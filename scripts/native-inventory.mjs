#!/usr/bin/env node
/**
 * Generates native package **observations** (D34). It records what is in a
 * package. It never records whether the obligations are met: that is a review,
 * it lives in scripts/native-reviews.json, and a person writes it. A generator
 * that could write reviews would be a generator that approves its own work.
 *
 * Two inspection methods, deliberately distinguished:
 *
 *   installed         the package is present in node_modules on this machine.
 *   fetched-package   the published tarball was downloaded and unpacked without
 *                     running anything. This is how the Windows and macOS
 *                     binaries get inspected from Linux: their bytes, licence
 *                     files and bundled component tables are all readable
 *                     statically. What still needs the target platform is
 *                     execution — loading the binary, confirming it links
 *                     against the shipped libvips — and that is never claimed
 *                     here.
 *
 * Observations merge. Running this on Windows adds the Windows rows and leaves
 * the Linux and macOS rows untouched, because a record is replaced only by a
 * record of the same package, version, platform and method.
 *
 * Usage: node scripts/native-inventory.mjs [--root <dir>] [--out <file>]
 *                                          [--fetch] [--check]
 *        --fetch   also download and statically inspect packages that are not
 *                  installed here (needs the registry); a tarball whose bytes
 *                  are not the lockfile's integrity is skipped, not unpacked
 *        --check   report drift without writing
 * Exit:  0 written or unchanged · 1 --check found drift · 2 usage or IO
 */
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

import {
  artefactDigestOf,
  deriveRequirements,
  mergeObservations,
  readObservations,
  readScope,
} from './native-reconcile.mjs';

class UsageError extends Error {}

const NATIVE_EXTENSIONS = ['.so', '.dylib', '.dll', '.node', '.wasm'];
const LICENCE_FILE = /(^|\/)(LICEN[CS]E|COPYING|NOTICE)([.-][A-Za-z0-9.]+)?$/i;

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/**
 * Reads how a compiled artefact resolves its dependencies, from the file's own
 * headers. No execution: an ELF dynamic section, a PE import table and a Mach-O
 * load-command list all say what the binary needs and where it looks for it.
 *
 * This is the fact the LGPL linking question turns on, and it is an observation,
 * not a review: whether dynamic linkage against a separately shipped library
 * discharges the obligation is a person's judgement, recorded elsewhere.
 */
