/**
 * M5.1: docs/manifest-reference.md, generated from the three template
 * schemas by scripts/gen-manifest-reference.mjs (D104).
 *
 * The committed file must be exactly what the generator writes, and its
 * header must name each input schema with its SHA-256. Every property of every
 * template schema outside an if/then/else/not must have a description and an
 * entry, and no pattern may appear as a regular expression. The layout table
 * is checked against the slide schema itself, slide by slide with the core's
 * Ajv, and each rule the reference names for a field a dedicated rule owns is
 * checked against the rule the validator reports. A schema the generator
 * cannot describe stops it.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, test} from 'node:test';
import {pathToFileURL} from 'node:url';

import * as core from '../../src/core/index.js';
import {TEMPLATE_NAMES, bundledSchema, createAjv, parseManifest, validateManifest} from '../../src/core/index.js';
import {applicationRoot, runCheckScript, scriptPath} from '../helpers/paths.js';

type Entry = {heading: string; anchor: string; pointers: string[]; rules: {rule: string; text: string}[]; description: string};
type Section = {key: string; title: string; properties: string[]; entries: Entry[]};
type Generated = {markdown: string; sections: Section[]; problems: string[]; unreferenced: string[]};
type Generator = {
  generate: (core: unknown, toolRoot?: string) => Generated;
  INPUTS: readonly string[];
  PATTERN_WORDS: Readonly<Record<string, unknown>>;
};

let loaded: Generator | null = null;

async function generator(): Promise<Generator> {
  loaded ??= (await import(pathToFileURL(scriptPath('gen-manifest-reference.mjs')).href)) as Generator;
  return loaded;
}

const REFERENCE = join(applicationRoot, 'docs', 'manifest-reference.md');
const committed = (): string => readFileSync(REFERENCE, 'utf8');

const folders: string[] = [];
after(() => {
  for (const folder of folders) {
    rmSync(folder, {recursive: true, force: true});
  }
});

function temporaryFolder(label: string): string {
  const folder = mkdtempSync(join(tmpdir(), `papeleria-manifest-reference-${label}-`));
  folders.push(folder);
  return folder;
}

type Schema = Record<string, unknown>;

/**
 * Every property and list position of a schema outside if/then/else/not,
 * keyed as the generator keys them: `template#/properties/…` for a template's
 * top level, `#/$defs/…` for a definition.
 */
function describedPlaces(template: string, schema: Schema): {key: string; description: unknown}[] {
  const places: {key: string; description: unknown}[] = [];
  const keyOf = (pointer: string): string => (pointer.startsWith('#/$defs/') ? pointer : `${template}${pointer}`);
  const walk = (node: unknown, pointer: string): void => {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      return;
    }
    for (const [keyword, value] of Object.entries(node as Schema)) {
      if (['if', 'then', 'else', 'not'].includes(keyword)) {
        continue;
      }
      if (keyword === 'properties' || keyword === '$defs') {
        for (const [name, child] of Object.entries(value as Schema)) {
          const at = `${pointer}/${keyword}/${name}`;
          if (keyword === 'properties') {
            places.push({key: keyOf(at), description: (child as Schema)['description']});
          }
          walk(child, at);
        }
      } else if (keyword === 'prefixItems') {
        (value as unknown[]).forEach((child, index) => {
          const at = `${pointer}/prefixItems/${index}`;
          places.push({key: keyOf(at), description: (child as Schema)['description']});
          walk(child, at);
        });
      } else if (keyword === 'oneOf' || keyword === 'allOf') {
        (value as unknown[]).forEach((child, index) => walk(child, `${pointer}/${keyword}/${index}`));
      } else if (keyword === 'items' || keyword === 'additionalProperties') {
        walk(value, `${pointer}/${keyword}`);
      }
    }
  };
  walk(schema, '#');
  return places;
}

function patternsIn(node: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    node.forEach((item) => patternsIn(item, found));
  } else if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'pattern' && typeof value === 'string') {
        found.add(value);
      } else {
        patternsIn(value, found);
      }
    }
  }
  return found;
}

