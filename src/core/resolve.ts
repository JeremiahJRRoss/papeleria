/**
 * M1.3: resolving a validated manifest into an immutable `Piece`.
 *
 * Every file the manifest names is inspected and read through the injected
 * `Loaders` file access — the only IO boundary — so resolve runs the same
 * against the disk, the editor's overlays or an in-memory test piece. What is
 * read goes to the reader that owns its format, as content (D155, D158): SVG
 * to the bounded profile, raster bytes to `probeImage`, CSV text to `parseCsv`,
 * video bytes to the video reader. A text value is a file reference exactly
 * when C05 says so; every other value is Markdown written in the manifest.
 * Content problems whose rule is R09 are reported here; R13 (CSV) and R16
 * (video) problems are kept in the piece for the rules that own them.
 *
 * A problem is reported where the author can act on it: an absent file (R02)
 * and an unsafe path (R09) at the manifest token that names it; a file too
 * large, not UTF-8, refused by its reader or outside the SVG profile (R09) at
 * the file, with the reader's own message and fix and the naming token as the
 * related location. The `Piece` is returned only
 * when resolve found no error; renderers never see a partial piece (D152).
 */
import {Buffer} from 'node:buffer';

import {FileChangedError, FileTooLargeError, InvalidTextEncodingError} from './types.js';
import {loadBrandFiles, resolveBrand, type BrandFiles} from './brand.js';
import {globalLocation, hasErrors, settleFindings, traced, type AssetProblem, type Finding, type Location, type TracedFinding} from './finding.js';
import {deepFreeze} from './freeze.js';
import {INPUT_LIMITS, mebibytes} from './limits.js';
import {loadManifest} from './manifest.js';
import {classifyLink, renderInlineMarkdown, renderMarkdown, type MarkdownIssue, type MarkdownOptions, type MarkdownResult} from './markdown.js';
import {FileInspector, checkAssetPath, isTextFileReference, locateToolRoot, quoteForMessage, type AssetKind} from './paths.js';
import {joinPointer, nearestEntry} from './positions.js';
import {validateManifest, type ValidatedManifest} from './schema.js';
import {loadStrings} from './strings.js';
import {validateSvg} from './svg.js';
import {
  type Block,
  type ChartBlock,
  type ComicManifest,
  type ComicPiece,
  type DataAsset,
  type DeckManifest,
  type DeckPiece,
  type Detail,
  type DocumentManifest,
  type DocumentPiece,
  type ImageAsset,
  type ImageBlock,
  type ImageFormat,
  type InlineText,
  type Language,
  type Loaders,
  type LogoBlock,
  type Piece,
  type ResolvedBlock,
  type ResolvedChart,
  type ResolvedDetail,
  type ResolvedImage,
  type ResolvedLogo,
  type ResolvedTable,
  type ResolvedText,
  type ResolvedVideo,
  type SourceLines,
  type TableBlock,
  type TextAsset,
  type UiStrings,
  type VideoAsset,
  type VideoBlock,
} from './types.js';

// ---------------------------------------------------------------------------
// Slugs (IC07)

/**
 * One heading's slug: NFKD, combining marks removed, lower case, every run of
 * characters other than Unicode letters and digits turned into one hyphen,
 * hyphens trimmed, and `section` when nothing is left.
 */
export function slugify(heading: string): string {
  const slug = heading
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'section' : slug;
}

/**
 * Slugs for a document's headings in source order. A repeated slug takes -2,
 * -3 and so on, skipping any suffix already taken, so every slug is unique
 * even when a heading's own slug looks like a suffixed one (D153). `reserved`
 * names ids the page already uses, which a section may not take.
 */
export function assignSlugs(headings: readonly string[], options: {reserved?: Iterable<string>} = {}): string[] {
  const used = new Set<string>(options.reserved ?? []);
  return headings.map((heading) => {
    const base = slugify(heading);
    let slug = base;
    for (let suffix = 2; used.has(slug); suffix += 1) {
      slug = `${base}-${suffix}`;
    }
    used.add(slug);
    return slug;
  });
}

// ---------------------------------------------------------------------------
// Context

export type ResolveContext = {
  readonly loaders: Loaders;
  /** The tool root holding templates/ and theme/; defaults to the installed package. */
  readonly toolRoot?: string;
  /** Control strings per language; defaults to templates/shared/strings.<language>.json. */
  readonly strings?: Partial<Readonly<Record<Language, UiStrings>>>;
  /** Brand settings; defaults to theme/brand.default.json and an optional brand/brand.json. */
  readonly brand?: BrandFiles;
};

export type ResolveResult = {readonly piece: Piece | null; readonly findings: readonly TracedFinding[]};

// ---------------------------------------------------------------------------
// Asset loading. A load never reports; the caller reports at the reference.

type Failure =
  | {readonly kind: 'missing'; readonly at: string; readonly blockedBy: 'file' | 'other' | null}
  | {readonly kind: 'symlink' | 'folder' | 'special' | 'outside' | 'changed'; readonly at: string}
  | {readonly kind: 'size'; readonly bytes: number; readonly limit: number}
  | {readonly kind: 'encoding'}
  | {readonly kind: 'content'; readonly problems: readonly AssetProblem[]}
  | {readonly kind: 'svg'; readonly problems: readonly {message: string; fix: string; line: number | null; column: number | null}[]};