function detectLinkage(file) {
  const run = (command, args) => {
    try {
      return execFileSync(command, [...args, file], {encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore']});
    } catch {
      return null;
    }
  };

  const elf = run('readelf', ['-d']);
  if (elf !== null && /\(NEEDED\)/.test(elf)) {
    return {
      format: 'ELF',
      method: 'readelf -d',
      needed: [...elf.matchAll(/\(NEEDED\)\s+Shared library: \[([^\]]+)\]/g)].map((m) => m[1]),
      searchPath: [...elf.matchAll(/\((?:RPATH|RUNPATH)\)\s+Library (?:rpath|runpath): \[([^\]]+)\]/g)].map((m) => m[1]),
    };
  }

  for (const [command, args] of [
    ['objdump', ['-p']],
    // GNU objdump in this toolchain does not recognise Mach-O; the LLVM one
    // does, and ARM64 PE too. Trying both keeps macOS and Windows on ARM from
    // being written off as "needs that platform" when only a reader was missing.
    ['llvm-objdump', ['-p']],
    ['llvm-objdump-18', ['-p']],
  ]) {
    const dump = run(command, args);
    if (dump === null) continue;
    if (/DLL Name:/.test(dump)) {
      return {
        format: 'PE',
        method: `${command} -p`,
        needed: [...dump.matchAll(/DLL Name:\s*(\S+)/g)].map((m) => m[1]),
        searchPath: [],
      };
    }
    if (/mach-o|LC_LOAD_DYLIB|MH_MAGIC/i.test(dump)) {
      // Read the load commands one block at a time rather than scraping every
      // "name ... (offset" line. LC_ID_DYLIB carries the library's OWN install
      // name and looks exactly like a dependency; scraping made every dylib
      // appear to link against itself, which in turn made a statically linked
      // libvips-cpp read as if it loaded libvips from somewhere else.
      const needed = [];
      const searchPath = [];
      let installName;
      for (const block of dump.split(/Load command \d+/)) {
        const kind = block.match(/\bcmd\s+(LC_\w+)/)?.[1];
        if (kind === undefined) continue;
        const name = block.match(/\bname\s+(\S+)\s+\(offset/)?.[1];
        const path = block.match(/\bpath\s+(\S+)\s+\(offset/)?.[1];
        if (kind === 'LC_ID_DYLIB') {
          if (name !== undefined) installName = name;
        } else if (/^LC_(LOAD|LOAD_WEAK|LAZY_LOAD|LOAD_UPWARD|REEXPORT)_DYLIB$/.test(kind)) {
          if (name !== undefined) needed.push(name);
        } else if (kind === 'LC_RPATH') {
          if (path !== undefined) searchPath.push(path);
        }
      }
      return {
        format: 'Mach-O',
        method: `${command} -p`,
        needed,
        searchPath,
        ...(installName === undefined ? {} : {installName}),
      };
    }
  }

  return {
    format: 'unknown',
    method: 'readelf -d; objdump -p; llvm-objdump -p',
    needed: [],
    searchPath: [],
    note: 'no reader on this machine recognised the file header, so the linkage is unread rather than absent',
  };
}

function walk(directory, found = []) {
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

/** The upstream component table that sharp-libvips ships in its README. */
function bundledComponents(packageDirectory) {
  const versionsPath = join(packageDirectory, 'versions.json');
  if (!existsSync(versionsPath)) return null;
  const versions = JSON.parse(readFileSync(versionsPath, 'utf8'));
  const readmePath = join(packageDirectory, 'README.md');
  const licences = new Map();
  if (existsSync(readmePath)) {
    for (const line of readFileSync(readmePath, 'utf8').split('\n')) {
      const row = /^\|\s*([A-Za-z0-9_-]+)\s*\|\s*(.+?)\s*\|\s*$/.exec(line);
      if (row !== null && row[1] !== 'Library' && !/^-+$/.test(row[1])) {
        licences.set(row[1], row[2].replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim());
      }
    }
  }
  return Object.entries(versions)
    .map(([name, version]) => ({
      component: name,
      version: String(version),
      licenseFromPackageReadme: licences.get(name) ?? licences.get(`lib${name}`) ?? null,
    }))
    .sort((a, b) => (a.component < b.component ? -1 : 1));
}

/** Everything a static read of one unpacked package directory can say. */
function inspectDirectory(packageDirectory, base) {
  const files = walk(packageDirectory);
  const describe = (file) => ({
    path: relative(base, file).split('\\').join('/'),
    sha256: sha256(file),
    bytes: statSync(file).size,
  });
  const licenseFiles = files.filter((file) => LICENCE_FILE.test(file)).sort().map(describe);
  const nativeArtefacts = files
    .filter((file) => NATIVE_EXTENSIONS.some((ext) => file.endsWith(ext) || file.includes(`${ext}.`)))
    .sort()
    .map((file) => ({...describe(file), linkage: detectLinkage(file)}));
  const bundled = bundledComponents(packageDirectory);

  const notes = [];
  if (licenseFiles.length === 0) {
    notes.push('the package ships no licence text of its own');
  }
  if (bundled !== null) {
    const weakCopyleft = bundled.filter((c) => /LGPL|MPL|Mozilla/i.test(c.licenseFromPackageReadme ?? ''));
    if (weakCopyleft.length > 0) {
      notes.push(
        `the prebuilt binary bundles ${weakCopyleft.length} component(s) under weak-copyleft terms: ` +
          weakCopyleft.map((c) => `${c.component} (${c.licenseFromPackageReadme})`).join(', '),
      );
    }
  }
  if (nativeArtefacts.length > 0) {
    const dynamic = nativeArtefacts.filter((a) => (a.linkage?.needed ?? []).some((n) => /vips/i.test(n)));
    if (dynamic.length > 0) {
      notes.push(
        'linkage read from the file headers: ' +
          dynamic
            .map((a) => `${a.path.split('/').pop()} (${a.linkage.format}) needs ${a.linkage.needed.filter((n) => /vips/i.test(n)).join(', ')}`)
            .join('; ') +
          '. The artefact resolves libvips at load time from a separately shipped library rather ' +
          'than containing it, which is the fact the LGPL linking question turns on. Whether that ' +
          'discharges the obligation is a review decision, not an observation.',
      );
    }
    notes.push(
      'source availability is not established by reading a package; record where corresponding ' +
        'source is offered for each weak-copyleft component',
    );
  }
  return {licenseFiles, nativeArtefacts, bundledComponents: bundled ?? undefined, notes};
}

/**
 * Whether `bytes` are what an npm `integrity` value names: one of its sha512
 * digests (Subresource Integrity form, `sha512-<base64>`, several allowed and
 * separated by spaces). A value with no sha512 digest names nothing this
 * checks, so it never matches.
 */
export function integrityMatches(bytes, expected) {
  if (typeof expected !== 'string') {
    return false;
  }
  const actual = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  return expected
    .split(/\s+/)
    .map((token) => token.replace(/\?.*$/, ''))
    .some((token) => token === actual);
}

/**
 * Downloads one published tarball and reads it without running anything. The
 * bytes must be the ones the lockfile's integrity names before anything is
 * unpacked (security audit F12), and tar writes no owner, group or mode bits
 * the archive asks for.
 */
function fetchAndInspect(packageName, version, integrity) {
  const workspace = mkdtempSync(join(tmpdir(), 'papeleria-fetch-'));
  try {
    execFileSync('npm', ['pack', `${packageName}@${version}`, '--silent', '--pack-destination', workspace], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180000,
    });
    const tarball = readdirSync(workspace).find((name) => name.endsWith('.tgz'));
    if (tarball === undefined) throw new Error('npm pack produced no tarball');
    const bytes = readFileSync(join(workspace, tarball));
    if (!integrityMatches(bytes, integrity)) {
      const actual = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
      throw new Error(`the tarball's integrity is ${actual}; the lockfile records ${integrity ?? 'none'}, so it was not unpacked`);
    }
    const unpacked = join(workspace, 'unpacked');
    mkdirSync(unpacked);
    execFileSync('tar', ['--no-same-owner', '--no-same-permissions', '-xzf', join(workspace, tarball), '-C', unpacked], {timeout: 180000});
    const packageDirectory = join(unpacked, 'package');
    const inspected = inspectDirectory(packageDirectory, packageDirectory);
    return {...inspected, tarballSha256: createHash('sha256').update(bytes).digest('hex')};
  } finally {
    rmSync(workspace, {recursive: true, force: true});
  }
}

export function generateObservations({root, fetch = false, onProgress = () => {}}) {
  const here = import.meta.dirname;
  const {scope, exclusions} = readScope(join(here, 'native-scope.json'));
  const requirements = deriveRequirements({root, scope, exclusions});
  const today = new Date().toISOString().slice(0, 10);
  const observedFrom = `${process.platform}/${process.arch}`;
  const fresh = [];
  const skipped = [];

  for (const requirement of requirements) {
    const lockPath = requirement.package.startsWith('@img/')
      ? join('node_modules', requirement.package)
      : join('node_modules', requirement.package);
    const packageDirectory = join(root, lockPath);
    const installed = existsSync(join(packageDirectory, 'package.json'));

    const base = {
      package: requirement.package,
      version: requirement.version,
      platformKey: requirement.platformKey,
      declaredLicense: requirement.declaredLicense,
      integrity: requirement.integrity,
      observedFrom,
      observedOn: today,
      distribution: 'published on the npm registry and fetched by npm; not vendored into this repository',
    };

    if (installed) {
      onProgress(`installed  ${requirement.package}@${requirement.version}`);
      fresh.push({...base, inspection: 'installed', ...inspectDirectory(packageDirectory, root)});
      continue;
    }
    if (!fetch) {
      skipped.push(`${requirement.package}@${requirement.version} (not installed; use --fetch)`);
      continue;
    }
    try {
      onProgress(`fetching   ${requirement.package}@${requirement.version}`);
      fresh.push({...base, inspection: 'fetched-package', ...fetchAndInspect(requirement.package, requirement.version, requirement.integrity)});
    } catch (error) {
      skipped.push(`${requirement.package}@${requirement.version} (fetch failed: ${String(error.message).slice(0, 120)})`);
    }
  }

  for (const record of fresh) {
    record.artefactDigest = artefactDigestOf(record);
  }
  return {fresh, skipped, requirements};
}

function serialise(records) {
  return `${JSON.stringify(
    {
      $comment: [
        'Native package observations, generated by scripts/native-inventory.mjs (D34).',
        'These are facts about package contents, not compliance decisions. Whether the obligations',
        'are met is recorded by a person in scripts/native-reviews.json, and nothing here can set it.',
        'Records merge on package, version, platformKey and inspection method, so running the',
        'generator on one platform never erases another platform\'s rows.',
        'inspection: "installed" means present in node_modules here; "fetched-package" means the',
        'published tarball was downloaded and read without executing anything. Execution checks,',
        'such as confirming the binary loads and links against the shipped libvips, still need the',
        'target platform and are never claimed by this file.',
      ],
      generatedBy: 'scripts/native-inventory.mjs',
      observations: records,
    },
    null,
    2,
  )}\n`;
}

function parseArguments(argv) {
  const options = {root: process.cwd(), out: null, check: false, fetch: false};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--check') {
      options.check = true;
      continue;
    }
    if (flag === '--fetch') {
      options.fetch = true;
      continue;
    }
    const value = argv[index + 1];
    if (flag === '--root' || flag === '--out') {
      if (value === undefined) throw new UsageError(`${flag} needs a path`);
      options[flag === '--root' ? 'root' : 'out'] = value;
      index += 1;
    } else {
      throw new UsageError(`unknown argument ${JSON.stringify(flag)}`);
    }
  }
  options.root = resolve(options.root);
  options.out = resolve(options.out ?? join(import.meta.dirname, 'native-observations.json'));
  return options;
}

