#!/usr/bin/env node
/**
 * Generates the third-party notices (M5.3, D126, D127).
 *
 * Package mode, the default, writes three things from the licence inventory
 * (scripts/license-inventory.mjs, D125), computed afresh from the repository:
 *
 *   THIRD_PARTY.md                 every third-party component of the npm package
 *                                  and of what npm installs with it, grouped by
 *                                  scope, each with its version, licence, the
 *                                  copyright lines its text gives, and the text
 *   licenses/packages/<name>@<version>/<file>
 *                                  the exact licence (and NOTICE) files of the
 *                                  packages whose code or data the package ships:
 *                                  the editor bundle's, and d3's copied locales
 *   licenses/index.json "packages" that section only; scripts/fetch-license-texts.mjs
 *                                  owns the rest and keeps this one (D126)
 *
 * `--dist <dir>` writes `<dir>/THIRD_PARTY.md` for a built piece, with the same
 * module the build uses for every generation (lib/src/build/notices.js, D127),
 * so a `dist/` can be checked, or its file rewritten, after the fact.
 *
 * It never writes NOTICE.md, which a person maintains, and refuses
 * any output path that names it.
 *
 * Usage: node scripts/gen-notice.mjs [--check] [--out <file>] [--licences <dir>] [inventory flags]
 *        node scripts/gen-notice.mjs --dist <dir> [--check]
 *        The inventory flags are scripts/license-inventory.mjs's: --root, --exceptions,
 *        --evidence, --scope, --observations, --reviews, --source-index, --bundle.
 * Exit:  0 written, or current with --check · 1 stale with --check, or R11 refuses
 *        an item · 2 usage, IO, no build, or an output path that is NOTICE.md
 */
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {basename, dirname, join, relative, resolve, sep} from 'node:path';
import {pathToFileURL} from 'node:url';

import {buildInventory, EDITOR_BUNDLE, packageTextPath, parseArguments as parseInventoryArguments} from './license-inventory.mjs';

class UsageError extends Error {}

const APPLICATION_ROOT = join(import.meta.dirname, '..');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** NOTICE.md is maintained by a person; nothing here may write it, under any name that resolves to it. */
export function refuseNotice(path) {
  if (basename(path).toLowerCase() === 'notice.md') {
    throw new UsageError(`${path} is NOTICE.md, which a person maintains; gen-notice never writes it`);
  }
  return path;
}

// ------------------------------------------------------------ texts ------

/**
 * The licence and NOTICE files to keep in licenses/packages/: those of every
 * package whose code or data the npm package ships, one copy per name and
 * version. Two installations of one version must hold the same text.
 */
export function packageTexts(inventory) {
  const texts = new Map();
  for (const record of inventory.npm) {
    const reasons = [
      ...(record.bundledInto !== undefined ? [`bundled into ${record.bundledInto.join(', ')}`] : []),
      ...(record.copiedInto !== undefined ? [`copied into ${record.copiedInto.join(', ')}`] : []),
    ];
    if (reasons.length === 0) continue;
    const why = reasons.join('; ');
    for (const file of [...(record.licenceFiles ?? []), ...(record.noticeFiles ?? [])]) {
      const path = packageTextPath(record.name, record.version, file.file);
      const previous = texts.get(path);
      if (previous !== undefined && previous.sha256 !== file.sha256) {
        throw new UsageError(`${record.name}@${record.version} has two installations whose ${file.file} differ; they cannot share ${path}`);
      }
      texts.set(path, {
        package: record.name,
        version: record.version,
        file: path.slice('licenses/'.length),
        sha256: file.sha256,
        bytes: file.bytes,
        copiedFrom: previous?.copiedFrom ?? `${record.path}/${file.file}`,
        why,
      });
    }
  }
  return [...texts.values()].sort((a, b) => byName(a.file, b.file));
}

// ---------------------------------------------------------- markdown -----

/**
 * A table cell: pipes and backslashes escaped, and a `<` that would open raw
 * HTML written as an entity. An email or web address in angle brackets, as
 * copyright lines give them, stays an autolink.
 */
