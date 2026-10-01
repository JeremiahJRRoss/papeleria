/**
 * M1.3: resolution into an immutable Piece, and the slugs, strings and brand
 * settings it carries. Every read goes through the injected loaders, so these
 * tests run the seeded pieces and every failure against in-memory files. The
 * image and video readers are stand-ins here, so no test needs sharp; the real
 * readers run in core-loaders.test.ts.
 */
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative} from 'node:path';
import {after, test} from 'node:test';

import {
  INPUT_LIMITS,
  ToolResourceError,
  assignSlugs,
  createMemoryLoaders,
  createNodeFileAccess,
  deepFreeze,
  formatString,
  loadBrandFiles,
  loadStrings,
  parseBrandFile,
  parseCsv,
  parseStrings,
  probeImage,
  readPiece,
  resolveBrand,
  slugify,
  type ComicPiece,
  type CsvProblem,
  type DeckPiece,
  type DocumentPiece,
  type Finding,
  type ImageProbeResult,
  type Loaders,
  type MemoryEntries,
  type Piece,
  type VideoProbeResult,
} from '../../src/core/index.js';
import {applicationRoot, fixturePath} from '../helpers/paths.js';

const temporary: string[] = [];
after(() => {
  for (const directory of temporary) {
    rmSync(directory, {recursive: true, force: true});
  }
});

function readFolder(root: string): Record<string, Uint8Array> {
  const entries: Record<string, Uint8Array> = {};
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      if (name === '.DS_Store') {
        continue;
      }
      const path = join(directory, name);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else {
        entries[relative(root, path).split('\\').join('/')] = new Uint8Array(readFileSync(path));
      }
    }
  };
  walk(root);
  return entries;
}

/** Stand-in readers: every raster reads as a 1600×2400 PNG and every video as six seconds. */
const fakeProbeImage = async (bytes: Uint8Array): Promise<ImageProbeResult> => ({
  ok: true,
  probe: {width: 1600, height: 2400, bytes: bytes.length, kind: 'raster', format: 'png'},
});
const fakeProbeVideo = async (): Promise<VideoProbeResult> => ({ok: true, probe: {duration: 6}});

function loaders(entries: MemoryEntries, extra: Partial<Pick<Loaders, 'parseCsv' | 'probeImage' | 'probeVideo'>> = {}): Loaders {
  return createMemoryLoaders(entries, {probeImage: fakeProbeImage, probeVideo: fakeProbeVideo, ...extra});
}

async function read(entries: MemoryEntries, extra: Partial<Pick<Loaders, 'parseCsv' | 'probeImage' | 'probeVideo'>> = {}) {
  return readPiece({loaders: loaders(entries, extra)});
}

function positionOf(text: string, marker: string): {line: number; column: number} {
  const offset = text.indexOf(marker);
  assert.notEqual(offset, -1, `marker ${JSON.stringify(marker)} is missing`);
  const before = text.slice(0, offset);
  return {line: before.split('\n').length, column: offset - (before.lastIndexOf('\n') + 1) + 1};
}

const VALID_SVG = readFileSync(fixturePath('svg', 'valid.svg'), 'utf8');

// ---------------------------------------------------------------------------
// The seeded pieces

test('every seeded manifest resolves to a Piece with stub loaders', async () => {
  // The sample comic's pages are the generated prototype art (M4.5, D102), read like any other file.
  for (const piece of ['starter-deck', 'hours-report', 'sample-comic']) {
    const result = await read(readFolder(join(applicationRoot, 'examples', piece)));
    assert.deepEqual(result.findings, [], piece);
    assert.ok(result.piece, piece);
  }
});

test('without its art the sample comic reports each missing page at the manifest line that names it', async () => {
  const text = readFileSync(join(applicationRoot, 'examples', 'sample-comic', 'papeleria.yaml'), 'utf8');
  const entries = readFolder(join(applicationRoot, 'examples', 'sample-comic'));
  const art = Object.keys(entries).filter((path) => /^assets\/images\/pages\/0[1-8]\.png$/.test(path));
  // The committed pages (M4.5) are taken away, so the case keeps testing what its name says.
  assert.equal(art.length, 8, 'the eight generated pages are committed');
  for (const path of art) {
    delete entries[path];
  }
  const result = await read(entries);
  assert.equal(result.piece, null);
  assert.equal(result.findings.length, 8);
  assert.deepEqual(result.findings[0], {
    file: 'papeleria.yaml',
    ...positionOf(text, 'assets/images/pages/01.png'),
    rule: 'R02',
    severity: 'error',
    message: 'The image "assets/images/pages/01.png" is missing.',
    fix: 'Check the path and the file name, including upper and lower case; paths start with assets/.',
    detail: null,
  });
});

test('the starter deck resolves with slide numbers, source lines, default footers and rendered notes', async () => {
  const result = await read(readFolder(join(applicationRoot, 'examples', 'starter-deck')));
  const deck = result.piece as DeckPiece;
  assert.equal(deck.template, 'deck');
  assert.deepEqual(deck.slides.map((slide) => [slide.number, slide.layout]), [
    [1, 'cover'], [2, 'statement'], [3, 'three'], [4, 'chart'], [5, 'closing'],
  ]);
  // Lines 13-16; line 17 is blank and line 18 starts the next slide, so no line belongs to two slides.
  assert.deepEqual(deck.slides[0]!.source, {file: 'papeleria.yaml', lineStart: 13, lineEnd: 16});
  assert.equal(deck.slides[0]!.footer, 'Version 0.1 / 2026-09-21', 'a slide without a footer shows the edition');
  assert.equal(deck.slides[1]!.footer, 'Proposed brand principle');
  assert.equal(deck.slides[0]!.notes?.origin, 'file');
  assert.equal(deck.slides[0]!.notes?.path, 'assets/text/01-cover-notes.md');
  assert.match(deck.slides[0]!.notes!.html, /^<p>Speaker notes for the cover\./);
  assert.equal(deck.slides[2]!.columns.length, 3);
  assert.equal(deck.slides[2]!.columns[1]!.text.html, '<p>Evidence, assumptions, limitations, and terms.</p>\n');
  assert.equal(deck.slides[2]!.columns[1]!.text.baseLevel, 4);
  assert.equal(deck.slides[3]!.chart?.orientation, 'vertical');
  assert.equal(deck.slides[3]!.chart?.data.path, 'assets/data/hours-by-phase.csv');
  assert.deepEqual(deck.slides[3]!.chart?.data.csv, parseCsv(readFileSync(join(applicationRoot, 'examples', 'starter-deck', 'assets', 'data', 'hours-by-phase.csv'), 'utf8')));
  assert.equal(deck.brand.wordmark, 'papeleria');
  assert.equal(deck.brand.source, 'theme');
  assert.equal(deck.statusLabel, 'Draft · not issued');
  assert.equal(deck.strings.next, 'Next');
  assert.deepEqual(deck.credits, [{role: 'Author', name: 'Ross.moda studio'}]);
  assert.deepEqual(Object.keys(deck.assets.texts), ['assets/text/01-cover-notes.md']);
});

