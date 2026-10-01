/**
 * M1.1: manifest loading with positions, for YAML and strict JSON alike.
 *
 * The fixture cases in test/fixtures/manifest/cases.json give every expected
 * location as marker text. This test finds the marker in each file with its own
 * line arithmetic, independent of the parser's, and one routine asserts every
 * case against both formats: that is the position-parity check IC01 asks for.
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';

import {
  INPUT_LIMITS,
  createMemoryFileAccess,
  loadManifest,
  parseManifest,
  settleFindings,
  type Finding,
  type ManifestFile,
} from '../../src/core/index.js';
import {applicationRoot, fixturePath} from '../helpers/paths.js';

type ByFormat<T> = T | {yaml: T; json: T};
type Marker = string | {marker: string; occurrence: number} | {end: true} | null;
type ExpectedFinding = {
  rule: string;
  severity: string;
  at: ByFormat<Marker>;
  message: ByFormat<string>;
  fix: ByFormat<string>;
  detail?: ByFormat<string>;
  related?: ByFormat<Marker>;
};
type Case = {name: string; files: string[]; usable: boolean; findings: ExpectedFinding[]};

const cases = (JSON.parse(readFileSync(fixturePath('manifest', 'cases.json'), 'utf8')) as {cases: Case[]}).cases;

function pick<T>(value: ByFormat<T>, format: 'yaml' | 'json'): T {
  if (typeof value === 'object' && value !== null && 'yaml' in value && 'json' in value) {
    return (value as {yaml: T; json: T})[format];
  }
  return value as T;
}

/** Line and column of an offset, by counting line feeds: deliberately not the core's LineIndex. */
function positionOf(text: string, offset: number): {line: number; column: number} {
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  const column = offset - (before.lastIndexOf('\n') + 1) + 1;
  return {line, column};
}

function locate(text: string, marker: Marker, label: string): {line: number | null; column: number | null} {
  if (marker === null) {
    return {line: null, column: null};
  }
  if (typeof marker === 'object' && 'end' in marker) {
    return positionOf(text, text.length);
  }
  const needle = typeof marker === 'string' ? marker : marker.marker;
  const occurrence = typeof marker === 'string' ? 1 : marker.occurrence;
  let offset = -1;
  for (let count = 0; count < occurrence; count += 1) {
    offset = text.indexOf(needle, offset + 1);
    assert.notEqual(offset, -1, `${label}: marker ${JSON.stringify(needle)} #${occurrence} is not in the fixture`);
  }
  return positionOf(text, offset);
}

function manifestFileFor(name: string): ManifestFile {
  return name.endsWith('.json') ? 'papeleria.json' : 'papeleria.yaml';
}

for (const testCase of cases) {
  for (const name of testCase.files) {
    const format = name.endsWith('.json') ? 'json' : 'yaml';
    test(`${testCase.name} (${format}: ${name})`, () => {
      const text = readFileSync(fixturePath('manifest', name), 'utf8');
      const file = manifestFileFor(name);
      const result = parseManifest(text, file);
      assert.equal(result.manifest !== null, testCase.usable, `usable should be ${testCase.usable}`);
      const findings = settleFindings(result.findings);
      const expected = testCase.findings.map((item) => {
        const at = locate(text, pick(item.at, format), `${name} at`);
        const finding: Finding = {
          file,
          line: at.line,
          column: at.column,
          rule: item.rule,
          severity: item.severity as Finding['severity'],
          message: pick(item.message, format),
          fix: pick(item.fix, format),
          detail: item.detail === undefined ? null : pick(item.detail, format),
        };
        if (item.related !== undefined) {
          finding.relatedLocation = {file, ...locate(text, pick(item.related, format), `${name} related`)};
        }
        return finding;
      });
      assert.deepEqual(findings, expected);
    });
  }
}

test('every YAML/JSON pair in the cases is present in both formats', () => {
  for (const testCase of cases) {
    const formats = new Set(testCase.files.map((name) => name.split('.').pop()));
    if (formats.size === 2) {
      assert.equal(testCase.files.length, 2, testCase.name);
    }
  }
  const pairs = cases.filter((testCase) => testCase.files.length === 2).length;
  assert.ok(pairs >= 14, `expected at least 14 paired cases, found ${pairs}`);
});

// ---------------------------------------------------------------------------
// Limits, generated rather than committed.

function yamlDeck(extra = ''): string {
  return `schema: 1\ntemplate: deck\ntitle: Craft with care.\n${extra}slides:\n  - layout: statement\n    title: One idea.\n`;
}

