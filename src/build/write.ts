/**
 * M1.7 / IC05: recoverable output.
 *
 * A build writes a complete generation under `.papeleria/staging/<id>/`, on
 * the same file system as `dist/`, and only a passing build promotes it. A
 * directory cannot be replaced by one atomic rename on every platform, so
 * promotion is two renames with a journal (D67):
 *
 *   1. `.papeleria/promotion.json` names the generation and the backup, and is
 *      synced before anything moves;
 *   2. an existing `dist/` is renamed to `.papeleria/previous/<id>/`;
 *   3. the generation is renamed to `dist/`;
 *   4. the backup is removed, then the journal.
 *
 * Between steps 2 and 3 there is no `dist/` at all — a brief window, never a
 * partly written one. Before step 1 every file and folder of the generation
 * is flushed to disk (D170), so a power loss after promotion cannot leave
 * `dist/` holding files whose bytes never reached the disk. A crash anywhere
 * leaves the journal, and `recoverPromotion`, which every build runs first,
 * finishes or undoes the promotion from what is on disk: the previous
 * complete generation is kept until the new one is in place. Tidying up is
 * best effort: a folder that cannot be removed is reported and left for a
 * later build, and never fails one whose `dist/` is settled (W5R-01). Nothing
 * is read or written through a symbolic link at or below the piece's
 * generated folders (IC02), and builds of one piece are serialized by a lock
 * file, as saves are by another (D171).
 *
 * A preview build (M2.1, W3A, D79) writes its generation the same way and,
 * instead of promoting it, moves it whole to `.papeleria/preview/<id>/`, where
 * the editor's preview origin serves it; `dist/` is never involved. Generation
 * ids increase within a process, so a later preview always has a later id.
 */
import {Buffer} from 'node:buffer';
import {execFile} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {constants} from 'node:fs';
import {link, lstat, open, readFile, readdir, rename, rm, writeFile, type FileHandle} from 'node:fs/promises';
import {uptime} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';

import {makeDirectoriesWithoutLinks, writeFileWithoutLinks} from '../core/index.js';

/** The folder of everything a build keeps inside a piece: generations, backups, the journal, the lock, the image cache. */
export const STATE_FOLDER = '.papeleria';
const STAGING = 'staging';
const PREVIOUS = 'previous';
/** Where preview generations are kept while an editor or `serve` session shows them (D79). */
export const PREVIEW_FOLDER = 'preview';
const JOURNAL = 'promotion.json';
const LOCK = 'build.lock';
const SAVE_LOCK = 'save.lock';
/** A generation id: the creation time in base 36 milliseconds, then 48 random bits. */
const GENERATION_ID = /^([0-9a-z]{1,12})-[0-9a-f]{12}$/;
/** An orphaned generation — a build or check that stopped without cleaning up — is removed once it is this old. */
const ORPHAN_AGE_MS = 60 * 60 * 1000;

export type OutputErrorCode = 'E_OUTPUT_IO' | 'E_BUSY' | 'E_RECOVERY';

/** The output folders cannot be written or recovered: exit 2 (IC05), never a finding. */
export class OutputError extends Error {
  readonly code: OutputErrorCode;

  constructor(code: OutputErrorCode, message: string, options?: {cause?: unknown}) {
    super(message, options);
    this.name = 'OutputError';
    this.code = code;
  }
}

/** A generation being built. `files` records every file written into it, output-relative, with its size. */
export type Generation = {
  readonly id: string;
  readonly pieceRoot: string;
  readonly directory: string;
  readonly files: Map<string, number>;
};

/** Where a test may stop promotion or recovery, as a crash would. */
export type PromotionStep = 'journal-written' | 'backup-moved' | 'promoted' | 'backup-removed' | 'recovery-restored' | 'recovery-staging-removed';
export type PromotionFaults = (step: PromotionStep) => void;

/**
 * A folder a build no longer needs and could not remove, such as one holding
 * a file marked immutable. It is not part of `dist/`; a later build tries
 * again (W5R-01). `path` is relative to the piece folder.
 */
export type Leftover = {readonly path: string; readonly reason: string};

/** The note a person reads about a leftover folder; the reason can quote the piece's path, so it is escaped where it is printed. */
export function leftoverNote(leftover: Leftover): string {
  return `${leftover.path} could not be removed (${leftover.reason}). It is not part of dist/; a later build tries again, or delete it yourself.`;
}

type Journal = {readonly version: 1; readonly generation: string; readonly staging: string; readonly backup: string | null};

function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as {code?: unknown}).code : undefined;
}

async function lstatOrNull(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    // ENOTDIR: a file where a folder on the way should be, so nothing is there either.
    if (codeOf(error) === 'ENOENT' || codeOf(error) === 'ENOTDIR') {
      return null;
    }
    throw error;
  }
}

/** Flushes a folder's entries to disk where the platform allows it. */
async function syncFolder(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch {
    // Windows cannot open a folder for syncing; the rename is as durable as the platform makes it.
  } finally {
    await handle?.close();
  }
}

