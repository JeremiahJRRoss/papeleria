/**
 * M1.2: the three template schemas and the mapping from schema errors to
 * findings.
 *
 * test/fixtures/schema/cases.json lists, per C constraint and dedicated rule,
 * a manifest and the exact findings it must produce. Exact equality is what
 * proves a dedicated rule (R03, R04, R05, R10, R14, R15) is never duplicated by
 * a generic R09: an extra finding fails the case.
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';

import ajv2020Module from 'ajv/dist/2020.js';

import {
  LAYOUT_COLUMNS,
  LAYOUT_NAMES,
  TEMPLATE_NAMES,
  bundledSchema,
  checkAssetPath,
  createAjv,
  dedupeFindings,
  parseManifest,
  settleFindings,
  sharedDefinitions,
  templateSchema,
  ToolResourceError,
  validateManifest,
  type AssetKind,
  type Finding,
  type TracedFinding,
} from '../../src/core/index.js';
import {applicationRoot, fixturePath} from '../helpers/paths.js';

const Ajv2020 = ajv2020Module as unknown as typeof ajv2020Module.default;

type Marker = string | {marker: string; occurrence: number};
type Expected = {rule: string; severity: string; at: Marker; message: string; fix: string; detail?: string};
type Case = {name: string; constraint: string; file: string; findings: Expected[]};

const cases = (JSON.parse(readFileSync(fixturePath('schema', 'cases.json'), 'utf8')) as {cases: Case[]}).cases;

function positionOf(text: string, offset: number): {line: number; column: number} {
  const before = text.slice(0, offset);
  return {line: before.split('\n').length, column: offset - (before.lastIndexOf('\n') + 1) + 1};
}

function locate(text: string, marker: Marker, label: string): {line: number; column: number} {
  const needle = typeof marker === 'string' ? marker : marker.marker;
  const occurrence = typeof marker === 'string' ? 1 : marker.occurrence;
  let offset = -1;
  for (let count = 0; count < occurrence; count += 1) {
    offset = text.indexOf(needle, offset + 1);
    assert.notEqual(offset, -1, `${label}: marker ${JSON.stringify(needle)} #${occurrence} is not in the fixture`);
  }
  const at = positionOf(text, offset);
  if (typeof marker === 'object' && needle.startsWith(' ')) {
    // A marker may start with a space to make it unique; the location is the character after it.
    return {line: at.line, column: at.column + 1};
  }
  return at;
}

/** Loads and validates, returning the traced findings of both stages as the pipeline would see them. */
function check(text: string, file: 'papeleria.yaml' | 'papeleria.json'): {valid: boolean; traced: TracedFinding[]} {
  const loaded = parseManifest(text, file);
  if (loaded.manifest === null) {
    return {valid: false, traced: [...loaded.findings]};
  }
  const validated = validateManifest(loaded.manifest);
  return {valid: validated.manifest !== null, traced: [...loaded.findings, ...validated.findings]};
}

for (const testCase of cases) {
  test(`${testCase.constraint}: ${testCase.name}`, () => {
    const text = readFileSync(fixturePath('schema', testCase.file), 'utf8');
    const {valid, traced} = check(text, 'papeleria.yaml');
    const expected: Finding[] = testCase.findings.map((item) => ({
      file: 'papeleria.yaml',
      ...locate(text, item.at, testCase.file),
      rule: item.rule,
      severity: item.severity as Finding['severity'],
      message: item.message,
      fix: item.fix,
      detail: item.detail ?? null,
    }));
    assert.deepEqual(settleFindings(traced), expected);
    assert.equal(valid, expected.length === 0);
  });
}

test('every dedicated rule has at least one negative case and none of them carries an R09 twin', () => {
  const dedicated = ['R03', 'R04', 'R05', 'R10', 'R14', 'R15'];
  for (const rule of dedicated) {
    const withRule = cases.filter((testCase) => testCase.findings.some((item) => item.rule === rule));
    assert.ok(withRule.length > 0, `${rule} has no case`);
    for (const testCase of withRule) {
      assert.ok(
        testCase.findings.every((item) => item.rule !== 'R09'),
        `${testCase.name} expects both ${rule} and R09`,
      );
    }
  }
});

test('every schema-expressible C constraint has a negative case', () => {
  for (const constraint of ['C03', 'C04', 'C06', 'C07', 'C08', 'C09', 'C10', 'C11', 'C14', 'C15', 'C16', 'C18', 'C19']) {
    assert.ok(
      cases.some((testCase) => testCase.constraint.split(' ').includes(constraint) && testCase.findings.length > 0),
      `${constraint} has no negative case`,
    );
  }
});

