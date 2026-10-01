/**
 * W5E (IC08, D167, D174): the deck's overflow mark in the editor's preview, in
 * Chromium, Firefox and WebKit.
 *
 * A deck prints one slide to an A4 landscape page, and a slide whose content
 * does not fit its printed page is an authoring defect (IC08) that the CLI has
 * no layout engine to find (D167). The deck's preview bundle measures each
 * slide as it prints once the page has loaded, and reports the slides that do
 * not fit as `overflow`; the editor names them in its status line. The editor
 * opens the print suite's overflow fixture, whose slide 2 does not fit, and
 * the two example decks, whose slides do (test/browser/print-deck.test.ts
 * measures the same three in print media). The verdict is the printed page's,
 * so it is the same at the Phone, Tablet and Desktop widths, each asked of a
 * generation loaded at that width. That published `deck.js` holds none of
 * this is test/unit/deck-client.test.ts.
 */
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {after, before, describe, test} from 'node:test';

import type {Browser, Page} from 'playwright';

import {applicationRoot} from '../helpers/paths.js';
import {removeTemporaryFolders} from '../helpers/pieces.js';
import {lineOf, nextShown, openEditor, placeCursor, shown, statusLine, TYPING} from './helpers/editor-session.js';
import {launchEngine, selectedEngines} from './helpers/engines.js';

const TIMEOUT = {timeout: 240_000};
const WIDTHS = [390, 834, 1280] as const;

after(removeTemporaryFolders);

declare global {
  interface Window {
    /** Installed by the tests in the editor page: the overflow reports the preview sent it. */
    overflowReports?: {generationId: string; slides: number[]}[];
  }
}

/** Starts keeping, in the editor page, the `overflow` messages the preview origin sends it. */
async function keepReports(page: Page, origin: string): Promise<void> {
  await page.evaluate((from) => {
    window.overflowReports = [];
    window.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as {type?: unknown; generationId?: unknown; slides?: unknown} | null;
      if (event.origin === from && data?.type === 'overflow') {
        window.overflowReports!.push({generationId: String(data.generationId), slides: data.slides as number[]});
      }
    });
  }, origin);
}

/** The slides a generation reported, once it has: the editor, listening first, has taken the report in by then. */
async function reportOf(page: Page, generationId: string): Promise<number[]> {
  const found = await page.waitForFunction((id) => window.overflowReports?.find((report) => report.generationId === id)?.slides ?? false, generationId, {timeout: 20_000});
  return (await found.jsonValue()) as number[];
}

const {run, excluded} = selectedEngines();

for (const engine of excluded) {
  test(`${engine}: not run`, {skip: `PAPELERIA_BROWSERS=${process.env['PAPELERIA_BROWSERS'] ?? ''} leaves ${engine} out`}, () => {});
}

for (const engine of run) {
  describe(`the deck's overflow mark in ${engine}`, () => {
    let browser: Browser | undefined;
    before(async () => {
      browser = await launchEngine(engine);
    }, TIMEOUT);
    after(async () => {
      await browser?.close();
    });

    /** Opens the editor on a copy of `piece`, then, at each width, asks a generation of it and returns what each reported and the status line. */
    async function atEveryWidth(piece: string, label: string, prepare?: (root: string) => void): Promise<{width: number; slides: number[]; preview: string; tone: string}[]> {
      if (browser === undefined) {
        throw new Error(`${engine} did not launch`);
      }
      const editor = await openEditor(browser, join(applicationRoot, piece), {label: `overflow-${label}-${engine}`, ...(prepare === undefined ? {} : {prepare})});
      try {
        const {page, session} = editor;
        await keepReports(page, session.previewOrigin);
        const results: {width: number; slides: number[]; preview: string; tone: string}[] = [];
        for (const width of WIDTHS) {
          await page.click(`.preview-widths button[data-width="${width}"]`);
          // A comment changes the manifest and nothing it publishes: a new generation, loaded at this width.
          const before = await shown(page);
          await placeCursor(page, await lineOf(page, 'schema: 1'));
          await page.keyboard.type(` # ${width}`, TYPING);
          const id = await nextShown(page, before, 60_000);
          const slides = await reportOf(page, id);
          const line = await statusLine(page);
          results.push({width, slides, preview: line.preview, tone: line.tone});
        }
        assert.deepEqual(editor.problems, [], 'the editor or the preview reported errors');
        return results;
      } finally {
        await editor.close();
      }
    }

    test('the print suite\'s overflow fixture: slide 2 does not fit its printed page, at every width, and the status line says so', TIMEOUT, async (context) => {
      context.diagnostic(`${engine} ${browser?.version() ?? ''}`);
      for (const result of await atEveryWidth('test/fixtures/print/deck-overflow', 'fixture')) {
        assert.deepEqual(result.slides, [2], `${result.width}: the slides reported`);
        assert.match(result.preview, / · Slide 2 overflows$/, `${result.width}: the status line`);
        assert.equal(result.tone, 'tone-warning', `${result.width}: in the warning colour`);
      }
    });

    test('decks whose slides fit, the starter deck and the brand overview, get no mark at any width', TIMEOUT, async () => {
      for (const [piece, label] of [
        ['examples/starter-deck', 'starter'],
        ['examples/brand-overview', 'brand'],
      ] as const) {
        for (const result of await atEveryWidth(piece, label)) {
          assert.deepEqual(result.slides, [], `${label} at ${result.width}: the slides reported`);
          assert.doesNotMatch(result.preview, /overflow/, `${label} at ${result.width}: the status line`);
        }
      }
    });

    test('three columns that fit their printed page side by side get no mark at the Phone width, where the screen stacks them', TIMEOUT, async () => {
      // Printed, the columns stand side by side; under 800 px the screen's rules stack them, three times as tall. Eight
      // sentences a column fit the printed canvas side by side with about 40 px to spare, and stacked pass it by about
      // 70 px (Chromium, measured in print media). The check judges a rule for a width at the printed page's width, so
      // the mark is the printed page's at every width.
      const column = (name: string): string =>
        `      - heading: ${name}\n        text: "${Array.from({length: 8}, (_, index) => `Sentence ${index + 1} of a column that fits beside two others on its printed page.`).join(' ')}"\n`;
      const manifest =
        'schema: 1\ntemplate: deck\ntitle: Columns side by side.\nlanguage: en\nstatus: draft\nslides:\n' +
        '  - layout: statement\n    title: A slide that fits.\n' +
        `  - layout: three\n    title: Three columns that fit side by side.\n    columns:\n${column('First')}${column('Second')}${column('Third')}`;
      const results = await atEveryWidth('test/fixtures/print/deck-overflow', 'columns', (root) => writeFileSync(join(root, 'papeleria.yaml'), manifest));
      for (const result of results) {
        assert.deepEqual(result.slides, [], `${result.width}: the slides reported`);
      }
    });
  });
}