/**
 * A generation's file is opened to be flushed without following a link or
 * waiting on a FIFO; for reading, which is all fsync needs, except on Windows,
 * which flushes only a file opened for writing.
 */
const SYNC_FILE_FLAGS = (process.platform === 'win32' ? constants.O_RDWR : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/**
 * Flushes every file of a generation, then each folder after what it holds, so
 * the journal never names a generation a power loss could still empty (IC05,
 * D170). A generation holds only files and folders; anything else is refused.
 * Unlike `syncFolder`, a failure here is the build's: nothing has moved yet.
 * Windows cannot open a folder to flush it and relies on the file flushes.
 */
async function syncGeneration(directory: string): Promise<void> {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await syncGeneration(path);
    } else if (entry.isFile()) {
      const handle = await open(path, SYNC_FILE_FLAGS);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } else {
      throw new Error(`${entry.name} in the generation is not a file or a folder`);
    }
  }
  if (process.platform !== 'win32') {
    const handle = await open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

function io(message: string, error: unknown): OutputError {
  return new OutputError('E_OUTPUT_IO', `${message}: ${error instanceof Error ? error.message : String(error)}`, {cause: error});
}

/**
 * A generated file an output rule reads back could not be read: the output's
 * failure, E_OUTPUT_IO, never the piece's E_SOURCE_IO (W5R-11). The rules run
 * before promotion, so `dist/` is as it was.
 */
export function outputReadError(rule: string, error: unknown): OutputError {
  return new OutputError(
    'E_OUTPUT_IO',
    `The generated output could not be read back for ${rule}: ${error instanceof Error ? error.message : String(error)}. Nothing was written to dist/; build again, and check the disk if it happens again.`,
    {cause: error},
  );
}

/** The time part of the last generation id this process made, so the next one is later (D79). */
let lastGenerationTime = 0;

/** Opens a new, empty generation under `.papeleria/staging/`. Its id is later than every id this process made before. */
export async function openGeneration(pieceRoot: string): Promise<Generation> {
  const time = Math.max(Date.now(), lastGenerationTime + 1);
  lastGenerationTime = time;
  const id = `${time.toString(36)}-${randomBytes(6).toString('hex')}`;
  try {
    const directory = await makeDirectoriesWithoutLinks(pieceRoot, [STATE_FOLDER, STAGING, id]);
    return {id, pieceRoot, directory, files: new Map()};
  } catch (error) {
    throw io(`The generation folder ${STATE_FOLDER}/${STAGING}/${id} could not be made`, error);
  }
}

/** Splits an output-relative path, refusing anything that could leave the generation. */
function outputSegments(path: string): string[] {
  const segments = path.split('/');
  if (path === '' || path.startsWith('/') || path.includes('\\') || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`E_INTERNAL: ${JSON.stringify(path)} is not an output path`);
  }
  return segments;
}

/** Writes one file into a generation without following a link, and records its size. */
export async function writeGenerationFile(generation: Generation, path: string, data: string | Uint8Array): Promise<number> {
  const segments = outputSegments(path);
  const bytes = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.byteLength;
  try {
    await writeFileWithoutLinks(generation.directory, segments.slice(0, -1), segments.at(-1)!, data);
  } catch (error) {
    throw io(`${path} could not be written into the generation`, error);
  }
  generation.files.set(path, bytes);
  return bytes;
}

/** Records a file another module wrote into the generation, such as an image derivative. */
export function recordGenerationFile(generation: Generation, path: string, bytes: number): void {
  outputSegments(path);
  generation.files.set(path, bytes);
}

/**
 * Removes a generation that will not be promoted. One a promotion journal
 * names is left where it is: a promotion that failed half way needs it, and
 * the next build's recovery decides. Idempotent, and it never throws: a
 * generation it cannot remove is an orphan, removed once it is old.
 */
export async function discardGeneration(generation: Generation): Promise<void> {
  try {
    const journal = await readJournal(generation.pieceRoot).catch(() => null);
    if (journal?.generation === generation.id) {
      return;
    }
    await rm(generation.directory, {recursive: true, force: true});
  } catch {
    // Left for the orphan clean-up of a later build.
  }
}

/**
 * Moves a complete preview generation to `.papeleria/preview/<id>/` and
 * returns its new folder (D79). The generation must not be used through its
 * old `directory` afterwards; discarding it is then a no-op.
 */
export async function keepPreviewGeneration(generation: Generation): Promise<string> {
  try {
    const folder = await makeDirectoriesWithoutLinks(generation.pieceRoot, [STATE_FOLDER, PREVIEW_FOLDER]);
    const kept = join(folder, generation.id);
    await rename(generation.directory, kept);
    return kept;
  } catch (error) {
    throw io(`The preview generation ${generation.id} could not be kept`, error);
  }
}

