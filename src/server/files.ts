/**
 * M2.1: the files the editor may read and write, and how it writes them
 * (IC02, IC05, IC06, C04, D81).
 *
 * The API exposes the manifest, Markdown under `assets/text/` and CSV under
 * `assets/data/`, nothing else: never the whole piece folder, a cache, the
 * generated folders or `brand/`. A path is approved by the same syntax rules a
 * manifest reference obeys (`checkAssetPath`), and every read goes through the
 * core's `FileAccess`, which refuses a link anywhere on the way, a file whose
 * canonical path leaves the piece, and a file that changes while it is read.
 * CSV is read-only.
 *
 * A save (IC05) compares SHA-256 content revisions, never timestamps: the
 * current file must be the revision the editor last saw, and is checked again
 * after the new content is written to a temporary file beside it and synced;
 * the previous content is kept under `.papeleria/backups/`; then the
 * temporary file is renamed over the old one and the folder synced. A file
 * changed on disk in between is a 409 carrying the revision now there. Every
 * editor session of a piece, in this process or another, takes the piece's
 * save lock from the first read to the rename, so two of them never both pass
 * the check and the later rename never discards the other's save (D171). A
 * program that does not cooperate can still write between the last check and
 * the rename; the backup is what makes that recoverable (IC05).
 */
import {Buffer} from 'node:buffer';
import {createHash, randomBytes} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, open, readdir, rename, rm, type FileHandle} from 'node:fs/promises';
import {join} from 'node:path';

import {
  checkAssetPath,
  createNodeFileAccess,
  FileChangedError,
  FileTooLargeError,
  inspectAsset,
  INPUT_LIMITS,
  makeDirectoriesWithoutLinks,
  MANIFEST_FILES,
  writeFileWithoutLinks,
  type FileAccess,
  type ManifestFile,
} from '../core/index.js';
import {acquireSaveLock, OutputError, STATE_FOLDER} from '../build/write.js';
import {HttpError} from './http.js';

export type ApprovedKind = 'manifest' | 'text' | 'data';

/** A file the editor may open: its path, kind and revision (null for one too large to open). */
export type ApprovedFile = {readonly path: string; readonly kind: ApprovedKind; readonly revision: string | null; readonly bytes: number};

/** The largest file of each kind the editor opens, in bytes (IC01). */
export const OPEN_LIMITS: Readonly<Record<ApprovedKind, number>> = Object.freeze({
  manifest: INPUT_LIMITS.manifestBytes,
  text: INPUT_LIMITS.textBytes,
  data: INPUT_LIMITS.textBytes,
});

/** Backups kept per file (D81). */
export const BACKUPS_KEPT = 10;

const BACKUPS = 'backups';
const BYTE_ORDER_MARK = Buffer.from([0xef, 0xbb, 0xbf]);

