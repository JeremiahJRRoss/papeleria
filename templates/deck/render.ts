/**
 * M1.5: the deck renderer.
 *
 * `render(piece, media, build)` turns a resolved deck into one HTML page: the
 * reference deck's markup (reference/decks/brand-overview.html) for all twelve
 * layouts, the page chrome `templates/deck/client/CONTRACT.md` requires, and
 * the typed source targets. It is pure: every string comes from the Piece,
 * every file name from the build's `media`, the tool version from the build,
 * and nothing is read from disk (architecture §4, D63).
 *
 * Deliberate differences from the reference, each recorded in
 * docs/REFERENCE_COMPATIBILITY.md: no kit header or robots meta; the strings
 * block and `tabindex="-1"` of CONTRACT §7; `type` on the tool buttons; the
 * status label in every footer (D61); the source line range on every slide;
 * notes as paragraphs after their label; the page title from the manifest
 * title; credits on the cover (D69). The no-JavaScript status is the
 * `no_js_slides` string, the reference's own sentence in English (D131).
 */
import {LAYOUT_COLUMNS, type DeckPiece, type ResolvedSlide, type Swatch} from '../../src/core/index.js';
import {deckTargets, type SourceTarget} from '../../src/build/targets.js';
import {
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
  type FirstViewImage,
  type ImageSlot,
  type PublishedImage,
} from '../shared/blocks.js';

/** What the build tells a renderer besides the Piece and its media (D63). */
export type BuildContext = {
  /** The tool version, for the page's generator (IC07, the ERD's BUILD `tool_version`). */
  readonly toolVersion: string;
};

export type RenderOutput = {
  readonly html: string;
  /** The one classic script the page loads, beside `index.html`; null when it loads none. */
  readonly script: string | null;
  readonly targets: readonly SourceTarget[];
};

/** The deck's one script (C22): the bundle `npm run build` writes to `lib/clients/deck.js` (D50). */
export const DECK_SCRIPT = 'deck.js';

/** The stylesheets a deck links, in order, and where each comes from in the tool (D62). */
export const DECK_STYLESHEETS: readonly {readonly href: string; readonly source: string}[] = Object.freeze([
  {href: 'theme/css/fonts.css', source: 'theme/css/fonts.css'},
  {href: 'theme/css/tokens.css', source: 'theme/css/tokens.css'},
  {href: 'theme/css/site.css', source: 'theme/css/site.css'},
  {href: 'theme/css/slides.css', source: 'theme/css/slides.css'},
  {href: 'theme/css/base.css', source: 'templates/shared/base.css'},
]);

/** The public favicon (D05), linked from every piece. */
export const FAVICON = 'theme/marks/papeleria-favicon.svg';

/** A logo in a register is 32 px tall (UX §09). */
export const LOGO_HEIGHT_PX = 32;

/**
 * An image on a slide spans the content area: the whole viewport width up to
 * 800 px (the deck's narrow breakpoint), then about nine tenths of it, never
 * more than 1,260 px. The estimate errs wide, so a browser picks a derivative
 * at least as sharp as the slot, and the budget counts that one (IC04).
 */
export const SLIDE_IMAGE_SLOT: ImageSlot = Object.freeze({
  sizes: '(max-width: 800px) 100vw, min(90vw, 1260px)',
  slotWidth: (viewportWidth: number) => (viewportWidth <= 800 ? viewportWidth : Math.min(0.9 * viewportWidth, 1260)),
});

/**
 * The theme's type samples on a `type` slide: fixed theme content, the same in
 * every language, as the reference shows it. `TYPE_SAMPLES` in
 * scripts/check-brand-overview-content.mjs holds the same, and a test keeps
 * the two equal.
 */
export const TYPE_SAMPLES: readonly {readonly eyebrow: string; readonly className: string; readonly lines: readonly string[]}[] = Object.freeze([
  {eyebrow: 'Poppins / Display', className: 'serif', lines: ['Thoughtful work.', 'Clearly expressed.']},
  {eyebrow: 'Inter / Reading + UI', className: '', lines: ['Plain language at a readable size.', 'Short measures. Clear hierarchy.']},
  {eyebrow: 'System mono / Exact references', className: 'mono', lines: ['RM-D10 / v1.1.0']},
]);

const HORIZON = '<div class="horizon" aria-hidden="true"><span></span><span></span><span></span><span></span></div>';

/** The tool buttons of CONTRACT §3: id, strings key, class, and whether it is a toggle. */
const TOOLS: readonly (readonly [id: string, key: 'previous' | 'next' | 'show_all' | 'show_notes' | 'fullscreen' | 'print', className: string, toggle: boolean])[] = [
  ['prev-slide', 'previous', 'button', false],
  ['next-slide', 'next', 'button', false],
  ['all-slides', 'show_all', 'button secondary', true],
  ['toggle-notes', 'show_notes', 'button secondary', true],
  ['full-deck', 'fullscreen', 'button secondary', false],
  ['print-deck', 'print', 'button secondary', false],
];

