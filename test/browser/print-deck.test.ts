/**
 * M3.6 (IC08, D98): decks in print. The deck cases of
 * test/fixtures/print/cases.json — the starter deck, the brand overview and
 * a deck whose second slide holds more than a printed slide can — are built
 * by the compiled CLI on temporary copies and served over loopback.
 *
 * Chromium prints each to PDF with the deck's own `@page` rule (A4
 * landscape, 8 mm margins, slides.css), and poppler reads it back (D91): a
 * deck whose slides fit prints one page a slide, each page holding its own
 * slide's title, with nothing in the margins and no two words printed over
 * each other.
 *
 * In Chromium, Firefox and WebKit the deck is laid out in print media at the
 * printed page's width, 281 mm: every slide shows, each breaks after itself
 * but the last, the deck's tools, header and notes do not print, and the
 * overflow check measures each slide's content against its printed canvas
 * (190 mm tall). It passes the starter deck and the brand overview, and names
 * slide 2 of the overflow fixture, and only slide 2: oversized content is an
 * authoring defect print verification must catch (IC08), and this is the
 * check failing as designed on it.
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {after, before, describe, test} from 'node:test';

import type {Browser, Page} from 'playwright';

import {applicationRoot} from '../helpers/paths.js';
import {readPrintCases, type PrintCase} from '../helpers/print-cases.js';
import {launchEngine, selectedEngines} from './helpers/engines.js';
import {findInOrder, inkInMargins, MM, overlappingWords, pdfToolsMissing, printedText, readPdf, type PrintedPdf} from './helpers/print.js';
import {serveDirectory, type StaticServer} from './helpers/static-server.js';

const TIMEOUT = {timeout: 180_000};
const CLI = join(applicationRoot, 'lib', 'src', 'cli', 'index.js');
const CASES = readPrintCases().deck;

/** A deck's page: A4 landscape with 8 mm margins (slides.css). */
const A4_LANDSCAPE = {width: 297 * MM, height: 210 * MM};
const MARGIN = 8 * MM;
/** The printed page's width less both margins, in CSS pixels. */
const PAGE_WIDTH_PX = Math.floor((281 / 25.4) * 96);

const workspace = mkdtempSync(join(tmpdir(), 'papeleria-print-deck-'));
const GENERATED = new Set(['dist', '.papeleria']);
let server: StaticServer | undefined;

before(() => {
  for (const each of CASES) {
    const piece = join(workspace, each.name);
    cpSync(join(applicationRoot, each.piece), piece, {recursive: true, filter: (path) => !GENERATED.has(basename(path))});
    const built = spawnSync(process.execPath, [CLI, 'build', piece], {encoding: 'utf8'});
    assert.equal(built.status, 0, `papeleria build ${each.name}: ${built.stderr}`);
  }
}, TIMEOUT);

before(async () => {
  server = await serveDirectory(workspace);
});

after(async () => {
  await server?.close();
  rmSync(workspace, {recursive: true, force: true});
});

/** Opens a deck once its script has run and its fonts have loaded, and fails on any error it reports. */
async function open(browser: Browser, each: PrintCase, body: (page: Page) => Promise<void>): Promise<void> {
  if (server === undefined) {
    throw new Error('the decks were not built and served');
  }
  const context = await browser.newContext({viewport: {width: 1280, height: 800}});
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`console error: ${message.text()}`);
    }
  });
  try {
    await page.goto(`${server.origin}/${each.name}/dist/index.html`);
    await page.waitForFunction(() => document.body.classList.contains('deck-enhanced'));
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await body(page);
    assert.deepEqual(errors, [], 'the deck reported errors');
  } finally {
    await context.close();
  }
}

function slideTitles(page: Page): Promise<string[]> {
  return page.evaluate(() => Array.from(document.querySelectorAll('article.deck-slide .slide-title'), (title) => (title.textContent ?? '').trim()));
}

/**
 * The slides, numbered from 1, whose content does not fit their printed
 * canvas: the canvas scrolls, or any element inside it reaches past its
 * edges. Measured in print media, at the printed page's width.
 */
export async function overflowingSlides(page: Page): Promise<number[]> {
  await page.setViewportSize({width: PAGE_WIDTH_PX, height: 800});
  await page.emulateMedia({media: 'print'});
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('article.deck-slide'), (slide, index) => {
      const canvas = slide.querySelector('.slide-canvas');
      if (canvas === null) {
        return 0;
      }
      const edge = canvas.getBoundingClientRect();
      const reaching = Array.from(canvas.querySelectorAll('*')).some((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && (box.bottom > edge.bottom + 1 || box.right > edge.right + 1 || box.top < edge.top - 1 || box.left < edge.left - 1);
      });
      const scrolls = canvas.scrollHeight > canvas.clientHeight + 1 || canvas.scrollWidth > canvas.clientWidth + 1;
      return reaching || scrolls ? index + 1 : 0;
    }).filter((number) => number > 0),
  );
}