/** The preview generations under `.papeleria/preview/`, oldest first; anything else there is left alone. */
export async function listPreviewGenerations(pieceRoot: string): Promise<string[]> {
  const folder = join(pieceRoot, STATE_FOLDER, PREVIEW_FOLDER);
  const state = await lstatOrNull(join(pieceRoot, STATE_FOLDER));
  const preview = state === null || !state.isDirectory() ? null : await lstatOrNull(folder);
  if (preview === null || !preview.isDirectory()) {
    return [];
  }
  const ids: string[] = [];
  for (const entry of await readdir(folder, {withFileTypes: true})) {
    if (entry.isDirectory() && GENERATION_ID.test(entry.name)) {
      ids.push(entry.name);
    }
  }
  return ids.sort(comparePreviewIds);
}

/** Orders generation ids by their time part, then by the rest (D79). */
export function comparePreviewIds(a: string, b: string): number {
  const time = (id: string): number => Number.parseInt(id.slice(0, id.indexOf('-')), 36);
  return time(a) - time(b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** Removes one preview generation. Idempotent; an id this module would not make is refused. */
export async function removePreviewGeneration(pieceRoot: string, id: string): Promise<void> {
  if (!GENERATION_ID.test(id)) {
    throw new Error(`E_INTERNAL: ${JSON.stringify(id)} is not a generation id`);
  }
  const state = await lstatOrNull(join(pieceRoot, STATE_FOLDER));
  const preview = state === null || !state.isDirectory() ? null : await lstatOrNull(join(pieceRoot, STATE_FOLDER, PREVIEW_FOLDER));
  if (preview === null || !preview.isDirectory()) {
    return;
  }
  await rm(join(pieceRoot, STATE_FOLDER, PREVIEW_FOLDER, id), {recursive: true, force: true});
}

async function writeJournal(pieceRoot: string, journal: Journal): Promise<void> {
  const state = join(pieceRoot, STATE_FOLDER);
  const temporary = join(state, `${JOURNAL}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(temporary, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(journal, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, join(state, JOURNAL));
  await syncFolder(state);
}

async function removeJournal(pieceRoot: string): Promise<void> {
  await rm(join(pieceRoot, STATE_FOLDER, JOURNAL), {force: true});
  await syncFolder(join(pieceRoot, STATE_FOLDER));
}

function recoveryError(message: string): OutputError {
  return new OutputError(
    'E_RECOVERY',
    `${message} Nothing was changed; look at dist/ and ${STATE_FOLDER}/ yourself, keep the output you want, then delete ${STATE_FOLDER}/${JOURNAL}.`,
  );
}

/** Removes a folder recovery no longer needs; one it cannot remove is noted and left for a later build (W5R-01). */
async function removeOrLeave(pieceRoot: string, path: string, leftovers: Leftover[]): Promise<boolean> {
  try {
    await rm(join(pieceRoot, ...path.split('/')), {recursive: true, force: true});
    return true;
  } catch (error) {
    leftovers.push({path, reason: error instanceof Error ? error.message : String(error)});
    return false;
  }
}

async function readJournal(pieceRoot: string): Promise<Journal | null> {
  const path = join(pieceRoot, STATE_FOLDER, JOURNAL);
  const stat = await lstatOrNull(path);
  if (stat === null) {
    return null;
  }
  if (!stat.isFile()) {
    throw recoveryError(`${STATE_FOLDER}/${JOURNAL} is not a regular file.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw recoveryError(`${STATE_FOLDER}/${JOURNAL} cannot be read as a promotion journal.`);
  }
  const journal = parsed as Partial<Journal> | null;
  const id = journal?.generation;
  // The journal only ever names the folders this module makes; anything else is refused, never renamed.
  if (
    journal?.version !== 1 ||
    typeof id !== 'string' ||
    !GENERATION_ID.test(id) ||
    journal.staging !== `${STATE_FOLDER}/${STAGING}/${id}` ||
    (journal.backup !== null && journal.backup !== `${STATE_FOLDER}/${PREVIOUS}/${id}`)
  ) {
    throw recoveryError(`${STATE_FOLDER}/${JOURNAL} does not describe a promotion this tool makes.`);
  }
  return {version: 1, generation: id, staging: journal.staging, backup: journal.backup};
}

/** `dist/` as it stands: absent, a folder, or something promotion must refuse. */
async function distState(pieceRoot: string): Promise<'absent' | 'folder'> {
  const stat = await lstatOrNull(join(pieceRoot, 'dist'));
  if (stat === null) {
    return 'absent';
  }
  if (stat.isSymbolicLink()) {
    throw new OutputError('E_OUTPUT_IO', 'dist is a symbolic link, and Papeleria never writes through a link (IC02). Replace it with a folder, or remove it.');
  }
  if (!stat.isDirectory()) {
    throw new OutputError('E_OUTPUT_IO', 'dist exists and is not a folder. Move it away so the build can write its output there.');
  }
  return 'folder';
}

/**
 * Promotes a complete generation to `dist/`, keeping the previous one until
 * the new one is in place. A failure after the old output moved puts it back
 * at once; if even that fails, the journal stays for recovery. Returns the
 * previous output's folder when it could not be removed afterwards.
 */
export async function promoteGeneration(generation: Generation, faults?: PromotionFaults): Promise<readonly Leftover[]> {
  const root = generation.pieceRoot;
  const dist = join(root, 'dist');
  const existing = await distState(root);
  const journal: Journal = {
    version: 1,
    generation: generation.id,
    staging: `${STATE_FOLDER}/${STAGING}/${generation.id}`,
    backup: existing === 'folder' ? `${STATE_FOLDER}/${PREVIOUS}/${generation.id}` : null,
  };
  try {
    await syncGeneration(generation.directory);
  } catch (error) {
    throw io('The new output could not be flushed to disk, so dist/ was left as it was', error);
  }
  try {
    if (journal.backup !== null) {
      await makeDirectoriesWithoutLinks(root, [STATE_FOLDER, PREVIOUS]);
    }
    await writeJournal(root, journal);
  } catch (error) {
    throw io('The promotion journal could not be written, so dist/ was left as it was', error);
  }
  faults?.('journal-written');
  if (journal.backup !== null) {
    try {
      await rename(dist, join(root, journal.backup));
      await syncFolder(root);
    } catch (error) {
      await removeJournal(root).catch(() => undefined);
      throw io('The previous dist/ could not be moved aside, so it was left as it was', error);
    }
    faults?.('backup-moved');
  }
  try {
    await rename(generation.directory, dist);
    await syncFolder(root);
  } catch (error) {
    if (journal.backup === null) {
      await removeJournal(root).catch(() => undefined);
      throw io('The new output could not be moved into dist/; there was no previous output', error);
    }
    try {
      await rename(join(root, journal.backup), dist);
    } catch {
      // The journal and the generation stay (discardGeneration leaves a generation a journal names),
      // and the next build's recovery puts the previous output back.
      throw io(
        `The new output could not be moved into dist/, and moving the previous output back failed too. It is kept in ${journal.backup}; the next build puts it back, or move it to dist/ yourself`,
        error,
      );
    }
    await removeJournal(root).catch(() => undefined);
    throw io('The new output could not be moved into dist/, and the previous output was put back', error);
  }
  faults?.('promoted');
  // dist/ holds the new output from here on. What is left is tidying: a step
  // that fails keeps the journal, and the next build's recovery finishes it.
  const leftovers: Leftover[] = [];
  const backupRemoved = journal.backup === null || (await removeOrLeave(root, journal.backup, leftovers));
  faults?.('backup-removed');
  if (backupRemoved) {
    await removeJournal(root).catch(() => undefined);
  }
  return leftovers;
}

/**
 * What recovery did: `nothing` to do; `cleaned` old orphans away; `restored`
 * the previous output; `completed` the cleanup after a new output was in
 * place; `discarded` a generation that was never promoted, `dist/` as it was.
 */
export type RecoveryOutcome = 'nothing' | 'cleaned' | 'restored' | 'completed' | 'discarded';

/** What recovery did, and the folders it could not remove, which it leaves for a later build (W5R-01). */
export type Recovery = {readonly outcome: RecoveryOutcome; readonly leftovers: readonly Leftover[]};

async function exists(path: string): Promise<boolean> {
  const stat = await lstatOrNull(path);
  if (stat !== null && (stat.isSymbolicLink() || !stat.isDirectory())) {
    throw recoveryError(`${path} is not a folder.`);
  }
  return stat !== null;
}

/**
 * Removes generations and backups no journal names, once they are old enough
 * that no build or check still writes them. Each is tried on its own: one that
 * cannot be removed is noted and the rest still go (W5R-01).
 */
async function removeOrphans(pieceRoot: string, now: number, leftovers: Leftover[]): Promise<boolean> {
  let removed = false;
  for (const folder of [STAGING, PREVIOUS]) {
    let names: string[];
    try {
      names = await readdir(join(pieceRoot, STATE_FOLDER, folder));
    } catch {
      continue;
    }
    for (const name of names) {
      const match = GENERATION_ID.exec(name);
      if (match !== null && now - Number.parseInt(match[1]!, 36) > ORPHAN_AGE_MS && (await removeOrLeave(pieceRoot, `${STATE_FOLDER}/${folder}/${name}`, leftovers))) {
        removed = true;
      }
    }
  }
  return removed;
}

/**
 * Finishes or undoes an interrupted promotion from what is on disk, then
 * removes old orphaned generations. Every step can itself be interrupted and
 * recovery run again: each state it meets is one it knows how to finish.
 * E_RECOVERY is kept for a state it cannot settle: a journal whose folders
 * conflict with `dist/`, or a previous output it cannot put back. A folder it
 * only fails to remove once `dist/` is settled is a leftover, never a failure.
 */
export async function recoverPromotion(pieceRoot: string, faults?: PromotionFaults, now: number = Date.now()): Promise<Recovery> {
  try {
    return await recover(pieceRoot, faults, now);
  } catch (error) {
    if (error instanceof OutputError || codeOf(error) === undefined) {
      // An OutputError says what it is; anything with no system error code is a fault hook or a defect.
      throw error;
    }
    throw new OutputError(
      'E_RECOVERY',
      `Finishing an interrupted build failed: ${(error as Error).message}. Look at dist/ and ${STATE_FOLDER}/, keep the output you want, then delete ${STATE_FOLDER}/${JOURNAL} and build again.`,
      {cause: error},
    );
  }
}

async function recover(pieceRoot: string, faults: PromotionFaults | undefined, now: number): Promise<Recovery> {
  const leftovers: Leftover[] = [];
  const state = await lstatOrNull(join(pieceRoot, STATE_FOLDER));
  if (state === null) {
    return {outcome: 'nothing', leftovers};
  }
  if (state.isSymbolicLink() || !state.isDirectory()) {
    throw new OutputError('E_OUTPUT_IO', `${STATE_FOLDER} is not a folder. Remove it; it holds only generated files.`);
  }
  const journal = await readJournal(pieceRoot);
  if (journal === null) {
    return {outcome: (await removeOrphans(pieceRoot, now, leftovers)) ? 'cleaned' : 'nothing', leftovers};
  }
  const dist = join(pieceRoot, 'dist');
  const staging = join(pieceRoot, journal.staging);
  const backup = journal.backup === null ? null : join(pieceRoot, journal.backup);
  const [hasDist, hasStaging, hasBackup] = await Promise.all([exists(dist), exists(staging), backup === null ? false : exists(backup)]);
  let outcome: RecoveryOutcome;
  if (hasStaging && hasDist) {
    // Interrupted before the previous output moved: it is still the current one.
    if (hasBackup) {
      throw recoveryError('A promotion was interrupted, and dist/, the new generation and a backup all exist.');
    }
    outcome = 'discarded';
  } else if (hasStaging) {
    // Interrupted between the two renames: the previous output goes back.
    if (backup !== null && hasBackup) {
      await rename(backup, dist);
      await syncFolder(pieceRoot);
      faults?.('recovery-restored');
      outcome = 'restored';
    } else {
      outcome = 'discarded';
    }
  } else if (hasDist) {
    // The new output is in place; only the cleanup was interrupted. A backup
    // that will not go is left, never a reason to fail a settled dist/ (W5R-01).
    if (journal.backup !== null && hasBackup) {
      await removeOrLeave(pieceRoot, journal.backup, leftovers);
    }
    outcome = 'completed';
  } else if (backup !== null && hasBackup) {
    // Neither the new generation nor dist/: the previous output is all there is.
    await rename(backup, dist);
    await syncFolder(pieceRoot);
    faults?.('recovery-restored');
    outcome = 'restored';
  } else {
    outcome = 'discarded';
  }
  // dist/ is settled, so the journal goes first: an unpromoted generation left
  // behind by a crash from here on is an orphan, removed once it is old enough,
  // and a later recovery never mistakes the previous output for a new one.
  await removeJournal(pieceRoot);
  if (hasStaging) {
    await removeOrLeave(pieceRoot, journal.staging, leftovers);
    faults?.('recovery-staging-removed');
  }
  await removeOrphans(pieceRoot, now, leftovers);
  return {outcome, leftovers};
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it runs, as another user.
    return codeOf(error) === 'EPERM';
  }
}

const execFileAsync = promisify(execFile);

/**
 * When a process started, as text that every reading of the same process gives
 * alike and a later process given the same id does not; null where it cannot
 * be read (W5R-10). Linux: the boot's id and the start time in clock ticks,
 * from /proc, which no clock change moves; macOS: `ps -o lstart=`, fixed when
 * the process began and read in UTC, since `ps` writes it in the reader's own
 * time zone and a holder and a contender need not share one (PRR-02). Windows
 * and other platforms: null, and a lock naming a running process is then
 * taken over only by D193's rule, when it was written before the system
 * started (`lockState`). `platform` is the running one but in tests.
 */
export async function processStartOf(pid: number, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  try {
    if (platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      // proc(5): the name in field 2 may hold spaces and parentheses, so fields count from the last ')'; field 22 is the start time.
      const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      if (ticks === undefined || !/^[0-9]+$/.test(ticks)) {
        return null;
      }
      const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8').catch(() => '')).trim();
      return `linux:${boot}:${ticks}`;
    }
    if (platform === 'darwin') {
      const {stdout} = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], {env: {...process.env, LC_ALL: 'C', TZ: 'UTC'}, timeout: 5_000});
      const started = stdout.trim();
      return started === '' ? null : `darwin-utc:${started}`;
    }
  } catch {
    // Gone meanwhile, hidden from this user, or no ps: unknown.
  }
  return null;
}

