/**
 * M2.6: the preview bridge in real frames (IC06, D83), Chromium, Firefox and
 * WebKit on CI (D51).
 *
 * The deck's preview bundle runs in the generation an editing session made,
 * with the editor page as its parent; the test speaks for the editor through
 * that page. The bridge alone — what a template with no script of its own
 * gets — runs in a two-origin fixture: a parent page on one loopback origin
 * framing a page on another. Covered: `ready` from the deck's own current
 * slide and again after a reader's move; `goto` through `goTo`, never the
 * address, and in the stacked view for the slide already current; messages
 * from another window, another origin or another generation, or of another
 * shape, changing nothing; `returnFocus`; a section `goto` the page may take
 * itself; `restoreScroll` and `scroll`; an outgoing link opening in a new tab
 * only after the reader acts, never from a script alone (W5R-G02); silence
 * when opened alone or given a parent that is not loopback; and no bridge in
 * the published client.
 */
import assert from 'node:assert/strict';
import {copyFileSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {after, before, describe, test} from 'node:test';

import type {Browser, Frame, Page} from 'playwright';

import {applicationRoot} from '../helpers/paths.js';
import {removeTemporaryFolders, temporaryFolder} from '../helpers/pieces.js';
import {frameOf, lineOf, nextShown, openEditor, placeCursor, shown, TYPING, type EditorFixture} from './helpers/editor-session.js';
import {launchEngine, selectedEngines} from './helpers/engines.js';
import {serveDirectory, type StaticServer} from './helpers/static-server.js';

const TIMEOUT = {timeout: 120_000};
const STARTER = join(applicationRoot, 'templates', 'deck', 'sample');
const CLIENTS = join(applicationRoot, 'lib', 'clients');
const ALONE_ID = 'muhz0000-0123456789ab';

after(removeTemporaryFolders);

declare global {
  interface Window {
    /** Installed by the tests in a parent page: what the bridge sent it. */
    bridgeSeen?: {origin: string; data: unknown}[];
  }
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolvePause) => setTimeout(resolvePause, milliseconds));
}

