/**
 * B9 of the code provenance review (docs/CODE_PROVENANCE_REVIEW_2026-09-28.md
 * §5.3; D144): every image, font, video, audio or archive file under the
 * application root has one provenance entry in
 * `docs/evidence/binary-provenance.json`, which says which script made it or
 * which upstream, version and licence it came from.
 *
 * The files are those git tracks or would commit (`git ls-files --cached
 * --others --exclude-standard`), so the installed `node_modules/`, the
 * compiled `lib/`, a piece's `dist/` and `.papeleria/` and a test run's
 * `test-results/`, all ignored, never count. An entry covers exactly the
 * number of files it states, so a new binary fails here until someone has
 * written down where it came from.
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';

import {applicationRoot} from '../helpers/paths.js';

type Entry = {readonly pattern: string; readonly count: number; readonly source: string};
type Record = {readonly extensions: readonly string[]; readonly entries: readonly Entry[]};

const record = JSON.parse(readFileSync(join(applicationRoot, 'docs', 'evidence', 'binary-provenance.json'), 'utf8')) as Record;

/** A pattern as a regular expression: `**` any folders, `*` any name within one folder. */
function patternExpression(pattern: string): RegExp {
  const source = pattern
    .split('/')
    .map((part) => (part === '**' ? '(?:[^/]+/)*' : `${part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}/`))
    .join('');
  return new RegExp(`^${source.slice(0, -1)}$`);
}

/** Every file git tracks or would commit under the application root, as root-relative paths. */
function committedFiles(): string[] {
  const listing = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {cwd: applicationRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
  return [...new Set(listing.split('\0').filter((path) => path !== ''))].sort();
}

test('B9: every binary has exactly one provenance entry, and every entry covers exactly the files it states', () => {
  const extensions = new Set(record.extensions);
  const binaries = committedFiles().filter((path) => extensions.has(path.slice(path.lastIndexOf('.') + 1).toLowerCase()));
  assert.ok(binaries.length > 0, 'no binary found: the listing did not run where it should');
  const expressions = record.entries.map((entry) => ({entry, expression: patternExpression(entry.pattern)}));
  const unexplained: string[] = [];
  const doubled: string[] = [];
  const covered = new Map<Entry, number>();
  for (const path of binaries) {
    const matches = expressions.filter(({expression}) => expression.test(path));
    if (matches.length === 0) {
      unexplained.push(path);
    } else if (matches.length > 1) {
      doubled.push(`${path}: ${matches.map(({entry}) => entry.pattern).join(', ')}`);
    }
    for (const {entry} of matches) {
      covered.set(entry, (covered.get(entry) ?? 0) + 1);
    }
  }
  assert.deepEqual(unexplained, [], 'a binary with no provenance entry: say where it came from in docs/evidence/binary-provenance.json');
  assert.deepEqual(doubled, [], 'a binary two entries cover');
  for (const entry of record.entries) {
    assert.equal(covered.get(entry) ?? 0, entry.count, `${entry.pattern} states ${entry.count} file(s)`);
    assert.ok(entry.source.trim().length > 0, `${entry.pattern} says nothing about where its files came from`);
  }
});

test('B9: the pattern reader matches as documented', () => {
  assert.ok(patternExpression('theme/fonts/inter-*.woff2').test('theme/fonts/inter-400-700-latin.woff2'));
  assert.ok(!patternExpression('theme/fonts/inter-*.woff2').test('theme/fonts/sub/inter-x.woff2'), '* stays within one folder');
  assert.ok(patternExpression('test/golden/baselines/brand-overview/**/*.png').test('test/golden/baselines/brand-overview/390x844/01-cover.png'));
  assert.ok(patternExpression('test/fixtures/brand/**/*.svg').test('test/fixtures/brand/with-owner-copy/brand/fixture-owner-mark.svg'));
  assert.ok(!patternExpression('test/fixtures/brand/**/*.svg').test('test/fixtures/brandx/a.svg'));
  assert.ok(patternExpression('a/**/b.png').test('a/b.png'), '** also matches no folder');
});