type Load<T> = {readonly ok: true; readonly value: T} | {readonly ok: false; readonly failure: Failure};

const NOUNS: Readonly<Record<AssetKind, string>> = {
  text: 'Markdown file',
  image: 'image',
  logo: 'logo',
  data: 'CSV file',
  video: 'video',
};

function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

function imageFormat(path: string): ImageFormat {
  const extension = path.slice(path.lastIndexOf('.') + 1);
  return extension === 'jpg' || extension === 'jpeg' ? 'jpeg' : (extension as ImageFormat);
}

class Resolver {
  readonly findings: TracedFinding[] = [];
  readonly texts: Record<string, TextAsset> = {};
  readonly images: Record<string, ImageAsset> = {};
  readonly data: Record<string, DataAsset> = {};
  readonly videos: Record<string, VideoAsset> = {};

  readonly #manifest: ValidatedManifest;
  readonly #loaders: Loaders;
  readonly #inspector: FileInspector;
  readonly #strings: UiStrings;
  readonly #loads = new Map<string, Promise<Load<unknown>>>();
  /** Rendered text files, by heading level and path, for those whose HTML carries no field's ids. */
  readonly #renders = new Map<string, MarkdownResult>();
  /** Markdown bytes the text fields have taken so far, against the piece's limit (IC01, D164). */
  #markdownBytes = 0;

  constructor(manifest: ValidatedManifest, loaders: Loaders, strings: UiStrings) {
    this.#manifest = manifest;
    this.#loaders = loaders;
    this.#inspector = new FileInspector(loaders);
    this.#strings = strings;
  }

  get file(): string {
    return this.#manifest.file;
  }

  /** Where a manifest value starts. */
  at(pointer: string): Location {
    const entry = nearestEntry(this.#manifest.sourceMap, pointer)?.entry;
    return entry === undefined
      ? globalLocation(this.file)
      : {file: this.file, line: entry.value.start.line, column: entry.value.start.column};
  }

  lines(pointer: string): SourceLines {
    const entry = this.#manifest.sourceMap.get(pointer);
    if (entry === undefined) {
      // Every value the manifest holds has an entry; a missing one is a defect, not line 1.
      throw new Error(`E_INTERNAL: no source position for ${pointer}`);
    }
    return {file: this.file, lineStart: entry.value.start.line, lineEnd: entry.value.end.line};
  }

  // -- loading ---------------------------------------------------------------

  #cached<T>(key: string, load: () => Promise<Load<T>>): Promise<Load<T>> {
    let promise = this.#loads.get(key) as Promise<Load<T>> | undefined;
    if (promise === undefined) {
      promise = load();
      this.#loads.set(key, promise);
    }
    return promise;
  }

