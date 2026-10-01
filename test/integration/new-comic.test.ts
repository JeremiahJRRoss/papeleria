/**
 * M4.8: `papeleria new comic` with the compiled CLI, as an author runs it
 * (IC09, D60's rule, D119). It copies the sample comic into an absent or
 * empty folder and nothing else; the piece it makes checks and builds with
 * zero errors and zero warnings into a self-contained `dist/` whose one script
 * is reader.js, with the engine's licence beside it; and it never writes into
 * a folder that holds anything.
 */
import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {after, test} from 'node:test';

import {applicationRoot, runNode} from '../helpers/paths.js';
import {readTree, removeTemporaryFolders, temporaryFolder} from '../helpers/pieces.js';

after(removeTemporaryFolders);

const CLI = join(applicationRoot, 'lib', 'src', 'cli', 'index.js');
const SAMPLE = join(applicationRoot, 'templates', 'comic', 'sample');

function sameTree(a: string, b: string): void {
  const left = readTree(a);
  const right = readTree(b);
  assert.deepEqual(Object.keys(left).sort(), Object.keys(right).sort());
  for (const [path, bytes] of Object.entries(left)) {
    assert.ok(Buffer.from(bytes).equals(Buffer.from(right[path]!)), path);
  }
}

test('new comic copies the sample, and the piece checks and builds with zero errors and zero warnings', async () => {
  const parent = temporaryFolder('new-comic');
  const piece = join(parent, 'my-comic');
  const made = await runNode(CLI, ['new', 'comic', piece]);
  assert.equal(made.code, 0, made.stderr);
  assert.equal(made.stdout, '');
  assert.match(made.stderr, /^Created .*my-comic from the comic sample \(11 files\)\.\nNext: papeleria build /);
  sameTree(piece, SAMPLE);

  const checked = await runNode(CLI, ['check', piece, '--json']);
  assert.equal(checked.code, 0, checked.stderr);
  const report = JSON.parse(checked.stdout) as {status: string; errors: number; warnings: number; findings: unknown[]; outputReason: string};
  assert.deepEqual([report.status, report.errors, report.warnings, report.outputReason], ['ok', 0, 0, 'check_only'], JSON.stringify(report.findings));

  const built = await runNode(CLI, ['build', piece]);
  assert.equal(built.code, 0, built.stderr);
  assert.match(built.stderr, /^Built .*my-comic\/dist · 0 errors · 0 warnings · first view [\d,]+ bytes · largest phone image [\d,]+ of 307,200 bytes\n$/);
  const dist = join(piece, 'dist');
  assert.deepEqual(readdirSync(dist).sort(), ['Inter-OFL.txt', 'LICENSE', 'NOTICE.md', 'Poppins-OFL.txt', 'THIRD_PARTY.md', 'assets', 'index.html', 'reader.js', 'theme', 'vendor']);
  assert.deepEqual(readdirSync(join(dist, 'vendor', 'page-flip')), ['LICENSE']);
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  assert.deepEqual([...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1]), ['reader.js'], 'one script (C22)');
  assert.equal(html.match(/<article class="comic-sheet"/g)?.length, 8);
  assert.ok(readFileSync(join(dist, 'reader.js')).equals(readFileSync(join(applicationRoot, 'lib', 'clients', 'reader.js'))));
});

test('new comic never writes into a folder that holds anything', async () => {
  const parent = temporaryFolder('new-comic-refused');
  const full = join(parent, 'full');
  mkdirSync(full);
  writeFileSync(join(full, 'keep.txt'), 'mine');
  const result = await runNode(CLI, ['new', 'comic', full]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /^papeleria: E_DESTINATION: .*is not empty/);
  assert.deepEqual(readdirSync(full), ['keep.txt']);
});