const cell = (text) =>
  String(text)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/<(?![^<>\s]+@[^<>\s]+>)(?!https?:\/\/[^<>\s]+>)/g, '&lt;')
    .replace(/\s+/g, ' ')
    .trim();
const code = (text) => `\`${text}\``;
const copyrightCell = (record) => {
  const lines = record.copyright ?? [];
  if (lines.length > 0) return lines.join('; ');
  if ((record.readmeCopyright ?? []).length > 0) return `${record.readmeCopyright.join('; ')} (its README; the licence text names nobody)`;
  return 'none in the licence text';
};
const table = (header, rows) => [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`)];

/** Entries of one name and version, installed at several paths, as one row. */
function grouped(records) {
  const groups = new Map();
  for (const record of records) {
    const key = `${record.name}@${record.version}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, {...record, paths: [record.path]});
    else group.paths.push(record.path);
  }
  return [...groups.values()].sort((a, b) => byName(`${a.name}@${a.version}`, `${b.name}@${b.version}`));
}

function notes(record) {
  const said = [];
  if (record.identifiedBy !== undefined) said.push(`declares no licence; identified as ${record.identifiedBy.identifies} by its ${record.identifiedBy.file} (D31)`);
  if (record.allowedBy !== undefined && record.allowedBy !== 'allowlist') said.push(record.allowedBy);
  if (record.bundledInto !== undefined) said.push('bundled into the editor page (section 3)');
  if (record.copiedInto !== undefined) said.push('material from it is copied into Papeleria’s own files (section 2)');
  if ((record.licenceFiles ?? []).length === 0 && record.inspected === 'installed') said.push('ships no licence text');
  if (record.paths.length > 1) said.push(`${record.paths.length} installations`);
  return said.join('; ') || '—';
}

/** What sharp's README says of its copyright, which its Apache-2.0 texts leave out. */
function sharpNotice(npm) {
  const sharp = npm.find((record) => record.name === 'sharp');
  return (sharp?.readmeCopyright ?? []).length === 0 ? '' : ` sharp’s README says: ${sharp.readmeCopyright.join(' ')}`;
}

