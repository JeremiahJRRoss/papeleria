/**
 * M1.11, blocks half: each shared block against a committed snapshot under
 * test/fixtures/blocks/, and the rules a snapshot cannot show on its own:
 * escaping in every position, derivative widths read from the media and never
 * assumed (D40), loading off the first view, the deck's reserved ids (D54(e)),
 * the table region named from author text, and a renderer that refuses to run
 * on anything the build could not have published.
 */
import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {test} from 'node:test';

import {
  loadStrings,
  parseCsv,
  renderChart,
  renderMarkdown,
  type DataAsset,
  type ResolvedChart,
  type ResolvedImage,
  type ResolvedLogo,
  type ResolvedTable,
  type ResolvedText,
  type VectorImageAsset,
} from '../../src/core/index.js';
import {
  chartInput,
  derivativesOf,
  escapeHtml,
  escapeJsonForHtml,
  joinBlockHtml,
  logoSlot,
  renderChartBlock,
  renderImageBlock,
  renderLogoBlock,
  renderTableBlock,
  renderTextBlock,
  type BlockContext,
  type BuildMedia,
  type ImageSlot,
  type PublishedImage,
  type PublishedRaster,
} from '../../templates/shared/blocks.js';
import {fixturePath} from '../helpers/paths.js';
import {assertSnapshot} from '../helpers/snapshot.js';

const EN = loadStrings('en');
const ES = loadStrings('es');
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

const SLOT: ImageSlot = {sizes: '(max-width: 800px) 100vw, 800px', slotWidth: (width) => Math.min(width, 800)};

function snapshot(name: string, html: string): void {
  assertSnapshot(fixturePath('blocks', `${name}.html`), html);
}

function context(images: Readonly<Record<string, PublishedImage>> = {}, language: 'en' | 'es' = 'en'): BlockContext {
  const media: BuildMedia = {images: new Map(Object.entries(images))};
  return {strings: language === 'en' ? EN : ES, language, media};
}

function text(markdown: string, pointer: string, baseLevel = 3): ResolvedText {
  const rendered = renderMarkdown(markdown, {baseLevel, docId: pointer, externalLinkLabel: EN.external_link});
  return {pointer, origin: 'inline', path: null, markdown, html: rendered.html, baseLevel};
}

function data(path: string, csv: string): DataAsset {
  return {path, bytes: Buffer.byteLength(csv), csv: parseCsv(csv)};
}

/** A published raster whose derivatives have the given widths and formats, as deriveImage would name them. */
function raster(path: string, widths: readonly number[], formats: readonly ('webp' | 'avif')[] = ['webp', 'avif']): PublishedRaster {
  const directory = path.slice(0, path.lastIndexOf('/') + 1);
  const stem = path.slice(path.lastIndexOf('/') + 1, path.lastIndexOf('.'));
  const height = (width: number): number => Math.round((width * 9) / 16);
  return {
    kind: 'raster',
    width: widths.at(-1)!,
    height: height(widths.at(-1)!),
    derivatives: widths.flatMap((width) =>
      formats.map((format) => ({path: `${directory}${stem}.0123456789abcdef.${width}.${format}`, width, height: height(width), format, bytes: width * (format === 'avif' ? 20 : 30)})),
    ),
  };
}

function rasterAsset(path: string): ResolvedImage['asset'] {
  return {path, kind: 'raster', format: 'png', width: 1700, height: 956, bytes: 4096};
}

const LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 32"><rect width="120" height="32" fill="#0f766e"/></svg>';

function vectorAsset(path: string): VectorImageAsset {
  return {path, kind: 'vector', format: 'svg', width: 120, height: 32, viewBox: [0, 0, 120, 32], bytes: Buffer.byteLength(LOGO_SVG), markup: LOGO_SVG};
}

function image(path: string, overrides: Partial<ResolvedImage> = {}): ResolvedImage {
  return {
    pointer: '/slides/0/image',
    asset: rasterAsset(path),
    alt: 'A pier at dawn.',
    decorative: false,
    caption: null,
    credit: null,
    rights: null,
    focalPoint: [50, 50],
    ...overrides,
  };
}

const HOURS = 'phase,hours,team\nReview,41,Studio\nBuild,26,\nDelivery,9,Client\n';

function chart(overrides: Partial<ResolvedChart> = {}): ResolvedChart {
  return {
    pointer: '/slides/3/chart',
    type: 'bar',
    orientation: 'vertical',
    data: data('assets/data/hours.csv', HOURS),
    x: 'phase',
    y: 'hours',
    series: null,
    summary: 'Review took the most hours and delivery the fewest.',
    showTable: false,
    caption: null,
    source: null,
    ...overrides,
  };
}

