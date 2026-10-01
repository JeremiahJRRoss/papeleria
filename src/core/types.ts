/**
 * Types shared by the core: the typed manifest for each template, the IO
 * boundary through which every piece file is read, and the immutable `Piece`
 * the renderers receive.
 *
 * The manifest types mirror `templates/<name>/schema.json`; a value reaches
 * them only after `validateManifest` accepted it. Field names stay snake_case
 * as the author wrote them. The resolved `Piece` uses camelCase for derived
 * values and carries every author string it needs, so a renderer never reads a
 * file (architecture §4; D152).
 */
import type {CsvResult} from './csv.js';
import type {AssetProblem} from './finding.js';
import type {ImageProbeResult, RasterFormat} from './images.js';
import type {SourceMap} from './positions.js';

export type TemplateName = 'deck' | 'comic' | 'document';
export type Language = 'en' | 'es';
export type Status = 'draft' | 'review' | 'published' | 'withheld';
export type ManifestFile = 'papeleria.yaml' | 'papeleria.json';
export type ManifestFormat = 'yaml' | 'json';

export const LAYOUT_NAMES = [
  'cover',
  'statement',
  'closing',
  'two',
  'three',
  'four',
  'chart',
  'image',
  'attributes',
  'palette',
  'type',
  'wordmark',
] as const;
export type LayoutName = (typeof LAYOUT_NAMES)[number];

/** How many columns each layout takes (ERD LAYOUT); absent means none. */
export const LAYOUT_COLUMNS: Readonly<Partial<Record<LayoutName, 2 | 3 | 4>>> = Object.freeze({
  two: 2,
  three: 3,
  four: 4,
});

/** The output control strings, UX section 12 and the ERD UI_STRING row, in table order (34 since D161, 37 since D130 and D131). */
export const STRING_KEYS = [
  'skip',
  'previous',
  'next',
  'slide_of',
  'all_shown',
  'all_shown_one',
  'show_all',
  'show_one',
  'show_notes',
  'hide_notes',
  'notes_label',
  'notes_heading',
  'fullscreen',
  'fullscreen_denied',
  'print',
  'page_of',
  'pages_of',
  'panel_of',
  'guided_view',
  'page_view',
  'detail',
  'close',
  'transcript',
  'panels_hint',
  'panels_hint_one',
  'no_js',
  'no_js_slides',
  'format_comics',
  'status_draft',
  'status_review',
  'status_published',
  'status_withheld',
  'note_label',
  'warning_label',
  'doc_type_default',
  'empty_cell',
  'external_link',
] as const;
export type StringKey = (typeof STRING_KEYS)[number];
export type UiStrings = Readonly<Record<StringKey, string>>;

/** Where the wordmark text came from: the manifest, the owner's `brand/brand.json`, or the theme default. */
export type BrandSettings = {readonly wordmark: string; readonly source: 'manifest' | 'owner' | 'theme'};

/** What a navigation link is, once the IC02 policy has accepted it. */
export type LinkKind = 'external' | 'mail' | 'phone' | 'relative' | 'fragment';

// ---------------------------------------------------------------------------
// Typed manifest, as validated by the template schemas.

export type Credit = {readonly role: string; readonly name: string};

export type ImageBlock = {
  readonly src: string;
  readonly alt?: string;
  readonly decorative?: true;
  readonly caption?: string;
  readonly credit?: string;
  readonly rights?: string;
  readonly focal_point?: readonly [number, number];
};

export type VideoBlock = {
  readonly src: string;
  readonly poster: string;
  readonly alt: string;
  readonly caption?: string;
  readonly credit?: string;
  readonly rights?: string;
};

export type ChartBlock = {
  readonly type: 'bar' | 'line';
  readonly orientation?: 'vertical' | 'horizontal';
  readonly data: string;
  readonly x: string;
  readonly y: string;
  readonly series?: string;
  readonly summary: string;
  readonly show_table?: boolean;
  readonly caption?: string;
  readonly source?: string;
};

export type TableColumn = string | {readonly field: string; readonly label?: string};

export type TableBlock = {
  readonly data: string;
  readonly columns?: readonly TableColumn[];
  readonly caption?: string;
  readonly source?: string;
};

