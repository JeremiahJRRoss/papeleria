/**
 * M5.4 part 1, A12 (W5C, D133): the strings the clients write in the browser,
 * in English and in Spanish, on pieces the compiled CLI builds from
 * test/fixtures/localization/, opened from disk in Chromium, Firefox and
 * WebKit (D51).
 *
 * The deck: the status as it turns (`slide_of`) and in the stacked view
 * (`all_shown`, and `all_shown_one` on a deck of one slide, D130), the labels
 * the client writes (the six it re-labels, then `show_one` and `hide_notes`),
 * a refused full screen (`fullscreen_denied`), and without JavaScript
 * `no_js_slides` (D131). The comic: the status in page view (`page_of`, and
 * `pages_of` for a spread) and in guided view (`panel_of`), the hint under the
 * bar (`panels_hint`, `panels_hint_one` for one panel, nothing for none), the
 * Guided view button (`page_view`), the dialog's title (`panel_of`) and its
 * Close button (`close`), a refused full screen, and without JavaScript
 * `no_js`. Each page is then searched, in all it shows and speaks, for the
 * other language's control strings. What the server writes is the matrix in
 * test/integration/localization.test.ts.
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cpSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {after, before, describe, test} from 'node:test';

import type {Browser, BrowserContextOptions, Page} from 'playwright';

import {controlStringsIn, fill, LANGUAGES, OTHER, STRINGS, type Language} from '../fixtures/localization/control-strings.js';
import {applicationRoot} from '../helpers/paths.js';
import {readReader, waitForPages, withComic} from './helpers/comic-fixture.js';
import {launchEngine, selectedEngines} from './helpers/engines.js';

const TIMEOUT = {timeout: 120_000};
const CLI = join(applicationRoot, 'lib', 'src', 'cli', 'index.js');
const PIECES = ['deck', 'deck-one', 'comic'] as const;
type Piece = (typeof PIECES)[number];

const workspace = mkdtempSync(join(tmpdir(), 'papeleria-l10n-browser-'));

function dist(piece: Piece, language: Language): string {
  return join(workspace, `${piece}-${language}`, 'dist');
}

function url(piece: Piece, language: Language): string {
  return pathToFileURL(join(dist(piece, language), 'index.html')).href;
}

before(() => {
  for (const piece of PIECES) {
    for (const language of LANGUAGES) {
      const folder = join(workspace, `${piece}-${language}`);
      cpSync(join(applicationRoot, 'test', 'fixtures', 'localization', piece, language), folder, {recursive: true});
      const built = spawnSync(process.execPath, [CLI, 'build', folder], {encoding: 'utf8'});
      assert.equal(built.status, 0, `papeleria build ${piece}/${language}: ${built.stderr}`);
    }
  }
});

after(() => rmSync(workspace, {recursive: true, force: true}));

/** The comic fixture's panels per page (its manifest). */
const COMIC_PANELS = [5, 1, 0, 2];

/** The hint for `n` panels shown (D130): nothing for none, the singular for one. */
function hintFor(language: Language, n: number): string {
  const strings = STRINGS[language];
  return n === 0 ? '' : fill(n === 1 ? strings['panels_hint_one'] : strings['panels_hint'], {n});
}

/** Everything a person reads or hears on the page now: the title, the body's text, and the attributes a browser shows or speaks. */
function readableText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const parts = [document.title, document.body.textContent ?? ''];
    for (const element of Array.from(document.querySelectorAll('*'))) {
      for (const name of ['alt', 'aria-label', 'aria-description', 'placeholder', 'title']) {
        const value = element.getAttribute(name);
        if (value !== null) {
          parts.push(value);
        }
      }
    }
    return parts.join('\n');
  });
}

async function expectNoOtherLanguage(page: Page, language: Language, when: string): Promise<void> {
  assert.deepEqual(controlStringsIn(await readableText(page), OTHER[language]), [], `${language} ${when}: the page carries ${OTHER[language]} control strings`);
}

function textOf(page: Page, id: string): Promise<string> {
  return page.evaluate((element) => document.getElementById(element)?.textContent ?? '', id);
}

async function waitForText(page: Page, id: string, text: string): Promise<void> {
  await page.waitForFunction(([element, expected]) => document.getElementById(element!)?.textContent === expected, [id, text] as const, {timeout: 5000});
}

/** Opens a page from disk in a fresh context and fails on any page or console error. */
async function openPage(browser: Browser, address: string, options: BrowserContextOptions, body: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext({viewport: {width: 1280, height: 800}, ...options});
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`console error: ${message.text()}`);
    }
  });
  try {
    await page.goto(address);
    await body(page);
    assert.deepEqual(errors, [], 'the page reported errors');
  } finally {
    await context.close();
  }
}