function padTo(text: string, bytes: number, format: 'yaml' | 'json'): string {
  const current = Buffer.byteLength(text, 'utf8');
  assert.ok(current <= bytes);
  if (format === 'yaml') {
    // A comment line of the right length: "#" + spaces + "\n".
    return text + '#' + ' '.repeat(bytes - current - 2) + '\n';
  }
  return text + ' '.repeat(bytes - current);
}

for (const format of ['yaml', 'json'] as const) {
  const file: ManifestFile = format === 'yaml' ? 'papeleria.yaml' : 'papeleria.json';
  const base =
    format === 'yaml'
      ? yamlDeck()
      : JSON.stringify({schema: 1, template: 'deck', title: 'T', slides: [{layout: 'statement', title: 'One'}]});

  test(`${format}: a manifest of exactly 1 MiB is accepted and one byte more is refused`, () => {
    const exact = padTo(base, INPUT_LIMITS.manifestBytes, format);
    assert.equal(Buffer.byteLength(exact), 1_048_576);
    const accepted = parseManifest(exact, file);
    assert.notEqual(accepted.manifest, null);
    assert.deepEqual(settleFindings(accepted.findings), []);

    const over = padTo(base, INPUT_LIMITS.manifestBytes + 1, format);
    const refused = parseManifest(over, file);
    assert.equal(refused.manifest, null);
    assert.deepEqual(settleFindings(refused.findings), [
      {
        file,
        line: null,
        column: null,
        rule: 'R09',
        severity: 'error',
        message: 'The manifest is 1,048,577 bytes; the limit is 1 MiB (1,048,576 bytes).',
        fix: 'Move long passages into Markdown files under assets/text/ and point the manifest at them.',
        detail: 'Input limit: manifest 1,048,576 bytes (IC01).',
      },
    ]);
  });

  test(`${format}: the size limit counts UTF-8 bytes, not characters`, () => {
    // 524,300 two-byte characters: fewer characters than the limit, more bytes.
    const long = 'é'.repeat(524_300);
    const text =
      format === 'yaml'
        ? yamlDeck(`lead_note: "${long}"\n`)
        : JSON.stringify({schema: 1, template: 'deck', title: long, slides: []});
    assert.ok(text.length < INPUT_LIMITS.manifestBytes);
    assert.ok(Buffer.byteLength(text) > INPUT_LIMITS.manifestBytes);
    const result = parseManifest(text, file);
    assert.equal(result.manifest, null);
    assert.match(settleFindings(result.findings)[0]!.message, /the limit is 1 MiB/);
  });

  for (const list of [
    {key: 'slides', template: 'deck', item: {layout: 'statement', title: 'One'}},
    {key: 'pages', template: 'comic', item: {image: 'assets/images/p.png', alt: 'A page.'}},
    {key: 'sections', template: 'document', item: {heading: 'H', blocks: [{text: 'x'}]}},
  ]) {
    test(`${format}: 1,000 ${list.key} are accepted and 1,001 are refused at the ${list.key} key`, () => {
      const make = (count: number): string => {
        const value = {schema: 1, template: list.template, title: 'T', [list.key]: Array.from({length: count}, () => list.item)};
        if (format === 'json') {
          return JSON.stringify(value, null, 1);
        }
        const item = JSON.stringify(list.item);
        return `schema: 1\ntemplate: ${list.template}\ntitle: T\n${list.key}:\n${`  - ${item}\n`.repeat(count)}`;
      };
      const accepted = parseManifest(make(1000), file);
      assert.notEqual(accepted.manifest, null);
      assert.deepEqual(settleFindings(accepted.findings), []);

      const text = make(1001);
      const refused = parseManifest(text, file);
      assert.equal(refused.manifest, null);
      const marker = format === 'json' ? `"${list.key}"` : `${list.key}:`;
      assert.deepEqual(settleFindings(refused.findings), [
        {
          file,
          ...positionOf(text, text.indexOf(marker)),
          rule: 'R09',
          severity: 'error',
          message: `The manifest lists 1,001 ${list.key}; the limit is 1,000 per piece.`,
          fix: 'Split the piece into several pieces.',
          detail: 'Input limit: 1,000 slides, pages or sections per piece (IC01).',
        },
      ]);
    });
  }

  test(`${format}: a leading byte-order mark is removed before positions are counted`, () => {
    // Positions on line 1, where a mark that was counted would move every column by one.
    const body = format === 'yaml' ? 'title: a\ntitle: b\n' : '{"title": "a", "title": "b"}';
    const [finding] = settleFindings(parseManifest(`\uFEFF${body}`, file).findings);
    assert.deepEqual(
      [finding?.line, finding?.column, finding?.relatedLocation?.line, finding?.relatedLocation?.column],
      format === 'yaml' ? [2, 1, 1, 1] : [1, 16, 1, 2],
    );
    const {manifest} = parseManifest(`\uFEFF${format === 'yaml' ? 'schema: 1\n' : '{"schema": 1}'}`, file);
    assert.equal(manifest?.text, format === 'yaml' ? 'schema: 1\n' : '{"schema": 1}');
    assert.deepEqual(manifest?.sourceMap.get('/schema')?.key?.start, format === 'yaml' ? {line: 1, column: 1, offset: 0} : {line: 1, column: 2, offset: 1});
    if (format === 'json') {
      // Only a leading mark is removed: one anywhere else is an error at its own position.
      const inner = settleFindings(parseManifest('{"schema": 1,\n\uFEFF"title": "a"}', file).findings);
      assert.deepEqual(inner.map((item) => [item.rule, item.line, item.column]), [['R09', 2, 1]]);
    }
  });

  test(`${format}: CRLF line ends count as one line each`, () => {
    const body = format === 'yaml' ? 'schema: 1\r\ntitle: a\r\ntitle: b\r\n' : '{"schema": 1,\r\n"title": "a",\r\n  "title": "b"}';
    const [finding] = settleFindings(parseManifest(body, file).findings);
    assert.equal(finding?.line, 3);
    assert.equal(finding?.column, format === 'yaml' ? 1 : 3);
    assert.equal(finding?.relatedLocation?.line, 2);
  });
}