test('the hours report resolves with slugs, a new-page section, both CSVs and its source note', async () => {
  const result = await read(readFolder(join(applicationRoot, 'examples', 'hours-report')));
  const report = result.piece as DocumentPiece;
  assert.deepEqual(report.sections.map((section) => [section.slug, section.newPage, section.blocks.map((block) => block.kind)]), [
    ['executive-summary', false, ['text']],
    ['hours-by-phase', false, ['chart', 'table']],
    ['hours-by-week', false, ['chart']],
    ['next-action', true, ['text', 'note']],
  ]);
  assert.equal(report.docType, 'Project report');
  const [bar] = report.sections[1]!.blocks;
  assert.equal(bar?.kind === 'chart' ? bar.chart.orientation : null, 'horizontal');
  const [line] = report.sections[2]!.blocks;
  assert.equal(line?.kind === 'chart' ? line.chart.orientation : 'unset', null, 'a line chart has no orientation');
  assert.equal(line?.kind === 'chart' ? line.chart.showTable : null, true);
  assert.deepEqual(Object.keys(report.assets.data).sort(), ['assets/data/hours-by-phase.csv', 'assets/data/hours-by-week.csv']);
  const note = report.sections[3]!.blocks[1];
  assert.equal(note?.kind === 'note' ? note.tone : null, 'warning');
  assert.equal(report.sourceNote?.html, '<p>Basis: sample timesheets. Not a signed approval.</p>\n');
  assert.equal(report.sourceNote?.baseLevel, 2);
});

// ---------------------------------------------------------------------------
// Every field, from the schema base fixtures

function deckEntries(): Record<string, string | Uint8Array> {
  return {
    'papeleria.yaml': readFileSync(fixturePath('schema', 'deck.yaml'), 'utf8'),
    'assets/text/b.md': '# A heading in a column\n\nText from a file.',
    'assets/data/hours.csv': 'phase,hours\nReview,41\nBuild,26\n',
    'assets/data/weeks.csv': 'week,phase,hours\n2026-07-06,Build,10\n2026-07-06,Review,4\n',
    'assets/images/logos/client.svg': VALID_SVG,
    'assets/images/photo.jpg': 'jpeg bytes',
    'assets/images/texture.png': 'png bytes',
  };
}

test('a deck with every layout resolves every field it takes', async () => {
  const result = await read(deckEntries());
  assert.deepEqual(result.findings, []);
  const deck = result.piece as DeckPiece;
  assert.equal(deck.slides.length, 15);
  assert.equal(deck.brand.wordmark, 'studio');
  assert.equal(deck.brand.source, 'manifest');
  assert.equal(deck.register, 'Fixture / Every layout');
  assert.equal(deck.logo?.asset.kind, 'vector');
  assert.deepEqual([deck.logo?.asset.width, deck.logo?.asset.height], [800, 1200]);
  const two = deck.slides[3]!;
  assert.equal(two.columns[1]!.text.origin, 'file');
  assert.equal(two.columns[1]!.text.html, '<h4>A heading in a column</h4>\n<p>Text from a file.</p>\n');
  const table = deck.slides[7]!.table!;
  assert.deepEqual(table.columns, [
    {field: 'phase', label: 'phase'},
    {field: 'hours', label: 'Hours'},
  ]);
  const image = deck.slides[9]!.image!;
  assert.deepEqual([image.alt, image.decorative, image.focalPoint, image.credit, image.rights], ['A pier.', false, [50, 30], 'J. Ross', 'Studio photograph']);
  assert.equal(image.caption?.html, '<p>Dawn.</p>\n');
  const decorative = deck.slides[10]!.image!;
  assert.deepEqual([decorative.alt, decorative.decorative, decorative.focalPoint], [null, true, [50, 50]]);
  assert.deepEqual(deck.slides[12]!.swatches[0], {name: 'Process cyan', value: '#32BCE9', use: 'section rail'});
  assert.deepEqual(deck.slides[11]!.items, [{label: 'Considered', text: 'Not aloof.'}]);
  assert.equal(deck.slides[0]!.lead?.html, 'A lead.');
  assert.deepEqual([deck.title.text, deck.slides[0]!.title.text, deck.slides[0]!.lead?.text], ['Every layout.', 'Cover.', 'A lead.']);
  assert.equal(deck.slides[0]!.notes?.origin, 'inline');
  assert.equal(deck.slides[6]!.chart?.showTable, true);
  assert.equal(deck.slides[8]!.chart?.series, 'phase');
});

test('a comic resolves pages, panels in reading order and every detail kind, in Spanish', async () => {
  const result = await read({
    'papeleria.yaml': readFileSync(fixturePath('schema', 'comic.yaml'), 'utf8'),
    'assets/images/pages/01.png': 'page one',
    'assets/images/pages/02.svg': VALID_SVG,
    'assets/images/detail.png': 'detail',
    'assets/text/gull-note.md': 'The gull has been there **all week**.',
  });
  assert.deepEqual(result.findings, []);
  const comic = result.piece as ComicPiece;
  assert.equal(comic.language, 'es');
  assert.equal(comic.formatLabel, 'Web Comics', 'the manifest format wins over the localized default');
  assert.equal(comic.statusLabel, 'Edición de revisión / aprobación pendiente');
  assert.equal(comic.strings.next, 'Siguiente');
  const [first, second] = comic.pages;
  assert.deepEqual(first!.panels.map((panel) => [panel.number, panel.detail?.kind ?? null]), [
    [1, 'zoom'], [2, 'text'], [3, 'image'], [4, 'link'], [5, null],
  ]);
  assert.deepEqual(first!.panels[0]!.box, [0, 0, 100, 100]);
  const link = first!.panels[3]!.detail;
  assert.deepEqual(link?.kind === 'link' ? [link.href, link.label, link.link] : null, ['https://example.com/ferry', 'The ferry timetable', 'external']);
  const text = first!.panels[1]!.detail;
  assert.equal(text?.kind === 'text' ? text.text.html : null, '<p>The gull has been there <strong>all week</strong>.</p>\n');
  assert.equal(second!.image.kind, 'vector');
  assert.deepEqual(second!.panels, []);
  assert.ok(first!.panels[0]!.source.lineStart < first!.panels[1]!.source.lineStart);
});

