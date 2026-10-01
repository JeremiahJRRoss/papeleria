/**
 * The code provenance review's B1 and B2 (review §5.3, issue 002 F5, D181):
 * `scripts/provenance-check.mjs` reads own code for the markers a copy's
 * declaration carries, and code and markup for the shape of a pasted build,
 * and each hit passes only when an entry in `scripts/provenance-allowlist.json`
 * reads it. The repository is checked on every `npm test`, beside planted
 * cases in temporary folders.
 */
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {after, test} from 'node:test';
import {pathToFileURL} from 'node:url';

import {applicationRoot, scriptPath} from '../helpers/paths.js';

type Hit = {file: string; line?: number; markers?: string[]; text?: string; longest?: number; bytes?: number};
type Part = {uncovered: Hit[]; problems: string[]};
type Entry = Record<string, unknown>;
type Result = {files: number; markers: Hit[]; shapes: Hit[]; b1: Part; b2: Part; pass: boolean};
type ProvenanceModule = {
  repositoryFiles(root: string): string[];
  checkProvenance(options: {root: string; files: readonly string[]; allowlist: {markers?: Entry[]; shapes?: Entry[]}}): Result;
  patternExpression(pattern: string): RegExp;
  report(result: Result): string;
};

const provenance = (await import(pathToFileURL(scriptPath('provenance-check.mjs')).href)) as ProvenanceModule;

const workspace = mkdtempSync(join(tmpdir(), 'papeleria-provenance-'));
after(() => rmSync(workspace, {recursive: true, force: true}));

let planted = 0;
/** A folder holding the given files; returns its root and their paths. */
function tree(files: Record<string, string>): {root: string; files: string[]} {
  const root = join(workspace, `tree-${(planted += 1)}`);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), {recursive: true});
    writeFileSync(join(root, path), text);
  }
  return {root, files: Object.keys(files).sort()};
}

const reading = {reading: 'what the line is', decision: 'D181'};

test('B1 and B2 pass on the repository: every hit is read by an entry, and every entry reads what it says', () => {
  const allowlist = JSON.parse(readFileSync(scriptPath('provenance-allowlist.json'), 'utf8')) as {markers: Entry[]; shapes: Entry[]};
  const result = provenance.checkProvenance({root: applicationRoot, files: provenance.repositoryFiles(applicationRoot), allowlist});
  assert.ok(result.pass, provenance.report(result));
  assert.ok(result.markers.some((hit) => hit.file === 'src/core/charts.ts'), 'D41’s copy is found by its marker');
  assert.ok(result.shapes.some((hit) => hit.file === 'theme/css/site.css'), 'the minified theme is found by its shape');
});

test('B1 finds a pasted snippet by its declaration, and not the words when they mean something else', () => {
  const {root, files} = tree({
    'src/pasted.ts': '// adapted from https://stackoverflow.com/a/1234\nexport const x = 1;\n',
    'src/fine.ts': [
      '// a stack overflow is avoided by walking iteratively',
      '// the value is exported from core and imported from there',
      '// see https://github.com/JeremiahJRRoss/Dev_Papeleria/issues/1',
      'export const y = 2;',
      '',
    ].join('\n'),
    'src/other.ts': '// from https://github.com/someone/else/blob/main/a.js, @license MIT\n',
    'test/fixtures/data/copied.ts': '// copied from somewhere, as a fixture may be\n',
    'theme/fonts/Face-OFL.txt': 'Copyright 2020 The Face Project Authors\n',
    'docs/notes.md': 'Adapted from a talk; documents are not own code.\n',
  });
  const result = provenance.checkProvenance({root, files, allowlist: {}});
  assert.equal(result.pass, false);
  assert.deepEqual(
    result.b1.uncovered.map((hit) => [hit.file, hit.line, hit.markers]),
    [
      ['src/other.ts', 1, ['code-host URL', '@license']],
      ['src/pasted.ts', 1, ['adapted from', 'Stack Overflow']],
    ],
  );
});

