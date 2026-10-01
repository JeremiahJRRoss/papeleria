/**
 * M3.2: the quote, note, callout and video blocks, each against a committed
 * snapshot under test/fixtures/document/blocks/, and what a snapshot cannot
 * show on its own: escaping in every position, the localized labels, the
 * video's IC04 attributes one by one, its poster's one file, and its refusal
 * of every container but a document's section (D07, D97).
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {loadStrings, renderMarkdown, type ImageAsset, type ResolvedText, type ResolvedVideo, type VideoAsset} from '../../src/core/index.js';
import {
  posterImage,
  renderCalloutBlock,
  renderNoteBlock,
  renderQuoteBlock,
  renderVideoBlock,
  type BlockContext,
  type ImageSlot,
  type PublishedImage,
  type PublishedRaster,
  type VideoContainer,
} from '../../templates/shared/blocks.js';
import {DOCUMENT_IMAGE_SLOT} from '../../templates/document/render.js';
import {fixturePath} from '../helpers/paths.js';
import {assertSnapshot} from '../helpers/snapshot.js';

const EN = loadStrings('en');
const ES = loadStrings('es');

function snapshot(name: string, html: string): void {
  assertSnapshot(fixturePath('document', 'blocks', `${name}.html`), html);
}

function text(markdown: string, pointer = '/sections/0/blocks/0/quote/text'): ResolvedText {
  const rendered = renderMarkdown(markdown, {baseLevel: 3, docId: pointer, externalLinkLabel: EN.external_link});
  return {pointer, origin: 'inline', path: null, markdown, html: rendered.html, baseLevel: 3};
}

function poster(widths: readonly number[], formats: readonly ('webp' | 'avif')[] = ['webp', 'avif']): PublishedRaster {
  return {
    kind: 'raster',
    width: widths.at(-1)!,
    height: Math.round((widths.at(-1)! * 9) / 16),
    derivatives: widths.flatMap((width) =>
      formats.map((format) => ({
        path: `assets/images/poster.0123456789abcdef.${width}.${format}`,
        width,
        height: Math.round((width * 9) / 16),
        format,
        bytes: width * 10,
      })),
    ),
  };
}

function context(images: Readonly<Record<string, PublishedImage>> = {}, language: 'en' | 'es' = 'en'): BlockContext {
  return {strings: language === 'en' ? EN : ES, language, media: {images: new Map(Object.entries(images))}};
}

const POSTER_ASSET: ImageAsset = {path: 'assets/images/poster.png', kind: 'raster', format: 'png', width: 1920, height: 1080, bytes: 4096};
const VIDEO_ASSET: VideoAsset = {path: 'assets/video/harbour loop.mp4', bytes: 2048, probe: {ok: true, probe: {duration: 6}}};

function video(overrides: Partial<ResolvedVideo> = {}): ResolvedVideo {
  return {
    pointer: '/sections/1/blocks/0/video',
    asset: VIDEO_ASSET,
    poster: POSTER_ASSET,
    alt: 'Waves against the pier at dawn.',
    caption: null,
    credit: null,
    rights: null,
    ...overrides,
  };
}

const MEDIA = {'assets/images/poster.png': poster([800, 1600])};
const OPTIONS = {id: 's2_b1', container: 'section' as const, slot: DOCUMENT_IMAGE_SLOT};

// ---------------------------------------------------------------------------
// Quote

test('quote: the kit’s blockquote in a figure, the attribution its caption', () => {
  const html = renderQuoteBlock(text('A considered label. *A clear handoff.*'), 'Brand principle', context());
  snapshot('quote', html);
  assert.equal(
    html,
    '<figure class="quote-figure"><blockquote><p>A considered label. <em>A clear handoff.</em></p></blockquote><figcaption class="quote-attribution">Brand principle</figcaption></figure>',
  );
  assert.equal(renderQuoteBlock(text('Alone.'), null, context()), '<figure class="quote-figure"><blockquote><p>Alone.</p></blockquote></figure>');
});

test('quote: the author’s markup is text, in the quotation and the attribution', () => {
  const html = renderQuoteBlock(text('<script>alert(1)</script> & "quoted"'), '<img src=x onerror=alert(1)> & Co.', context());
  snapshot('quote-hostile', html);
  assert.doesNotMatch(html, /<script|<img/);
  assert.match(html, /<figcaption class="quote-attribution">&lt;img src=x onerror=alert\(1\)&gt; &amp; Co\.<\/figcaption>/);
});

// ---------------------------------------------------------------------------
// Note

test('note: the default and the warning tone, each opened by its localized label', () => {
  const note = renderNoteBlock(text('A plain note with **bold** words.'), 'default', context());
  const warning = renderNoteBlock(text('Sample data, for the example only.'), 'warning', context());
  snapshot('note', note);
  snapshot('note-warning', warning);
  assert.match(note, /^<div class="note" role="note"><strong class="note-label">Note<\/strong><p>A plain note with <strong>bold<\/strong> words\.<\/p><\/div>$/);
  assert.match(warning, /^<div class="note warning" role="note"><strong class="note-label">Warning<\/strong>/);
  assert.match(renderNoteBlock(text('Nota.'), 'default', context({}, 'es')), /<strong class="note-label">Nota<\/strong>/);
  assert.match(renderNoteBlock(text('Aviso.'), 'warning', context({}, 'es')), /<strong class="note-label">Aviso<\/strong>/);
});

// ---------------------------------------------------------------------------
// Callout

test('callout: the kit’s doc-callout around the author’s text', () => {
  const html = renderCalloutBlock(text('A folder of text, data and images becomes a finished piece.'), context());
  snapshot('callout', html);
  assert.equal(html, '<div class="doc-callout"><p>A folder of text, data and images becomes a finished piece.</p></div>');
});

// ---------------------------------------------------------------------------
// Video

test('video: IC04 attribute for attribute — controls, muted, loop, playsinline, preload none, a poster, no autoplay', () => {
  const html = renderVideoBlock(video(), context(MEDIA), OPTIONS);
  snapshot('video', html);
  const player = /<video\b[^>]*>/.exec(html)?.[0] ?? '';
  const attributes = [...player.matchAll(/\s([a-z-]+)(?:="([^"]*)")?/g)].map((match) => [match[1], match[2] ?? true]);
  assert.deepEqual(attributes, [
    ['controls', true],
    ['muted', true],
    ['loop', true],
    ['playsinline', true],
    ['preload', 'none'],
    ['poster', 'assets/images/poster.0123456789abcdef.800.webp'],
    ['width', '1600'],
    ['height', '900'],
    ['aria-describedby', 's2_b1-alt'],
    ['src', 'assets/video/harbour%20loop.mp4'],
  ]);
  assert.doesNotMatch(html, /autoplay|<script|<source/i);
  assert.match(html, /<video [^>]*><\/video>/, 'nothing inside the player: its poster and the text beside it carry the content');
});

test('video: the alternative is visible text naming the player, then caption, credit and rights', () => {
  const html = renderVideoBlock(
    video({caption: text('The *loop*.', '/sections/1/blocks/0/video/caption'), credit: 'J. Ross', rights: 'Studio footage'}),
    context(MEDIA),
    OPTIONS,
  );
  snapshot('video-captioned', html);
  assert.match(
    html,
    /<figcaption class="figure-caption"><p class="video-alt" id="s2_b1-alt">Waves against the pier at dawn\.<\/p><div class="figure-text"><p>The <em>loop<\/em>\.<\/p><\/div><p class="figure-credit">J\. Ross<\/p><p class="figure-rights">Studio footage<\/p><\/figcaption>/,
  );
});

test('video: print shows the same poster as an image, and the alternative beneath (IC04)', () => {
  const html = renderVideoBlock(video(), context(MEDIA), OPTIONS);
  assert.match(html, /<img class="video-print-poster" src="assets\/images\/poster\.0123456789abcdef\.800\.webp" alt="" width="1600" height="900">/);
  const posters = [...html.matchAll(/(?:poster|src)="(assets\/images\/[^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(new Set(posters).size, 1, 'the player and the print copy name one file, fetched once');
});

test('video: every author string is escaped', () => {
  const html = renderVideoBlock(
    video({alt: '"><script>alert(1)</script>', credit: '<b>bold</b> & co', rights: 'It\'s "ours"'}),
    context(MEDIA),
    OPTIONS,
  );
  snapshot('video-hostile', html);
  assert.doesNotMatch(html, /<script|<b>/);
  assert.match(html, /<p class="video-alt" id="s2_b1-alt">&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/p>/);
});

test('D07: a video anywhere but a document section is refused', () => {
  for (const container of ['slide', 'page', 'detail'] as VideoContainer[]) {
    assert.throws(() => renderVideoBlock(video(), context(MEDIA), {...OPTIONS, container}), /E_INTERNAL: a video cannot stand in a/, container);
  }
  for (const id of ['2', 'a b', '']) {
    assert.throws(() => renderVideoBlock(video(), context(MEDIA), {...OPTIONS, id}), /E_INTERNAL/, id);
  }
  assert.throws(() => renderVideoBlock(video(), context(), OPTIONS), /E_INTERNAL: the build published nothing/);
});

test('the poster names one file: the narrowest WebP as wide as the slot, else the widest; never AVIF; a vector as it is', () => {
  const slot: ImageSlot = {sizes: '658px', slotWidth: () => 658};
  const one = (image: PublishedImage): string => {
    const narrowed = posterImage(image, slot.slotWidth(0));
    assert.ok(narrowed.kind === 'vector' || narrowed.derivatives.length === 1);
    return narrowed.kind === 'vector' ? narrowed.file.path : narrowed.derivatives[0]!.path;
  };
  assert.equal(one(poster([800, 1600])), 'assets/images/poster.0123456789abcdef.800.webp');
  assert.equal(one(poster([600])), 'assets/images/poster.0123456789abcdef.600.webp', 'a narrow source: its one width');
  assert.equal(posterImage(poster([800, 1600]), 1000).kind === 'raster' ? (posterImage(poster([800, 1600]), 1000) as PublishedRaster).derivatives[0]!.width : 0, 1600);
  assert.equal(one({kind: 'vector', width: 160, height: 90, file: {path: 'assets/images/poster.svg', bytes: 300}}), 'assets/images/poster.svg');
  assert.throws(() => posterImage(poster([800], ['avif']), 658), /E_INTERNAL/);
});