/** The text of one entry or group: from its heading to the next heading of the same or a higher level. */
function block(markdown: string, heading: string): string {
  const lines = markdown.split('\n');
  const start = lines.indexOf(heading);
  assert.notEqual(start, -1, `the reference has no heading ${heading}`);
  const level = /^#+/.exec(heading)![0].length;
  let end = start + 1;
  while (end < lines.length && !new RegExp(`^#{1,${level}} `).test(lines[end]!)) {
    end += 1;
  }
  return lines.slice(start, end).join('\n');
}

test('the committed reference is what the generator writes from the committed schemas', async () => {
  const run = await runCheckScript('gen-manifest-reference.mjs', ['--check']);
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /^checked docs\/manifest-reference\.md: current, \d+ entries$/m);
  const {generate} = await generator();
  const first = generate(core);
  assert.deepEqual(first.problems, []);
  assert.equal(generate(core).markdown, first.markdown, 'two runs give the same bytes');
  assert.equal(first.markdown, committed());
  assert.deepEqual(first.unreferenced, ['template_name'], 'the one shared definition no template uses');
});

test('--check fails on a stale file and --out writes where it is told', async () => {
  const folder = temporaryFolder('out');
  const target = join(folder, 'reference.md');
  const written = await runCheckScript('gen-manifest-reference.mjs', ['--out', target]);
  assert.equal(written.code, 0, written.stderr);
  assert.equal(readFileSync(target, 'utf8'), committed());
  writeFileSync(target, `${committed()}\nA hand edit.\n`);
  const stale = await runCheckScript('gen-manifest-reference.mjs', ['--check', '--out', target]);
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /is not what the schemas give; run npm run gen:manifest-reference/);
  const usage = await runCheckScript('gen-manifest-reference.mjs', ['--out']);
  assert.equal(usage.code, 2);
});

test('the header names each input schema with its SHA-256', async () => {
  const {INPUTS} = await generator();
  assert.deepEqual(
    [...INPUTS].sort(),
    ['templates/comic/schema.json', 'templates/deck/schema.json', 'templates/document/schema.json', 'templates/shared/schema-defs.json'],
  );
  const header = committed().slice(0, committed().indexOf('## Contents'));
  const rows = [...header.matchAll(/^\| `([^`]+)` \| `([0-9a-f]{64})` \|$/gm)].map((match) => [match[1], match[2]]);
  assert.deepEqual(
    rows,
    INPUTS.map((input) => [input, createHash('sha256').update(readFileSync(join(applicationRoot, input))).digest('hex')]),
  );
  assert.doesNotMatch(header, /\b20\d\d-\d\d-\d\d\b|\/home\/|\\Users\\/, 'no date or machine path, so regeneration is byte-identical');
});

test('every property of every template schema is described and has its entry', async () => {
  const {generate} = await generator();
  const result = generate(core);
  const documented = new Map<string, Entry>();
  for (const section of result.sections) {
    for (const entry of section.entries) {
      for (const pointer of entry.pointers) {
        documented.set(pointer, entry);
      }
    }
    assert.deepEqual(section.properties, section.entries.flatMap((entry) => entry.pointers), section.key);
  }
  const everyKey = new Set<string>();
  for (const template of TEMPLATE_NAMES) {
    for (const {key, description} of describedPlaces(template, bundledSchema(template))) {
      everyKey.add(key);
      assert.equal(typeof description, 'string', `${key} has no description`);
      assert.notEqual((description as string).trim(), '', `${key} has a blank description`);
      const entry = documented.get(key);
      assert.ok(entry !== undefined, `${key} has no entry in the reference`);
      assert.ok(entry.description.includes(description as string), `${key}: the entry does not carry the schema's description`);
      assert.ok(result.markdown.includes(description as string), `${key}: its description is not in the reference`);
      assert.ok(result.markdown.includes(`\n#### ${entry.heading}\n`), `${key}: its heading is not in the reference`);
    }
  }
  const beyond = [...documented.keys()].filter((key) => !everyKey.has(key) && !/\/oneOf\/\d+$/.test(key));
  assert.deepEqual(beyond, [], 'no entry for a place the schemas do not have');
  assert.ok(everyKey.size >= 100, `only ${everyKey.size} places were walked`);
});