test('a document resolves every block kind, including video with its poster', async () => {
  const result = await read({
    'papeleria.yaml': readFileSync(fixturePath('schema', 'document.yaml'), 'utf8'),
    'assets/text/summary.md': 'Review took the most hours.',
    'assets/data/hours.csv': 'phase,hours\nReview,41\n',
    'assets/images/photo.jpg': 'jpeg',
    'assets/images/poster.png': 'png',
    'assets/images/logos/client.svg': VALID_SVG,
    'assets/video/loop.mp4': 'mp4',
  });
  assert.deepEqual(result.findings, []);
  const document = result.piece as DocumentPiece;
  assert.equal(document.status, 'published');
  assert.equal(document.footer, 'Studio report');
  const kinds = document.sections.flatMap((section) => section.blocks.map((block) => block.kind));
  assert.deepEqual(kinds, ['text', 'text', 'chart', 'table', 'image', 'video', 'quote', 'note', 'callout', 'logo']);
  const video = document.sections[1]!.blocks[3];
  assert.ok(video?.kind === 'video');
  if (video.kind === 'video') {
    assert.deepEqual(video.video.asset.probe, {ok: true, probe: {duration: 6}});
    assert.equal(video.video.poster.path, 'assets/images/poster.png');
    assert.equal(video.video.alt, 'Water moving under the pier.');
  }
  const table = document.sections[1]!.blocks[1];
  assert.equal(table?.kind === 'table' ? table.table.columns : 'unset', null, 'no columns means every column in file order');
  const note = document.sections[1]!.blocks[5];
  assert.equal(note?.kind === 'note' ? note.tone : null, 'warning');
  assert.equal(document.sections[0]!.blocks[1]!.kind === 'text' ? (document.sections[0]!.blocks[1] as {text: {html: string}}).text.html : null, '<p>Inline <strong>Markdown</strong> works too.</p>\n');
});

test('the defaults come from the language: document type and comic format', async () => {
  const doc = await read({'papeleria.yaml': 'schema: 1\ntemplate: document\ntitle: T\nlanguage: es\nsections:\n  - heading: Uno\n    blocks:\n      - text: Palabras.\n'});
  assert.equal((doc.piece as DocumentPiece).docType, 'Documento');
  const comic = await read({'papeleria.yaml': 'schema: 1\ntemplate: comic\ntitle: T\nlanguage: es\npages:\n  - {image: assets/images/p.png, alt: Una página.}\n', 'assets/images/p.png': 'p'});
  assert.equal((comic.piece as ComicPiece).formatLabel, 'Web Cómics');
});

// ---------------------------------------------------------------------------
// Immutability

test('the Piece is immutable all the way down', async () => {
  const {piece} = await read(deckEntries());
  assert.ok(piece);
  const deck = piece as DeckPiece;
  const attempts: [string, () => void][] = [
    ['top level', () => ((deck as {title: unknown}).title = null)],
    ['slide', () => ((deck.slides[0] as {layout: string}).layout = 'type')],
    ['slides list', () => (deck.slides as unknown[]).push({})],
    ['column text', () => ((deck.slides[3]!.columns[0]!.text as {html: string}).html = '<script>')],
    ['assets', () => ((deck.assets.images as Record<string, unknown>)['x'] = {})],
    ['manifest', () => ((deck.manifest.slides[0] as {title: string}).title = 'changed')],
    ['strings', () => ((deck.strings as {next: string}).next = 'Onward')],
    ['source map', () => (deck.sourceMap as Map<string, unknown>).set('/x', {})],
    ['source map entry', () => ((deck.sourceMap.get('/title') as {value: unknown}).value = null)],
    ['source map position', () => ((deck.sourceMap.get('/title')!.value.start as {line: number}).line = 999)],
    ['source map key span', () => ((deck.sourceMap.get('/slides/0/layout')!.key!.end as {column: number}).column = 1)],
    ['CSV rows', () => (deck.slides[7]!.table!.data.csv as {table: {rows: string[][]}}).table.rows.push(['x'])],
  ];
  for (const [label, attempt] of attempts) {
    assert.throws(attempt, TypeError, label);
  }
  assert.equal(deck.sourceMap.get('/title')!.value.start.line, 4);
});

test('deepFreeze follows Map entries and objects frozen only at the top, and stops at cycles', () => {
  const inner = {count: 1};
  const shallow = Object.freeze({inner, list: [1]});
  const cyclic: {self?: unknown; entry: {n: number}} = {entry: {n: 1}};
  cyclic.self = cyclic;
  const map = new Map<object, {span: {line: number}}>([[{key: true}, {span: {line: 1}}]]);
  deepFreeze({shallow, cyclic, map});
  assert.ok(Object.isFrozen(inner) && Object.isFrozen(shallow.list) && Object.isFrozen(cyclic.entry));
  const [[key, value]] = [...map];
  assert.ok(Object.isFrozen(key) && Object.isFrozen(value) && Object.isFrozen(value!.span));
});

test('resolve freezes its own copies of what the readers and the caller hand it, never their objects', async () => {
  const csv = Object.freeze(parseCsv('phase,hours\nReview,41\n'));
  const video: VideoProbeResult = {ok: true, probe: {duration: 6}};
  const strings = {...loadStrings('en')};
  const manifest =
    'schema: 1\ntemplate: document\ntitle: T\nsections:\n  - heading: H\n    blocks:\n' +
    '      - table: {data: assets/data/h.csv}\n      - video: {src: assets/video/v.mp4, poster: assets/images/p.png, alt: A loop.}\n';
  const {piece} = await readPiece({
    loaders: loaders(
      {'papeleria.yaml': manifest, 'assets/data/h.csv': 'phase,hours\n', 'assets/video/v.mp4': 'mp4', 'assets/images/p.png': 'png'},
      {parseCsv: () => csv, probeVideo: async () => video},
    ),
    strings: {en: strings},
  });
  const document = piece as DocumentPiece;
  const [table, clip] = document.sections[0]!.blocks;
  assert.ok(table?.kind === 'table' && clip?.kind === 'video');
  if (table.kind === 'table' && clip.kind === 'video') {
    assert.deepEqual(table.table.data.csv, csv);
    assert.ok(table.table.data.csv.ok && Object.isFrozen(table.table.data.csv.table.rows[0]));
    assert.deepEqual(clip.video.asset.probe, video);
    assert.ok(Object.isFrozen(clip.video.asset.probe));
  }
  assert.ok(csv.ok && !Object.isFrozen(csv.table.rows), 'the reader\'s table is not frozen by resolve');
  assert.ok(!Object.isFrozen(video) && !Object.isFrozen(strings), 'nor the probe result or the strings the caller passed');
  assert.equal(document.strings.next, 'Next');
  assert.ok(Object.isFrozen(document.strings));
});

