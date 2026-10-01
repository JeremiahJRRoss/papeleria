/**
 * M4.2: the comic renderer.
 *
 * `render(piece, media, build)` turns a resolved comic into one HTML page, the
 * DOM contract of `templates/comic/client/CONTRACT.md`: the markup the reader
 * enhances and, as it is, the form that reads without JavaScript and prints.
 * It is pure: every string comes from the Piece, every file name from the
 * build's `media`, the tool version from the build, and nothing is read from
 * disk (architecture §4, D63).
 *
 * The page (D105):
 *
 * - a register: the title as `h1`, the format label (the manifest's `format`,
 *   else the localized `format_comics`), the status label and the wordmark;
 * - the controls bar, before the pages as C4 orders them (skip link,
 *   controls, then each panel): Previous, the status line (`role=status`,
 *   the `no_js` sentence until the reader starts), Next, Guided view, Detail
 *   (guided view only), Transcript and Full screen. The stylesheet hides the
 *   buttons until the reader has enhanced the page, as the deck hides its
 *   tools (D69);
 * - `main#comic-main`: an empty book stage the reader fills, then one
 *   `article.comic-sheet#page-N` per page, each starting a line of its own,
 *   with the page's manifest lines (R08). A sheet holds its heading, "Page N
 *   of M"; the art `figure`, the page image with one control per panel
 *   positioned over its box in percent, named by its transcript, in reading
 *   order; the page's credit and rights; and its transcript list, where a
 *   text or image detail lives under its panel's transcript, and a link
 *   detail as its link. The last sheet ends with the comic's credits.
 *
 * A panel is a `button`; a panel whose detail is a link is that link, an `a`
 * with IC02's external indication (D151). The reader moves each art figure
 * into the page-turn engine's book, so the sheets left behind become the
 * transcript strip under the book; without JavaScript they stack, art then
 * transcript, which is also what prints (IC08).
 */
import {formatString, type ComicPiece, type ResolvedDetail, type ResolvedPage, type ResolvedPanel} from '../../src/core/index.js';
import type {PhoneImageSource} from '../../src/build/budget.js';
import {comicTargets} from '../../src/build/targets.js';
import {FAVICON, type BuildContext, type RenderOutput} from '../deck/render.js';
import {
  escapeHtml,
  escapeJsonForHtml,
  joinBlockHtml,
  renderImageBlock,
  renderPicture,
  renderTextBlock,
  urlPath,
  type BlockContext,
  type BuildMedia,
  type FirstViewImage,
  type ImageSlot,
  type PublishedImage,
} from '../shared/blocks.js';

/** The comic's one script (C22): the engine's pinned bytes, then the reader, bundled by `npm run build` (D109). */
export const COMIC_SCRIPT = 'reader.js';

/**
 * The stylesheets a comic links, in order, and where each comes from in the
 * tool: the kit's, its print rules in print only, the shared blocks, and the
 * comic's own, last, so decks and documents never carry the reader's rules (D105).
 */
export const COMIC_STYLESHEETS: readonly {readonly href: string; readonly source: string; readonly media?: 'print'}[] = Object.freeze([
  {href: 'theme/css/fonts.css', source: 'theme/css/fonts.css'},
  {href: 'theme/css/tokens.css', source: 'theme/css/tokens.css'},
  {href: 'theme/css/site.css', source: 'theme/css/site.css'},
  {href: 'theme/css/print.css', source: 'theme/css/print.css', media: 'print'},
  {href: 'theme/css/base.css', source: 'templates/shared/base.css'},
  {href: 'theme/css/comic.css', source: 'templates/comic/comic.css'},
]);

/**
 * The engine's MIT licence, which travels with every comic (D11, D100,
 * DISTRIBUTION_INVENTORY §2). It keeps its component's path, since `LICENSE`
 * at the root is Papeleria's own (D108).
 */
export const COMIC_NOTICES: readonly {readonly path: string; readonly source: string}[] = Object.freeze([
  {path: 'vendor/page-flip/LICENSE', source: 'vendor/page-flip/LICENSE'},
]);

/** The main content, the skip link's target: outside every page, so the reader leaves it to the browser (IC07). */
export const MAIN_ID = 'comic-main';

/** The empty stage the reader builds the book in. */
export const BOOK_ID = 'comic-book';

/**
 * A page's image slot: half the viewport from 900 px, where a spread may
 * stand, the whole width below it. It errs wide, as the other templates'
 * slots do, since a page fitted to a short viewport is narrower still; the
 * budget reports what it picks (IC04).
 */
export const COMIC_PAGE_SLOT: ImageSlot = Object.freeze({
  sizes: '(min-width: 900px) 50vw, 100vw',
  slotWidth: (viewportWidth: number) => (viewportWidth >= 900 ? viewportWidth / 2 : viewportWidth),
});