export type QuoteBlock = {readonly text: string; readonly attribution?: string};
export type NoteBlock = {readonly text: string; readonly tone?: 'default' | 'warning'};
export type CalloutBlock = {readonly text: string};
export type LogoBlock = {readonly src: string; readonly alt: string};

export type Block =
  | {readonly text: string}
  | {readonly image: ImageBlock}
  | {readonly video: VideoBlock}
  | {readonly chart: ChartBlock}
  | {readonly table: TableBlock}
  | {readonly quote: QuoteBlock}
  | {readonly note: NoteBlock}
  | {readonly callout: CalloutBlock}
  | {readonly logo: LogoBlock};

export type BlockKind = 'text' | 'image' | 'video' | 'chart' | 'table' | 'quote' | 'note' | 'callout' | 'logo';

export type Column = {readonly heading: string; readonly text: string};
export type Item = {readonly label: string; readonly text: string};
export type Swatch = {readonly name: string; readonly value: string; readonly use?: string};

export type Slide = {
  readonly layout: LayoutName;
  readonly title: string;
  readonly lead?: string;
  readonly footer?: string;
  readonly notes?: string;
  readonly columns?: readonly Column[];
  readonly chart?: ChartBlock;
  readonly table?: TableBlock;
  readonly image?: ImageBlock;
  readonly items?: readonly Item[];
  readonly swatches?: readonly Swatch[];
};

export type Detail =
  | {readonly zoom: true}
  | {readonly text: string}
  | {readonly image: ImageBlock}
  | {readonly href: string; readonly label: string};

export type PanelBox = readonly [number, number, number, number];

export type Panel = {readonly box: PanelBox; readonly transcript: string; readonly detail?: Detail};

export type Page = {
  readonly image: string;
  readonly alt: string;
  readonly credit?: string;
  readonly rights?: string;
  readonly panels?: readonly Panel[];
};

export type MetadataItem = {readonly label: string; readonly value: string};

export type Section = {readonly heading: string; readonly new_page?: boolean; readonly blocks: readonly Block[]};

type ManifestCommon = {
  readonly schema: 1;
  readonly title: string;
  readonly language?: Language;
  readonly status?: Status;
  readonly wordmark?: string;
  readonly credits?: readonly Credit[];
};

export type DeckManifest = ManifestCommon & {
  readonly template: 'deck';
  readonly register?: string;
  readonly edition?: string;
  readonly logo?: LogoBlock;
  readonly slides: readonly Slide[];
};

export type ComicManifest = ManifestCommon & {
  readonly template: 'comic';
  readonly format?: string;
  readonly pages: readonly Page[];
};

export type DocumentManifest = ManifestCommon & {
  readonly template: 'document';
  readonly doc_type?: string;
  readonly metadata?: readonly MetadataItem[];
  readonly sections: readonly Section[];
  readonly source_note?: string;
  readonly footer?: string;
};

export type Manifest = DeckManifest | ComicManifest | DocumentManifest;

// ---------------------------------------------------------------------------
// The IO boundary. Paths are piece-relative, written with forward slashes, and
// `''` is the piece folder itself.

export type FileKind = 'file' | 'directory' | 'symlink' | 'other';

export type FileStat = {readonly kind: FileKind; readonly bytes: number};

/** Thrown by `FileAccess.readText` when the bytes are not valid UTF-8. */
export class InvalidTextEncodingError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`${path} is not valid UTF-8`);
    this.name = 'InvalidTextEncodingError';
    this.path = path;
  }
}

/** Thrown by `FileAccess.readText` and `readBytes` when the file holds more bytes than the caller allows. */
export class FileTooLargeError extends Error {
  readonly path: string;
  readonly bytes: number;
  readonly limit: number;

  constructor(path: string, bytes: number, limit: number) {
    super(`${path} holds ${bytes} bytes; the limit is ${limit}`);
    this.name = 'FileTooLargeError';
    this.path = path;
    this.bytes = bytes;
    this.limit = limit;
  }
}

/**
 * Thrown by `FileAccess.readText` and `readBytes` when the file it opened is not the regular
 * file that was inspected inside the piece: a link appeared on the way, its
 * canonical path now leaves the piece, or it changed while it was read.
 */
export class FileChangedError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`${path} changed while it was read: ${reason}`);
    this.name = 'FileChangedError';
    this.path = path;
  }
}