// ---------------------------------------------------------------------------
// R02 and R09 at honest locations

const DECK_HEAD = 'schema: 1\ntemplate: deck\ntitle: T\nslides:\n';

test('an absent file is R02 at the manifest token that names it, once per reference', async () => {
  const manifest = DECK_HEAD + '  - layout: cover\n    title: One\n    notes: assets/text/missing.md\n  - layout: closing\n    title: Two\n    notes: assets/text/missing.md\n';
  const result = await read({'papeleria.yaml': manifest});
  assert.equal(result.piece, null);
  assert.deepEqual(result.findings.map((finding) => [finding.rule, finding.line, finding.column, finding.message, finding.detail]), [
    ['R02', 7, 12, 'The Markdown file "assets/text/missing.md" is missing.', 'Nothing exists at assets.'],
    ['R02', 10, 12, 'The Markdown file "assets/text/missing.md" is missing.', 'Nothing exists at assets.'],
  ]);
});

test('a missing CSV, poster, video or logo is R02 at the token that names it', async () => {
  const manifest =
    'schema: 1\ntemplate: document\ntitle: T\nsections:\n  - heading: H\n    blocks:\n' +
    '      - table: {data: assets/data/absent.csv}\n' +
    '      - video: {src: assets/video/loop.mp4, poster: assets/images/absent-poster.png, alt: A loop.}\n' +
    '      - video: {src: assets/video/absent.mp4, poster: assets/images/poster.png, alt: A loop.}\n' +
    '      - logo: {src: assets/images/logos/absent.svg, alt: Client}\n';
  const result = await read({
    'papeleria.yaml': manifest,
    'assets/data/present.csv': 'a\n1\n',
    'assets/video/loop.mp4': 'mp4',
    'assets/images/poster.png': 'png',
    'assets/images/logos/other.svg': VALID_SVG,
  });
  assert.equal(result.piece, null);
  assert.deepEqual(result.findings.map((finding) => [finding.rule, finding.line, finding.column, finding.message]), [
    ['R02', 7, 23, 'The CSV file "assets/data/absent.csv" is missing.'],
    ['R02', 8, 53, 'The image "assets/images/absent-poster.png" is missing.'],
    ['R02', 9, 22, 'The video "assets/video/absent.mp4" is missing.'],
    ['R02', 10, 21, 'The logo "assets/images/logos/absent.svg" is missing.'],
  ]);
});

test('a folder where a file should be is R02; a device or pipe is R09', async () => {
  const folder = await read({'papeleria.yaml': DECK_HEAD + '  - layout: cover\n    title: T\n    notes: assets/text/notes.md\n', 'assets/text/notes.md/inside.md': 'x'});
  assert.deepEqual(folder.findings.map((finding) => [finding.rule, finding.message]), [['R02', 'The Markdown file "assets/text/notes.md" is a folder, not a file.']]);
  const device = await read({'papeleria.yaml': DECK_HEAD + '  - layout: cover\n    title: T\n    notes: assets/text/notes.md\n', 'assets/text/notes.md': {other: true}});
  assert.deepEqual(device.findings.map((finding) => [finding.rule, finding.message]), [['R09', 'The Markdown file "assets/text/notes.md" is not a regular file.']]);
});

test('an unsafe text path is R09 at its token; a sentence that merely mentions a file is text', async () => {
  const manifest = DECK_HEAD + '  - layout: cover\n    title: T\n    notes: assets/text/../../secret.md\n  - layout: closing\n    title: T\n    notes: See assets/text/summary.md for more.\n';
  const result = await read({'papeleria.yaml': manifest});
  assert.deepEqual(result.findings.map((finding) => [finding.rule, finding.line, finding.column, finding.message]), [
    ['R09', 7, 12, 'The path "assets/text/../../secret.md" uses a .. segment.'],
  ]);
});

test('a linked text file on disk is R09 at the naming token and is never read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'papeleria-resolve-'));
  const outside = mkdtempSync(join(tmpdir(), 'papeleria-outside-'));
  temporary.push(root, outside);
  mkdirSync(join(root, 'assets', 'text'), {recursive: true});
  writeFileSync(join(outside, 'secret.md'), 'Outside.');
  symlinkSync(join(outside, 'secret.md'), join(root, 'assets', 'text', 'notes.md'));
  writeFileSync(join(root, 'papeleria.yaml'), DECK_HEAD + '  - layout: cover\n    title: T\n    notes: assets/text/notes.md\n');
  const access = createNodeFileAccess(root);
  const result = await readPiece({loaders: {...access, parseCsv, probeImage: fakeProbeImage, probeVideo: fakeProbeVideo}});
  assert.deepEqual(result.findings.map((finding) => [finding.rule, finding.line, finding.column, finding.message]), [
    ['R09', 7, 12, 'assets/text/notes.md is a symbolic link, and Papeleria does not follow links inside a piece.'],
  ]);
});

test('a case-only mismatch on disk is R02, the same on every platform', async () => {
  const root = mkdtempSync(join(tmpdir(), 'papeleria-case-'));
  temporary.push(root);
  mkdirSync(join(root, 'assets', 'text'), {recursive: true});
  writeFileSync(join(root, 'assets', 'text', 'Notes.md'), 'Words.');
  writeFileSync(join(root, 'papeleria.yaml'), DECK_HEAD + '  - layout: cover\n    title: T\n    notes: assets/text/notes.md\n');
  const result = await readPiece({loaders: {...createNodeFileAccess(root), parseCsv, probeImage: fakeProbeImage, probeVideo: fakeProbeVideo}});
  assert.deepEqual(result.findings.map((finding) => finding.rule), ['R02']);
});