/** An image detail fills the dialog, at most 720 px wide. */
export const COMIC_DETAIL_SLOT: ImageSlot = Object.freeze({
  sizes: '(max-width: 800px) 90vw, 720px',
  slotWidth: (viewportWidth: number) => (viewportWidth <= 800 ? 0.9 * viewportWidth : 720),
});

/** The cover and its next spread are the first view (IC04); every later page's image waits, lazily. */
export const FIRST_VIEW_PAGES = 3;

/**
 * Text headings in a detail sit under the page's `h2` and its transcript's `h3` (D150's rebasing). The reader raises
 * them a level while the detail is in its dialog, under the dialog's `h2` (W5R-19).
 */
const DETAIL_HEADING_LEVEL = 4;

/** The ids of a page and a panel: the address fragments the reader answers to (ERD §09). Ids beginning `page-` are theirs alone. */
export function pageId(page: number): string {
  return `page-${page}`;
}

export function panelId(page: number, panel: number): string {
  return `page-${page}-panel-${panel}`;
}

function attribute(name: string, value: string | number): string {
  return ` ${name}="${escapeHtml(String(value))}"`;
}

/** A defect in the caller: the schema, resolve and R14 admit no piece that reaches here. */
function invalid(where: string, what: string): never {
  throw new Error(`E_INTERNAL: ${where} ${what}; the renderer never renders an invalid piece`);
}

function published(media: BuildMedia, path: string): PublishedImage {
  const image = media.images.get(path);
  if (image === undefined) {
    throw new Error(`E_INTERNAL: the build published nothing for ${path}`);
  }
  return image;
}

/** A panel's box as CSS: left, top, width and height in percent of the page image (R08 allows exactly these, D105). */
function boxStyle(panel: ResolvedPanel, where: string): string {
  const [x, y, width, height] = panel.box;
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || !(width > 0) || !(height > 0) || x + width > 100 + 1e-9 || y + height > 100 + 1e-9) {
    invalid(where, `has the box [${panel.box.join(', ')}], which is not inside the page`);
  }
  return `left:${x}%;top:${y}%;width:${width}%;height:${height}%`;
}

/**
 * A link as the core renders one (D151): external ones marked, visibly and for
 * a screen reader. One whose address resolve refused is its label alone, as a
 * refused Markdown link is its text (F17).
 */
function linkHtml(detail: Extract<ResolvedDetail, {kind: 'link'}>, context: BlockContext, className = ''): string {
  if (detail.href === null) {
    return escapeHtml(detail.label);
  }
  const external = detail.link === 'external';
  const classes = [className, external ? 'link-external' : ''].filter((name) => name !== '').join(' ');
  const mark = external
    ? `<span class="link-external-mark" aria-hidden="true">↗</span><span class="sr-only"> (${escapeHtml(context.strings.external_link)})</span>`
    : '';
  return `<a${attribute('href', detail.href)}${classes === '' ? '' : attribute('class', classes)}>${escapeHtml(detail.label)}${mark}</a>`;
}

/**
 * A panel: a button over its box, named by its transcript, which the reader
 * turns into its detail (a dialog for a zoom, text or image) or, without one,
 * into an announcement of the transcript; a link detail makes the panel that
 * link. The transcript is the control's text, visually hidden: the art shows
 * nothing at rest (UX §06). A detail's hint shows on hover and focus only.
 */
function panelHtml(page: ResolvedPage, panel: ResolvedPanel, zoomSrc: string, context: BlockContext): string {
  const where = `panel ${panel.number} of page ${page.number} (${panel.pointer})`;
  if (panel.transcript.trim() === '') {
    invalid(where, 'has no transcript');
  }
  const detail = panel.detail;
  // A link whose address was refused has nothing to follow: the panel is one without a detail (F17).
  const kind = detail === null || (detail.kind === 'link' && detail.href === null) ? 'none' : detail.kind;
  const common =
    attribute('id', panelId(page.number, panel.number)) +
    attribute('data-page', page.number) +
    attribute('data-panel', panel.number) +
    attribute('data-detail', kind) +
    attribute('data-box', panel.box.join(' ')) +
    attribute('data-source-line-start', panel.source.lineStart) +
    attribute('data-source-line-end', panel.source.lineEnd) +
    attribute('style', boxStyle(panel, where));
  const label = `<span class="comic-panel-label">${escapeHtml(panel.transcript)}</span>`;
  if (detail?.kind === 'link' && detail.href !== null) {
    const external = detail.link === 'external';
    const hint =
      `<span class="comic-panel-hint">${escapeHtml(detail.label)}` +
      (external ? `<span class="link-external-mark" aria-hidden="true">↗</span><span class="sr-only"> (${escapeHtml(context.strings.external_link)})</span>` : '') +
      '</span>';
    return `<a class="comic-panel${external ? ' link-external' : ''}"${attribute('href', detail.href)}${common}>${label}${hint}</a>`;
  }
  if (detail === null || detail.kind === 'link') {
    return `<button class="comic-panel" type="button"${common}>${label}</button>`;
  }
  const zoom = detail.kind === 'zoom' ? attribute('data-zoom-src', zoomSrc) : '';
  const hint = `<span class="comic-panel-hint" aria-hidden="true">${escapeHtml(context.strings.detail)}</span>`;
  return `<button class="comic-panel" type="button"${common} aria-haspopup="dialog"${zoom}>${label}${hint}</button>`;
}

