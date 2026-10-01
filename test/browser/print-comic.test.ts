/**
 * M4.5 (IC08, D115): comics in print. The comic case of
 * test/fixtures/print/cases.json, a page whose transcripts run longer than a
 * sheet and then a second page, and the sample comic are built by the
 * compiled CLI with the files the case makes, and served over loopback.
 *
 * The reader is running when the page prints: it steps aside on
 * `beforeprint` and on the print media query, so what prints is the page as
 * published (D115). Chromium prints each to PDF with the page's own `@page`
 * rules, and poppler reads it back (D91):
 *
 * - every page is A4 portrait, nothing prints in the 18 mm margins, no word
 *   is printed over another, nothing numbers the pages;
 * - each comic page starts a printed page with its heading, its art whole on
 *   that page and never taller than 200 mm; its transcript follows and runs
 *   on over the next printed pages, in order, before the next comic page's
 *   art starts a page of its own;
 * - the bar, its status and the book do not print.
 *
 * In all three engines the page is also laid out in print media at the
 * printed text's width: every comic page after the first breaks before, the
 * art is never split and fits a page, the controls and panels are hidden, and
 * the reader has handed every figure back to its sheet. The PDF's reading
 * order and tagging stay A6's human check. `PAPELERIA_PRINT_OUT=<folder>`
 * keeps the PDFs there.
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {after, before, describe, test} from 'node:test';
import {pathToFileURL} from 'node:url';

import type {Browser, Page} from 'playwright';

import {applicationRoot} from '../helpers/paths.js';
import {generatedFiles, readPrintCases, type PrintCase} from '../helpers/print-cases.js';
import {launchEngine, selectedEngines} from './helpers/engines.js';
import {findInOrder, inkInMargins, MM, overlappingWords, pageNumbering, pdfToolsMissing, printedText, readPdf, squash, wordsInSideMargins, type PdfPage, type PrintedPdf} from './helpers/print.js';
import {serveDirectory, type StaticServer} from './helpers/static-server.js';

const TIMEOUT = {timeout: 240_000};
const CLI = join(applicationRoot, 'lib', 'src', 'cli', 'index.js');
const TRANSCRIPT = readPrintCases().comic.find((each) => each.name === 'comic-transcript')!;
/** The sample comic, printed as a second case: eight pages, one after another. */
const SAMPLE: PrintCase = {name: 'sample-comic', piece: 'examples/sample-comic', comicPages: 8, minPages: 8, inOrder: ['The ferry', 'Page 1 of 8', 'Narration: The ferry was late again.', 'Page 8 of 8', 'Page 8, panel 3: the next beat.']};
const CASES = [TRANSCRIPT, SAMPLE];

const A4 = {width: 210 * MM, height: 297 * MM};
const MARGIN = 18 * MM;
const TEXT_WIDTH_PX = Math.floor((174 / 25.4) * 96);
const IMAGE_MAX_PX = (200 / 25.4) * 96;

const workspace = mkdtempSync(join(tmpdir(), 'papeleria-print-comic-'));
const GENERATED = new Set(['dist', '.papeleria']);
let server: StaticServer | undefined;

before(async () => {
  for (const each of CASES) {
    const piece = join(workspace, each.name);
    cpSync(join(applicationRoot, each.piece), piece, {recursive: true, filter: (path) => !GENERATED.has(basename(path))});
    for (const [path, bytes] of Object.entries(await generatedFiles(each))) {
      mkdirSync(dirname(join(piece, path)), {recursive: true});
      writeFileSync(join(piece, path), bytes);
    }
    const built = spawnSync(process.execPath, [CLI, 'build', piece], {encoding: 'utf8'});
    assert.equal(built.status, 0, `papeleria build ${each.name}: ${built.stderr}`);
  }
  server = await serveDirectory(workspace);
}, {timeout: 300_000});

after(async () => {
  await server?.close();
  rmSync(workspace, {recursive: true, force: true});
});