/** Lock holders queued in this process, by piece folder and lock: the promise each new one waits for. */
const queues = new Map<string, Promise<void>>();

/** How often a build or save tries for its lock, a running holder's wait aside, before it reports E_BUSY. */
const LOCK_ATTEMPTS = 8;
/** A lock or break file that names no process may still be being written; it is left alone this long. */
const LOCK_GRACE_MS = 10_000;
/** A lock is read without following a link, and without waiting on a FIFO put in its place (the platform flags where they exist). */
const READ_LOCK_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
/** Errors from `link` on file systems that have no hard links, such as FAT and exFAT. */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);

/**
 * The two locks a piece has under `.papeleria/`. A build's lasts as long as
 * the build, so a running holder is E_BUSY at once; a save's lasts from the
 * read to the rename, milliseconds, so a running holder is waited for a while
 * first (D171). `idle` finishes the sentence that says when it may be deleted.
 */
const LOCKS = {
  build: {file: LOCK, waitMs: 0, running: 'Another build of this piece is running', idle: 'no build is running'},
  save: {file: SAVE_LOCK, waitMs: 10_000, running: 'Another Papeleria editor is saving a file of this piece', idle: 'no editor of this piece is running'},
} as const;
type LockKind = (typeof LOCKS)[keyof typeof LOCKS];

