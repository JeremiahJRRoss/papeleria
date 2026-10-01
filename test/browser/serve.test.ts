/**
 * M2.6: `papeleria serve`'s read-only shell in Chromium, Firefox and WebKit
 * (IC09, D87, D51): it shows the newest good build of the saved files,
 * reloads when a file changes and keeps the reader's slide, keeps the last
 * good build with a note when a build fails, says when the server has
 * stopped, and asks nothing of any origin but its own and the preview's.
 */
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {after, before, describe, test} from 'node:test';

import type {Browser, Frame, Page} from 'playwright';

import type {ServeSession, startServe} from '../../src/server/index.js';
import {applicationRoot} from '../helpers/paths.js';
import {copyPiece, removeTemporaryFolders} from '../helpers/pieces.js';
import {launchEngine, selectedEngines} from './helpers/engines.js';

const TIMEOUT = {timeout: 120_000};
const STARTER = join(applicationRoot, 'templates', 'deck', 'sample');

after(removeTemporaryFolders);

/** `startServe` from the full build in `lib/src/`, whose checks load their rules from their own folder. */
async function serve(root: string): Promise<ServeSession> {
  const server = (await import(pathToFileURL(join(applicationRoot, 'lib', 'src', 'server', 'index.js')).href)) as {startServe: typeof startServe};
  return server.startServe({root, label: 'piece'});
}

/** The frame the shell shows, once it is shown, and its address. */
async function front(page: Page, other?: string): Promise<{frame: Frame; src: string}> {
  const handle = await page.waitForSelector(other === undefined ? '.serve-frame:not(.is-loading)' : `.serve-frame:not(.is-loading):not([src="${other}"])`, {timeout: 20_000});
  const frame = await handle.contentFrame();
  assert.ok(frame !== null);
  return {frame, src: (await handle.getAttribute('src'))!};
}

function deckCurrent(frame: Frame): Promise<number | undefined> {
  return frame.evaluate(() => (window as unknown as {papeleriaDeck?: {current: number}}).papeleriaDeck?.current);
}

const {run, excluded} = selectedEngines();

for (const engine of excluded) {
  test(`${engine}: not run`, {skip: `PAPELERIA_BROWSERS=${process.env['PAPELERIA_BROWSERS'] ?? ''} leaves ${engine} out`}, () => {});
}

for (const engine of run) {
  describe(`serve in ${engine}`, () => {
    let browser: Browser | undefined;
    before(async () => {
      browser = await launchEngine(engine);
    }, TIMEOUT);
    after(async () => {
      await browser?.close();
    });

    test('shows the saved piece, reloads on a change keeping the slide, keeps the last good build after a failure, and says when it stops', TIMEOUT, async () => {
      assert.ok(browser !== undefined, `${engine} did not launch`);
      const root = copyPiece(STARTER, `serve-${engine}`);
      const session = await serve(root);
      const context = await browser.newContext({viewport: {width: 1280, height: 800}});
      const page = await context.newPage();
      const errors: string[] = [];
      const foreign: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      context.on('request', (request) => {
        const url = request.url();
        if (!url.startsWith(`${session.origin}/`) && !url.startsWith(`${session.previewOrigin}/`)) {
          foreign.push(url);
        }
      });
      try {
        await page.goto(session.origin);
        const first = await front(page);
        assert.match(first.src, new RegExp(`^${session.previewOrigin.replace(/[.]/g, '\\.')}/[0-9a-z]+-[0-9a-f]{12}/index\\.html\\?parent=`));
        assert.equal(await page.title(), 'piece · Papeleria preview');
        assert.match((await first.frame.evaluate(() => document.body.textContent)) ?? '', /Craft with care\. Build for the long view\./);

        // The reader moves on; the shell keeps the place in its own address.
        await page.click('.serve-frame:not(.is-loading)', {position: {x: 20, y: 200}});
        await page.keyboard.press('ArrowRight');
        await page.waitForFunction(() => location.hash === '#slide-2');

        const manifest = join(root, 'papeleria.yaml');
        const original = readFileSync(manifest, 'utf8');
        writeFileSync(manifest, original.replace('Care should be visible in the work.', 'Care shows in the work.'));
        const second = await front(page, first.src);
        await second.frame.waitForFunction(() => (window as unknown as {papeleriaDeck?: {current: number}}).papeleriaDeck?.current === 2);
        assert.match((await second.frame.evaluate(() => document.body.textContent)) ?? '', /Care shows in the work\./);
        assert.equal(await page.locator('.serve-frame').count(), 1, 'the old frame is gone once the new one shows');

        writeFileSync(manifest, original.replace('layout: statement', 'layout: poster'));
        await page.waitForSelector('#note:not([hidden])');
        assert.match((await page.textContent('#note')) ?? '', /^[0-9]+ errors?\. Showing the last good build; the terminal lists them\.$/);
        assert.equal(await page.getAttribute('.serve-frame', 'src'), second.src);
        assert.equal(await deckCurrent(second.frame), 2);

        await session.close();
        await page.waitForFunction(() => document.getElementById('note')?.textContent === 'Papeleria stopped. Start it again from the terminal.', null, {timeout: 20_000});
        assert.deepEqual(errors, []);
        assert.deepEqual(foreign, [], 'nothing is asked of any other origin');
      } finally {
        await context.close();
        await session.close();
      }
    });
  });
}