/**
 * Each comic opens from disk, as an author's reader may: print shows the art the reader released from the
 * browser's cache (D115), and the loopback server's `no-store` would forbid that cache. Over a host that
 * forbids caching, the art of pages the reader released would not print; that limit is D115's.
 */
function address(each: PrintCase): string {
  if (server === undefined) {
    throw new Error('the pieces were not built and served');
  }
  return pathToFileURL(join(workspace, each.name, 'dist', 'index.html')).href;
}

/** Opens a case's page with the reader running, fonts loaded, every image in, and fails on any error the page reports. */
async function open(browser: Browser, each: PrintCase, body: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext({viewport: {width: 1280, height: 900}});
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`console error: ${message.text()}`);
    }
  });
  try {
    await page.goto(address(each));
    await page.waitForFunction(() => (window as unknown as {papeleriaReader?: unknown}).papeleriaReader !== undefined);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    // A reader prints some moments after opening: by then every page's art has been fetched once (D115).
    await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLImageElement>('figure.comic-figure img')).every((image) => (image.complete && image.naturalWidth > 0) || image.hasAttribute('data-papeleria-src')), undefined, {timeout: 20_000});
    await body(page);
    assert.deepEqual(errors, [], 'the page reported errors');
  } finally {
    await context.close();
  }
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

/**
 * What would number the printed pages, as pageNumbering reads it (IC08), once
 * the comic's own words about its pages are taken out of each page's text:
 * its headings ("Page 1 of 2") and the transcripts that name a page.
 */
function comicNumbering(pdf: PrintedPdf): string[] {
  const own = [/Page \d+ of \d+/g, /Page \d+, panel \d+:/g, /Page 2 starts on a sheet of its own\./g];
  return pageNumbering({
    ...pdf,
    pages: pdf.pages.map((page) => {
      let text = page.words.map((word) => word.text).join(' ');
      for (const phrase of own) {
        text = text.replace(phrase, ' ');
      }
      return {...page, words: text.split(/\s+/).filter((word) => word !== '').map((word) => ({text: word, xMin: 0, yMin: 0, xMax: 0, yMax: 0}))};
    }),
  });
}

function pageText(page: PdfPage): string {
  return squash(page.words.map((word) => word.text).join(''));
}

function checkPdf(each: PrintCase, pdf: PrintedPdf): string {
  const total = each.comicPages!;
  for (const printed of pdf.pages) {
    assert.ok(Math.abs(printed.width - A4.width) < 1 && Math.abs(printed.height - A4.height) < 1, `page ${printed.number} is ${printed.width} × ${printed.height} pt, not A4 portrait`);
  }
  assert.ok(pdf.pages.length >= (each.minPages ?? total), `${pdf.pages.length} printed pages`);
  assert.deepEqual(wordsInSideMargins(pdf, MARGIN), [], 'words in the side margins');
  assert.deepEqual(inkInMargins(pdf, MARGIN), [], 'ink in the margins');
  assert.deepEqual(overlappingWords(pdf), [], 'words printed over each other');
  // A comic names its own pages ("Page 1 of 2") and its transcripts may too: what numbers printed pages is anything else.
  assert.deepEqual(comicNumbering(pdf), [], 'nothing numbers the printed pages (IC08)');

  const printed = printedText(pdf);
  findInOrder(printed, [...(each.inOrder ?? [])]);
  for (const hidden of ['Previous', 'Guidedview', 'Fullscreen', 'AllpagesareavailablewithoutJavaScript']) {
    assert.ok(!squash(printed.text).includes(squash(hidden)), `"${hidden}" does not print`);
  }

  // Each comic page starts a printed page with its heading (after the register, on the first).
  const headings = Array.from({length: total}, (_, index) => `Page ${index + 1} of ${total}`);
  const starts = findInOrder(printed, headings).map((found) => found.page);
  starts.forEach((start, index) => {
    const text = pageText(pdf.pages[start - 1]!);
    const heading = squash(headings[index]!);
    if (index === 0) {
      assert.ok(text.includes(heading), 'the first comic page is on the first printed page');
    } else {
      assert.ok(text.startsWith(heading), `"${headings[index]}" opens printed page ${start}: ${text.slice(0, 60)}`);
    }
  });
  assert.equal(starts[0], 1);

  // Every page's art prints whole, once, on the page its heading opens, never taller than 200 mm.
  const art = pdf.images.filter((image) => image.printedHeight > 50 * MM);
  assert.equal(art.length, total, `one piece of art per comic page: ${JSON.stringify(pdf.images)}`);
  art.forEach((image, index) => {
    assert.equal(image.page, starts[index], `page ${index + 1}'s art prints on the page its heading opens`);
    assert.ok(image.printedHeight <= 200 * MM + 0.5, `page ${index + 1}'s art is ${(image.printedHeight / MM).toFixed(1)} mm tall`);
  });

  // A transcript runs on before the next comic page starts.
  const runs = starts.map((start, index) => {
    const end = (starts[index + 1] ?? pdf.pages.length + 1) - 1;
    return {start, end};
  });
  return `${each.name}: ${pdf.pages.length} printed pages; comic pages start on ${starts.join(', ')}; transcripts end on ${runs.map((run) => run.end).join(', ')}`;
}