export type ReadOptions = {
  /** Refuse, with `FileTooLargeError`, a file that holds more bytes than this when it is opened. */
  readonly maxBytes?: number;
};

/**
 * A tool file — strings, brand settings, schemas — is missing or malformed.
 * This is an installation or configuration failure, reported with its code
 * and exit 2 (IC05), never as a finding against the author's piece.
 */
export class ToolResourceError extends Error {
  readonly code = 'E_TOOL_RESOURCE';
  readonly file: string;

  constructor(file: string, message: string) {
    super(`${file}: ${message}`);
    this.name = 'ToolResourceError';
    this.file = file;
  }
}

/**
 * Reads piece files. Everything the core learns about the disk comes through
 * here, and it is the only way a piece file is read (D152, D155).
 */
/**
 * What one inspection run has learned, passed to `stat` by the `FileInspector`
 * that owns the run: the names in each folder, by the folder's absolute path,
 * so an exact-case check reads a folder once per run rather than once per file.
 * Nothing in it outlives the run, so an access the editor keeps for many runs
 * never answers from a stale listing (D152, D164).
 */
export type InspectionRun = {readonly listings: Map<string, Promise<ReadonlySet<string>>>};

export interface FileAccess {
  /**
   * `lstat` semantics: a symbolic link is reported as `symlink` and never
   * followed. Names match exactly, including case, on every platform, so a
   * piece behaves the same on a case-insensitive disk. `null` when absent.
   * Given a run, the exact-case check may use and add to what it has read; a
   * wrapper around an access passes `run` on.
   */
  stat(path: string, run?: InspectionRun): Promise<FileStat | null>;
  /**
   * The file as UTF-8 text with a leading byte-order mark removed. The file
   * opened must be the regular file inspected inside the piece, and it is read
   * with a bound. Throws `InvalidTextEncodingError`, `FileTooLargeError` or
   * `FileChangedError`.
   */
  readText(path: string, options?: ReadOptions): Promise<string>;
  /**
   * The file's bytes, opened and checked exactly as `readText` does. Throws
   * `FileTooLargeError` or `FileChangedError`.
   */
  readBytes(path: string, options?: ReadOptions): Promise<Uint8Array>;
  /** The canonical absolute path, used to confirm a file stays inside the piece. */
  realpath(path: string): Promise<string>;
}

/** A video's duration from W3B's `video.ts` (music-metadata), in seconds. */
export type VideoProbe = {readonly duration: number};

/** A video reader's result; its problems belong to R16 (D157). */
export type VideoProbeResult = {readonly ok: true; readonly probe: VideoProbe} | {readonly ok: false; readonly problem: AssetProblem};

/**
 * File access plus the readers that turn a file's content into data (D158).
 * Each reader is the function of the module that owns the format, used as it
 * is: `csv.ts` `parseCsv`, `images.ts` `probeImage` and, from M3.4, W3B's video
 * probe. Resolve reads every file through the file access and hands the
 * readers its content, so a reader never touches the piece.
 */
export interface Loaders extends FileAccess {
  parseCsv(text: string): CsvResult;
  probeImage(bytes: Uint8Array): Promise<ImageProbeResult>;
  probeVideo(bytes: Uint8Array): Promise<VideoProbeResult>;
}


// ---------------------------------------------------------------------------
// The resolved piece. Every object and array is frozen.

/** Where a slide, page, panel or section sits in the manifest (IC06 `SourceTarget`). */
export type SourceLines = {readonly file: string; readonly lineStart: number; readonly lineEnd: number};

/**
 * A title or lead: inline Markdown only, rendered without block structure.
 * `text` is the same words as plain text, for a page title, an `aria-label` or
 * a string placeholder: the text and code the HTML shows, one space for each
 * line break, no external-link mark or hint. It is not escaped; a renderer
 * escapes it like any plain string.
 */
export type InlineText = {readonly pointer: string; readonly markdown: string; readonly html: string; readonly text: string};

/** A text field: Markdown written in the manifest or loaded from `assets/text/`. */
export type ResolvedText = {
  readonly pointer: string;
  readonly origin: 'inline' | 'file';
  /** The `assets/text/…` path when the text came from a file. */
  readonly path: string | null;
  readonly markdown: string;
  /** Rendered with headings rebased so `#` becomes `h{baseLevel}`. */
  readonly html: string;
  readonly baseLevel: number;
};

