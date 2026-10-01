/**
 * M4.2: the comic renderer (templates/comic/render.ts, D105, D106, D108).
 *
 * The reader fixture (test/fixtures/comic/reader/) holds every detail kind,
 * a page without panels, SVG and raster pages, and renders to the committed
 * page, the DOM contract of templates/comic/client/CONTRACT.md. Around the
 * snapshot, the properties the milestone names: the register and the credits
 * on the last page; each page a figure with its image, a raster's srcset
 * exactly what the build published and an SVG its one file; panels over their
 * boxes in percent, named by their transcripts, in reading order, with their
 * page and number; a transcript list per page; the bar rendered on the
 * server; the strings block escaped (IC02), the no-JS status and the source
 * lines of every page and panel; one classic script. Then the first view,
 * the phone images and the zoom originals the build reads.
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {createMemoryLoaders, readPiece, type ComicPiece} from '../../src/core/index.js';
import {comicTargets} from '../../src/build/targets.js';
import {
  BOOK_ID,
  COMIC_NOTICES,
  COMIC_PAGE_SLOT,
  COMIC_SCRIPT,
  COMIC_STYLESHEETS,
  comicFirstView,
  comicPhoneImages,
  FIRST_VIEW_PAGES,
  MAIN_ID,
  pageId,
  panelId,
  render,
  zoomOriginals,
} from '../../templates/comic/render.js';
import type {BuildContext} from '../../templates/deck/render.js';
import type {BuildMedia, PublishedImage} from '../../templates/shared/blocks.js';
import {readerFixtureImages} from '../fixtures/comic/generate.js';
import {fixturePath} from '../helpers/paths.js';
import {readTree} from '../helpers/pieces.js';
import {assertSnapshot} from '../helpers/snapshot.js';

const BUILD: BuildContext = {toolVersion: '0.0.0'};
const FIXTURE = fixturePath('comic', 'reader');

async function resolveComic(overrides: Readonly<Record<string, string | Uint8Array>> = {}): Promise<ComicPiece> {
  const entries = {...readTree(FIXTURE), ...(await readerFixtureImages()), ...overrides};
  const {piece, findings} = await readPiece({loaders: createMemoryLoaders(entries)});
  assert.deepEqual(findings, []);
  assert.equal(piece?.template, 'comic');
  return piece as ComicPiece;
}

function raster(stem: string, widths: readonly number[], height: (width: number) => number): PublishedImage {
  return {
    kind: 'raster',
    width: widths.at(-1)!,
    height: height(widths.at(-1)!),
    derivatives: widths.flatMap((width) =>
      (['webp', 'avif'] as const).map((format) => ({
        path: `assets/images/${stem}.0123456789abcdef.${width}.${format}`,
        width,
        height: height(width),
        format,
        bytes: width * (format === 'avif' ? 20 : 30),
      })),
    ),
  };
}

const tall = (width: number) => Math.round((width * 2200) / 1600);

/** What the build would publish for the fixture: each raster page at 800 and 1600, the extra picture at 800 and 1200, the SVGs as they are. */
const MEDIA: BuildMedia = {
  images: new Map<string, PublishedImage>([
    ['assets/images/pages/01.png', raster('pages/01', [800, 1600], tall)],
    ['assets/images/pages/02.png', raster('pages/02', [800, 1600], tall)],
    ['assets/images/pages/03.svg', {kind: 'vector', width: 1600, height: 2200, file: {path: 'assets/images/pages/03.svg', bytes: 317}}],
    ['assets/images/pages/04.png', raster('pages/04', [800, 1600], tall)],
    ['assets/images/pages/05.svg', {kind: 'vector', width: 1600, height: 2200, file: {path: 'assets/images/pages/05.svg', bytes: 418}}],
    ['assets/images/extra.png', raster('extra', [800, 1200], (width) => Math.round((width * 2) / 3))],
  ]),
};

test('the reader fixture renders to its committed page', async () => {
  const piece = await resolveComic();
  const {html, script, targets} = render(piece, MEDIA, BUILD);
  assertSnapshot(fixturePath('comic', 'page.html'), html);
  assert.equal(script, COMIC_SCRIPT);
  assert.equal(script, 'reader.js');
  assert.deepEqual(targets, comicTargets(piece));
});