test('a newer schema is R17 alone, even when the manifest also breaks a v1 input limit, profile or syntax rule', () => {
  const yaml = (extra: string, head = ''): string => `${head}schema: 2\ntemplate: deck\ntitle: T\n${extra}slides:\n  - {layout: statement, title: S}\n`;
  const json = (extra: string): string => `{"schema": 2, "template": "deck", "title": "T", ${extra}"slides": [{"layout": "statement", "title": "S"}]}`;
  const deep = `${'['.repeat(33)}${']'.repeat(33)}`;
  const variants: [string, ManifestFile, string][] = [
    ['1,001 slides', 'papeleria.yaml', `schema: 2\ntemplate: deck\ntitle: T\nslides:\n${'  - {layout: statement, title: S}\n'.repeat(1001)}`],
    ['1,001 slides', 'papeleria.json', JSON.stringify({schema: 2, template: 'deck', title: 'T', slides: Array.from({length: 1001}, () => ({layout: 'statement', title: 'S'}))})],
    ['nesting deeper than 32', 'papeleria.yaml', yaml(`deep: ${deep}\n`)],
    ['nesting deeper than 32', 'papeleria.json', json(`"deep": ${deep}, `)],
    ['a duplicate key', 'papeleria.yaml', yaml('title: U\n')],
    ['a duplicate key', 'papeleria.json', json('"title": "U", ')],
    ['an anchor and an alias', 'papeleria.yaml', yaml('a: &x 1\nb: *x\n')],
    ['a custom tag', 'papeleria.yaml', yaml('a: !future 1\n')],
    ['a merge key', 'papeleria.yaml', yaml('m:\n  <<: {a: 1}\n')],
    ['a second document', 'papeleria.yaml', `${yaml('')}---\nother: 1\n`],
    ['a %YAML 1.3 directive', 'papeleria.yaml', yaml('', '%YAML 1.3\n---\n')],
    ['a key that is not text', 'papeleria.yaml', yaml('1: one\n')],
    ['a quotation mark never closed', 'papeleria.yaml', yaml('note: "open\n')],
    ['a mapping written as JSON, with a duplicate key', 'papeleria.yaml', '{"schema": 2, "a": 1, "a": 2}\n'],
    ['a comment after the schema', 'papeleria.json', '{"schema": 2, // a newer format\n "template": "deck"}'],
    ['a trailing comma', 'papeleria.json', '{"schema": 2, "template": "deck",}'],
  ];
  for (const [label, file, text] of variants) {
    const result = parseManifest(text, file);
    assert.equal(result.manifest, null, `${file}: ${label}`);
    // At the version's own value, the first 2 after the word schema.
    const at = positionOf(text, text.indexOf('2', text.indexOf('schema')));
    assert.deepEqual(
      settleFindings(result.findings).map((finding) => [finding.rule, finding.line, finding.column, finding.message]),
      [['R17', at.line, at.column, "The manifest's schema 2 is newer than this version of Papeleria, which reads schema 1."]],
      `${file}: ${label}`,
    );
  }
  // The size limit is checked before the text is read at all.
  const oversized = parseManifest(`schema: 2\n#${' '.repeat(INPUT_LIMITS.manifestBytes)}\n`, 'papeleria.yaml');
  assert.deepEqual(settleFindings(oversized.findings).map((finding) => [finding.rule, finding.line]), [['R09', null]]);
  // A version the scanner never reached cannot decide anything.
  const unread = parseManifest('{// a newer format\n"schema": 2}', 'papeleria.json');
  assert.deepEqual(settleFindings(unread.findings).map((finding) => [finding.rule, finding.message]), [['R09', 'JSON does not allow comments.']]);
});

