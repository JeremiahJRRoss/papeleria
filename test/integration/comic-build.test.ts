/**
 * M4.2 (D106, D108, D109): real builds of comics through the whole pipeline.
 *
 * A comic's dist/ carries its one script, reader.js, as `npm run build` wrote
 * it; the engine's MIT licence at vendor/page-flip/LICENSE, staged with the
 * notices; the originals its zoom details open, written from the bytes the
 * piece's FileAccess read (D155), never before a zoom asks for one; and a
 * report whose first view has no limit and whose phone images each keep
 * 307,200 bytes. Every auto-loaded URL is relative and in dist/, and the page
 * passes R08 with its panels' inline boxes.
 */
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {after, test} from 'node:test';

import {
  createMemoryLoaders,
  FileChangedError,
  FileTooLargeError,
  INPUT_LIMITS,
  readPiece,
  type ComicPiece,
  type Loaders,
} from '../../src/core/index.js';
import {publishOriginals} from '../../src/build/originals.js';
import {runPipeline} from '../../src/build/pipeline.js';
import {discardGeneration, openGeneration} from '../../src/build/write.js';
import {readerFixtureImages} from '../fixtures/comic/generate.js';
import {applicationRoot, fixturePath, runNode} from '../helpers/paths.js';
import {copyPiece, readTree, removeTemporaryFolders, temporaryFolder} from '../helpers/pieces.js';

after(removeTemporaryFolders);

const CLI = join(applicationRoot, 'lib', 'src', 'cli', 'index.js');
const FIXTURE = fixturePath('comic', 'reader');

async function readerPiece(label: string): Promise<string> {
  const root = copyPiece(FIXTURE, label);
  for (const [path, bytes] of Object.entries(await readerFixtureImages())) {
    mkdirSync(dirname(join(root, path)), {recursive: true});
    writeFileSync(join(root, path), bytes);
  }
  return root;
}

test('a comic builds into a self-contained dist/: the page, reader.js, the engine\'s licence, the stylesheets and the images', async () => {
  const root = await readerPiece('comic-build');
  const {report} = await runPipeline({root, label: 'comic'}, {kind: 'dist'});
  assert.equal(report.status, 'ok', JSON.stringify(report.findings));
  assert.deepEqual(report.findings, []);
  const dist = join(root, 'dist');
  const files = Object.keys(readTree(dist)).sort();
  for (const expected of [
    'index.html',
    'reader.js',
    'vendor/page-flip/LICENSE',
    'LICENSE',
    'NOTICE.md',
    'THIRD_PARTY.md',
    'Inter-OFL.txt',
    'Poppins-OFL.txt',
    'theme/css/comic.css',
    'theme/css/base.css',
    'theme/css/print.css',
    'assets/images/pages/01.png',
    'assets/images/pages/04.png',
    'assets/images/pages/03.svg',
    'assets/images/pages/05.svg',
  ]) {
    assert.ok(files.includes(expected), `${expected} is in dist/`);
  }
  assert.ok(!files.some((file) => file.endsWith('.js') && file !== 'reader.js'), 'one script');
  assert.ok(!files.includes('assets/images/pages/02.png'), 'page 2 has no zoom: its original is not published');
  assert.ok(!files.includes('assets/images/extra.png'), 'an image detail is derived, not copied');

  const same = (output: string, source: string) => assert.ok(readFileSync(join(dist, output)).equals(readFileSync(join(applicationRoot, source))), output);
  same('reader.js', 'lib/clients/reader.js');
  same('vendor/page-flip/LICENSE', 'vendor/page-flip/LICENSE');
  same('theme/css/comic.css', 'templates/comic/comic.css');
  for (const page of ['01', '04']) {
    assert.ok(readFileSync(join(dist, 'assets', 'images', 'pages', `${page}.png`)).equals(readFileSync(join(root, 'assets', 'images', 'pages', `${page}.png`))), `the original of page ${page}, byte for byte`);
  }
  const thirdParty = readFileSync(join(dist, 'THIRD_PARTY.md'), 'utf8');
  assert.match(thirdParty, /including the page, the reader in `reader\.js` and the stylesheets, is under the Apache License 2\.0/);
  assert.match(thirdParty, /\| StPageFlip 2\.0\.7 \| line 2 of `reader\.js`, byte for byte, and the four layout rules `theme\/css\/comic\.css` restates from it \| MIT \| Copyright \(c\) 2020 Nodlik \| `vendor\/page-flip\/LICENSE` \|/);
});

test('IC04: the zoom originals wait for a zoom to ask; every URL the page loads is relative and in dist/', async () => {
  const root = await readerPiece('comic-urls');
  await runPipeline({root, label: 'comic'}, {kind: 'dist'});
  const dist = join(root, 'dist');
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /\s(?:src|srcset)="[^"]*pages\/0[14]\.png/, 'no src or srcset names an original');
  assert.match(html, /data-zoom-src="assets\/images\/pages\/01\.png"/);
  for (const match of html.matchAll(/\s(src|href|srcset|data-zoom-src)="([^"]*)"/g)) {
    const [, attribute, value] = match;
    if (attribute === 'href' && (value!.startsWith('#') || /^(https?|mailto|tel):/.test(value!))) {
      continue;
    }
    for (const url of attribute === 'srcset' ? value!.split(',').map((candidate) => candidate.trim().split(/\s+/)[0]!) : [value!]) {
      assert.doesNotMatch(url, /^(?:[a-z][a-z0-9+.-]*:|\/)/i, `${attribute}="${url}" is relative`);
      assert.ok(existsSync(join(dist, url)), `${attribute}="${url}" is in dist/`);
    }
  }
});

