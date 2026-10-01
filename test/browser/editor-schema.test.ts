/**
 * DEP02, confirmed against the real editor (D75): completion from
 * `codemirror-json-schema`, fed the three real bundled schemas the server
 * sends, in YAML and in JSON; hover built by the editor from the same
 * schemas, including the three cases the adapter's own hover missed (a
 * description beside a `$ref`, a `prefixItems` slot, the `then` an `if`
 * chooses); and no diagnostic but the report's — a tuple the adapter's
 * Draft04/07 engine would reject is not marked, and a real error is marked
 * once. Chromium, Firefox and WebKit on CI (D51).
 */
import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {after, before, describe, test} from 'node:test';

import type {Browser, Page} from 'playwright';

import {applicationRoot} from '../helpers/paths.js';
import {removeTemporaryFolders} from '../helpers/pieces.js';
import {lineOf, openEditor, placeCursor, pointAt, TYPING, type EditorFixture, type OpenOptions} from './helpers/editor-session.js';
import {launchEngine, selectedEngines} from './helpers/engines.js';

const TIMEOUT = {timeout: 120_000};
const STARTER = join(applicationRoot, 'templates', 'deck', 'sample');

type Described = {description: string; properties: Record<string, Described>; prefixItems: Described[]};
const SHARED = (JSON.parse(readFileSync(join(applicationRoot, 'templates', 'shared', 'schema-defs.json'), 'utf8')) as {$defs: Record<string, Described>}).$defs;
const BESIDE_REF = SHARED['image_block']!.properties['focal_point']!.description;
const FOCAL_POINT = SHARED['focal_point']!.description;
const HORIZONTAL = SHARED['focal_point']!.prefixItems[0]!.description;
const TEXT_FILE_PATH = SHARED['text_file_path']!.description;

after(removeTemporaryFolders);

const SQUARE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 30"><rect width="40" height="30" fill="#2f7fbf"/></svg>\n';

/** The starter deck with an image slide whose picture has a focal point. */
function withPicture(root: string): void {
  mkdirSync(join(root, 'assets', 'images'), {recursive: true});
  writeFileSync(join(root, 'assets', 'images', 'square.svg'), SQUARE);
  const manifest = join(root, 'papeleria.yaml');
  writeFileSync(
    manifest,
    `${readFileSync(manifest, 'utf8')}\n  - layout: image\n    title: A picture.\n    image:\n      src: assets/images/square.svg\n      alt: A blue square\n      focal_point: [30, 70]\n`,
  );
}

