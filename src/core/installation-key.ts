/**
 * The installation key (security audit F6, D191). The image cache lives in the
 * piece (`.papeleria/cache`, IC04), so whoever hands over a piece can hand
 * over a cache with it; a record anyone can compute would let them publish
 * bytes of their choosing under an image's name. The cache's records are
 * therefore signed with a key a piece cannot carry: 32 random bytes this
 * installation keeps in the user's own state folder, outside every piece,
 * made on first use (image-cache.ts).
 *
 * The folder is `PAPELERIA_STATE_HOME` when that is an absolute path, and
 * otherwise the platform's place for such state: `%LOCALAPPDATA%\Papeleria`
 * on Windows, `~/Library/Application Support/Papeleria` on macOS, and
 * `$XDG_STATE_HOME/papeleria`, by default `~/.local/state/papeleria`,
 * elsewhere. Losing the key costs one cold build per piece and nothing else.
 * Where no folder can hold it, a key made for this process alone is used: the
 * cache still serves the process that wrote it (the editor's previews) and is
 * trusted by no other.
 */
import {randomBytes} from 'node:crypto';
import {constants} from 'node:fs';
import {link, lstat, mkdir, open, rename, rm, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {isAbsolute, join} from 'node:path';

export type InstallationKey = {
  /** 32 random bytes. */
  readonly bytes: Uint8Array;
  /** False for a key made for this process alone, because no state folder could hold one. */
  readonly persistent: boolean;
};

/** The key file inside the state folder: 64 lower-case hex digits and a line break. */
export const INSTALLATION_KEY_FILE = 'installation-key';

const KEY_TEXT = /^([0-9a-f]{64})\n?$/;
/** Errors from `link` on file systems that have no hard links, such as FAT and exFAT. */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);

function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as {code?: unknown}).code : undefined;
}

function absolute(path: string | undefined): string | null {
  return path !== undefined && path !== '' && isAbsolute(path) ? path : null;
}

/**
 * The user's home folder, or '' where the system names none: `homedir()`
 * throws when `HOME` is unset and the user has no account entry, as a
 * container run under a bare numeric user id may, and that must leave the key
 * to this process, never stop the build (PRR-01).
 */
export function homeFolder(read: () => string = homedir): string {
  try {
    return read();
  } catch {
    return '';
  }
}

/** The folder the key is kept in, or null when this environment names no absolute one. */
export function stateFolder(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homeFolder()): string | null {
  const override = absolute(env['PAPELERIA_STATE_HOME']);
  if (override !== null) {
    return override;
  }
  const base = absolute(home);
  if (platform === 'win32') {
    const local = absolute(env['LOCALAPPDATA']) ?? (base === null ? null : join(base, 'AppData', 'Local'));
    return local === null ? null : join(local, 'Papeleria');
  }
  if (platform === 'darwin') {
    return base === null ? null : join(base, 'Library', 'Application Support', 'Papeleria');
  }
  const state = absolute(env['XDG_STATE_HOME']) ?? (base === null ? null : join(base, '.local', 'state'));
  return state === null ? null : join(state, 'papeleria');
}

/**
 * The key in `path`; null when there is none; `unusable` for anything else
 * there, a link or a damaged file, which is replaced and never followed.
 */
async function readKey(path: string): Promise<Uint8Array | null | 'unusable'> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
  if (!info.isFile() || info.size > 1024) {
    return 'unusable';
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const match = KEY_TEXT.exec(await handle.readFile('utf8'));
    return match === null ? 'unusable' : Buffer.from(match[1]!, 'hex');
  } finally {
    await handle.close();
  }
}

/** How often a process waiting on another's replacement reads the key again. */
const LOCK_POLL_MS = 25;
/** A lock this old was left by a process that stopped: a replacement takes milliseconds. */
const LOCK_STALE_MS = 10_000;

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolvePause) => setTimeout(resolvePause, milliseconds));
}

/**
 * Puts the key in place where a link cannot: over a damaged file, or on a file
 * system without hard links. A rename replaces rather than follows what is
 * there, but two processes renaming at once would each use their own key while
 * only the last stayed on disk, and the others' cache records would be refused
 * by every later build. So one process at a time does it, holding the lock
 * folder `installation-key.lock`, which only one can make: it reads the key
 * again first, since the one before it may have mended it, and the others wait
 * and read what it wrote (Codex review of #43).
 */
async function replaceKey(path: string, temporary: string, bytes: Uint8Array): Promise<Uint8Array> {
  const lock = `${path}.lock`;
  for (;;) {
    try {
      await mkdir(lock, {mode: 0o700});
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') {
        throw error;
      }
      const existing = await readKey(path);
      if (existing instanceof Uint8Array) {
        return existing;
      }
      const held = await lstat(lock).catch(() => null);
      if (held !== null && Date.now() - held.mtimeMs > LOCK_STALE_MS) {
        await rm(lock, {recursive: true, force: true});
      } else {
        await pause(LOCK_POLL_MS);
      }
      continue;
    }
    try {
      const existing = await readKey(path);
      if (existing instanceof Uint8Array) {
        return existing;
      }
      await rename(temporary, path);
      return bytes;
    } finally {
      await rm(lock, {recursive: true, force: true});
    }
  }
}

/**
 * Makes the key file whole: its text is written to a file of its own and
 * linked into place, so no process reads a key without its text, and of two
 * processes making it at once one wins and the other reads the winner's. A
 * damaged file, or a file system without hard links, gets the key renamed
 * into place by `replaceKey`, one process at a time.
 */
async function makeKey(folder: string, path: string): Promise<Uint8Array> {
  await mkdir(folder, {recursive: true, mode: 0o700});
  const bytes = randomBytes(32);
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, `${bytes.toString('hex')}\n`, {flag: 'wx', mode: 0o600});
  try {
    try {
      await link(temporary, path);
      return bytes;
    } catch (error) {
      if (codeOf(error) === 'EEXIST') {
        const existing = await readKey(path);
        if (existing instanceof Uint8Array) {
          return existing;
        }
      } else if (!NO_HARD_LINKS.has(String(codeOf(error)))) {
        throw error;
      }
    }
    return await replaceKey(path, temporary, bytes);
  } finally {
    await rm(temporary, {force: true});
  }
}

async function loadKey(folder: string | null): Promise<InstallationKey> {
  if (folder !== null) {
    try {
      const path = join(folder, INSTALLATION_KEY_FILE);
      const existing = await readKey(path);
      return {bytes: existing instanceof Uint8Array ? existing : await makeKey(folder, path), persistent: true};
    } catch {
      // The folder cannot hold a key; the process makes do with its own below.
    }
  }
  return {bytes: randomBytes(32), persistent: false};
}

const keys = new Map<string | null, Promise<InstallationKey>>();

/** The installation key kept in `folder`, the state folder by default; read or made once per process and folder. */
export function installationKey(folder: string | null = stateFolder()): Promise<InstallationKey> {
  let pending = keys.get(folder);
  if (pending === undefined) {
    pending = loadKey(folder);
    keys.set(folder, pending);
  }
  return pending;
}
