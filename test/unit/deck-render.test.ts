/**
 * M1.5: the deck renderer. Every layout renders to the committed article in
 * test/fixtures/deck/layouts/ (the fixture deck holds each once, with a logo,
 * credits, notes from a file and inline, and a slide without notes); the page
 * chrome follows CONTRACT.md; the brand-overview piece renders to sixteen
 * slides whose layouts, titles, leads, footers and column text are the
 * reference deck's; the Spanish strings reach every control; and a piece the
 * schema would refuse is never rendered.
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';

import {createMemoryLoaders, createNodeLoaders, readPiece, type DeckPiece, type ResolvedSlide} from '../../src/core/index.js';
import {deckFirstView, render, slideCounter, TYPE_SAMPLES, type BuildContext} from '../../templates/deck/render.js';
import type {BuildMedia, PublishedImage} from '../../templates/shared/blocks.js';
import {pngSource} from '../fixtures/images/generate.js';
import {applicationRoot, fixturePath, scriptPath} from '../helpers/paths.js';
import {readTree} from '../helpers/pieces.js';
import {assertSnapshot} from '../helpers/snapshot.js';

const BUILD: BuildContext = {toolVersion: '0.0.0'};
const LAYOUTS_FIXTURE = fixturePath('deck', 'all-layouts');

async function fixtureDeck(overrides: Readonly<Record<string, string>> = {}): Promise<DeckPiece> {
  const entries: Record<string, string | Uint8Array> = {...readTree(LAYOUTS_FIXTURE), ...overrides};
  entries['assets/images/photo.png'] = await pngSource(1700, 900);
  const {piece, findings} = await readPiece({loaders: createMemoryLoaders(entries)});
  assert.deepEqual(findings, []);
  assert.equal(piece?.template, 'deck');
  return piece as DeckPiece;
}

/** What the build would publish for the fixture: two widths of the photo in both formats, and the SVG logo as it is. */
const FIXTURE_MEDIA: BuildMedia = {
  images: new Map<string, PublishedImage>([
    [
      'assets/images/photo.png',
      {
        kind: 'raster',
        width: 1700,
        height: 900,
        derivatives: [
          {path: 'assets/images/photo.00112233aabbccdd.800.webp', width: 800, height: 424, format: 'webp', bytes: 21_000},
          {path: 'assets/images/photo.00112233aabbccdd.800.avif', width: 800, height: 424, format: 'avif', bytes: 14_000},
          {path: 'assets/images/photo.00112233aabbccdd.1600.webp', width: 1600, height: 847, format: 'webp', bytes: 60_000},
          {path: 'assets/images/photo.00112233aabbccdd.1600.avif', width: 1600, height: 847, format: 'avif', bytes: 39_000},
        ],
      },
    ],
    ['assets/images/logos/client.svg', {kind: 'vector', width: 120, height: 32, file: {path: 'assets/images/logos/client.svg', bytes: 118}}],
  ]),
};

/** Each slide's article, whole; every one starts a line of its own, which R08 relies on. */
function slideArticles(html: string): string[] {
  const found = [...html.matchAll(/<article [\s\S]*?<\/article>/g)].map((match) => match[0]);
  assert.equal(html.split('\n').filter((line) => line.startsWith('<article ')).length, found.length, 'every article starts a line of its own');
  return found;
}

test('every layout renders to its committed article', async () => {
  const piece = await fixtureDeck();
  const {html} = render(piece, FIXTURE_MEDIA, BUILD);
  const rendered = slideArticles(html);
  assert.equal(rendered.length, piece.slides.length);
  const layouts = new Set<string>();
  for (const [index, slide] of piece.slides.entries()) {
    layouts.add(slide.layout);
    assertSnapshot(fixturePath('deck', 'layouts', `${String(slide.number).padStart(2, '0')}-${slide.layout}.html`), rendered[index]!);
  }
  assert.equal(layouts.size, 12, 'the fixture holds all twelve layouts');
});

test('the page chrome follows CONTRACT.md: head, strings block, one script, tools and status', async () => {
  const piece = await fixtureDeck();
  const {html, script} = render(piece, FIXTURE_MEDIA, BUILD);
  assert.equal(script, 'deck.js');
  assertSnapshot(fixturePath('deck', 'layouts', 'page.html'), html.replace(/\n<article [\s\S]*<\/article>\n/, '\n<!-- articles -->\n'));
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.deepEqual(
    scripts.map((match) => match[1]),
    [' type="application/json" id="papeleria-strings"', ' src="deck.js" defer'],
  );
  assert.deepEqual(JSON.parse(scripts[0]![2]!), piece.strings);
  assert.equal(scripts[1]![2], '');
  assert.match(html, /<p class="deck-status" id="deck-status" role="status">All slides are available without JavaScript\.<\/p>/, 'no_js_slides, the reference\u2019s own sentence (D131)');
  assert.match(html, /<title>Every layout on one deck<\/title>/, 'the page title is the manifest title as plain text');
  assert.match(html, /<meta name="generator" content="Papeleria 0\.0\.0">/);
  assert.doesNotMatch(html, /deck-header|robots|slides\.js|site\.js/);
});