/** The deck's status for slide `n` of `total`, from the title the page shows. */
async function slideStatus(page: Page, language: Language, n: number, total: number): Promise<string> {
  const title = (await textOf(page, `title-${n}`)).replace(/\s+/g, ' ').trim();
  return fill(STRINGS[language]['slide_of'], {n, total, title});
}

function refuseFullscreen(page: Page): Promise<void> {
  return page.evaluate(() => {
    document.documentElement.requestFullscreen = () => Promise.reject(new TypeError('refused'));
  });
}

const {run, excluded} = selectedEngines();

for (const engine of excluded) {
  test(`${engine}: the localized clients not run`, {skip: `PAPELERIA_BROWSERS=${process.env['PAPELERIA_BROWSERS'] ?? ''} leaves ${engine} out`}, () => {});
}

for (const engine of run) {
  describe(`the localized clients in ${engine}`, () => {
    let browser: Browser | undefined;
    before(async () => {
      browser = await launchEngine(engine);
    }, TIMEOUT);
    after(async () => {
      await browser?.close();
    });
    const use = (): Browser => {
      if (browser === undefined) {
        throw new Error(`${engine} did not launch`);
      }
      return browser;
    };

    for (const language of LANGUAGES) {
      const strings = STRINGS[language];

      test(`deck, ${language}: every label, slide_of, all_shown, show_one, hide_notes and fullscreen_denied`, TIMEOUT, async (context) => {
        context.diagnostic(`${engine} ${use().version()}`);
        await openPage(use(), url('deck', language), {}, async (page) => {
          await page.waitForFunction(() => document.body.classList.contains('deck-enhanced'));
          const labels = await Promise.all(['prev-slide', 'next-slide', 'all-slides', 'toggle-notes', 'full-deck', 'print-deck'].map((id) => textOf(page, id)));
          assert.deepEqual(labels, [strings['previous'], strings['next'], strings['show_all'], strings['show_notes'], strings['fullscreen'], strings['print']]);
          assert.equal(await textOf(page, 'deck-status'), await slideStatus(page, language, 1, 4));

          await page.keyboard.press('ArrowRight');
          await waitForText(page, 'deck-status', await slideStatus(page, language, 2, 4));

          await page.click('#all-slides');
          await waitForText(page, 'deck-status', fill(strings['all_shown'], {total: 4}));
          assert.equal(await textOf(page, 'all-slides'), strings['show_one']);
          await expectNoOtherLanguage(page, language, 'in the stacked view');
          await page.click('#all-slides');
          await waitForText(page, 'all-slides', strings['show_all']!);

          await page.click('#toggle-notes');
          await waitForText(page, 'toggle-notes', strings['hide_notes']!);
          await expectNoOtherLanguage(page, language, 'with its notes shown');
          await page.click('#toggle-notes');
          await waitForText(page, 'toggle-notes', strings['show_notes']!);

          await refuseFullscreen(page);
          await page.click('#full-deck');
          await waitForText(page, 'deck-status', strings['fullscreen_denied']!);
          await expectNoOtherLanguage(page, language, 'after a refused full screen');
        });
      });

      test(`deck of one slide, ${language}: the stacked view says all_shown_one (D130)`, TIMEOUT, async () => {
        await openPage(use(), url('deck-one', language), {}, async (page) => {
          await page.waitForFunction(() => document.body.classList.contains('deck-enhanced'));
          assert.equal(await textOf(page, 'deck-status'), await slideStatus(page, language, 1, 1));
          await page.click('#all-slides');
          const singular = fill(strings['all_shown_one'], {total: 1});
          await waitForText(page, 'deck-status', singular);
          assert.notEqual(singular, fill(strings['all_shown'], {total: 1}), 'not "All 1 slides shown."');
          await expectNoOtherLanguage(page, language, 'in the stacked view of one slide');
        });
      });

      test(`deck without JavaScript, ${language}: no_js_slides (D131)`, TIMEOUT, async () => {
        await openPage(use(), url('deck', language), {javaScriptEnabled: false}, async (page) => {
          assert.equal((await textOf(page, 'deck-status')).trim(), strings['no_js_slides']);
          assert.equal(await page.locator('.deck-tools button:visible').count(), 0, 'no control that needs the script');
          await expectNoOtherLanguage(page, language, 'without JavaScript');
        });
      });

      test(`comic, ${language}, one page at a time: page_of, the hint by count, panel_of, page_view, the dialog and fullscreen_denied`, TIMEOUT, async () => {
        await withComic(use(), url('comic', language), {context: {viewport: {width: 390, height: 844}}}, async ({page}) => {
          let state = await readReader(page);
          assert.deepEqual([state.layout, state.visible], ['single', [1]]);
          assert.equal(state.status, fill(strings['page_of'], {n: 1, total: 4}));
          assert.equal(state.hint, hintFor(language, 5));
          const labels = await Promise.all(['comic-previous', 'comic-next', 'comic-guided', 'comic-transcript-toggle', 'comic-fullscreen'].map((id) => textOf(page, id)));
          assert.deepEqual(labels, [strings['previous'], strings['next'], strings['guided_view'], strings['transcript'], strings['fullscreen']]);

          for (const n of [2, 3, 4]) {
            await page.click('#comic-next');
            await waitForPages(page, [n]);
            state = await readReader(page);
            assert.equal(state.status, fill(strings['page_of'], {n, total: 4}), `page ${n}`);
            assert.equal(state.hint, hintFor(language, COMIC_PANELS[n - 1]!), `the hint on page ${n}, with ${COMIC_PANELS[n - 1]} panels`);
          }
          await expectNoOtherLanguage(page, language, 'in page view');

          await page.keyboard.press('Home');
          await waitForPages(page, [1]);
          await page.click('#comic-guided');
          await page.waitForFunction(() => window.papeleriaReader?.view === 'guided');
          state = await readReader(page);
          assert.equal(state.status, fill(strings['panel_of'], {n: 1, total: 5, page: 1}));
          assert.equal(state.guidedLabel, strings['page_view']);
          assert.deepEqual([state.detailHidden, await textOf(page, 'comic-detail')], [false, strings['detail']], 'panel 1 has a detail');

          await page.keyboard.press('ArrowRight');
          await page.waitForFunction(() => window.papeleriaReader?.panel === 2);
          assert.equal((await readReader(page)).status, fill(strings['panel_of'], {n: 2, total: 5, page: 1}));
          await page.click('#comic-detail');
          await page.waitForFunction(() => window.papeleriaReader?.detailOpen === true);
          assert.equal(await textOf(page, 'comic-dialog-title'), fill(strings['panel_of'], {n: 2, total: 5, page: 1}), 'the dialog is titled panel_of');
          assert.equal(await textOf(page, 'comic-dialog-close'), strings['close']);
          await expectNoOtherLanguage(page, language, 'with the dialog open');
          await page.keyboard.press('Escape');
          await page.waitForFunction(() => window.papeleriaReader?.detailOpen === false);
          await page.keyboard.press('Escape');
          await page.waitForFunction(() => window.papeleriaReader?.view === 'page');
          assert.equal((await readReader(page)).guidedLabel, strings['guided_view']);

          await refuseFullscreen(page);
          await page.click('#comic-fullscreen');
          await waitForText(page, 'comic-status', strings['fullscreen_denied']!);
          await expectNoOtherLanguage(page, language, 'after a refused full screen');
        });
      });

      test(`comic, ${language}, in spreads: pages_of, and the singular hint for a spread holding one panel`, TIMEOUT, async () => {
        await withComic(use(), url('comic', language), {context: {viewport: {width: 1280, height: 800}}}, async ({page}) => {
          let state = await readReader(page);
          assert.deepEqual([state.layout, state.visible], ['spread', [1]]);
          assert.equal(state.status, fill(strings['page_of'], {n: 1, total: 4}));
          assert.equal(state.hint, hintFor(language, 5));
          await page.click('#comic-next');
          await waitForPages(page, [2, 3]);
          state = await readReader(page);
          assert.equal(state.status, fill(strings['pages_of'], {a: 2, b: 3, total: 4}));
          assert.equal(state.hint, hintFor(language, 1), 'pages 2 and 3 hold one panel between them');
          await page.click('#comic-next');
          await waitForPages(page, [4]);
          state = await readReader(page);
          assert.equal(state.status, fill(strings['page_of'], {n: 4, total: 4}));
          assert.equal(state.hint, hintFor(language, 2));
          await expectNoOtherLanguage(page, language, 'in spreads');
        });
      });

      test(`comic without JavaScript, ${language}: no_js`, TIMEOUT, async () => {
        await withComic(use(), url('comic', language), {context: {javaScriptEnabled: false}, reader: false}, async ({page}) => {
          assert.equal((await textOf(page, 'comic-status')).trim(), strings['no_js']);
          await expectNoOtherLanguage(page, language, 'without JavaScript');
        });
      });
    }
  });
}