const HEX_COLOUR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** A defect in the caller: the schema and resolve admit no piece that reaches here. */
function invalid(slide: ResolvedSlide, what: string): never {
  throw new Error(`E_INTERNAL: slide ${slide.number} (${slide.pointer}) ${what}; the renderer never renders an invalid piece`);
}

/** Checks what the layout takes against what the slide has (LAYOUT, R15, C08, C09). */
function assertShape(slide: ResolvedSlide): void {
  const columns = LAYOUT_COLUMNS[slide.layout] ?? 0;
  if (slide.columns.length !== columns) {
    invalid(slide, `has ${slide.columns.length} columns where ${slide.layout} takes ${columns}`);
  }
  const charted = (slide.chart === null ? 0 : 1) + (slide.table === null ? 0 : 1);
  if ((slide.layout === 'chart') !== (charted === 1) || charted > 1) {
    invalid(slide, 'does not have exactly one chart or table where its layout takes one, or has one where it takes none');
  }
  if ((slide.layout === 'image') !== (slide.image !== null)) {
    invalid(slide, 'has an image where its layout takes none, or none where it takes one');
  }
  if ((slide.layout === 'attributes') !== (slide.items.length > 0)) {
    invalid(slide, 'has items where its layout takes none, or none where it takes some');
  }
  if ((slide.layout === 'palette') !== (slide.swatches.length > 0)) {
    invalid(slide, 'has swatches where its layout takes none, or none where it takes some');
  }
  if (slide.title.markdown.trim() === '') {
    invalid(slide, 'has an empty title');
  }
}

/** `NN / TOTAL`, both zero-padded to the width of the total and at least two digits (D69). */
export function slideCounter(number: number, total: number): string {
  const width = Math.max(2, String(total).length);
  return `${String(number).padStart(width, '0')} / ${String(total).padStart(width, '0')}`;
}

function swatchHtml(slide: ResolvedSlide, swatch: Swatch): string {
  if (!HEX_COLOUR.test(swatch.value)) {
    invalid(slide, `has the swatch value ${JSON.stringify(swatch.value)}, which is not a hex colour`);
  }
  // The value is a checked hex colour, so the inline style can hold nothing else (D65).
  const use = swatch.use === undefined ? '' : `<br>${escapeHtml(swatch.use)}`;
  return `<div><div class="slide-swatch" style="background:${swatch.value}"></div><p><strong>${escapeHtml(swatch.name)}</strong><br>${escapeHtml(swatch.value)}${use}</p></div>`;
}

function contentHtml(piece: DeckPiece, slide: ResolvedSlide, context: BlockContext): string {
  const titleId = `title-${slide.number}`;
  switch (slide.layout) {
    case 'cover':
    case 'closing':
      return HORIZON;
    case 'statement':
      return '';
    case 'two':
    case 'three':
    case 'four': {
      const modifier = slide.layout === 'three' ? '' : ` ${slide.layout}`;
      const columns = slide.columns.map(
        (column) => `<div class="slide-column"><h3>${escapeHtml(column.heading)}</h3>${joinBlockHtml(renderTextBlock(column.text, context))}</div>`,
      );
      return `<div class="slide-columns${modifier}">${columns.join('')}</div>`;
    }
    case 'chart':
      return slide.chart !== null
        ? renderChartBlock(slide.chart, context, {id: `chart-${slide.number}`, labelledBy: titleId})
        : renderTableBlock(slide.table!, context, {id: `table-${slide.number}`, labelledBy: titleId});
    case 'image':
      return renderImageBlock(slide.image!, context, {firstView: slide.number === 1, slot: SLIDE_IMAGE_SLOT, className: 'slide-figure image-figure'});
    case 'attributes':
      return `<div class="slide-attributes">${slide.items.map((item) => `<p><strong>${escapeHtml(item.label)}</strong>${escapeHtml(item.text)}</p>`).join('')}</div>`;
    case 'palette':
      return `<div class="slide-swatches">${slide.swatches.map((swatch) => swatchHtml(slide, swatch)).join('')}</div>`;
    case 'type': {
      const samples = TYPE_SAMPLES.map(
        (sample) =>
          `<div><p class="eyebrow">${escapeHtml(sample.eyebrow)}</p><p class="${sample.className}">${sample.lines.map(escapeHtml).join('<br>')}</p></div>`,
      );
      return `<div class="slide-columns type-demo">${samples.join('')}</div>`;
    }
    case 'wordmark': {
      const wordmark = escapeHtml(piece.brand.wordmark);
      return `<div class="slide-columns two"><div class="mark-demo">${wordmark}</div><div class="mark-demo reverse">${wordmark}</div></div>`;
    }
  }
}

function registerHtml(piece: DeckPiece, context: BlockContext, firstView: boolean): string {
  const register = piece.register === null ? '' : `<span>${escapeHtml(piece.register)}</span>`;
  const mark =
    piece.logo === null
      ? `<span class="wordmark">${escapeHtml(piece.brand.wordmark)}</span>`
      : renderLogoBlock(piece.logo, context, {firstView, heightPx: LOGO_HEIGHT_PX, className: 'slide-logo'});
  return `<div class="slide-register">${register}${mark}</div>`;
}

