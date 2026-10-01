/**
 * M3.1: the document renderer. The fixture document in
 * test/fixtures/document/all-blocks/ holds every block kind over two logical
 * sheets and renders to the committed page; the page is the kit's project
 * report without its editing widgets or script (D94); logical sheets follow
 * `new_page`, the first section always starting the first; every sheet ends
 * with its footer text and the status, never a page number (D10, IC08);
 * section headings carry their slugs and link to them, and no slug takes an
 * id the page already uses (D153, D95); the Spanish strings reach every
 * label; the targets and the first view are what IC06 and IC04 ask.
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  createMemoryLoaders,
  DOCUMENT_PAGE_IDS,
  readPiece,
  type DocumentPiece,
} from '../../src/core/index.js';
import {documentTargets} from '../../src/build/targets.js';
import type {BuildContext} from '../../templates/deck/render.js';
import {
  DOCUMENT_IMAGE_SLOT,
  DOCUMENT_STYLESHEETS,
  documentFirstView,
  logicalSheets,
  MAIN_ID,
  render,
} from '../../templates/document/render.js';
import type {BuildMedia, PublishedImage, PublishedRaster} from '../../templates/shared/blocks.js';
import {pngSource} from '../fixtures/images/generate.js';
import {mp4Source} from '../fixtures/video/generate.js';
import {fixturePath} from '../helpers/paths.js';
import {readTree} from '../helpers/pieces.js';
import {assertSnapshot} from '../helpers/snapshot.js';

const BUILD: BuildContext = {toolVersion: '0.0.0'};
const FIXTURE = fixturePath('document', 'all-blocks');

async function fixtureEntries(overrides: Readonly<Record<string, string>> = {}): Promise<Record<string, string | Uint8Array>> {
  return {
    ...readTree(FIXTURE),
    'assets/images/photo.png': await pngSource(1700, 900),
    'assets/images/poster.png': await pngSource(1280, 720),
    'assets/video/loop.mp4': mp4Source({seconds: 6}),
    ...overrides,
  };
}

async function resolveDocument(entries: Readonly<Record<string, string | Uint8Array>>): Promise<DocumentPiece> {
  const {piece, findings} = await readPiece({loaders: createMemoryLoaders(entries)});
  assert.deepEqual(findings, []);
  assert.equal(piece?.template, 'document');
  return piece as DocumentPiece;
}

async function fixtureDocument(overrides: Readonly<Record<string, string>> = {}): Promise<DocumentPiece> {
  return resolveDocument(await fixtureEntries(overrides));
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

/** What the build would publish for the fixture: the photo at two widths, the poster at 800, the logo as it is. */
const MEDIA: BuildMedia = {
  images: new Map<string, PublishedImage>([
    ['assets/images/photo.png', raster('photo', [800, 1600], (width) => Math.round((width * 9) / 17))],
    ['assets/images/poster.png', raster('poster', [800], (width) => Math.round((width * 9) / 16))],
    ['assets/images/logos/client.svg', {kind: 'vector', width: 120, height: 32, file: {path: 'assets/images/logos/client.svg', bytes: 118}}],
  ]),
};

/** The manifest of a one-section document, with the given heading lines and blocks. */
function minimal(sections: string, extra = ''): string {
  return `schema: 1\ntemplate: document\ntitle: T\n${extra}sections:\n${sections}`;
}

test('the fixture document renders to its committed page', async () => {
  const piece = await fixtureDocument();
  const {html, script, targets} = render(piece, MEDIA, BUILD);
  assertSnapshot(fixturePath('document', 'page.html'), html);
  assert.equal(script, null, 'a document publishes no script (C22)');
  assert.deepEqual(targets, documentTargets(piece));
});

test('C22: a published document has no script element and no inline handler', async () => {
  const {html} = render(await fixtureDocument(), MEDIA, BUILD);
  assert.doesNotMatch(html, /<script\b/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /javascript:/i);
});

test('IC07: the page carries its language, the generator and the status', async () => {
  const piece = await fixtureDocument();
  const {html} = render(piece, MEDIA, BUILD);
  assert.match(html, /^<!DOCTYPE html>\n<html lang="en">\n<head>\n/);
  assert.match(html, /<meta name="generator" content="Papeleria 0\.0\.0">/);
  assert.match(html, /<title>The takeaway &lt;b&gt;stays&lt;\/b&gt; text\.<\/title>/, 'the title as plain text, markup kept as text');
  assert.equal(piece.statusLabel, 'Review edition / approval pending');
  assert.equal(html.split('Review edition / approval pending').length - 1, 3, 'the draft label once, and each of the two sheets’ footers');
  const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"(?: media="([^"]+)")?>/g)].map((match) => [match[1], match[2] ?? null]);
  assert.deepEqual(links, DOCUMENT_STYLESHEETS.map((sheet) => [sheet.href, sheet.media ?? null]));
  assert.deepEqual(links.at(3), ['theme/css/print.css', 'print']);
});