/**
 * How long before the system started a lock may say it was written and still
 * be believed, for the coarse uptime some systems report and a clock that was
 * set since.
 */
const BOOT_MARGIN_MS = 60_000;

/**
 * Test hooks (IC05): `beforeBreak` runs after a stale lock was inspected and
 * before it is broken; `bootedAt` stands in for the time the system started,
 * null for a system that does not say.
 */
export type LockHooks = {readonly beforeBreak?: () => Promise<void>; readonly bootedAt?: number | null};

/**
 * A lock or break file as it is: its identity and content read through one
 * handle, so the two belong together; the process it names, and when that
 * process started, as `processStartOf` read it then (null when the file does
 * not say, as a lock from an older build or one written by hand does not).
 */
type LockHolder = {
  readonly ino: number;
  readonly dev: number;
  readonly content: string;
  readonly pid: number | null;
  readonly processStart: string | null;
  readonly ageMs: number;
  /** The earliest of the time the lock says it was taken and its file's modification time. */
  readonly writtenAt: number;
};

/** When this process started, read once: it never changes. */
let ownStart: Promise<string | null> | undefined;

/** The content of a lock or break file: who holds it, since when that process runs, and a token no other holder has. */
async function holderContent(): Promise<string> {
  ownStart ??= processStartOf(process.pid);
  return `${JSON.stringify({pid: process.pid, processStart: await ownStart, token: randomBytes(12).toString('hex'), started: new Date().toISOString()})}\n`;
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolvePause) => setTimeout(resolvePause, milliseconds));
}

