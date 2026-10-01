#!/usr/bin/env node
/**
 * The checksum manifest, `MANIFEST.sha256` (M5.5, D141; issue 002 E3).
 *
 * It lists the SHA-256 of every regular file under the application root in
 * the scope README.md ("Contents and checksums") and
 * docs/REFERENCE_COMPATIBILITY.md ("Link and snapshot policy") state: every
 * file except the manifest itself, `.git/` and macOS `.DS_Store` files, the
 * installed `node_modules/` (the licence fixtures' tracked `node_modules/`
 * trees under `test/fixtures/license/` stay in scope), the generated `lib/`,
 * and each piece's `dist/` and `.papeleria/`, a piece being a folder that
 * holds `papeleria.yaml` or `papeleria.json`.
 *
 * Each line is `<sha256>  <path>`, the form `sha256sum -c MANIFEST.sha256`
 * reads, with the path relative to the root, `/`-separated, and the lines
 * sorted by the paths' UTF-8 bytes. The hashes are of the bytes on disk.
 * Symbolic links are not followed or listed, since the scope is regular
 * files, and each one skipped is named on stderr. A path `sha256sum` would
 * have to escape, holding a backslash or a line break, stops the run.
 *
 * The manifest is a snapshot of what a clone of the repository holds, so it
 * can be verified from one. A file git ignores that the scope does not
 * exclude, such as `test-results/`, a packed `*.tgz` or `coverage/`, would
 * make a clone fail the check, so it stops the run and is named: remove it
 * and run again. Writing also stops on a file in scope whose bytes are not
 * the ones git would commit: untracked, changed but not staged, or deleted
 * but not staged. Stage or commit it, then write the manifest, and commit it
 * with the index. Where there is no repository, `--no-git` skips both checks.
 *
 * The file is regenerated for a release or a documentation snapshot, after
 * every other change, never on each commit, so no test holds the committed
 * copy current. `--check` compares the committed copy with the tree and
 * writes nothing, where `sha256sum` is not available.
 *
 * Usage: node scripts/gen-manifest.mjs [--root <dir>] [--check] [--no-git]
 * Exit:  0 written, or with --check the manifest matches the tree · 1 with
 *        --check a file differs, is missing or is unlisted; a file git
 *        ignores is in scope; or, when writing, a file in scope is not as
 *        git would commit it · 2 usage, IO, or git unable to answer
 */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, readdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const APPLICATION_ROOT = fileURLToPath(new URL('..', import.meta.url));

export const MANIFEST_NAME = 'MANIFEST.sha256';

/** Folders left out only directly under the root: the installed dependencies and the compiled output. */
const SKIPPED_AT_ROOT = new Set(['node_modules', 'lib']);

/** Files that make a folder a piece, whose `dist/` and `.papeleria/` are generated. */
const PIECE_MANIFESTS = ['papeleria.yaml', 'papeleria.json'];

/** Generated folders inside a piece. */
const PIECE_OUTPUT = new Set(['dist', '.papeleria']);

class UsageError extends Error {}

class ManifestError extends Error {}

function parseArguments(argv) {
  const options = {root: APPLICATION_ROOT, check: false, git: true};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--root') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError('--root needs a path');
      }
      options.root = value;
      index += 1;
    } else if (flag === '--check') {
      options.check = true;
    } else if (flag === '--no-git') {
      options.git = false;
    } else {
      throw new UsageError(`unknown argument ${JSON.stringify(flag)}`);
    }
  }
  options.root = resolve(options.root);
  return options;
}

function isPiece(entries) {
  return PIECE_MANIFESTS.some((name) => entries.some((entry) => entry.name === name && entry.isFile()));
}

/**
 * Every regular file in scope, as root-relative `/`-separated paths, and the
 * entries the walk passed over because they are not regular files or folders.
 */
export function scopeFiles(root) {
  const files = [];
  const skipped = [];
  const walk = (directory, prefix) => {
    const entries = readdirSync(directory, {withFileTypes: true});
    const piece = isPiece(entries);
    for (const entry of entries) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.name === '.git' || entry.name === '.DS_Store') {
        continue;
      }
      if (prefix === '' && (entry.name === MANIFEST_NAME || (entry.isDirectory() && SKIPPED_AT_ROOT.has(entry.name)))) {
        continue;
      }
      if (entry.isDirectory()) {
        if (piece && PIECE_OUTPUT.has(entry.name)) {
          continue;
        }
        walk(join(directory, entry.name), path);
      } else if (entry.isFile()) {
        if (/[\\\n\r]/.test(path)) {
          throw new ManifestError(`${JSON.stringify(path)} holds a backslash or a line break, which sha256sum would have to escape; rename it`);
        }
        files.push(path);
      } else {
        skipped.push(`${path} (${entry.isSymbolicLink() ? 'a symbolic link' : 'not a regular file'})`);
      }
    }
  };
  walk(root, '');
  files.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  return {files, skipped};
}

/** Whether a root-relative path is outside the scope, by the rules `scopeFiles` applies as it walks. */
function outOfScope(root, path) {
  const parts = path.split('/');
  if (path === MANIFEST_NAME || parts.includes('.git') || parts.at(-1) === '.DS_Store') {
    return true;
  }
  if (parts.length > 1 && SKIPPED_AT_ROOT.has(parts[0])) {
    return true;
  }
  return parts.slice(0, -1).some((part, depth) => PIECE_OUTPUT.has(part) && PIECE_MANIFESTS.some((name) => existsSync(join(root, ...parts.slice(0, depth), name))));
}

/**
 * The files in scope whose bytes on disk are not the ones git would commit,
 * each with why: untracked (and not ignored), changed but not staged, or
 * deleted but not staged. A manifest written over them would name bytes a
 * clone does not hold. Throws when git cannot say.
 */