test('C22: one classic script, reader.js, deferred; no module, inline script or inline handler', async () => {
  const {html} = render(await resolveComic(), MEDIA, BUILD);
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((match) => match[0]);
  assert.deepEqual(scripts, ['<script type="application/json" id="papeleria-strings">', '<script src="reader.js" defer>']);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(html, /type="module"/);
});

test('IC02: the strings block is JSON that cannot close its element; the page carries its language and generator', async () => {
  const piece = await resolveComic();
  const {html} = render(piece, MEDIA, BUILD);
  const block = /<script type="application\/json" id="papeleria-strings">([^<]*)<\/script>/.exec(html);
  assert.ok(block !== null);
  assert.deepEqual(JSON.parse(block[1]!), piece.strings);
  assert.doesNotMatch(block[1]!, new RegExp('[<>&\\u2028\\u2029]'));
  assert.match(html, /^<!DOCTYPE html>\n<html lang="en">\n<head>\n/);
  assert.match(html, /<meta name="generator" content="Papeleria 0\.0\.0">/);
  assert.match(html, /<title>The &lt;b&gt;reader&lt;\/b&gt; &amp; &quot;fixture&quot;<\/title>/);
  const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"(?: media="([^"]+)")?>/g)].map((match) => [match[1], match[2] ?? null]);
  assert.deepEqual(links, COMIC_STYLESHEETS.map((sheet) => [sheet.href, sheet.media ?? null]));
  assert.deepEqual(links.at(-1), ['theme/css/comic.css', null], 'the comic\'s own sheet comes last, and only a comic links it');
  assert.deepEqual(COMIC_NOTICES, [{path: 'vendor/page-flip/LICENSE', source: 'vendor/page-flip/LICENSE'}]);
});

test('the register: the title, the format label (format_comics by default), the status and the wordmark; the credits on the last page, in meta size', async () => {
  const piece = await resolveComic();
  const {html} = render(piece, MEDIA, BUILD);
  assert.match(
    html,
    /<header class="comic-register"><h1 class="comic-title">The &lt;b&gt;reader&lt;\/b&gt; &amp; &quot;fixture&quot;<\/h1><span class="comic-format">Web Comics<\/span><span class="comic-status-label">Review edition \/ approval pending<\/span><span class="wordmark">fixture<\/span><\/header>/,
  );
  const sheets = html.split('<article class="comic-sheet"').slice(1);
  assert.equal(sheets.length, 5);
  for (const [index, sheet] of sheets.entries()) {
    assert.equal(sheet.includes('<dl class="comic-credits">'), index === 4, `the credits close the last page only (page ${index + 1})`);
  }
  assert.match(sheets[4]!, /<dl class="comic-credits"><div><dt>Art<\/dt><dd>Generated by the tests<\/dd><\/div><div><dt>Words<\/dt><dd>A\. Writer &amp; co<\/dd><\/div><\/dl><\/article>/);

  const spanish = await resolveComic({'papeleria.yaml': readTree(FIXTURE)['papeleria.yaml']!.toString().replace('language: en', 'language: es')});
  const es = render(spanish, MEDIA, BUILD).html;
  assert.match(es, /<span class="comic-format">Web Cómics<\/span>/);
  assert.match(es, /<html lang="es">/);
  assert.match(es, /<p class="comic-status" id="comic-status" role="status">Todas las páginas están disponibles sin JavaScript\.<\/p>/);
  const labelled = await resolveComic({'papeleria.yaml': readTree(FIXTURE)['papeleria.yaml']!.toString().replace('status: review', 'status: review\nformat: Tiras & <cómics>')});
  assert.match(render(labelled, MEDIA, BUILD).html, /<span class="comic-format">Tiras &amp; &lt;cómics&gt;<\/span>/);
});