/** The same piece written as JSON. */
function asJson(root: string): void {
  mkdirSync(join(root, 'assets', 'images'), {recursive: true});
  writeFileSync(join(root, 'assets', 'images', 'square.svg'), SQUARE);
  rmSync(join(root, 'papeleria.yaml'));
  const manifest = {
    schema: 1,
    template: 'deck',
    title: 'A JSON deck',
    status: 'draft',
    slides: [
      {layout: 'cover', title: 'One', notes: 'assets/text/01-cover-notes.md'},
      {layout: 'image', title: 'A picture.', image: {src: 'assets/images/square.svg', alt: 'A blue square', focal_point: [30, 70]}},
    ],
  };
  writeFileSync(join(root, 'papeleria.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Opens completion with Ctrl Space and returns the options offered. */
async function complete(page: Page): Promise<string[]> {
  await page.keyboard.press('Control+Space');
  await page.waitForSelector('.cm-tooltip-autocomplete li');
  const options = await page.locator('.cm-tooltip-autocomplete li .cm-completionLabel').allTextContents();
  await page.keyboard.press('Escape');
  await page.waitForSelector('.cm-tooltip-autocomplete', {state: 'detached'});
  return options.map((option) => option.replace(/^"|"$/g, ''));
}

/** Hovers over a character of `text` and returns the help's paragraphs, or null when none shows. */
async function hover(page: Page, text: string, offset = 1): Promise<string[] | null> {
  await page.mouse.move(2, 2);
  await page.waitForSelector('.papeleria-help', {state: 'detached'});
  const point = await pointAt(page, text, offset);
  await page.mouse.move(point.x, point.y);
  try {
    await page.waitForSelector('.papeleria-help', {timeout: 3000});
  } catch {
    return null;
  }
  return page.locator('.papeleria-help p').allTextContents();
}

/** Replaces the value of the manifest line holding `text` from `column` to the line's end. */
async function retype(page: Page, text: string, column: number, value: string): Promise<void> {
  await placeCursor(page, await lineOf(page, text), column);
  await page.keyboard.press('Shift+End');
  await page.keyboard.type(value, TYPING);
}

const {run, excluded} = selectedEngines();

for (const engine of excluded) {
  test(`${engine}: not run`, {skip: `PAPELERIA_BROWSERS=${process.env['PAPELERIA_BROWSERS'] ?? ''} leaves ${engine} out`}, () => {});
}

for (const engine of run) {
  describe(`schema help in the editor in ${engine} (DEP02)`, () => {
    let browser: Browser | undefined;
    before(async () => {
      browser = await launchEngine(engine);
    }, TIMEOUT);
    after(async () => {
      await browser?.close();
    });

    async function withEditor(options: OpenOptions, body: (editor: EditorFixture) => Promise<void>): Promise<void> {
      if (browser === undefined) {
        throw new Error(`${engine} did not launch`);
      }
      const editor = await openEditor(browser, STARTER, {label: `schema-${engine}`, ...options});
      try {
        await body(editor);
      } finally {
        await editor.close();
      }
    }

    test('completion offers the deck’s keys and values from its bundled schema, in YAML', TIMEOUT, async () => {
      await withEditor({}, async ({page, problems}) => {
        await placeCursor(page, await lineOf(page, 'status: draft'));
        await page.keyboard.press('Enter');
        await page.keyboard.type('word', TYPING);
        assert.ok((await complete(page)).includes('wordmark'), 'a root key from the shared $defs');
        await page.keyboard.press('Shift+Home');
        await page.keyboard.press('Backspace');
        await page.keyboard.press('Backspace');

        await retype(page, 'status: draft', 9, 'd');
        assert.deepEqual(await complete(page), ['draft'], 'the enum behind the $ref, filtered');
        await page.keyboard.press('Backspace');
        await page.keyboard.type('r', TYPING);
        assert.deepEqual(await complete(page), ['review'], 'filtered by what is typed');
        // With nothing typed after the colon the adapter offers nothing (DEP02; D75): hovering the key lists the values.
        const help = await hover(page, 'status: r', 2);
        assert.equal(help?.at(-1), 'One of draft, review, published or withheld.');
        await placeCursor(page, await lineOf(page, 'status: r'));
        await page.keyboard.press('Backspace');
        await page.keyboard.type('draft', TYPING);

        await placeCursor(page, await lineOf(page, 'notes: assets/text/01-cover-notes.md'));
        await page.keyboard.press('Enter');
        await page.keyboard.type('foo', TYPING);
        assert.ok((await complete(page)).includes('footer'), 'a slide’s key, inside the list');
        assert.deepEqual(problems, []);
      });
    });

    test('completion follows the template typed into the manifest: the comic’s and the document’s own keys', TIMEOUT, async () => {
      await withEditor({}, async ({page}) => {
        for (const [template, typed, expected] of [
          ['comic', 'form', 'format'],
          ['document', 'sour', 'source_note'],
          ['document', 'doc_', 'doc_type'],
        ] as const) {
          await retype(page, 'template: ', 11, template);
          await page.waitForFunction((name) => document.getElementById('piece-line')?.textContent === `piece · ${name} · en · draft`, template, {timeout: 10_000});
          await placeCursor(page, await lineOf(page, 'status: draft'));
          await page.keyboard.press('Enter');
          await page.keyboard.type(typed, TYPING);
          assert.ok((await complete(page)).includes(expected), `${template}: ${expected}`);
          await page.keyboard.press('Shift+Home');
          await page.keyboard.press('Backspace');
          await page.keyboard.press('Backspace');
        }
        // A deck's slides under the document template: the report says so, and the frame keeps the last good deck.
        await page.waitForFunction(() => document.getElementById('status-preview')?.className === 'tone-error', null, {timeout: 10_000});
      });
    });

    test('completion works the same way in a JSON manifest', TIMEOUT, async () => {
      await withEditor({prepare: asJson}, async ({page}) => {
        // The editor does not close quotes for the author, so the key is typed whole and completed from inside.
        await placeCursor(page, await lineOf(page, '"status": "draft",'));
        await page.keyboard.press('Enter');
        await page.keyboard.type('"word"', TYPING);
        await page.keyboard.press('ArrowLeft');
        assert.ok((await complete(page)).includes('wordmark'));
        await page.keyboard.press('End');
        await page.keyboard.press('Shift+Home');
        await page.keyboard.press('Backspace');
        await page.keyboard.press('Backspace');
        await placeCursor(page, await lineOf(page, '"status": "draft",'), 15);
        assert.deepEqual(await complete(page), ['draft'], 'a value, filtered by what is before the cursor');
      });
    });

    test('hover explains a key beside its $ref, a tuple’s slot, and a notes value that names a file (YAML)', TIMEOUT, async () => {
      await withEditor({prepare: withPicture}, async ({page}) => {
        const key = await hover(page, 'focal_point');
        assert.deepEqual(key?.slice(0, 3), [BESIDE_REF, FOCAL_POINT, 'A list of exactly 2.']);
        assert.deepEqual(await hover(page, '[30, 70]', 1), [HORIZONTAL, 'A number from 0 to 100.']);
        const notes = await hover(page, 'assets/text/01-cover-notes.md', 3);
        assert.equal(notes?.[0], TEXT_FILE_PATH, 'the then an if chooses for this value comes first');
        assert.equal(await hover(page, 'slides:\n', 7), null, 'no help over blank space');
      });
    });

    test('hover gives the same answers in a JSON manifest', TIMEOUT, async () => {
      await withEditor({prepare: asJson}, async ({page}) => {
        const key = await hover(page, '"focal_point"', 2);
        assert.deepEqual(key?.slice(0, 2), [BESIDE_REF, FOCAL_POINT]);
        assert.deepEqual(await hover(page, '30,', 0), [HORIZONTAL, 'A number from 0 to 100.']);
        assert.equal((await hover(page, 'assets/text/01-cover-notes.md', 3))?.[0], TEXT_FILE_PATH);
      });
    });

    test('no diagnostic but the report’s: a valid tuple is not marked, and a real error is marked once', TIMEOUT, async () => {
      await withEditor({prepare: asJson}, async ({page}) => {
        // Draft04 and Draft07 reject [30, 70] for a prefixItems pair; the editor runs neither. What is marked is the report's.
        assert.equal(await page.textContent('#count-errors'), '✕ 0 errors');
        const markedLines = async (): Promise<number[]> =>
          page.evaluate(() => {
            const view = window.papeleriaTestView!() as unknown as {posAtDOM(node: Node): number; state: {doc: {lineAt(position: number): {number: number}}}};
            const lines = [...document.querySelectorAll('.editor-panel:not([hidden]) .cm-lintRange')].map((range) => view.state.doc.lineAt(view.posAtDOM(range)).number);
            return [...new Set(lines)].sort((a, b) => a - b);
          });
        const listedLines = async (): Promise<number[]> => {
          const where = await page.locator('.diagnostics-item .diagnostics-where').allTextContents();
          const lines = where.map((text) => /^papeleria\.json:([0-9]+)/.exec(text)?.[1]).filter((line) => line !== undefined);
          return [...new Set(lines.map(Number))].sort((a, b) => a - b);
        };
        assert.deepEqual(await markedLines(), await listedLines(), 'every mark is a line the report names, and every such line is marked');
        for (const slot of ['30,', '70']) {
          assert.ok(!(await markedLines()).includes(await lineOf(page, slot)), `the tuple's ${slot} is not marked`);
        }
        await retype(page, '"status": "draft",', 14, 'drafty",');
        await page.waitForFunction(() => document.getElementById('count-errors')?.textContent === '✕ 1 error');
        assert.deepEqual(
          await page.evaluate(() => [...document.querySelectorAll('.cm-lintRange-error')].map((range) => range.closest('.cm-line')?.textContent?.trim())),
          ['"status": "drafty",'],
          'the error is marked once, where the report puts it',
        );
        assert.deepEqual(await markedLines(), await listedLines());
      });
    });
  });
}