test('slides carry their number, title focus target, source lines, status and counter', async () => {
  const piece = await fixtureDeck();
  const {html} = render(piece, FIXTURE_MEDIA, BUILD);
  for (const [index, article] of slideArticles(html).entries()) {
    const slide = piece.slides[index]!;
    const number = slide.number;
    assert.match(article, new RegExp(`^<article class="deck-slide slide-layout-${slide.layout}" id="slide-${number}" aria-labelledby="title-${number}" data-source-line-start="${slide.source.lineStart}" data-source-line-end="${slide.source.lineEnd}">`));
    assert.match(article, new RegExp(`<h2 class="slide-title" id="title-${number}" tabindex="-1">`));
    assert.match(article, new RegExp(`<span class="slide-status">Review edition / approval pending</span><span>${slideCounter(number, piece.slides.length)}</span></footer>`));
    assert.equal(article.includes('<aside class="slide-notes" aria-label="Speaker notes"><strong>Speaker notes &amp; source detail</strong> '), slide.notes !== null);
  }
  assert.equal(piece.slides.at(-1)!.notes, null, 'the closing slide has no notes, and so no aside');
  assert.deepEqual([slideCounter(1, 5), slideCounter(16, 16), slideCounter(7, 120)], ['01 / 05', '16 / 16', '007 / 120']);
});

test('notes follow their label after a space, with no line break between paragraphs (W1D observation 2)', async () => {
  const piece = await fixtureDeck();
  const cover = slideArticles(render(piece, FIXTURE_MEDIA, BUILD).html)[0]!;
  const aside = /<aside class="slide-notes"[^>]*>([\s\S]*?)<\/aside>/.exec(cover)![1]!;
  assert.ok(aside.startsWith('<strong>Speaker notes &amp; source detail</strong> <p>Notes for the cover, from a file.</p><p>A second paragraph'));
  assert.doesNotMatch(aside, /\n/);
});

test('the brand-overview piece renders to the reference deck\'s sixteen slides', async () => {
  const {piece} = await readPiece({loaders: createNodeLoaders(join(applicationRoot, 'examples', 'brand-overview'))});
  const deck = piece as DeckPiece;
  const {html} = render(deck, {images: new Map()}, BUILD);
  const generated = slideArticles(html);
  const reference = [...readFileSync(join(applicationRoot, 'reference', 'decks', 'brand-overview.html'), 'utf8').matchAll(/<article [\s\S]*?<\/article>/g)].map((match) => match[0]);
  assert.equal(generated.length, 16);
  assert.equal(reference.length, 16);
  const part = (article: string, pattern: RegExp): string | undefined => pattern.exec(article)?.[1];
  const canvas = (article: string): string => part(article, /<div class="slide-canvas">([\s\S]*?)<\/div><aside/)!;
  for (let index = 0; index < 16; index += 1) {
    const [ours, theirs] = [generated[index]!, reference[index]!];
    for (const pattern of [
      /class="(deck-slide slide-layout-[a-z]+)"/,
      /<h2 class="slide-title" id="title-\d+"[^>]*>([\s\S]*?)<\/h2>/,
      /<p class="slide-lead">([\s\S]*?)<\/p>/,
      /<div class="slide-register"><span>([^<]*)<\/span>/,
      /<footer class="slide-footer"><span>([^<]*)<\/span>/,
      /(\d\d \/ 16)<\/span><\/footer>/,
    ]) {
      assert.equal(part(ours, pattern), part(theirs, pattern), `slide ${index + 1}: ${pattern.source}`);
    }
    // The slide content, apart from the status span the generated footer adds (D61) and
    // the reference's trailing space in the three-column class (W1D observation 5).
    const content = (article: string): string => part(canvas(article), /<div class="slide-content">([\s\S]*)<footer/)!.replace('class="slide-columns "', 'class="slide-columns"');
    assert.equal(content(ours), content(theirs), `slide ${index + 1}: content`);
  }
});