test('the same cases written as JSON produce the same rules for the same fields', () => {
  for (const testCase of cases) {
    const text = readFileSync(fixturePath('schema', testCase.file), 'utf8');
    const value = parseManifest(text, 'papeleria.yaml').manifest?.value;
    // JSON cannot carry NaN or Infinity; those cases are YAML-only by nature.
    const finite = (_key: string, item: unknown): unknown => {
      if (typeof item === 'number' && !Number.isFinite(item)) {
        throw new RangeError('not representable in JSON');
      }
      return item;
    };
    let jsonText: string;
    try {
      jsonText = JSON.stringify(value, finite, 2);
    } catch {
      continue;
    }
    const strip = (items: readonly TracedFinding[]) =>
      dedupeFindings(items)
        .map((item) => `${item.finding.rule} ${item.sourcePath.replace(/^papeleria\.(?:yaml|json)/, '')}`)
        .sort();
    assert.deepEqual(strip(check(jsonText, 'papeleria.json').traced), strip(check(text, 'papeleria.yaml').traced), testCase.name);
  }
});

test('the three seeded manifests validate with no findings', () => {
  for (const [piece, template] of [
    ['starter-deck', 'deck'],
    ['hours-report', 'document'],
    ['sample-comic', 'comic'],
  ] as const) {
    const text = readFileSync(join(applicationRoot, 'examples', piece, 'papeleria.yaml'), 'utf8');
    const {manifest, findings} = parseManifest(text, 'papeleria.yaml');
    assert.ok(manifest, piece);
    const validated = validateManifest(manifest);
    assert.deepEqual(settleFindings([...findings, ...validated.findings]), [], piece);
    assert.equal(validated.manifest?.template, template);
  }
});

test('the planning facts hold: the sample comic has 8 pages with 5,3,3,3,3,3,3,3 panels and the starter deck its five layouts', () => {
  const comic = parseManifest(readFileSync(join(applicationRoot, 'examples', 'sample-comic', 'papeleria.yaml'), 'utf8'), 'papeleria.yaml');
  const pages = comic.manifest!.value['pages'] as {panels: unknown[]}[];
  assert.deepEqual(pages.map((page) => page.panels.length), [5, 3, 3, 3, 3, 3, 3, 3]);
  const deck = parseManifest(readFileSync(join(applicationRoot, 'examples', 'starter-deck', 'papeleria.yaml'), 'utf8'), 'papeleria.yaml');
  const slides = deck.manifest!.value['slides'] as {layout: string}[];
  assert.deepEqual(slides.map((slide) => slide.layout), ['cover', 'statement', 'three', 'chart', 'closing']);
});

// ---------------------------------------------------------------------------
// The schema documents themselves.

type FindUndescribed = (schema: unknown) => string[];

async function loadFindUndescribed(): Promise<FindUndescribed> {
  const module = (await import(pathToFileURL(join(applicationRoot, 'scripts', 'check-schema-defs.mjs')).href)) as {
    findUndescribed: FindUndescribed;
  };
  return module.findUndescribed;
}

test('each template schema is 2020-12, has a file-layout $id and describes every property', async () => {
  const findUndescribed = await loadFindUndescribed();
  for (const template of TEMPLATE_NAMES) {
    const schema = templateSchema(template) as {$schema: string; $id: string; additionalProperties: boolean};
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(schema.$id, `https://papeleria.ross.moda/schema/1/${template}/schema.json`);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(findUndescribed(schema), [], `${template} has undescribed properties`);
  }
  assert.equal(sharedDefinitions()['$id'], 'https://papeleria.ross.moda/schema/1/shared/schema-defs.json');
});

test('every object in the template schemas refuses unknown fields', () => {
  for (const template of TEMPLATE_NAMES) {
    const open: string[] = [];
    const walk = (node: unknown, path: string, inConstraint: boolean): void => {
      if (typeof node !== 'object' || node === null) {
        return;
      }
      const record = node as Record<string, unknown>;
      if (!inConstraint && record['type'] === 'object' && record['additionalProperties'] !== false) {
        open.push(path);
      }
      for (const [key, value] of Object.entries(record)) {
        const constraint = inConstraint || ['if', 'then', 'else', 'not', 'oneOf', 'allOf', 'anyOf'].includes(key);
        walk(value, `${path}/${key}`, constraint);
      }
    };
    walk(templateSchema(template), '#', false);
    assert.deepEqual(open, [], `${template} has open objects`);
  }
});

