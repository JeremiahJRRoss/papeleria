/**
 * M1.8: a deck made and built by the compiled CLI opens from disk (file://)
 * in Chromium, Firefox and WebKit (D51): slide 1 shows with its controls, the
 * keyboard moves on, nothing is requested from anywhere but the piece's own
 * files, and no error is reported. Without JavaScript every slide is there.
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {after, before, describe, test} from 'node:test';

import type {Browser, BrowserContextOptions, Page} from 'playwright';

import {applicationRoot} from '../helpers/paths.js';
import {launchEngine, selectedEngines} from './helpers/engines.js';

const TIMEOUT = {timeout: 90_000};
const CLI = join(applicationRoot, 'lib', 'src', 'cli', 'index.js');
const STRINGS = JSON.parse(readFileSync(join(applicationRoot, 'templates', 'shared', 'strings.en.json'), 'utf8')) as Record<string, string>;

const workspace = mkdtempSync(join(tmpdir(), 'papeleria-deck-build-'));
const piece = join(workspace, 'my-deck');
const address = pathToFileURL(join(piece, 'dist', 'index.html')).href;

before(() => {
  for (const args of [
    ['new', 'deck', piece],
    ['build', piece],
  ]) {
    const result = spawnSync(process.execPath, [CLI, ...args], {encoding: 'utf8'});
    assert.equal(result.status, 0, `papeleria ${args.join(' ')}: ${result.stderr}`);
  }
});

after(() => rmSync(workspace, {recursive: true, force: true}));

type Opened = {readonly page: Page; readonly requests: readonly string[]};

async function open(browser: Browser, options: BrowserContextOptions, body: (opened: Opened) => Promise<void>): Promise<void> {
  const context = await browser.newContext({viewport: {width: 1280, height: 800}, ...options});
  const page = await context.newPage();
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', (error) => errors.push(`page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`console error: ${message.text()}`);
    }
  });
  page.on('request', (request) => requests.push(request.url()));
  try {
    await page.goto(address);
    await body({page, requests});
    assert.deepEqual(errors, [], 'the page reported errors');
  } finally {
    await context.close();
  }
}

function visibleSlides(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('article.deck-slide'))
      .filter((slide) => slide.offsetParent !== null && getComputedStyle(slide).visibility !== 'hidden')
      .map((slide) => slide.id),
  );
}

const {run, excluded} = selectedEngines();

for (const engine of excluded) {
  test(`${engine}: not run`, {skip: `PAPELERIA_BROWSERS=${process.env['PAPELERIA_BROWSERS'] ?? ''} leaves ${engine} out`}, () => {});
}

for (const engine of run) {
  describe(`a built deck from file:// in ${engine}`, () => {
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

    test('opens on slide 1 with its controls, moves on with the keyboard, and loads only its own files', TIMEOUT, async (context) => {
      context.diagnostic(`${engine} ${use().version()}`);
      await open(use(), {}, async ({page, requests}) => {
        // deck.js ran: it marks the page enhanced before it changes anything else (CONTRACT.md §5).
        await page.waitForFunction(() => document.body.classList.contains('deck-enhanced'));
        assert.deepEqual(await visibleSlides(page), ['slide-1']);
        assert.equal(await page.locator('#deck-status').textContent(), 'Slide 1 of 5: Craft with care. Build for the long view.');
        const buttons = page.locator('.deck-tools button');
        assert.equal(await buttons.count(), 6);
        for (let index = 0; index < 6; index += 1) {
          assert.ok(await buttons.nth(index).isVisible(), `control ${index + 1} is visible`);
        }
        await page.keyboard.press('ArrowRight');
        await page.waitForFunction(() => location.hash === '#slide-2');
        assert.deepEqual(await visibleSlides(page), ['slide-2']);
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        await page.waitForFunction(() => location.hash === '#slide-4');
        assert.ok(await page.locator('#slide-4 .chart-frame svg').isVisible(), 'the chart drawn at build time shows');
        assert.deepEqual(
          requests.filter((url) => !url.startsWith('file://')),
          [],
          'nothing is requested from outside the piece (C24)',
        );
      });
    });

    test('without JavaScript every slide is there and the status says so', TIMEOUT, async () => {
      await open(use(), {javaScriptEnabled: false}, async ({page, requests}) => {
        assert.deepEqual(await visibleSlides(page), ['slide-1', 'slide-2', 'slide-3', 'slide-4', 'slide-5']);
        assert.equal((await page.locator('#deck-status').textContent())?.trim(), STRINGS['no_js_slides']);
        assert.equal(await page.locator('.deck-tools button:visible').count(), 0, 'controls that need the script stay hidden');
        assert.deepEqual(requests.filter((url) => !url.startsWith('file://')), []);
      });
    });
  });
}