  async #inspect(path: string, limit: number): Promise<Load<number>> {
    const inspection = await this.#inspector.inspect(path);
    if (!inspection.ok) {
      switch (inspection.reason) {
        case 'not-a-file': {
          const stat = await this.#inspector.stat(inspection.at);
          return {ok: false, failure: {kind: stat?.kind === 'directory' ? 'folder' : 'special', at: inspection.at}};
        }
        case 'not-a-folder': {
          const stat = await this.#inspector.stat(inspection.at);
          return {ok: false, failure: {kind: 'missing', at: inspection.at, blockedBy: stat?.kind === 'file' ? 'file' : 'other'}};
        }
        case 'missing':
          return {ok: false, failure: {kind: 'missing', at: inspection.at, blockedBy: null}};
        case 'symlink':
          return {ok: false, failure: {kind: 'symlink', at: inspection.at}};
        case 'outside-piece':
          return {ok: false, failure: {kind: 'outside', at: inspection.at}};
      }
    }
    if (inspection.bytes > limit) {
      return {ok: false, failure: {kind: 'size', bytes: inspection.bytes, limit}};
    }
    return {ok: true, value: inspection.bytes};
  }

  /** Reads a file inspected a moment ago; the size limit is checked again on the file actually opened. */
  async #readText(path: string, limit: number): Promise<Load<string>> {
    try {
      return {ok: true, value: await this.#loaders.readText(path, {maxBytes: limit})};
    } catch (error) {
      if (error instanceof InvalidTextEncodingError) {
        return {ok: false, failure: {kind: 'encoding'}};
      }
      if (error instanceof FileTooLargeError) {
        return {ok: false, failure: {kind: 'size', bytes: error.bytes, limit}};
      }
      if (error instanceof FileChangedError) {
        return {ok: false, failure: {kind: 'changed', at: path}};
      }
      throw error;
    }
  }

  /** Reads a file inspected a moment ago as bytes, with the same checks as `#readText`. */
  async #readBytes(path: string, limit: number): Promise<Load<Uint8Array>> {
    try {
      return {ok: true, value: await this.#loaders.readBytes(path, {maxBytes: limit})};
    } catch (error) {
      if (error instanceof FileTooLargeError) {
        return {ok: false, failure: {kind: 'size', bytes: error.bytes, limit}};
      }
      if (error instanceof FileChangedError) {
        return {ok: false, failure: {kind: 'changed', at: path}};
      }
      throw error;
    }
  }

  loadText(path: string): Promise<Load<TextAsset>> {
    return this.#cached(`text:${path}`, async () => {
      const inspected = await this.#inspect(path, INPUT_LIMITS.textBytes);
      if (!inspected.ok) {
        return inspected;
      }
      const text = await this.#readText(path, INPUT_LIMITS.textBytes);
      if (!text.ok) {
        return text;
      }
      const asset: TextAsset = {path, bytes: inspected.value, markdown: text.value};
      this.texts[path] = asset;
      return {ok: true, value: asset};
    });
  }

  /**
   * Counts a text field's Markdown against the piece's limit. A file counts
   * once for each field that names it, since the page publishes it once for
   * each; one 5 MiB file named from a small manifest could otherwise take
   * minutes and all the memory there is. The field that passes the limit is
   * R09, and no text field is rendered after it. True while within the limit.
   */
  admitMarkdown(bytes: number, pointer: string): boolean {
    const limit = INPUT_LIMITS.pieceMarkdownBytes;
    if (this.#markdownBytes > limit) {
      return false;
    }
    this.#markdownBytes += bytes;
    if (this.#markdownBytes <= limit) {
      return true;
    }
    this.#add(
      'R09',
      this.at(pointer),
      `${this.file}#${pointer}`,
      `With this field the piece's text reaches ${mebibytes(this.#markdownBytes)} of Markdown; a piece is limited to ${mebibytes(limit)}, counting a text file once for each field that names it.`,
      'Name a long text file from fewer fields, or split the piece.',
      `Input limit: ${formatNumber(limit)} bytes of Markdown in a piece's text fields (IC01).`,
    );
    return false;
  }

  /**
   * A text file rendered for one field. Only footnote ids differ between the
   * fields that name one file (D150), so a file without footnotes is rendered
   * once per heading level and those fields share the result; before, 25
   * fields naming a 1 MiB file rendered it 25 times and held 25 copies of its
   * HTML. A footnoted file is still rendered for each field. The issues are
   * the same either way, and each field still reports them.
   */
  renderText(asset: TextAsset, options: MarkdownOptions): MarkdownResult {
    const key = `${options.baseLevel}:${asset.path}`;
    const shared = this.#renders.get(key);
    if (shared !== undefined) {
      return shared;
    }
    const rendered = renderMarkdown(asset.markdown, options);
    if (!rendered.fieldIds) {
      this.#renders.set(key, rendered);
    }
    return rendered;
  }

  loadImage(path: string): Promise<Load<ImageAsset>> {
    return this.#cached(`image:${path}`, async () => {
      const inspected = await this.#inspect(path, INPUT_LIMITS.mediaBytes);
      if (!inspected.ok) {
        return inspected;
      }
      const format = imageFormat(path);
      let asset: ImageAsset;
      if (format === 'svg') {
        const text = await this.#readText(path, INPUT_LIMITS.mediaBytes);
        if (!text.ok) {
          return text;
        }
        const svg = validateSvg(text.value);
        if (!svg.ok) {
          return {ok: false, failure: {kind: 'svg', problems: svg.problems}};
        }
        // The text checked is the text kept: the build publishes it and never reads the file again (IC02).
        asset = {path, kind: 'vector', format: 'svg', width: svg.width, height: svg.height, viewBox: svg.viewBox, bytes: inspected.value, markup: text.value};
      } else {
        const bytes = await this.#readBytes(path, INPUT_LIMITS.mediaBytes);
        if (!bytes.ok) {
          return bytes;
        }
        const probed = await this.#loaders.probeImage(bytes.value);
        if (!probed.ok) {
          return {ok: false, failure: {kind: 'content', problems: [probed.problem]}};
        }
        // The format is what the bytes are (D160); the size on disk is the inspection's.
        const {probe} = probed;
        asset = {path, kind: 'raster', format: probe.format, width: probe.width, height: probe.height, bytes: inspected.value};
      }
      this.images[path] = asset;
      return {ok: true, value: asset};
    });
  }

  loadData(path: string): Promise<Load<DataAsset>> {
    return this.#cached(`data:${path}`, async () => {
      const inspected = await this.#inspect(path, INPUT_LIMITS.textBytes);
      if (!inspected.ok) {
        return inspected;
      }
      const text = await this.#readText(path, INPUT_LIMITS.textBytes);
      if (!text.ok) {
        return text;
      }
      const csv = this.#loaders.parseCsv(text.value);
      // The row limit is an input limit (R09) and is reported here; R13 problems wait for the R13 rule (D158).
      const limits = csv.ok ? [] : csv.problems.filter((problem) => problem.rule === 'R09');
      if (limits.length > 0) {
        return {ok: false, failure: {kind: 'content', problems: limits}};
      }
      // The piece is frozen with a copy: the reader's own result is never frozen in place.
      const asset: DataAsset = {path, bytes: inspected.value, csv: structuredClone(csv)};
      this.data[path] = asset;
      return {ok: true, value: asset};
    });
  }

  loadVideo(path: string): Promise<Load<VideoAsset>> {
    return this.#cached(`video:${path}`, async () => {
      const inspected = await this.#inspect(path, INPUT_LIMITS.mediaBytes);
      if (!inspected.ok) {
        return inspected;
      }
      const bytes = await this.#readBytes(path, INPUT_LIMITS.mediaBytes);
      if (!bytes.ok) {
        return bytes;
      }
      // Duration problems belong to R16 and stay with the asset, as a copy the piece can freeze.
      const probe = await this.#loaders.probeVideo(bytes.value);
      const asset: VideoAsset = {path, bytes: inspected.value, probe: structuredClone(probe)};
      this.videos[path] = asset;
      return {ok: true, value: asset};
    });
  }

  // -- reporting -------------------------------------------------------------

  #add(rule: string, location: Location, sourcePath: string, message: string, fix: string, detail: string | null = null, relatedLocation?: Location): void {
    this.findings.push(traced({rule, message, fix, detail, location, sourcePath, ...(relatedLocation === undefined ? {} : {relatedLocation})}));
  }

  /** Reports a failed load: at the naming token for reference problems, at the file for content problems. */
  reportFailure(failure: Failure, kind: AssetKind, path: string, pointer: string): void {
    const reference = this.at(pointer);
    const token = `${this.file}#${pointer}`;
    const noun = NOUNS[kind];
    const shown = quoteForMessage(path);
    switch (failure.kind) {
      case 'missing':
        this.#add(
          'R02',
          reference,
          token,
          `The ${noun} ${shown} is missing.`,
          'Check the path and the file name, including upper and lower case; paths start with assets/.',
          failure.blockedBy === 'file'
            ? `${failure.at} is a file, not a folder.`
            : failure.blockedBy === 'other'
              ? `${failure.at} is not a folder.`
              : failure.at === path
                ? null
                : `Nothing exists at ${failure.at}.`,
        );
        return;
      case 'folder':
        this.#add('R02', reference, token, `The ${noun} ${shown} is a folder, not a file.`, 'Point the manifest at the file inside the folder.');
        return;
      case 'symlink':
        this.#add(
          'R09',
          reference,
          token,
          `${failure.at} is a symbolic link, and Papeleria does not follow links inside a piece.`,
          'Replace the link with the file or folder itself.',
        );
        return;
      case 'special':
        this.#add('R09', reference, token, `The ${noun} ${shown} is not a regular file.`, 'Replace it with an ordinary file.');
        return;
      case 'outside':
        this.#add('R09', reference, token, `The ${noun} ${shown} resolves outside the piece folder.`, 'Keep every file the piece uses inside its own folder.');
        return;
      case 'changed':
        this.#add(
          'R09',
          reference,
          token,
          `The ${noun} ${shown} changed while Papeleria was reading it, and what was opened is not the file that was checked.`,
          'Build again once nothing else is changing the piece folder; replace any link with the file itself.',
        );
        return;
      case 'size':
        this.#add(
          'R09',
          globalLocation(path),
          `${path}#size`,
          `The ${noun} ${path} is ${formatNumber(failure.bytes)} bytes; the limit is ${mebibytes(failure.limit)} (${formatNumber(failure.limit)} bytes).`,
          kind === 'text' ? 'Split the text into several files.' : kind === 'data' ? 'Split or reduce the data.' : 'Reduce the file before adding it to the piece.',
          `Input limit: ${formatNumber(failure.limit)} bytes per ${kind === 'text' || kind === 'data' ? 'Markdown or CSV file' : 'image or video file'} (IC01).`,
          reference,
        );
        return;
      case 'encoding':
        this.#add('R09', globalLocation(path), `${path}#encoding`, `The ${noun} ${path} is not valid UTF-8 text.`, 'Save the file as UTF-8.', null, reference);
        return;
      case 'content':
        for (const problem of failure.problems) {
          this.#add(
            problem.rule,
            {file: path, line: problem.line, column: problem.line === null ? null : (problem.column ?? null)},
            `${path}#${problem.code}`,
            problem.message,
            problem.fix,
            null,
            reference,
          );
        }
        return;
      case 'svg':
        for (const problem of failure.problems) {
          this.#add('R09', {file: path, line: problem.line, column: problem.column}, `${path}@${problem.line}:${problem.column}:${problem.message}`, problem.message, problem.fix, null, reference);
        }
        return;
    }
  }

  /** Reports Markdown issues: in the file when the text came from one, at the field otherwise. */
  reportMarkdown(issues: readonly MarkdownIssue[], pointer: string, path: string | null): void {
    for (const issue of issues) {
      if (path !== null) {
        this.#add(
          'R09',
          {file: path, line: issue.line, column: issue.column},
          `${path}@${issue.line}:${issue.column}:${issue.kind}:${issue.message}`,
          issue.message,
          issue.fix,
          null,
          this.at(pointer),
        );
      } else {
        // Every issue is placed at the field, so its place in the field's Markdown is what
        // keeps two links with one message apart, in the semantic path and for the author.
        this.#add(
          'R09',
          this.at(pointer),
          `${this.file}#${pointer}@${issue.line}:${issue.column}:${issue.kind}:${issue.message}`,
          issue.message,
          issue.fix,
          issue.line === null
            ? null
            : `In the Markdown of this field, line ${issue.line}${issue.column === null ? '' : `, column ${issue.column}`}.`,
        );
      }
    }
  }

  /**
   * A path is checked in full: the schema's patterns hold what JSON Schema can
   * state, C05's text paths among them, and `checkAssetPath` adds the rest,
   * such as reserved names and the name and path lengths (IC02, D164).
   * validateManifest already reports what this finds, with the schema's other
   * errors (W5R-33), under the same rule and source path; the check stays so
   * that a path outside IC02 never reaches a Piece, however the manifest was
   * validated.
   */
  checkPath(kind: AssetKind, path: string, pointer: string): boolean {
    const problem = checkAssetPath(kind, path);
    if (problem !== null) {
      this.#add('R09', this.at(pointer), `${this.file}#${pointer}`, problem.message, problem.fix);
      return false;
    }
    return true;
  }

  reportLink(pointer: string, href: string, reason: string): void {
    this.#add('R09', this.at(pointer), `${this.file}#${pointer}`, `The link ${quoteForMessage(href)} uses ${reason}.`, 'Use an https, http, mailto or tel address, a relative link or a #fragment.');
  }

  get externalLinkLabel(): string {
    return this.#strings.external_link;
  }
}