test('no pattern is printed as a regular expression, and every pattern has words', async () => {
  const {PATTERN_WORDS} = await generator();
  const patterns = new Set<string>();
  for (const template of TEMPLATE_NAMES) {
    patternsIn(bundledSchema(template), patterns);
  }
  assert.ok(patterns.size >= 8);
  const markdown = committed();
  for (const pattern of patterns) {
    assert.ok(Object.hasOwn(PATTERN_WORDS, pattern), `no words for ${pattern}`);
    assert.ok(!markdown.includes(pattern), `${pattern} is printed`);
  }
  for (const fragment of ['(?:', '\\p{', '[A-Za-z0-9', '\\S+', '[0-9a-fA-F]', '[\\s\\S]']) {
    assert.ok(!markdown.includes(fragment), `a regular-expression fragment ${fragment} is printed`);
  }
});

test('every row of the layout table says what the slide schema does', () => {
  const markdown = committed();
  const lines = block(markdown, '### Layouts').split('\n');
  const headerAt = lines.findIndex((line) => line.startsWith('| Layout |'));
  assert.notEqual(headerAt, -1);
  const cells = (line: string): string[] => line.split(' | ').map((cell) => cell.replace(/^\| ?| ?\|$/g, '').trim());
  const fields = cells(lines[headerAt]!).slice(1).map((cell) => cell.replaceAll('`', ''));
  const rows: string[][] = [];
  for (let index = headerAt + 2; index < lines.length && lines[index]!.startsWith('|'); index += 1) {
    rows.push(cells(lines[index]!));
  }

  const deck = bundledSchema('deck') as {$id: string; $defs: {layout: {enum: string[]}; slide: {properties: Schema; required: string[]}}};
  assert.deepEqual(rows.map((row) => row[0]!.replaceAll('`', '')), deck.$defs.layout.enum, 'one row per layout, in the schema order');
  const slideFields = Object.keys(deck.$defs.slide.properties);
  assert.ok(fields.every((field) => slideFields.includes(field)), fields.join());

  const ajv = createAjv();
  ajv.addSchema(deck);
  const validate = ajv.getSchema(`${deck.$id}#/$defs/slide`)!;
  const valid = (slide: Schema): boolean => validate(slide) === true;
  const column = {heading: 'Heading', text: 'Text'};
  const sample: Record<string, (count?: number) => unknown> = {
    columns: (count = 2) => Array.from({length: count}, () => column),
    chart: () => ({type: 'bar', data: 'assets/data/a.csv', x: 'a', y: 'b', summary: 'A summary.'}),
    table: () => ({data: 'assets/data/a.csv'}),
    image: () => ({src: 'assets/images/a.png', alt: 'A picture.'}),
    items: () => [{label: 'Label', text: 'Text'}],
    swatches: () => [{name: 'Name', value: '#fff'}],
  };
  for (const field of fields) {
    assert.ok(sample[field] !== undefined, `the test has no sample for ${field}`);
  }
  const untouched = slideFields.filter((field) => !fields.includes(field) && !deck.$defs.slide.required.includes(field));

  for (const row of rows) {
    const layout = row[0]!.replaceAll('`', '');
    const base: Schema = {layout, title: 'A title'};
    const claims = fields.map((field, index) => ({field, cell: row[index + 1]!}));
    for (const {field, cell} of claims) {
      const exact = /^required, exactly (\d+)$/.exec(cell);
      const pair = /^exactly one of `(\w+)` and `(\w+)`$/.exec(cell);
      if (cell === 'required') {
        base[field] = sample[field]!();
      } else if (exact !== null) {
        base[field] = sample[field]!(Number(exact[1]));
      } else if (pair !== null && pair[1] === field) {
        base[field] = sample[field]!();
      } else {
        assert.ok(cell === '—' || cell === 'optional' || pair !== null, `${layout}/${field}: the cell "${cell}" is not one the test knows`);
      }
    }
    assert.ok(valid(base), `${layout}: the row's own slide does not validate: ${JSON.stringify(base)}`);
    for (const field of untouched) {
      assert.ok(valid({...base, [field]: field === 'notes' ? 'Notes.' : 'Text'}), `${layout} takes ${field}`);
    }
    for (const {field, cell} of claims) {
      const without = {...base};
      delete without[field];
      const exact = /^required, exactly (\d+)$/.exec(cell);
      const pair = /^exactly one of `(\w+)` and `(\w+)`$/.exec(cell);
      if (cell === 'required') {
        assert.equal(valid(without), false, `${layout} needs ${field}`);
      } else if (exact !== null) {
        const count = Number(exact[1]);
        assert.equal(valid(without), false, `${layout} needs ${field}`);
        assert.equal(valid({...base, [field]: sample[field]!(count - 1)}), false, `${layout}: ${count - 1} ${field}`);
        assert.equal(valid({...base, [field]: sample[field]!(count + 1)}), false, `${layout}: ${count + 1} ${field}`);
      } else if (pair !== null) {
        const [first, second] = [pair[1]!, pair[2]!];
        const neither = {...base};
        delete neither[first];
        delete neither[second];
        assert.equal(valid(neither), false, `${layout} needs one of ${first} and ${second}`);
        assert.equal(valid({...neither, [first]: sample[first]!(), [second]: sample[second]!()}), false, `${layout} refuses both`);
        assert.equal(valid({...neither, [second]: sample[second]!()}), true, `${layout} takes ${second} alone`);
      } else if (cell === '—') {
        assert.equal(valid({...base, [field]: sample[field]!()}), false, `${layout} refuses ${field}`);
      } else {
        assert.equal(valid({...base, [field]: sample[field]!()}), true, `${layout} takes ${field}`);
      }
    }
  }
});