/**
 * What a panel's entry in the transcript list holds after its transcript: a
 * text or image detail itself, which the reader moves into its dialog while
 * it is open, or a link detail's link. A zoom is the art itself, so nothing.
 */
function detailHtml(page: ResolvedPage, panel: ResolvedPanel, context: BlockContext): string {
  const detail = panel.detail;
  if (detail === null || detail.kind === 'zoom') {
    return '';
  }
  const id = attribute('id', `detail-${page.number}-${panel.number}`);
  switch (detail.kind) {
    case 'text':
      return `<div class="comic-detail comic-detail-text"${id} data-detail="text">${joinBlockHtml(renderTextBlock(detail.text, context, DETAIL_HEADING_LEVEL))}</div>`;
    case 'image':
      return (
        `<div class="comic-detail comic-detail-image"${id} data-detail="image">` +
        `${renderImageBlock(detail.image, context, {firstView: false, slot: COMIC_DETAIL_SLOT, className: 'comic-detail-figure image-figure'})}</div>`
      );
    case 'link':
      return `<p class="comic-detail-link"${id}>${linkHtml(detail, context)}</p>`;
  }
}

function transcriptHtml(page: ResolvedPage, context: BlockContext): string {
  if (page.panels.length === 0) {
    return '';
  }
  const items = page.panels.map(
    (panel) =>
      `<li class="comic-transcript-item"${attribute('data-panel', panel.number)}>` +
      `<p class="comic-transcript-text">${escapeHtml(panel.transcript)}</p>${detailHtml(page, panel, context)}</li>`,
  );
  return (
    `<div class="comic-transcript"><h3 class="comic-transcript-title">${escapeHtml(context.strings.transcript)}</h3>` +
    `<ol class="comic-transcript-list">${items.join('')}</ol></div>`
  );
}

/** A page's credit and rights, in meta size under its art; nothing when it has neither (R06 warns). */
function creditHtml(page: ResolvedPage): string {
  const parts = [
    page.credit === null ? '' : `<span class="comic-credit-name">${escapeHtml(page.credit)}</span>`,
    page.rights === null ? '' : `<span class="comic-credit-rights">${escapeHtml(page.rights)}</span>`,
  ].filter((part) => part !== '');
  return parts.length === 0 ? '' : `<p class="comic-credit">${parts.join('')}</p>`;
}

/** The comic's credits, on its last page in meta size (UX §06). */
function creditsHtml(piece: ComicPiece): string {
  if (piece.credits.length === 0) {
    return '';
  }
  const entries = piece.credits.map((credit) => `<div><dt>${escapeHtml(credit.role)}</dt><dd>${escapeHtml(credit.name)}</dd></div>`);
  return `<dl class="comic-credits">${entries.join('')}</dl>`;
}

function sheetHtml(piece: ComicPiece, page: ResolvedPage, context: BlockContext): string {
  const total = piece.pages.length;
  const image = published(context.media, page.image.path);
  const zoomSrc = urlPath(image.kind === 'vector' ? image.file.path : page.image.path);
  const titleId = `sheet-${page.number}-title`;
  const picture = renderPicture(image, {alt: page.alt, slot: COMIC_PAGE_SLOT, lazy: page.number > FIRST_VIEW_PAGES});
  const panels = page.panels.map((panel) => panelHtml(page, panel, zoomSrc, context)).join('');
  const last = page.number === total ? creditsHtml(piece) : '';
  return (
    `<article class="comic-sheet"${attribute('id', pageId(page.number))}${attribute('data-page', page.number)}` +
    `${attribute('data-source-line-start', page.source.lineStart)}${attribute('data-source-line-end', page.source.lineEnd)}>` +
    `<h2 class="comic-sheet-title"${attribute('id', titleId)}>${escapeHtml(formatString(context.strings.page_of, {n: page.number, total}))}</h2>` +
    `<figure class="comic-figure"${attribute('data-page', page.number)}${attribute('aria-labelledby', titleId)}><div class="comic-art">${picture}${panels}</div></figure>` +
    `${creditHtml(page)}${transcriptHtml(page, context)}${last}</article>`
  );
}