test('content problems are R09 at the file, with the naming token as the related location', async () => {
  const manifest = DECK_HEAD + '  - layout: cover\n    title: T\n    notes: assets/text/notes.md\n';
  const reference = {file: 'papeleria.yaml', line: 7, column: 12};
  const invalid = await read({'papeleria.yaml': manifest, 'assets/text/notes.md': new Uint8Array([0x63, 0x61, 0x66, 0xe9])});
  assert.deepEqual(invalid.findings, [
    {file: 'assets/text/notes.md', line: null, column: null, rule: 'R09', severity: 'error', message: 'The Markdown file assets/text/notes.md is not valid UTF-8 text.', fix: 'Save the file as UTF-8.', detail: null, relatedLocation: reference},
  ]);
  const large = await read({'papeleria.yaml': manifest, 'assets/text/notes.md': 'x'.repeat(INPUT_LIMITS.textBytes + 1)});
  assert.deepEqual(large.findings, [
    {
      file: 'assets/text/notes.md',
      line: null,
      column: null,
      rule: 'R09',
      severity: 'error',
      message: 'The Markdown file assets/text/notes.md is 5,242,881 bytes; the limit is 5 MiB (5,242,880 bytes).',
      fix: 'Split the text into several files.',
      detail: 'Input limit: 5,242,880 bytes per Markdown or CSV file (IC01).',
      relatedLocation: reference,
    },
  ]);
  const exact = await read({'papeleria.yaml': manifest, 'assets/text/notes.md': 'x'.repeat(INPUT_LIMITS.textBytes)});
  assert.deepEqual(exact.findings, [], 'exactly 5 MiB is accepted');
});

test('the text fields of a piece hold at most 20 MiB of Markdown, a file counted once for each field that names it (IC01, D164)', async () => {
  const mebibyte = 'a'.repeat(1_048_576);
  const documentNaming = (references: number) =>
    'schema: 1\ntemplate: document\ntitle: T\nsections:\n  - heading: H\n    blocks:\n' + '      - text: assets/text/a.md\n'.repeat(references);
  // Twenty fields naming one 1 MiB file are exactly at the limit, which is inclusive.
  const exact = await read({'papeleria.yaml': documentNaming(20), 'assets/text/a.md': mebibyte});
  assert.deepEqual(exact.findings, []);
  // A twenty-first is refused at its own token, and nothing after it is rendered.
  const over = await read({'papeleria.yaml': documentNaming(22), 'assets/text/a.md': mebibyte});
  assert.equal(over.piece, null);
  assert.deepEqual(over.findings.map((finding) => [finding.rule, finding.line, finding.column, finding.message, finding.detail]), [
    [
      'R09',
      27,
      15,
      "With this field the piece's text reaches 21 MiB of Markdown; a piece is limited to 20 MiB, counting a text file once for each field that names it.",
      "Input limit: 20,971,520 bytes of Markdown in a piece's text fields (IC01).",
    ],
  ]);
  // Markdown written in the manifest counts as well.
  const inline = documentNaming(20) + '      - text: "One more word."\n';
  assert.deepEqual((await read({'papeleria.yaml': inline, 'assets/text/a.md': mebibyte})).findings.map((finding) => [finding.rule, finding.line]), [['R09', 27]]);
});

test('Markdown problems are located in the file they are written in, or at the inline field', async () => {
  const manifest = DECK_HEAD + '  - layout: cover\n    title: T\n    notes: assets/text/notes.md\n  - layout: closing\n    title: T\n    notes: "Inline ![pier](assets/images/pier.jpg)"\n';
  const result = await read({'papeleria.yaml': manifest, 'assets/text/notes.md': 'Intro.\n\nA [bad link](javascript:alert(1)).\n'});
  assert.deepEqual(result.findings, [
    {
      file: 'assets/text/notes.md',
      line: 3,
      column: 3,
      rule: 'R09',
      severity: 'error',
      message: 'The link to javascript:alert(1) uses the javascript: scheme, which is not allowed.',
      fix: 'Use an https, http, mailto or tel address, a relative link or a #fragment.',
      detail: null,
      relatedLocation: {file: 'papeleria.yaml', line: 7, column: 12},
    },
    {
      file: 'papeleria.yaml',
      line: 10,
      column: 12,
      rule: 'R09',
      severity: 'error',
      message: 'Markdown image syntax is not allowed (assets/images/pier.jpg).',
      fix: 'Use an image block, which carries the alternative text, credit and rights, instead of Markdown image syntax.',
      detail: 'In the Markdown of this field, line 1, column 8.',
    },
  ]);
});

test('distinct Markdown problems in one manifest-written field are separate findings, as in a file', async () => {
  const notes = await read({'papeleria.yaml': DECK_HEAD + '  - layout: cover\n    title: T\n    notes: |\n      First [a](javascript:x) here.\n\n      Second [b](javascript:x) there.\n'});
  assert.deepEqual(notes.findings.map((finding) => [finding.rule, finding.line, finding.column, finding.detail]), [
    ['R09', 7, 12, 'In the Markdown of this field, line 1, column 7.'],
    ['R09', 7, 12, 'In the Markdown of this field, line 3, column 8.'],
  ]);
  const title = await read({'papeleria.yaml': 'schema: 1\ntemplate: deck\ntitle: "[a](javascript:x) and [b](javascript:x)"\nslides:\n  - layout: cover\n    title: T\n'});
  assert.deepEqual(title.findings.map((finding) => [finding.rule, finding.line, finding.column, finding.detail]), [
    ['R09', 3, 8, 'In the Markdown of this field, line 1, column 1.'],
    ['R09', 3, 8, 'In the Markdown of this field, line 1, column 23.'],
  ]);
});

