/**
 * M4.6: the comic reader with the keyboard and the accessibility tree, in
 * Chromium, Firefox and WebKit (A13's automated share).
 *
 * - Keyboard traversal: Tab visits the skip link, the bar's controls, then
 *   every panel shown in reading order, and nothing hidden.
 * - Enter and Space on each kind of panel; the dialog's name, its focus on
 *   Close, Tab kept inside it, and focus back on the panel that opened it.
 * - Escape nests: the dialog first, then guided view, then nothing the reader
 *   takes; focus returns at each step.
 * - Turns are announced: the status line is a live region whose words change
 *   with every turn and step; a panel without a detail announces its
 *   transcript in a live region of its own.
 * - ARIA snapshots (`locator.ariaSnapshot()`) of the bar, a page's figure,
 *   the dialog, guided view and the page without JavaScript, held to the
 *   committed files in test/fixtures/comic/aria/.
 *
 * An accessibility tree is not a screen reader: A13's NVDA/Firefox and
 * VoiceOver/Safari sessions are people's, and stay pending in
 * docs/user/accessibility-record.md whatever this suite says.
 */
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, describe, test} from 'node:test';

import type {Browser, Page} from 'playwright';

import {fixturePath} from '../helpers/paths.js';
import {assertSnapshot} from '../helpers/snapshot.js';
import {buildComics, readReader, waitForPages, withComic, type BuiltComics, type OpenOptions} from './helpers/comic-fixture.js';
import {launchEngine, selectedEngines, type EngineName} from './helpers/engines.js';
import {serveDirectory, type StaticServer} from './helpers/static-server.js';

const TIMEOUT = {timeout: 150_000};
const workspace = mkdtempSync(join(tmpdir(), 'papeleria-comic-a11y-'));
let comics: BuiltComics | undefined;
let server: StaticServer | undefined;

before(async () => {
  comics = await buildComics(workspace);
  server = await serveDirectory(workspace);
}, {timeout: 300_000});

after(async () => {
  await server?.close();
  rmSync(workspace, {recursive: true, force: true});
});

function url(piece: 'sample' | 'reader', hash = ''): string {
  if (server === undefined || comics === undefined) {
    throw new Error('the comics were not built and served');
  }
  return `${server.origin}/${piece}/dist/index.html${hash}`;
}

/** The key that moves focus to the next control: WebKit on macOS moves it only between form controls with Tab alone. */
function tabKey(engine: EngineName): string {
  return engine === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab';
}

function focused(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement;
    return active === null || active === document.body ? 'body' : active.id !== '' ? active.id : `${active.tagName.toLowerCase()}.${Array.from(active.classList).join('.')}`;
  });
}

/** Records each Escape that reaches the window once the page has handled it, and whether its default was prevented. */
const RECORD_ESCAPES = `(() => {
  window.escapes = [];
  window.addEventListener('keydown', (event) => { if (event.key === 'Escape') window.escapes.push(event.defaultPrevented); });
})();`;

const snapshot = (name: string): string => fixturePath('comic', 'aria', `${name}.yaml`);

const {run, excluded} = selectedEngines();

for (const engine of excluded) {
  test(`${engine}: not run`, {skip: `PAPELERIA_BROWSERS=${process.env['PAPELERIA_BROWSERS'] ?? ''} leaves ${engine} out`}, () => {});
}

