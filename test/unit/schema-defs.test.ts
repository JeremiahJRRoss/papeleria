/**
 * M0.6: templates/shared/schema-defs.json compiles under Ajv 2020-12 in strict
 * mode, every definition and property carries help text, and the fixture cases
 * behave. The checker itself is proved non-vacuous by a fixture whose
 * expectations are deliberately wrong.
 */
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, test} from 'node:test';

import ajv2020Module from 'ajv/dist/2020.js';

import {applicationRoot, fixturePath, runCheckScript} from '../helpers/paths.js';

const Ajv2020 = ajv2020Module as unknown as typeof ajv2020Module.default;

const temporaryRoots: string[] = [];
after(() => {
  for (const directory of temporaryRoots) {
    rmSync(directory, {recursive: true, force: true});
  }
});

const schemaPath = join(applicationRoot, 'templates', 'shared', 'schema-defs.json');
type SchemaDocument = {
  $id: string;
  $schema: string;
  $defs: Record<string, {description?: string}>;
};
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as SchemaDocument;

test('the shipped definitions compile and every case behaves', async () => {
  const result = await runCheckScript('check-schema-defs.mjs', []);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /compiled: (\d+) of \1 definition\(s\) with Ajv 2020-12 in strict mode/);
  assert.match(result.stdout, /descriptions: every definition, property and tuple slot/);
  assert.match(result.stdout, /result: pass/);
});

test('the case runner is not vacuous', async () => {
  const result = await runCheckScript('check-schema-defs.mjs', [
    '--cases',
    fixturePath('schema-defs', 'cases-broken.json'),
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /result: FAIL — 4 problem\(s\)/);
  assert.match(result.stdout, /names the unknown definition "no_such_definition"/);
});

test('an undescribed property fails the check', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'papeleria-schema-'));
  temporaryRoots.push(directory);
  const mutated = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
    $defs: {credit: {properties: Record<string, {description?: string}>}};
  };
  delete mutated.$defs.credit.properties['role']!.description;
  const file = join(directory, 'schema-defs.json');
  writeFileSync(file, JSON.stringify(mutated));
  const result = await runCheckScript('check-schema-defs.mjs', ['--schema', file]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /#\/\$defs\/credit\/properties\/role has no description/);
});

test('the document declares 2020-12 and a stable identifier', () => {
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.match(schema.$id, /^https:\/\/\S+schema-defs\.json$/);
});

test('every common manifest field, block and shared type is defined', () => {
  const required = [
    'schema_version', 'template_name', 'title', 'language', 'status', 'wordmark', 'credit', 'credits',
    'non_empty_string', 'text_value', 'text_file_path', 'image_path', 'logo_path', 'data_path', 'video_path',
    'focal_point', 'panel_box', 'panel', 'detail', 'metadata_item', 'item', 'swatch', 'column', 'table_column',
    'text_block', 'image_block', 'video_block', 'chart_block', 'table_block',
    'quote_block', 'note_block', 'callout_block', 'logo_block', 'block', 'blocks',
  ];
  for (const name of required) {
    assert.ok(Object.hasOwn(schema.$defs, name), `$defs.${name} is missing`);
    assert.equal(typeof schema.$defs[name]!.description, 'string', `$defs.${name} has no description`);
  }
});

test('the block wrapper covers the nine kinds of ERD section 05', () => {
  const block = schema.$defs['block'] as unknown as {
    properties: Record<string, unknown>;
    minProperties: number;
    maxProperties: number;
    additionalProperties: boolean;
  };
  assert.deepEqual(Object.keys(block.properties).sort(), [
    'callout', 'chart', 'image', 'logo', 'note', 'quote', 'table', 'text', 'video',
  ]);
  assert.equal(block.minProperties, 1);
  assert.equal(block.maxProperties, 1);
  assert.equal(block.additionalProperties, false);
});

test('Ajv validates against the definitions directly, not only through the script', () => {
  const ajv = new Ajv2020({strict: true, strictTypes: true, strictTuples: true, strictRequired: false});
  ajv.addSchema(schema);

  const blockValidator = ajv.getSchema(`${schema.$id}#/$defs/block`);
  assert.equal(typeof blockValidator, 'function');
  assert.equal(blockValidator!({text: 'A paragraph.'}), true);
  assert.equal(blockValidator!({}), false, 'zero kind keys');
  assert.equal(blockValidator!({text: 'a', note: {text: 'b'}}), false, 'two kind keys');

  const detailValidator = ajv.getSchema(`${schema.$id}#/$defs/detail`);
  assert.equal(detailValidator!({zoom: true}), true);
  assert.equal(detailValidator!({}), false, 'zero detail keys');
  assert.equal(detailValidator!({zoom: true, text: 'x'}), false, 'two detail keys');

  const stringValidator = ajv.getSchema(`${schema.$id}#/$defs/non_empty_string`);
  assert.equal(stringValidator!('x'), true);
  assert.equal(stringValidator!('   '), false, 'whitespace only');
  assert.equal(stringValidator!(''), false, 'empty');
});

test('the fixture covers the required-string and union cases explicitly', () => {
  const cases = JSON.parse(readFileSync(fixturePath('schema-defs', 'cases.json'), 'utf8')) as {
    cases: {def: string; value: unknown; valid: boolean}[];
  };
  const has = (def: string, valid: boolean, predicate: (value: unknown) => boolean): boolean =>
    cases.cases.some((entry) => entry.def === def && entry.valid === valid && predicate(entry.value));

  const isEmptyObject = (value: unknown): boolean =>
    typeof value === 'object' && value !== null && Object.keys(value).length === 0;
  const hasTwoKeys = (value: unknown): boolean =>
    typeof value === 'object' && value !== null && Object.keys(value).length === 2;

  assert.ok(has('non_empty_string', false, (value) => value === '   '), 'whitespace-only string');
  assert.ok(has('block', false, isEmptyObject), 'block union at zero keys');
  assert.ok(has('block', false, hasTwoKeys), 'block union at two keys');
  assert.ok(has('detail', false, isEmptyObject), 'detail union at zero keys');
  assert.ok(has('detail', false, hasTwoKeys), 'detail union at two keys');
  assert.ok(cases.cases.length >= 100, 'the fixture must cover every definition');
});
