/**
 * M3.1 and M3.2: a document on screen, in Chromium, Firefox and WebKit (D51).
 * The every-block fixture (test/fixtures/document/all-blocks) is built by the
 * compiled CLI with the photograph, poster and video its case makes, and
 * served over loopback, whose log records every file a browser fetches (D74).
 *
 * - The page runs no script, and loads only files of its own `dist/`. The
 *   video loads nothing until the reader presses Play: its poster shows, the
 *   video file is never requested, and the player stands paused, muted and
 *   looping, with its controls and nothing buffered (IC04, D96).
 * - A section's address opens that section, and its heading links to it;
 *   the first section's slug steps past the page's own id (D95).
 * - The quote, callout, note and metadata take the kit's styles (D90).
 * - At 320 px nothing scrolls sideways (UX §02).
 * - The keyboard reaches the skip link first; following it, the next stop is
 *   the first section's heading link.
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {after, before, describe, test} from 'node:test';

import type {Browser, BrowserContextOptions, Page} from 'playwright';

import {applicationRoot} from '../helpers/paths.js';
import {generatedFiles, readPrintCases} from '../helpers/print-cases.js';
import {launchEngine, selectedEngines, type EngineName} from './helpers/engines.js';
import {serveDirectory, type StaticServer} from './helpers/static-server.js';

const TIMEOUT = {timeout: 120_000};
const CLI = join(applicationRoot, 'lib', 'src', 'cli', 'index.js');
const EVERY_BLOCK = readPrintCases().document.find((each) => each.name === 'every-block')!;

const workspace = mkdtempSync(join(tmpdir(), 'papeleria-document-'));
const piece = join(workspace, 'every-block');
const GENERATED = new Set(['dist', '.papeleria']);
let server: StaticServer | undefined;

before(async () => {
  cpSync(join(applicationRoot, EVERY_BLOCK.piece), piece, {recursive: true, filter: (path) => !GENERATED.has(basename(path))});
  for (const [path, bytes] of Object.entries(await generatedFiles(EVERY_BLOCK))) {
    mkdirSync(dirname(join(piece, path)), {recursive: true});
    writeFileSync(join(piece, path), bytes);
  }
  const built = spawnSync(process.execPath, [CLI, 'build', piece], {encoding: 'utf8'});
  assert.equal(built.status, 0, `papeleria build: ${built.stderr}`);
  server = await serveDirectory(workspace);
}, TIMEOUT);

after(async () => {
  await server?.close();
  rmSync(workspace, {recursive: true, force: true});
});

const PAGE = '/every-block/dist/index.html';

type Opened = {readonly page: Page; readonly requests: readonly string[]};

/** Opens the page (at `hash`, if given) and hands over the page and the paths the server saw for it. */
async function open(browser: Browser, options: BrowserContextOptions, hash: string, body: (opened: Opened) => Promise<void>): Promise<void> {
  if (server === undefined) {
    throw new Error('the fixture was not built and served');
  }
  const context = await browser.newContext({viewport: {width: 1280, height: 800}, ...options});
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`console error: ${message.text()}`);
    }
  });
  const from = server.requests.length;
  try {
    await page.goto(`${server.origin}${PAGE}${hash}`);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await body({page, requests: server.requests.slice(from)});
    assert.deepEqual(errors, [], 'the page reported errors');
  } finally {
    await context.close();
  }
}

const {run, excluded} = selectedEngines();

for (const engine of excluded) {
  test(`${engine}: not run`, {skip: `PAPELERIA_BROWSERS=${process.env['PAPELERIA_BROWSERS'] ?? ''} leaves ${engine} out`}, () => {});
}

/** The key that moves focus to the next link: WebKit on macOS moves it only between form controls with Tab alone. */
function tabKey(engine: EngineName): string {
  return engine === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab';
}