/** SHA-256 of exact bytes: a file's content revision (IC06 `Revision`). */
export function revisionOf(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The piece's manifest file, when exactly one exists; null when there is none or both. */
export async function findManifest(root: string): Promise<ManifestFile | null> {
  const present: ManifestFile[] = [];
  for (const name of MANIFEST_FILES) {
    const stat = await lstat(join(root, name)).catch(() => null);
    if (stat?.isFile() === true) {
      present.push(name);
    }
  }
  return present.length === 1 ? present[0]! : null;
}

/** The kind of an approved path, by syntax alone; null when the API must not touch it. */
export function approvedKind(path: string, manifest: ManifestFile | null): ApprovedKind | null {
  if (manifest !== null && path === manifest) {
    return 'manifest';
  }
  if (checkAssetPath('text', path) === null) {
    return 'text';
  }
  if (checkAssetPath('data', path) === null) {
    return 'data';
  }
  return null;
}

async function walk(root: string, folder: string, nested: boolean, found: string[]): Promise<void> {
  const stat = await lstat(join(root, ...folder.split('/'))).catch(() => null);
  // A folder reached through a link is not the piece's: nothing under it is listed.
  if (stat === null || !stat.isDirectory()) {
    return;
  }
  const entries = await readdir(join(root, ...folder.split('/')), {withFileTypes: true}).catch(() => []);
  for (const entry of entries) {
    const path = `${folder}/${entry.name}`;
    if (entry.isDirectory() && nested) {
      await walk(root, path, nested, found);
    } else if (entry.isFile()) {
      found.push(path);
    }
  }
}

/** Every approved file on disk, in path order: the manifest first, then Markdown, then CSV. */
export async function listApprovedFiles(root: string, manifest: ManifestFile | null): Promise<ApprovedFile[]> {
  const access = createNodeFileAccess(root);
  const texts: string[] = [];
  const data: string[] = [];
  await walk(root, 'assets/text', true, texts);
  await walk(root, 'assets/data', false, data);
  const candidates = [...texts.sort(), ...data.sort()];
  const files: ApprovedFile[] = [];
  for (const path of manifest === null ? candidates : [manifest, ...candidates]) {
    const kind = approvedKind(path, manifest);
    if (kind === null) {
      continue;
    }
    const inspection = await inspectAsset(path, access);
    if (!inspection.ok) {
      continue;
    }
    if (inspection.bytes > OPEN_LIMITS[kind]) {
      files.push({path, kind, revision: null, bytes: inspection.bytes});
      continue;
    }
    try {
      const bytes = await access.readBytes(path, {maxBytes: OPEN_LIMITS[kind]});
      files.push({path, kind, revision: revisionOf(bytes), bytes: bytes.length});
    } catch {
      // Changed or grown while listed: the next listing sees it as it settles.
    }
  }
  return files;
}

/** An approved path for the API, inspected on disk: its kind, or an HTTP error that says why not. */
export async function inspectForApi(access: FileAccess, path: string, manifest: ManifestFile | null): Promise<ApprovedKind> {
  const kind = approvedKind(path, manifest);
  if (kind === null) {
    throw new HttpError(404, 'E_NOT_APPROVED', 'The editor opens only the manifest, Markdown under assets/text/ and CSV under assets/data/.');
  }
  const inspection = await inspectAsset(path, access);
  if (!inspection.ok) {
    if (inspection.reason === 'missing' || inspection.reason === 'not-a-folder') {
      throw new HttpError(404, 'E_NOT_FOUND', `${path} does not exist.`, {currentRevision: null});
    }
    throw new HttpError(403, 'E_PATH_REFUSED', `${path} is a link, is not a regular file or leaves the piece folder, so the editor does not open it.`);
  }
  return kind;
}

/** A text file's content for the editor: the bytes decoded as UTF-8, with a leading byte-order mark taken off. */
export type OpenedFile = {
  readonly path: string;
  readonly kind: ApprovedKind;
  readonly content: string;
  readonly revision: string;
  readonly readOnly: boolean;
  readonly lineEnding: 'lf' | 'crlf';
};

function decode(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    throw new HttpError(422, 'E_ENCODING', `${path} is not UTF-8 text, so the editor cannot show it.`);
  }
}

function ioError(path: string, error: unknown): HttpError {
  if (error instanceof FileTooLargeError) {
    return new HttpError(413, 'E_TOO_LARGE', `${path} is larger than the editor opens (${error.limit} bytes).`);
  }
  if (error instanceof FileChangedError) {
    return new HttpError(409, 'E_CHANGED', `${path} changed while it was read. Try again.`);
  }
  return new HttpError(500, 'E_SOURCE_IO', `${path} could not be read.`);
}

/** Opens an approved file. */
export async function openApprovedFile(root: string, path: string, manifest: ManifestFile | null): Promise<OpenedFile> {
  const access = createNodeFileAccess(root);
  const kind = await inspectForApi(access, path, manifest);
  let bytes: Uint8Array;
  try {
    bytes = await access.readBytes(path, {maxBytes: OPEN_LIMITS[kind]});
  } catch (error) {
    throw ioError(path, error);
  }
  const content = decode(bytes, path);
  return {path, kind, content, revision: revisionOf(bytes), readOnly: kind === 'data', lineEnding: /\r\n/.test(content.slice(0, 65_536)) ? 'crlf' : 'lf'};
}

/** The current revision of an approved file, or null when it does not exist. Other failures are HTTP errors. */
export async function currentRevision(root: string, path: string, manifest: ManifestFile | null): Promise<string | null> {
  const access = createNodeFileAccess(root);
  try {
    const kind = await inspectForApi(access, path, manifest);
    return revisionOf(await access.readBytes(path, {maxBytes: OPEN_LIMITS[kind]}));
  } catch (error) {
    if (error instanceof HttpError && error.status === 404 && error.code === 'E_NOT_FOUND') {
      return null;
    }
    throw error instanceof HttpError ? error : ioError(path, error);
  }
}

/** Where a save is stopped, as a crash or a racing writer would, for the IC05 tests. */
export type SaveStep = 'temporary-written' | 'rechecked' | 'backup-written';
export type SaveHooks = {readonly at?: (step: SaveStep) => Promise<void> | void};

function conflict(path: string, revision: string | null): HttpError {
  return new HttpError(409, 'E_CONFLICT', `${path} changed on disk since the editor read it. Reload it, or keep yours and save again.`, {
    currentRevision: revision,
    reload: `/api/file?path=${encodeURIComponent(path)}`,
  });
}

async function syncFolder(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch {
    // Windows cannot open a folder to sync it.
  } finally {
    await handle?.close();
  }
}

