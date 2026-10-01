/**
 * M5.5 (W5D, D140): the release tarball as an author installs it, in
 * Chromium, Firefox and WebKit.
 *
 * The pack and the production installation are the tarball proof's own flow,
 * `test/helpers/tarball.ts`: the scaffold job proves the CLI's commands from
 * that installation (`test/package/tarball.ts`), and this suite drives what
 * needs a browser, from the same installation.
 *
 * - `edit`, started from the installed package with the opener off: the
 *   editor opens at the launch address and drops the key from the address
 *   bar; its preview shows the piece the installed tool built; a change
 *   written to disk under the clean tab reloads it and the preview follows;
 *   Build writes `dist/` through the session's API; Ctrl C stops it, and the
 *   page says so.
 * - `serve`: the shell shows the saved piece, follows a change on disk, and
 *   says when it stops.
 * - `file://`: the deck, the report and the comic the installed CLI built
 *   read from disk: the deck and the comic enhance, every stylesheet loads,
 *   every image that has a source and is not lazy loads, both font families
 *   load, no script error is thrown, and nothing is asked for outside the
 *   piece's `dist/` among the requests the engine reports (Firefox reports
 *   none for a `file://` page, D74, so there that last check holds by
 *   default).
 *
 * The installation fetches its dependencies from the npm registry, or from
 * the cache `npm ci` has just filled, as the tarball proof does.
 */
import assert from 'node:assert/strict';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {after, before, describe, test} from 'node:test';

import type {Browser, Frame, Page} from 'playwright';

import {EDIT_READY, SERVE_READY, packAndInstall, startInstalled, type Installation} from '../helpers/tarball.js';
import {launchEngine, selectedEngines} from './helpers/engines.js';
import {nextShown, shownText} from './helpers/editor-session.js';

const TIMEOUT = {timeout: 180_000};
const STOPPED = 'Papeleria stopped. Start it again from the terminal.';
const COVER = 'Craft with care. Build for the long view.';

let installation: Installation | undefined;

/** The pieces the installed CLI made and built once, read from disk in every engine. */
const BUILT = [
  {template: 'deck', folder: 'built-deck'},
  {template: 'document', folder: 'built-report'},
  {template: 'comic', folder: 'built-comic'},
] as const;

before(async () => {
  installation = await packAndInstall('release-smoke');
  for (const piece of BUILT) {
    const made = await installation.cli(['new', piece.template, piece.folder]);
    assert.equal(made.code, 0, made.stderr);
    const built = await installation.cli(['build', piece.folder]);
    assert.equal(built.code, 0, built.stderr);
    assert.match(built.stderr, / · 0 errors · 0 warnings · /);
  }
});

after(() => installation?.remove());

function installed(): Installation {
  assert.ok(installation !== undefined, 'the tarball was not installed');
  return installation;
}

/** Makes a fresh deck with the installed CLI, for a test that changes it. */
async function freshDeck(folder: string): Promise<string> {
  const made = await installed().cli(['new', 'deck', folder]);
  assert.equal(made.code, 0, made.stderr);
  return join(installed().install, folder);
}

/** Writes a new cover title into a deck's manifest, as another program would. */
function retitle(piece: string, title: string): void {
  const manifest = join(piece, 'papeleria.yaml');
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replaceAll(COVER, title));
}

/** The frame the serve shell shows, once it is shown, and its address (as `test/browser/serve.test.ts` reads it). */
async function served(page: Page, other?: string): Promise<{frame: Frame; src: string}> {
  const handle = await page.waitForSelector(other === undefined ? '.serve-frame:not(.is-loading)' : `.serve-frame:not(.is-loading):not([src="${other}"])`, {timeout: 60_000});
  const frame = await handle.contentFrame();
  assert.ok(frame !== null);
  return {frame, src: (await handle.getAttribute('src'))!};
}

const {run, excluded} = selectedEngines();

for (const engine of excluded) {
  test(`${engine}: not run`, {skip: `PAPELERIA_BROWSERS=${process.env['PAPELERIA_BROWSERS'] ?? ''} leaves ${engine} out`}, () => {});
}

