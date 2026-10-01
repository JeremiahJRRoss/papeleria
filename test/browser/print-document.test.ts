/**
 * M3.5 (IC08, D98): documents in print. Each document case of
 * test/fixtures/print/cases.json is built by the compiled CLI on a temporary
 * copy, with the files the case makes, and served over loopback.
 *
 * Chromium prints each to PDF with the page's own `@page` rules, tagged, and
 * poppler reads it back (D91):
 *
 * - every page is A4 portrait, and nothing prints in the 18 mm margins;
 * - every word prints once where it belongs: the case's text, in order, with
 *   no two words printed over each other;
 * - each logical sheet starts a page with the sheet's header, a `new_page`
 *   section starts one, and the status closes each sheet; nothing prints a
 *   page number or a count of pages (IC08 leaves that to the browser);
 * - the tag tree holds the takeaway as H1 and the section headings as H2, in
 *   order;
 * - a table over several pages repeats its header on each, and a row taller
 *   than a page splits without losing a line; a tall image prints whole on
 *   one page with its caption; a video prints as its poster, with its
 *   alternative beneath.
 *
 * Firefox and WebKit cannot print to PDF under Playwright, so in all three
 * engines the page is also laid out in print media at the printed text's
 * width, 174 mm: the sheets after the first break before; the skip link and
 * the player are hidden and the video's print poster is shown, loaded, above
 * its alternative; headings keep with what follows; paragraphs keep three
 * lines each side of a break, where the engine has orphans and widows (Firefox
 * has neither); table headers are header groups, so they repeat; nothing is
 * wider than the text; no image is taller than 200 mm, so none is cut.
 *
 * The reading order and tagging of the PDF are also judged by a person (A6),
 * which stays pending. `PAPELERIA_PRINT_OUT=<folder>` keeps the PDFs there
 * for that session.
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {after, before, describe, test} from 'node:test';

import type {Browser, Page} from 'playwright';

import {applicationRoot} from '../helpers/paths.js';
import {generatedFiles, readPrintCases, type PrintCase} from '../helpers/print-cases.js';
import {launchEngine, selectedEngines} from './helpers/engines.js';
import {
  countPrinted,
  findInOrder,
  inkInMargins,
  lastLine,
  MM,
  overlappingWords,
  pageNumbering,
  pdfToolsMissing,
  printedText,
  readPdf,
  squash,
  structureNodes,
  wordsInSideMargins,
  type PdfPage,
  type PdfWord,
  type PrintedPdf,
} from './helpers/print.js';
import {serveDirectory, type StaticServer} from './helpers/static-server.js';

const TIMEOUT = {timeout: 180_000};
const CLI = join(applicationRoot, 'lib', 'src', 'cli', 'index.js');
const CASES = readPrintCases().document;

/** The document's page: A4 portrait with 18 mm margins (print.css). */
const A4 = {width: 210 * MM, height: 297 * MM};
const MARGIN = 18 * MM;
/** The printed text's width, 210 mm less both margins, in CSS pixels. */
const TEXT_WIDTH_PX = Math.floor((174 / 25.4) * 96);
/** The tallest an image prints (base.css), in CSS pixels. */
const IMAGE_MAX_PX = (200 / 25.4) * 96;

const workspace = mkdtempSync(join(tmpdir(), 'papeleria-print-document-'));
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
}, TIMEOUT);

after(async () => {
  await server?.close();
  rmSync(workspace, {recursive: true, force: true});
});

function address(each: PrintCase): string {
  if (server === undefined) {
    throw new Error('the pieces were not built and served');
  }
  return `${server.origin}/${each.name}/dist/index.html`;
}

/** Opens a case's page, fonts loaded, and fails on any error the page reports. */
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
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await body(page);
    assert.deepEqual(errors, [], 'the page reported errors');
  } finally {
    await context.close();
  }
}

/** What the page says it holds, to hold the PDF to. */
type Written = {title: string; headings: string[]; status: string; footer: string; sheets: number};