test('a text file named by many fields is rendered once per heading level, unless footnotes give each field its own ids', async () => {
  const paragraph = 'Lorem *ipsum* dolor [sit](https://example.com) amet, `code` consectetur elit.\n\n';
  const large = paragraph.repeat(Math.floor(1_048_576 / paragraph.length));
  // Twenty references to a 1 MiB file, the most the piece's Markdown limit allows.
  const blocks = Array.from({length: 20}, () => '      - text: assets/text/a.md\n').join('');
  const started = performance.now();
  const shared = await read({'papeleria.yaml': `schema: 1\ntemplate: document\ntitle: T\nsections:\n  - heading: H\n    blocks:\n${blocks}`, 'assets/text/a.md': large});
  const elapsed = performance.now() - started;
  // Every field rendered the file again, and kept its own copy of the HTML: 25 references took 7.8 s before the fix.
  assert.ok(elapsed < 3_000, `20 references to a 1 MiB file took ${elapsed.toFixed(0)} ms; the budget is 3000 ms`);
  const texts = (shared.piece as DocumentPiece).sections[0]!.blocks.map((block) => (block.kind === 'text' ? block.text : null));
  assert.equal(texts.length, 20);
  assert.ok(texts.every((text) => text !== null && text.html === texts[0]!.html && text.html.startsWith('<p>Lorem <em>ipsum</em>')));
  assert.deepEqual(texts.map((text) => text!.pointer).slice(0, 2), ['/sections/0/blocks/0/text', '/sections/0/blocks/1/text']);

  // The heading level is the field's: slide notes are h3, column text h4.
  const levels = await read({
    'papeleria.yaml': DECK_HEAD + '  - layout: two\n    title: T\n    notes: assets/text/h.md\n    columns:\n      - {heading: A, text: assets/text/h.md}\n      - {heading: B, text: b}\n',
    'assets/text/h.md': '# Heading\n',
  });
  const slide = (levels.piece as DeckPiece).slides[0]!;
  assert.deepEqual([slide.notes!.html, slide.columns[0]!.text.html], ['<h3>Heading</h3>\n', '<h4>Heading</h4>\n']);

  // Footnote ids carry the field (D150), so a footnoted file is rendered for each field that names it.
  const footnoted = await read({
    'papeleria.yaml': 'schema: 1\ntemplate: document\ntitle: T\nsections:\n  - heading: H\n    blocks:\n      - text: assets/text/n.md\n      - text: assets/text/n.md\n',
    'assets/text/n.md': 'A claim.^[A source.]\n',
  });
  const [first, second] = (footnoted.piece as DocumentPiece).sections[0]!.blocks.map((block) => (block.kind === 'text' ? block.text.html : ''));
  assert.match(first!, /id="fn-sections-0-blocks-0-text-1"/);
  assert.match(second!, /id="fn-sections-0-blocks-1-text-1"/);
  assert.ok(!second!.includes('blocks-0'));

  // What is reported does not change: one finding in the file, related to the first field that names it.
  const refused = await read({
    'papeleria.yaml': 'schema: 1\ntemplate: document\ntitle: T\nsections:\n  - heading: H\n    blocks:\n      - text: assets/text/r.md\n      - text: assets/text/r.md\n      - text: assets/text/r.md\n',
    'assets/text/r.md': 'See [this](javascript:alert(1)).\n',
  });
  assert.deepEqual(refused.findings.map((finding) => [finding.rule, finding.file, finding.line, finding.column, finding.relatedLocation]), [
    ['R09', 'assets/text/r.md', 1, 5, {file: 'papeleria.yaml', line: 7, column: 15}],
  ]);
});

test('an SVG outside the profile is reported inside the SVG, once however often it is used', async () => {
  const bad = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">\n  <script>alert(1)</script>\n</svg>\n';
  const manifest = DECK_HEAD + '  - layout: image\n    title: T\n    image: {src: assets/images/mark.svg, alt: A mark.}\n  - layout: image\n    title: T\n    image: {src: assets/images/mark.svg, alt: The mark again.}\n';
  const result = await read({'papeleria.yaml': manifest, 'assets/images/mark.svg': bad});
  assert.deepEqual(result.findings, [
    {
      file: 'assets/images/mark.svg',
      line: 2,
      column: 3,
      rule: 'R09',
      severity: 'error',
      message: 'Scripts are not allowed in an SVG.',
      fix: 'Remove it, or export the SVG again with only the shapes, text and gradients it needs.',
      detail: null,
      relatedLocation: {file: 'papeleria.yaml', line: 7, column: 18},
    },
  ]);
});

test('an image the reader refuses is reported at the image with the reader\'s own rule and fix; oversized media never reaches it', async () => {
  const manifest = DECK_HEAD + '  - layout: image\n    title: T\n    image: {src: assets/images/photo.png, alt: A photo.}\n';
  const unreadable = await read({'papeleria.yaml': manifest, 'assets/images/photo.png': 'too wide'}, {
    probeImage: async () => ({
      ok: false,
      problem: {code: 'too_tall', rule: 'R09', message: 'At 800 px wide the image would be 16,400 px tall.', fix: 'Crop the image or split it into several images.', line: null},
    }),
  });
  assert.deepEqual(unreadable.findings.map((finding) => [finding.rule, finding.file, finding.line, finding.message, finding.fix, finding.relatedLocation]), [
    ['R09', 'assets/images/photo.png', null, 'At 800 px wide the image would be 16,400 px tall.', 'Crop the image or split it into several images.', {file: 'papeleria.yaml', line: 7, column: 18}],
  ]);
  let probed = false;
  const huge = new Uint8Array(INPUT_LIMITS.mediaBytes + 1);
  const oversized = await read({'papeleria.yaml': manifest, 'assets/images/photo.png': huge}, {
    probeImage: async (bytes) => {
      probed = true;
      return fakeProbeImage(bytes);
    },
  });
  assert.equal(probed, false);
  assert.deepEqual(oversized.findings.map((finding) => [finding.rule, finding.file, finding.line, finding.message]), [
    ['R09', 'assets/images/photo.png', null, 'The image assets/images/photo.png is 104,857,601 bytes; the limit is 100 MiB (104,857,600 bytes).'],
  ]);
});

test('the CSV row limit is the parser\'s, and resolve reports it once at the first row beyond it', async () => {
  const manifest = DECK_HEAD + '  - layout: chart\n    title: T\n    table: {data: assets/data/big.csv}\n';
  const rows = (count: number) => `n\n${'1\n'.repeat(count)}`;
  const accepted = await read({'papeleria.yaml': manifest, 'assets/data/big.csv': rows(INPUT_LIMITS.csvRows)});
  assert.deepEqual(accepted.findings, []);
  const refused = await read({'papeleria.yaml': manifest, 'assets/data/big.csv': rows(INPUT_LIMITS.csvRows + 1)});
  assert.deepEqual(refused.findings.map((finding) => [finding.rule, finding.file, finding.line, finding.message, finding.relatedLocation?.line]), [
    ['R09', 'assets/data/big.csv', 100_002, 'The data file has 100,001 data rows; a CSV is limited to 100,000.', 7],
  ]);
});

test('CSV and video content problems are kept for their own rules, not reported here', async () => {
  const problems: CsvProblem[] = [{code: 'header_duplicate', rule: 'R13', message: 'The header repeats phase.', fix: 'Rename one.', line: 1}];
  const table = await read({'papeleria.yaml': DECK_HEAD + '  - layout: chart\n    title: T\n    table: {data: assets/data/h.csv}\n', 'assets/data/h.csv': 'phase,phase\n'}, {
    parseCsv: () => ({ok: false, problems}),
  });
  assert.deepEqual(table.findings, [], 'R13 belongs to the CSV rule');
  assert.deepEqual((table.piece as DeckPiece).slides[0]!.table?.data.csv, {ok: false, problems});
  const video = await read(
    {
      'papeleria.yaml': 'schema: 1\ntemplate: document\ntitle: T\nsections:\n  - heading: H\n    blocks:\n      - video: {src: assets/video/v.mp4, poster: assets/images/p.png, alt: A loop.}\n',
      'assets/video/v.mp4': 'mp4',
      'assets/images/p.png': 'png',
    },
    {probeVideo: async () => ({ok: false, problem: {code: 'too_long', rule: 'R16', message: 'The video is 16 seconds long.', fix: 'Trim it to 15 seconds.', line: null}})},
  );
  assert.deepEqual(video.findings, [], 'R16 belongs to the video rule');
});