test('the bar is rendered on the server, before the pages: Previous, the no-JS status, Next, then the view\'s tools', async () => {
  const {html} = render(await resolveComic(), MEDIA, BUILD);
  assert.match(
    html,
    /<div class="comic-tools" id="comic-tools"><button class="button" id="comic-previous" type="button">Previous<\/button><p class="comic-status" id="comic-status" role="status">All pages are available without JavaScript\.<\/p><button class="button" id="comic-next" type="button">Next<\/button><button class="button secondary" id="comic-guided" type="button">Guided view<\/button><button class="button secondary" id="comic-detail" type="button" hidden>Detail<\/button><button class="button secondary" id="comic-transcript-toggle" type="button" aria-pressed="false">Transcript<\/button><button class="button secondary" id="comic-fullscreen" type="button">Full screen<\/button><\/div>\n/,
  );
  const order = ['class="skip-link" href="#comic-main"', 'class="comic-register"', 'id="comic-tools"', `id="${MAIN_ID}"`, `id="${BOOK_ID}"`, 'id="page-1"'].map((needle) => html.indexOf(needle));
  assert.ok(order.every((at, index) => at > 0 && (index === 0 || at > order[index - 1]!)), `DOM order: skip link, register, bar, main, book, pages (${order.join(', ')})`);
  assert.match(html, /<div class="comic-book" id="comic-book"><\/div>\n<article class="comic-sheet" id="page-1"/, 'the book is empty until the reader builds it');
});

test('each page is a figure with its image: a raster\'s srcset is what the build published, an SVG page its one file; pages after the first view are lazy', async () => {
  const piece = await resolveComic();
  const {html} = render(piece, MEDIA, BUILD);
  const figures = [...html.matchAll(/<figure class="comic-figure" data-page="(\d+)" aria-labelledby="sheet-\1-title"><div class="comic-art">([\s\S]*?)<\/div><\/figure>/g)];
  assert.deepEqual(figures.map((match) => Number(match[1])), [1, 2, 3, 4, 5]);
  const page1 = figures[0]![2]!;
  assert.match(
    page1,
    /^<picture><source type="image\/avif" srcset="assets\/images\/pages\/01\.0123456789abcdef\.800\.avif 800w, assets\/images\/pages\/01\.0123456789abcdef\.1600\.avif 1600w" sizes="\(min-width: 900px\) 50vw, 100vw"><img src="assets\/images\/pages\/01\.0123456789abcdef\.800\.webp" srcset="assets\/images\/pages\/01\.0123456789abcdef\.800\.webp 800w, assets\/images\/pages\/01\.0123456789abcdef\.1600\.webp 1600w" sizes="\(min-width: 900px\) 50vw, 100vw" width="1600" height="2200" alt="Page one, five panels, one of each kind\."><\/picture>/,
  );
  assert.equal(COMIC_PAGE_SLOT.sizes, '(min-width: 900px) 50vw, 100vw');
  assert.match(figures[2]![2]!, /^<img src="assets\/images\/pages\/03\.svg" width="1600" height="2200" alt="Page three has no panels at all\.">$/, 'an SVG page is its one file, with no panel');
  assert.match(figures[4]![2]!, /^<img src="assets\/images\/pages\/05\.svg" width="1600" height="2200" alt="[^"]+" loading="lazy">/);
  for (const [index, figure] of figures.entries()) {
    assert.equal(/ loading="lazy"/.test(figure[2]!), index + 1 > FIRST_VIEW_PAGES, `page ${index + 1}`);
  }
  assert.equal(FIRST_VIEW_PAGES, 3);
});