test('the published deck client carries no bridge; both preview bundles do', () => {
  const published = readFileSync(join(CLIENTS, 'deck.js'), 'utf8');
  for (const part of ['papeleria-preview-goto', 'postMessage', 'returnFocus']) {
    assert.ok(!published.includes(part), `deck.js holds ${part}`);
  }
  for (const bundle of ['deck-preview.js', 'document-preview.js']) {
    const text = readFileSync(join(CLIENTS, bundle), 'utf8');
    assert.ok(text.includes('papeleria-preview-goto') && text.includes('returnFocus'), bundle);
    assert.ok(!/postMessage\([^)]*['"]\*['"]\)/.test(text), `${bundle} never posts to any origin`);
  }
});

/** Starts collecting, in `page`, the messages `origin` sends it. */
async function collect(page: Page, origin: string): Promise<void> {
  await page.evaluate((from) => {
    window.bridgeSeen = [];
    window.addEventListener('message', (event) => {
      if (event.origin === from) {
        window.bridgeSeen!.push({origin: event.origin, data: event.data});
      }
    });
  }, origin);
}

async function seen(page: Page): Promise<{origin: string; data: Record<string, unknown>}[]> {
  return page.evaluate(() => (window.bridgeSeen ?? []) as {origin: string; data: Record<string, unknown>}[]);
}

async function waitForMessage(page: Page, match: (data: Record<string, unknown>) => boolean, what: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const found = (await seen(page)).find((message) => match(message.data));
    if (found !== undefined) {
      return found.data;
    }
    if (Date.now() > deadline) {
      throw new Error(`no ${what} arrived; saw ${JSON.stringify(await seen(page))}`);
    }
    await pause(50);
  }
}

/** Posts a message from the editor page to the frame showing `id`, as the editor does. */
async function postToFrame(page: Page, id: string, message: unknown, targetOrigin: string): Promise<void> {
  await page.evaluate(
    ({generation, data, origin}) => {
      document.querySelector<HTMLIFrameElement>(`iframe[data-generation-id="${generation}"]`)!.contentWindow!.postMessage(data, origin);
    },
    {generation: id, data: message, origin: targetOrigin},
  );
}

function deckState(frame: Frame): Promise<{current: number; showAll: boolean; history: number; hash: string}> {
  return frame.evaluate(() => {
    const deck = (window as unknown as {papeleriaDeck: {current: number; showAll: boolean}}).papeleriaDeck;
    return {current: deck.current, showAll: deck.showAll, history: history.length, hash: location.hash};
  });
}

const {run, excluded} = selectedEngines();

for (const engine of excluded) {
  test(`${engine}: not run`, {skip: `PAPELERIA_BROWSERS=${process.env['PAPELERIA_BROWSERS'] ?? ''} leaves ${engine} out`}, () => {});
}

for (const engine of run) {
  describe(`preview bridge in ${engine}`, () => {
    let browser: Browser | undefined;
    let alone: {preview: StaticServer; parent: StaticServer} | undefined;
    before(async () => {
      browser = await launchEngine(engine);
      const previewRoot = temporaryFolder(`bridge-preview-${engine}`);
      mkdirSync(join(previewRoot, ALONE_ID));
      copyFileSync(join(CLIENTS, 'document-preview.js'), join(previewRoot, ALONE_ID, 'preview.js'));
      writeFileSync(
        join(previewRoot, ALONE_ID, 'index.html'),
        [
          '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A page with the bridge alone</title>',
          '<script src="preview.js" defer></script></head><body><main>',
          '<h1 id="intro" tabindex="-1">Intro</h1><p style="height: 2400px">Text.</p>',
          '<h2 id="the-basis">The basis</h2><p style="height: 2400px">More text.</p>',
          '</main></body></html>',
        ].join('\n'),
      );
      // Links (IC06): an outgoing link a script clicks once the page has loaded, before the reader does anything; one a
      // script clicks while the reader presses a button, as the comic's Detail does for a link panel; and one for the
      // reader. links.js is test tooling that records every tab the page asks for.
      writeFileSync(
        join(previewRoot, ALONE_ID, 'links.html'),
        [
          '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Links</title>',
          '<script src="links.js"></script><script src="preview.js" defer></script></head><body><main>',
          '<p><a id="scripted" href="https://example.com/scripted">Scripted</a> <a id="delegated" href="https://example.com/delegated">Delegated</a></p>',
          '<p><button type="button" id="relay">Follow the delegated link</button> <a id="away" href="https://example.com/away">Away</a></p>',
          '</main></body></html>',
        ].join('\n'),
      );
      writeFileSync(
        join(previewRoot, ALONE_ID, 'links.js'),
        [
          'const open = window.open;',
          'window.opened = [];',
          'window.open = function (...args) {',
          '  window.opened.push(String(args[0]));',
          '  return open.apply(this, args);',
          '};',
          "window.addEventListener('load', () => {",
          "  document.getElementById('scripted').click();",
          "  document.body.dataset.scripted = 'clicked';",
          "  document.getElementById('relay').addEventListener('click', () => document.getElementById('delegated').click());",
          '});',
        ].join('\n'),
      );
      const parentRoot = temporaryFolder(`bridge-parent-${engine}`);
      writeFileSync(join(parentRoot, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Parent</title></head><body></body></html>\n');
      alone = {preview: await serveDirectory(previewRoot), parent: await serveDirectory(parentRoot)};
    }, TIMEOUT);
    after(async () => {
      await browser?.close();
      await alone?.preview.close();
      await alone?.parent.close();
    });

    async function withEditor(body: (editor: EditorFixture) => Promise<void>): Promise<void> {
      if (browser === undefined) {
        throw new Error(`${engine} did not launch`);
      }
      const editor = await openEditor(browser, STARTER, {label: `bridge-${engine}`});
      try {
        await body(editor);
      } finally {
        await editor.close();
      }
    }

    /** A parent page on one origin framing a bridge-alone page from another; returns the frame. */
    async function framedAlone(page: Page, parentParameter: string, hash = '', file = 'index.html'): Promise<Frame> {
      const fixture = alone!;
      await page.goto(`${fixture.parent.origin}/index.html`);
      await collect(page, fixture.preview.origin);
      const address = `${fixture.preview.origin}/${ALONE_ID}/${file}?parent=${encodeURIComponent(parentParameter)}${hash}`;
      await page.evaluate((src) => {
        const iframe = document.createElement('iframe');
        iframe.id = 'frame';
        iframe.style.width = '800px';
        iframe.style.height = '600px';
        iframe.src = src;
        document.body.append(iframe);
      }, address);
      const frame = await (await page.waitForSelector('#frame')).contentFrame();
      assert.ok(frame !== null);
      await frame.waitForLoadState('load');
      return frame;
    }

    test('ready names the deck’s current slide when a generation loads, and again after a reader’s move', TIMEOUT, async () => {
      await withEditor(async ({page, session}) => {
        await collect(page, session.previewOrigin);
        const before = (await shown(page))!;
        await placeCursor(page, await lineOf(page, 'title: Care should be visible in the work.'));
        await page.keyboard.type(' Again.', TYPING);
        const id = await nextShown(page, before);
        const ready = await waitForMessage(page, (data) => data['type'] === 'ready' && data['generationId'] === id, 'ready');
        assert.deepEqual(ready, {type: 'ready', generationId: id, hash: '#slide-2'});
        assert.ok((await seen(page)).every((message) => message.origin === session.previewOrigin));

        const frame = frameOf(page, id);
        await page.frameLocator(`iframe[data-generation-id="${id}"]`).locator('main').click({position: {x: 10, y: 10}});
        await frame.evaluate(() => document.getElementById('slide-2')?.focus());
        await page.keyboard.press('ArrowRight');
        const moved = await waitForMessage(page, (data) => data['type'] === 'ready' && data['hash'] === '#slide-3', 'ready after the move');
        assert.equal(moved['generationId'], id);
      });
    });

    test('goto shows a slide through the deck, never through the address, and in the stacked view brings the current slide to the top', TIMEOUT, async () => {
      await withEditor(async ({page, session}) => {
        const id = (await shown(page))!;
        const frame = frameOf(page, id);
        const start = await deckState(frame);
        await postToFrame(page, id, {type: 'goto', generationId: id, target: {kind: 'slide', slide: 4}}, session.previewOrigin);
        await frame.waitForFunction(() => (window as unknown as {papeleriaDeck: {current: number}}).papeleriaDeck.current === 4);
        const after4 = await deckState(frame);
        assert.equal(after4.history, start.history, 'no history entry: the bridge never navigates');
        assert.equal(await page.evaluate(() => document.activeElement?.tagName === 'IFRAME'), false, 'the frame does not take focus');

        // The stacked view: goTo does nothing for the slide already current, so the bridge brings it to the top itself.
        await frame.click('#all-slides');
        await frame.waitForFunction(() => (window as unknown as {papeleriaDeck: {showAll: boolean}}).papeleriaDeck.showAll);
        await postToFrame(page, id, {type: 'goto', generationId: id, target: {kind: 'slide', slide: 2}}, session.previewOrigin);
        await frame.waitForFunction(() => (window as unknown as {papeleriaDeck: {current: number}}).papeleriaDeck.current === 2);
        const atTop = (): boolean => {
          const slide = document.getElementById('slide-2')!;
          return Math.abs(slide.getBoundingClientRect().top - Number.parseFloat(getComputedStyle(slide).scrollMarginTop)) < 2;
        };
        await frame.waitForFunction(atTop);
        await frame.evaluate(() => window.scrollTo({top: 0, behavior: 'instant'}));
        assert.equal(await frame.evaluate(atTop), false);
        await postToFrame(page, id, {type: 'goto', generationId: id, target: {kind: 'slide', slide: 2}}, session.previewOrigin);
        await frame.waitForFunction(atTop);
        assert.equal((await deckState(frame)).history, start.history);
      });
    });

    test('a message from another window, another origin or another generation, or of another shape, changes nothing', TIMEOUT, async () => {
      await withEditor(async ({page, session}) => {
        const id = (await shown(page))!;
        const frame = frameOf(page, id);
        assert.equal((await deckState(frame)).current, 1);
        const goto = (slide: number, generationId = id): Record<string, unknown> => ({type: 'goto', generationId, target: {kind: 'slide', slide}});
        for (const message of [
          goto(3, 'muhz0000-ffffffffffff'),
          {...goto(3), extra: true},
          {type: 'goto', generationId: id, target: {kind: 'slide', slide: 0}},
          {type: 'navigate', generationId: id, url: `${session.previewOrigin}/`},
          JSON.stringify(goto(3)),
        ]) {
          await postToFrame(page, id, message, session.previewOrigin);
        }
        // Another window of the editor's own origin: an empty frame beside the preview.
        await page.evaluate(() => {
          const sibling = document.createElement('iframe');
          sibling.id = 'sibling';
          document.body.append(sibling);
        });
        const sibling = await (await page.waitForSelector('#sibling')).contentFrame();
        await sibling!.evaluate(
          ({generation, origin}) => {
            const target = window.parent.document.querySelector<HTMLIFrameElement>(`iframe[data-generation-id="${generation}"]`)!.contentWindow!;
            target.postMessage({type: 'goto', generationId: generation, target: {kind: 'slide', slide: 3}}, origin);
          },
          {generation: id, origin: session.previewOrigin},
        );
        // Another origin: the preview origin's own page, opened beside it.
        await page.evaluate(
          ({src}) => {
            const other = document.createElement('iframe');
            other.id = 'other-origin';
            other.src = src;
            document.body.append(other);
          },
          {src: `${session.previewOrigin}/${id}/index.html`},
        );
        const other = await (await page.waitForSelector('#other-origin')).contentFrame();
        await other!.waitForLoadState('load');
        await other!.evaluate(
          ({index}) => {
            window.parent.frames[index]!.postMessage({type: 'goto', generationId: location.pathname.split('/')[1], target: {kind: 'slide', slide: 3}}, '*');
          },
          {index: await page.evaluate((generation) => [...document.querySelectorAll('iframe')].findIndex((iframe) => iframe.dataset['generationId'] === generation), id)},
        );
        await pause(800);
        assert.equal((await deckState(frame)).current, 1, 'none of them moved the deck');
        // The same message from the right window, origin and generation does.
        await postToFrame(page, id, goto(3), session.previewOrigin);
        await frame.waitForFunction(() => (window as unknown as {papeleriaDeck: {current: number}}).papeleriaDeck.current === 3);
      });
    });

    test('Escape the page leaves unhandled comes back as returnFocus, for this generation only', TIMEOUT, async () => {
      await withEditor(async ({page, session}) => {
        const id = (await shown(page))!;
        await collect(page, session.previewOrigin);
        await page.frameLocator(`iframe[data-generation-id="${id}"]`).locator('main').click({position: {x: 10, y: 10}});
        await page.keyboard.press('Escape');
        assert.deepEqual(await waitForMessage(page, (data) => data['type'] === 'returnFocus', 'returnFocus'), {type: 'returnFocus', generationId: id});
      });
    });

    test('the bridge alone: ready with the page’s address, a section goto the page may take itself, restoreScroll and scroll', TIMEOUT, async () => {
      assert.ok(browser !== undefined && alone !== undefined);
      const context = await browser.newContext({viewport: {width: 1000, height: 800}});
      try {
        const page = await context.newPage();
        const frame = await framedAlone(page, alone.parent.origin, '#intro');
        assert.deepEqual(await waitForMessage(page, (data) => data['type'] === 'ready', 'ready'), {type: 'ready', generationId: ALONE_ID, hash: '#intro'});
        const post = (message: unknown): Promise<void> =>
          page.evaluate(({data, origin}) => document.querySelector<HTMLIFrameElement>('#frame')!.contentWindow!.postMessage(data, origin), {data: message, origin: alone!.preview.origin});

        await post({type: 'goto', generationId: ALONE_ID, target: {kind: 'section', slug: 'the-basis'}});
        await frame.waitForFunction(() => Math.abs(document.getElementById('the-basis')!.getBoundingClientRect().top) < 2);
        const scrolled = await waitForMessage(page, (data) => data['type'] === 'scroll' && Number(data['y']) > 0, 'scroll');
        assert.equal(scrolled['generationId'], ALONE_ID);

        await post({type: 'restoreScroll', generationId: ALONE_ID, y: 100});
        await frame.waitForFunction(() => window.scrollY === 100);

        // A page that handles the goto itself cancels the event, and the bridge leaves the scroll alone.
        await frame.evaluate(() => document.addEventListener('papeleria-preview-goto', (event) => event.preventDefault()));
        await post({type: 'goto', generationId: ALONE_ID, target: {kind: 'section', slug: 'the-basis'}});
        await pause(500);
        assert.equal(await frame.evaluate(() => window.scrollY), 100);

        // A click, as a reader's would: a script's focus() does not move keyboard focus into a frame in every engine (WebKit).
        await frame.click('#intro');
        await page.keyboard.press('Escape');
        assert.deepEqual(await waitForMessage(page, (data) => data['type'] === 'returnFocus', 'returnFocus'), {type: 'returnFocus', generationId: ALONE_ID});
      } finally {
        await context.close();
      }
    });

    test('an outgoing link opens in a new tab only after the reader acts, never from a script alone, and the frame keeps its page (IC06)', TIMEOUT, async () => {
      assert.ok(browser !== undefined && alone !== undefined);
      const context = await browser.newContext({viewport: {width: 1000, height: 800}});
      try {
        // The new tabs' address is answered here, so nothing leaves the machine.
        await context.route('https://example.com/**', (route) => route.fulfill({status: 200, contentType: 'text/html', body: '<!doctype html><title>Away</title>'}));
        const page = await context.newPage();
        const frame = await framedAlone(page, alone.parent.origin, '', 'links.html');
        const address = frame.url();
        const opened = (): Promise<string[]> => frame.evaluate(() => (window as unknown as {opened: string[]}).opened);
        // links.js clicked #scripted at load, in the load event itself, before the test could act in the frame: a
        // script's click with no action of the reader's, which Playwright's own calls would otherwise lend it.
        assert.equal(await frame.evaluate(() => document.body.dataset['scripted']), 'clicked');
        assert.deepEqual(await opened(), [], 'no tab for a script\'s click alone');
        assert.equal(frame.url(), address, 'the frame keeps its page');

        const [tab] = await Promise.all([context.waitForEvent('page'), frame.click('#away')]);
        await tab.waitForLoadState('domcontentloaded');
        assert.equal(tab.url(), 'https://example.com/away', 'the reader\'s click opens its link in a new tab');
        assert.equal(await tab.evaluate(() => window.opener), null, 'with no way back to the preview');
        assert.deepEqual(await opened(), ['https://example.com/away']);

        // A script's click while the reader acts, as the comic's Detail follows a link panel: the reader's action.
        const [relayed] = await Promise.all([context.waitForEvent('page'), frame.click('#relay')]);
        await relayed.waitForLoadState('domcontentloaded');
        assert.equal(relayed.url(), 'https://example.com/delegated');
        assert.deepEqual(await opened(), ['https://example.com/away', 'https://example.com/delegated']);
        assert.equal(frame.url(), address, 'the frame keeps its page');
      } finally {
        await context.close();
      }
    });

    test('the bridge stays silent opened on its own, or given a parent that is not a loopback origin', TIMEOUT, async () => {
      assert.ok(browser !== undefined && alone !== undefined);
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(`${alone.preview.origin}/${ALONE_ID}/index.html`);
        await page.keyboard.press('Escape');
        assert.deepEqual(errors, []);

        for (const parent of ['http://evil.example', 'https://127.0.0.1:1', `${alone.parent.origin}/index.html`, 'null']) {
          await framedAlone(page, parent);
          await pause(600);
          assert.deepEqual(await seen(page), [], `parent=${parent}`);
        }
      } finally {
        await context.close();
      }
    });
  });
}