function busy(kind: LockKind, detail: string): OutputError {
  return new OutputError('E_BUSY', `${detail} Wait for it to finish, or delete ${STATE_FOLDER}/${kind.file} and ${STATE_FOLDER}/${kind.file}.break if ${kind.idle}.`);
}

/** The lock or break file at `path`, shown as `name`; null when there is none. */
async function inspectLock(path: string, name: string): Promise<LockHolder | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, READ_LOCK_FLAGS);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') {
      return null;
    }
    if (codeOf(error) === 'ELOOP' || codeOf(error) === 'EMLINK') {
      throw new OutputError('E_OUTPUT_IO', `${name} is a symbolic link, and Papeleria never reads through a link (IC02). Remove it.`);
    }
    throw io(`${name} could not be read`, error);
  }
  try {
    let stat;
    let content: string;
    try {
      stat = await handle.stat();
      if (!stat.isFile()) {
        throw new OutputError('E_OUTPUT_IO', `${name} is not a regular file. Remove it; a lock holds only a process id.`);
      }
      content = await handle.readFile('utf8');
    } catch (error) {
      throw error instanceof OutputError ? error : io(`${name} could not be read`, error);
    }
    let pid: number | null = null;
    let processStart: string | null = null;
    let started = Number.NaN;
    try {
      const held = JSON.parse(content) as {pid?: unknown; processStart?: unknown; started?: unknown} | null;
      pid = typeof held?.pid === 'number' && Number.isInteger(held.pid) ? held.pid : null;
      processStart = typeof held?.processStart === 'string' ? held.processStart : null;
      started = typeof held?.started === 'string' ? Date.parse(held.started) : Number.NaN;
    } catch {
      pid = null;
    }
    const writtenAt = Number.isFinite(started) ? Math.min(started, stat.mtimeMs) : stat.mtimeMs;
    return {ino: stat.ino, dev: stat.dev, content, pid, processStart, ageMs: Date.now() - stat.mtimeMs, writtenAt};
  } finally {
    await handle.close();
  }
}

/** What reads a recorded start: the text before its first colon, `linux` or `darwin-utc`. */
function kindOfStart(start: string): string {
  return start.slice(0, start.indexOf(':'));
}

/**
 * Whether the process a lock or break file names is still the one that wrote
 * it: `gone` when no process has that id, or this process has it (it queues
 * its own holders before they reach the file, so one naming it is left over);
 * `running` when that id runs and started when the file says; `reused` when
 * it runs but started at another time, as an id given again after a crash or
 * a restart is (W5R-10); `unknown` when the file or the platform does not say
 * when it started. A running holder is never judged by the file's age alone:
 * a legitimate build can outlive any ceiling.
 */