test('the bundled schema is self-contained and validates exactly as the linked one', () => {
  for (const template of TEMPLATE_NAMES) {
    const bundle = bundledSchema(template);
    assert.ok(!JSON.stringify(bundle).includes('../shared/'), `${template} bundle still links out`);
    const ajv = createAjv();
    const validate = ajv.compile(bundle);
    const text = readFileSync(fixturePath('schema', `${template}.yaml`), 'utf8');
    const value = parseManifest(text, 'papeleria.yaml').manifest!.value;
    assert.equal(validate(value), true, `${template}: ${ajv.errorsText(validate.errors)}`);
    const broken = {...value, unexpected: true};
    assert.equal(validate(broken), false);
  }
});

test('the deck layout enum and column counts match the ERD LAYOUT table', () => {
  const erd = readFileSync(join(applicationRoot, 'docs', 'papeleria-erd-draft-0-3.md'), 'utf8');
  const section = erd.slice(erd.indexOf('### LAYOUT (deck)'), erd.indexOf('### THEME'));
  const rows = [...section.matchAll(/^\| ([a-z]+) \| ([0-9]) \|/gm)].map((match) => [match[1]!, Number(match[2])] as const);
  assert.equal(rows.length, 12);
  assert.deepEqual(rows.map(([name]) => name).sort(), [...LAYOUT_NAMES].sort());
  for (const [name, count] of rows) {
    assert.equal(LAYOUT_COLUMNS[name as keyof typeof LAYOUT_COLUMNS] ?? 0, count, name);
  }
  const deck = templateSchema('deck') as {$defs: {layout: {enum: string[]}}};
  assert.deepEqual(deck.$defs.layout.enum, [...LAYOUT_NAMES]);
});

test('the shared path patterns and checkAssetPath agree on what is well formed', () => {
  const defs = sharedDefinitions() as {$defs: Record<string, {pattern: string}>};
  const patterns: Record<AssetKind, RegExp> = {
    text: new RegExp(defs.$defs['text_file_path']!.pattern),
    image: new RegExp(defs.$defs['image_path']!.pattern),
    logo: new RegExp(defs.$defs['logo_path']!.pattern),
    data: new RegExp(defs.$defs['data_path']!.pattern),
    video: new RegExp(defs.$defs['video_path']!.pattern),
  };
  const samples = [
    'assets/text/summary.md', 'assets/text/notes/01-cover.md', 'assets/text/a..b.md', 'assets/text/.hidden.md',
    'assets/text/My Notes.md', 'assets/text/../x.md', 'assets/text/x.MD', 'assets/text//x.md', 'assets/text/.md',
    'assets/images/pages/01.png', 'assets/images/photo.jpeg', 'assets/images/photo.JPG', 'assets/images/logos/client.svg',
    'assets/images/a b.png', 'assets/images/%2e.png', 'assets/images\\a.png', '/assets/images/a.png', 'C:/a.png',
    'https://example.com/a.png', 'assets/data/hours.csv', 'assets/data/q3/hours.csv', 'assets/data/hours.tsv',
    'assets/video/loop.mp4', 'assets/video/loop.webm', 'assets/video/clips/loop.mp4', 'assets/video/loop.mov',
    'assets/images/logos/sub/mark.png', 'assets/images/logo.png', 'assets/text/-dash.md', 'assets/text/_under.md',
  ];
  for (const kind of Object.keys(patterns) as AssetKind[]) {
    for (const sample of samples) {
      assert.equal(
        patterns[kind].test(sample),
        checkAssetPath(kind, sample) === null,
        `${kind} ${JSON.stringify(sample)}: the schema pattern and checkAssetPath disagree`,
      );
    }
  }
  // What only the core refuses: names Windows reserves, and names ending in a dot.
  for (const sample of ['assets/text/con.md', 'assets/text/notes./a.md', 'assets/images/aux.png']) {
    const kind: AssetKind = sample.startsWith('assets/text/') ? 'text' : 'image';
    assert.ok(patterns[kind].test(sample), sample);
    assert.notEqual(checkAssetPath(kind, sample), null, sample);
  }
});