type Manifest = Record<string, unknown>;

const deckOf = (slides: unknown[], extra: Manifest = {}): Manifest => ({schema: 1, template: 'deck', title: 'A deck', slides, ...extra});
const comicOf = (pages: unknown[]): Manifest => ({schema: 1, template: 'comic', title: 'A comic', pages});
const documentOf = (blocks: unknown[]): Manifest => ({schema: 1, template: 'document', title: 'A document', sections: [{heading: 'A section', blocks}]});
const page = (extra: Manifest = {}): Manifest => ({image: 'assets/images/pages/01.png', alt: 'A page.', ...extra});
const panel = (extra: Manifest = {}): Manifest => ({box: [0, 0, 50, 50], transcript: 'Words.', ...extra});
const two = [{heading: 'One', text: 'Text'}, {heading: 'Two', text: 'Text'}];
const chart = {type: 'bar', data: 'assets/data/a.csv', x: 'a', y: 'b', summary: 'A summary.'};
const video = {src: 'assets/video/loop.mp4', poster: 'assets/images/poster.png', alt: 'A loop.'};

/** A manifest, the one rule it must produce, and where the reference must name that rule. */
const RULE_CASES: {name: string; manifest: Manifest; rule: string; heading: string}[] = [
  {name: 'a comic page without alt', manifest: comicOf([{image: 'assets/images/pages/01.png'}]), rule: 'R03', heading: '#### `alt` (page)'},
  {name: 'a comic page with blank alt', manifest: comicOf([page({alt: ' '})]), rule: 'R03', heading: '#### `alt` (page)'},
  {name: 'a comic page marked decorative', manifest: comicOf([page({decorative: true})]), rule: 'R03', heading: '### Page fields'},
  {name: 'a panel without a transcript', manifest: comicOf([page({panels: [{box: [0, 0, 50, 50]}]})]), rule: 'R04', heading: '#### `transcript` (panel)'},
  {name: 'a blank transcript', manifest: comicOf([page({panels: [panel({transcript: '​'})]})]), rule: 'R04', heading: '#### `transcript` (panel)'},
  {name: 'a box with no width', manifest: comicOf([page({panels: [panel({box: [0, 0, 0, 50]})]})]), rule: 'R14', heading: '#### `width` (panel box)'},
  {name: 'a box over 100', manifest: comicOf([page({panels: [panel({box: [101, 0, 10, 50]})]})]), rule: 'R14', heading: '#### `x` (panel box)'},
  {name: 'a box of three numbers', manifest: comicOf([page({panels: [panel({box: [0, 0, 50]})]})]), rule: 'R14', heading: '#### `box` (panel)'},
  {name: 'a box that is not a list', manifest: comicOf([page({panels: [panel({box: 'wide'})]})]), rule: 'R14', heading: '#### `box` (panel)'},
  {name: 'a panel without a box', manifest: comicOf([page({panels: [{transcript: 'Words.'}]})]), rule: 'R09', heading: '#### `box` (panel)'},
  {name: 'three columns on a two slide', manifest: deckOf([{layout: 'two', title: 'T', columns: [...two, two[0]]}]), rule: 'R15', heading: '#### `columns` (slide)'},
  {name: 'a two slide without columns', manifest: deckOf([{layout: 'two', title: 'T'}]), rule: 'R15', heading: '#### `columns` (slide)'},
  {name: 'columns on a cover slide', manifest: deckOf([{layout: 'cover', title: 'T', columns: two}]), rule: 'R15', heading: '#### `columns` (slide)'},
  {name: 'columns that are not a list', manifest: deckOf([{layout: 'two', title: 'T', columns: 'two'}]), rule: 'R09', heading: '#### `columns` (slide)'},
  {name: 'a chart slide with a chart and a table', manifest: deckOf([{layout: 'chart', title: 'T', chart, table: {data: 'assets/data/a.csv'}}]), rule: 'R09', heading: '#### `chart` (slide)'},
  {name: 'an image with neither alt nor decorative', manifest: deckOf([{layout: 'image', title: 'T', image: {src: 'assets/images/a.png'}}]), rule: 'R03', heading: '#### `alt` (image block)'},
  {name: 'an image with alt and decorative', manifest: deckOf([{layout: 'image', title: 'T', image: {src: 'assets/images/a.png', alt: 'A.', decorative: true}}]), rule: 'R03', heading: '#### `decorative` (image block)'},
  {name: 'decorative: false', manifest: deckOf([{layout: 'image', title: 'T', image: {src: 'assets/images/a.png', decorative: false}}]), rule: 'R03', heading: '#### `decorative` (image block)'},
  {name: 'a deck logo without alt', manifest: deckOf([{layout: 'cover', title: 'T'}], {logo: {src: 'assets/images/logos/client.svg'}}), rule: 'R03', heading: '#### `alt` (logo block)'},
  {name: 'a logo marked decorative', manifest: deckOf([{layout: 'cover', title: 'T'}], {logo: {src: 'assets/images/logos/client.svg', alt: 'Client', decorative: true}}), rule: 'R03', heading: '### Logo block'},
  {name: 'a video without alt', manifest: documentOf([{video: {src: video.src, poster: video.poster}}]), rule: 'R10', heading: '#### `alt` (video block)'},
  {name: 'a video marked decorative', manifest: documentOf([{video: {...video, decorative: true}}]), rule: 'R10', heading: '### Video block'},
  {name: 'a chart without a summary', manifest: documentOf([{chart: {type: 'bar', data: 'assets/data/a.csv', x: 'a', y: 'b'}}]), rule: 'R05', heading: '#### `summary` (chart block)'},
  {name: 'a blank summary', manifest: documentOf([{chart: {...chart, summary: '   '}}]), rule: 'R05', heading: '#### `summary` (chart block)'},
  {name: 'orientation on a line chart', manifest: documentOf([{chart: {...chart, type: 'line', orientation: 'horizontal'}}]), rule: 'R09', heading: '#### `orientation` (chart block)'},
  {name: 'a detail with zoom and text', manifest: comicOf([page({panels: [panel({detail: {zoom: true, text: 'More.'}})]})]), rule: 'R09', heading: '#### `zoom` (detail)'},
  {name: 'a link without a label', manifest: comicOf([page({panels: [panel({detail: {href: 'https://example.org/'}})]})]), rule: 'R09', heading: '#### `label` (detail)'},
  {name: 'a block of two kinds', manifest: documentOf([{text: 'Words.', callout: {text: 'More.'}}]), rule: 'R09', heading: '#### `callout` (block kind)'},
  {name: 'a blank title', manifest: {...deckOf([{layout: 'cover', title: 'T'}]), title: '  '}, rule: 'R09', heading: '#### `title` (piece)'},
  {name: 'a newer schema', manifest: {...deckOf([{layout: 'cover', title: 'T'}]), schema: 2}, rule: 'R17', heading: '#### `schema` (piece)'},
  {name: 'an older schema', manifest: {...deckOf([{layout: 'cover', title: 'T'}]), schema: 0}, rule: 'R09', heading: '#### `schema` (piece)'},
];