test('IC08: sheets follow new_page, and the first section starts the first sheet whatever it says', async () => {
  const piece = await fixtureDocument();
  assert.equal(piece.sections[0]!.newPage, true, 'the fixture marks its first section, which must not open an empty sheet');
  assert.deepEqual(logicalSheets(piece).map((sheet) => sheet.map((section) => section.slug)), [['document-2', 'numbers-tails'], ['numbers-tails-2']]);
  const {html} = render(piece, MEDIA, BUILD);
  const sheets = html.split('<article class="template-page">').slice(1);
  assert.equal(sheets.length, 2);
  for (const [index, sheet] of sheets.entries()) {
    assert.match(sheet, /^\n<header class="doc-top"><span class="wordmark">papeleria<\/span><span class="doc-type">Field report &amp; &lt;notes&gt;<\/span><\/header>\n/);
    assert.match(sheet, /<footer class="template-footer"><span>Internal &lt;draft&gt;<\/span><span class="doc-status">Review edition \/ approval pending<\/span><\/footer>\n<\/article>/);
    assert.equal(sheet.includes('<span class="draft-label">'), index === 0, 'the draft label opens the first sheet only');
    assert.equal(sheet.includes('<h1>'), index === 0);
    assert.equal(sheet.includes('<div class="source-note">'), index === 1, 'the source note closes the last sheet');
  }
  // No sheet or page number anywhere: nothing like "1 / 2" or "Page 1".
  const footers = [...html.matchAll(/<footer class="template-footer">[\s\S]*?<\/footer>/g)].map((match) => match[0]);
  for (const footer of footers) {
    assert.doesNotMatch(footer, /\d/, footer);
  }

  const single = await resolveDocument({'papeleria.yaml': minimal('  - heading: A\n    blocks:\n      - text: One.\n  - heading: B\n    blocks:\n      - text: Two.\n')});
  assert.equal(logicalSheets(single).length, 1);
  assert.equal(render(single, MEDIA, BUILD).html.split('<article class="template-page">').length - 1, 1);
});

test('the default footer is the status alone, in the language of the piece', async () => {
  const piece = await resolveDocument({'papeleria.yaml': minimal('  - heading: A\n    blocks:\n      - text: One.\n', 'language: es\nstatus: published\n')});
  const {html} = render(piece, MEDIA, BUILD);
  assert.match(html, /<footer class="template-footer"><span class="doc-status">Publicado<\/span><\/footer>/);
  assert.match(html, /<span class="doc-type">Documento<\/span>/, 'doc_type_default');
  assert.match(html, /<a class="skip-link" href="#document">Ir al contenido<\/a>/);
  assert.match(html, /<html lang="es">/);
});

test('the front matter: the takeaway, then the metadata and the credits, escaped', async () => {
  const {html} = render(await fixtureDocument(), MEDIA, BUILD);
  assert.match(
    html,
    /<div class="doc-content"><span class="draft-label">Review edition \/ approval pending<\/span><h1>The <em>takeaway<\/em> &lt;b&gt;stays&lt;\/b&gt; text\.<\/h1><dl class="doc-metadata"><div><dt>Audience<\/dt><dd>Studio leads &amp; &quot;friends&quot;<\/dd><\/div><div><dt>Period<\/dt><dd>Q3 2026<\/dd><\/div><div><dt>Author<\/dt><dd>Test fixture<\/dd><\/div><\/dl>\n/,
  );
  const bare = await resolveDocument({'papeleria.yaml': minimal('  - heading: A\n    blocks:\n      - text: One.\n')});
  assert.doesNotMatch(render(bare, MEDIA, BUILD).html, /doc-metadata/, 'no metadata, no list');
});

