/**
 * M4.5 and the comic part of A7: examples/sample-comic, built by the compiled
 * CLI the way an author builds it, on a temporary copy so nothing is written
 * into examples/ (D71, D72).
 *
 * - It names only files it has, and has every file it names, besides the
 *   pages' provenance note (test/unit/comic-sample.test.ts keeps it identical
 *   to templates/comic/sample/).
 * - It checks and builds with zero errors, every warning listed; its notices
 *   and the engine's licence ship beside the page; its one script is
 *   reader.js.
 * - IC04: its first view, the cover and the next spread, has no limit and is
 *   reported; every phone format of every page keeps 307,200 bytes. The sizes
 *   are printed as diagnostics for the W4 record.
 */
import assert from 'node:assert/strict';
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {after, before, describe, test} from 'node:test';

import {parse} from 'yaml';

import {applicationRoot, runNode, type RunResult} from '../helpers/paths.js';
import {copyPiece, readTree, removeTemporaryFolders} from '../helpers/pieces.js';

after(removeTemporaryFolders);

const CLI = join(applicationRoot, 'lib', 'src', 'cli', 'index.js');
const EXAMPLE = join(applicationRoot, 'examples', 'sample-comic');
const NOTICES = ['LICENSE', 'NOTICE.md', 'Poppins-OFL.txt', 'Inter-OFL.txt', 'THIRD_PARTY.md', 'vendor/page-flip/LICENSE'];

type Report = {
  status: 'ok' | 'failed';
  errors: number;
  warnings: number;
  findings: {file: string; line: number | null; rule: string; severity: string; message: string}[];
  weight: {firstViewBytes: number; budgetBytes: number | null; withinBudget: boolean; largest: [string, number][]; phoneImages?: [string, number, boolean][]} | null;
  outputWritten: boolean;
  outputReason: string;
};

function assetReferences(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.startsWith('assets/') ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(assetReferences);
  }
  return value !== null && typeof value === 'object' ? Object.values(value).flatMap(assetReferences) : [];
}

test('the sample comic names only files it has, and has every file it names', () => {
  const manifest = parse(readFileSync(join(EXAMPLE, 'papeleria.yaml'), 'utf8')) as unknown;
  const named = [...new Set(assetReferences(manifest))].sort();
  const held = Object.keys(readTree(EXAMPLE)).filter((path) => path.startsWith('assets/') && !path.endsWith('README.md')).sort();
  assert.deepEqual(named, held);
  assert.equal(named.filter((path) => path.startsWith('assets/images/pages/')).length, 8);
});

describe('examples/sample-comic, built by the compiled CLI', () => {
  let piece = '';
  let checked: {code: number; report: Report; stderr: string};
  let built: RunResult;
  before(async () => {
    piece = copyPiece(EXAMPLE, 'sample-comic');
    const result = await runNode(CLI, ['check', piece, '--json']);
    checked = {code: result.code, report: JSON.parse(result.stdout) as Report, stderr: result.stderr};
    built = await runNode(CLI, ['build', piece]);
  });

  test('A7: check and build report zero errors, and every warning is listed', (context) => {
    assert.equal(checked.code, 0, checked.stderr);
    const {report} = checked;
    assert.deepEqual([report.status, report.errors, report.outputWritten, report.outputReason], ['ok', 0, false, 'check_only']);
    const warnings = report.findings.filter((finding) => finding.severity === 'warning').map((finding) => `${finding.file}:${finding.line ?? '-'} ${finding.rule} ${finding.message}`);
    for (const warning of warnings) {
      context.diagnostic(`warning: ${warning}`);
    }
    assert.deepEqual(warnings, [], 'a new warning is added to an expected list once someone has read it');
    assert.equal(built.code, 0, built.stderr);
    assert.equal(built.stdout, '');
    assert.match(built.stderr, /^Built .*dist · 0 errors · 0 warnings · first view [\d,]+ bytes · largest phone image [\d,]+ of 307,200 bytes\n$/);
    const html = readFileSync(join(piece, 'dist', 'index.html'), 'utf8');
    assert.equal(html.match(/<article class="comic-sheet" /g)?.length, 8);
    assert.equal(html.match(/<(?:button|a) class="comic-panel/g)?.length, 26, '5 panels on page 1 and 3 on each of the other seven');
  });

  test('A7: the notices and the engine\'s licence ship beside the page; the one script is reader.js', () => {
    for (const notice of NOTICES) {
      assert.ok(statSync(join(piece, 'dist', notice)).isFile(), `${notice} is missing from dist/`);
    }
    const html = readFileSync(join(piece, 'dist', 'index.html'), 'utf8');
    assert.deepEqual([...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1]), ['reader.js']);
    assert.ok(readFileSync(join(piece, 'dist', 'reader.js')).equals(readFileSync(join(applicationRoot, 'lib', 'clients', 'reader.js'))));
    assert.ok(readdirSync(join(piece, 'dist', 'assets', 'images', 'pages')).includes('01.png'), 'page 1 has a zoom: its original is published');
  });

  test('IC04: the first view has no limit and is reported; every phone format of every page keeps 307,200 bytes', (context) => {
    const weight = checked.report.weight;
    assert.ok(weight !== null);
    assert.equal(weight.budgetBytes, null);
    assert.equal(weight.withinBudget, true);
    context.diagnostic(`first view (the cover and the next spread): ${weight.firstViewBytes.toLocaleString('en-US')} bytes; largest: ${weight.largest.map(([path, bytes]) => `${path} ${bytes.toLocaleString('en-US')}`).join('; ')}`);
    const phone = weight.phoneImages ?? [];
    const formats = new Set(phone.map(([path]) => path.slice(path.lastIndexOf('.') + 1)));
    assert.equal(phone.length, 8 * formats.size, 'every page, in every format written at its phone width');
    for (const [path, bytes, within] of phone) {
      assert.match(path, /^assets\/images\/pages\/0[1-8]\.[0-9a-f]{16}\.800\.(?:webp|avif)$/);
      assert.ok(within && bytes <= 307_200, `${path} is ${bytes} bytes`);
      context.diagnostic(`phone image ${path}: ${bytes.toLocaleString('en-US')} bytes`);
    }
    // The first view counts the page, its files and the cover spread's images: at least what dist/ holds for the rest.
    const dist = join(piece, 'dist');
    const html = readFileSync(join(dist, 'index.html'), 'utf8');
    const referenced = [
      ...Array.from(html.matchAll(/<link rel="(?:stylesheet|icon)" href="([^"]+)"(?! media="print")/g), (match) => match[1]!),
      'reader.js',
    ];
    const fixed = ['index.html', ...referenced].reduce((sum, path) => sum + statSync(join(dist, path)).size, 0);
    assert.ok(weight.firstViewBytes > fixed, 'the images of pages 1 to 3 are counted besides the page and its files');
  });
});