function written(page: Page): Promise<Written> {
  return page.evaluate(() => {
    const text = (element: Element | null): string => (element?.textContent ?? '').trim();
    const footer = document.querySelector('.template-footer');
    return {
      title: text(document.querySelector('h1')),
      headings: Array.from(document.querySelectorAll('.doc-section > h2'), text),
      status: text(document.querySelector('.doc-status')),
      footer: footer === null ? '' : Array.from(footer.children, text).join(''),
      sheets: document.querySelectorAll('article.template-page').length,
    };
  });
}

const keep = process.env['PAPELERIA_PRINT_OUT'];

/** Prints the open page as a person would save it as PDF: the page's own size and margins, no background graphics. */
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
 * The sheet header's words, when the page opens a sheet: the wordmark is its
 * first and topmost word, and the header is every word beside it.
 */
function sheetHeader(page: PdfPage): PdfWord[] | undefined {
  const first = page.words[0];
  if (first?.text !== 'papeleria' || page.words.some((word) => word.yMin < first.yMin - 0.5)) {
    return undefined;
  }
  return page.words.filter((word) => (word.yMin + word.yMax) / 2 <= first.yMax);
}

/** A page's text after its sheet header, squashed. */
function bodyText(page: PdfPage): string {
  const header = new Set(sheetHeader(page) ?? []);
  return squash(page.words.filter((word) => !header.has(word)).map((word) => word.text).join(''));
}

function paragraphsOf(each: PrintCase): string[] {
  if (each.inOrderFile === undefined) {
    return [...(each.inOrder ?? [])];
  }
  return readFileSync(join(applicationRoot, each.piece, each.inOrderFile), 'utf8')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '');
}

function checkPdf(each: PrintCase, pdf: PrintedPdf, page: Written): string {
  // A4 portrait, never fewer pages than sheets.
  for (const printedPage of pdf.pages) {
    assert.ok(
      Math.abs(printedPage.width - A4.width) < 1 && Math.abs(printedPage.height - A4.height) < 1,
      `page ${printedPage.number} is ${printedPage.width} × ${printedPage.height} pt, not A4 portrait`,
    );
  }
  assert.ok(pdf.pages.length >= (each.minPages ?? each.sheets ?? 1), `${pdf.pages.length} pages`);

  // Nothing in the margins, no word printed over another.
  assert.deepEqual(wordsInSideMargins(pdf, MARGIN), [], 'words in the side margins');
  assert.deepEqual(inkInMargins(pdf, MARGIN), [], 'ink in the margins');
  assert.deepEqual(overlappingWords(pdf), [], 'words printed over each other');

  // The text, in order.
  const printed = printedText(pdf);
  findInOrder(printed, paragraphsOf(each));
  findInOrder(printed, [page.title, ...page.headings]);

  // Each sheet starts a page with the sheet's header, and a new_page section
  // is the first thing on its sheet after it.
  assert.equal(page.sheets, each.sheets, 'logical sheets on the page');
  const starts = pdf.pages.flatMap((printedPage) => (sheetHeader(printedPage) === undefined ? [] : [printedPage.number]));
  assert.equal(starts.length, each.sheets, `pages starting a sheet: ${starts.join(', ')}`);
  assert.equal(starts[0], 1);
  for (const phrase of each.startsSheet ?? []) {
    assert.ok(
      starts.slice(1).some((start) => bodyText(pdf.pages[start - 1]!).startsWith(squash(phrase))),
      `"${phrase}" opens a sheet after the first`,
    );
  }

  // The footer and the status close each sheet: nothing prints below them
  // before the next sheet. The status prints once more, under the header of
  // page 1; no page is numbered.
  starts.forEach((start, index) => {
    const last = pdf.pages[(index + 1 < starts.length ? starts[index + 1]! - 1 : pdf.pages.length) - 1]!;
    assert.equal(lastLine(last), squash(page.footer), `sheet ${index + 1}, from page ${start}, closes on page ${last.number} with "${page.footer}"`);
  });
  assert.equal(countPrinted(printed, page.status), each.sheets! + 1, `"${page.status}" under the first header and closing each sheet`);
  assert.deepEqual(pageNumbering(pdf), [], 'nothing numbers the printed pages (IC08)');

  // Tagged, with the takeaway and the section headings as headings, in
  // order. The H1 holds the takeaway's text in order, but may lack what
  // inline markup wraps: in Chromium 153's tag tree every-block's H1 read
  // "The <b>stays</b> text.", without its emphasized word, which Chromium 141
  // keeps inside. How the tags read is A6's human check.
  assert.ok(pdf.tagged, 'the PDF is tagged');
  const nodes = structureNodes(pdf.structure);
  const headings = nodes.filter((node) => node.type === 'H1').map((node) => squash(node.text));
  assert.equal(headings.length, 1, 'one H1');
  assert.ok(headings[0] !== '' && inOrderWithin(headings[0]!, squash(page.title)), `the H1, "${headings[0]}", is the takeaway, "${page.title}"`);
  assert.deepEqual(
    nodes.filter((node) => node.type === 'H2').map((node) => squash(node.text)),
    page.headings.map(squash),
    'H2s are the section headings, in order',
  );

  // No image drawn on more than one page: none is cut.
  const pagesOf = new Map<string, Set<number>>();
  for (const image of pdf.images) {
    pagesOf.set(image.object, (pagesOf.get(image.object) ?? new Set()).add(image.page));
  }
  for (const [object, pages] of pagesOf) {
    assert.equal(pages.size, 1, `image ${object} prints on pages ${[...pages].join(', ')}`);
  }
  return `${each.name}: ${pdf.pages.length} pages, ${each.sheets} sheets starting on ${starts.join(', ')}, ${pdf.images.length} images; the tag tree's H1 reads "${headings[0]}"`;
}