/** THIRD_PARTY.md for the package, from the inventory and the licence index. */
export function renderThirdParty(inventory, licenceIndex) {
  const npm = inventory.npm;
  const installed = grouped(npm.filter((record) => record.scope === 'author-runtime'));
  const platform = grouped(npm.filter((record) => record.scope === 'optional-platform'));
  const dev = grouped(npm.filter((record) => record.scope === 'dev'));
  const bundledPaths = new Set(inventory.bundled.flatMap((bundle) => bundle.installations));
  const bundled = grouped(npm.filter((record) => bundledPaths.has(record.path)));
  const nativePackages = new Map(inventory.native.packages.map((record) => [record.package, record]));
  const textsById = new Map((licenceIndex.licenses ?? []).map((entry) => [entry.spdxId, entry]));
  const lines = [
    '# Third-party components in Papeleria',
    '',
    'Generated by `scripts/gen-notice.mjs` from the licence inventory and the texts in `licenses/`. Do not edit it by hand: change what it is made from and run the generator again. `NOTICE.md` is the attribution a person maintains, and no generator writes it.',
    '',
    'Papeleria’s own code is under the Apache License 2.0 in `LICENSE`. The names and marks are not licensed with it; see `TRADEMARKS.md`.',
    '',
    'This file covers the npm package and what npm installs with it. Every piece Papeleria builds carries its own `THIRD_PARTY.md`, which names only what that piece holds: the two font families, and in a comic the page-turn engine.',
    '',
    ...table(['Section', 'What it lists', 'Entries'], [
      ['1. In published pieces', 'What `papeleria build` can copy into a piece', String(inventory.vendored.length + inventory.fonts.length)],
      ['2. Copied into Papeleria’s own files', 'Third-party material inside Papeleria’s own code', String(inventory.copied.length)],
      ['3. Bundled into the editor page', `The packages whose code is in \`${EDITOR_BUNDLE}\``, String(bundled.length)],
      ['4. Installed with Papeleria', 'npm packages installed on the author’s machine', String(installed.length)],
      ['5. Platform packages', 'sharp’s prebuilt binaries, one set per platform, and the libraries inside them', `${platform.length} packages, ${inventory.native.components.length} components`],
      ['6. Development only', 'Not installed with Papeleria and not in the package', String(dev.length)],
      ['7. Licence texts', 'The texts this package carries', String((licenceIndex.licenses ?? []).length + (licenceIndex.packages ?? []).length)],
    ]),
    '',
    '## 1. In published pieces',
    '',
    'What `papeleria build` can copy into a piece’s `dist/`, beside Papeleria’s own code. Nothing else from outside Papeleria reaches a piece: charts are drawn when the piece is built, and nothing that runs only on the author’s machine is copied.',
    '',
    ...table(['Component', 'Version', 'What it is', 'Licence', 'Copyright', 'In the package', 'Licence text'], [
      ...inventory.vendored.map((component) => [
        component.name,
        component.version,
        'the page-turn engine, vendored (comics only)',
        component.declared,
        (component.copyright ?? []).join('; ') || 'none in the licence text',
        `${code(component.file.path)}; line 2 of ${code('lib/clients/reader.js')} and ${code('lib/clients/reader-preview.js')}; four layout rules in ${code('templates/comic/comic.css')}`,
        code(component.licenceFile.path),
      ]),
      ...inventory.fonts.map((family) => {
        const versions = [...new Set(family.files.map((file) => file.observed.fontRevision))].join(', ');
        const named = [...new Set(family.files.map((file) => file.observed.version).filter((version) => version !== undefined && !versions.split(', ').includes(version)))];
        const axes = [...new Set(family.files.flatMap((file) => file.observed.variableAxes ?? []))];
        const tableCopyright = family.nameTableCopyright.filter((line) => !family.copyright.includes(line));
        return [
          family.family,
          versions,
          `a typeface: ${family.files.length} WOFF2 subsets${axes.length > 0 ? `, variable (${axes.join(', ')})` : ''}${named.length > 0 ? `; its name table says ${named.join(', ')}` : ''}`,
          family.declared,
          `${family.copyright.join('; ')}${tableCopyright.length > 0 ? `; the fonts’ own name tables say ${tableCopyright.join('; ')}` : ''}`,
          family.files.map((file) => code(file.path)).join(', '),
          code(family.licenceFile.path),
        ];
      }),
    ]),
    '',
    'The font versions are the fonts’ own head-table revisions. The subset files were supplied without the recipe that made them (`NOTICE.md`).',
    '',
    '## 2. Copied into Papeleria’s own files',
    '',
    'Material from outside Papeleria inside files Papeleria itself ships, which no lockfile shows.',
    '',
    ...table(['Material', 'From', 'Licence', 'Copyright', 'Into', 'Licence text'], inventory.copied.map((entry) => {
      if (entry.package !== undefined) {
        const record = npm.find((candidate) => candidate.name === entry.package && candidate.version === entry.version);
        return [
          entry.what,
          `${entry.package} ${entry.version}: ${entry.from.map(code).join(', ')}`,
          entry.license ?? '—',
          record === undefined ? '—' : copyrightCell(record),
          `${code(entry.into)}, shipped as ${entry.ships.map(code).join(', ')}`,
          (record?.retained ?? []).map(code).join(', ') || '—',
        ];
      }
      const component = inventory.vendored.find((candidate) => candidate.component === entry.component);
      return [
        entry.what,
        component === undefined ? entry.component : `${component.name} ${component.version} (${code(entry.component)})`,
        entry.license,
        (component?.copyright ?? []).join('; ') || '—',
        `${code(entry.into)}, shipped as it is and in every comic’s ${code('dist/')} as ${code('theme/css/comic.css')}`,
        component === undefined ? '—' : code(component.licenceFile.path),
      ];
    })),
    '',
    '## 3. Bundled into the editor page',
    '',
    `${code(EDITOR_BUNDLE)} is the editor page that ${code('papeleria edit')} serves on 127.0.0.1. It runs in the author’s own browser and is never copied into a piece. It holds code from these ${bundled.length} package installations, read from the path comments esbuild writes into the shipped file. Each package’s own licence file is kept in ${code('licenses/packages/')}.`,
    '',
    ...table(['Package', 'Version', 'Licence', 'Copyright', 'Licence text'], bundled.map((record) => [
      record.name,
      record.version,
      record.expression ?? '—',
      copyrightCell(record),
      (record.retained ?? []).map(code).join(', ') || 'none shipped',
    ])),
    '',
    '## 4. Installed with Papeleria',
    '',
    'npm installs these with Papeleria, as its `dependencies` and theirs, and each keeps its own licence file in its own folder under `node_modules/`. They run on the author’s machine; nothing from them reaches a piece, and only the editor page’s packages (section 3) are inside the package itself.',
    '',
    ...table(['Package', 'Version', 'Licence', 'Copyright', 'Licence file in the installed package', 'Notes'], installed.map((record) => [
      record.name,
      record.version,
      record.expression ?? '—',
      copyrightCell(record),
      (record.licenceFiles ?? []).map((file) => code(file.file)).join(', ') || 'none',
      notes(record),
    ])),
    '',
    '## 5. Platform packages',
    '',
    `sharp converts a piece’s images on the author’s machine, with a prebuilt binary npm picks for the platform. What each package contains was read from the published tarballs without running anything (\`scripts/native-observations.json\` in the repository). None of it reaches a piece.${sharpNotice(npm)}`,
    '',
    ...table(['Package', 'Version', 'Platform', 'Licence', 'Distribution scope', 'Licence text in the package', 'Components inside'], platform.map((record) => {
      const native = nativePackages.get(record.name);
      const inside = native?.observations.reduce((most, observation) => Math.max(most, observation.bundledComponents), 0) ?? 0;
      return [
        record.name,
        record.version,
        record.platform === undefined ? 'any' : `${(record.platform.os ?? ['any']).join(', ')} / ${(record.platform.cpu ?? ['any']).join(', ')}`,
        record.expression ?? '—',
        native === undefined ? '—' : native.distributionScope === 'required' ? `required; review ${native.review}` : `excluded (${native.excludedBy})`,
        (record.licenceFiles ?? []).map((file) => code(file.file)).join(', ') || 'none',
        inside > 0 ? String(inside) : '—',
      ];
    })),
    '',
    'The compliance reviews of these packages are recorded in the repository (`scripts/native-reviews.json`, `docs/RELEASE_LICENSE_REVIEW.md`); a person signs them, and until then the release check fails.',
    '',
    '### 5.1 The libraries inside the prebuilt binaries',
    '',
    'libvips and the libraries it is built with, compiled into the shared library of each `@img/sharp-libvips-*` package, into `libvips-42.dll` in the Windows packages, and into the WebAssembly module of `@img/sharp-wasm32`. The licence is the one each package README names; where a component’s own licence file was read at the version shipped, it is given too. The copyright lines of each component are in its own sources, at the upstream named.',
    '',
    ...table(['Component', 'Version', 'Licence (package README)', 'Upstream licence, where read', 'Licence text', 'Packages', 'Upstream'], inventory.native.components.map((component) => [
      `${component.component}${component.weakCopyleft ? ' (weak copyleft)' : ''}`,
      component.version,
      component.licenceFromReadme ?? '—',
      component.upstreamLicence ?? '—',
      [...(component.retained ?? []).map(code), ...(component.notRetained ?? []).map((missing) => `not retained: ${missing}`)].join(', ') || '—',
      component.inPackages.length === 1 ? component.inPackages[0] : `${component.inPackages.length} packages`,
      component.upstream ?? '—',
    ])),
    '',
    'Part of mozjpeg is under the IJG licence, which asks for this acknowledgement: this software is based in part on the work of the Independent JPEG Group. libvips also compiles libnsgif (MIT, NetSurf) from its own source tree.',
    '',
    '## 6. Development only',
    '',
    'Used to build and test Papeleria. `npm install --omit=dev` leaves them out, and nothing of theirs is in the package.',
    '',
    ...table(['Package', 'Version', 'Licence', 'Platform'], dev.map((record) => [
      record.name,
      record.version,
      record.expression ?? '—',
      record.platform === undefined ? 'any' : `${(record.platform.os ?? ['any']).join(', ')} / ${(record.platform.cpu ?? ['any']).join(', ')}`,
    ])),
    '',
    '## 7. Licence texts',
    '',
    'Each text below travels in the package.',
    '',
    ...table(['File', 'Licence', 'Why it is here'], [
      [code('LICENSE'), 'Apache-2.0', 'Papeleria’s own code'],
      ...inventory.fonts.map((family) => [code(family.licenceFile.path), family.declared, `the ${family.family} fonts, and copied beside them into every piece`]),
      ...inventory.vendored.map((component) => [code(component.licenceFile.path), component.declared, `${component.name} ${component.version}, and copied into every comic`]),
      ...[...textsById.values()].map((entry) => [code(`licenses/${entry.file}`), entry.spdxId, entry.why]),
      ...(licenceIndex.packages ?? []).map((entry) => [code(`licenses/${entry.file}`), `${entry.package} ${entry.version}`, entry.why]),
    ]),
    '',
  ];
  return lines.join('\n');
}

