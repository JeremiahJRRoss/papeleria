/**
 * M4.7 (A14): reduced motion across the comic, the document and the editor,
 * in Chromium, Firefox and WebKit. The deck's share is in
 * test/browser/deck.test.ts.
 *
 * - The comic, at the three viewports under `prefers-reduced-motion:
 *   reduce`: every turn, by button, key, swipe, edge click and drag, is
 *   complete when its action returns; the engine the reader receives, wrapped
 *   by an init script (ENGINE_TRAP, D118), is never asked for an animated
 *   turn: flipNext, flipPrev, flip and the renderer's startAnimation are
 *   never called; no element has a transition or animation; focus stays.
 * - Switched live: a curl running when reduced motion comes on finishes at
 *   once, the next turns are instant, focus does not move, and switching back
 *   brings the curl back. Guided view's steps are instant either way.
 * - The document, where nothing moves by itself: no transition or animation
 *   under reduced motion, and the video a reader starts can be paused; it
 *   never plays by itself.
 * - The editor: no transition or animation under reduced motion, switched on
 *   and off while it runs.
 * - A small screenshot series of a turn, at fixed moments after Next, with
 *   and without reduced motion, held to one rule: under reduced motion every
 *   moment shows the new page; with motion some moment shows the turn. Page 2
 *   is shown once and every image decoded before the turn is recorded, since
 *   an engine may paint an image it has never painted a frame late (the
 *   likely reason WebKit failed the rule once in CI); a failed rule logs how
 *   each capture differs and leaves them in test-results/motion/.
 *   The series in test/golden/motion/ was written by this test in Chromium
 *   (PAPELERIA_MOTION_SERIES=1), for the person who inspects A14's recording.
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {after, before, describe, test} from 'node:test';

import type {Browser, Page} from 'playwright';

import {comparePixels} from '../golden/pixels.js';
import {applicationRoot} from '../helpers/paths.js';
import {generatedFiles, readPrintCases} from '../helpers/print-cases.js';
import {removeTemporaryFolders} from '../helpers/pieces.js';
import {buildComics, CLI, ENGINE_TRAP, engineCalls, expectedLayout, readReader, VIEWPORTS, viewportLabel, waitForPages, withComic, type BuiltComics, type OpenOptions} from './helpers/comic-fixture.js';
import {openEditor} from './helpers/editor-session.js';
import {launchEngine, selectedEngines} from './helpers/engines.js';
import {dispatchSwipe} from './helpers/gestures.js';
import {serveDirectory, type StaticServer} from './helpers/static-server.js';

const TIMEOUT = {timeout: 180_000};
const EVERY_BLOCK = readPrintCases().document.find((each) => each.name === 'every-block')!;
const SERIES = join(applicationRoot, 'test', 'golden', 'motion');

const workspace = mkdtempSync(join(tmpdir(), 'papeleria-motion-'));
let comics: BuiltComics | undefined;
let server: StaticServer | undefined;

before(async () => {
  comics = await buildComics(workspace);
  const document = join(workspace, 'document');
  cpSync(join(applicationRoot, EVERY_BLOCK.piece), document, {recursive: true, filter: (path) => !['dist', '.papeleria'].includes(basename(path))});
  for (const [path, bytes] of Object.entries(await generatedFiles(EVERY_BLOCK))) {
    mkdirSync(dirname(join(document, path)), {recursive: true});
    writeFileSync(join(document, path), bytes);
  }
  const built = spawnSync(process.execPath, [CLI, 'build', document], {encoding: 'utf8'});
  assert.equal(built.status, 0, built.stderr);
  server = await serveDirectory(workspace);
}, {timeout: 300_000});

after(async () => {
  await server?.close();
  rmSync(workspace, {recursive: true, force: true});
  removeTemporaryFolders();
});

function address(path: string): string {
  if (server === undefined || comics === undefined) {
    throw new Error('the pieces were not built and served');
  }
  return `${server.origin}/${path}`;
}

/** Every element with a transition or an animation that takes time, as "tag.classes#id: property duration". */
function moving(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('*')).flatMap((element) => {
      const style = getComputedStyle(element);
      const seconds = (value: string): number[] => value.split(',').map((part) => Number.parseFloat(part) || 0);
      const transition = seconds(style.transitionDuration).some((value) => value > 0);
      const animation = style.animationName.split(',').some((name) => name.trim() !== 'none') && seconds(style.animationDuration).some((value) => value > 0);
      if (!transition && !animation) {
        return [];
      }
      const classes = typeof element.className === 'string' && element.className !== '' ? `.${element.className.trim().split(/\s+/).join('.')}` : '';
      return [`${element.tagName.toLowerCase()}${classes}#${element.id}: ${style.transitionProperty} ${style.transitionDuration} ${style.animationName} ${style.animationDuration}`];
    }),
  );
}

