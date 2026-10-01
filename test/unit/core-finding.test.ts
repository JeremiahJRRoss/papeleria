/**
 * M1.1: the IC01 finding shape, ordering and deduplication, and the position
 * helpers every stage uses to report a real line.
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  LineIndex,
  QUOTED_LENGTH,
  checkAssetPath,
  compareFindings,
  createMemoryLoaders,
  dedupeFindings,
  escapeControls,
  escapeInvisible,
  hasErrors,
  joinPointer,
  listForMessage,
  nearestEntry,
  parentPointer,
  parseCsv,
  parseManifest,
  parsePointer,
  pointerOf,
  quoteForMessage,
  quoteValue,
  readPiece,
  renderChart,
  settleFindings,
  shortenForMessage,
  sortFindings,
  traced,
  validateManifest,
  validateSvg,
  type CsvTable,
  type Finding,
  type SourceEntry,
} from '../../src/core/index.js';
import {rule as R13} from '../../src/checks/rules/R13.js';

function finding(file: string, line: number | null, column: number | null, rule: string): Finding {
  return {file, line, column, rule, severity: 'error', message: rule, fix: 'fix', detail: null};
}

test('findings sort by file, real line with null last, column with null last, then rule', () => {
  const shuffled = [
    finding('papeleria.yaml', null, null, 'R09'),
    finding('assets/text/a.md', 3, 1, 'R09'),
    finding('papeleria.yaml', 12, 5, 'R15'),
    finding('papeleria.yaml', 12, 5, 'R09'),
    finding('papeleria.yaml', 12, null, 'R03'),
    finding('papeleria.yaml', 2, 9, 'R17'),
    finding('papeleria.yaml', 12, 1, 'R10'),
  ];
  assert.deepEqual(
    sortFindings(shuffled).map((item) => `${item.file}:${item.line}:${item.column}:${item.rule}`),
    [
      'assets/text/a.md:3:1:R09',
      'papeleria.yaml:2:9:R17',
      'papeleria.yaml:12:1:R10',
      'papeleria.yaml:12:5:R09',
      'papeleria.yaml:12:5:R15',
      'papeleria.yaml:12:null:R03',
      'papeleria.yaml:null:null:R09',
    ],
  );
  assert.equal(compareFindings(shuffled[0]!, shuffled[0]!), 0);
});

test('rule ids compare numerically because they are zero-padded', () => {
  assert.ok(compareFindings(finding('f', 1, 1, 'R02'), finding('f', 1, 1, 'R10')) < 0);
});

test('deduplication keys on rule and semantic source path, not on location', () => {
  const location = {file: 'papeleria.yaml', line: 4, column: 3};
  const missingTitle = traced({rule: 'R09', message: 'no title', fix: 'f', location, sourcePath: 'papeleria.yaml#/slides/0/title'});
  const missingLayout = traced({rule: 'R09', message: 'no layout', fix: 'f', location, sourcePath: 'papeleria.yaml#/slides/0/layout'});
  const sameTitleAgain = traced({rule: 'R09', message: 'blank', fix: 'f', location, sourcePath: 'papeleria.yaml#/slides/0/title'});
  const otherRule = traced({rule: 'R03', message: 'alt', fix: 'f', location, sourcePath: 'papeleria.yaml#/slides/0/title'});
  const kept = dedupeFindings([missingTitle, missingLayout, sameTitleAgain, otherRule]);
  assert.deepEqual(
    kept.map((item) => item.finding.message),
    ['no title', 'no layout', 'alt'],
    'two missing fields of one object share a location but are two findings; the first of a repeat wins',
  );
  assert.equal(settleFindings([missingTitle, sameTitleAgain]).length, 1);
});

test('traced takes the catalogue severity and refuses a rule whose severity depends on context', () => {
  const item = traced({rule: 'R02', message: 'm', fix: 'f', location: {file: 'x', line: null, column: null}, sourcePath: 'x'});
  assert.equal(item.finding.severity, 'error');
  assert.equal(item.finding.detail, null);
  assert.ok(!('relatedLocation' in item.finding), 'relatedLocation is absent, not undefined, when there is none');
  assert.throws(
    () => traced({rule: 'R01', message: 'm', fix: 'f', location: {file: 'x', line: 1, column: 1}, sourcePath: 'x'}),
    /state it explicitly/,
  );
  const warning = traced({rule: 'R01', severity: 'warning', message: 'm', fix: 'f', location: {file: 'x', line: 1, column: 1}, sourcePath: 'x'});
  assert.equal(hasErrors([warning]), false);
  assert.equal(hasErrors([warning, item]), true);
  assert.equal(hasErrors([item.finding]), true);
});

test('a finding serialises to exactly the flat IC01 keys', () => {
  const item = traced({
    rule: 'R02',
    message: 'm',
    fix: 'f',
    location: {file: 'papeleria.yaml', line: 3, column: 7},
    relatedLocation: {file: 'assets/images/a.png', line: null, column: null},
    sourcePath: 'papeleria.yaml#/pages/0/image',
  });
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(item.finding))).sort(), [
    'column', 'detail', 'file', 'fix', 'line', 'message', 'relatedLocation', 'rule', 'severity',
  ]);
});

test('LineIndex treats CRLF, LF and a lone CR as one line break each, with 1-based columns', () => {
  const index = new LineIndex('ab\r\ncd\ne\rf');
  assert.deepEqual(index.position(0), {line: 1, column: 1, offset: 0});
  assert.deepEqual(index.position(4), {line: 2, column: 1, offset: 4});
  assert.deepEqual(index.position(7), {line: 3, column: 1, offset: 7});
  assert.deepEqual(index.position(9), {line: 4, column: 1, offset: 9});
  assert.equal(index.lineCount, 4);
  // Columns count UTF-16 code units, as JavaScript and CodeMirror do.
  assert.deepEqual(new LineIndex('😀x').position(2), {line: 1, column: 3, offset: 2});
  // Offsets are clamped to the text.
  assert.deepEqual(new LineIndex('ab').position(99), {line: 1, column: 3, offset: 2});
});

test('JSON pointers escape ~ and / and round-trip', () => {
  const pointer = joinPointer(joinPointer('', 'a/b'), 'c~d');
  assert.equal(pointer, '/a~1b/c~0d');
  assert.deepEqual(parsePointer(pointer), ['a/b', 'c~d']);
  assert.equal(pointerOf(['slides', 3, 'title']), '/slides/3/title');
  assert.equal(parentPointer('/slides/3/title'), '/slides/3');
  assert.equal(parentPointer(''), null);
  assert.deepEqual(parsePointer(''), []);
  assert.throws(() => parsePointer('slides'), /not a JSON pointer/);
});

test('nearestEntry falls back to the closest ancestor and says which one it found', () => {
  const span = {start: {line: 2, column: 1, offset: 5}, end: {line: 2, column: 4, offset: 8}};
  const map = new Map<string, SourceEntry>([['/slides/0', {value: span}]]);
  assert.deepEqual(nearestEntry(map, '/slides/0/title'), {pointer: '/slides/0', entry: {value: span}});
  assert.equal(nearestEntry(map, '/pages/0'), null);
});

test('message, fix and detail never carry a control character, a line separator, a bidirectional override or an invisible space', () => {
  const unsafe = '\u001b\u0007\u009b\u2028\u202e\u2066\u200b\ufeff';
  const item = traced({
    rule: 'R09',
    message: `a${unsafe}b`,
    fix: `fix${unsafe}`,
    detail: `detail${unsafe}`,
    location: {file: 'papeleria.yaml', line: 1, column: 1},
    sourcePath: 'papeleria.yaml#/x',
  });
  const escaped = '\\u001b\\u0007\\u009b\\u2028\\u202e\\u2066\\u200b\\ufeff';
  assert.equal(item.finding.message, `a${escaped}b`);
  assert.equal(item.finding.fix, `fix${escaped}`);
  assert.equal(item.finding.detail, `detail${escaped}`);
  // Everything else is kept as written, including accents, right-to-left text and its marks, and the joiners
  // that Persian words and emoji sequences need.
  const kept = 'Café \u05e9\u05dc\u05d5\u05dd \u200f\u061c\u200e\u2014 \u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645 \u{1f469}\u200d\u{1f4bb} \\ "quoted"';
  assert.equal(escapeControls(kept), kept);
  assert.equal(quoteForMessage('a\u001bb'), '"a\\u001bb"');
});

test('a quoted value shows every default-ignorable character but the joiners and the bidirectional marks (W5R-32)', () => {
  // A word joiner, a soft hyphen, a combining grapheme joiner, a variation selector and a tag character draw
  // nothing: quoted as themselves, a key holding one would print exactly like the key without it.
  for (const [hidden, escape] of [
    ['⁠', '\\u2060'],
    ['­', '\\u00ad'],
    ['͏', '\\u034f'],
    ['️', '\\ufe0f'],
    ['\u{e0001}', '\\u{e0001}'],
    ['᠎', '\\u180e'],
    ['ㅤ', '\\u3164'],
  ]) {
    assert.equal(quoteForMessage(`title${hidden}`), `"title${escape}"`, escape);
  }
  // What the report escaper escapes is escaped here too, once.
  assert.equal(quoteForMessage('a\u001b​﻿‮ b'), '"a\\u001b\\u200b\\ufeff\\u202e\\u2028b"');
  // The joiners and the bidirectional marks stay, as they do in every message (D164(b)), and so does ordinary text.
  const kept = 'می‌خواهم \u{1f469}‍\u{1f4bb} ‏؜‎ Café "x" \\';
  assert.equal(quoteForMessage(kept), `"${kept}"`);
  assert.equal(escapeInvisible(kept), kept);
  // Inside a quote even a flag's tag characters show: the author is comparing what was written, character by character.
  assert.equal(escapeInvisible('\u{1f3f4}\u{e0067}\u{e0062}\u{e007f}'), '\u{1f3f4}\\u{e0067}\\u{e0062}\\u{e007f}');
});

test('a long quoted value keeps its first and last 60 code units and states its length (D175)', () => {
  assert.equal(QUOTED_LENGTH, 120);
  const exact = 'a'.repeat(120);
  assert.equal(shortenForMessage(exact), exact);
  assert.equal(quoteValue(exact), `"${exact}"`, 'a value that fits is quoted whole, with no length');
  const long = `${'h'.repeat(150_000)}${'t'.repeat(150_000)}`;
  assert.equal(quoteValue(long), `"${'h'.repeat(60)}…${'t'.repeat(60)}" (300,000 characters)`);
  assert.equal(quoteValue(long, 'json'), `"${'h'.repeat(60)}…${'t'.repeat(60)}" (300,000 characters)`);
  assert.equal(quoteValue(long, 'none'), `${'h'.repeat(60)}…${'t'.repeat(60)} (300,000 characters)`);
  assert.equal(quoteValue('say "hi" \\'), '"say "hi" \\"', 'as written: quotes and backslashes kept');
  assert.equal(quoteValue('say "hi" \\', 'json'), '"say \\"hi\\" \\\\"');

  // A cut never splits a surrogate pair: an emoji astride either cut is left out whole.
  const astride = `${'a'.repeat(59)}\u{1f600}${'x'.repeat(100)}\u{1f600}${'z'.repeat(59)}`;
  assert.equal(shortenForMessage(astride), `${'a'.repeat(59)}…${'z'.repeat(59)}`);
  const inside = `${'a'.repeat(58)}\u{1f600}${'x'.repeat(100)}\u{1f600}${'z'.repeat(58)}`;
  assert.equal(shortenForMessage(inside), `${'a'.repeat(58)}\u{1f600}…\u{1f600}${'z'.repeat(58)}`);
  // Nor an escape: the value is cut first, so every control shows as a whole \u escape.
  assert.equal(quoteValue('\u0001'.repeat(200)), `"${'\\u0001'.repeat(60)}…${'\\u0001'.repeat(60)}" (200 characters)`);
  assert.equal(quoteValue(`${'\u{e0001}'.repeat(100)}`), `"${'\\u{e0001}'.repeat(30)}…${'\\u{e0001}'.repeat(30)}" (200 characters)`);

  // A list of values names twenty and counts the rest.
  const names = Array.from({length: 25}, (_, index) => `c${index + 1}`);
  assert.equal(listForMessage(names.slice(0, 20), (name) => name), names.slice(0, 20).join(', '));
  assert.equal(listForMessage(names, (name) => name), `${names.slice(0, 20).join(', ')} and 5 more`);
});

test('every message that quotes an author value stays short, however long the value (D175)', () => {
  const huge = 'q'.repeat(300_000);
  /** Each text at most `bound` characters, where the value quoted in it is 300,000. */
  const short = (label: string, texts: readonly (string | null)[], bound = 1_000): void => {
    assert.ok(texts.length > 0, `${label}: no finding`);
    for (const text of texts) {
      assert.ok((text ?? '').length <= bound, `${label}: ${(text ?? '').length} characters`);
    }
  };
  const findings = (text: string, file: 'papeleria.yaml' | 'papeleria.json'): Finding[] => {
    const loaded = parseManifest(text, file);
    const traced = loaded.manifest === null ? loaded.findings : [...loaded.findings, ...validateManifest(loaded.manifest).findings];
    return settleFindings(traced);
  };
  const texts = (items: readonly Finding[]) => items.flatMap((item) => [item.message, item.fix, item.detail]);
  const deck = (extra: string) => `schema: 1\ntemplate: deck\ntitle: T\n${extra}slides:\n  - {layout: statement, title: S}\n`;

  // The review's case: a 300 KB layout value quoted whole made a 300,025-character message.
  const layout = findings(`schema: 1\ntemplate: deck\ntitle: T\nslides:\n  - layout: ${huge}\n    title: S\n`, 'papeleria.yaml');
  short('an unknown layout', texts(layout));
  assert.match(layout[0]!.message, /^"q{60}…q{60}" \(300,000 characters\) is not a valid layout\.$/);
  short('an unknown key', texts(findings(JSON.stringify({schema: 1, template: 'deck', title: 'T', [huge]: 1, slides: [{layout: 'statement', title: 'S'}]}), 'papeleria.json')));
  short('an unknown template', texts(findings(`schema: 1\ntemplate: ${huge}\n`, 'papeleria.yaml')));
  short('a schema that is text', texts(findings(`schema: "${huge}"\ntemplate: deck\n`, 'papeleria.yaml')));
  short('a key written twice, quoted in message, fix and detail', texts(findings(`{"schema": 1, "${huge}": 1, "${huge}": 2}`, 'papeleria.json')));
  for (const [label, extra] of [
    ['a tag', `x: !${huge} 1\n`],
    ['an anchor', `x: &${huge} 1\n`],
    ['an alias', `x: *${huge}\n`],
    ['a scalar the parser stops at', `]${huge}\n`],
    ['a block scalar header', `x: |${huge}\n  y\n`],
  ]) {
    short(label!, texts(findings(deck(extra!), 'papeleria.yaml')));
  }
  short('a directive', texts(findings(`%${huge}\n---\n${deck('')}`, 'papeleria.yaml')));
  short('a %YAML directive', texts(findings(`%YAML 1.${'1'.repeat(300_000)}\n---\n${deck('')}`, 'papeleria.yaml')));

  // Paths: one the schema's pattern refuses, two only the path rules refuse (reported with the schema's errors,
  // W5R-33), and each message of the path rules, the reserved name as long as the path.
  for (const src of [`assets/images/${huge}\\x.png`, `assets/images/${'a/'.repeat(150_000)}x.png`, `assets/images/con.${huge}.png`]) {
    const image = findings(`schema: 1\ntemplate: deck\ntitle: T\nslides:\n  - layout: image\n    title: S\n    image: {src: '${src}', alt: A}\n`, 'papeleria.yaml');
    short(`the path ${src.slice(14, 24)}…`, texts(image));
  }
  for (const [kind, value, code] of [
    ['image', `assets/images/${huge}.png`, 'too-long'],
    ['image', `assets/images/${'a/'.repeat(150_000)}x.png`, 'too-long'],
    ['image', `assets/images/con.${huge}.png`, 'reserved'],
    ['data', `assets/data/${huge}.csv.`, 'characters'],
    ['text', `/${huge}.md`, 'absolute'],
  ] as const) {
    const problem = checkAssetPath(kind, value);
    assert.equal(problem?.code, code, kind);
    short(`the path rule ${code}`, [problem?.message ?? null, problem?.fix ?? null]);
  }

  // Charts and CSV: a cell, the header's names listed, a name among them, and a header name written twice.
  const spaced = renderChart({id: 'c', type: 'bar', x: 'x', y: 'y', summary: 'S.', locale: 'en', table: parseCsvTable(`x,y\n${huge},1\n${huge} ,2\n`)});
  short('names that differ only in spacing', spaced.problems.map((problem) => problem.message));
  const line = renderChart({id: 'c', type: 'line', x: 'x', y: 'y', summary: 'S.', locale: 'en', table: parseCsvTable(`x,y\n1,1\n${huge},2\n`)});
  short('an x value that is not a number', line.problems.map((problem) => problem.message));
  const wide = parseCsvTable(`${Array.from({length: 5_000}, (_, index) => `c${index}`).join(',')}\n${'1,'.repeat(4_999)}1\n`);
  const missing = renderChart({id: 'c', type: 'bar', x: 'nope', y: 'no', summary: 'S.', locale: 'en', table: wide});
  short('a missing column named against 5,000 headers', missing.problems.map((problem) => problem.message));
  assert.match(missing.problems[0]!.message, /: c0, c1, c2, .*, c19 and 4,980 more\.$/);
  const named = renderChart({id: 'c', type: 'bar', x: 'nope', y: 'y', summary: 'S.', locale: 'en', table: parseCsvTable(`${huge},y\n1,2\n`)});
  short('a missing column named against a header as long as the file', named.problems.map((problem) => problem.message));
  const doubled = parseCsv(`${huge},${huge}\n1,2\n`);
  short('a header name written twice', doubled.ok ? [] : doubled.problems.map((problem) => problem.message));

  // SVG: an attribute value, an element name, an attribute name, a transform function and a closing tag saxes cannot match.
  const svg = (body: string) => validateSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">${body}</svg>`);
  for (const [label, body] of [
    ['an attribute value', `<rect width="${huge}"/>`],
    ['an element name', `<${huge}/>`],
    ['an attribute name', `<rect ${huge}="1"/>`],
    ['a transform function', `<g transform="${huge}(1)"/>`],
    ['a closing tag', `<g></${huge}>`],
  ]) {
    const result = svg(body!);
    short(`svg: ${label}`, result.ok ? [] : result.problems.map((problem) => problem.message));
  }
});