test('IC07 and D153: each heading carries its slug and links to it; no slug takes an id the page uses', async () => {
  const piece = await fixtureDocument();
  const {html} = render(piece, MEDIA, BUILD);
  for (const section of piece.sections) {
    const encoded = encodeURIComponent(section.slug);
    assert.ok(html.includes(`<h2 id="${section.slug}"><a class="doc-anchor" href="#${encoded}">`), section.slug);
    assert.ok(
      html.includes(`<section class="doc-section" data-source-line-start="${section.source.lineStart}" data-source-line-end="${section.source.lineEnd}"><h2`),
      `section ${section.number} carries its manifest lines`,
    );
  }
  assert.equal(piece.sections[0]!.slug, 'document-2', '"Document" would take the page’s own id');

  // Every id on the page is unique, and each is a slug, a footnote's, the page's own or a block's.
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]!);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids.join(', ')}`);
  const slugs = new Set(piece.sections.map((section) => section.slug));
  for (const id of ids) {
    assert.ok(slugs.has(id) || DOCUMENT_PAGE_IDS.includes(id) || id.includes('_') || /^fn(?:ref)?-/.test(id), `${id} is none of the ids the renderer makes`);
  }
  assert.deepEqual(DOCUMENT_PAGE_IDS, [MAIN_ID], 'the renderer’s own id is the one resolve reserves');
});

test('D95: a heading whose slug would be a footnote id takes the next suffix', async () => {
  const text = 'A claim.[^1]\n\n[^1]: The source.\n';
  const piece = await resolveDocument({
    'papeleria.yaml': minimal(`  - heading: Claims\n    blocks:\n      - text: assets/text/claim.md\n  - heading: FN sections 0 blocks 0 text 1\n    blocks:\n      - text: Two.\n`),
    'assets/text/claim.md': text,
  });
  const {html} = render(piece, MEDIA, BUILD);
  assert.match(html, /<li id="fn-sections-0-blocks-0-text-1"/);
  assert.equal(piece.sections[1]!.slug, 'fn-sections-0-blocks-0-text-1-2');
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]!);
  assert.equal(new Set(ids).size, ids.length);
});

test('a heading in any script is a slug of its letters, URL-encoded in its link', async () => {
  const piece = await resolveDocument({'papeleria.yaml': minimal('  - heading: Sección 2\n    blocks:\n      - text: Uno.\n  - heading: 報告\n    blocks:\n      - text: Dos.\n', 'language: es\n')});
  const {html} = render(piece, MEDIA, BUILD);
  assert.deepEqual(piece.sections.map((section) => section.slug), ['seccion-2', '報告']);
  assert.ok(html.includes('<h2 id="報告"><a class="doc-anchor" href="#%E5%A0%B1%E5%91%8A">報告</a></h2>'));
});

test('IC06: a section’s targets are its manifest lines and the text files its blocks read', async () => {
  const piece = await fixtureDocument();
  assert.deepEqual(documentTargets(piece), [
    {target: {kind: 'section', slug: 'document-2'}, file: 'papeleria.yaml', lineStart: 19, lineEnd: 29},
    {target: {kind: 'section', slug: 'document-2'}, file: 'assets/text/intro.md', lineStart: 1, lineEnd: 5},
    {target: {kind: 'section', slug: 'numbers-tails'}, file: 'papeleria.yaml', lineStart: 30, lineEnd: 33},
    {target: {kind: 'section', slug: 'numbers-tails-2'}, file: 'papeleria.yaml', lineStart: 34, lineEnd: 38},
  ]);
});

test('IC04 and D96: the first view is the first sheet’s images and logo, and every poster wherever it stands', async () => {
  const piece = await fixtureDocument();
  const first = documentFirstView(piece, MEDIA);
  assert.deepEqual(
    first.map(({image, slot}) => [image.kind === 'vector' ? image.file.path : image.derivatives.map((each) => each.path), slot.sizes]),
    [
      [(MEDIA.images.get('assets/images/photo.png') as PublishedRaster).derivatives.map((each) => each.path), DOCUMENT_IMAGE_SLOT.sizes],
      ['assets/images/logos/client.svg', '180px'],
      [['assets/images/poster.0123456789abcdef.800.webp'], DOCUMENT_IMAGE_SLOT.sizes],
    ],
  );
  const {html} = render(piece, MEDIA, BUILD);
  // The first sheet's picture loads at once; the budget counts it. Its logo too.
  const firstSheet = html.slice(0, html.indexOf('</article>'));
  assert.match(firstSheet, /<img src="assets\/images\/photo\.0123456789abcdef\.800\.webp"[^>]*alt="A test photograph\."(?![^>]*loading)/);
  assert.match(firstSheet, /<img src="assets\/images\/logos\/client\.svg" width="120" height="32" class="doc-logo" alt="Client &amp; partner">/);
});

test('an image after the first sheet waits until it is scrolled to, and is not counted', async () => {
  const piece = await resolveDocument({
    'papeleria.yaml': minimal('  - heading: A\n    blocks:\n      - text: One.\n  - heading: B\n    new_page: true\n    blocks:\n      - image: {src: assets/images/photo.png, alt: Later.}\n'),
    'assets/images/photo.png': await pngSource(1700, 900),
  });
  assert.deepEqual(documentFirstView(piece, MEDIA), []);
  assert.match(render(piece, MEDIA, BUILD).html, /<img [^>]*alt="Later\." loading="lazy">/);
});

test('the image slot errs wide: the phone’s text width below 641 px, the sheet’s measure above', () => {
  assert.deepEqual([390, 640, 641, 834, 1280].map((width) => DOCUMENT_IMAGE_SLOT.slotWidth(width)), [318, 568, 658, 658, 658]);
});