test('the type slide shows exactly the theme samples the content check documents', async () => {
  const check = (await import(pathToFileURL(scriptPath('check-brand-overview-content.mjs')).href)) as {
    TYPE_SAMPLES: readonly {eyebrow: string; className: string; sample: string}[];
  };
  assert.deepEqual(
    TYPE_SAMPLES.map((sample) => ({eyebrow: sample.eyebrow, className: sample.className, sample: sample.lines.join('<br>')})),
    check.TYPE_SAMPLES,
  );
});

test('a Spanish deck takes every control and label from the Spanish strings', async () => {
  const piece = await fixtureDeck({
    'papeleria.yaml': readFileSync(join(LAYOUTS_FIXTURE, 'papeleria.yaml'), 'utf8').replace('language: en', 'language: es'),
  });
  const {html} = render(piece, FIXTURE_MEDIA, BUILD);
  assert.match(html, /<html lang="es">/);
  for (const expected of [
    '<a class="skip-link" href="#deck-main">Ir al contenido</a>',
    'id="prev-slide" type="button">Anterior</button>',
    'id="all-slides" type="button" aria-pressed="false">Ver todas las diapositivas</button>',
    'role="status">Todas las diapositivas están disponibles sin JavaScript.</p>',
    'aria-label="Notas del orador"><strong>Notas del orador y detalle de fuentes</strong>',
    '<span class="slide-status">Edición de revisión / aprobación pendiente</span>',
    '<span class="sr-only">Sin valor</span>',
  ]) {
    assert.ok(html.includes(expected), expected);
  }
});

test('the first view is the logo and the first slide\'s picture', async () => {
  const piece = await fixtureDeck();
  assert.deepEqual(
    deckFirstView(piece, FIXTURE_MEDIA).map((entry) => [entry.image.kind, entry.slot.sizes]),
    [['vector', '120px']],
  );
  const imageFirst = await fixtureDeck({
    'papeleria.yaml': readFileSync(join(LAYOUTS_FIXTURE, 'papeleria.yaml'), 'utf8').replace(/slides:\n/, 'slides:\n  - layout: image\n    title: First.\n    image: {src: assets/images/photo.png, alt: A picture.}\n\n'),
  });
  const firstView = deckFirstView(imageFirst, FIXTURE_MEDIA);
  assert.deepEqual(firstView.map((entry) => entry.image.kind), ['vector', 'raster']);
  const [first] = slideArticles(render(imageFirst, FIXTURE_MEDIA, BUILD).html);
  assert.doesNotMatch(first!, /loading="lazy"/, 'the first slide loads its picture at once');
  const [, second] = slideArticles(render(imageFirst, FIXTURE_MEDIA, BUILD).html);
  assert.match(second!, /<img src="assets\/images\/logos\/client\.svg" width="120" height="32" class="slide-logo" alt="Client &amp; partner logo" loading="lazy">/);
});

test('rendering is deterministic and never mutates the piece', async () => {
  const piece = await fixtureDeck();
  const first = render(piece, FIXTURE_MEDIA, BUILD);
  const second = render(piece, FIXTURE_MEDIA, BUILD);
  assert.equal(first.html, second.html);
  assert.deepEqual(first.targets, second.targets);
  assert.ok(Object.isFrozen(piece.slides[0]));
});

test('a piece the schema would refuse is never rendered', async () => {
  const piece = await fixtureDeck();
  const broken = (index: number, change: Partial<ResolvedSlide>): DeckPiece => ({
    ...piece,
    slides: piece.slides.map((slide, at) => (at === index ? {...slide, ...change} : slide)),
  });
  const two = piece.slides.findIndex((slide) => slide.layout === 'two');
  const chart = piece.slides.findIndex((slide) => slide.layout === 'chart');
  const palette = piece.slides.findIndex((slide) => slide.layout === 'palette');
  const cases: [string, DeckPiece][] = [
    ['three columns on a two slide', broken(two, {columns: [...piece.slides[two]!.columns, piece.slides[two]!.columns[0]!]})],
    ['columns on a statement', broken(1, {columns: piece.slides[two]!.columns})],
    ['no chart on a chart slide', broken(chart, {chart: null})],
    ['a swatch that is not a colour', broken(palette, {swatches: [{name: 'Bad', value: 'red;position:fixed'}]})],
    ['an empty title', broken(0, {title: {...piece.slides[0]!.title, markdown: ' '}})],
  ];
  for (const [label, value] of cases) {
    assert.throws(() => render(value, FIXTURE_MEDIA, BUILD), /E_INTERNAL/, label);
  }
  assert.throws(() => render(piece, {images: new Map()}, BUILD), /E_INTERNAL: the build published nothing/);
});