// ---------------------------------------------------------------------------
// Placeholders keep the walk going after a failure; a piece with errors is never returned.

function placeholderImage(path: string): ImageAsset {
  const format = imageFormat(path);
  return format === 'svg'
    ? {path, kind: 'vector', format, width: 0, height: 0, viewBox: [0, 0, 0, 0], bytes: 0, markup: ''}
    : {path, kind: 'raster', format, width: 0, height: 0, bytes: 0};
}

function placeholderData(path: string): DataAsset {
  return {path, bytes: 0, csv: {ok: false, problems: []}};
}

function placeholderVideo(path: string): VideoAsset {
  return {path, bytes: 0, probe: {ok: false, problem: {code: 'unresolved', rule: 'R16', message: 'The video was not resolved.', fix: '', line: null}}};
}

/** Heading levels for rebased Markdown (D150): one below the heading of the container. */
const BASE_LEVEL = {
  slideNotes: 3,
  slideColumn: 4,
  slideFigure: 3,
  sectionBlock: 3,
  sourceNote: 2,
  comicDetail: 3,
} as const;

async function resolveText(resolver: Resolver, value: string, pointer: string, baseLevel: number): Promise<ResolvedText> {
  const options = {baseLevel, docId: pointer, externalLinkLabel: resolver.externalLinkLabel};
  if (isTextFileReference(value)) {
    if (!resolver.checkPath('text', value, pointer)) {
      return {pointer, origin: 'file', path: value, markdown: '', html: '', baseLevel};
    }
    const loaded = await resolver.loadText(value);
    if (!loaded.ok) {
      resolver.reportFailure(loaded.failure, 'text', value, pointer);
      return {pointer, origin: 'file', path: value, markdown: '', html: '', baseLevel};
    }
    if (!resolver.admitMarkdown(loaded.value.bytes, pointer)) {
      return {pointer, origin: 'file', path: value, markdown: '', html: '', baseLevel};
    }
    const rendered = resolver.renderText(loaded.value, options);
    resolver.reportMarkdown(rendered.issues, pointer, value);
    return {pointer, origin: 'file', path: value, markdown: loaded.value.markdown, html: rendered.html, baseLevel};
  }
  if (!resolver.admitMarkdown(Buffer.byteLength(value), pointer)) {
    return {pointer, origin: 'inline', path: null, markdown: '', html: '', baseLevel};
  }
  const rendered = renderMarkdown(value, options);
  resolver.reportMarkdown(rendered.issues, pointer, null);
  return {pointer, origin: 'inline', path: null, markdown: value, html: rendered.html, baseLevel};
}