test('B1 entries: a hit passes only when one entry names its line, with the count it states', () => {
  const {root, files} = tree({'src/a.ts': '// the key is taken from the file\n// and taken from the cache\n// the value is taken from the cache\n'});
  const check = (markers: Entry[]): Result => provenance.checkProvenance({root, files, allowlist: {markers}});
  const fileEntry: Entry = {file: 'src/a.ts', line: 'taken from the file', count: 1, kind: 'not-a-copy', ...reading};
  const cacheEntry: Entry = {file: 'src/a.ts', line: 'taken from the cache', count: 2, kind: 'not-a-copy', ...reading};
  assert.ok(check([fileEntry, cacheEntry]).pass, provenance.report(check([fileEntry, cacheEntry])));
  const miscounted = check([fileEntry, {...cacheEntry, count: 1}]);
  assert.match(miscounted.b1.problems.join('\n'), /covers 2 hit\(s\), and states 1/);
  const stale = check([fileEntry, cacheEntry, {file: 'src/gone.ts', line: 'taken from the gone', count: 1, kind: 'not-a-copy', ...reading}]);
  assert.match(stale.b1.problems.join('\n'), /src\/gone\.ts\) covers nothing/);
  const twice = check([fileEntry, cacheEntry, {file: 'src/a.ts', line: 'the key is taken from', count: 1, kind: 'not-a-copy', ...reading}]);
  assert.match(twice.b1.problems.join('\n'), /src\/a\.ts:1: covered by 2 entries/);
  const unread = check([{...fileEntry, reading: ' ', decision: 'soon'}, cacheEntry]);
  assert.match(unread.b1.problems.join('\n'), /no reading/);
  assert.match(unread.b1.problems.join('\n'), /no decision row/);
});

test('B1 entries name the line they read: a file-wide entry, a text without a marker and a line that gains one all fail', () => {
  const {root, files} = tree({'src/a.ts': '// the key is taken from the file\n'});
  const check = (markers: Entry[]): Result => provenance.checkProvenance({root, files, allowlist: {markers}});
  const wildcard = check([{file: 'src/a.ts', line: '*', count: 1, kind: 'not-a-copy', ...reading}]);
  assert.match(wildcard.b1.problems.join('\n'), /holds no marker/);
  const unmarked = check([{file: 'src/a.ts', line: 'the key is', count: 1, kind: 'not-a-copy', ...reading}]);
  assert.match(unmarked.b1.problems.join('\n'), /holds no marker/);
  const gained = tree({'src/a.ts': '// the key is taken from the file, see https://github.com/someone/else\n'});
  const read = provenance.checkProvenance({root: gained.root, files: gained.files, allowlist: {markers: [{file: 'src/a.ts', line: 'taken from the file', count: 1, kind: 'not-a-copy', ...reading}]}});
  assert.deepEqual(read.b1.uncovered.map((hit) => hit.markers), [['taken from', 'code-host URL']], 'a line that gains a marker is read again');
});

test('B1: a reviewed line swapped for a new declaration in the same file fails, though the count is the same (the Codex review of PR #41)', () => {
  const entries: Entry[] = [
    {file: 'src/cache.ts', line: 'or copied from another key', count: 1, kind: 'not-a-copy', ...reading},
    {file: 'src/cache.ts', line: 'so one copied from another entry', count: 1, kind: 'not-a-copy', ...reading},
  ];
  const before = tree({'src/cache.ts': '// a record edited, or copied from another key, is damage\n// so one copied from another entry does not match\n'});
  assert.ok(provenance.checkProvenance({root: before.root, files: before.files, allowlist: {markers: entries}}).pass);
  const after = tree({'src/cache.ts': '// a record edited, or copied from another key, is damage\n// copied from https://example.com/snippet with a fix\n'});
  const swapped = provenance.checkProvenance({root: after.root, files: after.files, allowlist: {markers: entries}});
  assert.equal(swapped.pass, false);
  assert.deepEqual(swapped.b1.uncovered.map((hit) => [hit.line, hit.markers]), [[2, ['copied from']]]);
  assert.match(swapped.b1.problems.join('\n'), /\(src\/cache\.ts\) covers nothing/, 'the reading of the line that went covers nothing');
});