const {run, excluded} = selectedEngines();

describe('comics printed to PDF by Chromium (D91)', {skip: run.includes('chromium') ? pdfToolsMissing() : 'PAPELERIA_BROWSERS leaves Chromium out, and only Chromium prints to PDF'}, () => {
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

  test('no stylesheet a comic links numbers pages or prints in the margins (IC08)', () => {
    for (const each of CASES) {
      const folder = join(workspace, each.name, 'dist', 'theme', 'css');
      for (const name of readdirSync(folder)) {
        const css = readFileSync(join(folder, name), 'utf8');
        assert.doesNotMatch(css, /counter\(\s*pages?\s*\)/, `${each.name}: ${name} numbers pages`);
        assert.doesNotMatch(css, /@(?:top|bottom|left|right)-/, `${each.name}: ${name} has a page margin box`);
      }
    }
  });

  test('comic-transcript: page 1 starts a sheet, its long transcript continues on the next sheets in order, and page 2 starts a sheet of its own', TIMEOUT, async (context) => {
    context.diagnostic(`chromium ${use().version()}`);
    await open(use(), TRANSCRIPT, async (page) => {
      const pdf = await print(page, TRANSCRIPT.name);
      context.diagnostic(checkPdf(TRANSCRIPT, pdf));
      const printed = printedText(pdf);
      // Every sentence of every panel of page 1, in order.
      const sentences = Array.from({length: 8}, (_, panel) => Array.from({length: 20}, (__, sentence) => `Panel ${panel + 1} transcript sentence ${String(sentence + 1).padStart(2, '0')} continues`)).flat();
      const found = findInOrder(printed, sentences);
      const [second] = findInOrder(printed, ['Page 2 of 2']);
      const lastSentencePage = found.at(-1)!.page;
      assert.ok(lastSentencePage > found[0]!.page, `page 1's transcript runs over printed pages ${found[0]!.page}–${lastSentencePage}`);
      assert.ok(second!.page > lastSentencePage, 'page 2 starts after the transcript has finished');
      assert.ok(pageText(pdf.pages[second!.page - 1]!).startsWith(squash('Page 2 of 2')), 'on a sheet of its own');
      context.diagnostic(`the transcript runs from printed page ${found[0]!.page} to ${lastSentencePage}; page 2 opens printed page ${second!.page}`);
    });
  });

  test('the sample comic: eight comic pages, eight printed pages starting with each, art whole on each', TIMEOUT, async (context) => {
    await open(use(), SAMPLE, async (page) => {
      // The reader was on a spread and in guided view: print still gets every page as published.
      await page.evaluate(() => (window as unknown as {papeleriaReader: {enterGuided(page: number, panel: number): void}}).papeleriaReader.enterGuided(4, 2));
      const pdf = await print(page, SAMPLE.name);
      context.diagnostic(checkPdf(SAMPLE, pdf));
      await page.waitForFunction(() => (window as unknown as {papeleriaReader: {view: string}}).papeleriaReader.view === 'guided' && document.body.classList.contains('comic-enhanced'));
    });
  });
});