test('a table that names a missing column lists at most twenty of its headers, each cut (D175)', async () => {
  const headers = [...Array.from({length: 4_999}, (_, index) => `h${index}`), 'q'.repeat(300_000)];
  const loaders = createMemoryLoaders({
    'papeleria.yaml': 'schema: 1\ntemplate: document\ntitle: T\nsections:\n  - heading: H\n    blocks:\n      - table: {data: assets/data/wide.csv, columns: [nope]}\n',
    'assets/data/wide.csv': `${headers.join(',')}\n${headers.map(() => '1').join(',')}\n`,
  });
  const {piece} = await readPiece({loaders});
  assert.ok(piece);
  const found = R13.check({piece, manifest: null, coreFindings: [], charts: new Map()});
  assert.deepEqual(
    found.map((item) => item.finding.message),
    [`The table names the column "nope", which assets/data/wide.csv does not have. Its headers are ${headers.slice(0, 20).map((name) => `"${name}"`).join(', ')} and 4,980 more.`],
  );
  const cut = R13.check({piece: (await readPiece({loaders: createMemoryLoaders({
    'papeleria.yaml': 'schema: 1\ntemplate: document\ntitle: T\nsections:\n  - heading: H\n    blocks:\n      - table: {data: assets/data/long.csv, columns: [nope]}\n',
    'assets/data/long.csv': `${'q'.repeat(300_000)},y\n1,2\n`,
  })})).piece, manifest: null, coreFindings: [], charts: new Map()});
  assert.match(cut[0]!.finding.message, /Its headers are "q{60}…q{60}" \(300,000 characters\), "y"\.$/);
});

function parseCsvTable(text: string): CsvTable {
  const parsed = parseCsv(text);
  assert.ok(parsed.ok, JSON.stringify(parsed.ok ? null : parsed.problems.slice(0, 2)));
  return parsed.table;
}