// ---------------------------------------------------------------------------
// The loaded value and its source map.

test('the loaded value is deep-frozen and its source map is read-only all the way down', () => {
  const {manifest} = parseManifest(yamlDeck(), 'papeleria.yaml');
  assert.ok(manifest);
  const slides = manifest.value['slides'] as {title: string}[];
  assert.throws(() => {
    (slides[0] as {title: string}).title = 'changed';
  }, TypeError);
  assert.throws(() => (manifest.sourceMap as Map<string, unknown>).set('/x', {}), TypeError);
  assert.throws(() => (manifest.sourceMap as Map<string, unknown>).delete('/x'), TypeError);
  // Not through Map itself, nor through an entry, a span, a position or the line index.
  assert.throws(() => Map.prototype.set.call(manifest.sourceMap, '/x', {}), TypeError);
  const entry = manifest.sourceMap.get('/title')!;
  assert.throws(() => {
    (entry as {value: unknown}).value = null;
  }, TypeError);
  assert.throws(() => {
    (entry.value as {end: unknown}).end = null;
  }, TypeError);
  assert.throws(() => {
    (entry.value.start as {line: number}).line = 99;
  }, TypeError);
  assert.throws(() => {
    (manifest.lines as unknown as {position: unknown}).position = () => ({line: 1});
  }, TypeError);
  assert.equal(manifest.sourceMap.get('/title')!.value.start.line, 3);
  assert.equal(manifest.sourceMap.has('/x'), false);
});

test('the source map places keys and values for nested pointers in both formats', () => {
  const yaml = 'schema: 1\ntemplate: deck\ntitle: T\nslides:\n  - layout: three\n    columns:\n      - {heading: A, text: B}\n';
  const json = '{"schema": 1, "template": "deck", "title": "T",\n "slides": [{"layout": "three",\n  "columns": [{"heading": "A", "text": "B"}]}]}';
  const y = parseManifest(yaml, 'papeleria.yaml').manifest!;
  const j = parseManifest(json, 'papeleria.json').manifest!;
  const heading = (map: typeof y.sourceMap) => map.get('/slides/0/columns/0/heading')!;
  assert.deepEqual([heading(y.sourceMap).key!.start.line, heading(y.sourceMap).key!.start.column], [7, 10]);
  assert.deepEqual([heading(y.sourceMap).value.start.line, heading(y.sourceMap).value.start.column], [7, 19]);
  assert.deepEqual([heading(j.sourceMap).key!.start.line, heading(j.sourceMap).key!.start.column], [3, 16]);
  assert.deepEqual([heading(j.sourceMap).value.start.line, heading(j.sourceMap).value.start.column], [3, 27]);
  // A list item has a value span and no key.
  assert.equal(y.sourceMap.get('/slides/0')!.key, undefined);
  assert.equal(j.sourceMap.get('/slides/0')!.key, undefined);
  // Every pointer in one format exists in the other.
  assert.deepEqual([...y.sourceMap.keys()].sort(), [...j.sourceMap.keys()].sort());
});

test('a key named __proto__ becomes an own field, never the prototype', () => {
  for (const [text, file] of [
    ['schema: 1\n__proto__: {polluted: true}\n', 'papeleria.yaml'],
    ['{"schema": 1, "__proto__": {"polluted": true}}', 'papeleria.json'],
  ] as const) {
    const {manifest} = parseManifest(text, file);
    assert.ok(manifest);
    assert.ok(Object.hasOwn(manifest.value, '__proto__'), file);
    assert.equal(Object.getPrototypeOf(manifest.value), Object.prototype, file);
    assert.equal(({} as {polluted?: boolean}).polluted, undefined);
  }
});

