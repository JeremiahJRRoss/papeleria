#!/usr/bin/env node
/**
 * The published dependency tree, pinned (security audit F11, D196).
 *
 * npm installs a package's dependencies by their ranges unless the package
 * carries `npm-shrinkwrap.json`, the one lockfile npm publishes. `npm pack`
 * and `npm publish` run this script first (`prepack`), which writes that file
 * as a byte-for-byte copy of `package-lock.json`, so an installation of the
 * tarball receives exactly the tree the suites ran, the licence inventory
 * lists and the native reviews read. `postpack` runs it again with
 * `--remove`, so the repository keeps one lockfile: with both present, npm
 * would install from the shrinkwrap and ignore the lock, and the two could
 * drift apart.
 *
 * It writes nothing to stdout, which `npm pack --json` keeps for its report.
 *
 * Usage: node scripts/shrinkwrap.mjs [--remove]
 * Exit:  0 written or removed · 1 a shrinkwrap is there that is not the
 *        lockfile's copy, which it neither overwrites nor removes · 2 usage
 *        or IO
 */
import {existsSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const APPLICATION_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const LOCKFILE = 'package-lock.json';
export const SHRINKWRAP = 'npm-shrinkwrap.json';

/**
 * Writes the shrinkwrap, or with `remove` takes it away again. A shrinkwrap
 * that differs from the lockfile was not made here: it is left alone and
 * reported, never overwritten or deleted.
 */
export function shrinkwrap(root, {remove = false} = {}) {
  const lock = readFileSync(join(root, LOCKFILE));
  const target = join(root, SHRINKWRAP);
  if (existsSync(target) && !readFileSync(target).equals(lock)) {
    return {ok: false, message: `${SHRINKWRAP} is there and is not a copy of ${LOCKFILE}; it was not made by this script, so it is left alone. Remove it, or make it the lockfile's copy, and try again.`};
  }
  if (remove) {
    rmSync(target, {force: true});
    return {ok: true, message: `${SHRINKWRAP} removed; ${LOCKFILE} stays the repository's lockfile.`};
  }
  writeFileSync(target, lock);
  return {ok: true, message: `${SHRINKWRAP} written from ${LOCKFILE} (${lock.length} bytes): the package pins its installed tree.`};
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--remove')) {
    process.stderr.write('Usage: node scripts/shrinkwrap.mjs [--remove]\n');
    process.exit(2);
  }
  try {
    const result = shrinkwrap(APPLICATION_ROOT, {remove: args.includes('--remove')});
    process.stderr.write(`shrinkwrap: ${result.message}\n`);
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    process.stderr.write(`shrinkwrap: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