function resolveInline(resolver: Resolver, value: string, pointer: string): InlineText {
  const rendered = renderInlineMarkdown(value, {externalLinkLabel: resolver.externalLinkLabel});
  resolver.reportMarkdown(rendered.issues, pointer, null);
  return {pointer, markdown: value, html: rendered.html, text: rendered.text};
}

async function optionalText(resolver: Resolver, value: string | undefined, pointer: string, baseLevel: number): Promise<ResolvedText | null> {
  return value === undefined ? null : resolveText(resolver, value, pointer, baseLevel);
}

async function imageAsset(resolver: Resolver, kind: 'image' | 'logo', path: string, pointer: string): Promise<ImageAsset> {
  if (!resolver.checkPath(kind, path, pointer)) {
    return placeholderImage(path);
  }
  const loaded = await resolver.loadImage(path);
  if (!loaded.ok) {
    resolver.reportFailure(loaded.failure, kind, path, pointer);
    return placeholderImage(path);
  }
  return loaded.value;
}

async function resolveImage(resolver: Resolver, block: ImageBlock, pointer: string, captionLevel: number): Promise<ResolvedImage> {
  return {
    pointer,
    asset: await imageAsset(resolver, 'image', block.src, joinPointer(pointer, 'src')),
    alt: block.alt ?? null,
    decorative: block.decorative === true,
    caption: await optionalText(resolver, block.caption, joinPointer(pointer, 'caption'), captionLevel),
    credit: block.credit ?? null,
    rights: block.rights ?? null,
    focalPoint: block.focal_point === undefined ? [50, 50] : [block.focal_point[0], block.focal_point[1]],
  };
}