type PrintLayout = {
  enhanced: boolean;
  inBook: number;
  sheetBreaks: string[];
  figureBreaks: string[];
  hidden: {tools: string; book: string; panels: string[]; skipLink: string};
  transcripts: string[];
  images: {height: number; complete: boolean}[];
  scrollWidth: number;
  clientWidth: number;
};

function printLayout(page: Page): Promise<PrintLayout> {
  return page.evaluate(() => {
    const style = (element: Element): CSSStyleDeclaration => getComputedStyle(element);
    return {
      enhanced: document.body.classList.contains('comic-enhanced'),
      inBook: document.querySelectorAll('.comic-book figure').length,
      sheetBreaks: Array.from(document.querySelectorAll('article.comic-sheet'), (sheet) => style(sheet).breakBefore),
      figureBreaks: Array.from(document.querySelectorAll('figure.comic-figure'), (figure) => style(figure).breakInside),
      hidden: {
        tools: style(document.getElementById('comic-tools')!).display,
        book: style(document.getElementById('comic-book')!).display,
        panels: [...new Set(Array.from(document.querySelectorAll('.comic-panel'), (panel) => style(panel).display))],
        skipLink: style(document.querySelector('.skip-link')!).display,
      },
      transcripts: Array.from(document.querySelectorAll('.comic-transcript'), (transcript) => style(transcript).display),
      images: Array.from(document.querySelectorAll<HTMLImageElement>('article.comic-sheet img')).map((image) => ({height: image.getBoundingClientRect().height, complete: image.complete})),
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  });
}

for (const engine of excluded) {
  test(`${engine}: not run`, {skip: `PAPELERIA_BROWSERS=${process.env['PAPELERIA_BROWSERS'] ?? ''} leaves ${engine} out`}, () => {});
}

for (const engine of run) {
  describe(`comics in print media in ${engine}`, () => {
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
      test(`${each.name}: the reader steps aside, every comic page after the first breaks before, art whole and within a page, controls hidden`, TIMEOUT, async (context) => {
        context.diagnostic(`${engine} ${use().version()}`);
        await open(use(), each, async (page) => {
          await page.setViewportSize({width: TEXT_WIDTH_PX, height: 900});
          await page.emulateMedia({media: 'print'});
          await page.waitForFunction(() => !document.body.classList.contains('comic-enhanced'));
          await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLImageElement>('article.comic-sheet img')).every((image) => image.complete));
          const layout = await printLayout(page);
          assert.deepEqual([layout.enhanced, layout.inBook], [false, 0], 'every figure is back in its sheet');
          assert.equal(layout.sheetBreaks.length, each.comicPages);
          assert.notEqual(layout.sheetBreaks[0], 'page');
          assert.deepEqual(layout.sheetBreaks.slice(1), layout.sheetBreaks.slice(1).map(() => 'page'), 'every later comic page starts a printed page');
          assert.deepEqual(layout.figureBreaks, layout.figureBreaks.map(() => 'avoid'), 'no art is split');
          assert.deepEqual(layout.hidden, {tools: 'none', book: 'none', panels: ['none'], skipLink: 'none'});
          assert.deepEqual(layout.transcripts, layout.transcripts.map(() => 'block'), 'the transcripts print');
          for (const image of layout.images) {
            assert.ok(image.complete && image.height > 0 && image.height <= IMAGE_MAX_PX + 0.5, `an image ${image.height.toFixed(1)} px tall in print`);
          }
          assert.ok(layout.scrollWidth <= layout.clientWidth, `the page is ${layout.scrollWidth} px wide in ${layout.clientWidth} px`);
          await page.emulateMedia({media: 'screen'});
          await page.waitForFunction(() => document.body.classList.contains('comic-enhanced'));
        });
      });
    }
  });
}