test('YAML keeps core-schema scalars: yes and dates stay text, 0x1F is a number', () => {
  const {manifest} = parseManifest('schema: 1\na: yes\nb: 2026-09-22\nc: 0x1F\nd: ~\n', 'papeleria.yaml');
  assert.ok(manifest);
  assert.deepEqual(manifest.value, {schema: 1, a: 'yes', b: '2026-09-22', c: 31, d: null});
});

// ---------------------------------------------------------------------------
// The IO boundary.

const minimal = yamlDeck();

test('loadManifest reads papeleria.yaml or papeleria.json through the file access', async () => {
  for (const [name, text] of [
    ['papeleria.yaml', minimal],
    ['papeleria.json', JSON.stringify({schema: 1, template: 'deck', title: 'T', slides: []})],
  ] as const) {
    const result = await loadManifest(createMemoryFileAccess({[name]: text}));
    assert.equal(result.manifest?.file, name);
    assert.deepEqual(settleFindings(result.findings), []);
  }
});

test('both manifests present is one global R09 on the piece folder', async () => {
  const access = createMemoryFileAccess({'papeleria.yaml': minimal, 'papeleria.json': '{}'});
  const result = await loadManifest(access, {pieceLabel: 'examples/demo'});
  assert.equal(result.manifest, null);
  assert.deepEqual(settleFindings(result.findings), [
    {
      file: 'examples/demo',
      line: null,
      column: null,
      rule: 'R09',
      severity: 'error',
      message: 'The piece has both papeleria.yaml and papeleria.json.',
      fix: 'Keep one manifest and delete the other.',
      detail: 'A piece has exactly one manifest (C01).',
    },
  ]);
});

test('no manifest is one global R09, with a hint when papeleria.yml is present', async () => {
  const none = await loadManifest(createMemoryFileAccess({'assets/text/a.md': 'x'}), {pieceLabel: 'demo'});
  assert.deepEqual(settleFindings(none.findings), [
    {
      file: 'demo',
      line: null,
      column: null,
      rule: 'R09',
      severity: 'error',
      message: 'The piece has no manifest.',
      fix: 'Add papeleria.yaml, or papeleria.json, at the top of the piece folder.',
      detail: 'A piece has exactly one manifest (C01).',
    },
  ]);
  const misnamed = await loadManifest(createMemoryFileAccess({'papeleria.yml': minimal}));
  assert.equal(settleFindings(misnamed.findings)[0]?.file, '.');
  assert.equal(
    settleFindings(misnamed.findings)[0]?.detail,
    'papeleria.yml is present; the manifest must be named papeleria.yaml.',
  );
});

test('a linked, non-file, oversized or non-UTF-8 manifest is refused without an invented line', async () => {
  const cases: [Record<string, string | Uint8Array | {symlink: string} | {other: true}>, string][] = [
    [{'papeleria.yaml': {symlink: '../elsewhere.yaml'}}, 'papeleria.yaml is a symbolic link, and Papeleria does not follow links inside a piece.'],
    [{'papeleria.yaml': {other: true}}, 'papeleria.yaml is not a file.'],
    [{'papeleria.yaml': 'x'.repeat(INPUT_LIMITS.manifestBytes + 1)}, 'The manifest is 1,048,577 bytes; the limit is 1 MiB (1,048,576 bytes).'],
    [{'papeleria.yaml': new Uint8Array([0x73, 0x3a, 0x20, 0xff, 0xfe, 0x0a])}, 'papeleria.yaml is not valid UTF-8 text.'],
  ];
  for (const [entries, message] of cases) {
    const result = await loadManifest(createMemoryFileAccess(entries));
    const findings = settleFindings(result.findings);
    assert.equal(result.manifest, null, message);
    assert.equal(findings.length, 1, message);
    assert.equal(findings[0]!.message, message);
    assert.equal(findings[0]!.file, 'papeleria.yaml');
    assert.equal(findings[0]!.line, null);
    assert.equal(findings[0]!.column, null);
  }
});