test('panels: controls over their boxes in percent, named by their transcripts, in reading order, with their page, number, detail and source lines', async () => {
  const piece = await resolveComic();
  const {html} = render(piece, MEDIA, BUILD);
  for (const page of piece.pages) {
    const panels = [...html.matchAll(new RegExp(`<(button|a) class="comic-panel[^"]*"[^>]*? id="page-${page.number}-panel-(\\d+)" data-page="${page.number}" data-panel="\\2"[^>]*>`, 'g'))];
    assert.deepEqual(panels.map((match) => Number(match[2])), page.panels.map((panel) => panel.number), `page ${page.number}: every panel, in reading order`);
    for (const [index, panel] of page.panels.entries()) {
      const tag = panels[index]![0];
      const [x, y, width, height] = panel.box;
      assert.ok(tag.includes(` style="left:${x}%;top:${y}%;width:${width}%;height:${height}%"`), tag);
      assert.ok(tag.includes(` data-box="${panel.box.join(' ')}"`), tag);
      assert.ok(tag.includes(` data-source-line-start="${panel.source.lineStart}" data-source-line-end="${panel.source.lineEnd}"`), tag);
      assert.ok(tag.includes(` data-detail="${panel.detail?.kind ?? 'none'}"`), tag);
    }
  }
  assert.match(
    html,
    /<button class="comic-panel" type="button" id="page-1-panel-1" data-page="1" data-panel="1" data-detail="zoom" data-box="4 4 56 28" data-source-line-start="\d+" data-source-line-end="\d+" style="left:4%;top:4%;width:56%;height:28%" aria-haspopup="dialog" data-zoom-src="assets\/images\/pages\/01\.png"><span class="comic-panel-label">Panel one zooms into the art\.<\/span><span class="comic-panel-hint" aria-hidden="true">Detail<\/span><\/button>/,
  );
  assert.match(html, /<button class="comic-panel" type="button" id="page-1-panel-3" [^>]*data-detail="none"[^>]*><span class="comic-panel-label">Panel three has no detail; its transcript is announced\.<\/span><\/button>/, 'no detail: no hint, no popup');
  assert.doesNotMatch(html.match(/<button class="comic-panel" type="button" id="page-1-panel-3"[^>]*>/)![0], /aria-haspopup/);
  assert.match(
    html,
    /<a class="comic-panel" href="#page-4" id="page-1-panel-4" [^>]*data-detail="link"[^>]*><span class="comic-panel-label">Panel four links to page four\.<\/span><span class="comic-panel-hint">Go to page four<\/span><\/a>/,
  );
  assert.match(
    html,
    /<a class="comic-panel link-external" href="https:\/\/example\.com\/more" id="page-1-panel-5" [^>]*><span class="comic-panel-label">Panel five links out\.<\/span><span class="comic-panel-hint">More on the web<span class="link-external-mark" aria-hidden="true">↗<\/span><span class="sr-only"> \(External link\)<\/span><\/span><\/a>/,
  );
  assert.match(html, /<span class="comic-panel-label">Speech: &lt;b&gt;not bold&lt;\/b&gt; &amp; &quot;quoted&quot;<\/span>/, 'a transcript is text, escaped');
  assert.match(html, /id="page-5-panel-1" [^>]*data-zoom-src="assets\/images\/pages\/05\.svg"/, 'an SVG page zooms into its own file');
  assert.match(html, /id="page-5-panel-2" [^>]*style="left:0%;top:80%;width:100%;height:20%"/, 'a box at the exact edge');
  assert.equal(pageId(2), 'page-2');
  assert.equal(panelId(2, 1), 'page-2-panel-1');
});