/** The bar's controls: id, strings key, class, and whether it starts hidden or pressed (CONTRACT §3). */
const TOOLS: readonly (readonly [id: string, key: 'previous' | 'next' | 'guided_view' | 'detail' | 'transcript' | 'fullscreen', className: string, state: '' | 'hidden' | 'pressed'])[] = [
  ['comic-previous', 'previous', 'button', ''],
  ['comic-next', 'next', 'button', ''],
  ['comic-guided', 'guided_view', 'button secondary', ''],
  ['comic-detail', 'detail', 'button secondary', 'hidden'],
  ['comic-transcript-toggle', 'transcript', 'button secondary', 'pressed'],
  ['comic-fullscreen', 'fullscreen', 'button secondary', ''],
];

function toolsHtml(context: BlockContext): string {
  const button = ([id, key, className, state]: (typeof TOOLS)[number]): string =>
    `<button class="${className}" id="${id}" type="button"${state === 'hidden' ? ' hidden' : state === 'pressed' ? ' aria-pressed="false"' : ''}>${escapeHtml(context.strings[key])}</button>`;
  const [previous, next, ...rest] = TOOLS;
  return (
    `<div class="comic-tools" id="comic-tools">${button(previous!)}` +
    `<p class="comic-status" id="comic-status" role="status">${escapeHtml(context.strings.no_js)}</p>` +
    `${button(next!)}${rest.map(button).join('')}</div>`
  );
}

/**
 * Renders a resolved comic. Every sheet starts a line of its own, so a line of
 * the generated page names the page it belongs to (R08).
 */
export function render(piece: ComicPiece, media: BuildMedia, build: BuildContext): RenderOutput {
  const context: BlockContext = {strings: piece.strings, language: piece.language, media};
  const strings = piece.strings;
  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<meta name="generator" content="Papeleria ${escapeHtml(build.toolVersion)}">`,
    `<title>${escapeHtml(piece.title.text)}</title>`,
    `<link rel="icon" href="${FAVICON}" type="image/svg+xml">`,
    ...COMIC_STYLESHEETS.map((sheet) => `<link rel="stylesheet" href="${sheet.href}"${sheet.media === undefined ? '' : ` media="${sheet.media}"`}>`),
    `<script type="application/json" id="papeleria-strings">${escapeJsonForHtml(strings)}</script>`,
    `<script src="${COMIC_SCRIPT}" defer></script>`,
  ];
  const register =
    `<header class="comic-register"><h1 class="comic-title">${piece.title.html}</h1>` +
    `<span class="comic-format">${escapeHtml(piece.formatLabel)}</span>` +
    `<span class="comic-status-label">${escapeHtml(piece.statusLabel)}</span>` +
    `<span class="wordmark">${escapeHtml(piece.brand.wordmark)}</span></header>`;
  const html = [
    '<!DOCTYPE html>',
    `<html lang="${piece.language}">`,
    '<head>',
    ...head,
    '</head>',
    '<body class="comic-body">',
    `<a class="skip-link" href="#${MAIN_ID}">${escapeHtml(strings.skip)}</a>`,
    register,
    toolsHtml(context),
    `<main class="comic" id="${MAIN_ID}">`,
    `<div class="comic-book" id="${BOOK_ID}"></div>`,
    ...piece.pages.map((page) => sheetHtml(piece, page, context)),
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
  return {html, script: COMIC_SCRIPT, targets: comicTargets(piece)};
}

/**
 * The raster page images a zoom detail opens, each once: the build publishes
 * their originals at their own paths (IC04: "Source originals are copied for
 * requested zoom details, but never preloaded"). An SVG page zooms into the
 * file the build already writes (D108).
 */
export function zoomOriginals(piece: ComicPiece): string[] {
  const paths = new Set<string>();
  for (const page of piece.pages) {
    if (page.image.kind === 'raster' && page.panels.some((panel) => panel.detail?.kind === 'zoom')) {
      paths.add(page.image.path);
    }
  }
  return [...paths].sort();
}

/**
 * The images a comic's first view loads (IC04): the cover and its next
 * spread, pages 1 to 3, at the page slot. A comic's first view has no limit
 * (`budgetBytes` null); its phone images have one each (D106).
 */
export function comicFirstView(piece: ComicPiece, media: BuildMedia): FirstViewImage[] {
  return piece.pages.slice(0, FIRST_VIEW_PAGES).map((page) => ({image: published(media, page.image.path), slot: COMIC_PAGE_SLOT}));
}

/** Every page image the build published, each once, for the phone-image limit (IC04, D106). */
export function comicPhoneImages(piece: ComicPiece, media: BuildMedia): PhoneImageSource[] {
  const seen = new Set<string>();
  const images: PhoneImageSource[] = [];
  for (const page of piece.pages) {
    if (!seen.has(page.image.path)) {
      seen.add(page.image.path);
      images.push({source: page.image.path, image: published(media, page.image.path)});
    }
  }
  return images;
}
