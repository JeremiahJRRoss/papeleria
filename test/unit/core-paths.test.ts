/**
 * M1.3: manifest file references (IC02, C04, C05) and the file access behind
 * them: syntax per asset kind, exact-case names, links refused rather than
 * followed, and canonical paths kept inside the piece — for text and, since
 * W1R, for the bytes of images and video (D155).
 */
import assert from 'node:assert/strict';
import {appendFileSync, linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, test} from 'node:test';

import {
  FileChangedError,
  FileInspector,
  FileTooLargeError,
  INPUT_LIMITS,
  InvalidTextEncodingError,
  checkAssetPath,
  createMemoryFileAccess,
  createNodeFileAccess,
  createNodeLoaders,
  describeAssetKind,
  inspectAsset,
  isTextFileReference,
  locateToolRoot,
  parseCsv,
  probeImage,
  probeVideoUnavailable,
  quoteForMessage,
  readPiece,
  type FileAccess,
  type Loaders,
} from '../../src/core/index.js';
import {applicationRoot} from '../helpers/paths.js';

const temporary: string[] = [];
after(() => {
  for (const directory of temporary) {
    rmSync(directory, {recursive: true, force: true});
  }
});

function tempPiece(): string {
  const directory = mkdtempSync(join(tmpdir(), 'papeleria-paths-'));
  temporary.push(directory);
  return directory;
}

test('C05: a text value is a file reference exactly when it starts with assets/text/ and ends with .md', () => {
  assert.equal(isTextFileReference('assets/text/summary.md'), true);
  assert.equal(isTextFileReference('assets/text/notes/01-cover.md'), true);
  assert.equal(isTextFileReference('assets/text/ is where notes live, see README.md'), true, 'the rule is literal');
  for (const value of ['See assets/text/summary.md', 'assets/text/summary.md ', 'Assets/text/summary.md', 'assets/text/summary.MD', 'assets/text/summary.markdown', 'A sentence.']) {
    assert.equal(isTextFileReference(value), false, value);
  }
});

test('every unsafe or malformed path is refused with its own reason', () => {
  const cases: [Parameters<typeof checkAssetPath>[0], string, string][] = [
    ['image', '', 'empty'],
    ['image', 'assets/images/a\u0000.png', 'nul'],
    ['image', 'assets\\images\\a.png', 'backslash'],
    ['image', 'assets/images/%2e%2e/a.png', 'percent'],
    ['image', '//server/share/a.png', 'unc'],
    ['image', '/etc/a.png', 'absolute'],
    ['image', 'C:/images/a.png', 'drive'],
    ['image', 'c:a.png', 'drive'],
    ['image', 'https://example.com/a.png', 'url'],
    ['image', 'file:///a.png', 'url'],
    ['image', 'assets/images/../a.png', 'traversal'],
    ['image', 'assets/./images/a.png', 'traversal'],
    ['image', '../assets/images/a.png', 'traversal'],
    ['image', 'assets/images//a.png', 'empty-segment'],
    ['image', 'assets/images/.hidden.png', 'hidden'],
    ['image', 'assets/images/my photo.png', 'characters'],
    ['image', 'assets/images/photo\u00e9.png', 'characters'],
    ['image', 'assets/images/folder./a.png', 'characters'],
    ['image', 'assets/images/con.png', 'reserved'],
    ['text', 'assets/text/LPT1.md', 'reserved'],
    ['image', 'images/a.png', 'folder'],
    ['logo', 'assets/images/a.svg', 'folder'],
    ['data', 'assets/data/2026/a.csv', 'folder'],
    ['video', 'assets/video/clips/a.mp4', 'folder'],
    ['image', 'assets/images/a.gif', 'extension'],
    ['image', 'assets/images/a.PNG', 'extension'],
    ['text', 'assets/text/.md', 'hidden'],
    ['data', 'assets/data/a.tsv', 'extension'],
    // A 256-character name, and a 241-character path whose names are all short.
    ['text', `assets/text/${'a'.repeat(253)}.md`, 'too-long'],
    ['text', `assets/text/${'a'.repeat(226)}.md`, 'too-long'],
    ['image', `assets/images/${'folder-10/'.repeat(23)}a.png`, 'too-long'],
  ];
  for (const [kind, value, code] of cases) {
    assert.equal(checkAssetPath(kind, value)?.code, code, `${kind} ${JSON.stringify(value)}`);
  }
  for (const [kind, value] of [
    ['text', 'assets/text/summary.md'],
    ['text', 'assets/text/notes/a-b_c.1.md'],
    ['image', 'assets/images/pages/01.png'],
    ['image', 'assets/images/logos/client.svg'],
    ['image', 'assets/images/photo.jpeg'],
    ['logo', 'assets/images/logos/nested/mark.webp'],
    ['data', 'assets/data/hours-by-phase.csv'],
    ['video', 'assets/video/loop.webm'],
    // Exactly 240 characters.
    ['text', `assets/text/${'a'.repeat(225)}.md`],
  ] as const) {
    assert.equal(checkAssetPath(kind, value), null, `${kind} ${value}`);
  }
});

