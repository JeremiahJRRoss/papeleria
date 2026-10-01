/**
 * M3.7 / D99, D60's rule for the document: `templates/document/sample/` is the
 * canonical sample report, the one `papeleria new document` copies and the
 * package ships; `examples/hours-report/` is the seeded repository example,
 * kept byte-identical by this test. Change one, copy it over the other in the
 * same commit. The sample is self-contained: it names only files it has and
 * has every file it names, and carries nothing generated.
 */
import assert from 'node:assert/strict';
import {lstatSync, readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';

import {parse} from 'yaml';

import {applicationRoot} from '../helpers/paths.js';
import {readTree} from '../helpers/pieces.js';

const SAMPLE = join(applicationRoot, 'templates', 'document', 'sample');
const EXAMPLE = join(applicationRoot, 'examples', 'hours-report');

/** Every entry under a folder that is not a regular file or a folder, such as a link. */
function irregular(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    const stat = lstatSync(path);
    return stat.isDirectory() ? irregular(path) : stat.isFile() ? [] : [path];
  });
}

/** Every string in a parsed manifest that names a file under assets/. */
function assetReferences(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.startsWith('assets/') ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(assetReferences);
  }
  return value !== null && typeof value === 'object' ? Object.values(value).flatMap(assetReferences) : [];
}

test('D60, D99: the document sample and examples/hours-report are the same files, byte for byte', () => {
  const sample = readTree(SAMPLE);
  const example = readTree(EXAMPLE);
  assert.deepEqual(Object.keys(sample).sort(), Object.keys(example).sort());
  for (const [path, bytes] of Object.entries(sample)) {
    assert.ok(Buffer.from(bytes).equals(Buffer.from(example[path]!)), `${path} differs; copy one over the other`);
  }
  assert.deepEqual(Object.keys(sample).sort(), [
    'assets/data/hours-by-phase.csv',
    'assets/data/hours-by-week.csv',
    'assets/text/summary.md',
    'papeleria.yaml',
  ]);
});

test('IC09: the sample is self-contained regular files naming only what it holds, with nothing generated in it', () => {
  assert.deepEqual(irregular(SAMPLE), []);
  assert.deepEqual(readdirSync(SAMPLE).sort(), ['assets', 'papeleria.yaml'], 'no dist/ or .papeleria/ travels with the sample');
  const manifest = parse(readFileSync(join(SAMPLE, 'papeleria.yaml'), 'utf8')) as {template: string};
  assert.equal(manifest.template, 'document');
  const named = [...new Set(assetReferences(manifest))].sort();
  assert.deepEqual(named, Object.keys(readTree(SAMPLE)).filter((path) => path.startsWith('assets/')).sort(), 'every file it names is there, and it holds nothing else');
});