test('the three seeded manifests load in both formats with identical values and pointers', () => {
  for (const piece of ['starter-deck', 'hours-report', 'sample-comic']) {
    const yaml = readFileSync(join(applicationRoot, 'examples', piece, 'papeleria.yaml'), 'utf8');
    const fromYaml = parseManifest(yaml, 'papeleria.yaml');
    assert.deepEqual(settleFindings(fromYaml.findings), [], piece);
    const fromJson = parseManifest(JSON.stringify(fromYaml.manifest!.value, null, 2), 'papeleria.json');
    assert.deepEqual(settleFindings(fromJson.findings), [], piece);
    assert.deepEqual(fromJson.manifest!.value, fromYaml.manifest!.value, piece);
    assert.deepEqual([...fromJson.manifest!.sourceMap.keys()].sort(), [...fromYaml.manifest!.sourceMap.keys()].sort(), piece);
  }
});

test('a list of hundreds of thousands of entries loads without exhausting the call stack', () => {
  // Within the 1 MiB limit; spreading such a list into one call's arguments threw a RangeError.
  const flow = parseManifest(`x: [${Array.from({length: 200_000}, () => '1').join(',')}]\n`, 'papeleria.yaml');
  assert.ok(flow.manifest !== null);
  assert.equal((flow.manifest.value['x'] as unknown[]).length, 200_000);
});

test('loading time grows linearly with the number of quotation marks never closed', () => {
  // 256 KiB of `- "` lines. Placing each unclosed quote by searching all the others took about 76 seconds.
  const text = '- "\n'.repeat(65_536);
  const started = performance.now();
  const findings = settleFindings(parseManifest(text, 'papeleria.yaml').findings);
  const elapsed = performance.now() - started;
  assert.equal(findings.length, 65_536);
  assert.deepEqual(
    [findings[65_534]!.line, findings[65_534]!.column, findings[65_534]!.message, findings[65_534]!.detail],
    [65_535, 3, 'This quoted value is never closed.', 'The parser reached line 65535 still inside the quotes.'],
  );
  assert.ok(elapsed < 10_000, `65,536 unclosed quotation marks took ${elapsed.toFixed(0)} ms`);
});

test('consecutive list items cover separate lines, so a line belongs to one slide', () => {
  const yaml =
    'schema: 1\ntemplate: deck\ntitle: T\nslides:\n  - layout: cover\n    title: A\n\n  - layout: cover\n    title: B\n' +
    '  - layout: cover\n    title: C\n    notes: |\n      line one\n      line two\n\n';
  const lines = (pointer: string, text: string, file: ManifestFile): [number, number] => {
    const entry = parseManifest(text, file).manifest!.sourceMap.get(pointer)!;
    return [entry.value.start.line, entry.value.end.line];
  };
  assert.deepEqual(lines('/slides/0', yaml, 'papeleria.yaml'), [5, 6]);
  assert.deepEqual(lines('/slides/1', yaml, 'papeleria.yaml'), [8, 9]);
  assert.deepEqual(lines('/slides/2', yaml, 'papeleria.yaml'), [10, 14]);
  assert.deepEqual(lines('/slides/2/notes', yaml, 'papeleria.yaml'), [12, 14]);
  // The seeded pieces: no two slides, pages, panels or sections (the IC06 source targets) share a line.
  for (const piece of ['starter-deck', 'hours-report', 'sample-comic']) {
    const loaded = parseManifest(readFileSync(join(applicationRoot, 'examples', piece, 'papeleria.yaml'), 'utf8'), 'papeleria.yaml').manifest!;
    for (const [pointer, entry] of loaded.sourceMap) {
      if (!/^\/(?:slides|pages|sections)\/\d+$|^\/pages\/\d+\/panels\/\d+$/.test(pointer)) {
        continue;
      }
      const next = pointer.replace(/\/(\d+)$/, (_match, index: string) => `/${Number(index) + 1}`);
      const following = loaded.sourceMap.get(next);
      if (following !== undefined) {
        assert.ok(entry.value.end.line < following.value.start.line, `${piece} ${pointer} ends on line ${entry.value.end.line}, where ${next} starts`);
      }
    }
  }
});