test('B1: a copy passes only when COPIED lists it for that file, so that THIRD_PARTY.md §2 names it', () => {
  const {root, files} = tree({
    'src/core/charts.ts': '// D41: fixed locale definitions, copied from d3-format 3.1.2 and d3-time-format 4.1.0\n',
    'src/elsewhere.ts': '// copied from d3-format 3.1.2\n',
  });
  const copyOf = (file: string, copy: Entry): Entry => ({file, line: 'copied from d3-format 3.1.2', count: 1, kind: 'copy', copy, ...reading});
  const listed = provenance.checkProvenance({root, files, allowlist: {markers: [copyOf('src/core/charts.ts', {package: 'd3-format', version: '3.1.2'}), copyOf('src/elsewhere.ts', {package: 'd3-format', version: '3.1.2'})]}});
  assert.deepEqual(listed.b1.problems.filter((problem) => /COPIED/.test(problem)).length, 1, listed.b1.problems.join('\n'));
  assert.match(listed.b1.problems.join('\n'), /COPIED \(scripts\/license-inventory\.mjs\) for src\/elsewhere\.ts/);
  const wrongVersion = provenance.checkProvenance({root, files, allowlist: {markers: [copyOf('src/core/charts.ts', {package: 'd3-format', version: '3.1.1'})]}});
  assert.match(wrongVersion.b1.problems.join('\n'), /must be listed in COPIED/);
});

test('B2 finds minified or oversized code and markup outside the declared doors, and nothing else', () => {
  const minified = `.a{color:red}${'.b{margin:0}'.repeat(60)}\n`;
  const {root, files} = tree({
    'theme/css/pasted.css': minified,
    'src/big.ts': `${'export const value = 1;\n'.repeat(4_500)}`,
    'vendor/engine/engine.js': minified,
    'licenses/TEXT.txt': 'x'.repeat(600),
    'docs/long.md': `${'word '.repeat(200)}\n`,
    'test/fixtures/data/rows.csv': `${'1,'.repeat(400)}\n`,
    'src/fine.ts': 'export const fine = true;\n',
  });
  const result = provenance.checkProvenance({root, files, allowlist: {}});
  assert.deepEqual(result.b2.uncovered.map((hit) => hit.file), ['src/big.ts', 'theme/css/pasted.css']);
  const entries = [
    {file: 'theme/css/pasted.css', count: 1, ...reading},
    {pattern: 'src/**/*.ts', count: 1, ...reading},
  ];
  assert.ok(provenance.checkProvenance({root, files, allowlist: {shapes: entries}}).b2.problems.length === 0);
  const miscounted = provenance.checkProvenance({root, files, allowlist: {shapes: [{pattern: 'src/**/*.ts', count: 2, ...reading}]}});
  assert.match(miscounted.b2.problems.join('\n'), /covers 1 hit\(s\), and states 2/);
  const both = provenance.checkProvenance({root, files, allowlist: {shapes: [{file: 'src/big.ts', pattern: 'src/*.ts', count: 1, ...reading}]}});
  assert.match(both.b2.problems.join('\n'), /names a file or a pattern/);
});

test('a pattern’s ** crosses folders and its * stays within one name', () => {
  const html = provenance.patternExpression('test/fixtures/**/*.html');
  assert.ok(html.test('test/fixtures/page.html'));
  assert.ok(html.test('test/fixtures/deck/layouts/01-cover.html'));
  assert.ok(!html.test('test/fixtures/deck/page.htmlx'));
  const svg = provenance.patternExpression('test/fixtures/localization/comic/*/assets/images/pages/01.svg');
  assert.ok(svg.test('test/fixtures/localization/comic/en/assets/images/pages/01.svg'));
  assert.ok(!svg.test('test/fixtures/localization/comic/en/extra/assets/images/pages/01.svg'));
});
