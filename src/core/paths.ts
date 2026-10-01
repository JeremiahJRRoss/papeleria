/**
 * Manifest file references and the file access that reads them (IC02, C04, C05).
 *
 * A manifest names a file with a piece-relative path written with forward
 * slashes, inside the documented `assets/` folder for its kind and with one of
 * that kind's extensions. Unsafe syntax — absolute, drive and UNC paths,
 * backslashes, NUL, `..` and `.` segments, percent-encoded characters, URLs,
 * names and paths too long to be portable — is R09; a well-formed path whose
 * file is absent is R02. The character set matches the shared schema
 * patterns, so the schema and this module agree on what is well formed; this
 * module adds the checks a pattern cannot state (D152).
 *
 * Reading goes through `FileAccess`. Every path component is inspected with
 * `lstat` semantics and exact-case names: a symbolic link anywhere on the way is
 * refused rather than followed, and the canonical path must stay inside the
 * canonical piece folder.
 */
import {Buffer} from 'node:buffer';
import {existsSync, readFileSync} from 'node:fs';
import {constants, lstat, open, readdir, readlink, realpath, stat as statFollowing, type FileHandle} from 'node:fs/promises';
import {basename, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {escapeInvisible, quoteValue, shortenForMessage} from './finding.js';
import {
  FileChangedError,
  FileTooLargeError,
  InvalidTextEncodingError,
  type FileAccess,
  type FileKind,
  type FileStat,
  type InspectionRun,
  type ReadOptions,
} from './types.js';

export type AssetKind = 'text' | 'image' | 'logo' | 'data' | 'video';

type KindRule = {
  readonly folder: string;
  readonly extensions: readonly string[];
  /** Whether sub-folders under `folder` are allowed. */
  readonly nested: boolean;
  readonly noun: string;
};

const KIND_RULES: Readonly<Record<AssetKind, KindRule>> = {
  text: {folder: 'assets/text/', extensions: ['.md'], nested: true, noun: 'Markdown file'},
  image: {folder: 'assets/images/', extensions: ['.png', '.jpg', '.jpeg', '.webp', '.svg'], nested: true, noun: 'image'},
  logo: {folder: 'assets/images/logos/', extensions: ['.png', '.jpg', '.jpeg', '.webp', '.svg'], nested: true, noun: 'logo'},
  data: {folder: 'assets/data/', extensions: ['.csv'], nested: false, noun: 'CSV file'},
  video: {folder: 'assets/video/', extensions: ['.mp4', '.webm'], nested: false, noun: 'video'},
};

export type PathProblemCode =
  | 'empty'
  | 'nul'
  | 'backslash'
  | 'percent'
  | 'url'
  | 'unc'
  | 'absolute'
  | 'drive'
  | 'traversal'
  | 'empty-segment'
  | 'hidden'
  | 'characters'
  | 'reserved'
  | 'too-long'
  | 'folder'
  | 'extension';

export type PathProblem = {readonly code: PathProblemCode; readonly message: string; readonly fix: string};

/** C05: a text value is a file reference exactly when it starts with assets/text/ and ends with .md. */
export function isTextFileReference(value: string): boolean {
  return value.startsWith('assets/text/') && value.endsWith('.md');
}

/** The asset folder and extensions for a kind, for messages and documentation. */
export function describeAssetKind(kind: AssetKind): {folder: string; extensions: readonly string[]; nested: boolean} {
  const rule = KIND_RULES[kind];
  return {folder: rule.folder, extensions: rule.extensions, nested: rule.nested};
}

const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i;

/**
 * Portable length bounds. Names are ASCII (SEGMENT), so a character is a byte.
 * 255 bytes is the longest name ext4, APFS and NTFS hold; a longer one cannot
 * exist, and the system refuses to look it up. A whole path of at most 240
 * characters stays under Windows' 260-character MAX_PATH once a short piece
 * folder is joined to it, so a piece that builds on one system builds on all.
 */
const MAX_NAME_LENGTH = 255;
const MAX_PATH_LENGTH = 240;

function listExtensions(extensions: readonly string[]): string {
  if (extensions.length === 1) {
    return extensions[0]!;
  }
  return `${extensions.slice(0, -1).join(', ')} or ${extensions.at(-1)!}`;
}

/**
 * A value in double quotes for a message, exactly as written except that
 * control and hidden characters are shown as escapes and a long value is cut,
 * its length stated (`quoteValue`, D175). Backslashes are not doubled: an
 * author who wrote assets\images must see assets\images.
 */
export function quoteForMessage(value: string): string {
  return quoteValue(value);
}

/**
 * Checks the syntax of a manifest file reference for one asset kind. Pure: it
 * says nothing about whether the file exists. Returns null when well formed.
 */
export function checkAssetPath(kind: AssetKind, value: string): PathProblem | null {
  const rule = KIND_RULES[kind];
  const example = `${rule.folder}${kind === 'text' ? 'summary.md' : kind === 'data' ? 'hours.csv' : kind === 'video' ? 'loop.mp4' : 'photo.jpg'}`;
  const problem = (code: PathProblemCode, message: string, fix: string): PathProblem => ({code, message, fix});
  const shown = quoteForMessage(value);

  if (value === '') {
    return problem('empty', 'The file path is empty.', `Write the path of the ${rule.noun}, such as ${example}.`);
  }
  if (value.includes('\u0000')) {
    return problem('nul', `The path ${shown} contains a NUL character.`, 'Remove the control character from the path.');
  }
  if (value.includes('\\')) {
    return problem('backslash', `The path ${shown} uses a backslash.`, `Separate folders with forward slashes, such as ${example}.`);
  }
  if (value.includes('%')) {
    return problem(
      'percent',
      `The path ${shown} contains a percent-encoded character.`,
      'Write the file name plainly; percent escapes are not decoded in manifest paths.',
    );
  }
  if (value.startsWith('//')) {
    return problem('unc', `The path ${shown} names a network share.`, `Copy the file into the piece and write its path, such as ${example}.`);
  }
  if (value.startsWith('/')) {
    return problem('absolute', `The path ${shown} is absolute.`, `Write the path from the piece folder, such as ${example}.`);
  }
  if (/^[A-Za-z]:/.test(value)) {
    return problem('drive', `The path ${shown} names a drive.`, `Copy the file into the piece and write its path, such as ${example}.`);
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    return problem(
      'url',
      `The path ${shown} is a URL; a piece only uses files inside its own folder.`,
      `Download the file into ${rule.folder} and write its path, such as ${example}.`,
    );
  }
  const segments = value.split('/');
  for (const segment of segments) {
    if (segment === '..' || segment === '.') {
      return problem(
        'traversal',
        `The path ${shown} uses a ${segment} segment.`,
        `Write the path straight down from the piece folder, such as ${example}.`,
      );
    }
  }
  for (const segment of segments) {
    if (segment === '') {
      return problem('empty-segment', `The path ${shown} has an empty folder name.`, 'Remove the doubled or trailing slash.');
    }
    if (segment.startsWith('.')) {
      return problem('hidden', `The path ${shown} names a hidden file or folder.`, 'Rename it so it does not start with a dot.');
    }
    if (!SEGMENT.test(segment) || segment.endsWith('.')) {
      return problem(
        'characters',
        `The path ${shown} uses a character that file paths in a piece do not allow.`,
        'Use only letters A–Z, digits, hyphens, underscores and dots in file and folder names, with no spaces, and do not end a name with a dot.',
      );
    }
    if (WINDOWS_RESERVED.test(segment)) {
      return problem(
        'reserved',
        `The path ${shown} uses the name ${quoteValue(segment, 'none')}, which Windows reserves for a device.`,
        'Rename the file or folder.',
      );
    }
    if (segment.length > MAX_NAME_LENGTH) {
      return problem(
        'too-long',
        `The path ${shown} has a file or folder name of ${segment.length.toLocaleString('en-US')} characters; names are limited to ${MAX_NAME_LENGTH}.`,
        'Shorten the file or folder name.',
      );
    }
  }
  if (value.length > MAX_PATH_LENGTH) {
    // The message states the length, so the quote does not repeat it.
    const cut = `"${escapeInvisible(shortenForMessage(value))}"`;
    return problem(
      'too-long',
      `The path ${cut} is ${value.length.toLocaleString('en-US')} characters long; paths are limited to ${MAX_PATH_LENGTH} so the piece also opens on Windows.`,
      'Shorten the file and folder names, or use fewer sub-folders.',
    );
  }
  if (!value.startsWith(rule.folder)) {
    return problem('folder', `The ${rule.noun} ${shown} is not inside ${rule.folder}.`, `Move the file into ${rule.folder} and write its path, such as ${example}.`);
  }
  if (!rule.nested && value.slice(rule.folder.length).includes('/')) {
    return problem(
      'folder',
      `The ${rule.noun} ${shown} is in a sub-folder; ${rule.folder} takes its files directly.`,
      `Move the file directly into ${rule.folder}.`,
    );
  }
  const extension = rule.extensions.find((candidate) => value.endsWith(candidate));
  const stem = extension === undefined ? '' : value.slice(value.lastIndexOf('/') + 1, -extension.length);
  if (extension === undefined || stem === '') {
    return problem(
      'extension',
      `The ${rule.noun} ${shown} must end in ${listExtensions(rule.extensions)}.`,
      `Use a file ending in ${listExtensions(rule.extensions)}, in lower case.`,
    );
  }
  return null;
}

export type AssetInspection =
  | {readonly ok: true; readonly bytes: number}
  | {
      readonly ok: false;
      /**
       * `missing`: a component is absent, and `not-a-folder`: a file (or a
       * device) sits where the path needs a folder; both mean the file named
       * is absent (R02). The others are unsafe (R09).
       */
      readonly reason: 'missing' | 'not-a-folder' | 'symlink' | 'not-a-file' | 'outside-piece';
      /** The component where inspection stopped. */
      readonly at: string;
    };

/**
 * Inspects each component of a well-formed piece-relative path: every folder
 * must be a real folder and the last component a regular file, with no link on
 * the way, and the canonical path must stay inside the canonical piece folder.
 * One inspector is one run: stat results are cached per inspector, so a folder
 * is looked at once per run, and on disk its names are listed once per run.
 */
export class FileInspector {
  readonly #access: FileAccess;
  readonly #stats = new Map<string, Promise<FileStat | null>>();
  readonly #run: InspectionRun = {listings: new Map()};
  #root: Promise<string> | null = null;

  constructor(access: FileAccess) {
    this.#access = access;
  }

  stat(path: string): Promise<FileStat | null> {
    let cached = this.#stats.get(path);
    if (cached === undefined) {
      cached = this.#access.stat(path, this.#run);
      this.#stats.set(path, cached);
    }
    return cached;
  }

  async inspect(path: string): Promise<AssetInspection> {
    const segments = path.split('/');
    let stat: FileStat | null = null;
    for (let index = 1; index <= segments.length; index += 1) {
      const prefix = segments.slice(0, index).join('/');
      stat = await this.stat(prefix);
      if (stat === null) {
        return {ok: false, reason: 'missing', at: prefix};
      }
      if (stat.kind === 'symlink') {
        return {ok: false, reason: 'symlink', at: prefix};
      }
      const last = index === segments.length;
      if (!last && stat.kind !== 'directory') {
        return {ok: false, reason: 'not-a-folder', at: prefix};
      }
      if (last && stat.kind !== 'file') {
        return {ok: false, reason: 'not-a-file', at: prefix};
      }
    }
    this.#root ??= this.#access.realpath('');
    const [root, file] = await Promise.all([this.#root, this.#access.realpath(path)]);
    if (!isInside(root, file)) {
      return {ok: false, reason: 'outside-piece', at: path};
    }
    return {ok: true, bytes: stat!.bytes};
  }
}

/** One-off inspection; use a `FileInspector` to share stat results across files. */
export function inspectAsset(path: string, access: FileAccess): Promise<AssetInspection> {
  return new FileInspector(access).inspect(path);
}

function isInside(root: string, file: string): boolean {
  const normalize = (value: string): string => value.replaceAll('\\', '/').replace(/\/+$/, '');
  const base = normalize(root);
  const target = normalize(file);
  return target.startsWith(`${base}/`);
}

/**
 * The tool's own root: the nearest folder above this module holding the
 * `papeleria` package.json. Templates, theme and brand files are read from it,
 * from the source tree, from `lib/`, and from an installed package alike.
 */
export function locateToolRoot(start: string = dirname(fileURLToPath(import.meta.url))): string {
  let directory = start;
  for (;;) {
    const candidate = join(directory, 'package.json');
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as {name?: unknown};
        if (parsed.name === 'papeleria') {
          return directory;
        }
      } catch {
        // Not the package we are looking for; keep walking.
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error('E_INTERNAL: the papeleria package root was not found above the core modules');
    }
    directory = parent;
  }
}

// ---------------------------------------------------------------------------
// File access implementations

function strictUtf8(bytes: Uint8Array, path: string): string {
  try {
    // The decoder removes one leading byte-order mark.
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    throw new InvalidTextEncodingError(path);
  }
}

function kindOf(stat: {isSymbolicLink(): boolean; isFile(): boolean; isDirectory(): boolean}): FileKind {
  if (stat.isSymbolicLink()) {
    return 'symlink';
  }
  if (stat.isFile()) {
    return 'file';
  }
  if (stat.isDirectory()) {
    return 'directory';
  }
  return 'other';
}

/** Reads exactly `size` bytes; a shorter file, or a byte more, means it changed while it was read. */
async function readExactly(handle: FileHandle, size: number, path: string): Promise<Uint8Array> {
  const buffer = Buffer.alloc(size + 1);
  let filled = 0;
  while (filled < buffer.length) {
    const {bytesRead} = await handle.read(buffer, filled, buffer.length - filled, filled);
    if (bytesRead === 0) {
      break;
    }
    filled += bytesRead;
  }
  if (filled !== size) {
    throw new FileChangedError(path, 'its size changed while it was read');
  }
  return buffer.subarray(0, size);
}

function isMissing(error: unknown): boolean {
  const code = (error as {code?: unknown}).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * File access to a piece folder on disk. Paths are piece-relative with
 * forward slashes. Names must match exactly, including case, even on a
 * case-insensitive disk, so a piece that builds on one machine builds on all.
 *
 * Inspection and reading are separate steps, and the folder can change in
 * between. `readText` therefore checks the file it actually opened (D152):
 * the final name is opened without following a link, the handle must be a
 * regular file, the handle's own location must be inside the canonical piece
 * folder, and exactly the size the handle reports is read. On Linux the
 * location comes from /proc/self/fd, which names the opened file itself;
 * elsewhere the canonical path is resolved and must name the same device and
 * inode as the handle, which leaves only a race that swaps a folder twice
 * between two system calls.
 */
export type NodeFileAccessOptions = {
  /**
   * Whether to locate an opened file through /proc/self/fd where the platform
   * has it (Linux). Tests turn it off to exercise the portable check.
   */
  readonly procFileDescriptors?: boolean;
};

export function createNodeFileAccess(root: string, options: NodeFileAccessOptions = {}): FileAccess {
  const absolute = (path: string): string => (path === '' ? root : join(root, ...path.split('/')));
  const useProc = (options.procFileDescriptors ?? true) && process.platform === 'linux';

  const confirmOpenedInside = async (handle: FileHandle, info: {dev: number; ino: number}, path: string): Promise<void> => {
    const base = await realpath(root);
    let opened: string | null = null;
    if (useProc) {
      try {
        opened = await readlink(`/proc/self/fd/${handle.fd}`);
      } catch {
        opened = null;
      }
    }
    if (opened !== null && opened.startsWith('/')) {
      if (!isInside(base, opened)) {
        throw new FileChangedError(path, 'the file opened is outside the piece folder');
      }
      return;
    }
    let canonical: string;
    let current: {dev: number; ino: number};
    try {
      canonical = await realpath(absolute(path));
      current = await statFollowing(canonical);
    } catch (error) {
      if (isMissing(error)) {
        throw new FileChangedError(path, 'it no longer exists at its path');
      }
      throw error;
    }
    if (!isInside(base, canonical)) {
      throw new FileChangedError(path, 'its canonical path is outside the piece folder');
    }
    if (current.dev !== info.dev || current.ino !== info.ino) {
      throw new FileChangedError(path, 'the file opened is not the file at its canonical path');
    }
  };

  /**
   * Opens the file inspected a moment ago and reads exactly its bytes, after
   * checking that the handle is that file: the final name opened without
   * following a link, a regular file, located inside the canonical piece, and
   * no larger than the caller allows (D152, D155).
   */
  const readVerified = async (path: string, options: ReadOptions): Promise<Uint8Array> => {
    // O_NOFOLLOW refuses a final-component link that appeared after inspection;
    // O_NONBLOCK keeps a FIFO from blocking the open. Both are 0 where unsupported.
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
    let handle: FileHandle;
    try {
      handle = await open(absolute(path), flags);
    } catch (error) {
      const code = (error as {code?: unknown}).code;
      if (code === 'ELOOP' || code === 'EMLINK') {
        throw new FileChangedError(path, 'it is now a symbolic link');
      }
      if (isMissing(error)) {
        throw new FileChangedError(path, 'it no longer exists');
      }
      throw error;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        throw new FileChangedError(path, 'it is no longer a regular file');
      }
      await confirmOpenedInside(handle, info, path);
      if (options.maxBytes !== undefined && info.size > options.maxBytes) {
        throw new FileTooLargeError(path, info.size, options.maxBytes);
      }
      return await readExactly(handle, info.size, path);
    } finally {
      await handle.close();
    }
  };

  /**
   * An exact-case stat needs its folder's names; read for every file, a folder
   * of 4,000 files cost 4,000 listings (10 s). Within a run each folder is read
   * once, and the access itself keeps nothing between runs.
   */
  const stat = async (path: string, run?: InspectionRun): Promise<FileStat | null> => {
    const full = absolute(path);
    let info;
    try {
      info = await lstat(full);
    } catch (error) {
      // A name longer than the system allows names no file here. checkAssetPath
      // refuses such names first; a long piece folder can still push a path
      // over the system's limit, and that is an absent file, not a crash.
      if (isMissing(error) || (error as {code?: unknown}).code === 'ENAMETOOLONG') {
        return null;
      }
      throw error;
    }
    if (path !== '') {
      const folder = dirname(full);
      let names = run?.listings.get(folder);
      if (names === undefined) {
        names = readdir(folder).then((entries) => new Set(entries));
        if (run !== undefined) {
          run.listings.set(folder, names);
          // A failed read is not kept: the next stat in the folder tries again.
          names.catch(() => run.listings.delete(folder));
        }
      }
      if (!(await names).has(basename(full))) {
        return null;
      }
    }
    return {kind: kindOf(info), bytes: info.size};
  };
  return {
    stat,

    async readText(path, options: ReadOptions = {}) {
      return strictUtf8(await readVerified(path, options), path);
    },

    readBytes(path, options: ReadOptions = {}) {
      return readVerified(path, options);
    },

    realpath(path) {
      return realpath(absolute(path));
    },
  };
}

/** An in-memory file: text, raw bytes, a link, or a stand-in for a device or pipe. */
export type MemoryEntry = string | Uint8Array | {readonly symlink: string} | {readonly other: true};

export type MemoryEntries = Readonly<Record<string, MemoryEntry>>;

/**
 * File access over an in-memory piece, for tests and for callers that already
 * hold the files. Folders are implied by the paths of the files inside them.
 */
export function createMemoryFileAccess(entries: MemoryEntries, rootName = '/memory/piece'): FileAccess {
  const files = new Map(Object.entries(entries));
  const folders = new Set<string>(['']);
  for (const path of files.keys()) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      folders.add(parts.slice(0, index).join('/'));
    }
  }
  const encoder = new TextEncoder();

  /** The entry at a path when it is a file within the bound; anything else is absent, as on disk. */
  const readable = (path: string, options: ReadOptions): string | Uint8Array => {
    const entry = files.get(path);
    if (typeof entry !== 'string' && !(entry instanceof Uint8Array)) {
      throw Object.assign(new Error(`ENOENT: ${path} is not a readable file`), {code: 'ENOENT'});
    }
    const bytes = typeof entry === 'string' ? encoder.encode(entry).length : entry.length;
    if (options.maxBytes !== undefined && bytes > options.maxBytes) {
      throw new FileTooLargeError(path, bytes, options.maxBytes);
    }
    return entry;
  };

  return {
    async stat(path) {
      const entry = files.get(path);
      if (entry === undefined) {
        return folders.has(path) ? {kind: 'directory', bytes: 0} : null;
      }
      if (typeof entry === 'string') {
        return {kind: 'file', bytes: encoder.encode(entry).length};
      }
      if (entry instanceof Uint8Array) {
        return {kind: 'file', bytes: entry.length};
      }
      return {kind: 'symlink' in entry ? 'symlink' : 'other', bytes: 0};
    },

    async readText(path, options: ReadOptions = {}) {
      const entry = readable(path, options);
      if (typeof entry === 'string') {
        return entry.charCodeAt(0) === 0xfeff ? entry.slice(1) : entry;
      }
      return strictUtf8(entry, path);
    },

    async readBytes(path, options: ReadOptions = {}) {
      const entry = readable(path, options);
      // A copy, as a read from disk would be: a caller cannot change the piece through it.
      return typeof entry === 'string' ? encoder.encode(entry) : entry.slice();
    },

    async realpath(path) {
      return path === '' ? rootName : `${rootName}/${path}`;
    },
  };
}