test('a key: value pair inside a flow list is a level of nesting, in YAML as in JSON', () => {
  const nestedYaml = (levels: number, explicit = false): string => {
    let value = '1';
    for (let level = 0; level < levels; level += 1) {
      value = explicit ? `[? a : ${value}]` : `[a: ${value}]`;
    }
    return `x: ${value}\n`;
  };
  const nestedJson = (levels: number): string => {
    let value = '1';
    for (let level = 0; level < levels; level += 1) {
      value = `[{"a": ${value}}]`;
    }
    return `{"x": ${value}}`;
  };
  const depthFinding = (text: string, file: ManifestFile): Finding | undefined =>
    settleFindings(parseManifest(text, file).findings).find((finding) => finding.message.startsWith('The manifest nests more than'));
  // The root is 1; each level adds a list and the one-entry mapping inside it: 15 levels reach 31, 16 reach 33.
  assert.equal(depthFinding(nestedYaml(15), 'papeleria.yaml'), undefined);
  assert.equal(depthFinding(nestedJson(15), 'papeleria.json'), undefined);
  const yaml = depthFinding(nestedYaml(16), 'papeleria.yaml');
  assert.deepEqual([yaml?.line, yaml?.column], [1, 65], 'at the key of the pair that crosses the limit');
  const explicit = depthFinding(nestedYaml(16, true), 'papeleria.yaml');
  // x: is 3 characters and each [? a : is 7, so the 16th pair's ? is at offset 3 + 15 * 7 + 1.
  assert.deepEqual([explicit?.line, explicit?.column], [1, 3 + 15 * 7 + 2], 'at the ? of the pair that crosses the limit');
  assert.notEqual(depthFinding(nestedJson(16), 'papeleria.json'), undefined);
  // A pair after other items is located at its key, not at the comma before it.
  const afterComma = depthFinding(`x: [0, ${nestedYaml(16).slice(4, -2)}]\n`, 'papeleria.yaml');
  const text = `x: [0, ${nestedYaml(16).slice(4, -2)}]\n`;
  assert.deepEqual([afterComma?.line, afterComma?.column], [1, text.indexOf('a:', 7 + 15 * 4) + 1]);
});

test('when several branches nest too deeply, the first in the text is reported, in YAML as in JSON', () => {
  const deep = `${'['.repeat(33)}1${']'.repeat(33)}`;
  const yaml = settleFindings(parseManifest(`a: 1\nb: ${deep}\nc: ${deep}\n`, 'papeleria.yaml').findings);
  const json = settleFindings(parseManifest(`{"a": 1,\n"b": ${deep},\n"c": ${deep}}`, 'papeleria.json').findings);
  assert.deepEqual(yaml.map((finding) => [finding.line, finding.column]), [[2, 35]]);
  assert.deepEqual(json.map((finding) => [finding.line, finding.column]), [[2, 37]]);
});

test('a core tag that does not fit its value is refused at the tag; one that fits is kept', () => {
  const refused: [string, string][] = [
    ['title: !!int Hello', 'The tag !!int needs a whole number, and the value it marks is not one.'],
    ['title: !!null abc', 'The tag !!null needs null, and the value it marks is not one.'],
    ['title: !!bool yes', 'The tag !!bool needs true or false, and the value it marks is not one.'],
    ['title: !!float x', 'The tag !!float needs a number, and the value it marks is not one.'],
    ['title: !!int 1.0', 'The tag !!int needs a whole number, and the value it marks is not one.'],
    ['slides: !!map [1, 2]', 'The tag !!map needs a mapping, and the value it marks is not one.'],
    ['credits: !!seq {a: 1}', 'The tag !!seq needs a list, and the value it marks is not one.'],
    ['title: !<tag:yaml.org,2002:int> x', 'The tag !<tag:yaml.org,2002:int> needs a whole number, and the value it marks is not one.'],
  ];
  for (const [line, message] of refused) {
    const result = parseManifest(`schema: 1\n${line}\n`, 'papeleria.yaml');
    assert.equal(result.manifest, null, line);
    assert.deepEqual(
      settleFindings(result.findings).map((finding) => [finding.rule, finding.line, finding.column, finding.message]),
      [['R09', 2, line.indexOf('!') + 1, message]],
      line,
    );
  }
  const kept = parseManifest('schema: 1\na: !!int 12\nb: !!str 12\nc: !!float 1.5\nd: !!bool true\ne: !!null ~\nf: !!map {g: 1}\nh: !!seq [1]\n', 'papeleria.yaml');
  assert.deepEqual(settleFindings(kept.findings), []);
  assert.deepEqual(kept.manifest!.value, {schema: 1, a: 12, b: '12', c: 1.5, d: true, e: null, f: {g: 1}, h: [1]});
  // The YAML 1.2 core float needs no decimal point or exponent (10.3.2): !!float 1 is the number 1.
  const whole = parseManifest('schema: 1\na: !!float 1\nb: !!float -3\nc: !!float +12\nd: !<tag:yaml.org,2002:float> 007\ne: 1\n', 'papeleria.yaml');
  assert.deepEqual(settleFindings(whole.findings), []);
  assert.deepEqual(whole.manifest!.value, {schema: 1, a: 1, b: -3, c: 12, d: 7, e: 1});
  // A tag outside the core schema is reported once, at the tag, not again as a value that does not fit.
  const custom = settleFindings(parseManifest('schema: 1\ntitle: !foo bar\n', 'papeleria.yaml').findings);
  assert.deepEqual(custom.map((finding) => [finding.line, finding.column, finding.message]), [[2, 8, 'The tag !foo is not supported in a manifest.']]);
});