export function uncommittedInScope(root, files) {
  const listed = (flags) => {
    const result = spawnSync('git', ['-C', root, 'ls-files', '-z', ...flags], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
    if (result.error !== undefined || result.status !== 0) {
      throw new ManifestError(`git could not list the working tree: ${result.error?.message ?? result.stderr.trim()}; run in a clone, or pass --no-git`);
    }
    return result.stdout.split('\0').filter((path) => path !== '');
  };
  const inScope = new Set(files);
  const deleted = new Set(listed(['--deleted']));
  const found = [];
  for (const path of listed(['--others', '--exclude-standard'])) {
    if (inScope.has(path)) {
      found.push(`${path} is not tracked by git`);
    }
  }
  for (const path of listed(['--modified'])) {
    if (deleted.has(path)) {
      if (!outOfScope(root, path)) {
        found.push(`${path} is deleted, and the deletion is not staged`);
      }
    } else if (inScope.has(path)) {
      found.push(`${path} has changes that are not staged`);
    }
  }
  return found.sort();
}

/** The files git ignores among `files`, or throws when git cannot say. */
export function ignoredByGit(root, files) {
  if (files.length === 0) {
    return [];
  }
  const result = spawnSync('git', ['-C', root, 'check-ignore', '--stdin', '-z'], {input: `${files.join('\0')}\0`, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
  // git can exit before it has read every path, as it does outside a
  // repository; writing the rest then fails with EPIPE, and git's own status
  // and message below say why.
  if (result.error !== undefined && !(result.error.code === 'EPIPE' && typeof result.status === 'number')) {
    throw new ManifestError(`git could not run (${result.error.message}); run in a clone, or pass --no-git`);
  }
  // check-ignore exits 0 when some path is ignored and 1 when none is.
  if (result.status === 1) {
    return [];
  }
  if (result.status !== 0) {
    throw new ManifestError(`git could not tell which files it ignores: ${result.stderr.trim()}; run in a clone, or pass --no-git`);
  }
  return result.stdout.split('\0').filter((path) => path !== '');
}

function sha256(root, path) {
  return createHash('sha256').update(readFileSync(join(root, ...path.split('/')))).digest('hex');
}

/** The manifest's text for `files`: one `<sha256>  <path>` line each, in the order given. */
export function manifestText(root, files) {
  return files.map((path) => `${sha256(root, path)}  ${path}\n`).join('');
}

/** Reads a manifest into a map from path to hash, refusing a line in any other form. */
function readManifest(file) {
  const entries = new Map();
  const lines = readFileSync(file, 'utf8').split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  lines.forEach((line, index) => {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (match === null) {
      throw new ManifestError(`${MANIFEST_NAME} line ${index + 1} is not "<sha256>  <path>"`);
    }
    if (entries.has(match[2])) {
      throw new ManifestError(`${MANIFEST_NAME} lists ${match[2]} twice`);
    }
    entries.set(match[2], match[1]);
  });
  return entries;
}

function main(argv) {
  const usage = 'usage: node scripts/gen-manifest.mjs [--root <dir>] [--check] [--no-git]';
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`gen-manifest: ${error.message}\n${usage}\n`);
    return 2;
  }
  const target = join(options.root, MANIFEST_NAME);
  try {
    const {files, skipped} = scopeFiles(options.root);
    for (const entry of skipped) {
      process.stderr.write(`gen-manifest: note: ${entry} is not listed; the manifest covers regular files\n`);
    }
    if (options.git) {
      const ignored = ignoredByGit(options.root, files);
      if (ignored.length > 0) {
        for (const path of ignored) {
          process.stderr.write(`gen-manifest: ${path} is ignored by git but inside the manifest's scope, so a clone could not verify it; remove it and run again\n`);
        }
        return 1;
      }
      // Only a write can name bytes a clone lacks; --check reports the differences instead.
      const uncommitted = options.check ? [] : uncommittedInScope(options.root, files);
      if (uncommitted.length > 0) {
        for (const reason of uncommitted) {
          process.stderr.write(`gen-manifest: ${reason}, so a clone could not verify the manifest; stage or commit it, and run again\n`);
        }
        return 1;
      }
    }
    if (options.check) {
      if (!existsSync(target)) {
        process.stderr.write(`gen-manifest: ${MANIFEST_NAME} is missing; run node scripts/gen-manifest.mjs\n`);
        return 1;
      }
      const listed = readManifest(target);
      const problems = [];
      for (const path of files) {
        const hash = listed.get(path);
        if (hash === undefined) {
          problems.push(`${path}: not listed`);
        } else if (hash !== sha256(options.root, path)) {
          problems.push(`${path}: differs`);
        }
      }
      const present = new Set(files);
      for (const path of listed.keys()) {
        if (!present.has(path)) {
          problems.push(`${path}: listed, but not in the tree`);
        }
      }
      for (const problem of problems) {
        process.stderr.write(`gen-manifest: ${problem}\n`);
      }
      process.stdout.write(`${MANIFEST_NAME}: ${listed.size} entries, ${files.length} files in scope, ${problems.length} difference${problems.length === 1 ? '' : 's'}\n`);
      return problems.length === 0 ? 0 : 1;
    }
    const text = manifestText(options.root, files);
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, text);
    renameSync(temporary, target);
    const digest = createHash('sha256').update(text).digest('hex');
    process.stdout.write(`${MANIFEST_NAME}: ${files.length} files; SHA-256 of the manifest ${digest}\n`);
    return 0;
  } catch (error) {
    // A ManifestError explains itself; anything else is the file system's.
    process.stderr.write(`gen-manifest: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  process.exitCode = main(process.argv.slice(2));
}
