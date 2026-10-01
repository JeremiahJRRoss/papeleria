/**
 * M1.4 / IC04: the content-and-settings cache for raster derivatives.
 *
 * A derivative is reused only when everything that decides its bytes is the
 * same: the source bytes, the target width and format, the encoder settings,
 * the orientation policy, the transformation contract version, every library
 * version sharp reports (libvips, libwebp, libaom, libheif and the rest), the
 * platform, architecture and SIMD state, and, for AVIF, the libvips thread
 * count (measured before coding: AVIF output changes with the thread count
 * and WebP output does not; see blueprint/W1B.md and D43). Changing any of
 * them yields a different key, so a stale derivative is never served.
 *
 * Layout under `<cacheDir>` (normally `<piece>/.papeleria/cache`):
 *
 *   images/v<contract>/derivatives/<k0k1>/<key>.<format>   encoded bytes
 *   images/v<contract>/derivatives/<k0k1>/<key>.json       width, height, size, SHA-256, key parts, check
 *   images/v<contract>/sources/<k0k1>/<key>.json           header facts about a source, check
 *
 * Every file is written to a temporary name in its final directory and then
 * renamed, and the sidecar is written after the bytes, so a reader never sees
 * half an entry. Each JSON record carries `check`, an HMAC-SHA-256 under the
 * cache's record key over canonical JSON of its key and every other field, so
 * a record that was edited, or copied from another key, is damage as surely as
 * truncated bytes are. The record key is the installation key
 * (installation-key.ts), which no piece carries: a cache that came with a
 * piece, signed by another installation or computed by hand, is damage too,
 * and its bytes are never published (security audit F6, D191). A read checks
 * the record, then the stored size and SHA-256 of the bytes, and source facts
 * must name the format the source bytes are; an entry that does not match is
 * treated as a miss and rewritten by the next encode, and so is anything in an
 * entry's place that is not a regular file, which is never opened. No read or
 * write goes through a symbolic link at or below the cache directory (IC02).
 */
import {createHash, createHmac, randomBytes} from 'node:crypto';
import {constants, lstat, mkdir, open, rename, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

/** The directory under the cache root that holds image entries. */
export const IMAGE_CACHE_LAYOUT = 'images';

export type CacheKeyParts = {
  contractVersion: number;
  sourceSha256: string;
  width: number;
  format: 'webp' | 'avif';
  quality: number;
  orientation: 'exif';
  encoder: Readonly<Record<string, string | number | boolean>>;
  sharpVersion: string;
  libvipsVersion: string;
  /** Every version string sharp reports, including the encoders it links. */
  libraries: Readonly<Record<string, string>>;
  platform: string;
  arch: string;
  /** sharp's SIMD switch, or null when the module does not report it. */
  simd: boolean | null;
  /** libvips thread count for encoders whose output depends on it (AVIF); null otherwise. */
  threads: number | null;
};

export type SourceKeyParts = {
  contractVersion: number;
  sourceSha256: string;
  sharpVersion: string;
  libvipsVersion: string;
  libraries: Readonly<Record<string, string>>;
  platform: string;
  arch: string;
};

export type CachedDerivative = {data: Uint8Array; width: number; height: number; format: 'webp' | 'avif'};
export type CachedSource = {width: number; height: number; format: 'png' | 'jpeg' | 'webp'};

type DerivativeSidecar = {
  format: 'webp' | 'avif';
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  parts: CacheKeyParts;
};

type EntryKind = 'derivatives' | 'sources';

const KEY_PATTERN = /^[0-9a-f]{64}$/;

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * JSON with object keys sorted at every level, so two equal key-part records
 * always serialize to the same string whatever order their fields were built in.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError(`cache key parts must be finite numbers, got ${String(value)}`);
    }
    if (value === undefined) {
      throw new TypeError('cache key parts must not contain undefined');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/** The cache key of one derivative: SHA-256 over a domain tag and the canonical key parts. */
export function derivativeCacheKey(parts: CacheKeyParts): string {
  return sha256Hex(`papeleria-image-derivative\u0000${canonicalJson(parts)}`);
}

/** The cache key of a source's header facts. */
export function sourceCacheKey(parts: SourceKeyParts): string {
  return sha256Hex(`papeleria-image-source\u0000${canonicalJson(parts)}`);
}

/**
 * The `check` a record carries: HMAC-SHA-256 under the record key over a
 * domain tag and canonical JSON of the entry's key and every other field of
 * the record. The entry's key binds a record to its name, so one copied from
 * another entry does not match; the record key binds it to this installation,
 * so one no installation of this user's wrote does not either (D191).
 */
function recordCheck(recordKey: Uint8Array, kind: EntryKind, key: string, fields: Readonly<Record<string, unknown>>): string {
  return createHmac('sha256', recordKey).update(`papeleria-image-${kind}-record\u0000${canonicalJson({key, fields})}`).digest('hex');
}

/** The fewest bytes a record key may have. */
const RECORD_KEY_BYTES = 32;

function assertKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new TypeError(`an image cache key is 64 lower-case hex characters, got ${JSON.stringify(key)}`);
  }
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as {code?: unknown}).code : undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