// ------------------------------------------------------------- files -----

/** Every file under a directory, as relative paths with forward slashes. */
function listFiles(directory, base = directory) {
  if (!existsSync(directory)) return [];
  const found = [];
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(full, base));
    else if (entry.isFile()) found.push(relative(base, full).split(sep).join('/'));
  }
  return found.sort(byName);
}

/** The index with this generator's section replaced, every other section as it was. */
export function indexWithPackages(index, packages) {
  const {packages: _previous, ...rest} = index;
  return `${JSON.stringify({...rest, packages}, null, 2)}\n`;
}

function packageMode(options) {
  const {inventory, check} = buildInventory(options);
  if (check.failures.length > 0) {
    process.stdout.write(`gen-notice: R11 refuses ${check.failures.length} item(s); run npm run check:licenses. Nothing written.\n`);
    return 1;
  }
  const licencesDirectory = options.licencesDirectory;
  const indexPath = join(licencesDirectory, 'index.json');
  const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : {};
  const texts = packageTexts(inventory);
  const indexText = indexWithPackages(index, texts);
  const thirdParty = renderThirdParty(inventory, {...index, packages: texts});

  const stale = [];
  const wanted = new Map(texts.map((entry) => [entry.file, entry]));
  const packagesDirectory = join(licencesDirectory, 'packages');
  const present = listFiles(packagesDirectory).map((file) => `packages/${file}`);
  for (const [file, entry] of wanted) {
    const target = join(licencesDirectory, ...file.split('/'));
    const source = readFileSync(join(options.root, ...entry.copiedFrom.split('/')));
    if (sha256(source) !== entry.sha256) {
      throw new UsageError(`${entry.copiedFrom} changed while the inventory was read`);
    }
    if (!existsSync(target) || sha256(readFileSync(target)) !== entry.sha256) {
      stale.push(`licenses/${file}`);
      if (!options.check) {
        mkdirSync(dirname(target), {recursive: true});
        writeFileSync(target, source);
      }
    }
  }
  for (const file of present) {
    if (!wanted.has(file)) {
      stale.push(`licenses/${file} (no longer shipped)`);
      if (!options.check) rmSync(join(licencesDirectory, ...file.split('/')));
    }
  }
  for (const [path, text] of [[indexPath, indexText], [options.out, thirdParty]]) {
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (current !== text) {
      stale.push(relative(options.root, path).split(sep).join('/'));
      if (!options.check) writeFileSync(refuseNotice(path), text);
    }
  }
  if (!options.check) {
    // A package directory left empty by a removed text goes too.
    for (const directory of new Set(present.map((file) => dirname(join(licencesDirectory, ...file.split('/')))))) {
      if (existsSync(directory) && readdirSync(directory).length === 0) rmSync(directory, {recursive: true});
    }
  }
  process.stdout.write(
    `gen-notice: THIRD_PARTY.md from ${inventory.npm.length} lockfile entries, ${inventory.bundled[0].installations.length} bundled installations, ` +
      `${inventory.native.components.length} native components; ${texts.length} package licence file(s) in licenses/packages/\n`,
  );
  if (options.check) {
    if (stale.length === 0) {
      process.stdout.write('check: THIRD_PARTY.md, licenses/packages/ and licenses/index.json are current\n');
      return 0;
    }
    process.stdout.write(`check: stale: ${stale.join(', ')}; run node scripts/gen-notice.mjs\n`);
    return 1;
  }
  process.stdout.write(stale.length === 0 ? 'unchanged\n' : `written: ${stale.join(', ')}\n`);
  return 0;
}