test('a detail link is held to the full policy, and worded by it, whether the schema or resolve refuses it', async () => {
  const comic = (href: string) =>
    `schema: 1\ntemplate: comic\ntitle: T\npages:\n  - image: assets/images/p.png\n    alt: A page.\n    panels:\n      - box: [0, 0, 50, 50]\n        transcript: T\n        detail: {href: ${href}, label: Timetable}\n`;
  const reasons = async (href: string) =>
    (await read({'papeleria.yaml': comic(href), 'assets/images/p.png': 'p'})).findings.map((finding) => [finding.rule, finding.line, finding.column, finding.message]);
  // The schema refuses a root-absolute link itself, in the link policy's words.
  assert.deepEqual(await reasons('/timetable'), [
    ['R09', 10, 24, 'The link "/timetable" uses an address from the root of the site, which breaks when the piece opens from disk.'],
  ]);
  // A control character before the slash gets past the schema's pattern; resolve, which trims it as a browser does, still refuses it.
  assert.deepEqual(await reasons('"\\x01/timetable"'), [
    ['R09', 10, 24, 'The link "\\u0001/timetable" uses an address from the root of the site, which breaks when the piece opens from disk.'],
  ]);
});

test('the memory loaders use the real readers unless a test passes its own', async () => {
  const manifest = DECK_HEAD + '  - layout: image\n    title: T\n    image: {src: assets/images/photo.png, alt: A photo.}\n';
  const result = await readPiece({loaders: createMemoryLoaders({'papeleria.yaml': manifest, 'assets/images/photo.png': 'x'})});
  assert.deepEqual(result.findings.map((finding) => [finding.rule, finding.message]), [['R09', 'The file is not a PNG, JPEG or WebP image.']]);
});

test('readPiece stops before resolving when the manifest or the schema fails', async () => {
  const both = await readPiece({loaders: loaders({'papeleria.yaml': 'schema: 1\n', 'papeleria.json': '{}'}), pieceLabel: 'examples/demo'});
  assert.deepEqual(both.findings.map((finding: Finding) => [finding.file, finding.line, finding.message]), [
    ['examples/demo', null, 'The piece has both papeleria.yaml and papeleria.json.'],
  ]);
  const invalid = await readPiece({loaders: loaders({'papeleria.yaml': DECK_HEAD + '  - layout: cover\n    title: T\n    notes: assets/text/missing.md\n    colour: red\n'})});
  assert.deepEqual(invalid.findings.map((finding: Finding) => finding.rule), ['R09'], 'no R02 cascades from a manifest that failed validation');
});

// ---------------------------------------------------------------------------
// Slugs (IC07)

test('slugify follows IC07: NFKD, marks removed, lower case, hyphen runs, trimmed', () => {
  const cases: [string, string][] = [
    ['Hours by phase', 'hours-by-phase'],
    ['Executive summary', 'executive-summary'],
    ['Año fiscal: Q3 (2026)', 'ano-fiscal-q3-2026'],
    ['Crème brûlée', 'creme-brulee'],
    ['  --Leading & trailing--  ', 'leading-trailing'],
    ['İstanbul', 'istanbul'],
    ['Ｆｕｌｌｗｉｄｔｈ ５', 'fullwidth-5'],
    ['数据 概览', '数据-概览'],
    ['Straße', 'straße'],
    ['!!!', 'section'],
    ['', 'section'],
  ];
  for (const [heading, slug] of cases) {
    assert.equal(slugify(heading), slug, heading);
  }
});

test('duplicate slugs take -2, -3 in source order and never collide with a natural suffix', () => {
  assert.deepEqual(assignSlugs(['Intro', 'Intro', 'Intro']), ['intro', 'intro-2', 'intro-3']);
  assert.deepEqual(assignSlugs(['Intro', 'Intro 2', 'Intro']), ['intro', 'intro-2', 'intro-3']);
  assert.deepEqual(assignSlugs(['Intro', 'Intro', 'Intro 2']), ['intro', 'intro-2', 'intro-2-2']);
  assert.deepEqual(assignSlugs(['???', '!!!']), ['section', 'section-2']);
  assert.deepEqual(assignSlugs(['Document', 'Notes'], {reserved: ['document']}), ['document-2', 'notes']);
});

// ---------------------------------------------------------------------------
// Strings and brand

test('the control strings load per language with all 37 keys', () => {
  const en = loadStrings('en');
  const es = loadStrings('es');
  assert.equal(Object.keys(en).length, 37);
  assert.equal(Object.keys(es).length, 37);
  assert.equal(en.external_link, 'External link');
  assert.equal(es.external_link, 'Enlace externo');
  assert.equal(es.doc_type_default, 'Documento');
  assert.ok(Object.isFrozen(en));
  assert.equal(formatString(en.slide_of, {n: 3, total: 16, title: 'Care'}), 'Slide 3 of 16: Care');
  assert.throws(() => formatString(en.slide_of, {n: 3}), /no value for \{total\}/);
});

test('a malformed strings file is a tool error, not a finding', () => {
  const good = Object.fromEntries(Object.entries(loadStrings('en')));
  assert.throws(() => parseStrings({...good, extra: 'x'}, 'strings.en.json'), (error: unknown) => error instanceof ToolResourceError && /unknown key extra/.test(error.message));
  const missing: Record<string, string> = {...good};
  delete missing['close'];
  assert.throws(() => parseStrings(missing, 'strings.en.json'), /no text for close/);
  assert.throws(() => parseStrings({...good, next: '  '}, 'strings.en.json'), /no text for next/);
  assert.throws(() => parseStrings([], 'strings.en.json'), /JSON object/);
});

