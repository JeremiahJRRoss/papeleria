/**
 * M3.1: the document renderer.
 *
 * `render(piece, media, build)` turns a resolved document into one HTML page:
 * the kit's project report (reference/documents/professional/project-report.html)
 * without its historical editing widgets or script, paginated as IC08 says
 * (D10). It is pure: every string comes from the Piece, every file name from
 * the build's `media`, the tool version from the build, and nothing is read
 * from disk (architecture §4, D63). A published document has no script at
 * all (C22, IC07).
 *
 * The page (D94): `main#document` holds one `article.template-page` per
 * logical sheet. The first section starts the first sheet, and each section
 * marked `new_page` starts another; print breaks before every sheet but the
 * first (`print.css`), and a sheet longer than a page flows on to further
 * pages, never cut. Each sheet opens with the wordmark and the document type
 * and ends with its footer: the author's footer text, if any, then the status
 * label, and never a sheet or page number. The first sheet shows the status
 * as its draft label, the takeaway as `h1` and the metadata and credits; the
 * last ends with the source note. Each section is a `<section>` with its
 * manifest lines, headed by an `h2` whose id is the section's slug and whose
 * text links to it, so a reader can take the address of any section.
 *
 * Deliberate differences from the reference, each recorded in
 * docs/REFERENCE_COMPATIBILITY.md: no editor toolbar, editable fields or
 * inline script; no static sheet numbers; linked stylesheets instead of the
 * reference's inline copy; section headings as links, sections as elements.
 */
import {DOCUMENT_PAGE_IDS, type DocumentPiece, type ResolvedBlock, type ResolvedSection} from '../../src/core/index.js';
import {documentTargets} from '../../src/build/targets.js';
import {FAVICON, type BuildContext, type RenderOutput} from '../deck/render.js';
import {
  escapeHtml,
  joinBlockHtml,
  logoSlot,
  posterImage,
  renderCalloutBlock,
  renderChartBlock,
  renderImageBlock,
  renderLogoBlock,
  renderNoteBlock,
  renderQuoteBlock,
  renderTableBlock,
  renderTextBlock,
  renderVideoBlock,
  type BlockContext,
  type BuildMedia,
  type FirstViewImage,
  type ImageSlot,
  type PublishedImage,
} from '../shared/blocks.js';

/**
 * The page's own id: the main content, which the skip link names. It is the
 * one entry of the core's `DOCUMENT_PAGE_IDS`, which resolve keeps section
 * slugs from (D153, D95); a unit test holds the two together.
 */
export const MAIN_ID = DOCUMENT_PAGE_IDS[0]!;

/**
 * The stylesheets a document links, in order, and where each comes from in
 * the tool (D62 for the kit files, D94): the kit's print rules apply in print
 * only, and `base.css` comes last so its print rules follow the kit's.
 */
export const DOCUMENT_STYLESHEETS: readonly {readonly href: string; readonly source: string; readonly media?: 'print'}[] = Object.freeze([
  {href: 'theme/css/fonts.css', source: 'theme/css/fonts.css'},
  {href: 'theme/css/tokens.css', source: 'theme/css/tokens.css'},
  {href: 'theme/css/site.css', source: 'theme/css/site.css'},
  {href: 'theme/css/print.css', source: 'theme/css/print.css', media: 'print'},
  {href: 'theme/css/base.css', source: 'templates/shared/base.css'},
]);

/**
 * The width of a sheet's text in CSS pixels: 210 mm less twice 18 mm of
 * padding (`site.css`), 174 mm at 96 px to the inch, rounded up.
 */
export const DOCUMENT_MEASURE_PX = 658;

/**
 * An image, a poster or a chart spans the sheet's text. Up to 640 px wide the
 * sheet fills the screen less 12 px of margin and 24 px of padding on each
 * side (`site.css`), so the text is the viewport less 72 px; wider, it is the
 * sheet's measure, or less when the window is narrower than a sheet. The
 * estimate errs wide, so a browser never picks a softer derivative than the
 * one the budget counts (IC04).
 */