async function distMode(directory, check) {
  const notices = join(APPLICATION_ROOT, 'lib', 'src', 'build', 'notices.js');
  if (!existsSync(notices)) {
    throw new UsageError('lib/src/build/notices.js is missing; run npm run build, which writes it');
  }
  if (!existsSync(directory)) {
    throw new UsageError(`${directory} does not exist`);
  }
  const {distThirdParty, THIRD_PARTY_FILE} = await import(pathToFileURL(notices).href);
  const {version} = JSON.parse(readFileSync(join(APPLICATION_ROOT, 'package.json'), 'utf8'));
  const paths = listFiles(directory);
  const read = async (path) => {
    const full = join(directory, ...path.split('/'));
    return existsSync(full) ? readFileSync(full) : null;
  };
  const text = await distThirdParty(APPLICATION_ROOT, {paths, read}, version);
  const target = refuseNotice(join(directory, THIRD_PARTY_FILE));
  const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
  if (check) {
    process.stdout.write(current === text ? `check: ${target} is current\n` : `check: ${target} differs from what the build would write\n`);
    return current === text ? 0 : 1;
  }
  writeFileSync(target, text);
  process.stdout.write(`written: ${target}\n`);
  return 0;
}

export function parseArguments(argv) {
  const rest = [];
  let dist = null;
  let out = null;
  let licencesDirectory = null;
  let check = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--check') {
      check = true;
    } else if (flag === '--dist' || flag === '--out' || flag === '--licences') {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError(`${flag} needs a path`);
      if (flag === '--dist') dist = resolve(value);
      else if (flag === '--out') out = refuseNotice(resolve(value));
      else licencesDirectory = resolve(value);
      index += 1;
    } else {
      rest.push(flag);
    }
  }
  if (dist !== null) {
    if (rest.length > 0 || out !== null || licencesDirectory !== null) throw new UsageError('--dist takes only --check');
    return {dist, check};
  }
  let inventory;
  try {
    inventory = parseInventoryArguments(rest);
  } catch (error) {
    throw new UsageError(error.message);
  }
  if (inventory.check) throw new UsageError('pass --check once');
  return {
    ...inventory,
    check,
    out: out ?? join(APPLICATION_ROOT, 'THIRD_PARTY.md'),
    licencesDirectory: licencesDirectory ?? join(APPLICATION_ROOT, 'licenses'),
    licences: join(licencesDirectory ?? join(APPLICATION_ROOT, 'licenses'), 'index.json'),
  };
}

async function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`gen-notice: ${error.message}\n`);
    process.stderr.write('usage: node scripts/gen-notice.mjs [--check] [--out <file>] [--licences <dir>] [inventory flags]\n       node scripts/gen-notice.mjs --dist <dir> [--check]\n');
    return 2;
  }
  try {
    return options.dist !== undefined ? await distMode(options.dist, options.check) : packageMode(options);
  } catch (error) {
    process.stderr.write(`gen-notice: ${error.message}\n`);
    return 2;
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  process.exitCode = await main(process.argv.slice(2));
}
