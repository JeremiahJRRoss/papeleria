/**
 * M2.1: watching a piece for changes made outside the editor (IC06, D82).
 *
 * What a piece is made of lives in two places: the manifest at the top of the
 * piece folder and everything under `assets/`. The watcher looks at exactly
 * those — the piece folder itself, `assets/` and every folder below it — so
 * `dist/`, `.papeleria/` (staging, previews, backups, the image cache),
 * `node_modules/` and `lib/` are excluded by construction rather than filtered
 * from a flood of events. Names starting with a dot are ignored too: that
 * covers the editor's own temporary files and editors' swap files, and no
 * piece path may start with one.
 *
 * Each folder has a watcher of its own, not one recursive watcher: a folder's
 * watcher reports what happens to its entries whatever file is behind them,
 * while Node's recursive watcher on Linux loses a file once a save replaces it
 * by renaming a new file over it — which is how this editor saves, and how
 * many editors do (found by `server-saves.test.ts`). The set of folders is
 * kept up to date as folders come and go. Links are never followed.
 *
 * File-system events are hints, not facts: they coalesce, arrive twice and
 * name the wrong half of a rename. So the watcher only reports which paths
 * were touched, after 100 ms of quiet, and whoever listens looks at the disk
 * itself and compares revisions (D82).
 *
 * The system may refuse to watch: a user's inotify watchers or open files run
 * out (ENOSPC, EMFILE), or a watcher fails later. Then the session says so
 * once in its log and looks at the same files itself every two seconds,
 * reporting each whose identity, size or times changed: slower, never silent
 * (W5R-15).
 */
import {watch, type FSWatcher} from 'node:fs';
import {lstat, readdir} from 'node:fs/promises';
import {join} from 'node:path';

import {MANIFEST_FILES} from '../core/index.js';

const QUIET_MS = 100;

/** How often the piece is looked at once the system cannot watch it. */
export const POLL_MS = 2000;

export type PieceWatch = {close(): void};

export type WatchOptions = {
  /** Routine diagnostics: where a watcher the system refuses is said, once. */
  readonly log?: (line: string) => void;
  /** Stands in for `fs.watch`, for a test to fail as a full watcher table does. */
  readonly watch?: typeof watch;
  /** How often to look at the piece once watching failed, for a test. */
  readonly pollMs?: number;
};

/** The folders to watch: `assets/` and every folder below it that is a real folder, not a link. */
async function assetFolders(root: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (folder: string): Promise<void> => {
    const stat = await lstat(join(root, ...folder.split('/'))).catch(() => null);
    if (stat === null || !stat.isDirectory()) {
      return;
    }
    found.push(folder);
    const entries = await readdir(join(root, ...folder.split('/')), {withFileTypes: true}).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        await visit(`${folder}/${entry.name}`);
      }
    }
  };
  await visit('assets');
  return found;
}

/**
 * The files the touched paths stand for: a path that is a real folder stands
 * for every file below it (dot-named entries left out, links not followed),
 * any other path for itself, present or gone.
 */
export async function filesUnder(root: string, paths: Iterable<string>): Promise<Set<string>> {
  const files = new Set<string>();
  const visit = async (path: string): Promise<void> => {
    const stat = await lstat(join(root, ...path.split('/'))).catch(() => null);
    if (stat === null || !stat.isDirectory()) {
      files.add(path);
      return;
    }
    const entries = await readdir(join(root, ...path.split('/')), {withFileTypes: true}).catch(() => []);
    for (const entry of entries) {
      if (!entry.name.startsWith('.')) {
        await visit(`${path}/${entry.name}`);
      }
    }
  };
  for (const path of paths) {
    await visit(path);
  }
  return files;
}

/** What the watcher would watch, file by file, with what a write, a replacement or a removal changes: for looking when it cannot watch. */
async function fileStates(root: string): Promise<Map<string, string>> {
  const states = new Map<string, string>();
  for (const path of [...MANIFEST_FILES, ...(await filesUnder(root, ['assets']))]) {
    const stat = await lstat(join(root, ...path.split('/'))).catch(() => null);
    if (stat !== null) {
      states.set(path, `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`);
    }
  }
  return states;
}