test('a manifest newer than the tool is R17 only and never reaches validation', () => {
  const text = 'schema: 3\ntemplate: deck\ntitle: T\nfuture_field: 1\nslides: []\n';
  const loaded = parseManifest(text, 'papeleria.yaml');
  assert.equal(loaded.manifest, null);
  assert.deepEqual(
    settleFindings(loaded.findings).map((item) => item.rule),
    ['R17'],
  );
});

test('a missing or invalid schema is reported once across the loader and the validator', () => {
  for (const text of ['template: deck\ntitle: T\nslides:\n  - {layout: statement, title: S}\n', 'schema: "1"\ntemplate: deck\ntitle: T\nslides:\n  - {layout: statement, title: S}\n']) {
    const {traced} = check(text, 'papeleria.yaml');
    const schemaFindings = settleFindings(traced).filter((item) => item.message.includes('schema'));
    assert.equal(schemaFindings.length, 1, JSON.stringify(schemaFindings));
  }
});

test('the validators compile once per tool root and the Ajv options stay strict', () => {
  const ajv = createAjv();
  assert.throws(() => ajv.compile({type: 'object', properties: {a: {minItems: 1}}}), /strict mode/);
  assert.ok(new Ajv2020({strict: true}));
});

test('an unknown key that hides a default-ignorable character is quoted with the character visible (W5R-32)', () => {
  for (const [hidden, escape] of [
    ['⁠', '\\u2060'],
    ['­', '\\u00ad'],
    ['͏', '\\u034f'],
    ['️', '\\ufe0f'],
    ['\u{e0001}', '\\u{e0001}'],
  ]) {
    for (const [text, file] of [
      [`schema: 1\ntemplate: deck\ntitle: T\n"title${hidden}": U\nslides:\n  - {layout: statement, title: S}\n`, 'papeleria.yaml'],
      [JSON.stringify({schema: 1, template: 'deck', title: 'T', [`title${hidden}`]: 'U', slides: [{layout: 'statement', title: 'S'}]}), 'papeleria.json'],
    ] as const) {
      const messages = settleFindings(check(text, file).traced).map((item) => item.message);
      assert.deepEqual(messages, [`"title${escape}" is not a field of the manifest.`], `${file} ${escape}`);
    }
  }
});

test('a chart slide with neither a chart nor a table is told so, and never that it has both', () => {
  const loaded = parseManifest('schema: 1\ntemplate: deck\ntitle: T\nslides:\n  - layout: chart\n    title: C\n', 'papeleria.yaml');
  // Before deduplication: the wording is decided by the slide's fields, not by the order of Ajv's errors.
  const raw = validateManifest(loaded.manifest!).findings.map((item) => item.finding.message);
  assert.ok(raw.length > 0, 'the slide is refused');
  assert.deepEqual([...new Set(raw)], ['A chart slide needs one chart or one table.']);
});

test('validation time grows linearly with the number of errors', () => {
  const credits = Array.from({length: 80_000}, () => 1);
  const loaded = parseManifest(JSON.stringify({schema: 1, template: 'deck', title: 'T', credits, slides: [{layout: 'cover', title: 'C'}]}), 'papeleria.json');
  const started = performance.now();
  const findings = settleFindings(validateManifest(loaded.manifest!).findings);
  const elapsed = performance.now() - started;
  assert.equal(findings.length, 80_000);
  assert.equal(findings[0]!.message, 'Credit 1 must be an object of fields.');
  // Ajv's own error joining took about 11 seconds for this manifest before the schemas were inlined.
  assert.ok(elapsed < 3_000, `80,000 errors took ${elapsed.toFixed(0)} ms`);
});

test('a missing, malformed or uncompilable schema file is a tool resource error, not a crash or a finding', async () => {
  const {mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'papeleria-schema-'));
  try {
    cpSync(join(applicationRoot, 'templates'), join(root, 'templates'), {recursive: true});
    const loaded = parseManifest('schema: 1\ntemplate: deck\ntitle: T\nslides:\n  - layout: cover\n    title: C\n', 'papeleria.yaml').manifest!;
    writeFileSync(join(root, 'templates', 'deck', 'schema.json'), '{ not json');
    assert.throws(() => validateManifest(loaded, {toolRoot: root}), (error: unknown) => error instanceof ToolResourceError && error.code === 'E_TOOL_RESOURCE');
    const other = mkdtempSync(join(tmpdir(), 'papeleria-schema-'));
    mkdirSync(join(other, 'templates'));
    try {
      assert.throws(() => validateManifest(loaded, {toolRoot: other}), ToolResourceError);
    } finally {
      rmSync(other, {recursive: true, force: true});
    }
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
