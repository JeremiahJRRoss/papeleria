/**
 * Committed output snapshots for the block and deck renderer tests (W2A).
 *
 * A snapshot is a file under `test/fixtures/` holding the exact output plus a
 * final newline. `UPDATE_SNAPSHOTS=1` writes the files instead of comparing;
 * CI never sets it. A failing snapshot is a finding to explain, never a file
 * to regenerate without reading the difference.
 */
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, relative} from 'node:path';

import {applicationRoot} from './paths.js';

export function assertSnapshot(file: string, actual: string): void {
  const content = `${actual}\n`;
  if (process.env['UPDATE_SNAPSHOTS'] === '1') {
    mkdirSync(dirname(file), {recursive: true});
    writeFileSync(file, content);
    return;
  }
  const shown = relative(applicationRoot, file);
  assert.ok(existsSync(file), `${shown} is missing: review the output, then write it with UPDATE_SNAPSHOTS=1`);
  assert.equal(content, readFileSync(file, 'utf8'), `${shown} differs from the output`);
}
