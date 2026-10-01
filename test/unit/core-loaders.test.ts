/**
 * W1R: the real readers through the real file access (D155–D160). The four
 * examples resolve through `createNodeLoaders`, and every seam the wave-1
 * reconciliation closed is exercised with real bytes on a real disk: images
 * read through `FileAccess` and probed from their bytes, the reader's own rule
 * and fix in the finding, the format taken from the bytes, the byte limit held
 * by the read, a video measured by W3B's reader (M3.4) with its problems kept
 * for the R16 rule, and a resolved table handed to the chart renderer as it is.
 */
import assert from 'node:assert/strict';
import {closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, test} from 'node:test';

import {
  INPUT_LIMITS,
  createNodeLoaders,
  readPiece,
  renderChart,
  type ComicPiece,
  type DeckPiece,
  type DocumentPiece,
  type ImageProbeResult,
  type Loaders,
} from '../../src/core/index.js';
import {apngSource, pngSource} from '../fixtures/images/generate.js';
import {mp4Source, webmSource} from '../fixtures/video/generate.js';
import {applicationRoot} from '../helpers/paths.js';

const temporary: string[] = [];
after(() => {
  for (const directory of temporary) {
    rmSync(directory, {recursive: true, force: true});
  }
});

function tempPiece(files: Readonly<Record<string, string | Uint8Array>>): string {
  const root = mkdtempSync(join(tmpdir(), 'papeleria-loaders-'));
  temporary.push(root);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, ...path.split('/'));
    mkdirSync(join(full, '..'), {recursive: true});
    writeFileSync(full, content);
  }
  return root;
}

/** A deck with one image slide naming `assets/images/<name>`; the `src` value starts at line 7, column 18. */
function imageDeck(name: string): string {
  return `schema: 1\ntemplate: deck\ntitle: T\nslides:\n  - layout: image\n    title: T\n    image: {src: assets/images/${name}, alt: A picture.}\n`;
}

test('the four examples resolve through the real readers', async () => {
  for (const name of ['brand-overview', 'starter-deck', 'hours-report', 'sample-comic']) {
    const result = await readPiece({loaders: createNodeLoaders(join(applicationRoot, 'examples', name)), pieceLabel: `examples/${name}`});
    assert.deepEqual(result.findings, [], name);
    assert.ok(result.piece, name);
  }
  // The comic's eight pages are the prototype art scripts/gen-sample-comic.mjs draws (M4.5, D102), probed from their bytes.
  const comic = await readPiece({loaders: createNodeLoaders(join(applicationRoot, 'examples', 'sample-comic'))});
  assert.equal(comic.piece?.template, 'comic');
  assert.deepEqual(
    (comic.piece as ComicPiece).pages.map((page) => {
      const {path, kind, format, width, height} = page.image;
      return {path, kind, format, width, height};
    }),
    Array.from({length: 8}, (_unused, index) => ({path: `assets/images/pages/0${index + 1}.png`, kind: 'raster', format: 'png', width: 1600, height: 2200})),
  );
});

