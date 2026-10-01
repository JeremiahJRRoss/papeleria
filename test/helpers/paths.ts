/**
 * Test helpers: locate the application root and the fixture tree, and run a
 * check script the way an npm script or CI runs it.
 *
 * Fixtures are read from the repository, never from the compiled `lib/` tree,
 * so the same fixture bytes back both `npm test` and the check scripts.
 */
import {spawn} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

function findApplicationRoot(start: string): string {
  let directory = start;
  for (;;) {
    const candidate = join(directory, 'package.json');
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as {name?: unknown};
      if (parsed.name === 'papeleria') {
        return directory;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error('the papeleria application root was not found above the test files');
    }
    directory = parent;
  }
}

/** The application root, which is the repository root. */
export const applicationRoot = findApplicationRoot(dirname(fileURLToPath(import.meta.url)));

/** A path inside `test/fixtures/`. */
export function fixturePath(...parts: readonly string[]): string {
  return join(applicationRoot, 'test', 'fixtures', ...parts);
}

/** A path inside `scripts/`. */
export function scriptPath(name: string): string {
  return join(applicationRoot, 'scripts', name);
}

export type RunResult = {code: number; stdout: string; stderr: string};

/** Runs a Node entry point from the application root and collects its output. */
export function runNode(entry: string, args: readonly string[] = []): Promise<RunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: applicationRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      resolvePromise({code: code ?? -1, stdout, stderr});
    });
  });
}

/** Runs one of the `scripts/*.mjs` check entry points. */
export function runCheckScript(name: string, args: readonly string[] = []): Promise<RunResult> {
  return runNode(scriptPath(name), args);
}
