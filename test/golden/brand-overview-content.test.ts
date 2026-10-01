/**
 * M1.9, content half: the brand-overview piece carries the reference deck's
 * text, and the check that says so fails on each kind of transcription error.
 *
 * Every negative case copies the real piece, or the real reference, into a
 * temporary directory and changes exactly one thing, so the fixtures cannot
 * drift from the files they test. The check runs as a child process, the same
 * code path `npm run check:brand-overview-content` takes.
 *
 * This is not the A4 golden test. W2B compares the built deck with the
 * reference in a browser.
 */
import assert from 'node:assert/strict';
import {cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, test} from 'node:test';

import {applicationRoot, runCheckScript, type RunResult} from '../helpers/paths.js';

const script = 'check-brand-overview-content.mjs';
const realPiece = join(applicationRoot, 'examples', 'brand-overview');
const realReference = join(applicationRoot, 'reference', 'decks', 'brand-overview.html');

const temporaryRoots: string[] = [];

after(() => {
  for (const directory of temporaryRoots) {
    rmSync(directory, {recursive: true, force: true});
  }
});

function temporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), 'papeleria-brand-overview-'));
  temporaryRoots.push(directory);
  return directory;
}

/** A copy of the committed piece. */
function copyPiece(): string {
  const piece = join(temporaryRoot(), 'brand-overview');
  cpSync(realPiece, piece, {recursive: true});
  return piece;
}

/** A copy of the reference deck. */
function copyReference(): string {
  const reference = join(temporaryRoot(), 'brand-overview.html');
  cpSync(realReference, reference);
  return reference;
}

/** Replaces the first match in a file and fails the test if nothing matched. */
function edit(file: string, search: string | RegExp, replacement: string): void {
  const before = readFileSync(file, 'utf8');
  const after = before.replace(search, replacement);
  assert.notEqual(after, before, `the fixture edit ${String(search)} did not apply to ${file}`);
  writeFileSync(file, after);
}

function check(piece: string, reference?: string): Promise<RunResult> {
  return runCheckScript(script, reference === undefined ? ['--piece', piece] : ['--piece', piece, '--reference', reference]);
}