async function resolveLogo(resolver: Resolver, block: LogoBlock, pointer: string): Promise<ResolvedLogo> {
  return {pointer, asset: await imageAsset(resolver, 'logo', block.src, joinPointer(pointer, 'src')), alt: block.alt};
}

async function dataAsset(resolver: Resolver, path: string, pointer: string): Promise<DataAsset> {
  if (!resolver.checkPath('data', path, pointer)) {
    return placeholderData(path);
  }
  const loaded = await resolver.loadData(path);
  if (!loaded.ok) {
    resolver.reportFailure(loaded.failure, 'data', path, pointer);
    return placeholderData(path);
  }
  return loaded.value;
}

async function resolveChart(resolver: Resolver, block: ChartBlock, pointer: string, captionLevel: number): Promise<ResolvedChart> {
  return {
    pointer,
    type: block.type,
    orientation: block.type === 'bar' ? (block.orientation ?? 'vertical') : null,
    data: await dataAsset(resolver, block.data, joinPointer(pointer, 'data')),
    x: block.x,
    y: block.y,
    series: block.series ?? null,
    summary: block.summary,
    showTable: block.show_table ?? false,
    caption: await optionalText(resolver, block.caption, joinPointer(pointer, 'caption'), captionLevel),
    source: block.source ?? null,
  };
}

async function resolveTable(resolver: Resolver, block: TableBlock, pointer: string, captionLevel: number): Promise<ResolvedTable> {
  return {
    pointer,
    data: await dataAsset(resolver, block.data, joinPointer(pointer, 'data')),
    columns:
      block.columns === undefined
        ? null
        : block.columns.map((column) =>
            typeof column === 'string' ? {field: column, label: column} : {field: column.field, label: column.label ?? column.field},
          ),
    caption: await optionalText(resolver, block.caption, joinPointer(pointer, 'caption'), captionLevel),
    source: block.source ?? null,
  };
}

async function resolveVideo(resolver: Resolver, block: VideoBlock, pointer: string, captionLevel: number): Promise<ResolvedVideo> {
  const srcPointer = joinPointer(pointer, 'src');
  let asset = placeholderVideo(block.src);
  if (resolver.checkPath('video', block.src, srcPointer)) {
    const loaded = await resolver.loadVideo(block.src);
    if (loaded.ok) {
      asset = loaded.value;
    } else {
      resolver.reportFailure(loaded.failure, 'video', block.src, srcPointer);
    }
  }
  return {
    pointer,
    asset,
    poster: await imageAsset(resolver, 'image', block.poster, joinPointer(pointer, 'poster')),
    alt: block.alt,
    caption: await optionalText(resolver, block.caption, joinPointer(pointer, 'caption'), captionLevel),
    credit: block.credit ?? null,
    rights: block.rights ?? null,
  };
}

async function resolveBlock(resolver: Resolver, block: Block, pointer: string, position: number, level: number): Promise<ResolvedBlock> {
  const base = {pointer, position};
  if ('text' in block) {
    return {...base, kind: 'text', text: await resolveText(resolver, block.text, joinPointer(pointer, 'text'), level)};
  }
  if ('image' in block) {
    return {...base, kind: 'image', image: await resolveImage(resolver, block.image, joinPointer(pointer, 'image'), level)};
  }
  if ('video' in block) {
    return {...base, kind: 'video', video: await resolveVideo(resolver, block.video, joinPointer(pointer, 'video'), level)};
  }
  if ('chart' in block) {
    return {...base, kind: 'chart', chart: await resolveChart(resolver, block.chart, joinPointer(pointer, 'chart'), level)};
  }
  if ('table' in block) {
    return {...base, kind: 'table', table: await resolveTable(resolver, block.table, joinPointer(pointer, 'table'), level)};
  }
  if ('quote' in block) {
    const inner = joinPointer(pointer, 'quote');
    return {...base, kind: 'quote', text: await resolveText(resolver, block.quote.text, joinPointer(inner, 'text'), level), attribution: block.quote.attribution ?? null};
  }
  if ('note' in block) {
    const inner = joinPointer(pointer, 'note');
    return {...base, kind: 'note', text: await resolveText(resolver, block.note.text, joinPointer(inner, 'text'), level), tone: block.note.tone ?? 'default'};
  }
  if ('callout' in block) {
    const inner = joinPointer(pointer, 'callout');
    return {...base, kind: 'callout', text: await resolveText(resolver, block.callout.text, joinPointer(inner, 'text'), level)};
  }
  return {...base, kind: 'logo', logo: await resolveLogo(resolver, block.logo, joinPointer(pointer, 'logo'))};
}