/** Whether every character of `part` appears in `whole`, in order. */
function inOrderWithin(part: string, whole: string): boolean {
  let at = 0;
  for (const character of part) {
    at = whole.indexOf(character, at);
    if (at === -1) {
      return false;
    }
    at += character.length;
  }
  return true;
}

function checkTable(each: PrintCase, pdf: PrintedPdf): void {
  const table = each.table!;
  const rowId = /^R\d{3}$/;
  const withRows = pdf.pages.filter((page) => page.words.some((word) => rowId.test(word.text)));
  const [first, last] = [withRows[0]!, withRows[withRows.length - 1]!];
  assert.ok(last.number - first.number + 1 >= 3, `the table prints over pages ${first.number}–${last.number}`);
  // Its header prints above its first row, then opens every page it continues on,
  // a page holding only the rest of the tall row included.
  const header = squash(table.header.join(''));
  const firstRow = first.words.findIndex((word) => rowId.test(word.text));
  assert.ok(squash(first.words.slice(0, firstRow).map((word) => word.text).join('')).endsWith(header), `page ${first.number}: the header prints above the first row`);
  for (const page of pdf.pages.slice(first.number, last.number)) {
    assert.ok(squash(page.words.map((word) => word.text).join('')).startsWith(header), `page ${page.number} opens with the table's header`);
  }
  const ids = pdf.pages.flatMap((page) => page.words.filter((word) => rowId.test(word.text)).map((word) => word.text));
  assert.deepEqual(ids, Array.from({length: table.rowIds}, (_, index) => `R${String(index + 1).padStart(3, '0')}`), 'every row once, in order');
  const lines = findInOrder(
    printedText(pdf),
    Array.from({length: table.tallRowLines}, (_, index) => `${table.tallRow} ${String(index + 1).padStart(3, '0')}`),
  );
  assert.ok(new Set(lines.map((line) => line.page)).size >= 2, 'the row taller than a page continues on the next');
  // No column squeezed to single letters: every "Item NNN" prints its word whole.
  assert.equal(pdf.pages.flatMap((page) => page.words).filter((word) => word.text === 'Item').length, table.rowIds);
}

function checkTallImage(each: PrintCase, pdf: PrintedPdf): string {
  const tall = each.tallImage!;
  const drawn = pdf.images.filter((image) => Math.abs(image.height / image.width - tall.height / tall.width) < 0.01);
  assert.equal(drawn.length, 1, 'the tall image is drawn once');
  const image = drawn[0]!;
  assert.ok(image.printedHeight <= 200 * MM + 0.5, `it prints ${(image.printedHeight / MM).toFixed(1)} mm tall`);
  const [caption] = findInOrder(printedText(pdf), [tall.caption]);
  assert.equal(caption?.page, image.page, 'its caption prints on its page');
  return `tall image ${image.width} × ${image.height} px printed ${(image.printedWidth / MM).toFixed(1)} × ${(image.printedHeight / MM).toFixed(1)} mm on page ${image.page}`;
}

