/**
 * M1.7: the source snapshot a build reads (IC05, IC06).
 *
 * A snapshot is a piece folder plus, optionally, text overlays: the editor's
 * unsaved buffers, which Preview and Check show and Build never takes (D09).
 * The build reads the snapshot through `createNodeLoaders(root)` — the core's
 * one read path, with the real readers (D155, D158) — wrapped twice:
 *
 * - `withOverlays` replaces the text of overlaid paths. It overlays text only:
 *   `stat` still inspects the disk, so every IC02 check on a path runs as it
 *   would without the overlay, and reports the buffer's UTF-8 size; `readText`
 *   returns the buffer; `readBytes`, images and CSV included, and `realpath`
 *   read the disk; `stat`'s inspection run is passed on (D164(d)).
 * - `recordRevisions` keeps the SHA-256 of everything read from disk, and what
 *   `stat` saw, so the build can recheck the sources before it promotes a
 *   generation and refuse with E_SOURCE_CHANGED when they moved (IC05).
 */
import {Buffer} from 'node:buffer';
import {createHash} from 'node:crypto';

import {createNodeLoaders, FileTooLargeError, type FileKind, type FileStat, type Loaders, type ReadOptions} from '../core/index.js';

/** An unsaved buffer that replaces the text of a file the piece already has. */
export type SourceOverlay = {readonly path: string; readonly content: string};

/** What a build reads: a piece folder, optionally with overlays, and how findings name the folder. */
export type SourceSnapshot = {
  readonly root: string;
  readonly overlays?: readonly SourceOverlay[];
  /** The folder as the author typed it, for global findings and the report; the root otherwise. */
  readonly label?: string;
};

/** A read the build made: how it was read, the SHA-256 of what it got, and the bound it read under. */
export type SourceRevision = {
  readonly method: 'text' | 'bytes';
  readonly sha256: string;
  readonly maxBytes: number | null;
};

/** Everything a build learned from the disk, to be checked again before promotion. */
export type SourceRecord = {
  /** Reads of files, by path and method. Overlaid reads are not the disk's and are left out. */
  readonly revisions: ReadonlyMap<string, SourceRevision>;
  /** What `stat` reported for each path it was asked about, the first time. */
  readonly stats: ReadonlyMap<string, FileKind | null>;
  /** Paths that read differently twice within the build. */
  readonly changed: readonly string[];
};

function stripByteOrderMark(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Overlays text buffers on a piece's loaders. A buffer for a path whose disk
 * entry is not a regular file changes nothing: the overlay replaces content,
 * never what a path is, so a link or an absent file is refused as without it.
 */
export function withOverlays(access: Loaders, overlays: readonly SourceOverlay[]): Loaders {
  if (overlays.length === 0) {
    return access;
  }
  const buffers = new Map(overlays.map((overlay) => [overlay.path, stripByteOrderMark(overlay.content)]));
  return {
    ...access,
    async stat(path, run) {
      const stat = await access.stat(path, run);
      const buffer = buffers.get(path);
      return buffer !== undefined && stat?.kind === 'file' ? {kind: 'file', bytes: Buffer.byteLength(buffer, 'utf8')} : stat;
    },
    async readText(path, options: ReadOptions = {}) {
      const buffer = buffers.get(path);
      if (buffer === undefined) {
        return access.readText(path, options);
      }
      const bytes = Buffer.byteLength(buffer, 'utf8');
      if (options.maxBytes !== undefined && bytes > options.maxBytes) {
        throw new FileTooLargeError(path, bytes, options.maxBytes);
      }
      return buffer;
    },
  };
}

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Wraps loaders so every disk read is remembered. A path read twice with
 * different content — an image changed between resolve and derivation — is
 * listed as changed at once; the recheck finds everything else.
 */
export function recordRevisions(access: Loaders, overlays: readonly SourceOverlay[] = []): {readonly loaders: Loaders; record(): SourceRecord} {
  const overlaid = new Set(overlays.map((overlay) => overlay.path));
  const revisions = new Map<string, SourceRevision>();
  const stats = new Map<string, FileKind | null>();
  const changed = new Set<string>();
  const remember = (path: string, method: SourceRevision['method'], content: string | Uint8Array, options: ReadOptions): void => {
    if (method === 'text' && overlaid.has(path)) {
      return;
    }
    const key = `${method}:${path}`;
    const revision: SourceRevision = {method, sha256: sha256(content), maxBytes: options.maxBytes ?? null};
    const earlier = revisions.get(key);
    if (earlier === undefined) {
      revisions.set(key, revision);
    } else if (earlier.sha256 !== revision.sha256) {
      changed.add(path);
    }
  };
  const loaders: Loaders = {
    ...access,
    async stat(path, run) {
      const stat: FileStat | null = await access.stat(path, run);
      if (!stats.has(path)) {
        stats.set(path, stat?.kind ?? null);
      }
      return stat;
    },
    async readText(path, options: ReadOptions = {}) {
      const text = await access.readText(path, options);
      remember(path, 'text', text, options);
      return text;
    },
    async readBytes(path, options: ReadOptions = {}) {
      const bytes = await access.readBytes(path, options);
      remember(path, 'bytes', bytes, options);
      return bytes;
    },
  };
  return {
    loaders,
    record: () => ({revisions: new Map(revisions), stats: new Map(stats), changed: [...changed].sort()}),
  };
}

/**
 * Reads everything the build read again, through fresh loaders, and returns
 * the paths whose content or kind is not what the build saw, sorted. A file
 * that can no longer be read the same way counts as changed.
 */
export async function recheckRevisions(root: string, record: SourceRecord): Promise<string[]> {
  const fresh = createNodeLoaders(root);
  const changed = new Set(record.changed);
  for (const [path, kind] of record.stats) {
    const now = await fresh.stat(path).catch(() => undefined);
    if (now === undefined || (now?.kind ?? null) !== kind) {
      changed.add(path);
    }
  }
  for (const [key, revision] of record.revisions) {
    const path = key.slice(key.indexOf(':') + 1);
    const options: ReadOptions = revision.maxBytes === null ? {} : {maxBytes: revision.maxBytes};
    try {
      const content = revision.method === 'text' ? await fresh.readText(path, options) : await fresh.readBytes(path, options);
      if (sha256(content) !== revision.sha256) {
        changed.add(path);
      }
    } catch {
      changed.add(path);
    }
  }
  return [...changed].sort();
}
