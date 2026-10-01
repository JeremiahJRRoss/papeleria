/**
 * M1.8 / D60: `templates/deck/sample/` is the canonical starter deck, the one
 * `papeleria new deck` copies and the package ships. `examples/starter-deck/`
 * is the seeded repository example, kept byte-identical by this test: change
 * the sample, then copy it over the example (or the other way round) in the
 * same commit.
 */
import assert from 'node:assert/strict';
import {lstatSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';

import {applicationRoot} from '../helpers/paths.js';
import {readTree} from '../helpers/pieces.js';

const SAMPLE = join(applicationRoot, 'templates', 'deck', 'sample');
const EXAMPLE = join(applicationRoot, 'examples', 'starter-deck');

/** Every entry under a folder that is not a regular file or a folder, such as a link. */
function irregular(root: string, directory = root): string[] {
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      found.push(...irregular(root, path));
    } else if (!stat.isFile()) {
      found.push(path);
    }
  }
  return found;
}

test('D60: the deck sample and examples/starter-deck are the same files, byte for byte', () => {
  const sample = readTree(SAMPLE);
  const example = readTree(EXAMPLE);
  assert.deepEqual(Object.keys(sample).sort(), Object.keys(example).sort());
  for (const [path, bytes] of Object.entries(sample)) {
    assert.ok(Buffer.from(bytes).equals(Buffer.from(example[path]!)), `${path} differs; copy one over the other`);
  }
  assert.deepEqual(Object.keys(sample).sort(), ['assets/data/hours-by-phase.csv', 'assets/text/01-cover-notes.md', 'papeleria.yaml']);
});

test('IC09: the sample is self-contained regular files, with nothing generated in it', () => {
  assert.deepEqual(irregular(SAMPLE), []);
  const top = readdirSync(SAMPLE).sort();
  assert.deepEqual(top, ['assets', 'papeleria.yaml'], 'no dist/ or .papeleria/ travels with the sample');
});