export const DOCUMENT_IMAGE_SLOT: ImageSlot = Object.freeze({
  sizes: `(max-width: 640px) calc(100vw - 72px), ${DOCUMENT_MEASURE_PX}px`,
  slotWidth: (viewportWidth: number) => (viewportWidth <= 640 ? Math.max(1, viewportWidth - 72) : DOCUMENT_MEASURE_PX),
});

/** A logo on a page is 48 px tall (UX §09). */
export const DOCUMENT_LOGO_HEIGHT_PX = 48;

/**
 * The sections of each logical sheet, in order. The first section always
 * starts the first sheet, whatever its `new_page`; every later section marked
 * `new_page` starts the next (IC08).
 */
export function logicalSheets(piece: DocumentPiece): (readonly ResolvedSection[])[] {
  const sheets: ResolvedSection[][] = [];
  for (const section of piece.sections) {
    const current = sheets.at(-1);
    if (current === undefined || section.newPage) {
      sheets.push([section]);
    } else {
      current.push(section);
    }
  }
  return sheets;
}

/** The block's id prefix: an underscore, which no slug holds, keeps it apart from every heading's id (D95). */
function blockId(section: ResolvedSection, block: ResolvedBlock): string {
  return `s${section.number}_b${block.position}`;
}

function blockHtml(section: ResolvedSection, block: ResolvedBlock, context: BlockContext, firstSheet: boolean): string {
  switch (block.kind) {
    case 'text':
      return joinBlockHtml(renderTextBlock(block.text, context));
    case 'image':
      return renderImageBlock(block.image, context, {firstView: firstSheet, slot: DOCUMENT_IMAGE_SLOT, className: 'doc-figure image-figure'});
    case 'video':
      return renderVideoBlock(block.video, context, {id: blockId(section, block), container: 'section', slot: DOCUMENT_IMAGE_SLOT});
    case 'chart':
      return renderChartBlock(block.chart, context, {id: blockId(section, block), labelledBy: section.slug});
    case 'table':
      return renderTableBlock(block.table, context, {id: blockId(section, block), labelledBy: section.slug});
    case 'quote':
      return renderQuoteBlock(block.text, block.attribution, context);
    case 'note':
      return renderNoteBlock(block.text, block.tone, context);
    case 'callout':
      return renderCalloutBlock(block.text, context);
    case 'logo':
      return `<div class="logo-block">${renderLogoBlock(block.logo, context, {firstView: firstSheet, heightPx: DOCUMENT_LOGO_HEIGHT_PX, className: 'doc-logo'})}</div>`;
  }
}

/** A section: its heading, which links to its own address, then its blocks. Each starts a line of its own (R08). */
function sectionHtml(section: ResolvedSection, context: BlockContext, firstSheet: boolean): string {
  if (section.heading.trim() === '' || section.blocks.length === 0) {
    throw new Error(`E_INTERNAL: section ${section.number} (${section.pointer}) has no heading or no block; the renderer never renders an invalid piece`);
  }
  const heading = `<h2${attribute('id', section.slug)}><a class="doc-anchor"${attribute('href', `#${encodeURIComponent(section.slug)}`)}>${escapeHtml(section.heading)}</a></h2>`;
  const blocks = section.blocks.map((block) => blockHtml(section, block, context, firstSheet));
  return (
    `<section class="doc-section" data-source-line-start="${section.source.lineStart}" data-source-line-end="${section.source.lineEnd}">` +
    `${heading}${blocks.join('')}</section>`
  );
}

function attribute(name: string, value: string | number): string {
  return ` ${name}="${escapeHtml(String(value))}"`;
}

