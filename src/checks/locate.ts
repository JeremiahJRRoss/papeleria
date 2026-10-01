/**
 * Locations for rule findings (IC01, D145): where a manifest value starts, the
 * container location of a missing field, the first manifest token that names
 * each file a Piece uses, and where each link the page carries is written.
 */
import {anchorPosition, joinPointer, markdownLinks, nearestEntry, type Location, type Piece, type SourceMap} from '../core/index.js';
import {isInlineText, isResolvedText, visitContent} from './walk.js';

type Located = {readonly manifestFile: string; readonly sourceMap: SourceMap};

/** Where the manifest value at `pointer` starts, or its nearest ancestor's; the manifest with no line if none. */
export function manifestLocation(piece: Located, pointer: string): Location {
  const entry = nearestEntry(piece.sourceMap, pointer)?.entry;
  return entry === undefined
    ? {file: piece.manifestFile, line: null, column: null}
    : {file: piece.manifestFile, line: entry.value.start.line, column: entry.value.start.column};
}

/** Where the object at `pointer` starts — its key when it has one — for a field it lacks (D145). */
export function containerLocation(piece: Located, pointer: string): Location {
  const entry = nearestEntry(piece.sourceMap, pointer)?.entry;
  if (entry === undefined) {
    return {file: piece.manifestFile, line: null, column: null};
  }
  const start = anchorPosition(entry);
  return {file: piece.manifestFile, line: start.line, column: start.column};
}

export type AssetReferences = {
  /** Each image, logo, poster and page file, and the first manifest token that names it. */
  readonly images: ReadonlyMap<string, string>;
  readonly data: ReadonlyMap<string, string>;
  readonly videos: ReadonlyMap<string, string>;
};

/** Parts of a Piece that hold no references of their own. */
const SKIPPED = new Set(['manifest', 'sourceMap', 'strings', 'assets', 'brand', 'credits', 'title', 'lead', 'notes', 'source']);

function isImageAsset(value: unknown): value is {path: string; kind: 'raster' | 'vector'} {
  const asset = value as {path?: unknown; kind?: unknown} | null;
  return typeof asset === 'object' && asset !== null && typeof asset.path === 'string' && (asset.kind === 'raster' || asset.kind === 'vector');
}

function isDataAsset(value: unknown): value is {path: string; csv: unknown} {
  const asset = value as {path?: unknown; csv?: unknown} | null;
  return typeof asset === 'object' && asset !== null && typeof asset.path === 'string' && asset.csv !== undefined;
}

function isVideoAsset(value: unknown): value is {path: string; probe: unknown} {
  const asset = value as {path?: unknown; probe?: unknown} | null;
  return typeof asset === 'object' && asset !== null && typeof asset.path === 'string' && asset.probe !== undefined;
}

/**
 * The first manifest token, in document order, naming each file the piece
 * uses: a resolved image, logo or detail image names its `src`, a video its
 * `src` and `poster`, a comic page its `image`, a chart or table its `data`.
 * Found by the shape of the resolved values, so a template's new blocks are
 * covered as long as they keep those shapes.
 */
export function assetReferences(piece: Piece): AssetReferences {
  const images = new Map<string, string>();
  const data = new Map<string, string>();
  const videos = new Map<string, string>();
  const note = (map: Map<string, string>, path: string, pointer: string): void => {
    if (!map.has(path)) {
      map.set(path, pointer);
    }
  };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (typeof value !== 'object' || value === null) {
      return;
    }
    const record = value as Record<string, unknown>;
    const pointer = typeof record['pointer'] === 'string' ? record['pointer'] : null;
    if (pointer !== null) {
      if (isImageAsset(record['asset'])) {
        note(images, record['asset'].path, `${pointer}/src`);
      }
      if (isVideoAsset(record['asset'])) {
        note(videos, record['asset'].path, `${pointer}/src`);
      }
      if (isImageAsset(record['poster'])) {
        note(images, record['poster'].path, `${pointer}/poster`);
      }
      if (isImageAsset(record['image'])) {
        note(images, record['image'].path, `${pointer}/image`);
      }
      if (isDataAsset(record['data'])) {
        note(data, record['data'].path, `${pointer}/data`);
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (!SKIPPED.has(key)) {
        visit(child);
      }
    }
  };
  visit(piece);
  return {images, data, videos};
}

/**
 * Where a link the page carries is written: the location, its place in a
 * manifest field's Markdown, and its semantic path, so a link the page shows
 * twice is one finding (D145).
 */
export type LinkSource = {readonly location: Location; readonly detail: string | null; readonly sourcePath: string};

/**
 * Where the links the page carries are written, by href as the page carries
 * it, in document order (D172): a link in a text file at its line and column;
 * one in Markdown written in the manifest at its field, its place in that
 * Markdown in the detail, as the core reports a Markdown problem there
 * (D164(e)); a comic detail's link at its `href`. A link whose place is not
 * known is named by its field. Each call gives the next link written with the
 * href, and the last again once they run out: a field the page shows twice
 * carries its links twice.
 */
export function linkSources(piece: Piece): (href: string) => LinkSource | undefined {
  const written = new Map<string, LinkSource[]>();
  const note = (href: string, source: LinkSource): void => {
    const sources = written.get(href) ?? [];
    sources.push(source);
    written.set(href, sources);
  };
  visitContent(piece, (value) => {
    if (isInlineText(value) || isResolvedText(value)) {
      const file = isResolvedText(value) && value.origin === 'file' ? value.path : null;
      const field = manifestLocation(piece, value.pointer);
      const fieldPath = `${piece.manifestFile}#${value.pointer}`;
      for (const link of markdownLinks(value.markdown, isInlineText(value))) {
        const at = `@${link.line}:${link.column}#link`;
        if (link.line === null) {
          note(link.href, {location: field, detail: null, sourcePath: `${fieldPath}#link:${link.href}`});
        } else if (file !== null) {
          note(link.href, {location: {file, line: link.line, column: link.column}, detail: null, sourcePath: `${file}${at}`});
        } else {
          const place = `line ${link.line}${link.column === null ? '' : `, column ${link.column}`}`;
          note(link.href, {location: field, detail: `In the Markdown of the related field, ${place}.`, sourcePath: `${fieldPath}${at}`});
        }
      }
    } else if (value['kind'] === 'link' && typeof value['href'] === 'string' && typeof value['pointer'] === 'string') {
      const pointer = joinPointer(value['pointer'], 'href');
      note(value['href'], {location: manifestLocation(piece, pointer), detail: null, sourcePath: `${piece.manifestFile}#${pointer}`});
    }
  });
  const taken = new Map<string, number>();
  return (href) => {
    const sources = written.get(href);
    if (sources === undefined) {
      return undefined;
    }
    const next = taken.get(href) ?? 0;
    taken.set(href, next + 1);
    return sources[Math.min(next, sources.length - 1)];
  };
}