test('a resolved chart table is the chart renderer\'s input as it is (D156)', async () => {
  const {piece} = await readPiece({loaders: createNodeLoaders(join(applicationRoot, 'examples', 'hours-report'))});
  assert.equal(piece?.template, 'document');
  const document = piece as DocumentPiece;
  const charts = document.sections.flatMap((section) => section.blocks).flatMap((block) => (block.kind === 'chart' ? [block.chart] : []));
  assert.equal(charts.length, 2);
  for (const [index, chart] of charts.entries()) {
    assert.ok(chart.data.csv.ok, chart.data.path);
    const rendered = renderChart({
      id: `chart-${index + 1}`,
      type: chart.type,
      ...(chart.orientation === null ? {} : {orientation: chart.orientation}),
      table: chart.data.csv.table,
      x: chart.x,
      y: chart.y,
      ...(chart.series === null ? {} : {series: chart.series}),
      summary: chart.summary,
      locale: document.language,
    });
    assert.deepEqual(rendered.problems, [], chart.data.path);
    assert.match(rendered.svg ?? '', /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  }
});

test('a raster is read through FileAccess and probed from its bytes; its format is what the bytes are (D155, D160)', async () => {
  const png = await pngSource(1700, 40);
  for (const name of ['photo.png', 'labelled.jpg']) {
    const root = tempPiece({'papeleria.yaml': imageDeck(name), [`assets/images/${name}`]: png});
    const result = await readPiece({loaders: createNodeLoaders(root)});
    assert.deepEqual(result.findings, [], name);
    const deck = result.piece as DeckPiece;
    assert.deepEqual(deck.slides[0]!.image?.asset, {path: `assets/images/${name}`, kind: 'raster', format: 'png', width: 1700, height: 40, bytes: png.length});
  }
});

test('an image the reader refuses is R09 at the file with the reader\'s own message and fix (D157, D158)', async () => {
  const cases: Array<[string, string | Uint8Array, RegExp, RegExp]> = [
    ['mark.png', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>', /holds SVG markup/, /\.svg extension/],
    ['anim.png', apngSource(), /animated \(2 frames\)/, /one still frame/],
    ['note.webp', 'not an image at all', /not a PNG, JPEG or WebP/, /Export the image as PNG, JPEG or WebP/],
  ];
  for (const [name, content, message, fix] of cases) {
    const root = tempPiece({'papeleria.yaml': imageDeck(name), [`assets/images/${name}`]: content});
    const result = await readPiece({loaders: createNodeLoaders(root)});
    assert.equal(result.piece, null, name);
    assert.equal(result.findings.length, 1, name);
    const [finding] = result.findings;
    assert.deepEqual([finding!.rule, finding!.file, finding!.line, finding!.column], ['R09', `assets/images/${name}`, null, null], name);
    assert.match(finding!.message, message, name);
    assert.match(finding!.fix, fix, name);
    assert.deepEqual(finding!.relatedLocation, {file: 'papeleria.yaml', line: 7, column: 18}, name);
  }
});

test('the byte limit and links are held by the read, and such bytes never reach the reader (D155, D159)', async () => {
  const oversized = tempPiece({'papeleria.yaml': imageDeck('big.png'), 'assets/images/big.png': ''});
  // A sparse file: the size is real, the disk use is not.
  const handle = openSync(join(oversized, 'assets', 'images', 'big.png'), 'r+');
  ftruncateSync(handle, INPUT_LIMITS.mediaBytes + 1);
  closeSync(handle);

  const outside = tempPiece({'secret.png': await pngSource(8, 8)});
  const linked = tempPiece({'papeleria.yaml': imageDeck('linked.png')});
  mkdirSync(join(linked, 'assets', 'images'), {recursive: true});
  symlinkSync(join(outside, 'secret.png'), join(linked, 'assets', 'images', 'linked.png'));

  for (const [root, rule, line, message] of [
    [oversized, 'R09', null, 'The image assets/images/big.png is 104,857,601 bytes; the limit is 100 MiB (104,857,600 bytes).'],
    [linked, 'R09', 7, 'assets/images/linked.png is a symbolic link, and Papeleria does not follow links inside a piece.'],
  ] as const) {
    let probed = 0;
    const real = createNodeLoaders(root);
    const loaders: Loaders = {
      ...real,
      probeImage: async (bytes): Promise<ImageProbeResult> => {
        probed += 1;
        return real.probeImage(bytes);
      },
    };
    const result = await readPiece({loaders});
    assert.equal(probed, 0, message);
    assert.deepEqual(result.findings.map((finding) => [finding.rule, finding.line, finding.message]), [[rule, line, message]]);
  }
});

test('a video is read through FileAccess and measured by W3B\'s reader; its problems are kept for the R16 rule (D158, D92)', async () => {
  const manifest = (name: string): string =>
    `schema: 1\ntemplate: document\ntitle: T\nsections:\n  - heading: H\n    blocks:\n      - video: {src: assets/video/${name}, poster: assets/images/p.png, alt: A loop.}\n`;
  const silent = mp4Source({seconds: 6});
  const cases = [
    {name: 'loop.mp4', content: silent as string | Uint8Array, expected: {ok: true, probe: {duration: 6}}},
    {name: 'v.mp4', content: 'not really a video', code: 'unsupported_container'},
    {name: 'long.webm', content: webmSource({duration: 16_000}), code: 'too_long'},
  ];
  for (const each of cases) {
    const root = tempPiece({'papeleria.yaml': manifest(each.name), [`assets/video/${each.name}`]: each.content, 'assets/images/p.png': await pngSource(64, 36)});
    const result = await readPiece({loaders: createNodeLoaders(root)});
    assert.deepEqual(result.findings, [], 'R16 belongs to the video rule, not to resolve');
    const document = result.piece as DocumentPiece;
    const block = document.sections[0]!.blocks[0]!;
    assert.equal(block.kind, 'video');
    if (block.kind === 'video') {
      assert.equal(block.video.asset.bytes, each.content.length, each.name);
      if ('expected' in each) {
        assert.deepEqual(block.video.asset.probe, each.expected);
      } else {
        assert.equal(block.video.asset.probe.ok, false, each.name);
        if (!block.video.asset.probe.ok) {
          assert.deepEqual([block.video.asset.probe.problem.code, block.video.asset.probe.problem.rule, block.video.asset.probe.problem.line], [each.code, 'R16', null]);
        }
      }
      assert.equal(block.video.poster.format, 'png');
    }
  }
});