test('each rule the reference names for a field is the rule the validator reports', () => {
  const markdown = committed();
  for (const {name, manifest, rule, heading} of RULE_CASES) {
    const parsed = parseManifest(JSON.stringify(manifest), 'papeleria.json');
    const findings = parsed.manifest === null ? parsed.findings : validateManifest(parsed.manifest).findings;
    const rules = [...new Set(findings.map((item) => item.finding.rule))];
    assert.deepEqual(rules, [rule], `${name}: ${findings.map((item) => `${item.finding.rule} ${item.finding.message}`).join(' | ')}`);
    const text = block(markdown, heading);
    const named = heading.startsWith('#### ') ? new RegExp(`^  - ${rule}: `, 'm') : new RegExp(`is ${rule}(?:,|\\.)`);
    assert.match(text, named, `${name}: ${heading} does not name ${rule}`);
  }
});

test('a schema the generator cannot describe stops it, and says where', async () => {
  const {generate} = await generator();
  const change = (label: string, edit: (files: Record<string, Schema>) => void): string[] => {
    const root = temporaryFolder(label);
    const files: Record<string, Schema> = {};
    for (const name of ['shared/schema-defs.json', 'deck/schema.json', 'comic/schema.json', 'document/schema.json']) {
      files[name] = JSON.parse(readFileSync(join(applicationRoot, 'templates', name), 'utf8')) as Schema;
    }
    edit(files);
    for (const [name, schema] of Object.entries(files)) {
      mkdirSync(join(root, 'templates', name.split('/')[0]!), {recursive: true});
      writeFileSync(join(root, 'templates', name), JSON.stringify(schema, null, 2));
    }
    return generate(core, root).problems;
  };
  const defs = (files: Record<string, Schema>): Record<string, Schema> => files['shared/schema-defs.json']!['$defs'] as Record<string, Schema>;

  assert.deepEqual(change('unchanged', () => undefined), []);
  const keyword = change('keyword', (files) => {
    defs(files)['non_empty_string']!['maxLength'] = 500;
  });
  assert.ok(keyword.some((problem) => /non_empty_string: the keyword maxLength is not one this generator can describe/.test(problem)), keyword.join('\n'));
  const undescribed = change('undescribed', (files) => {
    delete ((defs(files)['swatch']!['properties'] as Record<string, Schema>)['use']!)['description'];
  });
  assert.ok(undescribed.some((problem) => /swatch\/properties\/use: has no description/.test(problem)), undescribed.join('\n'));
  const unexampled = change('unexampled', (files) => {
    (files['deck/schema.json']!['properties'] as Record<string, Schema>)['subtitle'] = {type: 'string', description: 'A new field.'};
  });
  assert.ok(unexampled.some((problem) => /deck#\/properties\/subtitle: has no example/.test(problem)), unexampled.join('\n'));
  const invalid = change('invalid', (files) => {
    defs(files)['language']!['enum'] = ['en'];
  });
  assert.ok(invalid.some((problem) => /properties\/language: the example "es" does not validate/.test(problem)), invalid.join('\n'));
  const pattern = change('pattern', (files) => {
    defs(files)['hex_color']!['pattern'] = '^#[0-9a-f]{6}$';
  });
  assert.ok(pattern.some((problem) => /has no words in PATTERN_WORDS/.test(problem)), pattern.join('\n'));
  const layout = change('layout', (files) => {
    const slide = (files['deck/schema.json']!['$defs'] as Record<string, Schema>)['slide']!;
    (slide['allOf'] as Schema[]).push({if: {type: 'object', properties: {title: {const: 'x'}}, required: ['title']}, then: {required: ['lead']}});
  });
  assert.ok(layout.some((problem) => /slide\/allOf\/\d+: only "if the layout is one of these, then" can be described/.test(problem)), layout.join('\n'));
});

test('the generator is wired as an npm script that builds first', () => {
  const manifest = JSON.parse(readFileSync(join(applicationRoot, 'package.json'), 'utf8')) as {scripts: Record<string, string>};
  assert.equal(manifest.scripts['gen:manifest-reference'], 'npm run build && node scripts/gen-manifest-reference.mjs');
});