/** Credits on the cover, in meta size above the footer (UX §05, D69). */
function creditsHtml(piece: DeckPiece): string {
  if (piece.credits.length === 0) {
    return '';
  }
  const entries = piece.credits.map((credit) => `<div><dt>${escapeHtml(credit.role)}</dt><dd>${escapeHtml(credit.name)}</dd></div>`);
  return `<dl class="slide-credits">${entries.join('')}</dl>`;
}

function slideHtml(piece: DeckPiece, slide: ResolvedSlide, context: BlockContext): string {
  assertShape(slide);
  const number = slide.number;
  const titleId = `title-${number}`;
  const lead = slide.lead === null ? '' : `<p class="slide-lead">${slide.lead.html}</p>`;
  const footerText = slide.footer === null ? '' : `<span>${escapeHtml(slide.footer)}</span>`;
  const footer =
    `<footer class="slide-footer">${footerText}<span class="slide-status">${escapeHtml(piece.statusLabel)}</span>` +
    `<span>${slideCounter(number, piece.slides.length)}</span></footer>`;
  // A slide without notes has no aside: an empty one would show a lone label without JavaScript (D69).
  const notes =
    slide.notes === null
      ? ''
      : `<aside class="slide-notes" aria-label="${escapeHtml(piece.strings.notes_label)}"><strong>${escapeHtml(piece.strings.notes_heading)}</strong> ${joinBlockHtml(slide.notes.html)}</aside>`;
  const canvas =
    `<div class="slide-canvas">${registerHtml(piece, context, number === 1)}` +
    `<h2 class="slide-title" id="${titleId}" tabindex="-1">${slide.title.html}</h2>${lead}` +
    `<div class="slide-content">${contentHtml(piece, slide, context)}</div>` +
    `${slide.layout === 'cover' ? creditsHtml(piece) : ''}${footer}</div>`;
  return (
    `<article class="deck-slide slide-layout-${slide.layout}" id="slide-${number}" aria-labelledby="${titleId}"` +
    ` data-source-line-start="${slide.source.lineStart}" data-source-line-end="${slide.source.lineEnd}">${canvas}${notes}</article>`
  );
}

/**
 * Renders a resolved deck. Each slide article starts a line of its own, so a
 * line of the generated page names the slide it belongs to (R08).
 */
export function render(piece: DeckPiece, media: BuildMedia, build: BuildContext): RenderOutput {
  const context: BlockContext = {strings: piece.strings, language: piece.language, media};
  const strings = piece.strings;
  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<meta name="generator" content="Papeleria ${escapeHtml(build.toolVersion)}">`,
    `<title>${escapeHtml(piece.title.text)}</title>`,
    `<link rel="icon" href="${FAVICON}" type="image/svg+xml">`,
    ...DECK_STYLESHEETS.map((sheet) => `<link rel="stylesheet" href="${sheet.href}">`),
    `<script type="application/json" id="papeleria-strings">${escapeJsonForHtml(strings)}</script>`,
    `<script src="${DECK_SCRIPT}" defer></script>`,
  ];
  const tools = TOOLS.map(
    ([id, key, className, toggle]) =>
      `<button class="${className}" id="${id}" type="button"${toggle ? ' aria-pressed="false"' : ''}>${escapeHtml(strings[key])}</button>`,
  );
  const html = [
    '<!DOCTYPE html>',
    `<html lang="${piece.language}">`,
    '<head>',
    ...head,
    '</head>',
    '<body class="deck-page">',
    `<a class="skip-link" href="#deck-main">${escapeHtml(strings.skip)}</a>`,
    `<div class="deck-tools">${tools.join('')}<p class="deck-status" id="deck-status" role="status">${escapeHtml(strings.no_js_slides)}</p></div>`,
    '<main class="deck" id="deck-main">',
    ...piece.slides.map((slide) => slideHtml(piece, slide, context)),
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
  return {html, script: DECK_SCRIPT, targets: deckTargets(piece)};
}

function published(media: BuildMedia, path: string): PublishedImage {
  const image = media.images.get(path);
  if (image === undefined) {
    throw new Error(`E_INTERNAL: the build published nothing for ${path}`);
  }
  return image;
}

/**
 * The images a deck's first view loads (IC04): the first slide with its logo
 * and its picture. Charts are inline in the page, and every other slide's
 * images wait, lazily, until it is shown.
 */
export function deckFirstView(piece: DeckPiece, media: BuildMedia): FirstViewImage[] {
  const images: FirstViewImage[] = [];
  if (piece.logo !== null) {
    const logo = published(media, piece.logo.asset.path);
    images.push({image: logo, slot: logoSlot(logo, LOGO_HEIGHT_PX)});
  }
  const first = piece.slides[0];
  if (first?.image !== null && first?.image !== undefined) {
    images.push({image: published(media, first.image.asset.path), slot: SLIDE_IMAGE_SLOT});
  }
  return images;
}