async function resolveDetail(resolver: Resolver, detail: Detail, pointer: string): Promise<ResolvedDetail> {
  if ('zoom' in detail) {
    return {pointer, kind: 'zoom'};
  }
  if ('text' in detail) {
    return {pointer, kind: 'text', text: await resolveText(resolver, detail.text, joinPointer(pointer, 'text'), BASE_LEVEL.comicDetail)};
  }
  if ('image' in detail) {
    return {pointer, kind: 'image', image: await resolveImage(resolver, detail.image, joinPointer(pointer, 'image'), BASE_LEVEL.comicDetail)};
  }
  const verdict = classifyLink(detail.href);
  if (!verdict.ok) {
    resolver.reportLink(joinPointer(pointer, 'href'), detail.href, verdict.reason);
    // The refused address goes no further; the label stays, as a refused Markdown link's text does (F17).
    return {pointer, kind: 'link', href: null, label: detail.label, link: 'relative'};
  }
  return {pointer, kind: 'link', href: detail.href, label: detail.label, link: verdict.kind};
}

// ---------------------------------------------------------------------------
// Per template

type Common = Omit<DeckPiece, 'template' | 'manifest' | 'register' | 'edition' | 'logo' | 'slides'>;

async function resolveDeck(resolver: Resolver, manifest: DeckManifest): Promise<Omit<DeckPiece, keyof Common>> {
  const edition = manifest.edition ?? null;
  const slides = [];
  for (const [index, slide] of manifest.slides.entries()) {
    const pointer = joinPointer('/slides', index);
    const at = (field: string) => joinPointer(pointer, field);
    const columns = [];
    for (const [position, column] of (slide.columns ?? []).entries()) {
      const columnPointer = joinPointer(at('columns'), position);
      columns.push({
        pointer: columnPointer,
        position: position + 1,
        heading: column.heading,
        text: await resolveText(resolver, column.text, joinPointer(columnPointer, 'text'), BASE_LEVEL.slideColumn),
      });
    }
    slides.push({
      pointer,
      number: index + 1,
      source: resolver.lines(pointer),
      layout: slide.layout,
      title: resolveInline(resolver, slide.title, at('title')),
      lead: slide.lead === undefined ? null : resolveInline(resolver, slide.lead, at('lead')),
      footer: slide.footer ?? edition,
      notes: await optionalText(resolver, slide.notes, at('notes'), BASE_LEVEL.slideNotes),
      columns,
      chart: slide.chart === undefined ? null : await resolveChart(resolver, slide.chart, at('chart'), BASE_LEVEL.slideFigure),
      table: slide.table === undefined ? null : await resolveTable(resolver, slide.table, at('table'), BASE_LEVEL.slideFigure),
      image: slide.image === undefined ? null : await resolveImage(resolver, slide.image, at('image'), BASE_LEVEL.slideFigure),
      items: slide.items ?? [],
      swatches: slide.swatches ?? [],
    });
  }
  return {
    template: 'deck',
    manifest,
    register: manifest.register ?? null,
    edition,
    logo: manifest.logo === undefined ? null : await resolveLogo(resolver, manifest.logo, '/logo'),
    slides,
  };
}

async function resolveComic(resolver: Resolver, manifest: ComicManifest, strings: UiStrings): Promise<Omit<ComicPiece, keyof Common>> {
  const pages = [];
  for (const [index, page] of manifest.pages.entries()) {
    const pointer = joinPointer('/pages', index);
    const panels = [];
    for (const [position, panel] of (page.panels ?? []).entries()) {
      const panelPointer = joinPointer(joinPointer(pointer, 'panels'), position);
      panels.push({
        pointer: panelPointer,
        number: position + 1,
        source: resolver.lines(panelPointer),
        box: [panel.box[0], panel.box[1], panel.box[2], panel.box[3]] as const,
        transcript: panel.transcript,
        detail: panel.detail === undefined ? null : await resolveDetail(resolver, panel.detail, joinPointer(panelPointer, 'detail')),
      });
    }
    pages.push({
      pointer,
      number: index + 1,
      source: resolver.lines(pointer),
      image: await imageAsset(resolver, 'image', page.image, joinPointer(pointer, 'image')),
      alt: page.alt,
      credit: page.credit ?? null,
      rights: page.rights ?? null,
      panels,
    });
  }
  return {template: 'comic', manifest, formatLabel: manifest.format ?? strings.format_comics, pages};
}

/**
 * Ids the document page itself uses, which no section slug may take (D153):
 * `main#document`, the skip link's target. The document renderer writes
 * nothing else with an id but section headings, footnotes and its block ids,
 * which hold an underscore that no slug can (D95).
 */
export const DOCUMENT_PAGE_IDS: readonly string[] = Object.freeze(['document']);

/** The ids Markdown put into a field's HTML: footnotes and their references (D150). */
function htmlIds(html: string | undefined, into: Set<string>): void {
  for (const match of html?.matchAll(/ id="([^"]+)"/g) ?? []) {
    into.add(match[1]!);
  }
}

/** The HTML of every text field a block renders, for the ids a slug must not take. */
function blockHtml(block: ResolvedBlock): (string | undefined)[] {
  switch (block.kind) {
    case 'text':
    case 'quote':
    case 'note':
    case 'callout':
      return [block.text.html];
    case 'image':
      return [block.image.caption?.html];
    case 'chart':
      return [block.chart.caption?.html];
    case 'table':
      return [block.table.caption?.html];
    case 'video':
      return [block.video.caption?.html];
    case 'logo':
      return [];
  }
}