const keep = process.env['PAPELERIA_PRINT_OUT'];

async function print(page: Page, name: string): Promise<PrintedPdf> {
  const file = join(workspace, `${name}.pdf`);
  await page.pdf({path: file, preferCSSPageSize: true, tagged: true});
  if (keep !== undefined && keep !== '') {
    mkdirSync(keep, {recursive: true});
    copyFileSync(file, join(keep, `${name}.pdf`));
  }
  return readPdf(file);
}

const {run, excluded} = selectedEngines();

describe('decks printed to PDF by Chromium (D91)', {skip: run.includes('chromium') ? pdfToolsMissing() : 'PAPELERIA_BROWSERS leaves Chromium out, and only Chromium prints to PDF'}, () => {
  let browser: Browser | undefined;
  before(async () => {
    browser = await launchEngine('chromium');
  }, TIMEOUT);
  after(async () => {
    await browser?.close();
  });
  const use = (): Browser => {
    if (browser === undefined) {
      throw new Error('chromium did not launch');
    }
    return browser;
  };

  for (const each of CASES) {
    const fits = (each.overflowing ?? []).length === 0;
    const name = fits
      ? `${each.name}: one A4 landscape page a slide, each with its own title, nothing in the margins`
      : `${each.name}: the overflowing slide does not fit its printed page`;
    test(name, TIMEOUT, async (context) => {
      context.diagnostic(`chromium ${use().version()}`);
      await open(use(), each, async (page) => {
        const titles = await slideTitles(page);
        assert.equal(titles.length, each.slides, 'slides in the deck');
        const pdf = await print(page, each.name);
        for (const printed of pdf.pages) {
          assert.ok(
            Math.abs(printed.width - A4_LANDSCAPE.width) < 1 && Math.abs(printed.height - A4_LANDSCAPE.height) < 1,
            `page ${printed.number} is ${printed.width} × ${printed.height} pt, not A4 landscape`,
          );
        }
        const found = findInOrder(printedText(pdf), titles);
        if (fits) {
          assert.equal(pdf.pages.length, each.slides, 'one page a slide');
          assert.deepEqual(
            found.map((title) => title.page),
            titles.map((_, index) => index + 1),
            'each page holds its own slide’s title',
          );
          assert.deepEqual(inkInMargins(pdf, MARGIN), [], 'ink in the margins');
          assert.deepEqual(overlappingWords(pdf), [], 'words printed over each other');
        } else {
          // What does not fit runs on past its page: the deck prints more
          // pages than it has slides, the defect the overflow check names.
          assert.ok(pdf.pages.length > (each.slides ?? 0), `${pdf.pages.length} pages for ${each.slides} slides`);
        }
        context.diagnostic(`${each.name}: ${titles.length} slides, ${pdf.pages.length} pages`);
      });
    });
  }
});

for (const engine of excluded) {
  test(`${engine}: not run`, {skip: `PAPELERIA_BROWSERS=${process.env['PAPELERIA_BROWSERS'] ?? ''} leaves ${engine} out`}, () => {});
}

for (const engine of run) {
  describe(`decks in print media in ${engine}`, () => {
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

    for (const each of CASES) {
      const expected = each.overflowing ?? [];
      test(`${each.name}: every slide prints, one a page, without the deck's tools; the overflow check names ${expected.length === 0 ? 'none' : `slide ${expected.join(', ')}`}`, TIMEOUT, async (context) => {
        context.diagnostic(`${engine} ${use().version()}`);
        await open(use(), each, async (page) => {
          const overflowing = await overflowingSlides(page);
          const layout = await page.evaluate(() => {
            const display = (selector: string): string[] => Array.from(document.querySelectorAll(selector), (element) => getComputedStyle(element).display);
            return {
              shown: Array.from(document.querySelectorAll('article.deck-slide'), (slide) => slide.getClientRects().length > 0),
              breaks: Array.from(document.querySelectorAll('article.deck-slide'), (slide) => getComputedStyle(slide).breakAfter),
              hidden: [...display('.deck-tools'), ...display('.deck-header'), ...display('.skip-link'), ...display('.slide-notes')],
            };
          });
          assert.equal(layout.shown.length, each.slides);
          assert.ok(layout.shown.every(Boolean), 'every slide prints');
          assert.deepEqual(layout.breaks.slice(0, -1), layout.breaks.slice(0, -1).map(() => 'page'), 'each slide but the last breaks after itself');
          assert.notEqual(layout.breaks[layout.breaks.length - 1], 'page', 'the last slide leaves no blank page');
          assert.deepEqual(layout.hidden, layout.hidden.map(() => 'none'), 'the tools, header, skip link and notes do not print');
          assert.deepEqual(overflowing, expected, 'slides whose content does not fit their printed canvas');
        });
      });
    }
  });
}