function linkRefused(path: string): Error {
  return Object.assign(
    new Error(`${path} is a symbolic link; Papeleria never reads or writes through links in generated folders (IC02)`),
    {code: 'E_SYMLINK'},
  );
}

/**
 * Walks `root` and each directory below it. Returns false as soon as one is
 * missing; throws if one is a symbolic link or not a directory. Ancestors of
 * `root` are the caller's choice and are not examined.
 */
export async function directoriesWithoutLinks(root: string, segments: readonly string[]): Promise<boolean> {
  let current = root;
  for (let index = -1; index < segments.length; index += 1) {
    current = index < 0 ? root : join(current, segments[index] ?? '');
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (isMissing(error)) {
        return false;
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw linkRefused(current);
    }
    if (!info.isDirectory()) {
      throw new Error(`${current} exists but is not a directory`);
    }
  }
  return true;
}

/**
 * Creates `root` and each directory below it, one level at a time, refusing a
 * symbolic link anywhere from `root` down, including one that appears while it
 * works. Returns the innermost directory.
 */
export async function makeDirectoriesWithoutLinks(root: string, segments: readonly string[]): Promise<string> {
  let current = root;
  for (let index = -1; index < segments.length; index += 1) {
    current = index < 0 ? root : join(current, segments[index] ?? '');
    for (let attempt = 0; ; attempt += 1) {
      let info;
      try {
        info = await lstat(current);
      } catch (error) {
        if (!isMissing(error)) {
          throw error;
        }
      }
      if (info !== undefined) {
        if (info.isSymbolicLink()) {
          throw linkRefused(current);
        }
        if (!info.isDirectory()) {
          throw new Error(`${current} exists but is not a directory`);
        }
        break;
      }
      try {
        // The root's own ancestors may be created; everything below the root is made one level at a time.
        await mkdir(current, {recursive: index < 0});
        break;
      } catch (error) {
        if (errorCode(error) !== 'EEXIST' || attempt > 0) {
          throw error;
        }
        // Someone else created it first: look at what they created.
      }
    }
  }
  return current;
}

/**
 * Writes `data` as `<root>/<segments…>/<name>` without following a link: the
 * directories are checked as above, and the file is written under a unique
 * temporary name and renamed, which replaces rather than follows a link at the
 * destination.
 */
export async function writeFileWithoutLinks(root: string, segments: readonly string[], name: string, data: string | Uint8Array): Promise<string> {
  const directory = await makeDirectoriesWithoutLinks(root, segments);
  const path = join(directory, name);
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, data, {flag: 'wx'});
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, {force: true});
    throw error;
  }
  return path;
}

/**
 * Reads `<root>/<segments…>/<name>`, or returns null when it is missing or is
 * not a regular file. A FIFO, socket, device or directory in an entry's place
 * is a miss and is never opened: opening a FIFO blocks until a writer comes,
 * which would hang the build for good.
 */