async function resolveDocument(resolver: Resolver, manifest: DocumentManifest, strings: UiStrings): Promise<Omit<DocumentPiece, keyof Common>> {
  const resolved = [];
  for (const [index, section] of manifest.sections.entries()) {
    const pointer = joinPointer('/sections', index);
    const blocks = [];
    for (const [position, block] of section.blocks.entries()) {
      blocks.push(await resolveBlock(resolver, block, joinPointer(joinPointer(pointer, 'blocks'), position), position + 1, BASE_LEVEL.sectionBlock));
    }
    resolved.push({pointer, index, section, blocks});
  }
  const sourceNote = await optionalText(resolver, manifest.source_note, '/source_note', BASE_LEVEL.sourceNote);
  // A slug never takes an id the page already has: the page's own, and the
  // footnote ids the document's Markdown carries (D153, D95).
  const reserved = new Set(DOCUMENT_PAGE_IDS);
  for (const {blocks} of resolved) {
    for (const block of blocks) {
      for (const html of blockHtml(block)) {
        htmlIds(html, reserved);
      }
    }
  }
  htmlIds(sourceNote?.html, reserved);
  const slugs = assignSlugs(
    manifest.sections.map((section) => section.heading),
    {reserved},
  );
  const sections = resolved.map(({pointer, index, section, blocks}) => ({
    pointer,
    number: index + 1,
    source: resolver.lines(pointer),
    heading: section.heading,
    slug: slugs[index]!,
    newPage: section.new_page ?? false,
    blocks,
  }));
  return {
    template: 'document',
    manifest,
    docType: manifest.doc_type ?? strings.doc_type_default,
    metadata: manifest.metadata ?? [],
    sections,
    sourceNote,
    footer: manifest.footer ?? null,
  };
}

/**
 * Resolves a validated manifest. The piece is null when any error was found;
 * the findings say why. Warnings never withhold the piece.
 */
export async function resolvePiece(manifest: ValidatedManifest, context: ResolveContext): Promise<ResolveResult> {
  const data = manifest.data;
  const language: Language = data.language ?? 'en';
  const strings = context.strings?.[language] ?? loadStrings(language, context.toolRoot ?? locateToolRoot());
  const brandFiles = context.brand ?? loadBrandFiles(context.toolRoot ?? locateToolRoot());
  const resolver = new Resolver(manifest, context.loaders, strings);

  const status = data.status ?? 'draft';
  const common: Common = {
    manifestFile: manifest.file,
    format: manifest.format,
    sourceMap: manifest.sourceMap,
    title: resolveInline(resolver, data.title, '/title'),
    language,
    status,
    statusLabel: strings[`status_${status}`],
    credits: data.credits ?? [],
    brand: resolveBrand(brandFiles, data.wordmark),
    // A copy: strings the caller passed stay the caller's, unfrozen.
    strings: {...strings},
    assets: {texts: resolver.texts, images: resolver.images, data: resolver.data, videos: resolver.videos},
  };

  let specific: Omit<DeckPiece, keyof Common> | Omit<ComicPiece, keyof Common> | Omit<DocumentPiece, keyof Common>;
  if (data.template === 'deck') {
    specific = await resolveDeck(resolver, data);
  } else if (data.template === 'comic') {
    specific = await resolveComic(resolver, data, strings);
  } else {
    specific = await resolveDocument(resolver, data, strings);
  }

  if (hasErrors(resolver.findings)) {
    return {piece: null, findings: resolver.findings};
  }
  // The manifest value and its source map are read-only all the way down already (manifest.ts).
  const piece = deepFreeze({...common, ...specific} as Piece);
  return {piece, findings: resolver.findings};
}

// ---------------------------------------------------------------------------
// One call for load, validate and resolve

export type ReadPieceOptions = ResolveContext & {
  /** How the piece folder is named in a global finding. */
  readonly pieceLabel?: string;
};

/**
 * Load, validate and resolve in one call, with the findings of all three
 * stages deduplicated and sorted. Later stages run only on valid input.
 */
export async function readPiece(options: ReadPieceOptions): Promise<{piece: Piece | null; findings: Finding[]}> {
  const loaded = await loadManifest(options.loaders, options.pieceLabel === undefined ? {} : {pieceLabel: options.pieceLabel});
  const traces: TracedFinding[] = [...loaded.findings];
  if (loaded.manifest === null) {
    return {piece: null, findings: settleFindings(traces)};
  }
  // Findings are joined with concat, never spread into push: a manifest can hold
  // more findings than a call can take arguments.
  const validated = validateManifest(loaded.manifest, options.toolRoot === undefined ? {} : {toolRoot: options.toolRoot});
  const afterValidation = traces.concat(validated.findings);
  if (validated.manifest === null || hasErrors(afterValidation)) {
    return {piece: null, findings: settleFindings(afterValidation)};
  }
  const resolved = await resolvePiece(validated.manifest, options);
  return {piece: resolved.piece, findings: settleFindings(afterValidation.concat(resolved.findings))};
}