test('the wordmark comes from the manifest, else the owner brand file, else the theme default', () => {
  const themeOnly = {theme: {wordmark: 'papeleria'}, owner: null};
  const withOwner = {theme: {wordmark: 'papeleria'}, owner: {wordmark: 'Owner mark'}};
  assert.deepEqual(resolveBrand(themeOnly), {wordmark: 'papeleria', source: 'theme'});
  assert.deepEqual(resolveBrand(withOwner), {wordmark: 'Owner mark', source: 'owner'});
  assert.deepEqual(resolveBrand(withOwner, 'Client'), {wordmark: 'Client', source: 'manifest'});
  assert.deepEqual(resolveBrand({theme: {wordmark: 'papeleria'}, owner: {}}), {wordmark: 'papeleria', source: 'theme'});
});

test('the brand files are read from the tool root; the owner file is optional and checked', () => {
  const shipped = loadBrandFiles();
  assert.deepEqual(shipped.theme, {wordmark: 'papeleria'});
  const root = mkdtempSync(join(tmpdir(), 'papeleria-brand-'));
  temporary.push(root);
  mkdirSync(join(root, 'theme'));
  mkdirSync(join(root, 'brand'));
  writeFileSync(join(root, 'theme', 'brand.default.json'), '{"wordmark": "papeleria"}');
  assert.deepEqual(loadBrandFiles(root), {theme: {wordmark: 'papeleria'}, owner: null});
  writeFileSync(join(root, 'brand', 'brand.json'), '{"wordmark": "Studio"}');
  assert.deepEqual(loadBrandFiles(root), {theme: {wordmark: 'papeleria'}, owner: {wordmark: 'Studio'}});
  writeFileSync(join(root, 'brand', 'brand.json'), '{"wordmak": "Typo"}');
  assert.throws(() => loadBrandFiles(root), (error: unknown) => error instanceof ToolResourceError && /unknown key wordmak/.test(error.message));
  assert.throws(() => parseBrandFile({wordmark: ' '}, 'brand.json'), /non-blank/);
});

test('tool resources saved with a byte-order mark are read; placeholders take only the values the caller gave', () => {
  const root = mkdtempSync(join(tmpdir(), 'papeleria-bom-'));
  temporary.push(root);
  mkdirSync(join(root, 'theme'));
  mkdirSync(join(root, 'brand'));
  mkdirSync(join(root, 'templates', 'shared'), {recursive: true});
  // Windows editors may save the owner's file with a byte-order mark, which JSON.parse refuses.
  writeFileSync(join(root, 'theme', 'brand.default.json'), '﻿{"wordmark": "papeleria"}');
  writeFileSync(join(root, 'brand', 'brand.json'), '﻿{"wordmark": "Studio"}');
  writeFileSync(join(root, 'templates', 'shared', 'strings.es.json'), `﻿${JSON.stringify(loadStrings('es'))}`);
  assert.deepEqual(loadBrandFiles(root), {theme: {wordmark: 'papeleria'}, owner: {wordmark: 'Studio'}});
  assert.deepEqual(loadStrings('es', root), loadStrings('es'));
  // Only one mark is removed: a second is still an error, as it is anywhere else in the file.
  writeFileSync(join(root, 'brand', 'brand.json'), '﻿﻿{"wordmark": "Studio"}');
  assert.throws(() => loadBrandFiles(root), ToolResourceError);

  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.throws(() => formatString(`{${name}}`, {}), new RegExp(`no value for \\{${name}\\}`), name);
  }
  assert.equal(formatString('{constructor}', {constructor: 'own'}), 'own');
});

test('resolve uses the owner wordmark when the manifest names none', async () => {
  const {piece} = await readPiece({
    loaders: loaders({'papeleria.yaml': DECK_HEAD + '  - layout: statement\n    title: T\n'}),
    brand: {theme: {wordmark: 'papeleria'}, owner: {wordmark: 'Owner mark'}},
  });
  assert.deepEqual((piece as Piece).brand, {wordmark: 'Owner mark', source: 'owner'});
});

test('a file where a folder should be is R02, and the detail says what is in the way', async () => {
  const manifest = 'schema: 1\ntemplate: document\ntitle: T\nsections:\n  - heading: H\n    blocks:\n      - text: assets/text/real.md/x.md\n';
  const result = await read({'papeleria.yaml': manifest, 'assets/text/real.md': 'A file, not a folder.'});
  assert.deepEqual(result.findings.map((finding) => [finding.rule, finding.line, finding.column, finding.message, finding.detail]), [
    ['R02', 7, 15, 'The Markdown file "assets/text/real.md/x.md" is missing.', 'assets/text/real.md is a file, not a folder.'],
  ]);
});

test('a manifest with hundreds of thousands of findings is reported, not a stack overflow', async () => {
  const credits = Array.from({length: 200_000}, () => 1);
  const result = await read({'papeleria.json': JSON.stringify({schema: 1, template: 'deck', title: 'T', credits, slides: [{layout: 'cover', title: 'C'}]})});
  assert.equal(result.piece, null);
  assert.equal(result.findings.length, 200_000);
});

test('a vector image keeps the SVG it validated, its exact viewBox and its size in whole pixels (IC02, D164)', async () => {
  const svg = '\uFEFF<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 595.28 841.89"><rect width="10" height="10"/></svg>\n';
  const manifest = DECK_HEAD + '  - layout: image\n    title: T\n    image: {src: assets/images/page.svg, alt: A page.}\n';
  const result = await read({'papeleria.yaml': manifest, 'assets/images/page.svg': svg});
  assert.deepEqual(result.findings, []);
  // The build publishes this text and never reads the file again, so nothing unchecked can take its place.
  assert.deepEqual((result.piece as DeckPiece).slides[0]!.image?.asset, {
    path: 'assets/images/page.svg',
    kind: 'vector',
    format: 'svg',
    width: 595,
    height: 842,
    viewBox: [0, 0, 595.28, 841.89],
    bytes: Buffer.byteLength(svg),
    markup: svg.slice(1),
  });
});

test('SVG markup under a raster name is refused by the real reader, so it cannot skip the SVG profile (D160)', async () => {
  const manifest = DECK_HEAD + '  - layout: image\n    title: T\n    image: {src: assets/images/mark.png, alt: A mark.}\n';
  const result = await read({'papeleria.yaml': manifest, 'assets/images/mark.png': VALID_SVG}, {probeImage});
  assert.equal(result.piece, null);
  assert.deepEqual(result.findings.map((finding) => [finding.rule, finding.file, finding.line, finding.message, finding.fix]), [
    [
      'R09',
      'assets/images/mark.png',
      null,
      'The file holds SVG markup. SVG images are validated and copied as they are, not resized.',
      'Give the file the .svg extension so it is handled as a vector image.',
    ],
  ]);
});