test('a transcript list per page, in reading order, each detail under its panel; none for a page without panels', async () => {
  const piece = await resolveComic();
  const {html} = render(piece, MEDIA, BUILD);
  const sheets = html.split('<article class="comic-sheet"').slice(1);
  for (const [index, page] of piece.pages.entries()) {
    const items = [...sheets[index]!.matchAll(/<li class="comic-transcript-item" data-panel="(\d+)"><p class="comic-transcript-text">([^<]*)<\/p>/g)];
    assert.deepEqual(items.map((match) => Number(match[1])), page.panels.map((panel) => panel.number));
    assert.equal(sheets[index]!.includes('<div class="comic-transcript">'), page.panels.length > 0);
  }
  assert.match(sheets[0]!, /<div class="comic-transcript"><h3 class="comic-transcript-title">Transcript<\/h3><ol class="comic-transcript-list">/);
  assert.match(sheets[0]!, /<div class="comic-detail comic-detail-text" id="detail-1-2" data-detail="text"><h5>A heading in the note<\/h5><p>The note's first paragraph, with <em>emphasis<\/em>, a link to <a href="#page-5">the last page<\/a> and one to <a href="https:\/\/example\.com\/outside" class="link-external">/);
  assert.match(sheets[0]!, /<p class="comic-detail-link" id="detail-1-5"><a href="https:\/\/example\.com\/more" class="link-external">More on the web<span class="link-external-mark" aria-hidden="true">↗<\/span><span class="sr-only"> \(External link\)<\/span><\/a><\/p>/);
  assert.match(sheets[1]!, /<div class="comic-detail comic-detail-image" id="detail-2-1" data-detail="image"><figure class="comic-detail-figure image-figure"/);
  assert.match(sheets[1]!, /The extra picture&#39;s caption\.|The extra picture's caption\./);
  assert.doesNotMatch(sheets[0]!, /id="detail-1-1"/, 'a zoom is the art: nothing in the list');
  // D150: a detail's headings sit under the page's h2 and the transcript's h3, so its ## is an h5.
  assert.match(sheets[0]!, /<h2 class="comic-sheet-title" id="sheet-1-title">Page 1 of 5<\/h2>/);
  assert.match(sheets[0]!, /<p class="comic-credit"><span class="comic-credit-name">Generated by the tests<\/span><span class="comic-credit-rights">Test fixture; no rights claimed<\/span><\/p>/);
});

test('R08: every page and panel carries its manifest lines, every page starts a line, and every id is unique', async () => {
  const piece = await resolveComic();
  const {html} = render(piece, MEDIA, BUILD);
  for (const page of piece.pages) {
    assert.ok(html.includes(`\n<article class="comic-sheet" id="page-${page.number}" data-page="${page.number}" data-source-line-start="${page.source.lineStart}" data-source-line-end="${page.source.lineEnd}">`), `page ${page.number}`);
  }
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]!);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids.join(', ')}`);
  for (const id of ids.filter((each) => each.startsWith('page-'))) {
    assert.match(id, /^page-\d+(?:-panel-\d+)?$/, 'ids beginning page- are the pages\' and panels\' alone');
  }
});

test('a link detail whose address resolve refused renders as its label, never as a link (security audit F17)', async () => {
  const piece = await resolveComic();
  const panel = piece.pages[0]!.panels[4]!;
  assert.equal(panel.detail?.kind === 'link' ? panel.detail.href : null, 'https://example.com/more', 'the fixture: page 1, panel 5 links out');
  const refused = {...panel, detail: {...panel.detail!, href: null}} as typeof panel;
  const pages = [{...piece.pages[0]!, panels: piece.pages[0]!.panels.map((each) => (each === panel ? refused : each))}, ...piece.pages.slice(1)];
  const {html} = render({...piece, pages} as ComicPiece, MEDIA, BUILD);
  assert.doesNotMatch(html, /https:\/\/example\.com\/more/);
  assert.match(html, /<button class="comic-panel" type="button" id="page-1-panel-5" [^>]*data-detail="none"[^>]*><span class="comic-panel-label">Panel five links out\.<\/span><\/button>/);
  assert.match(html, /<p class="comic-detail-link" id="detail-1-5">More on the web<\/p>/);
});

test('a box off the page never renders: the renderer refuses what R14 reports (E_INTERNAL)', async () => {
  const piece = await resolveComic();
  const panel = piece.pages[0]!.panels[0]!;
  const broken = {...piece, pages: [{...piece.pages[0]!, panels: [{...panel, box: [60, 4, 41, 28] as const}]}]} as ComicPiece;
  assert.throws(() => render(broken, MEDIA, BUILD), /E_INTERNAL: panel 1 of page 1 .* has the box \[60, 4, 41, 28\], which is not inside the page/);
  const edge = {...piece, pages: [{...piece.pages[0]!, panels: [{...panel, box: [70.1, 4, 29.9, 28] as const}]}]} as ComicPiece;
  assert.doesNotThrow(() => render(edge, MEDIA, BUILD), '70.1 + 29.9 is the edge');
});

test('IC04: the first view is the cover and the next spread; the phone images are every page image once; zoom originals are the raster pages a zoom opens', async () => {
  const piece = await resolveComic();
  const first = comicFirstView(piece, MEDIA);
  assert.deepEqual(first.map((each) => each.image), [1, 2, 3].map((page) => MEDIA.images.get(piece.pages[page - 1]!.image.path)));
  assert.ok(first.every((each) => each.slot === COMIC_PAGE_SLOT));
  assert.deepEqual(comicPhoneImages(piece, MEDIA).map((each) => each.source), [
    'assets/images/pages/01.png',
    'assets/images/pages/02.png',
    'assets/images/pages/03.svg',
    'assets/images/pages/04.png',
    'assets/images/pages/05.svg',
  ]);
  assert.deepEqual(zoomOriginals(piece), ['assets/images/pages/01.png', 'assets/images/pages/04.png'], 'page 2 has no zoom; page 5 is an SVG, which zooms into its published file');
  const repeated = {...piece, pages: [...piece.pages, {...piece.pages[0]!, number: 6}]} as ComicPiece;
  assert.equal(comicPhoneImages(repeated, MEDIA).length, 5, 'a page image used twice is measured once');
  assert.deepEqual(zoomOriginals(repeated), ['assets/images/pages/01.png', 'assets/images/pages/04.png']);
});