/** A raster's format is what its bytes are (D160); SVG is the vector format. */
export type ImageFormat = RasterFormat | 'svg';

/** A raster image, whose format is what its bytes are (D160). */
export type RasterImageAsset = {
  readonly path: string;
  readonly kind: 'raster';
  readonly format: RasterFormat;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
};

/**
 * An SVG that passed the IC02 profile. `markup` is the text that was validated;
 * the build publishes it as it is and never reads the file again, so what is
 * published is what was checked (IC02, D164). `width` and `height` are the
 * viewBox rounded to whole pixels, for markup; `viewBox` is exact.
 */
export type VectorImageAsset = {
  readonly path: string;
  readonly kind: 'vector';
  readonly format: 'svg';
  readonly width: number;
  readonly height: number;
  readonly viewBox: readonly [number, number, number, number];
  readonly bytes: number;
  readonly markup: string;
};

export type ImageAsset = RasterImageAsset | VectorImageAsset;

export type TextAsset = {readonly path: string; readonly bytes: number; readonly markdown: string};

/**
 * A CSV as parsed. Resolve reports the problems whose rule is R09 (the row
 * limit); R13 problems are kept for the R13 rule, which knows how the data is used.
 */
export type DataAsset = {readonly path: string; readonly bytes: number; readonly csv: CsvResult};

/** A video as probed. Duration problems are R16 and reported by W3B's rule. */
export type VideoAsset = {readonly path: string; readonly bytes: number; readonly probe: VideoProbeResult};

export type ResolvedImage = {
  readonly pointer: string;
  readonly asset: ImageAsset;
  readonly alt: string | null;
  readonly decorative: boolean;
  readonly caption: ResolvedText | null;
  readonly credit: string | null;
  readonly rights: string | null;
  /** x and y in percent; `[50, 50]` when the author gave none. */
  readonly focalPoint: readonly [number, number];
};

export type ResolvedLogo = {readonly pointer: string; readonly asset: ImageAsset; readonly alt: string};

export type ResolvedVideo = {
  readonly pointer: string;
  readonly asset: VideoAsset;
  readonly poster: ImageAsset;
  readonly alt: string;
  readonly caption: ResolvedText | null;
  readonly credit: string | null;
  readonly rights: string | null;
};

export type ResolvedChart = {
  readonly pointer: string;
  readonly type: 'bar' | 'line';
  /** `vertical` by default for a bar chart; always null for a line chart. */
  readonly orientation: 'vertical' | 'horizontal' | null;
  readonly data: DataAsset;
  readonly x: string;
  readonly y: string;
  readonly series: string | null;
  readonly summary: string;
  readonly showTable: boolean;
  readonly caption: ResolvedText | null;
  readonly source: string | null;
};

export type ResolvedTableColumn = {readonly field: string; readonly label: string};

export type ResolvedTable = {
  readonly pointer: string;
  readonly data: DataAsset;
  /** The picked columns, labels defaulted to the field; null means every column in file order. */
  readonly columns: readonly ResolvedTableColumn[] | null;
  readonly caption: ResolvedText | null;
  readonly source: string | null;
};

type BlockBase = {readonly pointer: string; readonly position: number};

export type ResolvedBlock =
  | (BlockBase & {readonly kind: 'text'; readonly text: ResolvedText})
  | (BlockBase & {readonly kind: 'image'; readonly image: ResolvedImage})
  | (BlockBase & {readonly kind: 'video'; readonly video: ResolvedVideo})
  | (BlockBase & {readonly kind: 'chart'; readonly chart: ResolvedChart})
  | (BlockBase & {readonly kind: 'table'; readonly table: ResolvedTable})
  | (BlockBase & {readonly kind: 'quote'; readonly text: ResolvedText; readonly attribution: string | null})
  | (BlockBase & {readonly kind: 'note'; readonly text: ResolvedText; readonly tone: 'default' | 'warning'})
  | (BlockBase & {readonly kind: 'callout'; readonly text: ResolvedText})
  | (BlockBase & {readonly kind: 'logo'; readonly logo: ResolvedLogo});

export type ResolvedColumn = {
  readonly pointer: string;
  readonly position: number;
  readonly heading: string;
  readonly text: ResolvedText;
};