function checkVideo(each: PrintCase, pdf: PrintedPdf): string {
  const video = each.video!;
  const [alternative] = findInOrder(printedText(pdf), [video.alternative]);
  const posters = pdf.images.filter((image) => image.width === video.poster[0] && image.height === video.poster[1]);
  assert.equal(posters.length, 1, `the poster, ${video.poster.join(' × ')} px, prints once: ${JSON.stringify(pdf.images)}`);
  assert.equal(posters[0]!.page, alternative?.page, 'the alternative prints with its poster');
  return `video poster printed ${(posters[0]!.printedWidth / MM).toFixed(1)} mm wide on page ${posters[0]!.page}`;
}

const {run, excluded} = selectedEngines();

describe('documents printed to PDF by Chromium (D91)', {skip: run.includes('chromium') ? pdfToolsMissing() : 'PAPELERIA_BROWSERS leaves Chromium out, and only Chromium prints to PDF'}, () => {
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

  test('no stylesheet a document links numbers pages or prints in the margins (IC08)', () => {
    for (const each of CASES) {
      const folder = join(workspace, each.name, 'dist', 'theme', 'css');
      for (const name of readdirSync(folder)) {
        const css = readFileSync(join(folder, name), 'utf8');
        assert.doesNotMatch(css, /counter\(\s*pages?\s*\)/, `${each.name}: ${name} numbers pages`);
        assert.doesNotMatch(css, /@(?:top|bottom|left|right)-/, `${each.name}: ${name} has a page margin box`);
      }
    }
  });

  for (const each of CASES) {
    test(`${each.name}: A4 portrait, nothing in the margins, every word in order, each sheet a new page, the status closing it`, TIMEOUT, async (context) => {
      context.diagnostic(`chromium ${use().version()}`);
      await open(use(), each, async (page) => {
        const facts = await written(page);
        const pdf = await print(page, each.name);
        context.diagnostic(checkPdf(each, pdf, facts));
        if (each.table !== undefined) {
          checkTable(each, pdf);
        }
        if (each.tallImage !== undefined) {
          context.diagnostic(checkTallImage(each, pdf));
        }
        if (each.video !== undefined) {
          context.diagnostic(checkVideo(each, pdf));
        }
      });
    });
  }
});

/** The page laid out in print media, as the checks below read it. */
type PrintLayout = {
  sheetBreaks: string[];
  skipLink: string;
  headingBreaks: string[];
  /** Each paragraph's `orphans` and `widows`, where the engine has the properties at all. */
  paragraphLines: {supported: boolean; values: string[]};
  headerGroups: string[];
  scrollWidth: number;
  clientWidth: number;
  wider: string[];
  overflowingCells: string[];
  images: {src: string; height: number}[];
  videos: string[];
  posters: {display: string; loaded: boolean; bottom: number; alternativeTop: number}[];
};

function printLayout(page: Page): Promise<PrintLayout> {
  return page.evaluate(() => {
    const style = (element: Element): CSSStyleDeclaration => getComputedStyle(element);
    const shown = (element: Element): boolean => element.getClientRects().length > 0;
    const width = document.documentElement.clientWidth;
    const name = (element: Element): string => `${element.tagName.toLowerCase()}${element.className === '' || typeof element.className !== 'string' ? '' : `.${element.className.split(' ').join('.')}`}`;
    return {
      sheetBreaks: Array.from(document.querySelectorAll('article.template-page'), (sheet) => style(sheet).breakBefore),
      skipLink: style(document.querySelector('.skip-link')!).display,
      headingBreaks: Array.from(document.querySelectorAll('.document-body h1, .document-body h2, .document-body h3'), (heading) => style(heading).breakAfter),
      paragraphLines: {
        supported: CSS.supports('orphans', '3') && CSS.supports('widows', '3'),
        values: Array.from(document.querySelectorAll('.document-body p'), (paragraph) => `${style(paragraph).getPropertyValue('orphans')} ${style(paragraph).getPropertyValue('widows')}`),
      },
      headerGroups: Array.from(document.querySelectorAll('thead'), (head) => style(head).display),
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: width,
      wider: Array.from(document.querySelectorAll('body *'))
        .filter((element) => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && (box.right > width + 1 || box.left < -1);
        })
        .map(name),
      overflowingCells: Array.from(document.querySelectorAll('th, td'))
        .filter((cell) => cell.scrollWidth > cell.clientWidth + 1)
        .map((cell) => (cell.textContent ?? '').slice(0, 40)),
      images: Array.from(document.querySelectorAll('img'))
        .filter(shown)
        .map((image) => ({src: image.currentSrc || image.src, height: image.getBoundingClientRect().height})),
      videos: Array.from(document.querySelectorAll('video'), (video) => style(video).display),
      posters: Array.from(document.querySelectorAll('.video-figure'), (figure) => {
        const poster = figure.querySelector<HTMLImageElement>('.video-print-poster')!;
        return {
          display: style(poster).display,
          loaded: poster.complete && poster.naturalWidth > 0,
          bottom: poster.getBoundingClientRect().bottom,
          alternativeTop: figure.querySelector('.video-alt')!.getBoundingClientRect().top,
        };
      }),
    };
  });
}

