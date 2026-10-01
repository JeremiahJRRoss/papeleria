/**
 * M1.11: the shared blocks every template renders the same way (text, image,
 * chart, table, logo), and the pieces of HTML output every renderer needs:
 * context escaping, the IC02 JSON data block, and the build's media.
 *
 * Everything here is a pure function of resolved values and the build's
 * `media`: nothing reads a file (architecture §4). The text a
 * block shows is the author's, escaped for its context; the control text is
 * the piece's strings; the file names are what the build published (D63).
 * The quote, note, callout and video blocks are W3B's (M3.2, D97).
 */
import {
  renderChart,
  renderMarkdown,
  type ChartInput,
  type CsvTable,
  type DataAsset,
  type Language,
  type ResolvedChart,
  type ResolvedImage,
  type ResolvedLogo,
  type ResolvedTable,
  type ResolvedTableColumn,
  type ResolvedText,
  type ResolvedVideo,
  type UiStrings,
} from '../../src/core/index.js';

// ---------------------------------------------------------------------------
// Escaping

const HTML_ESCAPES: Readonly<Record<string, string>> = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};

/**
 * Escapes text for an HTML text node or a double-quoted attribute value: the
 * five characters that could end either, so an author's string never becomes
 * markup (IC01, IC02).
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]!);
}

/**
 * Serializes a value for an inert `<script type="application/json">` element
 * (IC02): `<`, `>`, `&`, U+2028 and U+2029 become Unicode escapes, so no value
 * can close the element, open a comment or break a line.
 */