function table(csv: string, overrides: Partial<ResolvedTable> = {}): ResolvedTable {
  return {pointer: '/slides/3/table', data: data('assets/data/hours.csv', csv), columns: null, caption: null, source: null, ...overrides};
}

// ---------------------------------------------------------------------------
// Escaping

test('escapeHtml escapes the five characters that end a text node or a quoted attribute', () => {
  assert.equal(escapeHtml(`<a href="x" title='y'>&amp;</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;amp;&lt;/a&gt;');
  assert.equal(escapeHtml('plain text, 3 > 2'), 'plain text, 3 &gt; 2');
});

test('escapeJsonForHtml keeps a value inert inside a script element and parses back unchanged (IC02)', () => {
  const value = {hostile: `</script><script>alert(1)</script><!-- & ${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}`, n: 1};
  const json = escapeJsonForHtml(value);
  assert.doesNotMatch(json, /[<>&]/);
  assert.ok(!json.includes(LINE_SEPARATOR) && !json.includes(PARAGRAPH_SEPARATOR));
  assert.deepEqual(JSON.parse(json), value);
  assert.throws(() => escapeJsonForHtml(undefined), /no JSON form/);
});

test('joinBlockHtml removes line breaks between block tags only', () => {
  const html = '<p>One</p>\n<p>Two\nthree</p>\n<pre><code>a\nb\n</code></pre>\n<ul>\n<li>x</li>\n</ul>\n';
  assert.equal(joinBlockHtml(html), '<p>One</p><p>Two\nthree</p><pre><code>a\nb\n</code></pre><ul><li>x</li></ul>');
  // A soft break between two inline elements is the author's line break, not a block boundary.
  assert.equal(joinBlockHtml('<p><em>a</em>\n<strong>b</strong></p>\n'), '<p><em>a</em>\n<strong>b</strong></p>');
});

// ---------------------------------------------------------------------------
// Text

test('text: the rendered HTML as resolve made it, or rendered again at another level (D150)', () => {
  const column = text('# Heading\n\nBody with a [link](https://example.com/).', '/slides/2/columns/0/text', 4);
  assert.equal(renderTextBlock(column, context()), column.html.replace(/\n+$/, ''));
  snapshot('text-rebased', renderTextBlock(column, context(), 2));
  assert.match(renderTextBlock(column, context(), 2), /^<h2>Heading<\/h2>/);
});

// ---------------------------------------------------------------------------
// Image

test('image: a raster with AVIF and WebP in the first view, with caption, credit, rights and a focal point', () => {
  const path = 'assets/images/pier.jpg';
  const value = image(path, {
    caption: text('The pier, *early*.', '/slides/0/image/caption'),
    credit: 'J. Ross',
    rights: 'Studio photograph',
    focalPoint: [30, 40],
  });
  snapshot('image-raster-first-view', renderImageBlock(value, context({[path]: raster(path, [800, 1600])}), {firstView: true, slot: SLOT, className: 'slide-figure image-figure'}));
});

test('image: WebP only off the first view is lazy and has no picture element', () => {
  const path = 'assets/images/pier.png';
  const html = renderImageBlock(image(path), context({[path]: raster(path, [800], ['webp'])}), {firstView: false, slot: SLOT, className: 'image-figure'});
  snapshot('image-raster-webp-only-lazy', html);
  assert.doesNotMatch(html, /<picture>/);
  assert.match(html, / loading="lazy"/);
});

test('image: the widths are the ones the media lists, never assumed (D40)', () => {
  const path = 'assets/images/small.png';
  const html = renderImageBlock(image(path), context({[path]: raster(path, [600])}), {firstView: true, slot: SLOT, className: 'image-figure'});
  snapshot('image-raster-narrow-source', html);
  assert.doesNotMatch(html, /800w|1600w/);
  assert.match(html, /small\.0123456789abcdef\.600\.webp 600w/);
  assert.doesNotMatch(html, /loading=/);
});

test('image: a decorative picture has an empty alt', () => {
  const path = 'assets/images/texture.png';
  const html = renderImageBlock(image(path, {alt: null, decorative: true}), context({[path]: raster(path, [800, 1600], ['webp'])}), {firstView: true, slot: SLOT, className: 'image-figure'});
  snapshot('image-decorative', html);
  assert.match(html, / alt=""/);
});

test('image: a vector is a plain img of its published file', () => {
  const path = 'assets/images/diagram.svg';
  const published: PublishedImage = {kind: 'vector', width: 120, height: 32, file: {path, bytes: Buffer.byteLength(LOGO_SVG)}};
  const html = renderImageBlock(image(path, {asset: vectorAsset(path)}), context({[path]: published}), {firstView: false, slot: SLOT, className: 'image-figure'});
  snapshot('image-vector', html);
  assert.match(html, /^<figure class="image-figure"><img src="assets\/images\/diagram\.svg" width="120" height="32" alt="A pier at dawn\." loading="lazy"><\/figure>$/);
});

test('image: every author string is escaped for its context', () => {
  const path = 'assets/images/pier.png';
  const html = renderImageBlock(
    image(path, {alt: '"><script>alert(1)</script>', credit: '<b>bold</b> & co', rights: 'It\'s "ours"'}),
    context({[path]: raster(path, [800], ['webp'])}),
    {firstView: true, slot: SLOT, className: 'image-figure'},
  );
  snapshot('image-hostile', html);
  assert.doesNotMatch(html, /<script|<b>/);
});

test('image: nothing published for the path is a defect, never a broken picture', () => {
  assert.throws(() => renderImageBlock(image('assets/images/none.png'), context(), {firstView: true, slot: SLOT, className: 'image-figure'}), /E_INTERNAL/);
});

test('image: a src is escaped for its attribute like every other value, not only percent-encoded (security audit F18)', () => {
  // The schema admits no such name; the test hands the renderer one to show the
  // attribute's safety no longer rests on encodeURIComponent, which keeps ' as it is.
  const path = "assets/images/it's.svg";
  const vector: PublishedImage = {kind: 'vector', width: 120, height: 32, file: {path, bytes: 1}};
  assert.match(renderImageBlock(image(path, {asset: vectorAsset(path)}), context({[path]: vector}), {firstView: true, slot: SLOT, className: 'image-figure'}), / src="assets\/images\/it&#39;s\.svg"/);
  const rasterPath = "assets/images/pier's.png";
  const html = renderImageBlock(image(rasterPath), context({[rasterPath]: raster(rasterPath, [800], ['webp'])}), {firstView: true, slot: SLOT, className: 'image-figure'});
  assert.match(html, / src="assets\/images\/pier&#39;s\.0123456789abcdef\.800\.webp"/);
});

test('image: a focal point outside the image, or not a finite number, is a defect the renderer refuses (security audit F19)', () => {
  const path = 'assets/images/pier.png';
  const render = (focalPoint: readonly [number, number]) =>
    renderImageBlock(image(path, {focalPoint}), context({[path]: raster(path, [800], ['webp'])}), {firstView: true, slot: SLOT, className: 'image-figure'});
  for (const point of [[Number.NaN, 50], [50, Number.POSITIVE_INFINITY], [-0.5, 50], [50, 100.5], [1e308, 0]] as const) {
    assert.throws(() => render(point), /E_INTERNAL: the focal point .* is not inside the image/, point.join(', '));
  }
  assert.match(render([0, 100]), / style="object-position:0% 100%"/, 'the edges are inside');
  assert.doesNotMatch(render([50, 50]), /style=/, 'the middle, the default, needs no style');
});

// ---------------------------------------------------------------------------
// Logo

test('logo: a raster at register height, its slot its aspect ratio times the height', () => {
  const path = 'assets/images/logos/client.png';
  const published = raster(path, [800]);
  const logo: ResolvedLogo = {pointer: '/logo', asset: rasterAsset(path), alt: 'Client & partner'};
  snapshot('logo-raster', renderLogoBlock(logo, context({[path]: published}), {firstView: true, heightPx: 32, className: 'slide-logo'}));
  assert.deepEqual([logoSlot(published, 32).sizes, logoSlot(published, 32).slotWidth(390)], ['57px', 57]);
});

test('logo: a vector', () => {
  const path = 'assets/images/logos/client.svg';
  const logo: ResolvedLogo = {pointer: '/logo', asset: vectorAsset(path), alt: 'Client'};
  const published: PublishedImage = {kind: 'vector', width: 120, height: 32, file: {path, bytes: 111}};
  snapshot('logo-vector', renderLogoBlock(logo, context({[path]: published}), {firstView: false, heightPx: 32, className: 'slide-logo'}));
});

// ---------------------------------------------------------------------------
// Chart

test('chart: the drawing, the visible summary hidden from assistive technology, caption and source', () => {
  const value = chart({caption: text('Hours by *phase*.', '/slides/3/chart/caption'), source: 'Source: studio time sheets'});
  const html = renderChartBlock(value, context(), {id: 'chart-4', labelledBy: 'title-4'});
  snapshot('chart-bar', html);
  const drawn = renderChart(chartInput(value, 'chart-4', 'en')).svg!.replace(/\n+$/, '');
  assert.ok(html.includes(drawn), 'the block holds exactly the SVG the chart module draws');
  assert.match(html, /<p class="chart-summary" aria-hidden="true">Review took the most hours and delivery the fewest\.<\/p>/);
});

test('chart: show_table adds the plotted columns as a table region named by the caption, or by the title', () => {
  const withCaption = renderChartBlock(chart({showTable: true, caption: text('Hours.', '/slides/3/chart/caption')}), context(), {id: 'chart-4', labelledBy: 'title-4'});
  snapshot('chart-with-table', withCaption);
  assert.match(withCaption, /<div class="table-wrap" tabindex="0" role="region" aria-labelledby="chart-4-caption">/);
  const withoutCaption = renderChartBlock(chart({showTable: true}), context(), {id: 'chart-4', labelledBy: 'title-4'});
  assert.match(withoutCaption, /aria-labelledby="title-4"/);
  assert.doesNotMatch(withoutCaption, /team/, 'only the plotted columns: x, then y');
});

test('chart: an id in the range the deck reserves for slides, or not a valid id, is refused', () => {
  for (const id of ['slide-4', '4chart', 'chart 4', '']) {
    assert.throws(() => renderChartBlock(chart(), context(), {id, labelledBy: 'title-4'}), /E_INTERNAL/, id);
  }
});

test('chart: a CSV that did not parse, or a chart with problems, is never drawn', () => {
  assert.throws(() => renderChartBlock(chart({data: data('assets/data/bad.csv', '')}), context(), {id: 'chart-1', labelledBy: 't'}), /E_INTERNAL/);
  assert.throws(() => renderChartBlock(chart({y: 'missing'}), context(), {id: 'chart-1', labelledBy: 't'}), /E_INTERNAL/);
});

// ---------------------------------------------------------------------------
// Table

test('table: every column in file order, empty cells as an em dash with the localized label', () => {
  const html = renderTableBlock(table(HOURS, {caption: text('Hours by phase.', '/slides/3/table/caption')}), context(), {id: 'table-4', labelledBy: 'title-4'});
  snapshot('table-all-columns', html);
  assert.match(html, /<td><span aria-hidden="true">—<\/span><span class="sr-only">No value<\/span><\/td>/);
  assert.match(html, /<th scope="col" class="num">hours<\/th>/);
  assert.doesNotMatch(html, /Scrollable reference table/);
});

test('table: columns pick, order and relabel; the region is named by the title without a caption; Spanish labels', () => {
  const html = renderTableBlock(
    table(HOURS, {columns: [{field: 'team', label: 'Equipo'}, {field: 'phase', label: 'phase'}], source: 'Datos de ejemplo.'}),
    context({}, 'es'),
    {id: 'table-2', labelledBy: 'title-2'},
  );
  snapshot('table-picked', html);
  assert.match(html, /aria-labelledby="title-2"/);
  assert.match(html, /<span class="sr-only">Sin valor<\/span>/);
  assert.doesNotMatch(html, /hours|41/);
});

test('table: a header-only CSV shows its header and no rows', () => {
  const html = renderTableBlock(table('phase,hours\n'), context(), {id: 'table-1', labelledBy: 'title-1'});
  snapshot('table-header-only', html);
  assert.match(html, /<tbody><\/tbody>/);
});

test('table: cells are escaped, and whitespace counts as empty', () => {
  const html = renderTableBlock(table('name,value\n"<script>alert(1)</script>",a & b\n"  ",x\n'), context(), {id: 'table-1', labelledBy: 'title-1'});
  snapshot('table-hostile', html);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /<td>a &amp; b<\/td>/);
});

test('table: a column the CSV does not have is a defect R13 catches first', () => {
  assert.throws(() => renderTableBlock(table(HOURS, {columns: [{field: 'Phase', label: 'Phase'}]}), context(), {id: 'table-1', labelledBy: 't'}), /E_INTERNAL/);
});

test('derivativesOf lists one format by width, whatever order the media holds', () => {
  const published = raster('assets/images/a.png', [800, 1600]);
  const reversed: PublishedRaster = {...published, derivatives: [...published.derivatives].reverse()};
  assert.deepEqual(derivativesOf(reversed, 'avif').map((each) => each.width), [800, 1600]);
});