test('a name or path too long to be portable is refused, naming the length and the limit', () => {
  const name = checkAssetPath('text', `assets/text/${'a'.repeat(297)}.md`);
  assert.deepEqual([name?.code, name?.message.replace(/"[^"]*"/, '"…"'), name?.fix], [
    'too-long',
    'The path "…" (312 characters) has a file or folder name of 300 characters; names are limited to 255.',
    'Shorten the file or folder name.',
  ]);
  // The path is quoted cut, its start and its file name kept, and its length stated once (D175).
  assert.equal(name?.message.match(/"[^"]*"/)?.[0], `"assets/text/${'a'.repeat(48)}…${'a'.repeat(57)}.md"`);
  const path = checkAssetPath('text', `assets/text/${'abc/'.repeat(1_200)}x.md`);
  assert.deepEqual([path?.code, path?.message.replace(/"[^"]*"/, '"…"'), path?.fix], [
    'too-long',
    'The path "…" is 4,816 characters long; paths are limited to 240 so the piece also opens on Windows.',
    'Shorten the file and folder names, or use fewer sub-folders.',
  ]);
});

test('path messages quote what the author wrote, backslashes and all, with controls escaped', () => {
  assert.equal(quoteForMessage('assets\\images\\a.png'), '"assets\\images\\a.png"');
  assert.equal(quoteForMessage('a\u0000b\tc'), '"a\\u0000b\\u0009c"');
  assert.equal(checkAssetPath('image', 'assets\\images\\a.png')?.message, 'The path "assets\\images\\a.png" uses a backslash.');
  assert.deepEqual(describeAssetKind('data'), {folder: 'assets/data/', extensions: ['.csv'], nested: false});
});

test('inspection walks every component: missing, link, folder and file', async () => {
  const access = createMemoryFileAccess({
    'assets/text/summary.md': 'Words.',
    'assets/text/linked.md': {symlink: '../../outside.md'},
    'assets/images': {symlink: '/elsewhere/images'},
    'assets/data/device.csv': {other: true},
  });
  assert.deepEqual(await inspectAsset('assets/text/summary.md', access), {ok: true, bytes: 6});
  assert.deepEqual(await inspectAsset('assets/text/absent.md', access), {ok: false, reason: 'missing', at: 'assets/text/absent.md'});
  assert.deepEqual(await inspectAsset('assets/video/loop.mp4', access), {ok: false, reason: 'missing', at: 'assets/video'});
  assert.deepEqual(await inspectAsset('assets/text/linked.md', access), {ok: false, reason: 'symlink', at: 'assets/text/linked.md'});
  assert.deepEqual(await inspectAsset('assets/images/a.png', access), {ok: false, reason: 'symlink', at: 'assets/images'});
  assert.deepEqual(await inspectAsset('assets/text', access), {ok: false, reason: 'not-a-file', at: 'assets/text'});
  assert.deepEqual(await inspectAsset('assets/data/device.csv', access), {ok: false, reason: 'not-a-file', at: 'assets/data/device.csv'});
  // A file used as a folder is reported where the walk stopped, as a file in a folder's place.
  assert.deepEqual(await inspectAsset('assets/text/summary.md/x.md', access), {ok: false, reason: 'not-a-folder', at: 'assets/text/summary.md'});
});

test('a file whose canonical path leaves the piece is refused even without a link on the way', async () => {
  const inner = createMemoryFileAccess({'assets/text/a.md': 'x'});
  const lying: FileAccess = {
    ...inner,
    realpath: async (path) => (path === '' ? '/pieces/demo' : '/pieces/demo-other/assets/text/a.md'),
  };
  assert.deepEqual(await inspectAsset('assets/text/a.md', lying), {ok: false, reason: 'outside-piece', at: 'assets/text/a.md'});
});

test('the inspector looks at each folder once per run', async () => {
  let calls = 0;
  const inner = createMemoryFileAccess({'assets/images/a.png': 'a', 'assets/images/b.png': 'b'});
  const counting: FileAccess = {...inner, stat: (path) => {
    calls += 1;
    return inner.stat(path);
  }};
  const inspector = new FileInspector(counting);
  await inspector.inspect('assets/images/a.png');
  await inspector.inspect('assets/images/b.png');
  assert.equal(calls, 4, 'assets, assets/images, a.png, b.png');
});

test('Node file access: exact-case names on every disk', async () => {
  const root = tempPiece();
  mkdirSync(join(root, 'assets', 'text'), {recursive: true});
  writeFileSync(join(root, 'assets', 'text', 'Summary.md'), 'Words.');
  const access = createNodeFileAccess(root);
  assert.deepEqual(await access.stat('assets/text/Summary.md'), {kind: 'file', bytes: 6});
  assert.equal(await access.stat('assets/text/summary.md'), null, 'a case-only match is absent, as it is on a case-sensitive disk');
  assert.equal(await access.stat('assets/Text/Summary.md'), null);
  assert.deepEqual(await access.stat('assets'), {kind: 'directory', bytes: (await access.stat('assets'))!.bytes});
  assert.equal(await access.stat('assets/text/Summary.md/inside'), null);
});

test('Node file access: a folder is listed once per inspection run, so many files in one folder take linear time', async () => {
  const root = tempPiece();
  mkdirSync(join(root, 'assets', 'images'), {recursive: true});
  for (let index = 0; index < 6_000; index += 1) {
    writeFileSync(join(root, 'assets', 'images', `p${index}.png`), 'x');
  }
  const access = createNodeFileAccess(root);
  // An access the editor wraps, such as an overlay of unsaved files, passes the run on and keeps the linear time.
  const wrapped: FileAccess = {...access, stat: (path, run) => access.stat(path, run)};
  for (const [name, used] of [['the access', access], ['a wrapper', wrapped]] as const) {
    const inspector = new FileInspector(used);
    const started = performance.now();
    for (let index = 0; index < 6_000; index += 1) {
      assert.equal((await inspector.inspect(`assets/images/p${index}.png`)).ok, true);
    }
    const elapsed = performance.now() - started;
    // Every stat read the whole folder: 4,000 files took 10 s, 6,000 about 23 s, before the fix.
    assert.ok(elapsed < 5_000, `6,000 files through ${name} took ${elapsed.toFixed(0)} ms; the budget is 5000 ms`);
    assert.equal((await inspector.inspect('assets/images/P1.png')).ok, false, 'names stay exact-case within a run');
  }
});

test('Node file access: a long-lived access never carries a folder listing from one run into the next', async () => {
  const root = tempPiece();
  mkdirSync(join(root, 'assets', 'text'), {recursive: true});
  writeFileSync(join(root, 'assets', 'text', 'Notes.md'), 'Words.');
  const access = createNodeFileAccess(root);
  const first = new FileInspector(access);
  assert.equal((await first.inspect('assets/text/Notes.md')).ok, true);
  assert.equal((await first.inspect('assets/text/notes.md')).ok, false);
  // The author renames the file and adds another between two checks, as in the editor.
  renameSync(join(root, 'assets', 'text', 'Notes.md'), join(root, 'assets', 'text', 'notes.md'));
  writeFileSync(join(root, 'assets', 'text', 'added.md'), 'New.');
  const second = new FileInspector(access);
  assert.equal((await second.inspect('assets/text/Notes.md')).ok, false);
  assert.equal((await second.inspect('assets/text/notes.md')).ok, true);
  assert.equal((await second.inspect('assets/text/added.md')).ok, true);
  // A stat outside any run reads the folder itself.
  assert.equal(await access.stat('assets/text/Notes.md'), null);
  assert.equal((await access.stat('assets/text/notes.md'))?.kind, 'file');
});

test('Node file access: an over-long name is a finding at its token, and absent to stat, never a thrown ENAMETOOLONG', async () => {
  const root = tempPiece();
  mkdirSync(join(root, 'assets', 'text'), {recursive: true});
  const long = 'a'.repeat(300);
  writeFileSync(join(root, 'papeleria.yaml'), `schema: 1\ntemplate: deck\ntitle: T\nslides:\n  - layout: cover\n    title: T\n    notes: assets/text/${long}.md\n`);
  const result = await readPiece({loaders: createNodeLoaders(root)});
  assert.equal(result.piece, null);
  assert.deepEqual(result.findings.map((finding) => [finding.rule, finding.line, finding.column]), [['R09', 7, 12]]);
  assert.match(result.findings[0]!.message, /has a file or folder name of 303 characters; names are limited to 255\.$/);
  // Where the system's own limit is lower than the path rules allow, stat reports absence rather than throwing.
  const access = createNodeFileAccess(root);
  assert.equal(await access.stat(`assets/text/${long}.md`), null);
  assert.equal(await access.stat(long), null);
});

test('Node file access: links are reported, never followed, and reading one fails', async () => {
  const root = tempPiece();
  const outside = tempPiece();
  mkdirSync(join(root, 'assets', 'text'), {recursive: true});
  writeFileSync(join(outside, 'secret.md'), 'Outside the piece.');
  symlinkSync(join(outside, 'secret.md'), join(root, 'assets', 'text', 'link.md'));
  symlinkSync(outside, join(root, 'assets', 'images'));
  const access = createNodeFileAccess(root);
  assert.deepEqual(await access.stat('assets/text/link.md'), {kind: 'symlink', bytes: (await access.stat('assets/text/link.md'))!.bytes});
  assert.equal((await access.stat('assets/images'))?.kind, 'symlink');
  assert.deepEqual(await inspectAsset('assets/text/link.md', access), {ok: false, reason: 'symlink', at: 'assets/text/link.md'});
  assert.deepEqual(await inspectAsset('assets/images/secret.md', access), {ok: false, reason: 'symlink', at: 'assets/images'});
  await assert.rejects(access.readText('assets/text/link.md'), /ELOOP|EMLINK|symbolic/i);
});

test('Node file access: a hard link is read like any regular file, wherever its other names are (D164(d))', async () => {
  const root = tempPiece();
  const outside = tempPiece();
  mkdirSync(join(root, 'assets', 'text'), {recursive: true});
  writeFileSync(join(root, 'assets', 'text', 'original.md'), 'Inside the piece.');
  writeFileSync(join(outside, 'kept.md'), 'Written elsewhere, as cp -al or a pnpm store leaves it.');
  linkSync(join(root, 'assets', 'text', 'original.md'), join(root, 'assets', 'text', 'twin.md'));
  linkSync(join(outside, 'kept.md'), join(root, 'assets', 'text', 'kept.md'));
  assert.equal(statSync(join(root, 'assets', 'text', 'kept.md')).nlink, 2);
  const access = createNodeFileAccess(root);
  for (const name of ['twin.md', 'kept.md']) {
    assert.deepEqual((await inspectAsset(`assets/text/${name}`, access)).ok, true, name);
  }
  assert.equal(await access.readText('assets/text/kept.md'), 'Written elsewhere, as cp -al or a pnpm store leaves it.');
  writeFileSync(
    join(root, 'papeleria.yaml'),
    'schema: 1\ntemplate: deck\ntitle: T\nslides:\n  - layout: cover\n    title: T\n    notes: assets/text/kept.md\n  - layout: statement\n    title: S\n    notes: assets/text/twin.md\n',
  );
  const result = await readPiece({loaders: createNodeLoaders(root)});
  assert.deepEqual(result.findings, []);
  assert.ok(result.piece);
  assert.deepEqual(Object.keys(result.piece.assets.texts).sort(), ['assets/text/kept.md', 'assets/text/twin.md']);
});

test('Node file access: a piece reached through a linked folder still resolves inside itself', async () => {
  const real = tempPiece();
  const parent = tempPiece();
  mkdirSync(join(real, 'assets', 'text'), {recursive: true});
  writeFileSync(join(real, 'assets', 'text', 'a.md'), 'x');
  symlinkSync(real, join(parent, 'piece'));
  const access = createNodeFileAccess(join(parent, 'piece'));
  assert.deepEqual(await inspectAsset('assets/text/a.md', access), {ok: true, bytes: 1});
});

test('Node file access: strict UTF-8 with the byte-order mark removed', async () => {
  const root = tempPiece();
  writeFileSync(join(root, 'bom.md'), Buffer.from([0xef, 0xbb, 0xbf, 0x48, 0x69]));
  writeFileSync(join(root, 'latin1.md'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  const access = createNodeFileAccess(root);
  assert.equal(await access.readText('bom.md'), 'Hi');
  await assert.rejects(access.readText('latin1.md'), (error: unknown) => error instanceof InvalidTextEncodingError && error.path === 'latin1.md');
  // The in-memory access decodes bytes the same way.
  const memory = createMemoryFileAccess({'latin1.md': new Uint8Array([0x63, 0x61, 0x66, 0xe9]), 'bom.md': '\uFEFFHi'});
  await assert.rejects(memory.readText('latin1.md'), InvalidTextEncodingError);
  assert.equal(await memory.readText('bom.md'), 'Hi');
});

test('the tool root is the papeleria package, from source and from lib alike', () => {
  assert.equal(locateToolRoot(), applicationRoot);
  assert.equal(locateToolRoot(join(applicationRoot, 'lib', 'src', 'core')), applicationRoot);
  assert.throws(() => locateToolRoot(tmpdir()), /package root was not found/);
});

/** A piece on disk whose text file is swapped, after inspection, by `swap` just before it is read. */
async function readWithSwap(procFileDescriptors: boolean, swap: (root: string, outside: string) => void): Promise<Awaited<ReturnType<typeof readPiece>>> {
  const root = tempPiece();
  const outside = tempPiece();
  mkdirSync(join(root, 'assets', 'text'), {recursive: true});
  writeFileSync(join(root, 'papeleria.yaml'), 'schema: 1\ntemplate: document\ntitle: Doc\nsections:\n  - heading: One\n    blocks:\n      - text: assets/text/a.md\n');
  writeFileSync(join(root, 'assets', 'text', 'a.md'), 'Inside the piece.');
  writeFileSync(join(outside, 'a.md'), 'SECRET outside the piece.');
  const access = createNodeFileAccess(root, {procFileDescriptors});
  const loaders: Loaders = {
    ...access,
    async readText(path, options) {
      if (path === 'assets/text/a.md') {
        swap(root, outside);
      }
      return access.readText(path, options);
    },
    parseCsv,
    probeImage,
    probeVideo: probeVideoUnavailable,
  };
  return readPiece({loaders});
}

for (const procFileDescriptors of [true, false]) {
  const how = procFileDescriptors ? 'the opened file located through /proc' : 'the portable canonical-path check';
  test(`Node file access: a folder swapped for a link after inspection is caught when the file is read (${how})`, async () => {
    const result = await readWithSwap(procFileDescriptors, (root, outside) => {
      renameSync(join(root, 'assets', 'text'), join(root, 'assets', 'text-before'));
      symlinkSync(outside, join(root, 'assets', 'text'));
    });
    assert.equal(result.piece, null);
    assert.deepEqual(result.findings.map((finding) => [finding.rule, finding.line, finding.column, finding.message]), [
      ['R09', 7, 15, 'The Markdown file "assets/text/a.md" changed while Papeleria was reading it, and what was opened is not the file that was checked.'],
    ]);
    assert.ok(!JSON.stringify(result).includes('SECRET'));
  });
}

test('Node file access: a file removed after inspection is reported, not thrown', async () => {
  const result = await readWithSwap(true, (root) => {
    rmSync(join(root, 'assets', 'text', 'a.md'));
  });
  assert.equal(result.piece, null);
  assert.deepEqual(result.findings.map((finding) => [finding.rule, finding.line, finding.column]), [['R09', 7, 15]]);
  assert.match(result.findings[0]!.message, /changed while Papeleria was reading it/);
});

test('Node file access: the size limit is checked on the file actually opened', async () => {
  const grown = await readWithSwap(true, (root) => {
    appendFileSync(join(root, 'assets', 'text', 'a.md'), Buffer.alloc(INPUT_LIMITS.textBytes, 0x61));
  });
  assert.equal(grown.piece, null);
  assert.deepEqual(grown.findings.map((finding) => [finding.rule, finding.file, finding.line, finding.message]), [
    ['R09', 'assets/text/a.md', null, 'The Markdown file assets/text/a.md is 5,242,897 bytes; the limit is 5 MiB (5,242,880 bytes).'],
  ]);
  // The same guard, called directly, on disk and in memory.
  const root = tempPiece();
  writeFileSync(join(root, 'a.md'), 'twelve bytes');
  await assert.rejects(createNodeFileAccess(root).readText('a.md', {maxBytes: 11}), (error: unknown) => error instanceof FileTooLargeError && error.bytes === 12);
  assert.equal(await createNodeFileAccess(root).readText('a.md', {maxBytes: 12}), 'twelve bytes');
  await assert.rejects(createMemoryFileAccess({'a.md': 'twelve bytes'}).readText('a.md', {maxBytes: 11}), FileTooLargeError);
});

test('Node file access: a final link that appears after inspection is refused as a change, not followed', async () => {
  const root = tempPiece();
  const outside = tempPiece();
  writeFileSync(join(outside, 'secret.md'), 'SECRET');
  symlinkSync(join(outside, 'secret.md'), join(root, 'a.md'));
  await assert.rejects(createNodeFileAccess(root).readText('a.md'), FileChangedError);
});

test('readBytes: the exact bytes, with the same checks as readText, on disk and in memory', async () => {
  const root = tempPiece();
  const outside = tempPiece();
  const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x0d, 0x0a]);
  writeFileSync(join(root, 'a.png'), binary);
  writeFileSync(join(outside, 'secret.png'), 'SECRET');
  symlinkSync(join(outside, 'secret.png'), join(root, 'linked.png'));
  const access = createNodeFileAccess(root);
  assert.ok(Buffer.from(await access.readBytes('a.png')).equals(binary), 'bytes that are not UTF-8 come back unchanged');
  assert.ok(Buffer.from(await access.readBytes('a.png', {maxBytes: binary.length})).equals(binary), 'the bound is inclusive');
  await assert.rejects(access.readBytes('a.png', {maxBytes: binary.length - 1}), (error: unknown) => error instanceof FileTooLargeError && error.bytes === binary.length);
  await assert.rejects(access.readBytes('linked.png'), FileChangedError);
  await assert.rejects(access.readBytes('absent.png'), FileChangedError);

  const memory = createMemoryFileAccess({'a.png': binary, 'b.md': 'text', 'link.png': {symlink: 'a.png'}});
  assert.ok(Buffer.from(await memory.readBytes('a.png')).equals(binary));
  (await memory.readBytes('a.png')).fill(0);
  assert.ok(Buffer.from(await memory.readBytes('a.png')).equals(binary), 'each read is a copy, as from disk');
  assert.deepEqual([...(await memory.readBytes('b.md'))], [...Buffer.from('text')]);
  await assert.rejects(memory.readBytes('a.png', {maxBytes: 3}), FileTooLargeError);
  await assert.rejects(memory.readBytes('link.png'), /ENOENT/);
});

for (const procFileDescriptors of [true, false]) {
  const how = procFileDescriptors ? 'the opened file located through /proc' : 'the portable canonical-path check';
  test(`readBytes: an image folder swapped for a link after inspection is caught when the bytes are read (${how})`, async () => {
    const root = tempPiece();
    const outside = tempPiece();
    mkdirSync(join(root, 'assets', 'images'), {recursive: true});
    writeFileSync(join(root, 'papeleria.yaml'), 'schema: 1\ntemplate: document\ntitle: Doc\nsections:\n  - heading: One\n    blocks:\n      - image: {src: assets/images/a.png, alt: A picture}\n');
    writeFileSync(join(root, 'assets', 'images', 'a.png'), 'inside');
    writeFileSync(join(outside, 'a.png'), 'SECRET outside the piece.');
    const access = createNodeFileAccess(root, {procFileDescriptors});
    let probed = 0;
    const loaders: Loaders = {
      ...access,
      async readBytes(path, options) {
        if (path === 'assets/images/a.png') {
          renameSync(join(root, 'assets', 'images'), join(root, 'assets', 'images-before'));
          symlinkSync(outside, join(root, 'assets', 'images'));
        }
        return access.readBytes(path, options);
      },
      parseCsv,
      probeImage: async (bytes) => {
        probed += 1;
        return probeImage(bytes);
      },
      probeVideo: probeVideoUnavailable,
    };
    const result = await readPiece({loaders});
    assert.equal(result.piece, null);
    assert.equal(probed, 0, 'the bytes never reach the reader');
    assert.deepEqual(result.findings.map((finding) => [finding.rule, finding.line]), [['R09', 7]]);
    assert.match(result.findings[0]!.message, /changed while Papeleria was reading it/);
    assert.ok(!JSON.stringify(result).includes('SECRET'));
  });
}