export function escapeJsonForHtml(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new TypeError('E_INTERNAL: the value has no JSON form');
  }
  return json.replace(/[<>&\u2028\u2029]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** An URL path written by the build: each segment percent-encoded, slashes kept. */
export function urlPath(path: string): string {
  return path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

const BLOCK_TAG = '(?:p|ul|ol|li|h[1-6]|blockquote|pre|table|thead|tbody|tfoot|tr|th|td|section|div|hr|dl|dt|dd|figure|figcaption)';
const BETWEEN_BLOCKS = new RegExp(`(<\\/?${BLOCK_TAG}\\b[^>]*>)\\n+(?=<\\/?${BLOCK_TAG}\\b|$)`, 'g');

/**
 * Rendered Markdown with no line break between block tags and none at the end.
 * markdown-it ends every block with a newline; inside an element styled
 * `white-space: pre-line`, such as the deck's notes aside, each of those shows
 * as a blank line (W1D observation 2). Line breaks inside a paragraph, which
 * the author typed, and everything inside `<pre>` stay as they are.
 */
export function joinBlockHtml(html: string): string {
  return html.replace(BETWEEN_BLOCKS, '$1').replace(/\n+$/, '');
}

function attribute(name: string, value: string | number): string {
  return ` ${name}="${escapeHtml(String(value))}"`;
}

// ---------------------------------------------------------------------------
// The build's media (D63)

/** A file the build wrote, relative to the output folder, and its size in bytes as written. */
export type PublishedFile = {readonly path: string; readonly bytes: number};

/** One raster derivative, as `deriveImage` returned it. */
export type PublishedDerivative = PublishedFile & {readonly width: number; readonly height: number; readonly format: 'webp' | 'avif'};

/**
 * A raster the build published: the derivatives `deriveImage` wrote, ascending
 * by width with WebP before AVIF at each width, and the oriented source size.
 * The widths are whatever the result holds (D40): one derivative for a source
 * narrower than 800 px, 800 alone for one under 1600 px.
 */
export type PublishedRaster = {
  readonly kind: 'raster';
  readonly width: number;
  readonly height: number;
  readonly derivatives: readonly PublishedDerivative[];
};

/**
 * An SVG the build published: the validated markup written as it is (IC02,
 * D164(f)); `bytes` are the bytes written, which never include a byte-order
 * mark. `width` and `height` are the viewBox in whole pixels.
 */
export type PublishedVector = {
  readonly kind: 'vector';
  readonly width: number;
  readonly height: number;
  readonly file: PublishedFile;
};

export type PublishedImage = PublishedRaster | PublishedVector;

/**
 * What the build published for the piece, handed to a renderer beside the
 * Piece (the owner's decision, W1_RECONCILIATION §6). `images` holds every
 * image, logo, poster and comic page, keyed by the piece-relative path the
 * manifest names; a derivative's name hashes the source bytes (D43), which the
 * Piece does not carry, so only the build can name it.
 */
export type BuildMedia = {readonly images: ReadonlyMap<string, PublishedImage>};

/** Media for a piece with no images. */
export const NO_MEDIA: BuildMedia = Object.freeze({images: new Map<string, PublishedImage>()});

/** What every block function needs besides its own value. */
export type BlockContext = {
  readonly strings: UiStrings;
  readonly language: Language;
  readonly media: BuildMedia;
};

function publishedImage(context: BlockContext, path: string): PublishedImage {
  const published = context.media.images.get(path);
  if (published === undefined) {
    // A renderer never runs on a piece the build could not publish in full.
    throw new Error(`E_INTERNAL: the build published nothing for ${path}`);
  }
  return published;
}

/**
 * How wide an image is drawn, for its `sizes` attribute and for the budget,
 * which picks the candidate a browser would pick at each reference viewport
 * (IC04). `slotWidth` is the CSS pixel width `sizes` states at a viewport width.
 */
export type ImageSlot = {
  readonly sizes: string;
  slotWidth(viewportWidth: number): number;
};

/** An image the first view loads, and the slot it fills. */
export type FirstViewImage = {readonly image: PublishedImage; readonly slot: ImageSlot};

/** The derivatives of one format, ascending by width. */
export function derivativesOf(raster: PublishedRaster, format: 'webp' | 'avif'): PublishedDerivative[] {
  return raster.derivatives.filter((derivative) => derivative.format === format).sort((a, b) => a.width - b.width);
}

function srcset(derivatives: readonly PublishedDerivative[]): string {
  return derivatives.map((derivative) => `${urlPath(derivative.path)} ${derivative.width}w`).join(', ');
}

/**
 * An `<img>`, or a `<picture>` offering AVIF before it when the build wrote
 * AVIF, for a published image. The raster's `src` is its narrowest WebP, the
 * fallback for a browser without `srcset`; its width and height are the widest
 * derivative's, which only set the aspect ratio.
 */
function imageElement(published: PublishedImage, attributes: string, slot: ImageSlot): string {
  if (published.kind === 'vector') {
    return `<img${attribute('src', urlPath(published.file.path))}${attribute('width', published.width)}${attribute('height', published.height)}${attributes}>`;
  }
  const webp = derivativesOf(published, 'webp');
  const avif = derivativesOf(published, 'avif');
  const smallest = webp[0];
  const widest = webp.at(-1);
  if (smallest === undefined || widest === undefined) {
    throw new Error('E_INTERNAL: a published raster has no WebP derivative');
  }
  const sizes = attribute('sizes', slot.sizes);
  const img =
    `<img${attribute('src', urlPath(smallest.path))}${attribute('srcset', srcset(webp))}${sizes}` +
    `${attribute('width', widest.width)}${attribute('height', widest.height)}${attributes}>`;
  if (avif.length === 0) {
    return img;
  }
  return `<picture><source type="image/avif"${attribute('srcset', srcset(avif))}${sizes}>${img}</picture>`;
}

export type PictureOptions = {
  /** The alternative text, escaped here; empty for an image a reader does not need. */
  readonly alt: string;
  readonly slot: ImageSlot;
  /** `loading="lazy"` for an image outside the first view (UX §09). */
  readonly lazy: boolean;
};

/**
 * A published image as the bare `<img>`, or `<picture>` with AVIF first, that
 * the blocks above wrap in a figure: for a template that lays out its own
 * figure around the picture, such as a comic page with its panels (M4.2, W4).
 */
export function renderPicture(published: PublishedImage, options: PictureOptions): string {
  return imageElement(published, attribute('alt', options.alt) + (options.lazy ? attribute('loading', 'lazy') : ''), options.slot);
}

// ---------------------------------------------------------------------------
// Text

/**
 * A text field's HTML at a heading level. Resolve rendered it at the level of
 * the field that holds it (D150); a template that nests it elsewhere gets it
 * rendered again from the kept Markdown, which is the only reason to (D150).
 */
export function renderTextBlock(text: ResolvedText, context: BlockContext, baseLevel: number = text.baseLevel): string {
  const html =
    baseLevel === text.baseLevel
      ? text.html
      : renderMarkdown(text.markdown, {baseLevel, docId: text.pointer, externalLinkLabel: context.strings.external_link}).html;
  return html.replace(/\n+$/, '');
}

// ---------------------------------------------------------------------------
// Image

export type ImageOptions = {
  /** In the first view: loaded at once; otherwise `loading="lazy"` (UX §09). */
  readonly firstView: boolean;
  readonly slot: ImageSlot;
  /** The figure's class, such as `slide-figure image-figure`. */
  readonly className: string;
};

/**
 * The focal point as `object-position`. The schema holds each coordinate to 0
 * to 100 and R08 allows no other declaration; checking them here as well keeps
 * the inline style two finite percentages whoever calls, as the swatch and the
 * comic box are kept (security audit F19).
 */
function focalPoint(point: readonly [number, number]): string {
  const [x, y] = point;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100) {
    throw new Error(`E_INTERNAL: the focal point [${point.join(', ')}] is not inside the image; the renderer never renders an invalid piece`);
  }
  return x === 50 && y === 50 ? '' : attribute('style', `object-position:${x}% ${y}%`);
}

/** Caption, credit and rights, each on its own line in meta size, or nothing. */
function figureCaption(parts: readonly string[], id?: string): string {
  const content = parts.filter((part) => part !== '').join('');
  return content === '' ? '' : `<figcaption class="figure-caption"${id === undefined ? '' : attribute('id', id)}>${content}</figcaption>`;
}

function metaLine(className: string, text: string | null): string {
  return text === null ? '' : `<p class="${className}">${escapeHtml(text)}</p>`;
}

/**
 * An image block: a `<figure>` holding the picture and, beneath it, the
 * caption, credit and rights. `alt` is the author's text, or empty for a
 * decorative image (R03 has already required one of the two). The focal point
 * becomes `object-position`, which a cropping layout honours.
 */
export function renderImageBlock(image: ResolvedImage, context: BlockContext, options: ImageOptions): string {
  const published = publishedImage(context, image.asset.path);
  const attributes =
    attribute('alt', image.decorative ? '' : (image.alt ?? '')) + (options.firstView ? '' : attribute('loading', 'lazy')) + focalPoint(image.focalPoint);
  const caption = figureCaption([
    image.caption === null ? '' : `<div class="figure-text">${joinBlockHtml(renderTextBlock(image.caption, context))}</div>`,
    metaLine('figure-credit', image.credit),
    metaLine('figure-rights', image.rights),
  ]);
  return `<figure${attribute('class', options.className)}>${imageElement(published, attributes, options.slot)}${caption}</figure>`;
}

// ---------------------------------------------------------------------------
// Logo

export type LogoOptions = {
  readonly firstView: boolean;
  /** The height the logo is drawn at, in CSS pixels: 32 in a register (UX §09). */
  readonly heightPx: number;
  readonly className: string;
};

/** The slot a logo fills: its height times its aspect ratio, at every viewport. */
export function logoSlot(published: PublishedImage, heightPx: number): ImageSlot {
  const width = Math.max(1, Math.ceil((heightPx * published.width) / published.height));
  return {sizes: `${width}px`, slotWidth: () => width};
}

/**
 * A logo: an `<img>` drawn at a fixed height with its width following its
 * aspect ratio, so it is never stretched (UX §09); the stylesheet sets the
 * height from the class.
 */
export function renderLogoBlock(logo: ResolvedLogo, context: BlockContext, options: LogoOptions): string {
  const published = publishedImage(context, logo.asset.path);
  const attributes = attribute('class', options.className) + attribute('alt', logo.alt) + (options.firstView ? '' : attribute('loading', 'lazy'));
  return imageElement(published, attributes, logoSlot(published, options.heightPx));
}

// ---------------------------------------------------------------------------
// Chart

const CHART_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;

function assertChartId(id: string): void {
  // Ids beginning `slide-` belong to the deck's slide articles (D54(e), CONTRACT §2).
  if (!CHART_ID.test(id) || id.startsWith('slide-')) {
    throw new Error(`E_INTERNAL: ${JSON.stringify(id)} cannot be a chart id`);
  }
}

function tableOf(data: DataAsset): CsvTable {
  if (!data.csv.ok) {
    throw new Error(`E_INTERNAL: ${data.path} did not parse, so nothing may be drawn from it`);
  }
  return data.csv.table;
}

/** The last segment of a path, for messages. */
function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * The `renderChart` input for a resolved chart. The build's R13 stage and the
 * chart block both draw through it, so what is checked is what is drawn.
 */
export function chartInput(chart: ResolvedChart, id: string, language: Language): ChartInput {
  assertChartId(id);
  return {
    id,
    type: chart.type,
    ...(chart.orientation === null ? {} : {orientation: chart.orientation}),
    table: tableOf(chart.data),
    x: chart.x,
    y: chart.y,
    ...(chart.series === null ? {} : {series: chart.series}),
    summary: chart.summary,
    locale: language,
    dataName: fileName(chart.data.path),
  };
}

export type FigureOptions = {
  /** The figure's id prefix: a letter, then letters, digits, `-` or `_`, never `slide-`. */
  readonly id: string;
  /** The element that names a table region when the block has no caption, such as the slide title. */
  readonly labelledBy: string;
};

/**
 * A chart block: the chart SVG drawn at build time (IC03), scaled to its
 * figure (D64), then the author's summary in small muted text, the caption and
 * the source, and the data as a table when `show_table` is set. The SVG is
 * named by the summary (D44), so the visible copy beneath it is hidden from
 * assistive technology, which would otherwise read the sentence twice.
 */
export function renderChartBlock(chart: ResolvedChart, context: BlockContext, options: FigureOptions): string {
  const drawn = renderChart(chartInput(chart, options.id, context.language));
  if (drawn.svg === null) {
    throw new Error(`E_INTERNAL: the chart at ${chart.pointer} has problems and cannot be drawn`);
  }
  const captionId = `${options.id}-caption`;
  const caption = figureCaption([
    `<p class="chart-summary" aria-hidden="true">${escapeHtml(chart.summary)}</p>`,
    chart.caption === null ? '' : `<div class="figure-text"${attribute('id', captionId)}>${joinBlockHtml(renderTextBlock(chart.caption, context))}</div>`,
    metaLine('figure-source', chart.source),
  ]);
  const figure = `<figure class="chart-figure"><div class="chart-frame">${drawn.svg.replace(/\n+$/, '')}</div>${caption}</figure>`;
  if (!chart.showTable) {
    return figure;
  }
  const columns: ResolvedTableColumn[] = [chart.x, ...(chart.series === null ? [] : [chart.series]), chart.y].map((field) => ({field, label: field}));
  const table = renderTableBlock(
    {pointer: chart.pointer, data: chart.data, columns, caption: null, source: null},
    context,
    {id: `${options.id}-data`, labelledBy: chart.caption === null ? options.labelledBy : captionId},
  );
  return `${figure}${table}`;
}

// ---------------------------------------------------------------------------
// Table

/**
 * A table block in the kit's table markup: a focusable scrolling region named
 * from author text, never from an English label (the caption when there is
 * one, else the element the caller names, such as the slide title); header
 * cells with `scope="col"`; the columns the author picked, in their order and
 * under their labels; cells as their source text, escaped; an empty cell as an
 * em dash hidden from assistive technology beside the localized `empty_cell`
 * label (IC03). Number columns align right.
 */
export function renderTableBlock(table: ResolvedTable, context: BlockContext, options: FigureOptions): string {
  const csv = tableOf(table.data);
  const columns = (table.columns ?? csv.columns.map((column) => ({field: column.name, label: column.name}))).map((column) => {
    const index = csv.columns.findIndex((candidate) => candidate.name === column.field);
    if (index === -1) {
      // R13 reports a column the CSV does not have; a renderer never sees one.
      throw new Error(`E_INTERNAL: ${table.data.path} has no column ${JSON.stringify(column.field)}`);
    }
    return {index, label: column.label, numeric: csv.columns[index]!.type === 'number'};
  });
  const numeric = (column: {numeric: boolean}): string => (column.numeric ? ' class="num"' : '');
  const empty = `<span aria-hidden="true">—</span><span class="sr-only">${escapeHtml(context.strings.empty_cell)}</span>`;
  const head = columns.map((column) => `<th scope="col"${numeric(column)}>${escapeHtml(column.label)}</th>`).join('');
  const body = csv.rows
    .map((row) => {
      const cells = columns.map((column) => {
        const text = row[column.index] ?? '';
        return `<td${numeric(column)}>${text.trim() === '' ? empty : escapeHtml(text)}</td>`;
      });
      return `<tr>${cells.join('')}</tr>`;
    })
    .join('');
  const captionId = `${options.id}-caption`;
  const caption = table.caption === null ? '' : figureCaption([joinBlockHtml(renderTextBlock(table.caption, context))], captionId);
  const region =
    `<div class="table-wrap" tabindex="0" role="region"${attribute('aria-labelledby', table.caption === null ? options.labelledBy : captionId)}>` +
    `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  return `<figure class="table-figure">${caption}${region}${metaLine('figure-source', table.source)}</figure>`;
}

// ---------------------------------------------------------------------------
// Quote, note and callout (M3.2, D97)

/** A text field's HTML with no line break between its blocks. */
function blockText(text: ResolvedText, context: BlockContext): string {
  return joinBlockHtml(renderTextBlock(text, context));
}

/**
 * A quote: the author's text in the kit's `blockquote` (Poppins 500 on a cyan
 * rail, D90), inside a figure whose caption is the attribution in small text,
 * so the quotation holds only the words quoted.
 */
export function renderQuoteBlock(text: ResolvedText, attribution: string | null, context: BlockContext): string {
  const caption = attribution === null ? '' : `<figcaption class="quote-attribution">${escapeHtml(attribution)}</figcaption>`;
  return `<figure class="quote-figure"><blockquote>${blockText(text, context)}</blockquote>${caption}</figure>`;
}

/**
 * A note: the kit's `.note`, or `.note.warning` on the warning rail, opened by
 * its localized label (`note_label`, `warning_label`), which says what the
 * block is in words and not only by its colour (UX §09).
 */
export function renderNoteBlock(text: ResolvedText, tone: 'default' | 'warning', context: BlockContext): string {
  const label = tone === 'warning' ? context.strings.warning_label : context.strings.note_label;
  return `<div class="${tone === 'warning' ? 'note warning' : 'note'}" role="note"><strong class="note-label">${escapeHtml(label)}</strong>${blockText(text, context)}</div>`;
}

/** A callout: a pull statement in the display face on the ground colour, the kit's `.doc-callout`. */
export function renderCalloutBlock(text: ResolvedText, context: BlockContext): string {
  return `<div class="doc-callout">${blockText(text, context)}</div>`;
}

// ---------------------------------------------------------------------------
// Video (M3.2, IC04, D07)

/** Where a block can stand; a video only in a document's section (D07, C07). */
export type VideoContainer = 'section' | 'slide' | 'page' | 'detail';

export type VideoOptions = {
  /** The figure's id prefix: a letter, then letters, digits, `-` or `_`. */
  readonly id: string;
  readonly container: VideoContainer;
  /** The slot the video fills, which chooses the poster's one file. */
  readonly slot: ImageSlot;
};

/**
 * The one file a video's poster names: `poster` takes a single URL, with no
 * `srcset` and no AVIF alternative, so a raster poster is its narrowest WebP
 * derivative at least as wide as the slot is at its widest, else its widest
 * one; a vector poster is its file. Returned as a published image holding
 * only that file, so the budget counts exactly what the page names (IC04).
 */
export function posterImage(published: PublishedImage, slotWidth: number): PublishedImage {
  if (published.kind === 'vector') {
    return published;
  }
  const webp = derivativesOf(published, 'webp');
  const chosen = webp.find((derivative) => derivative.width >= slotWidth) ?? webp.at(-1);
  if (chosen === undefined) {
    throw new Error('E_INTERNAL: a published poster has no WebP derivative');
  }
  return {kind: 'raster', width: published.width, height: published.height, derivatives: [chosen]};
}

/** The URL of a poster that `posterImage` narrowed to one file. */
function posterUrl(poster: PublishedImage): string {
  return urlPath(poster.kind === 'vector' ? poster.file.path : poster.derivatives[0]!.path);
}

/**
 * A video block (IC04): the native player with its controls, muted and
 * looping, playing inline, loading nothing until the reader presses Play
 * (`preload="none"`), never on its own (no `autoplay`, no script). The
 * poster shows before Play and in print, where the player is replaced by the
 * same image; the author's alternative is visible text beneath it and the
 * player's description, then the caption, credit and rights. Refused
 * anywhere but a document's section (D07).
 */
export function renderVideoBlock(video: ResolvedVideo, context: BlockContext, options: VideoOptions): string {
  if (options.container !== 'section') {
    throw new Error(`E_INTERNAL: a video cannot stand in a ${options.container}; video is allowed only in a document's sections (D07, C07)`);
  }
  if (!CHART_ID.test(options.id)) {
    throw new Error(`E_INTERNAL: ${JSON.stringify(options.id)} cannot be a video id`);
  }
  const published = publishedImage(context, video.poster.path);
  const poster = posterImage(published, options.slot.slotWidth(Number.MAX_SAFE_INTEGER));
  const size = attribute('width', published.width) + attribute('height', published.height);
  const altId = `${options.id}-alt`;
  const player =
    `<video controls muted loop playsinline preload="none"${attribute('poster', posterUrl(poster))}${size}` +
    `${attribute('aria-describedby', altId)}${attribute('src', urlPath(video.asset.path))}></video>`;
  const printed = `<img class="video-print-poster"${attribute('src', posterUrl(poster))} alt=""${size}>`;
  const caption = figureCaption([
    `<p class="video-alt"${attribute('id', altId)}>${escapeHtml(video.alt)}</p>`,
    video.caption === null ? '' : `<div class="figure-text">${blockText(video.caption, context)}</div>`,
    metaLine('figure-credit', video.credit),
    metaLine('figure-rights', video.rights),
  ]);
  return `<figure class="video-figure">${player}${printed}${caption}</figure>`;
}