for (const engine of run) {
  describe(`the comic reader's keyboard and accessibility tree in ${engine}`, () => {
    let browser: Browser | undefined;
    before(async () => {
      browser = await launchEngine(engine);
    }, TIMEOUT);
    after(async () => {
      await browser?.close();
    });
    const open = (address: string, options: OpenOptions, body: Parameters<typeof withComic>[3]): Promise<void> => {
      if (browser === undefined) {
        throw new Error(`${engine} did not launch`);
      }
      return withComic(browser, address, options, body);
    };
    const tab = tabKey(engine);

    test('Tab visits the skip link, the bar, then every panel shown in reading order, and nothing hidden', TIMEOUT, async () => {
      const cases: [string, {width: number; height: number}, string[]][] = [
        ['#page-1', {width: 390, height: 844}, ['a.skip-link', 'comic-next', 'comic-guided', 'comic-transcript-toggle', 'comic-fullscreen', 'page-1-panel-1', 'page-1-panel-2', 'page-1-panel-3', 'page-1-panel-4', 'page-1-panel-5']],
        ['#page-2', {width: 1280, height: 800}, ['a.skip-link', 'comic-previous', 'comic-next', 'comic-guided', 'comic-transcript-toggle', 'comic-fullscreen', 'page-2-panel-1', 'page-2-panel-2', 'page-2-panel-3', 'page-3-panel-1', 'page-3-panel-2', 'page-3-panel-3']],
      ];
      for (const [hash, viewport, expected] of cases) {
        await open(url('sample', hash), {context: {viewport, reducedMotion: 'reduce'}}, async ({page}) => {
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          const order: string[] = [];
          for (let step = 0; step < expected.length + 1; step += 1) {
            await page.keyboard.press(tab);
            order.push(await focused(page));
          }
          assert.deepEqual(order.slice(0, expected.length), expected, `${hash} at ${viewport.width}: the Tab order`);
          assert.ok(!['comic-detail', 'comic-announce', 'comic-hint'].includes(order.at(-1)!), 'nothing hidden takes focus');
        });
      }
    });

    test('Enter and Space open a detail; the dialog is named by its panel, holds focus, and gives it back', TIMEOUT, async () => {
      await open(url('reader'), {context: {reducedMotion: 'reduce'}}, async ({page}) => {
        assert.equal(await page.getAttribute('#page-1-panel-1', 'aria-haspopup'), 'dialog');
        assert.equal(await page.getAttribute('#page-1-panel-3', 'aria-haspopup'), null, 'no popup for a panel without a detail');
        for (const [panel, key, name] of [
          ['#page-1-panel-1', 'Enter', 'Panel 1 of 5 on page 1'],
          ['#page-1-panel-2', ' ', 'Panel 2 of 5 on page 1'],
        ] as const) {
          await page.focus(panel);
          await page.keyboard.press(key === ' ' ? 'Space' : key);
          const dialog = page.getByRole('dialog', {name});
          assert.equal(await dialog.isVisible(), true, `the dialog is named "${name}"`);
          assert.equal(await dialog.getAttribute('aria-modal'), 'true');
          assert.equal(await focused(page), 'comic-dialog-close');
          for (let step = 0; step < 4; step += 1) {
            await page.keyboard.press(tab);
            assert.equal(await page.evaluate(() => document.getElementById('comic-dialog')!.contains(document.activeElement)), true, 'focus stays in the dialog');
          }
          assert.equal(await page.locator('#comic-next').evaluate((button) => button.closest('[inert]') !== null), true, 'the page behind is inert');
          await page.keyboard.press('Escape');
          assert.equal(await focused(page), panel.slice(1), 'focus returns to the panel');
        }
      });
    });

    test('Escape nests: the dialog, then guided view, then nothing the reader takes', TIMEOUT, async () => {
      await open(url('reader'), {context: {reducedMotion: 'reduce'}, init: RECORD_ESCAPES}, async ({page}) => {
        await page.click('#comic-guided');
        await page.focus('#comic-book');
        let state = await readReader(page);
        assert.deepEqual([state.view, state.panel], ['guided', 1]);
        await page.click('#comic-detail');
        assert.equal((await readReader(page)).detailOpen, true);
        await page.keyboard.press('Escape');
        state = await readReader(page);
        assert.deepEqual([state.detailOpen, state.view, state.focus], [false, 'guided', 'button.comic-lens-panel'], 'the dialog closes; guided view stays; focus on the step');
        await page.keyboard.press('Escape');
        state = await readReader(page);
        assert.deepEqual([state.view, state.focus], ['page', 'page-1-panel-1'], 'guided view closes; focus on its panel');
        await page.keyboard.press('Escape');
        assert.deepEqual((await readReader(page)).view, 'page');
        // The reader stops the two Escapes it takes; the third reaches the window unprevented, for the preview's bridge (IC06).
        assert.deepEqual(await page.evaluate(() => (window as unknown as {escapes: boolean[]}).escapes), [false]);
      });
    });

    test('turns and steps are announced by a live status; a transcript-only panel announces its transcript', TIMEOUT, async () => {
      await open(url('sample'), {context: {reducedMotion: 'reduce', viewport: {width: 390, height: 844}}}, async ({page}) => {
        assert.equal(await page.getAttribute('#comic-status', 'role'), 'status');
        const lines: string[] = [];
        for (const action of ['next', 'next', 'guided', 'right', 'right']) {
          if (action === 'next') {
            await page.click('#comic-next');
          } else if (action === 'guided') {
            await page.click('#comic-guided');
          } else {
            await page.keyboard.press('ArrowRight');
          }
          lines.push((await readReader(page)).status);
        }
        assert.deepEqual(lines, ['Page 2 of 8', 'Page 3 of 8', 'Panel 1 of 3 on page 3', 'Panel 2 of 3 on page 3', 'Panel 3 of 3 on page 3']);
        await page.keyboard.press('Escape');
        await waitForPages(page, [3]);
        assert.equal(await page.getAttribute('#comic-announce', 'role'), 'status');
        await page.focus('#page-3-panel-1');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.getElementById('comic-announce')?.textContent === 'Page 3, panel 1: On deck; the town shrinks behind the wake.');
        assert.equal(await page.getByRole('dialog').count(), 0, 'nothing opens');
      });
    });

    test('ARIA snapshots: the bar, a page, the dialog, guided view and the page without JavaScript', TIMEOUT, async () => {
      await open(url('reader'), {context: {reducedMotion: 'reduce'}}, async ({page}) => {
        assertSnapshot(snapshot('tools'), await page.locator('#comic-tools').ariaSnapshot());
        assertSnapshot(snapshot('page-1'), await page.locator('.comic-book figure[data-page="1"]').ariaSnapshot());
        await page.click('#page-1-panel-1');
        assertSnapshot(snapshot('dialog-zoom'), await page.locator('#comic-dialog').ariaSnapshot());
        await page.keyboard.press('Escape');
        await page.click('#page-1-panel-2');
        assertSnapshot(snapshot('dialog-text'), await page.locator('#comic-dialog').ariaSnapshot());
        await page.keyboard.press('Escape');
        await page.evaluate(() => window.papeleriaReader!.enterGuided(1, 5));
        assertSnapshot(snapshot('guided'), await page.locator('#comic-lens').ariaSnapshot());
        await page.evaluate(() => window.papeleriaReader!.enterGuided(3));
        assertSnapshot(snapshot('guided-no-panels'), await page.locator('#comic-lens').ariaSnapshot());
      });
      await open(url('reader'), {context: {javaScriptEnabled: false}, reader: false}, async ({page}) => {
        assertSnapshot(snapshot('no-js-page-1'), await page.locator('#page-1').ariaSnapshot());
      });
    });
  });
}