for (const engine of run) {
  describe(`a document in ${engine}`, () => {
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

    test('runs no script, loads only its own files, and the video loads nothing until played', TIMEOUT, async (context) => {
      context.diagnostic(`${engine} ${use().version()}`);
      await open(use(), {}, '', async ({page, requests}) => {
        assert.equal(await page.evaluate(() => document.scripts.length), 0, 'a document has no script (C22)');
        await page.waitForFunction(() => Array.from(document.images).every((image) => image.loading === 'lazy' || image.complete));
        const video = await page.evaluate(() => {
          const element = document.querySelector('video')!;
          return {
            paused: element.paused,
            autoplay: element.autoplay,
            muted: element.muted,
            loop: element.loop,
            controls: element.controls,
            playsinline: element.hasAttribute('playsinline'),
            preload: element.preload,
            readyState: element.readyState,
            poster: new URL(element.poster).pathname,
            printPoster: new URL(document.querySelector<HTMLImageElement>('.video-print-poster')!.src).pathname,
            printPosterShown: document.querySelector('.video-print-poster')!.getClientRects().length > 0,
          };
        });
        assert.deepEqual(
          {...video, poster: undefined, printPoster: undefined},
          {paused: true, autoplay: false, muted: true, loop: true, controls: true, playsinline: true, preload: 'none', readyState: 0, poster: undefined, printPoster: undefined, printPosterShown: false},
          'the player: paused, muted, looping, with controls, nothing loaded',
        );
        assert.equal(video.poster, video.printPoster, 'the print copy of the poster is the poster the player shows');
        const seen = await page.evaluate(() => performance.getEntriesByType('resource').length);
        context.diagnostic(`${requests.length} requests, ${seen} resource entries`);
        assert.ok(requests.includes(PAGE));
        assert.deepEqual(requests.filter((path) => !path.startsWith('/every-block/dist/')), [], 'nothing outside the piece is requested (C24)');
        assert.deepEqual(requests.filter((path) => path.endsWith('.mp4')), [], 'the video is not requested before Play (IC04)');
        assert.ok(requests.includes(video.poster), `the poster ${video.poster} is requested`);
      });
    });

    test('a section’s address opens it, and its heading links to itself (D95)', TIMEOUT, async () => {
      await open(use(), {}, '#numbers-tails-2', async ({page}) => {
        // The kit scrolls smoothly (site.css), so the heading arrives, not jumps.
        await page.waitForFunction(() => {
          const top = document.querySelector(':target')?.getBoundingClientRect().top;
          return top !== undefined && top >= -1 && top < 200;
        });
        const target = await page.evaluate(() => {
          const element = document.querySelector(':target');
          return element === null ? null : {id: element.id, top: element.getBoundingClientRect().top, link: element.querySelector('a')?.getAttribute('href') ?? null};
        });
        assert.ok(target !== null, 'the address names an element');
        assert.equal(target.id, 'numbers-tails-2');
        assert.equal(target.link, '#numbers-tails-2');
        assert.ok(target.top >= -1 && target.top < 200, `the section's heading is at the top of the window, ${target.top} px down`);
        const ids = await page.evaluate(() => Array.from(document.querySelectorAll('.doc-section > h2'), (heading) => heading.id));
        assert.deepEqual(ids, ['document-2', 'numbers-tails', 'numbers-tails-2'], 'the first slug steps past the page’s own id, #document');
      });
    });

    test('the quote, callout, note and metadata take the kit’s styles (D90)', TIMEOUT, async () => {
      await open(use(), {}, '', async ({page}) => {
        const styles = await page.evaluate(() => {
          const style = (selector: string): CSSStyleDeclaration => getComputedStyle(document.querySelector(selector)!);
          const family = (declaration: CSSStyleDeclaration): string => declaration.fontFamily.split(',')[0]!.trim().replace(/^["']|["']$/g, '');
          // Engines write a computed size to their own precision: Firefox to
          // 1/64 px (19.1875px for 1.2rem), WebKit in single precision
          // (19.200001px). A tenth of a pixel tells the kit's sizes apart.
          const px = (declaration: CSSStyleDeclaration): number => Math.round(Number.parseFloat(declaration.fontSize) * 10) / 10;
          const quote = style('.quote-figure blockquote');
          return {
            quote: [family(quote), quote.fontWeight, px(quote), px(style('.quote-figure blockquote p'))],
            callout: [family(style('.doc-callout p')), px(style('.doc-callout p'))],
            note: [px(style('.note p')), px(style('.note.warning p'))],
            metadata: [style('.doc-metadata').display, style('.doc-metadata').gridTemplateColumns.split(' ').length],
          };
        });
        assert.deepEqual(styles, {
          quote: ['Poppins', '500', 24, 24],
          callout: ['Poppins', 19.2],
          note: [14.4, 14.4],
          metadata: ['grid', 2],
        });
      });
    });

    test('at 320 px nothing scrolls sideways', TIMEOUT, async () => {
      await open(use(), {viewport: {width: 320, height: 640}}, '', async ({page}) => {
        const widths = await page.evaluate(() => ({scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth}));
        assert.ok(widths.scroll <= widths.client, `the page is ${widths.scroll} px wide in ${widths.client} px`);
      });
    });

    test('the keyboard reaches the skip link first, and following it, the first section’s heading link', TIMEOUT, async () => {
      await open(use(), {}, '', async ({page}) => {
        const focused = (): Promise<string> =>
          page.evaluate(() => {
            const element = document.activeElement;
            return element === null ? '' : `${element.className} ${element.getAttribute('href') ?? ''}`.trim();
          });
        await page.keyboard.press(tabKey(engine));
        assert.equal(await focused(), 'skip-link #document');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => location.hash === '#document');
        await page.keyboard.press(tabKey(engine));
        assert.equal(await focused(), 'doc-anchor #document-2');
      });
    });
  });
}