export type ResolvedSlide = {
  readonly pointer: string;
  /** Position from 1; deep link `#slide-N`. */
  readonly number: number;
  readonly source: SourceLines;
  readonly layout: LayoutName;
  readonly title: InlineText;
  readonly lead: InlineText | null;
  /** The slide's own footer, else the deck's edition, else null. */
  readonly footer: string | null;
  readonly notes: ResolvedText | null;
  readonly columns: readonly ResolvedColumn[];
  readonly chart: ResolvedChart | null;
  readonly table: ResolvedTable | null;
  readonly image: ResolvedImage | null;
  readonly items: readonly Item[];
  readonly swatches: readonly Swatch[];
};

export type ResolvedDetail =
  | {readonly pointer: string; readonly kind: 'zoom'}
  | {readonly pointer: string; readonly kind: 'text'; readonly text: ResolvedText}
  | {readonly pointer: string; readonly kind: 'image'; readonly image: ResolvedImage}
  | {
      readonly pointer: string;
      readonly kind: 'link';
      /**
       * The address, or null when `classifyLink` refused it: resolve reports
       * that as R09 and keeps only the label, as a refused Markdown link keeps
       * only its text, so no renderer can write it (security audit F17).
       */
      readonly href: string | null;
      readonly label: string;
      readonly link: LinkKind;
    };

export type ResolvedPanel = {
  readonly pointer: string;
  /** Reading order from 1; deep link `#page-N-panel-M`. */
  readonly number: number;
  readonly source: SourceLines;
  readonly box: PanelBox;
  readonly transcript: string;
  readonly detail: ResolvedDetail | null;
};

export type ResolvedPage = {
  readonly pointer: string;
  /** Position from 1; deep link `#page-N`. */
  readonly number: number;
  readonly source: SourceLines;
  readonly image: ImageAsset;
  readonly alt: string;
  readonly credit: string | null;
  readonly rights: string | null;
  readonly panels: readonly ResolvedPanel[];
};

export type ResolvedSection = {
  readonly pointer: string;
  readonly number: number;
  readonly source: SourceLines;
  readonly heading: string;
  /** IC07 slug, unique within the document; deep link `#slug`, URL-encoded in an href. */
  readonly slug: string;
  readonly newPage: boolean;
  readonly blocks: readonly ResolvedBlock[];
};

export type PieceAssets = {
  readonly texts: Readonly<Record<string, TextAsset>>;
  readonly images: Readonly<Record<string, ImageAsset>>;
  readonly data: Readonly<Record<string, DataAsset>>;
  readonly videos: Readonly<Record<string, VideoAsset>>;
};

type PieceCommon = {
  readonly manifestFile: ManifestFile;
  readonly format: ManifestFormat;
  readonly sourceMap: SourceMap;
  readonly title: InlineText;
  readonly language: Language;
  readonly status: Status;
  /** The localized status label, `status_<status>` from the strings. */
  readonly statusLabel: string;
  readonly credits: readonly Credit[];
  readonly brand: BrandSettings;
  readonly strings: UiStrings;
  /** Every file the piece reads, keyed by its piece-relative path, each once. */
  readonly assets: PieceAssets;
};

export type DeckPiece = PieceCommon & {
  readonly template: 'deck';
  readonly manifest: DeckManifest;
  readonly register: string | null;
  readonly edition: string | null;
  readonly logo: ResolvedLogo | null;
  readonly slides: readonly ResolvedSlide[];
};

export type ComicPiece = PieceCommon & {
  readonly template: 'comic';
  readonly manifest: ComicManifest;
  /** The register label: the manifest's `format`, else the localized `format_comics`. */
  readonly formatLabel: string;
  readonly pages: readonly ResolvedPage[];
};

export type DocumentPiece = PieceCommon & {
  readonly template: 'document';
  readonly manifest: DocumentManifest;
  /** The header label: the manifest's `doc_type`, else the localized `doc_type_default`. */
  readonly docType: string;
  readonly metadata: readonly MetadataItem[];
  readonly sections: readonly ResolvedSection[];
  readonly sourceNote: ResolvedText | null;
  readonly footer: string | null;
};

export type Piece = DeckPiece | ComicPiece | DocumentPiece;