async function readFileWithoutLinks(root: string, segments: readonly string[], name: string): Promise<Buffer | null> {
  if (!(await directoriesWithoutLinks(root, segments))) {
    return null;
  }
  const path = join(root, ...segments, name);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw linkRefused(path);
  }
  if (!info.isFile()) {
    return null;
  }
  // O_NOFOLLOW refuses a link that appeared since the lstat; O_NONBLOCK keeps a
  // FIFO that appeared since from blocking the open. Both are 0 where unsupported.
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    if (errorCode(error) === 'ELOOP' || errorCode(error) === 'EMLINK') {
      throw linkRefused(path);
    }
    throw error;
  }
  try {
    return (await handle.stat()).isFile() ? await handle.readFile() : null;
  } finally {
    await handle.close();
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export class ImageCache {
  /** The cache directory given, normally `<piece>/.papeleria/cache`. */
  readonly cacheDir: string;
  /** `<cacheDir>/images/v<contract>`. */
  readonly root: string;
  private readonly base: readonly string[];
  readonly #recordKey: Uint8Array;

  /** `recordKey` signs and checks every record: the installation key in production (D191). */
  constructor(cacheDir: string, contractVersion: number, recordKey: Uint8Array) {
    if (typeof cacheDir !== 'string' || cacheDir.length === 0) {
      throw new TypeError('the image cache needs a cache directory');
    }
    if (!isPositiveInteger(contractVersion)) {
      throw new TypeError(`the transformation contract version is a positive integer, got ${String(contractVersion)}`);
    }
    if (!(recordKey instanceof Uint8Array) || recordKey.length < RECORD_KEY_BYTES) {
      throw new TypeError(`the image cache needs a record key of at least ${RECORD_KEY_BYTES} bytes`);
    }
    this.cacheDir = cacheDir;
    this.base = [IMAGE_CACHE_LAYOUT, `v${contractVersion}`];
    this.root = join(cacheDir, ...this.base);
    this.#recordKey = Uint8Array.from(recordKey);
  }

  private segments(kind: EntryKind, key: string): string[] {
    assertKey(key);
    return [...this.base, kind, key.slice(0, 2)];
  }

  /**
   * Reads an entry's JSON record and returns its fields, or null unless its
   * `check` matches the key and every other field: a missing, unparseable,
   * edited or moved record is a miss.
   */
  private async readRecord(kind: EntryKind, key: string): Promise<Readonly<Record<string, unknown>> | null> {
    const text = await readFileWithoutLinks(this.cacheDir, this.segments(kind, key), `${key}.json`);
    if (text === null) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.toString('utf8'));
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const {check, ...fields} = parsed as Record<string, unknown>;
    try {
      return check === recordCheck(this.#recordKey, kind, key, fields) ? fields : null;
    } catch {
      // A number JSON reads as Infinity (1e999) has no canonical form: damage too.
      return null;
    }
  }

  private async writeRecord(kind: EntryKind, key: string, fields: Readonly<Record<string, unknown>>): Promise<void> {
    const record = {...fields, check: recordCheck(this.#recordKey, kind, key, fields)};
    await writeFileWithoutLinks(this.cacheDir, this.segments(kind, key), `${key}.json`, `${JSON.stringify(record, null, 2)}\n`);
  }

  /**
   * Returns the cached derivative, or null on a miss. A missing half, a
   * sidecar that is not this key's intact record, or bytes whose size or
   * SHA-256 differ from the sidecar all count as a miss.
   */
  async readDerivative(key: string, format: 'webp' | 'avif'): Promise<CachedDerivative | null> {
    const sidecar = (await this.readRecord('derivatives', key)) as Partial<DerivativeSidecar> | null;
    if (
      sidecar === null ||
      sidecar.format !== format ||
      !isPositiveInteger(sidecar.width) ||
      !isPositiveInteger(sidecar.height) ||
      !isPositiveInteger(sidecar.bytes) ||
      typeof sidecar.sha256 !== 'string'
    ) {
      return null;
    }
    const data = await readFileWithoutLinks(this.cacheDir, this.segments('derivatives', key), `${key}.${format}`);
    if (data === null || data.length !== sidecar.bytes || sha256Hex(data) !== sidecar.sha256) {
      return null;
    }
    return {data, width: sidecar.width, height: sidecar.height, format};
  }

  /** Stores a derivative: bytes first, then the sidecar that makes the entry readable. */
  async writeDerivative(key: string, entry: CachedDerivative, parts: CacheKeyParts): Promise<void> {
    const sidecar: DerivativeSidecar = {
      format: entry.format,
      width: entry.width,
      height: entry.height,
      bytes: entry.data.length,
      sha256: sha256Hex(entry.data),
      parts,
    };
    await writeFileWithoutLinks(this.cacheDir, this.segments('derivatives', key), `${key}.${entry.format}`, entry.data);
    await this.writeRecord('derivatives', key, sidecar);
  }

  /**
   * Returns cached header facts for a source whose bytes are `format` (as
   * sniffed), or null on a miss, a damaged entry, or facts naming another format.
   */
  async readSource(key: string, format: CachedSource['format']): Promise<CachedSource | null> {
    const facts = (await this.readRecord('sources', key)) as Partial<CachedSource> | null;
    if (facts === null || facts.format !== format || !isPositiveInteger(facts.width) || !isPositiveInteger(facts.height)) {
      return null;
    }
    return {width: facts.width, height: facts.height, format};
  }

  async writeSource(key: string, entry: CachedSource): Promise<void> {
    await this.writeRecord('sources', key, {width: entry.width, height: entry.height, format: entry.format});
  }
}
