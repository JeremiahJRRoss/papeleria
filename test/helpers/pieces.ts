/**
 * Piece folders for tests (W2A): read a fixture folder into memory, or copy
 * one into a temporary folder a build may write into. `dist/` and
 * `.papeleria/` are generated and never part of a fixture.
 */
import {execFileSync} from 'node:child_process';
import {chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, join, relative} from 'node:path';

const GENERATED = new Set(['dist', '.papeleria']);

/** Every regular file under `root`, by its forward-slash path relative to `root`. */
export function readTree(root: string, directory: string = root): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!GENERATED.has(entry.name)) {
        Object.assign(files, readTree(root, full));
      }
    } else if (entry.isFile()) {
      files[relative(root, full).split('\\').join('/')] = readFileSync(full);
    }
  }
  return files;
}

/** Temporary folders made by `temporaryFolder`, for `removeTemporaryFolders` in an `after` hook. */
const made: string[] = [];

export function temporaryFolder(label: string): string {
  const folder = mkdtempSync(join(tmpdir(), `papeleria-${label}-`));
  made.push(folder);
  return folder;
}

export function removeTemporaryFolders(): void {
  for (const folder of made.splice(0)) {
    rmSync(folder, {recursive: true, force: true});
  }
}

/** Copies a piece folder, generated folders left out, into a new temporary folder and returns the copy. */
export function copyPiece(source: string, label: string): string {
  const target = join(temporaryFolder(label), 'piece');
  cpSync(source, target, {recursive: true, filter: (path) => !GENERATED.has(basename(path))});
  return target;
}

/**
 * Makes a folder impossible to remove, as a file marked immutable or a folder
 * the build may not write makes one (W5R-01), and returns what undoes it; call
 * that before the folder is cleaned up. Root ignores permissions, so under
 * root a file inside is marked immutable with `chattr +i` (Linux); otherwise
 * the folder holds a read-only folder with a file in it, which no one else
 * can empty. Not for Windows, whose permissions work otherwise.
 */
export function pinFolder(folder: string): () => void {
  const inner = join(folder, 'pinned');
  mkdirSync(inner, {recursive: true});
  const file = join(inner, 'file');
  writeFileSync(file, 'pinned');
  if (process.getuid?.() === 0) {
    execFileSync('chattr', ['+i', file]);
    return () => execFileSync('chattr', ['-i', file]);
  }
  chmodSync(inner, 0o555);
  return () => chmodSync(inner, 0o755);
}
