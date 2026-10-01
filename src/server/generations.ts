/**
 * M2.1: the preview generations a session shows (IC06, D79).
 *
 * A preview generation is a complete, passing build of the piece's buffers,
 * moved by the pipeline to `.papeleria/preview/<id>/`. The preview origin
 * serves a file only from a generation this session made and still keeps, so
 * nothing else under the piece folder — not the sources, not `dist/`, not
 * another session's previews — is ever reachable from it. A generation never
 * changes once kept.
 *
 * The newest `KEEP` generations are kept: the one the editor shows, and the
 * ones a frame may still be loading or swapping out. Older ones are removed as
 * newer ones arrive, and the session's own are removed when it stops. A
 * session that stopped without doing so (killed, or its machine lost power)
 * leaves its generations behind, so a start removes those no session has
 * marked in the last hour: every running session marks the folders of the
 * generations it keeps every ten minutes, so another `edit` or `serve` on the
 * same piece, however long it has run, never loses the one it shows. The
 * mark is the folder's modification time, which nothing else changes once a
 * generation is kept.
 */
import {Buffer} from 'node:buffer';
import {constants} from 'node:fs';
import {lstat, lutimes, open, realpath, type FileHandle} from 'node:fs/promises';
import {extname, join, sep} from 'node:path';

import {comparePreviewIds, listPreviewGenerations, PREVIEW_FOLDER, removePreviewGeneration, STATE_FOLDER} from '../build/write.js';
import {GENERATION_ID_PATTERN} from '../../templates/shared/preview-protocol.js';

/** How many generations a session keeps (D79). */
export const KEEP = 3;

/** A generation no session has marked for this long is a leftover, removed at a start. */
export const STALE_MS = 60 * 60 * 1000;

/** How often a running session marks the generations it keeps. */
export const MARK_MS = 10 * 60 * 1000;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

/** The media type a generation file is served with; anything unlisted is a download, never sniffed. */
export function contentTypeOf(path: string): string {
  const extension = extname(path).toLowerCase();
  return CONTENT_TYPES[extension] ?? (path.endsWith('/LICENSE') || path === 'LICENSE' ? 'text/plain; charset=utf-8' : 'application/octet-stream');
}

/** A file found inside a generation, opened and checked; the caller reads and closes it. */
export type GenerationFile = {readonly handle: FileHandle; readonly size: number; readonly type: string};

/**
 * The segments of a path inside a generation, or null for one that could leave
 * it or name nothing: empty, `.` and `..` segments, backslashes, NUL and
 * characters that do not decode are all refused.
 */
