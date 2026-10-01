/**
 * M3.7: `papeleria new document` with the compiled CLI, as an author runs it
 * (IC09, D60's rule, D99). It copies the sample report into an absent or empty
 * folder and nothing else; the piece it makes checks and builds with zero
 * errors and zero warnings into a self-contained `dist/` with no script; and
 * it never writes into a folder that holds anything.
 */
import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {after, test} from 'node:test';

import {applicationRoot, runNode} from '../helpers/paths.js';
import {readTree, removeTemporaryFolders, temporaryFolder} from '../helpers/pieces.js';

after(removeTemporaryFolders);

const CLI = join(applicationRoot, 'lib', 'src', 'cli', 'index.js');
const SAMPLE = join(applicationRoot, 'templates', 'document', 'sample');

function sameTree(a: string, b: string): void {
  const left = readTree(a);
  const right = readTree(b);
  assert.deepEqual(Object.keys(left).sort(), Object.keys(right).sort());
  for (const [path, bytes] of Object.entries(left)) {
    assert.ok(Buffer.from(bytes).equals(Buffer.from(right[path]!)), path);
  }
}

test('new document copies the sample, and the piece checks and builds with zero errors and zero warnings', async () => {
  const parent = temporaryFolder('new-document');
  const piece = join(parent, 'my-report');
  const made = await runNode(CLI, ['new', 'document', piece]);
  assert.equal(made.code, 0, made.stderr);
  assert.equal(made.stdout, '');
  assert.match(made.stderr, /^Created .*my-report from the document sample \(4 files\)\.\nNext: papeleria build /);
  sameTree(piece, SAMPLE);

  const checked = await runNode(CLI, ['check', piece, '--json']);
  assert.equal(checked.code, 0, checked.stderr);
  const report = JSON.parse(checked.stdout) as {status: string; errors: number; warnings: number; findings: unknown[]; outputReason: string};
  assert.deepEqual([report.status, report.errors, report.warnings, report.outputReason], ['ok', 0, 0, 'check_only'], JSON.stringify(report.findings));

  const built = await runNode(CLI, ['build', piece]);
  assert.equal(built.code, 0, built.stderr);
  assert.match(built.stderr, /^Built .*my-report\/dist · 0 errors · 0 warnings · first view [\d,]+ of 1,048,576 bytes\n$/);
  const dist = join(piece, 'dist');
  assert.deepEqual(readdirSync(dist).sort(), ['Inter-OFL.txt', 'LICENSE', 'NOTICE.md', 'Poppins-OFL.txt', 'THIRD_PARTY.md', 'index.html', 'theme']);
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /<script\b/i, 'a document has no script (C22)');
  assert.equal(html.match(/<article class="template-page">/g)?.length, 2, 'the sample’s new_page starts a second sheet');
  assert.match(readFileSync(join(dist, 'THIRD_PARTY.md'), 'utf8'), /including the page and the stylesheets, is under the Apache License 2\.0/, 'the notice names no script a document does not have');
});

test('new document never writes into a folder that holds anything', async () => {
  const parent = temporaryFolder('new-document-refused');
  const full = join(parent, 'full');
  mkdirSync(full);
  writeFileSync(join(full, 'keep.txt'), 'mine');
  const result = await runNode(CLI, ['new', 'document', full]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /^papeleria: E_DESTINATION: .*is not empty/);
  assert.deepEqual(readdirSync(full), ['keep.txt']);
});