for (const engine of excluded) {
  test(`${engine}: not run`, {skip: `PAPELERIA_BROWSERS=${process.env['PAPELERIA_BROWSERS'] ?? ''} leaves ${engine} out`}, () => {});
}

for (const engine of run) {
  describe(`documents in print media in ${engine}`, () => {
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
      test(`${each.name}: sheets break, headings keep with their text, paragraphs keep three lines, headers repeat, nothing wider than the text or taller than a page`, TIMEOUT, async (context) => {
        context.diagnostic(`${engine} ${use().version()}`);
        await open(use(), each, async (page) => {
          await page.setViewportSize({width: TEXT_WIDTH_PX, height: 900});
          await page.emulateMedia({media: 'print'});
          const layout = await printLayout(page);
          assert.equal(layout.sheetBreaks.length, each.sheets);
          assert.notEqual(layout.sheetBreaks[0], 'page', 'the first sheet does not break before');
          assert.deepEqual(layout.sheetBreaks.slice(1), layout.sheetBreaks.slice(1).map(() => 'page'), 'every later sheet starts a page');
          assert.equal(layout.skipLink, 'none', 'the skip link does not print');
          assert.deepEqual(layout.headingBreaks, layout.headingBreaks.map(() => 'avoid'), 'no break after a heading');
          // IC08: paragraphs use three-line widow and orphan targets (print.css).
          if (layout.paragraphLines.supported) {
            assert.ok(layout.paragraphLines.values.length > 0, 'paragraphs to judge');
            assert.deepEqual(layout.paragraphLines.values, layout.paragraphLines.values.map(() => '3 3'), 'every paragraph keeps three lines together each side of a break');
          } else {
            // Firefox has never implemented orphans and widows (Mozilla bug 137367); print.css asks all the same.
            assert.equal(engine, 'firefox', `${engine} does not support orphans and widows`);
            context.diagnostic(`${engine} has no orphans or widows`);
          }
          assert.deepEqual(layout.headerGroups, layout.headerGroups.map(() => 'table-header-group'), 'table headers repeat on each page');
          assert.ok(layout.scrollWidth <= layout.clientWidth, `the page is ${layout.scrollWidth} px wide in ${layout.clientWidth} px`);
          assert.deepEqual(layout.wider, [], 'elements wider than the printed text');
          assert.deepEqual(layout.overflowingCells, [], 'cells whose text overflows them');
          for (const image of layout.images) {
            assert.ok(image.height <= IMAGE_MAX_PX + 0.5, `${image.src} is ${image.height.toFixed(1)} px tall in print`);
          }
          assert.deepEqual(layout.videos, layout.videos.map(() => 'none'), 'no player prints');
          for (const poster of layout.posters) {
            assert.equal(poster.display, 'block', 'the print poster shows');
            assert.ok(poster.loaded, 'the print poster has loaded');
            assert.ok(poster.bottom <= poster.alternativeTop + 0.5, 'the alternative is beneath the poster');
          }
          assert.equal(layout.posters.length, each.video === undefined ? 0 : 1);
        });
      });
    }
  });
}