/** A folder that went before it could be watched: not a refusal, since the next change syncs again. */
function gone(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Calls `onChange` with the piece-relative paths touched, once changes have
 * been quiet for a moment. Resolves once the piece is being watched, or
 * looked at when it cannot be, so a change made from then on is reported.
 */
export async function watchPiece(root: string, onChange: (paths: ReadonlySet<string>) => void, options: WatchOptions = {}): Promise<PieceWatch> {
  const watchWith = options.watch ?? watch;
  const pollMs = options.pollMs ?? POLL_MS;
  let closed = false;
  let timer: NodeJS.Timeout | null = null;
  const touched = new Set<string>();
  const folders = new Map<string, FSWatcher>();
  let syncing: Promise<void> = Promise.resolve();
  let top: FSWatcher | null = null;
  /** Set once the system has refused to watch: from then on the piece is looked at every `pollMs`. */
  let looking: NodeJS.Timeout | null = null;

  const report = (path: string): void => {
    if (closed || path.split('/').some((segment) => segment.startsWith('.'))) {
      return;
    }
    touched.add(path);
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      const paths = new Set(touched);
      touched.clear();
      // A folder may have come or gone: bring the watchers up to date first.
      syncing = syncing.then(sync).then(() => {
        if (!closed) {
          onChange(paths);
        }
      });
    }, QUIET_MS);
  };

  /** The system refused to watch: say so once, stop watching, and look at the files every `pollMs` instead. */
  const fail = (error: unknown): void => {
    if (closed || looking !== null) {
      return;
    }
    const reason = (error as NodeJS.ErrnoException | null)?.code ?? (error instanceof Error ? error.message : String(error));
    options.log?.(`papeleria: the piece folder cannot be watched for changes (${reason}); it is looked at every ${pollMs / 1000} s instead.`);
    top?.close();
    top = null;
    for (const watcher of folders.values()) {
      watcher.close();
    }
    folders.clear();
    let states = new Map<string, string>();
    let busy = true;
    syncing = syncing.then(async () => {
      states = await fileStates(root);
      busy = false;
    });
    looking = setInterval(() => {
      // A look still running is not queued behind again.
      if (busy) {
        return;
      }
      busy = true;
      syncing = syncing.then(async () => {
        const now = await fileStates(root);
        for (const path of new Set([...states.keys(), ...now.keys()])) {
          if (states.get(path) !== now.get(path)) {
            report(path);
          }
        }
        states = now;
        busy = false;
      });
    }, pollMs);
  };

  const watchFolder = (folder: string): void => {
    try {
      const watcher = watchWith(join(root, ...folder.split('/')), {recursive: false}, (_event, name) => {
        report(typeof name === 'string' ? `${folder}/${name}` : folder);
      });
      watcher.on('error', () => {
        watcher.close();
        folders.delete(folder);
        report(folder);
      });
      folders.set(folder, watcher);
    } catch (error) {
      if (!gone(error)) {
        fail(error);
      }
    }
  };

  const sync = async (): Promise<void> => {
    if (closed || looking !== null) {
      return;
    }
    const wanted = new Set(await assetFolders(root));
    for (const [folder, watcher] of [...folders]) {
      if (!wanted.has(folder)) {
        watcher.close();
        folders.delete(folder);
      }
    }
    for (const folder of wanted) {
      if (!folders.has(folder) && !closed && looking === null) {
        watchFolder(folder);
      }
    }
  };

  try {
    top = watchWith(root, {recursive: false}, (_event, name) => {
      if (typeof name !== 'string') {
        return;
      }
      if ((MANIFEST_FILES as readonly string[]).includes(name) || name === 'assets') {
        report(name);
      }
    });
    top.on('error', (error) => fail(error));
  } catch (error) {
    fail(error);
  }
  syncing = syncing.then(sync);
  // A folder the system refuses on the way adds the first look to the chain: wait for the chain as it ends.
  let settled: Promise<void>;
  do {
    settled = syncing;
    await settled;
  } while (settled !== syncing);

  return {
    close(): void {
      closed = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      if (looking !== null) {
        clearInterval(looking);
      }
      top?.close();
      for (const watcher of folders.values()) {
        watcher.close();
      }
      folders.clear();
    },
  };
}