async function holderState(holder: LockHolder): Promise<'gone' | 'running' | 'reused' | 'unknown'> {
  if (holder.pid === null || holder.pid === process.pid || !processIsRunning(holder.pid)) {
    return 'gone';
  }
  const live = await processStartOf(holder.pid);
  if (holder.processStart === null || live === null) {
    return 'unknown';
  }
  // A start recorded another way, such as the local-time `darwin:` of a build before PRR-02, cannot be compared:
  // the running holder may be that build, so its lock is never judged reused on that ground.
  if (kindOfStart(live) !== kindOfStart(holder.processStart)) {
    return 'unknown';
  }
  return live === holder.processStart ? 'running' : 'reused';
}

/**
 * Creates the lock whole: its content is written to a file of its own and
 * linked into place, so no process ever reads a lock without its content.
 * False when a lock is already there. A file system without hard links gets
 * the lock created in place, its content a moment behind (LOCK_GRACE_MS).
 */
async function createLock(path: string, name: string, content: string): Promise<boolean> {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, content, {flag: 'wx'});
    try {
      await link(temporary, path);
      return true;
    } catch (error) {
      if (codeOf(error) === 'EEXIST') {
        return false;
      }
      if (!NO_HARD_LINKS.has(String(codeOf(error)))) {
        throw error;
      }
    }
    const handle = await open(path, 'wx').catch((error: unknown) => {
      if (codeOf(error) === 'EEXIST') {
        return null;
      }
      throw error;
    });
    if (handle === null) {
      return false;
    }
    try {
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    throw io(`${name} could not be written`, error);
  } finally {
    await rm(temporary, {force: true});
  }
}

/**
 * Removes a break file a holder left when it stopped inside the break window
 * (W5R-09), if it is still exactly the one inspected. The window lasts
 * milliseconds, so a break file is stale when its process is gone or was
 * given again, and also, when that cannot be told, once it is older than
 * LOCK_GRACE_MS; one a running breaker holds, however old, stays.
 */
async function removeStaleBreaker(breaker: string, name: string): Promise<void> {
  const held = await inspectLock(breaker, name);
  if (held === null) {
    return;
  }
  // One that names no process may be one being written, so its age decides, as for the lock.
  const state = held.pid === null ? null : await holderState(held);
  const stale = state === null ? held.ageMs >= LOCK_GRACE_MS : state === 'gone' || state === 'reused' || (state === 'unknown' && held.ageMs >= LOCK_GRACE_MS);
  if (!stale) {
    return;
  }
  const current = await inspectLock(breaker, name);
  if (current !== null && current.ino === held.ino && current.dev === held.dev && current.content === held.content) {
    await rm(breaker, {force: true});
  }
}

/**
 * Removes a stale lock, if it is still exactly the lock inspected. Only the
 * process that holds the lock's `.break` file may do this, so no two holders
 * ever check and remove at once, and a lock another took meanwhile, which has
 * content of its own, is never the one removed. The break file names its
 * holder like a lock and is held for a moment; while another holds it, this
 * one waits and tries again, and one left by a process that stopped is
 * removed (`removeStaleBreaker`).
 */
async function breakStaleLock(path: string, name: string, holder: LockHolder): Promise<'broken' | 'contended'> {
  const breaker = `${path}.break`;
  let handle: FileHandle;
  try {
    handle = await open(breaker, 'wx');
  } catch (error) {
    if (codeOf(error) === 'EEXIST') {
      await removeStaleBreaker(breaker, `${name}.break`);
      return 'contended';
    }
    throw io(`${name}.break could not be written`, error);
  }
  try {
    try {
      await handle.writeFile(await holderContent());
    } finally {
      await handle.close();
    }
    const current = await inspectLock(path, name);
    if (current !== null && current.ino === holder.ino && current.dev === holder.dev && current.content === holder.content) {
      await rm(path, {force: true});
    }
    return 'broken';
  } finally {
    await rm(breaker, {force: true});
  }
}

