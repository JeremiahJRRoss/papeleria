/**
 * M1.7: the source snapshot — text overlays for W3A's preview (D164(d)) and
 * the revision record the build rechecks before promotion (IC05).
 */
import assert from 'node:assert/strict';
import {mkdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {after, test} from 'node:test';

import {createMemoryLoaders, createNodeLoaders, FileTooLargeError, type InspectionRun} from '../../src/core/index.js';
import {recheckRevisions, recordRevisions, withOverlays} from '../../src/build/snapshot.js';
import {removeTemporaryFolders, temporaryFolder} from '../helpers/pieces.js';

after(removeTemporaryFolders);

const MANIFEST = 'schema: 1\ntemplate: deck\n';

test('an overlay replaces a file’s text and its reported size, and nothing else', async () => {
  const disk = createMemoryLoaders({
    'papeleria.yaml': MANIFEST,
    'assets/text/a.md': 'on disk',
    'assets/images/a.png': new Uint8Array([1, 2, 3]),
    'assets/text/link.md': {symlink: 'a.md'},
  });
  const loaders = withOverlays(disk, [
    {path: 'assets/text/a.md', content: '\ufeffunsaved ñ'},
    {path: 'assets/text/absent.md', content: 'a buffer for a file that is not there'},
    {path: 'assets/text/link.md', content: 'a buffer over a link'},
    {path: 'assets/images/a.png', content: 'text over an image'},
  ]);
  assert.equal(await loaders.readText('assets/text/a.md'), 'unsaved ñ', 'the byte-order mark goes, as a disk read strips it');
  assert.deepEqual(await loaders.stat('assets/text/a.md'), {kind: 'file', bytes: 10});
  assert.equal(await loaders.stat('assets/text/absent.md'), null, 'an overlay never makes a file exist');
  assert.equal((await loaders.stat('assets/text/link.md'))?.kind, 'symlink', 'or changes what a path is');
  assert.deepEqual([...(await loaders.readBytes('assets/images/a.png'))], [1, 2, 3], 'bytes always come from the disk');
  assert.equal(await loaders.readText('papeleria.yaml'), MANIFEST);
  await assert.rejects(loaders.readText('assets/text/a.md', {maxBytes: 9}), FileTooLargeError);
  assert.equal(await loaders.readText('assets/text/a.md', {maxBytes: 10}), 'unsaved ñ');
  assert.equal(withOverlays(disk, []), disk, 'no overlay, no wrapper');
});

test('an overlay passes stat’s inspection run on to the disk access', async () => {
  const seen: (InspectionRun | undefined)[] = [];
  const disk = createMemoryLoaders({'papeleria.yaml': MANIFEST});
  const spy = {...disk, stat: (path: string, run?: InspectionRun) => {
    seen.push(run);
    return disk.stat(path, run);
  }};
  const run: InspectionRun = {listings: new Map()};
  await withOverlays(spy, [{path: 'papeleria.yaml', content: MANIFEST}]).stat('papeleria.yaml', run);
  assert.equal(seen[0], run);
});

function folder(label: string): string {
  const root = temporaryFolder(label);
  mkdirSync(join(root, 'assets', 'text'), {recursive: true});
  writeFileSync(join(root, 'papeleria.yaml'), MANIFEST);
  writeFileSync(join(root, 'assets', 'text', 'a.md'), 'first');
  writeFileSync(join(root, 'assets', 'text', 'b.md'), 'second');
  return root;
}

test('IC05: the recheck finds a file whose content, or whose kind, changed after the build read it', async () => {
  const root = folder('recheck');
  const {loaders, record} = recordRevisions(createNodeLoaders(root));
  await loaders.stat('assets/text/a.md');
  await loaders.readText('assets/text/a.md', {maxBytes: 100});
  await loaders.readBytes('assets/text/b.md');
  await loaders.stat('assets/text/missing.md');
  assert.deepEqual(await recheckRevisions(root, record()), [], 'nothing moved');

  writeFileSync(join(root, 'assets', 'text', 'a.md'), 'first, edited');
  assert.deepEqual(await recheckRevisions(root, record()), ['assets/text/a.md']);
  writeFileSync(join(root, 'assets', 'text', 'a.md'), 'first');

  writeFileSync(join(root, 'assets', 'text', 'missing.md'), 'now it exists');
  assert.deepEqual(await recheckRevisions(root, record()), ['assets/text/missing.md']);
  rmSync(join(root, 'assets', 'text', 'missing.md'));

  rmSync(join(root, 'assets', 'text', 'b.md'));
  symlinkSync('a.md', join(root, 'assets', 'text', 'b.md'));
  assert.deepEqual(await recheckRevisions(root, record()), ['assets/text/b.md'], 'a link in place of the file read');
});

test('IC05: a file read twice with different content is recorded as changed at once', async () => {
  const root = folder('twice');
  const {loaders, record} = recordRevisions(createNodeLoaders(root));
  await loaders.readBytes('assets/text/a.md');
  writeFileSync(join(root, 'assets', 'text', 'a.md'), 'changed between two reads');
  await loaders.readBytes('assets/text/a.md');
  assert.deepEqual(record().changed, ['assets/text/a.md']);
  assert.deepEqual(await recheckRevisions(root, record()), ['assets/text/a.md'], 'even though it now matches the second read');
});

test('an overlaid text read is the buffer’s, not the disk’s, and is not rechecked', async () => {
  const root = folder('overlaid');
  const overlays = [{path: 'assets/text/a.md', content: 'unsaved'}];
  const {loaders, record} = recordRevisions(withOverlays(createNodeLoaders(root), overlays), overlays);
  assert.equal(await loaders.readText('assets/text/a.md'), 'unsaved');
  assert.equal(record().revisions.size, 0);
  writeFileSync(join(root, 'assets', 'text', 'a.md'), 'saved elsewhere meanwhile');
  assert.deepEqual(await recheckRevisions(root, record()), []);
});