for (const engine of run) {
  describe(`the installed release in ${engine}`, () => {
    let browser: Browser | undefined;
    before(async () => {
      browser = await launchEngine(engine);
    }, TIMEOUT);
    after(async () => {
      await browser?.close();
    });

    test('edit: the editor opens from the launch address, previews, follows a change on disk, builds, and stops on Ctrl C', TIMEOUT, async (context) => {
      assert.ok(browser !== undefined, `${engine} did not launch`);
      context.diagnostic(`${engine} ${browser.version()}`);
      const piece = await freshDeck(`edit-${engine}`);
      const edit = await startInstalled(installed(), ['edit', `edit-${engine}`], EDIT_READY);
      const [, origin, token] = edit.match;
      const page = await (await browser.newContext({viewport: {width: 1440, height: 900}})).newPage();
      const problems: string[] = [];
      page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
      page.on('console', (message) => {
        if (message.type() === 'error') {
          problems.push(`console error: ${message.text()}`);
        }
      });
      try {
        await page.goto(`${origin}/#token=${token}`);
        const first = await nextShown(page, undefined, 60_000);
        assert.equal(new URL(page.url()).hash, '', 'the key leaves the address bar (D77)');
        assert.equal(await page.textContent('#piece-line'), `edit-${engine} · deck · en · draft`);
        assert.match(await shownText(page), new RegExp(COVER.replace(/\./g, '\\.')));

        // A change written by another program under the clean tab: the tab reloads and the preview follows (D81).
        retitle(piece, 'Installed, then edited.');
        await nextShown(page, first, 60_000);
        assert.match(await shownText(page), /Installed, then edited\./);

        // Build, through the session's write API, from the saved files.
        await page.click('#build');
        await page.waitForFunction(() => document.getElementById('status-note')?.textContent?.startsWith('Built '), null, {timeout: 60_000});
        assert.equal(await page.textContent('#status-note'), `Built edit-${engine}/dist · 0 errors · 0 warnings`);
        assert.match(readFileSync(join(piece, 'dist', 'index.html'), 'utf8'), /Installed, then edited\./);

        const stopped = await edit.stop();
        assert.equal(stopped.code, 0, stopped.stderr);
        assert.match(stopped.stderr, /Stopped\. The preview files were removed\.\n$/);
        await page.waitForFunction((text) => document.body.textContent?.includes(text), STOPPED, {timeout: 30_000});
        assert.deepEqual(problems, []);
      } finally {
        await edit.stop();
        await page.context().close();
      }
    });

    test('serve: the shell shows the saved piece, follows a change on disk, and says when it stops', TIMEOUT, async () => {
      assert.ok(browser !== undefined, `${engine} did not launch`);
      const piece = await freshDeck(`serve-${engine}`);
      const serve = await startInstalled(installed(), ['serve', `serve-${engine}`], SERVE_READY);
      const [, origin] = serve.match;
      const page = await (await browser.newContext({viewport: {width: 1280, height: 800}})).newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        await page.goto(origin!);
        const first = await served(page);
        assert.match((await first.frame.evaluate(() => document.body.textContent)) ?? '', new RegExp(COVER.replace(/\./g, '\\.')));
        retitle(piece, 'Served, then changed.');
        const second = await served(page, first.src);
        assert.match((await second.frame.evaluate(() => document.body.textContent)) ?? '', /Served, then changed\./);
        assert.equal(existsSync(join(piece, 'dist')), false, 'serve never writes dist/');

        const stopped = await serve.stop();
        assert.equal(stopped.code, 0, stopped.stderr);
        await page.waitForFunction((text) => document.getElementById('note')?.textContent === text, STOPPED, {timeout: 30_000});
        assert.deepEqual(errors, []);
      } finally {
        await serve.stop();
        await page.context().close();
      }
    });

    for (const piece of BUILT) {
      test(`file://: the ${piece.template} the installed CLI built reads from disk`, TIMEOUT, async () => {
        assert.ok(browser !== undefined, `${engine} did not launch`);
        const dist = join(installed().install, piece.folder, 'dist');
        const inside = `${pathToFileURL(dist).href}/`;
        const context = await browser.newContext({viewport: {width: 1280, height: 800}});
        const page = await context.newPage();
        const errors: string[] = [];
        const outside: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        context.on('request', (request) => {
          if (!request.url().startsWith(inside)) {
            outside.push(request.url());
          }
        });
        try {
          await page.goto(`${inside}index.html`);
          if (piece.template === 'deck') {
            await page.waitForFunction(() => (window as unknown as {papeleriaDeck?: unknown}).papeleriaDeck !== undefined);
            assert.equal(await page.textContent('#deck-status'), `Slide 1 of 5: ${COVER}`);
          } else if (piece.template === 'comic') {
            await page.waitForFunction(() => (window as unknown as {papeleriaReader?: unknown}).papeleriaReader !== undefined);
            assert.match((await page.textContent('#comic-status')) ?? '', /^Pages? 1(?:–\d+)? of 8$/);
          } else {
            assert.equal(await page.locator('script').count(), 0, 'a document has no script (C22)');
            assert.ok(((await page.textContent('h1')) ?? '').trim() !== '', 'the takeaway is the page heading');
          }
          const loaded = await page.evaluate(async () => {
            await document.fonts.ready;
            // Rendering the text faces the page uses makes the browser fetch them.
            await Promise.all([document.fonts.load('600 16px Poppins'), document.fonts.load('400 16px Inter')]);
            // An image with no source asks for nothing: the reader's guided-view lens waits empty until guided view opens.
            const images = [...document.images].filter((image) => image.loading !== 'lazy' && (image.getAttribute('src') ?? '') !== '');
            await Promise.all(
              images.map((image) =>
                image.complete
                  ? undefined
                  : new Promise<void>((settle) => {
                      image.addEventListener('load', () => settle(), {once: true});
                      image.addEventListener('error', () => settle(), {once: true});
                    }),
              ),
            );
            return {
              stylesheets: [...document.querySelectorAll<HTMLLinkElement>('link[rel=stylesheet]')].map((link) => [link.getAttribute('href'), link.sheet !== null] as const),
              families: [...new Set([...document.fonts].filter((face) => face.status === 'loaded').map((face) => face.family.replace(/["']/g, '')))].sort(),
              broken: images.filter((image) => !image.complete || image.naturalWidth === 0).map((image) => image.getAttribute('src')),
              eager: images.length,
            };
          });
          assert.ok(loaded.stylesheets.length > 0);
          assert.deepEqual(loaded.stylesheets.filter(([, sheet]) => !sheet), [], 'every stylesheet loads');
          assert.deepEqual(loaded.families, ['Inter', 'Poppins'], 'both font families load');
          assert.deepEqual(loaded.broken, [], 'every image that is not lazy loads and decodes');
          assert.deepEqual(errors, []);
          assert.deepEqual(outside, [], 'nothing outside dist/ is asked for');
        } finally {
          await context.close();
        }
      });
    }
  });
}