export function generationSegments(encodedPath: string): string[] | null {
  const raw = encodedPath === '' ? 'index.html' : encodedPath.endsWith('/') ? `${encodedPath}index.html` : encodedPath;
  const segments: string[] = [];
  for (const part of raw.split('/')) {
    let segment: string;
    try {
      segment = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (segment === '' || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('/') || segment.includes('\u0000')) {
      return null;
    }
    segments.push(segment);
  }
  return segments;
}

export class PreviewGenerations {
  readonly #pieceRoot: string;
  /** The session's generations, oldest first, with their folders. */
  readonly #kept = new Map<string, string>();
  readonly #markEveryMs: number;
  /** Marks the kept generations every `#markEveryMs`, from the first one kept until `removeAll`. */
  #marking: NodeJS.Timeout | null = null;

  constructor(pieceRoot: string, markEveryMs: number = MARK_MS) {
    this.#pieceRoot = pieceRoot;
    this.#markEveryMs = markEveryMs;
  }

  /** The ids this session keeps, oldest first. */
  get ids(): readonly string[] {
    return [...this.#kept.keys()];
  }

  has(id: string): boolean {
    return this.#kept.has(id);
  }

  /** Adds a generation the pipeline kept, marks it, and removes the session's older ones beyond `KEEP`. */
  async add(id: string, directory: string): Promise<void> {
    this.#kept.set(id, directory);
    await markFolder(directory, Date.now());
    if (this.#marking === null) {
      this.#marking = setInterval(() => void this.mark(), this.#markEveryMs);
      this.#marking.unref();
    }
    const ids = [...this.#kept.keys()].sort(comparePreviewIds);
    for (const old of ids.slice(0, Math.max(0, ids.length - KEEP))) {
      this.#kept.delete(old);
      await removePreviewGeneration(this.#pieceRoot, old).catch(() => undefined);
    }
  }

  /** Marks every generation this session keeps as still in use at `now`. */
  async mark(now: number = Date.now()): Promise<void> {
    for (const directory of [...this.#kept.values()]) {
      await markFolder(directory, now);
    }
  }

  /** Removes every generation this session kept, and stops marking. */
  async removeAll(): Promise<void> {
    if (this.#marking !== null) {
      clearInterval(this.#marking);
      this.#marking = null;
    }
    for (const id of [...this.#kept.keys()]) {
      this.#kept.delete(id);
      await removePreviewGeneration(this.#pieceRoot, id).catch(() => undefined);
    }
  }

  /** Removes the generations no session has marked for an hour: leftovers of sessions that are gone. */
  async removeStale(now: number = Date.now()): Promise<void> {
    for (const id of await listPreviewGenerations(this.#pieceRoot).catch(() => [])) {
      if (this.#kept.has(id)) {
        continue;
      }
      // Listed only when the folder and every one above it is a real directory, never a link.
      const marked = await lstat(join(this.#pieceRoot, STATE_FOLDER, PREVIEW_FOLDER, id)).catch(() => null);
      if (marked !== null && marked.isDirectory() && now - marked.mtimeMs > STALE_MS) {
        await removePreviewGeneration(this.#pieceRoot, id).catch(() => undefined);
      }
    }
  }

  /**
   * Opens a file of a kept generation by its encoded path below the id, or
   * returns null. Every component is looked at without following a link, the
   * last must be a regular file, and the file opened must be inside the
   * generation's canonical folder (IC02).
   */
  async open(id: string, encodedPath: string): Promise<GenerationFile | null> {
    const directory = this.#kept.get(id);
    const segments = generationSegments(encodedPath);
    if (directory === undefined || !GENERATION_ID_PATTERN.test(id) || segments === null) {
      return null;
    }
    let current = directory;
    for (const [index, segment] of segments.entries()) {
      current = join(current, segment);
      const stat = await lstat(current).catch(() => null);
      const last = index === segments.length - 1;
      if (stat === null || stat.isSymbolicLink() || (last ? !stat.isFile() : !stat.isDirectory())) {
        return null;
      }
    }
    let handle: FileHandle;
    try {
      handle = await open(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    } catch {
      return null;
    }
    try {
      const [base, file, info] = await Promise.all([realpath(directory), realpath(current), handle.stat()]);
      if (!info.isFile() || !file.startsWith(`${base}${sep}`)) {
        await handle.close();
        return null;
      }
      return {handle, size: info.size, type: contentTypeOf(segments.join('/'))};
    } catch {
      await handle.close();
      return null;
    }
  }
}

/** Sets a generation folder's modification time, the mark `removeStale` reads, without following a link. */
async function markFolder(directory: string, now: number): Promise<void> {
  const time = new Date(now);
  await lutimes(directory, time, time).catch(() => undefined);
}

/** Reads a byte range of an opened generation file and closes it. */
export async function readGenerationFile(file: GenerationFile, start = 0, end = file.size - 1): Promise<Buffer> {
  try {
    const length = Math.max(0, end - start + 1);
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const {bytesRead} = await file.handle.read(buffer, filled, length - filled, start + filled);
      if (bytesRead === 0) {
        break;
      }
      filled += bytesRead;
    }
    return buffer.subarray(0, filled);
  } finally {
    await file.handle.close();
  }
}