function assertFails(result: RunResult, ...patterns: RegExp[]): void {
  assert.equal(result.code, 1, `expected exit 1\n${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /result: FAIL — \d+ difference\(s\)/);
  for (const pattern of patterns) {
    assert.match(result.stdout, pattern);
  }
}

test('the committed piece matches the reference with zero differences', async () => {
  const result = await runCheckScript(script);
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /reference: 16 slide\(s\); layouts cover, two, three, statement, attributes, palette, type, wordmark, three, three, three, statement, two, four, attributes, closing/);
  assert.match(result.stdout, /compared: 122 field\(s\) at source level, 122 rendered by the product, 16 notes file\(s\) holding 23 paragraph\(s\)/);
  assert.match(result.stdout, /unclaimed reference text: 0/);
  assert.match(result.stdout, /document title: "Brand overview · Papeleria slides"/);
  assert.match(result.stdout, /result: pass — 16 slides, 0 differences/);
});

test('the piece holds sixteen notes files and no credits, logo or wordmark', () => {
  const notes = readdirSync(join(realPiece, 'assets', 'text')).sort();
  assert.deepEqual(notes, Array.from({length: 16}, (_, index) => `${String(index + 1).padStart(2, '0')}-notes.md`));
  const manifest = readFileSync(join(realPiece, 'papeleria.yaml'), 'utf8');
  assert.doesNotMatch(manifest, /^(credits|logo|wordmark):/m);
});

test('a title whose hard break is lost fails at its line', async () => {
  const piece = copyPiece();
  edit(
    join(piece, 'papeleria.yaml'),
    '- layout: cover\n    title: |-\n      Craft with care.\\\n      Build for the long view.',
    '- layout: cover\n    title: Craft with care. Build for the long view.',
  );
  assertFails(await check(piece), /slide 1 \(cover\) title, papeleria\.yaml:17: expected "Craft with care\.\\\\\\nBuild for the long view\."/);
});

test('a hard break written as two trailing spaces fails, although it renders the same (D55)', async () => {
  const piece = copyPiece();
  edit(join(piece, 'papeleria.yaml'), '      Two sources.\\\n', '      Two sources.  \n');
  assertFails(await check(piece), /slide 2 \(two\) title, papeleria\.yaml:\d+: .*not as trailing spaces \(D55\)/);
});

test('a relabelled layout fails on the sequence and on its column count (R15)', async () => {
  const piece = copyPiece();
  edit(join(piece, 'papeleria.yaml'), /- layout: three(\n {4}title: \|-\n {6}The record should)/, '- layout: two$1');
  assertFails(
    await check(piece),
    /layout sequence differs/,
    /slide 9 \(three\) layout, papeleria\.yaml:\d+: expected "three", found "two"/,
    /slide 9 \(three\) columns, papeleria\.yaml:\d+: the two layout takes 2 columns \(R15\); the manifest gives 3/,
  );
});

test('a changed word in the notes fails, naming the file and the paragraph', async () => {
  const piece = copyPiece();
  edit(join(piece, 'assets', 'text', '04-notes.md'), 'artisan care', 'artisanal care');
  assertFails(await check(piece), /slide 4 \(statement\) notes, assets\/text\/04-notes\.md paragraph 1: at character \d+/);
});

test('a URL turned into a Markdown link or an autolink fails', async () => {
  const linked = copyPiece();
  edit(join(linked, 'assets', 'text', '02-notes.md'), 'https://www.ross.moda/', '[the live page](https://www.ross.moda/)');
  assertFails(
    await check(linked),
    /slide 2 \(two\) notes, assets\/text\/02-notes\.md: holds bracketed text/,
    /slide 2 \(two\) notes, assets\/text\/02-notes\.md paragraph 1: at character 32: expected/,
  );

  const autolinked = copyPiece();
  edit(join(autolinked, 'assets', 'text', '12-notes.md'), /(https:\/\/github\.com\S+)/, '<$1>');
  assertFails(await check(autolinked), /slide 12 \(statement\) notes, assets\/text\/12-notes\.md paragraph 1: at character 21: expected/);
});

test('credits at the top level fail as an unexpected key', async () => {
  const piece = copyPiece();
  edit(join(piece, 'papeleria.yaml'), 'status: review\n', 'status: review\ncredits:\n  - { role: Author, name: "[Approved credit]" }\n');
  assertFails(await check(piece), /manifest credits, papeleria\.yaml:\d+: unexpected key; this piece carries schema, template, title, language, status, register, edition, slides only \(D55\)/);
});

test('a bracketed placeholder in a lead fails as R01', async () => {
  const piece = copyPiece();
  edit(join(piece, 'papeleria.yaml'), 'lead: Papeleria templates', 'lead: "[Papeleria templates]"');
  assertFails(await check(piece), /slide 1 \(cover\) lead, papeleria\.yaml:\d+: holds bracketed text; the kit has none, and an unescaped label is an R01 placeholder/);
});

test('a lowercase swatch value fails', async () => {
  const piece = copyPiece();
  edit(join(piece, 'papeleria.yaml'), 'value: "#EB3A96"', 'value: "#eb3a96"');
  assertFails(await check(piece), /slide 6 \(palette\) swatch 2 value, papeleria\.yaml:\d+: expected "#EB3A96", found "#eb3a96"/);
});

test('a footer that repeats the edition fails as redundant', async () => {
  const piece = copyPiece();
  edit(join(piece, 'papeleria.yaml'), '    lead: Papeleria templates\n', '    lead: Papeleria templates\n    footer: Version 1.1.0 / 2026-09-05\n');
  assertFails(await check(piece), /slide 1 \(cover\) footer, papeleria\.yaml:\d+: repeats the edition; omit it/);
});

test('a missing notes file fails, naming it', async () => {
  const piece = copyPiece();
  unlinkSync(join(piece, 'assets', 'text', '07-notes.md'));
  assertFails(await check(piece), /slide 7 \(type\) notes, assets\/text\/07-notes\.md: the file is missing \(R02\)/);
});

test('a notes paragraph wrapped over two lines fails, because the notes keep line breaks', async () => {
  const piece = copyPiece();
  edit(join(piece, 'assets', 'text', '01-notes.md'), '. The connective', '.\nThe connective');
  assertFails(await check(piece), /slide 1 \(cover\) notes, assets\/text\/01-notes\.md paragraph 1: is wrapped over several lines/);
});

test('a backslash-escaped punctuation character is the same text', async () => {
  const piece = copyPiece();
  edit(join(piece, 'papeleria.yaml'), 'source-backed basis.', 'source\\-backed basis.');
  const result = await check(piece);
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /result: pass — 16 slides, 0 differences/);
});

test('text that is right at source level but renders as markup fails at render level', async () => {
  const piece = copyPiece();
  const reference = copyReference();
  edit(reference, 'Five working attributes—not five', 'Five working attributes—*not* five');
  edit(join(piece, 'papeleria.yaml'), 'Five working attributes—not five', 'Five working attributes—*not* five');
  assertFails(await check(piece, reference), /slide 5 \(attributes\) lead, papeleria\.yaml:\d+: the product renders ".*<em>not<\/em>.*"; the kit has/);
});

test('column text is block Markdown: a column that renders as a list fails, although its text matches', async () => {
  const piece = copyPiece();
  const reference = copyReference();
  edit(reference, '<p>What is being said?</p>', '<p>1. What is being said?</p>');
  edit(join(piece, 'papeleria.yaml'), 'text: What is being said?', 'text: 1. What is being said?');
  assertFails(await check(piece, reference), /slide 14 \(four\) column 1 text, papeleria\.yaml:\d+: the product renders "<ol>/);
});

test('a hard break renders as a bare <br>, exactly as the kit writes it (D164)', async () => {
  const result = await runCheckScript(script);
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  // The render level now compares without removing anything after a <br>, so this pass means an exact match.
  assert.match(result.stdout, /122 rendered by the product/);
});

test('a piece the product refuses fails, whatever its text: a linked notes file (D152)', async () => {
  const piece = copyPiece();
  const outside = temporaryRoot();
  const notes = join(piece, 'assets', 'text', '05-notes.md');
  cpSync(notes, join(outside, '05-notes.md'));
  unlinkSync(notes);
  symlinkSync(join(outside, '05-notes.md'), notes);
  assertFails(await check(piece), /product, papeleria\.yaml:\d+: R09 assets\/text\/05-notes\.md is a symbolic link/);
});

test('a no-break space in the reference is not matched by a plain space in the notes', async () => {
  const piece = copyPiece();
  const reference = copyReference();
  edit(reference, 'about 170 KB', 'about 170\u00a0KB');
  assertFails(await check(piece, reference), /slide 7 \(type\) notes, assets\/text\/07-notes\.md paragraph \d+:/);
});

test("text that markdown-it's typographer would change fails", async () => {
  const piece = copyPiece();
  const reference = copyReference();
  edit(reference, 'A “verified” label', 'A "verified" label');
  edit(join(piece, 'assets', 'text', '14-notes.md'), 'A “verified” label', 'A "verified" label');
  assertFails(await check(piece, reference), /slide 14 \(four\) notes, assets\/text\/14-notes\.md: markdown-it's typographer would change the notes/);
});

test('reference text that nothing claims fails, so the completeness check is not vacuous', async () => {
  const piece = copyPiece();
  const reference = copyReference();
  edit(
    reference,
    '<footer class="slide-footer"><span>Proposed brand principle</span>',
    '<p class="slide-kicker">An extra line</p><footer class="slide-footer"><span>Proposed brand principle</span>',
  );
  assertFails(
    await check(piece, reference),
    /reference: text that no manifest field or documented template content claims, at .*article#slide-4\.deck-slide\.slide-layout-statement > div\.slide-canvas > p\.slide-kicker: "An extra line"/,
  );
});

test('CRLF line endings, as a Windows checkout can produce, still pass', async () => {
  const piece = copyPiece();
  const files = [join(piece, 'papeleria.yaml'), ...readdirSync(join(piece, 'assets', 'text')).map((name) => join(piece, 'assets', 'text', name))];
  for (const file of files) {
    writeFileSync(file, readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
  }
  const result = await check(piece);
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /result: pass — 16 slides, 0 differences/);
});

test('a duplicate key stops the check with the parser message and its line (IC01)', async () => {
  const piece = copyPiece();
  edit(join(piece, 'papeleria.yaml'), 'status: review\n', 'status: review\nstatus: draft\n');
  const result = await check(piece);
  assert.equal(result.code, 2, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /papeleria\.yaml: line 12: DUPLICATE_KEY: Map keys must be unique/);
});

test('an anchor and an alias stop the check (IC01)', async () => {
  const piece = copyPiece();
  const manifest = join(piece, 'papeleria.yaml');
  edit(manifest, 'footer: Adopted / RM-D10, superseding RM-D04', 'footer: &adopted Adopted / RM-D10, superseding RM-D04');
  edit(manifest, /(\n {4}lead: Self-hosted faces keep this edition portable\.\n {4}footer: )Adopted \/ RM-D10, superseding RM-D04/, '$1*adopted');
  const result = await check(piece);
  assert.equal(result.code, 2, `${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /the anchor &adopted is not allowed \(IC01\)/);
  assert.match(result.stderr, /the alias \*adopted is not allowed \(IC01\)/);
});

test('usage and IO failures exit 2', async () => {
  const unknown = await runCheckScript(script, ['--pieces', realPiece]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown argument "--pieces"/);

  const missing = await runCheckScript(script, ['--reference', join(temporaryRoot(), 'absent.html')]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /absent\.html is missing/);
});
