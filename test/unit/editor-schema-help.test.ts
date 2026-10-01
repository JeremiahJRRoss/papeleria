/**
 * M2.2: the editor's hover help, built from the real bundled schemas (D75).
 * The three cases the DEP02 re-run found the adapter's own hover missing: a
 * description written beside a `$ref`, a tuple's own slot (`prefixItems`),
 * and the `then` an `if` chooses for the value under the cursor (C05's text
 * file path). Every expected text is read from the schema files, so the test
 * follows them when they are reworded.
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';

import {bundledSchema} from '../../src/core/index.js';
import {helpAt, holds, MAX_DESCRIPTIONS, pointerSegments} from '../../src/editor/schema-help.js';
import {applicationRoot} from '../helpers/paths.js';

type Schema = {
  description: string;
  properties: Record<string, Schema>;
  items: Schema;
  prefixItems: Schema[];
  $defs: Record<string, Schema>;
};

function schemaFile(...parts: string[]): Schema {
  return JSON.parse(readFileSync(join(applicationRoot, 'templates', ...parts), 'utf8')) as Schema;
}

const SHARED = schemaFile('shared', 'schema-defs.json').$defs;
const DECK = schemaFile('deck', 'schema.json');
const deck = bundledSchema('deck', applicationRoot);
const comic = bundledSchema('comic', applicationRoot);
const documentSchema = bundledSchema('document', applicationRoot);

const SLIDE = DECK.$defs['slide']!.properties;

test('a description written beside a $ref comes first, then the definition’s own', () => {
  const help = helpAt(deck, ['slides', 0, 'image', 'focal_point'], undefined);
  assert.deepEqual(help, {
    descriptions: [SHARED['image_block']!.properties['focal_point']!.description, SHARED['focal_point']!.description],
    summary: 'A list of exactly 2.',
  });
  const layout = helpAt(deck, ['slides', 3, 'layout'], undefined);
  assert.deepEqual(layout?.descriptions, [SLIDE['layout']!.description, DECK.$defs['layout']!.description]);
  assert.match(layout?.summary ?? '', /^One of cover, statement, closing, .* or wordmark\.$/);
});

test('each slot of a prefixItems tuple has its own help, and a slot past the tuple has none', () => {
  const [x, y] = SHARED['focal_point']!.prefixItems;
  assert.deepEqual(helpAt(deck, ['slides', 0, 'image', 'focal_point', 0], undefined), {descriptions: [x!.description], summary: 'A number from 0 to 100.'});
  assert.deepEqual(helpAt(deck, ['slides', 0, 'image', 'focal_point', '1'], undefined), {descriptions: [y!.description], summary: 'A number from 0 to 100.'});
  assert.equal(helpAt(deck, ['slides', 0, 'image', 'focal_point', 2], undefined), null);
  const width = SHARED['panel_box']!.prefixItems[2]!;
  assert.deepEqual(helpAt(comic, ['pages', 0, 'panels', 0, 'box', 2], undefined), {descriptions: [width.description], summary: 'A number from 0 to 100, above the first.'});
  assert.deepEqual(helpAt(comic, ['pages', 0, 'panels', 0, 'box'], undefined)?.descriptions, [SHARED['panel']!.properties['box']!.description, SHARED['panel_box']!.description]);
});

test('the then an if chooses for this very value comes first: a notes value naming a Markdown file is a text file path (C05)', () => {
  const file = {slides: [{layout: 'cover', title: 'One', notes: 'assets/text/01-cover-notes.md'}]};
  assert.deepEqual(helpAt(deck, ['slides', 0, 'notes'], file)?.descriptions, [
    SHARED['text_file_path']!.description,
    SLIDE['notes']!.description,
    SHARED['notes']!.description,
  ]);
  const written = {slides: [{layout: 'cover', title: 'One', notes: 'Say hello first.'}]};
  assert.deepEqual(helpAt(deck, ['slides', 0, 'notes'], written)?.descriptions, [SLIDE['notes']!.description, SHARED['notes']!.description, SHARED['text_value']!.description]);
  // Nothing typed yet: no branch is chosen, and the plain descriptions stand.
  assert.deepEqual(helpAt(deck, ['slides', 0, 'notes'], undefined)?.descriptions, [SLIDE['notes']!.description, SHARED['notes']!.description, SHARED['text_value']!.description]);
});

test('help never shows more than three descriptions, each once', () => {
  for (const [schema, path] of [
    [deck, ['slides', 0, 'notes']],
    [deck, ['status']],
    [comic, ['title']],
    [documentSchema, ['title']],
  ] as const) {
    const help = helpAt(schema, path, undefined);
    assert.ok(help !== null, path.join('/'));
    assert.ok(help.descriptions.length <= MAX_DESCRIPTIONS);
    assert.equal(new Set(help.descriptions).size, help.descriptions.length);
  }
});

test('values: a constant, an enumeration behind a $ref, and a key the schema does not have', () => {
  assert.deepEqual(helpAt(deck, ['template'], undefined), {descriptions: [DECK.properties['template']!.description], summary: 'The value deck.'});
  assert.equal(helpAt(deck, ['status'], undefined)?.summary, 'One of draft, review, published or withheld.');
  assert.equal(helpAt(deck, ['no_such_field'], undefined), null);
  assert.equal(helpAt(deck, ['slides', 0, 'no_such_field'], undefined), null);
  assert.equal(helpAt(null, ['title'], undefined), null);
});

test('the comic and document schemas answer through the same walk', () => {
  for (const schema of [comic, documentSchema]) {
    const status = helpAt(schema, ['status'], undefined);
    assert.equal(status?.summary, 'One of draft, review, published or withheld.');
    assert.ok((status?.descriptions.length ?? 0) >= 1);
  }
});

test('holds decides the keywords the templates’ conditions use, and says when it cannot', () => {
  const root = {$defs: {name: {type: 'string', pattern: '^a'}}};
  assert.equal(holds(root, {type: 'string', pattern: '^assets/text/'}, 'assets/text/a.md'), true);
  assert.equal(holds(root, {type: 'string', pattern: '^assets/text/'}, 'hello'), false);
  assert.equal(holds(root, {properties: {type: {const: 'line'}}, required: ['type']}, {type: 'line'}), true);
  assert.equal(holds(root, {properties: {type: {const: 'line'}}, required: ['type']}, {type: 'bar'}), false);
  assert.equal(holds(root, {required: ['href']}, {label: 'x'}), false);
  assert.equal(holds(root, {$ref: '#/$defs/name'}, 'abc'), true);
  assert.equal(holds(root, {minLength: 3}, 'abc'), null);
});

test('a JSON pointer becomes path segments, with ~1 and ~0 unescaped', () => {
  assert.deepEqual(pointerSegments(''), []);
  assert.deepEqual(pointerSegments('/slides/2/title'), ['slides', '2', 'title']);
  assert.deepEqual(pointerSegments('/a~1b/c~0d'), ['a/b', 'c~d']);
});