/** Keeps the previous content under `.papeleria/backups/<path>/`, newest `BACKUPS_KEPT` only. */
async function keepBackup(root: string, path: string, bytes: Uint8Array, revision: string): Promise<void> {
  const segments = [STATE_FOLDER, BACKUPS, ...path.split('/')];
  const folder = await makeDirectoriesWithoutLinks(root, segments);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await writeFileWithoutLinks(root, segments, `${stamp}-${revision.slice(0, 16)}`, bytes);
  const kept = (await readdir(folder)).sort();
  for (const old of kept.slice(0, Math.max(0, kept.length - BACKUPS_KEPT))) {
    await rm(join(folder, old), {force: true});
  }
}

/**
 * Saves text over an approved manifest or Markdown file whose revision on disk
 * is `expectedRevision` (IC05), and returns the new revision. The file's
 * byte-order mark, if it had one, is kept; the content's line breaks are
 * written as given.
 */
export async function saveApprovedFile(
  root: string,
  path: string,
  content: string,
  expectedRevision: string,
  manifest: ManifestFile | null,
  hooks: SaveHooks = {},
): Promise<string> {
  const access = createNodeFileAccess(root);
  const kind = await inspectForApi(access, path, manifest).catch((error: unknown) => {
    if (error instanceof HttpError && error.code === 'E_NOT_FOUND') {
      throw conflict(path, null);
    }
    throw error;
  });
  if (kind === 'data') {
    throw new HttpError(403, 'E_READ_ONLY', 'CSV files are read-only in the editor.');
  }
  const readCurrent = async (): Promise<Uint8Array> => {
    try {
      return await access.readBytes(path, {maxBytes: OPEN_LIMITS[kind]});
    } catch (error) {
      if (error instanceof FileChangedError) {
        throw conflict(path, null);
      }
      throw ioError(path, error);
    }
  };
  let release: () => Promise<void>;
  try {
    release = await acquireSaveLock(root);
  } catch (error) {
    if (error instanceof OutputError && error.code === 'E_BUSY') {
      throw new HttpError(503, 'E_BUSY', `${path} was not saved: ${error.message}`);
    }
    // A lock in the way that no running process holds, a folder, a FIFO or a link where the lock goes, blocks every
    // save until it is removed, so its own sentence says which file and what to do (PRR-04). A system error's text,
    // which may name the machine's paths, is not passed on.
    const reason = error instanceof OutputError && error.cause === undefined ? ` ${error.message}` : '';
    throw new HttpError(500, 'E_SAVE_IO', `${path} could not be saved; the file on disk is unchanged.${reason}`);
  }
  try {
    return await writeUnderLock(root, path, content, expectedRevision, kind, readCurrent, hooks);
  } finally {
    await release();
  }
}

/** The save itself, from the first read of the current revision to the rename, while the piece's save lock is held. */
async function writeUnderLock(
  root: string,
  path: string,
  content: string,
  expectedRevision: string,
  kind: ApprovedKind,
  readCurrent: () => Promise<Uint8Array>,
  hooks: SaveHooks,
): Promise<string> {
  const current = await readCurrent();
  if (revisionOf(current) !== expectedRevision) {
    throw conflict(path, revisionOf(current));
  }
  const body = Buffer.from(content.startsWith('﻿') ? content.slice(1) : content, 'utf8');
  const hadMark = Buffer.from(current.subarray(0, 3)).equals(BYTE_ORDER_MARK);
  const data = hadMark ? Buffer.concat([BYTE_ORDER_MARK, body]) : body;
  if (data.length > OPEN_LIMITS[kind]) {
    throw new HttpError(413, 'E_TOO_LARGE', `The new ${path} is larger than ${OPEN_LIMITS[kind]} bytes.`);
  }
  const target = join(root, ...path.split('/'));
  const folder = join(root, ...path.split('/').slice(0, -1));
  const name = path.split('/').at(-1)!;
  // Hidden, so neither the watcher nor a manifest path can take it for a piece file.
  const temporary = join(folder, `.${name}.papeleria-${randomBytes(6).toString('hex')}.tmp`);
  const mode = (await lstat(target)).mode & 0o777;
  let handle: FileHandle | undefined;
  let renamed = false;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await hooks.at?.('temporary-written');
    const again = await readCurrent();
    if (revisionOf(again) !== expectedRevision) {
      throw conflict(path, revisionOf(again));
    }
    await hooks.at?.('rechecked');
    await keepBackup(root, path, again, expectedRevision);
    await hooks.at?.('backup-written');
    await rename(temporary, target);
    renamed = true;
    await syncFolder(folder);
    return revisionOf(data);
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(500, 'E_SAVE_IO', `${path} could not be saved; the file on disk is unchanged.`);
  } finally {
    await handle?.close().catch(() => undefined);
    if (!renamed) {
      await rm(temporary, {force: true}).catch(() => undefined);
    }
  }
}
