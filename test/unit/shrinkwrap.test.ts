/**
 * The published tree, pinned (security audit F11, D196): `scripts/shrinkwrap.mjs`
 * writes `npm-shrinkwrap.json` as the lockfile's copy when the package is
 * packed and removes it after, and never touches one it did not make. The
 * tarball proof (`test/package/tarball.ts`) checks what an installation then
 * receives.
 */
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';

import {applicationRoot} from '../helpers/paths.js';

type Shrinkwrap = {
  shrinkwrap(root: string, options?: {remove?: boolean}): {ok: boolean; message: string};
  LOCKFILE: string;
  SHRINKWRAP: string;
};

const {shrinkwrap, LOCKFILE, SHRINKWRAP} = (await import(pathToFileURL(join(applicationRoot, 'scripts', 'shrinkwrap.mjs')).href)) as Shrinkwrap;

test('F11 (D196): packing writes the lockfile as npm-shrinkwrap.json, and removes it after', () => {
  const root = mkdtempSync(join(tmpdir(), 'papeleria-shrinkwrap-'));
  try {
    const lock = `${JSON.stringify({name: 'x', lockfileVersion: 3, packages: {}}, null, 2)}\n`;
    writeFileSync(join(root, LOCKFILE), lock);
    assert.equal(shrinkwrap(root).ok, true);
    assert.equal(readFileSync(join(root, SHRINKWRAP), 'utf8'), lock, 'byte for byte');
    assert.equal(shrinkwrap(root).ok, true, 'written again, as a second pack would');
    assert.equal(shrinkwrap(root, {remove: true}).ok, true);
    assert.equal(existsSync(join(root, SHRINKWRAP)), false);
    assert.equal(shrinkwrap(root, {remove: true}).ok, true, 'nothing to remove is fine');

    // A shrinkwrap it did not make is neither overwritten nor removed.
    writeFileSync(join(root, SHRINKWRAP), '{"hand": "made"}\n');
    for (const remove of [false, true]) {
      const result = shrinkwrap(root, {remove});
      assert.equal(result.ok, false);
      assert.match(result.message, /is not a copy of package-lock\.json/);
      assert.equal(readFileSync(join(root, SHRINKWRAP), 'utf8'), '{"hand": "made"}\n');
    }
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('F11 (D196): the package packs the shrinkwrap, and the repository keeps one lockfile', () => {
  const manifest = JSON.parse(readFileSync(join(applicationRoot, 'package.json'), 'utf8')) as {files: string[]; scripts: Record<string, string>};
  assert.ok(manifest.files.includes(SHRINKWRAP));
  assert.equal(manifest.scripts['prepack'], 'node scripts/shrinkwrap.mjs');
  assert.equal(manifest.scripts['postpack'], 'node scripts/shrinkwrap.mjs --remove');
  // With both present npm would install from the shrinkwrap and ignore the lock, and the two could drift apart.
  assert.equal(existsSync(join(applicationRoot, SHRINKWRAP)), false, `${SHRINKWRAP} exists only while a pack runs`);
});