test('a lone carriage return ends a line in YAML, as YAML 1.2 says, and in JSON', () => {
  const yaml = parseManifest('schema: 1\rtemplate: deck\rtitle: "A\r  B"\r', 'papeleria.yaml');
  assert.deepEqual(settleFindings(yaml.findings), []);
  assert.deepEqual(yaml.manifest!.value, {schema: 1, template: 'deck', title: 'A B'});
  assert.deepEqual(yaml.manifest!.sourceMap.get('/template')!.value.start, {line: 2, column: 11, offset: 20});
  const json = parseManifest('{"schema": 1,\r"template": "deck"}', 'papeleria.json');
  assert.deepEqual(json.manifest!.sourceMap.get('/template')!.value.start, {line: 2, column: 13, offset: 26});
});

test('a character that cannot be seen is named by its code point, never shown as itself', () => {
  const json = (text: string): [number | null, number | null, string, string][] =>
    settleFindings(parseManifest(text, 'papeleria.json').findings).map((finding) => [finding.line, finding.column, finding.message, finding.fix]);
  const fix = 'Delete it, or type a plain space in its place: JSON allows only spaces, tabs and line breaks between its parts.';
  // Two files joined into one, a space pasted from a word processor, characters hidden after a comma and a number.
  assert.deepEqual(json('{"schema": 1,\n\uFEFF"template": "deck"}'), [[2, 1, 'Unexpected U+FEFF (byte-order mark) where JSON expects a key in double quotes.', fix]]);
  assert.deepEqual(json('{"schema":\u00a01}'), [[1, 11, 'Unexpected U+00A0 (no-break space) where JSON expects a value.', fix]]);
  assert.deepEqual(json('{"schema": 1,\u200b"template": "deck"}'), [[1, 14, 'Unexpected U+200B (zero-width space) where JSON expects a key in double quotes.', fix]]);
  assert.deepEqual(json('{"schema": 1\u2060}'), [[1, 13, 'Unexpected U+2060 where JSON expects a comma or }.', fix]]);
  // A key that hides a zero-width space is quoted with it escaped. A bidirectional mark is kept, as it is in
  // any quoted text, because right-to-left text needs it.
  const yaml = settleFindings(parseManifest('"ti\u200btle": a\n"ti\u200btle": b\n', 'papeleria.yaml').findings);
  assert.equal(yaml[0]!.message, 'The field "ti\\u200btle" appears twice in the same mapping.');
  const marked = settleFindings(parseManifest('{"ti\u200ftle": 1, "ti\u200ftle": 2}', 'papeleria.json').findings);
  assert.equal(marked[0]!.message, 'The field "ti\u200ftle" appears twice in the same object.');
});

test('control characters in keys and values never reach a message as themselves', () => {
  const unsafe = /[\u0000-\u001f\u007f-\u009f]/;
  const results = [
    parseManifest('"a\\e]0;x\\a": 1\n"a\\e]0;x\\a": 2\n', 'papeleria.yaml'),
    parseManifest('{"a\\u001b[2J": 1, "a\\u001b[2J": 2}', 'papeleria.json'),
    parseManifest('schema: "1\\e[2J"\n', 'papeleria.yaml'),
    parseManifest('{"schema": 1, "\\u009b31m": [}', 'papeleria.json'),
  ];
  const findings = results.flatMap((result) => settleFindings(result.findings));
  assert.equal(findings.length, 4);
  for (const finding of findings) {
    for (const text of [finding.message, finding.fix, finding.detail ?? '']) {
      assert.ok(!unsafe.test(text), JSON.stringify(text));
    }
  }
  assert.equal(findings[0]!.message, 'The field "a\\u001b]0;x\\u0007" appears twice in the same mapping.');
  assert.equal(findings[2]!.message, 'schema must be the whole number 1, not "1\\u001b[2J".');
});