/** Captures until two in a row are the same: the book as painted, not while it is being painted. */
async function settled(page: Page, capture: () => Promise<Buffer>): Promise<Buffer> {
  let last = await capture();
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await page.waitForTimeout(50);
    const next = await capture();
    if (next.equals(last)) {
      return next;
    }
    last = next;
  }
  throw new Error('the book was still changing after 60 captures');
}

/** The pages the engine shows right now, without waiting. */
function shownNow(page: Page): Promise<number[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('.comic-book figure.comic-figure'))
      .filter((figure) => getComputedStyle(figure).display !== 'none')
      .map((figure) => Number(figure.dataset['page']))
      .sort((one, two) => one - two),
  );
}

const {run, excluded} = selectedEngines();

for (const engine of excluded) {
  test(`${engine}: not run`, {skip: `PAPELERIA_BROWSERS=${process.env['PAPELERIA_BROWSERS'] ?? ''} leaves ${engine} out`}, () => {});
}

for (const engine of run) {
  describe(`reduced motion in ${engine} (A14)`, () => {
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
    const open = (path: string, options: OpenOptions, body: Parameters<typeof withComic>[3]): Promise<void> => withComic(use(), address(path), options, body);

    test('the comic: every turn instant, no animated engine call, nothing moving, focus kept, at the three viewports', TIMEOUT, async (context) => {
      for (const viewport of VIEWPORTS) {
        const spread = expectedLayout(viewport) === 'spread';
        await open('sample/dist/index.html', {init: ENGINE_TRAP, context: {viewport, reducedMotion: 'reduce', hasTouch: true}}, async ({page}) => {
          assert.equal((await readReader(page)).instant, true, 'prefers-reduced-motion starts the reader in instant mode');
          const second = spread ? [2, 3] : [2];
          // Each turn is on screen when its action returns: read at once, without waiting.
          await page.click('#comic-next');
          assert.deepEqual(await shownNow(page), second, 'Next');
          await page.focus('#comic-book');
          await page.keyboard.press('ArrowLeft');
          assert.deepEqual(await shownNow(page), [1], 'a key');
          assert.equal(await page.evaluate(() => document.activeElement?.id), 'comic-book', 'focus stays where it was');
          const figure = await page.evaluate(() => {
            const rect = document.querySelector('.comic-book figure[data-page="1"]')!.getBoundingClientRect();
            return {x: rect.left, y: rect.top, width: rect.width, height: rect.height};
          });
          await dispatchSwipe(page, '.comic-book figure[data-page="1"] img', {x: figure.x + figure.width * 0.6, y: figure.y + figure.height * 0.5}, {dx: -140, dy: 6});
          assert.deepEqual(await shownNow(page), second, 'a swipe');
          await page.evaluate(() => window.papeleriaReader!.goTo(1));
          const edge = {x: figure.x + figure.width * 0.985, y: figure.y + figure.height * 0.5};
          await page.mouse.click(edge.x, edge.y);
          assert.deepEqual(await shownNow(page), second, 'an edge-zone click');
          await page.evaluate(() => window.papeleriaReader!.goTo(1));
          await page.mouse.move(edge.x, edge.y);
          await page.mouse.down();
          await page.mouse.move(edge.x - figure.width * 0.4, edge.y, {steps: 6});
          await page.mouse.up();
          assert.deepEqual(await shownNow(page), second, 'a drag');
          await page.click('#comic-guided');
          await page.keyboard.press('ArrowRight');
          assert.equal((await readReader(page)).panel, 2, 'a guided step');
          assert.deepEqual(await moving(page), [], 'nothing moves');
          const calls = await engineCalls(page);
          assert.deepEqual({flipNext: calls.flipNext, flipPrev: calls.flipPrev, flip: calls.flip, startAnimation: calls.startAnimation}, {flipNext: 0, flipPrev: 0, flip: 0, startAnimation: 0}, `${viewportLabel(viewport)}: the engine's animated path is never called`);
          assert.ok(calls.turnToPage >= 5, `${calls.turnToPage} instant turns`);
          context.diagnostic(`${engine} ${viewportLabel(viewport)}: ${calls.turnToPage} instant turns, 0 animated engine calls`);
        });
      }
    });

    test('the comic, switched live: a running curl ends at once, turns become instant, focus stays, and the curl comes back', TIMEOUT, async () => {
      await open('sample/dist/index.html', {init: ENGINE_TRAP, context: {reducedMotion: 'no-preference'}}, async ({page}) => {
        assert.equal((await readReader(page)).instant, false);
        await page.focus('#comic-book');
        await page.keyboard.press('ArrowRight');
        const during = await engineCalls(page);
        assert.ok(during.startAnimation >= 1 || during.flipNext >= 1, 'with motion, Next curls');
        await page.emulateMedia({reducedMotion: 'reduce'});
        await waitForPages(page, [2, 3], 1000);
        await page.waitForFunction(() => window.papeleriaReader!.instant, undefined, {timeout: 2000});
        const state = await readReader(page);
        assert.deepEqual([state.instant, state.focus], [true, 'comic-book'], 'instant now, and focus did not move');
        const before = (await engineCalls(page)).startAnimation;
        await page.keyboard.press('ArrowRight');
        assert.deepEqual(await shownNow(page), [4, 5], 'the next turn is instant');
        assert.equal((await engineCalls(page)).startAnimation, before, 'with no animation');
        assert.deepEqual(await moving(page), []);
        await page.emulateMedia({reducedMotion: 'no-preference'});
        // The media query's change arrives with the next rendering update, not with emulateMedia's promise.
        await page.waitForFunction(() => window.papeleriaReader!.instant === false, undefined, {timeout: 2000});
        await page.keyboard.press('ArrowRight');
        await waitForPages(page, [6, 7]);
        assert.ok((await engineCalls(page)).startAnimation > before, 'the curl is back');
        // Guided view never animates, whatever the setting.
        await page.click('#comic-guided');
        await page.keyboard.press('ArrowRight');
        const lensMoves = (await moving(page)).filter((item) => /comic-lens/.test(item));
        assert.deepEqual(lensMoves, [], 'a guided step is instant');
      });
    });

    test('the document: nothing moves under reduced motion, and the video a reader starts can be paused', TIMEOUT, async () => {
      await open('document/dist/index.html', {reader: false, context: {reducedMotion: 'reduce'}}, async ({page}) => {
        assert.deepEqual(await moving(page), []);
        assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior), 'auto');
        const video = await page.evaluate(async () => {
          const element = document.querySelector('video')!;
          const before = {paused: element.paused, autoplay: element.autoplay, controls: element.controls};
          element.muted = true;
          await element.play().catch(() => undefined);
          element.pause();
          return {...before, pausedAfter: element.paused};
        });
        assert.deepEqual(video, {paused: true, autoplay: false, controls: true, pausedAfter: true}, 'it waits for the reader, and pauses when asked');
        await page.emulateMedia({reducedMotion: 'no-preference'});
        await page.emulateMedia({reducedMotion: 'reduce'});
        assert.deepEqual(await moving(page), [], 'and again after a live switch');
      });
    });

    test('the editor: nothing moves under reduced motion, switched on and off while it runs', TIMEOUT, async () => {
      const fixture = await openEditor(use(), join(applicationRoot, 'templates', 'deck', 'sample'), {label: 'motion-editor'});
      try {
        const {page} = fixture;
        await page.emulateMedia({reducedMotion: 'reduce'});
        assert.deepEqual(await moving(page), [], 'the editor under reduced motion');
        await page.emulateMedia({reducedMotion: 'no-preference'});
        await page.emulateMedia({reducedMotion: 'reduce'});
        assert.deepEqual(await moving(page), [], 'and after switching it off and on');
        assert.deepEqual(fixture.problems, []);
      } finally {
        await fixture.close();
      }
    });

    test('a turn, in moments: under reduced motion every moment is the new page; with motion some moment is the turn', TIMEOUT, async (context) => {
      const write = engine === 'chromium' && process.env['PAPELERIA_MOTION_SERIES'] === '1';
      for (const motion of ['reduce', 'no-preference'] as const) {
        await open('sample/dist/index.html', {context: {viewport: {width: 390, height: 844}, reducedMotion: motion}}, async ({page}) => {
          const book = await page.evaluate(() => {
            const rect = document.getElementById('comic-book')!.getBoundingClientRect();
            return {x: Math.floor(rect.left), y: Math.floor(rect.top), width: Math.floor(rect.width), height: Math.floor(rect.height)};
          });
          const frame = (): Promise<Buffer> => page.screenshot({clip: book, animations: 'allow'});
          // Page 2's image is kept from the start (D114): let it load, so no moment waits for its bytes.
          await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLImageElement>('figure.comic-figure img[src]')).every((image) => image.complete));
          // An engine may paint an image it has never painted a frame late, while it decodes it (the likely reason WebKit
          // failed this rule once in CI): that is not motion. So page 2 is shown once and every image the book holds is
          // decoded before the turn is recorded.
          await page.click('#comic-next');
          await waitForPages(page, [2]);
          await settled(page, frame);
          await page.click('#comic-previous');
          await waitForPages(page, [1]);
          // Only images that have loaded: decode() on a lazy image that has not waits until it does.
          await page.evaluate(() =>
            Promise.all(
              Array.from(document.querySelectorAll<HTMLImageElement>('figure.comic-figure img[src]'))
                .filter((image) => image.complete && image.naturalWidth > 0)
                .map((image) => image.decode().catch(() => undefined)),
            ),
          );
          const start = await settled(page, frame);
          await page.click('#comic-next');
          const moments: Buffer[] = [];
          for (const wait of [0, 120, 240, 360]) {
            if (wait > 0) {
              await page.waitForTimeout(120);
            }
            moments.push(await frame());
          }
          await waitForPages(page, [2]);
          const end = await settled(page, frame);
          const name = motion === 'reduce' ? 'reduced' : 'motion';
          const holds = motion === 'reduce' ? moments.every((moment) => moment.equals(end)) : moments.some((moment) => !moment.equals(start) && !moment.equals(end));
          if (!holds) {
            // What differed, in the log, and the captures where CI keeps a failed run's evidence (D70).
            const kept = join(applicationRoot, 'test-results', 'motion');
            mkdirSync(kept, {recursive: true});
            for (const [label, capture] of [['0-start', start], ...moments.map((moment, index) => [`${index + 1}-${index * 120}ms`, moment] as const), ['5-end', end]] as const) {
              writeFileSync(join(kept, `${engine}-${name}-${label}.png`), capture);
              const compared = await comparePixels(capture, end, {weakDelta: 8, strongDelta: 64});
              context.diagnostic(`${engine} ${name} ${label}: ${compared.weak} pixels differ from the end by more than 8 levels, ${compared.strong} by more than 64`);
            }
          }
          assert.ok(holds, motion === 'reduce' ? 'every moment after Next already shows page 2' : 'some moment shows the page turning');
          if (write) {
            mkdirSync(SERIES, {recursive: true});
            writeFileSync(join(SERIES, `${name}-0-start.png`), start);
            moments.forEach((moment, index) => writeFileSync(join(SERIES, `${name}-${index + 1}-${index * 120}ms.png`), moment));
            writeFileSync(join(SERIES, `${name}-5-end.png`), end);
            context.diagnostic(`wrote the ${name} series to test/golden/motion/`);
          }
        });
      }
    });
  });
}