/** The takeaway, the status and the metadata, which open the first sheet (UX §07). */
function frontMatter(piece: DocumentPiece): string {
  const entries = [
    ...piece.metadata.map((item) => [item.label, item.value] as const),
    ...piece.credits.map((credit) => [credit.role, credit.name] as const),
  ].map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`);
  const metadata = entries.length === 0 ? '' : `<dl class="doc-metadata">${entries.join('')}</dl>`;
  return `<span class="draft-label">${escapeHtml(piece.statusLabel)}</span><h1>${piece.title.html}</h1>${metadata}`;
}

/** A sheet's footer: the author's footer text, then the status, which a custom footer never hides (ERD DOCUMENT). */
function footerHtml(piece: DocumentPiece): string {
  const text = piece.footer === null ? '' : `<span>${escapeHtml(piece.footer)}</span>`;
  return `<footer class="template-footer">${text}<span class="doc-status">${escapeHtml(piece.statusLabel)}</span></footer>`;
}

function sheetHtml(piece: DocumentPiece, sections: readonly ResolvedSection[], index: number, last: boolean, context: BlockContext): string[] {
  const first = index === 0;
  const top = `<header class="doc-top"><span class="wordmark">${escapeHtml(piece.brand.wordmark)}</span><span class="doc-type">${escapeHtml(piece.docType)}</span></header>`;
  const note = last && piece.sourceNote !== null ? [`<div class="source-note">${joinBlockHtml(renderTextBlock(piece.sourceNote, context))}</div>`] : [];
  return [
    '<article class="template-page">',
    top,
    `<div class="doc-content">${first ? frontMatter(piece) : ''}`,
    ...sections.map((section) => sectionHtml(section, context, first)),
    ...note,
    '</div>',
    footerHtml(piece),
    '</article>',
  ];
}

/**
 * Renders a resolved document. Every section starts a line of its own, so a
 * line of the generated page names the section it belongs to (R08).
 */
export function render(piece: DocumentPiece, media: BuildMedia, build: BuildContext): RenderOutput {
  const context: BlockContext = {strings: piece.strings, language: piece.language, media};
  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<meta name="generator" content="Papeleria ${escapeHtml(build.toolVersion)}">`,
    `<title>${escapeHtml(piece.title.text)}</title>`,
    `<link rel="icon" href="${FAVICON}" type="image/svg+xml">`,
    ...DOCUMENT_STYLESHEETS.map((sheet) => `<link rel="stylesheet" href="${sheet.href}"${sheet.media === undefined ? '' : ` media="${sheet.media}"`}>`),
  ];
  const sheets = logicalSheets(piece);
  const html = [
    '<!DOCTYPE html>',
    `<html lang="${piece.language}">`,
    '<head>',
    ...head,
    '</head>',
    '<body class="document-body">',
    `<a class="skip-link" href="#${MAIN_ID}">${escapeHtml(piece.strings.skip)}</a>`,
    `<main id="${MAIN_ID}" class="document-main">`,
    ...sheets.flatMap((sections, index) => sheetHtml(piece, sections, index, index === sheets.length - 1, context)),
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
  return {html, script: null, targets: documentTargets(piece)};
}

function published(media: BuildMedia, path: string): PublishedImage {
  const image = media.images.get(path);
  if (image === undefined) {
    throw new Error(`E_INTERNAL: the build published nothing for ${path}`);
  }
  return image;
}

/**
 * The images a document's first view loads (IC04, D96): every image and logo
 * of the first logical sheet, which the page loads at once, and every video's
 * poster wherever it stands, because a browser fetches a poster when the page
 * loads and a poster cannot wait. Charts are inline in the page; images of
 * later sheets load lazily and are not counted.
 */
export function documentFirstView(piece: DocumentPiece, media: BuildMedia): FirstViewImage[] {
  const images: FirstViewImage[] = [];
  for (const [index, sections] of logicalSheets(piece).entries()) {
    for (const block of sections.flatMap((section) => section.blocks)) {
      if (block.kind === 'video') {
        const poster = posterImage(published(media, block.video.poster.path), DOCUMENT_IMAGE_SLOT.slotWidth(Number.MAX_SAFE_INTEGER));
        images.push({image: poster, slot: DOCUMENT_IMAGE_SLOT});
      } else if (index === 0 && block.kind === 'image') {
        images.push({image: published(media, block.image.asset.path), slot: DOCUMENT_IMAGE_SLOT});
      } else if (index === 0 && block.kind === 'logo') {
        const logo = published(media, block.logo.asset.path);
        images.push({image: logo, slot: logoSlot(logo, DOCUMENT_LOGO_HEIGHT_PX)});
      }
    }
  }
  return images;
}