function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`native-inventory: ${error.message}\n`);
    process.stderr.write('usage: node scripts/native-inventory.mjs [--root <dir>] [--out <file>] [--fetch] [--check]\n');
    return 2;
  }

  let generated;
  let existing;
  try {
    generated = generateObservations({
      root: options.root,
      fetch: options.fetch,
      onProgress: (line) => process.stdout.write(`  ${line}\n`),
    });
    existing = readObservations(options.out).records;
  } catch (error) {
    process.stderr.write(`native-inventory: ${error.message}\n`);
    return 2;
  }

  const {merged, replaced, added, rewritten, kept} = mergeObservations(existing, generated.fresh);
  const serialised = serialise(merged);

  process.stdout.write(
    `observations: ${generated.fresh.length} fresh, ${added.length} new, ${replaced.length} changed, ` +
      `${rewritten.length} re-read unchanged bytes, ${kept} kept from other platforms or runs; ` +
      `${merged.length} total\n`,
  );
  for (const key of replaced) {
    process.stdout.write(`  changed ${key} — any review bound to the old digest is now invalid\n`);
  }
  for (const key of rewritten) {
    process.stdout.write(`  re-read ${key} — same bytes, different record; reviews stay valid\n`);
  }
  for (const note of generated.skipped) {
    process.stdout.write(`  skipped ${note}\n`);
  }

  if (options.check) {
    const current = existsSync(options.out) ? readFileSync(options.out, 'utf8') : '';
    if (current === serialised) {
      process.stdout.write('check: the committed observations already contain what this platform sees\n');
      return 0;
    }
    process.stdout.write(`check: ${options.out} would change\n`);
    return 1;
  }

  writeFileSync(options.out, serialised);
  process.stdout.write(`written: ${options.out}\n`);
  return 0;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  process.exitCode = main(process.argv.slice(2));
}