test('the report: a first view with no limit, each phone image within 307,200 bytes, and the report line says so', async () => {
  const root = await readerPiece('comic-report');
  const {report} = await runPipeline({root, label: 'comic'}, {kind: 'dist'});
  assert.equal(report.weight?.budgetBytes, null);
  assert.equal(report.weight?.withinBudget, true);
  const phone = report.weight?.phoneImages ?? [];
  assert.deepEqual(
    phone.map(([path]) => path.replace(/\.[0-9a-f]{16}\./, '.#.')),
    [
      'assets/images/pages/01.#.800.webp',
      'assets/images/pages/01.#.800.avif',
      'assets/images/pages/02.#.800.webp',
      'assets/images/pages/02.#.800.avif',
      'assets/images/pages/03.svg',
      'assets/images/pages/04.#.800.webp',
      'assets/images/pages/04.#.800.avif',
      'assets/images/pages/05.svg',
    ].filter((path) => !path.endsWith('.avif') || phone.some(([written]) => written.endsWith('.avif'))),
  );
  assert.ok(phone.every(([, bytes, within]) => within && bytes <= 307_200));

  const cli = await runNode(CLI, ['check', root]);
  assert.equal(cli.code, 0, cli.stderr);
  assert.match(cli.stderr, /^Checked .* · 0 errors · 0 warnings · first view [\d,]+ bytes · largest phone image [\d,]+ of 307,200 bytes\n$/);
});

test('R07: a page whose phone image is over 307,200 bytes stops the build, one error per file at the page image', async () => {
  const root = await readerPiece('comic-heavy');
  // Noise does not compress: 800 × 2,000 random pixels make a phone image far past the limit in every format.
  const width = 1600;
  const height = 4000;
  const pixels = Buffer.alloc(width * height * 3);
  let seed = 7;
  for (let index = 0; index < pixels.length; index += 1) {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    pixels[index] = seed >> 16;
  }
  const {default: sharp} = await import('sharp');
  writeFileSync(join(root, 'assets', 'images', 'pages', '02.png'), await sharp(pixels, {raw: {width, height, channels: 3}}).png().toBuffer());
  const {report} = await runPipeline({root, label: 'comic'}, {kind: 'dist'});
  assert.equal(report.status, 'failed');
  const findings = report.findings.filter((finding) => finding.rule === 'R07');
  assert.ok(findings.length >= 1);
  for (const finding of findings) {
    assert.deepEqual([finding.severity, finding.file, finding.line], ['error', 'assets/images/pages/02.png', null]);
    assert.match(finding.message, /^The phone image assets\/images\/pages\/02\.[0-9a-f]{16}\.800\.(?:webp|avif) is [\d,]+ bytes, [\d,]+ over the comic phone-image budget of 307,200\.$/);
    assert.equal(finding.relatedLocation?.file, 'papeleria.yaml');
  }
  assert.equal(existsSync(join(root, 'dist')), false, 'nothing is published');
});

test('D155: an original is written from the bytes FileAccess reads, under the IC01 bound; a file too large or changed is R09 at the image', async () => {
  const entries = {...readTree(FIXTURE), ...(await readerFixtureImages())};
  const {piece} = await readPiece({loaders: createMemoryLoaders(entries)});
  const comic = piece as ComicPiece;
  const reads: [string, number | undefined][] = [];
  const base = createMemoryLoaders(entries);
  const spying: Loaders = {
    ...base,
    readBytes: async (path, options) => {
      reads.push([path, options?.maxBytes]);
      return base.readBytes(path, options);
    },
  };
  const generation = await openGeneration(temporaryFolder('originals'));
  try {
    const {findings} = await publishOriginals(comic, spying, generation);
    assert.deepEqual(findings, []);
    assert.deepEqual(reads, [
      ['assets/images/pages/01.png', INPUT_LIMITS.mediaBytes],
      ['assets/images/pages/04.png', INPUT_LIMITS.mediaBytes],
    ]);
    assert.ok(readFileSync(join(generation.directory, 'assets', 'images', 'pages', '01.png')).equals(Buffer.from(entries['assets/images/pages/01.png'])));
    assert.equal(generation.files.get('assets/images/pages/04.png'), entries['assets/images/pages/04.png'].length);

    const refusing = (error: Error): Loaders => ({...base, readBytes: async () => Promise.reject(error)});
    const large = await publishOriginals(comic, refusing(new FileTooLargeError('assets/images/pages/01.png', INPUT_LIMITS.mediaBytes + 1, INPUT_LIMITS.mediaBytes)), generation);
    assert.equal(large.findings.length, 2, 'one for each original');
    const first = large.findings[0]!.finding;
    assert.deepEqual([first.rule, first.severity, first.file, first.line], ['R09', 'error', 'assets/images/pages/01.png', null]);
    assert.match(first.message, /^The image assets\/images\/pages\/01\.png is [\d,]+ bytes; the limit is /);
    assert.equal(first.relatedLocation?.file, 'papeleria.yaml');
    const changed = await publishOriginals(comic, refusing(new FileChangedError('assets/images/pages/01.png', 'its size changed')), generation);
    assert.match(changed.findings[0]!.finding.message, /changed while Papeleria was reading it/);
    await assert.rejects(publishOriginals(comic, refusing(new Error('disk on fire')), generation), /disk on fire/, 'anything else is the tool\'s failure, not a finding');
  } finally {
    await discardGeneration(generation);
  }
});