/** When the system started, from its uptime; null where the platform does not say. */
function systemStartedAt(): number | null {
  try {
    const seconds = uptime();
    return Number.isFinite(seconds) && seconds > 0 ? Date.now() - seconds * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * `holderState`, with the rules for a lock no running build or save can hold
 * (security audit F7, D193). A process id that is not a whole number above 1
 * holds nothing: `kill` reads 0 and the negative ids as process groups, and 1
 * is the system's first process, which never builds or saves. And a lock whose
 * holder cannot be told apart (`unknown`, as one without a start time is) holds
 * nothing if it was written before the system started, which no process
 * running now can have done, whatever the id names today. So a piece that came
 * from elsewhere with its `.papeleria/` no longer refuses every build until its
 * author deletes the file. A lock whose recorded start matches its running
 * process is held whatever its dates say, since a clock set since can move them.
 */
async function lockState(holder: LockHolder, bootedAt: number | null): Promise<'gone' | 'running' | 'reused' | 'unknown'> {
  if (holder.pid !== null && (!Number.isSafeInteger(holder.pid) || holder.pid <= 1)) {
    return 'gone';
  }
  const state = await holderState(holder);
  return state === 'unknown' && bootedAt !== null && holder.writtenAt < bootedAt - BOOT_MARGIN_MS ? 'gone' : state;
}

/** Takes a lock file and returns its content, or fails with E_BUSY while a running process holds it. */
async function takeLock(path: string, kind: LockKind, hooks: LockHooks): Promise<string> {
  const name = `${STATE_FOLDER}/${kind.file}`;
  const content = await holderContent();
  const bootedAt = hooks.bootedAt === undefined ? systemStartedAt() : hooks.bootedAt;
  const waitUntil = Date.now() + kind.waitMs;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    if (await createLock(path, name, content)) {
      return content;
    }
    const holder = await inspectLock(path, name);
    if (holder === null) {
      continue;
    }
    const state = await lockState(holder, bootedAt);
    if (state === 'running' || state === 'unknown') {
      if (Date.now() < waitUntil) {
        // A save's holder is done in milliseconds: waiting for it costs no attempt.
        attempt -= 1;
        await pause(20);
        continue;
      }
      if (state === 'running') {
        throw busy(kind, `${kind.running} (process ${holder.pid}).`);
      }
      // Running, but whether it is the one that took the lock cannot be told here: never taken over (W5R-10).
      throw new OutputError(
        'E_BUSY',
        `Process ${holder.pid} holds ${name} and is running, and Papeleria cannot tell here whether it is one of its own. Wait for it to finish; if ps -p ${holder.pid} (or Task Manager on Windows) shows it is not Papeleria, delete ${name} and try again.`,
      );
    }
    if (holder.pid === null && holder.ageMs < LOCK_GRACE_MS) {
      await pause(100);
      continue;
    }
    await hooks.beforeBreak?.();
    if ((await breakStaleLock(path, name, holder)) === 'contended') {
      await pause(50);
    }
  }
  throw busy(kind, `${name} could not be taken.`);
}

/** Takes one of a piece's locks for this process: queued behind the holders in this process, then the file. */
async function acquireLock(pieceRoot: string, kind: LockKind, hooks: LockHooks): Promise<() => Promise<void>> {
  const key = `${pieceRoot}\0${kind.file}`;
  const previous = queues.get(key) ?? Promise.resolve();
  let finish!: () => void;
  const turn = new Promise<void>((resolveTurn) => {
    finish = resolveTurn;
  });
  const tail = previous.then(() => turn);
  queues.set(key, tail);
  const leave = (): void => {
    finish();
    if (queues.get(key) === tail) {
      queues.delete(key);
    }
  };
  await previous;
  const name = `${STATE_FOLDER}/${kind.file}`;
  let path: string;
  let content: string;
  try {
    let state: string;
    try {
      state = await makeDirectoriesWithoutLinks(pieceRoot, [STATE_FOLDER]);
    } catch (error) {
      throw io(`${STATE_FOLDER} could not be made`, error);
    }
    path = join(state, kind.file);
    content = await takeLock(path, kind, hooks);
  } catch (error) {
    leave();
    throw error;
  }
  let released = false;
  return async () => {
    if (!released) {
      released = true;
      try {
        // Only this holder's own lock is removed: its content carries a token no other lock has.
        const current = await inspectLock(path, name).catch(() => null);
        if (current !== null && current.content === content) {
          await rm(path, {force: true});
        }
      } finally {
        leave();
      }
    }
  };
}

/**
 * Serializes builds of one piece (IC05) until the returned function releases
 * them: in this process by a queue, across processes by the lock file
 * `.papeleria/build.lock`, which names its process, when that process started,
 * and carries a random token. A lock left by a process that no longer runs,
 * whose id a later process has been given, or that no running build can hold
 * (`lockState`, D193), is broken and taken over, one build at a time
 * (`breakStaleLock`); one held by a running process is E_BUSY however old it
 * is, and so is one whose holder cannot be told apart (W5R-10).
 */
export function acquireBuildLock(pieceRoot: string, hooks: LockHooks = {}): Promise<() => Promise<void>> {
  return acquireLock(pieceRoot, LOCKS.build, hooks);
}

/**
 * Serializes saves of one piece across every editor session of it, in this
 * process and in any other (IC05 "editor-owned operations serialize", D171):
 * `.papeleria/save.lock`, held from the read of the current revision to the
 * rename, with the build lock's rules for a holder that stopped. A holder that
 * runs is waited for, since a save takes milliseconds; E_BUSY only after that.
 */
export function acquireSaveLock(pieceRoot: string, hooks: LockHooks = {}): Promise<() => Promise<void>> {
  return acquireLock(pieceRoot, LOCKS.save, hooks);
}
