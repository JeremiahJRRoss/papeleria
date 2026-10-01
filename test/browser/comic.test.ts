/**
 * M4.3 and M4.5 (A5): the comic reader in Chromium, Firefox and WebKit.
 *
 * Two comics are built with the compiled CLI when the suite starts
 * (helpers/comic-fixture.ts): the sample comic, eight pages of 26 panels, and
 * the reader fixture, five pages with every detail kind, a page without
 * panels and SVG pages. Both are served from a loopback server; the file://
 * cases open the same dist/ from disk.
 *
 * A5, at 390×844, 834×1112 and 1280×800: the cover alone, then pairs and the
 * final page alone where a spread fits, one page where it does not; turns by
 * button and key with the address and status following; the preload window;
 * guided steps across pages, a page without panels as one step, and the lens
 * showing the box with 4% around it; panels opening their details, a text
 * detail's headings a level higher in the dialog (W5R-19), a panel without
 * one announcing its transcript, link panels; resize keeping the
 * logical page; the transcript toggle; the page without JavaScript.
 *
 * The reader's contract besides (CONTRACT.md §5): the address and its
 * corrections, gestures and what never turns a page, full screen, file://,
 * requests (C22, C24), the hook the preview bridge uses (§6), and a start or a
 * resume with no room for the book, which changes nothing (W5R-18). The DEP05
 * items are confirmed again on the real reader, as D103 asks of a change
 * built on the adapter. Reduced motion is test/browser/motion.test.ts and
 * accessibility test/browser/comic-a11y.test.ts.
 */
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {after, before, describe, test} from 'node:test';

import type {Browser, Page} from 'playwright';

import type {PageChangeDetail} from '../../templates/comic/client/reader-logic.js';
import {applicationRoot} from '../helpers/paths.js';
import {
  buildComics,
  ENGINE_TRAP,
  engineCalls,
  expectedLayout,
  fileUrl,
  readReader,
  VIEWPORTS,
  viewportLabel,
  waitForPages,
  withComic,
  type BuiltComics,
  type OpenOptions,
  type Viewport,
} from './helpers/comic-fixture.js';
import {launchEngine, selectedEngines, type EngineName} from './helpers/engines.js';
import {dispatchSwipe} from './helpers/gestures.js';
import {serveDirectory, type StaticServer} from './helpers/static-server.js';

const TIMEOUT = {timeout: 180_000};
const EN = JSON.parse(readFileSync(join(applicationRoot, 'templates', 'shared', 'strings.en.json'), 'utf8')) as Record<string, string>;

/** Fills a template with split and join, a different mechanism from the reader's. */
function fill(template: string | undefined, values: Readonly<Record<string, string | number>>): string {
  let text = template ?? '';
  for (const [name, value] of Object.entries(values)) {
    text = text.split(`{${name}}`).join(String(value));
  }
  return text;
}

function pagesStatus(visible: readonly number[], total: number): string {
  return visible.length === 1 ? fill(EN['page_of'], {n: visible[0]!, total}) : fill(EN['pages_of'], {a: visible[0]!, b: visible[1]!, total});
}

function panelStatus(panel: number, panels: number, page: number): string {
  return fill(EN['panel_of'], {n: panel, total: panels, page});
}

/** The sample's panels per page, from its manifest: five on page 1, three on each of the others. */
const SAMPLE_PANELS = [5, 3, 3, 3, 3, 3, 3, 3];

/** The hint for `n` panels shown: `panels_hint_one` for exactly one (D130), which the sample's pages never hold alone. */
function hintFor(n: number): string {
  return fill(n === 1 ? EN['panels_hint_one'] : EN['panels_hint'], {n});
}
/** The sample's panel boxes on page 1, from its manifest. */
const SAMPLE_PAGE_1_BOXES: readonly (readonly [number, number, number, number])[] = [
  [4, 4, 56, 28],
  [64, 4, 32, 28],
  [4, 36, 92, 26],
  [4, 66, 44, 30],
  [52, 66, 44, 30],
];

/** What the spreads are, written out: one page, or the cover alone, pairs and a last page alone. */
function spreads(total: number, layout: 'single' | 'spread'): number[][] {
  if (layout === 'single') {
    return Array.from({length: total}, (_, index) => [index + 1]);
  }
  const result: number[][] = [[1]];
  for (let first = 2; first <= total; first += 2) {
    result.push(first + 1 <= total ? [first, first + 1] : [first]);
  }
  return result;
}

const workspace = mkdtempSync(join(tmpdir(), 'papeleria-comic-'));
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

function served(): StaticServer {
  if (server === undefined) {
    throw new Error('the comics were not built and served');
  }
  return server;
}

function built(): BuiltComics {
  if (comics === undefined) {
    throw new Error('the comics were not built');
  }
  return comics;
}

const sampleUrl = (hash = ''): string => `${served().origin}/sample/dist/index.html${hash}`;
const readerUrl = (hash = ''): string => `${served().origin}/reader/dist/index.html${hash}`;

/** Records every pagechange in `window.pageChanges`, from a listener added before the reader starts. */
const RECORD_CHANGES = `(() => {
  window.pageChanges = [];
  document.addEventListener('pagechange', (event) => window.pageChanges.push(event.detail));
})();`;

function pageChanges(page: Page): Promise<PageChangeDetail[]> {
  return page.evaluate(() => [...(window as unknown as {pageChanges: PageChangeDetail[]}).pageChanges]);
}

/** Clicks a control and waits for the reader to show `visible`. */
async function press(page: Page, selector: string, visible: readonly number[]): Promise<void> {
  await page.click(selector);
  await waitForPages(page, visible);
}

async function key(page: Page, name: string, visible: readonly number[]): Promise<void> {
  await page.keyboard.press(name);
  await waitForPages(page, visible);
}

async function changeHash(page: Page, hash: string): Promise<void> {
  await page.evaluate((next) => {
    location.hash = next;
  }, hash);
}

/** The key that moves focus to the next link: WebKit on macOS moves it only between form controls with Tab alone. */
function tabKey(engine: EngineName): string {
  return engine === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab';
}

type Rect = {readonly left: number; readonly top: number; readonly width: number; readonly height: number};

function rectOf(page: Page, selector: string): Promise<Rect> {
  return page.evaluate((target) => {
    const rect = document.querySelector(target)!.getBoundingClientRect();
    return {left: rect.left, top: rect.top, width: rect.width, height: rect.height};
  }, selector);
}

const {run, excluded} = selectedEngines();

for (const engine of excluded) {
  test(`${engine}: not run`, {skip: `PAPELERIA_BROWSERS=${process.env['PAPELERIA_BROWSERS'] ?? ''} leaves ${engine} out`}, () => {});
}

for (const engine of run) {
  describe(`comic reader in ${engine}`, () => {
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
    const open = (url: string, options: OpenOptions, body: Parameters<typeof withComic>[3]): Promise<void> => withComic(use(), url, options, body);
    const at = (viewport: Viewport, extra: OpenOptions = {}): OpenOptions => ({...extra, context: {viewport, ...extra.context}});

    test('launches', TIMEOUT, (context) => {
      context.diagnostic(`${engine} ${use().version()}`);
    });

    test('A5: the cover alone, then pairs and the last page alone where a spread fits; buttons and keys turn; the address and status follow', TIMEOUT, async (context) => {
      for (const viewport of VIEWPORTS) {
        const layout = expectedLayout(viewport);
        const all = spreads(8, layout);
        await open(sampleUrl(), at(viewport), async ({page}) => {
          const entries = await page.evaluate(() => history.length);
          let state = await readReader(page);
          assert.deepEqual(
            {enhanced: state.enhanced, page: state.page, view: state.view, layout: state.layout, visible: state.visible, shown: state.shown, hash: state.hash, focus: state.focus},
            {enhanced: true, page: 1, view: 'page', layout, visible: [1], shown: [1], hash: '', focus: 'body'},
            `${viewportLabel(viewport)}: the start`,
          );
          assert.equal(state.status, pagesStatus([1], 8));
          assert.equal(state.hint, hintFor(5));
          assert.deepEqual(state.disabled, {previous: true, next: false});
          assert.deepEqual([state.guidedLabel, state.detailHidden, state.sheets], [EN['guided_view'], true, [1]]);

          for (const visible of all.slice(1)) {
            await press(page, '#comic-next', visible);
            state = await readReader(page);
            assert.equal(state.status, pagesStatus(visible, 8), `${viewportLabel(viewport)}: status at ${visible.join('–')}`);
            assert.equal(state.hash, `#page-${visible[0]}`);
            assert.deepEqual(state.sheets, visible, 'the sheets under the book are the pages shown');
            assert.equal(state.hint, hintFor(visible.reduce((sum, number) => sum + SAMPLE_PANELS[number - 1]!, 0)));
          }
          assert.deepEqual(state.disabled, {previous: false, next: true}, 'Next is disabled at the end');
          assert.deepEqual(state.visible, [8], 'the last page alone, in either layout');
          await page.focus('#comic-book');
          for (const visible of [...all].reverse().slice(1)) {
            await key(page, 'ArrowLeft', visible);
          }
          assert.deepEqual((await readReader(page)).disabled, {previous: true, next: false});
          await key(page, 'End', all.at(-1)!);
          await key(page, 'Home', [1]);
          await key(page, 'ArrowRight', all[1]!);
          assert.equal(await page.evaluate(() => history.length), entries, 'the address is replaced, never pushed');
          context.diagnostic(`${engine} ${viewportLabel(viewport)}: ${layout}, spreads ${all.map((each) => each.join('–')).join(' ')}`);
        });
      }
    });

    test('A5 and DEP05: only the spreads shown, before and after keep their image sources; a loaded page outside lets its go, keeping its size and element', TIMEOUT, async () => {
      for (const viewport of VIEWPORTS) {
        const layout = expectedLayout(viewport);
        await open(sampleUrl(), at(viewport, {context: {reducedMotion: 'reduce'}}), async ({page}) => {
          type Image = {page: number; src: boolean; kept: boolean; loaded: boolean; lazy: boolean; size: string; sources: boolean};
          const images = (): Promise<Image[]> =>
            page.evaluate(() =>
              Array.from(document.querySelectorAll<HTMLImageElement>('figure.comic-figure img')).map((image) => ({
                page: Number(image.closest<HTMLElement>('figure')!.dataset['page']),
                src: image.hasAttribute('src'),
                kept: image.hasAttribute('data-papeleria-src'),
                loaded: image.hasAttribute('src') && image.complete && image.naturalWidth > 0,
                lazy: image.loading === 'lazy',
                size: `${image.getAttribute('width')}×${image.getAttribute('height')}`,
                sources: Array.from(image.parentElement?.querySelectorAll('source') ?? []).every((source) => source.hasAttribute('srcset') !== source.hasAttribute('data-papeleria-srcset')),
              })),
            );
          /** The window's images load (they are eager); then a turn lets the loaded ones outside it go. */
          const settle = (): Promise<unknown> =>
            page.waitForFunction(() =>
              Array.from(document.querySelectorAll<HTMLImageElement>('figure.comic-figure img[src]'))
                .filter((image) => image.loading !== 'lazy')
                .every((image) => image.complete),
            );
          await page.evaluate(() => {
            document.querySelectorAll<HTMLImageElement>('figure.comic-figure img').forEach((image, index) => {
              (image as unknown as {papeleriaMark: number}).papeleriaMark = index + 1;
            });
          });
          const expectWindow = async (window: readonly number[], released: readonly number[], where: string): Promise<void> => {
            const now = await images();
            for (const image of now) {
              const label = `${viewportLabel(viewport)} ${where}: page ${image.page}`;
              assert.ok(image.size === '1600×2200' && image.sources, `${label} keeps its size, its sources released with it`);
              if (window.includes(image.page)) {
                assert.ok(image.src && !image.kept && !image.lazy, `${label} is in the window: its source, loading now`);
              } else if (released.includes(image.page)) {
                assert.ok(!image.src && image.kept, `${label} had loaded and let its source go`);
              } else {
                // Not loaded yet: lazy as published, or being fetched for print, or fetched and let go (D115).
                assert.ok((image.src && !image.loaded) || (!image.src && image.kept), `${label} is not loaded, or let its source go`);
              }
            }
          };
          await settle();
          await page.evaluate(() => window.papeleriaReader!.goTo(5));
          await expectWindow(layout === 'spread' ? [2, 3, 4, 5, 6, 7] : [4, 5, 6], layout === 'spread' ? [1] : [1, 2, 3], 'at page 5');
          await settle();
          await page.evaluate(() => window.papeleriaReader!.goTo(8));
          await expectWindow(layout === 'spread' ? [6, 7, 8] : [7, 8], layout === 'spread' ? [1, 2, 3, 4, 5] : [1, 2, 3, 4, 5, 6], 'at the end');
          await settle();
          await page.evaluate(() => window.papeleriaReader!.goTo(1));
          await expectWindow(layout === 'spread' ? [1, 2, 3] : [1, 2], layout === 'spread' ? [4, 5, 6, 7, 8] : [3, 4, 5, 6, 7, 8], 'back at the cover');
          const marks = await page.evaluate(() =>
            Array.from(document.querySelectorAll<HTMLImageElement>('figure.comic-figure img')).map((image) => (image as unknown as {papeleriaMark?: number}).papeleriaMark ?? 0),
          );
          assert.deepEqual(marks, [1, 2, 3, 4, 5, 6, 7, 8], 'the same image elements, in order: the engine made no copy of a page it kept');
          // A moment after load the reader has fetched every page once, for print, and let go of what it does not show.
          await page.waitForFunction((shown) => Array.from(document.querySelectorAll<HTMLImageElement>('figure.comic-figure img')).every((image) => {
            const number = Number(image.closest<HTMLElement>('figure')!.dataset['page']);
            return shown.includes(number) ? image.complete && image.naturalWidth > 0 : image.hasAttribute('data-papeleria-src') && !image.hasAttribute('src');
          }), layout === 'spread' ? [1, 2, 3] : [1, 2], {timeout: 15_000});
          await settle();
        });
      }
    });

    test('A5: guided view steps panel by panel across pages, shows the box with 4% around it, and Escape returns to the page', TIMEOUT, async () => {
      for (const viewport of VIEWPORTS) {
        await open(sampleUrl(), at(viewport, {context: {reducedMotion: 'reduce'}}), async ({page}) => {
          await page.click('#comic-guided');
          let state = await readReader(page);
          assert.deepEqual([state.view, state.page, state.panel, state.hash, state.status], ['guided', 1, 1, '#page-1-panel-1', panelStatus(1, 5, 1)]);
          assert.deepEqual([state.guidedLabel, state.detailHidden, state.visible], [EN['page_view'], false, [1]], 'Page view, and Detail for a zoom panel');

          // The lens: the box with 4% of the page around it fills the lens on one side and fits on the other.
          for (const [index, box] of SAMPLE_PAGE_1_BOXES.entries()) {
            if (index > 0) {
              await page.keyboard.press('ArrowRight');
            }
            const geometry = await page.evaluate(() => {
              const lens = document.getElementById('comic-lens')!.getBoundingClientRect();
              const art = document.querySelector('.comic-lens-art')!.getBoundingClientRect();
              return {lens: {left: lens.left, top: lens.top, width: lens.width, height: lens.height}, art: {left: art.left, top: art.top, width: art.width, height: art.height}};
            });
            const left = Math.max(0, box[0] - 4);
            const top = Math.max(0, box[1] - 4);
            const right = Math.min(100, box[0] + box[2] + 4);
            const bottom = Math.min(100, box[1] + box[3] + 4);
            const region = {
              left: geometry.art.left + (left / 100) * geometry.art.width - geometry.lens.left,
              top: geometry.art.top + (top / 100) * geometry.art.height - geometry.lens.top,
              right: geometry.art.left + (right / 100) * geometry.art.width - geometry.lens.left,
              bottom: geometry.art.top + (bottom / 100) * geometry.art.height - geometry.lens.top,
            };
            const fillsWidth = Math.abs(region.left) < 1.5 && Math.abs(region.right - geometry.lens.width) < 1.5;
            const fillsHeight = Math.abs(region.top) < 1.5 && Math.abs(region.bottom - geometry.lens.height) < 1.5;
            assert.ok(fillsWidth || fillsHeight, `${viewportLabel(viewport)} panel ${index + 1}: the padded box fills the lens on one side (${JSON.stringify(region)} in ${geometry.lens.width}×${geometry.lens.height})`);
            assert.ok(region.left > -1.5 && region.top > -1.5 && region.right < geometry.lens.width + 1.5 && region.bottom < geometry.lens.height + 1.5, 'and is never cropped');
            const aspect = geometry.art.height / geometry.art.width;
            assert.ok(Math.abs(aspect - 2200 / 1600) < 0.01, 'the same image, at its own proportions');
          }
          state = await readReader(page);
          assert.deepEqual([state.page, state.panel, state.detailHidden], [1, 5, true], 'panel 5 has no detail');
          await page.keyboard.press('ArrowRight');
          state = await readReader(page);
          assert.deepEqual([state.page, state.panel, state.hash, state.status], [2, 1, '#page-2-panel-1', panelStatus(1, 3, 2)], 'after the last panel, the next page\'s first');
          await page.click('#comic-previous');
          state = await readReader(page);
          assert.deepEqual([state.page, state.panel, state.hash], [1, 5, '#page-1-panel-5'], 'Previous steps back across the page');
          await page.keyboard.press('Escape');
          state = await readReader(page);
          assert.deepEqual([state.view, state.page, state.hash, state.focus], ['page', 1, '#page-1', 'page-1-panel-5'], 'Escape: page view at the page, focus on the panel');
        });
      }
    });

    test('A5: a page without panels is one guided step, addressed as the page; its lens shows the whole page', TIMEOUT, async () => {
      await open(readerUrl('#page-2-panel-2'), {context: {reducedMotion: 'reduce'}}, async ({page}) => {
        let state = await readReader(page);
        assert.deepEqual([state.view, state.page, state.panel], ['guided', 2, 2]);
        await page.keyboard.press('ArrowRight');
        state = await readReader(page);
        assert.deepEqual([state.view, state.page, state.panel, state.hash, state.status, state.detailHidden], ['guided', 3, null, '#page-3', pagesStatus([3], 5), true]);
        const whole = await page.evaluate(() => {
          const lens = document.getElementById('comic-lens')!.getBoundingClientRect();
          const art = document.querySelector('.comic-lens-art')!.getBoundingClientRect();
          const control = document.querySelector('.comic-lens-page');
          return {fits: art.width <= lens.width + 1 && art.height <= lens.height + 1, fills: Math.abs(art.height - lens.height) < 1.5 || Math.abs(art.width - lens.width) < 1.5, role: control?.getAttribute('role'), label: control?.getAttribute('aria-label'), src: (document.querySelector('.comic-lens-art') as HTMLImageElement).src};
        });
        assert.deepEqual([whole.fits, whole.fills, whole.role, whole.label], [true, true, 'img', 'Page three has no panels at all.']);
        assert.match(whole.src, /\/pages\/03\.svg$/);
        await page.keyboard.press('ArrowRight');
        state = await readReader(page);
        assert.deepEqual([state.page, state.panel, state.hash], [4, 1, '#page-4-panel-1']);
      });
    });

    test('A5: a panel opens its detail, a panel without one announces its transcript, a link panel is a link', TIMEOUT, async () => {
      const ORIGINAL = '/reader/dist/assets/images/pages/01.png';
      for (const viewport of [VIEWPORTS[0], VIEWPORTS[2]]) {
        const opened = served().requests.length;
        await open(readerUrl(), at(viewport, {context: {reducedMotion: 'reduce'}}), async ({page}) => {
          const requestsBefore = served().requests.length;
          assert.ok(!served().requests.slice(opened).includes(ORIGINAL), 'nothing asks for the original while the page loads and starts');
          // A zoom: the original, only now.
          await page.focus('#page-1-panel-1');
          await page.keyboard.press('Enter');
          const dialog = await page.evaluate(() => {
            const element = document.getElementById('comic-dialog') as HTMLDialogElement;
            return {
              open: element.open,
              modal: element.getAttribute('aria-modal'),
              title: document.getElementById('comic-dialog-title')?.textContent,
              transcript: document.getElementById('comic-dialog-transcript')?.textContent,
              focus: document.activeElement?.id,
              inert: Array.from(document.body.children).filter((child) => child !== element).every((child) => (child as HTMLElement).inert),
              zoom: document.querySelector<HTMLImageElement>('.comic-zoom-art')?.getAttribute('src'),
            };
          });
          assert.deepEqual(dialog, {
            open: true,
            modal: 'true',
            title: panelStatus(1, 5, 1),
            transcript: 'Panel one zooms into the art.',
            focus: 'comic-dialog-close',
            inert: true,
            zoom: 'assets/images/pages/01.png',
          });
          await page.waitForFunction(() => (document.querySelector('.comic-zoom-art') as HTMLImageElement).complete);
          assert.equal(served().requests.slice(requestsBefore).filter((path) => path === ORIGINAL).length, 1, 'the original is asked for when the zoom opens, and only then');
          await page.keyboard.press('Escape');
          let state = await readReader(page);
          assert.deepEqual([state.detailOpen, state.focus, state.view], [false, 'page-1-panel-1', 'page'], 'Escape closes it; focus returns to the panel');
          assert.equal(await page.evaluate(() => Array.from(document.body.children).some((child) => (child as HTMLElement).inert)), false, 'nothing stays inert');

          // A text detail moves into the dialog and back. Its headings, from h4 in the page, stand a level higher under the
          // dialog's h2 and keep their look; the page's own come back (W5R-19). The note has an h5; probes add an h4 and an h6,
          // as `#` and `###` render, and the transcript shows, so every heading is laid out where it is read.
          await page.evaluate(() => {
            const detail = document.getElementById('detail-1-2')!;
            const first = document.createElement('h4');
            first.textContent = 'A probe at the first level';
            const third = document.createElement('h6');
            third.textContent = 'A probe at the third level';
            detail.prepend(first);
            detail.append(third);
            (window as unknown as {pageHeadings: Element[]}).pageHeadings = Array.from(detail.querySelectorAll('h4, h5, h6'));
          });
          await page.click('#comic-transcript-toggle');
          const headings = (selector: string): Promise<{level: number; text: string; look: string}[]> =>
            page.evaluate(
              (within) =>
                Array.from(document.querySelectorAll(within), (heading) => {
                  const style = getComputedStyle(heading);
                  return {level: Number(heading.localName.slice(1)), text: heading.textContent ?? '', look: [style.fontSize, style.fontWeight, style.lineHeight, style.letterSpacing, style.marginTop, style.marginBottom].join(' ')};
                }),
              selector,
            );
          const inPage = await headings('#detail-1-2 :is(h2, h3, h4, h5, h6)');
          assert.deepEqual(
            inPage.map((heading) => `h${heading.level} ${heading.text}`),
            ['h4 A probe at the first level', 'h5 A heading in the note', 'h6 A probe at the third level'],
          );
          await page.click('#page-1-panel-2');
          const text = await page.evaluate(() => ({
            open: (document.getElementById('comic-dialog') as HTMLDialogElement).open,
            inDialog: document.getElementById('detail-1-2')?.closest('dialog') !== null,
          }));
          assert.deepEqual(text, {open: true, inDialog: true});
          assert.deepEqual(await headings('#comic-dialog .comic-dialog-content :is(h2, h3, h4, h5, h6)'), inPage.map((heading) => ({...heading, level: heading.level - 1})), 'a level higher, with the look they had');
          await page.click('#comic-dialog-close');
          state = await readReader(page);
          assert.deepEqual([state.detailOpen, state.focus], [false, 'page-1-panel-2']);
          assert.equal(await page.evaluate(() => document.getElementById('detail-1-2')?.parentElement?.className), 'comic-transcript-item', 'back under its transcript');
          assert.deepEqual(await headings('#detail-1-2 :is(h2, h3, h4, h5, h6)'), inPage, 'the page\'s headings as they were');
          assert.equal(
            await page.evaluate(() => {
              const before = (window as unknown as {pageHeadings: Element[]}).pageHeadings;
              const now = Array.from(document.querySelectorAll('#detail-1-2 h4, #detail-1-2 h5, #detail-1-2 h6'));
              return now.length === before.length && now.every((heading, index) => heading === before[index]);
            }),
            true,
            'the very elements the page had',
          );
          await page.click('#comic-transcript-toggle');

          // No detail: the transcript is announced, nothing opens.
          await page.focus('#page-1-panel-3');
          await page.keyboard.press('Enter');
          await page.waitForFunction(() => document.getElementById('comic-announce')?.textContent === 'Panel three has no detail; its transcript is announced.');
          state = await readReader(page);
          assert.deepEqual([state.detailOpen, state.hint], [false, 'Panel three has no detail; its transcript is announced.']);

          // A link panel is a link, with its external indication in its name.
          const external = page.locator('#page-1-panel-5');
          assert.equal(await external.getAttribute('href'), 'https://example.com/more');
          assert.match((await external.textContent()) ?? '', /\(External link\)/);
          await page.click('#page-1-panel-4');
          await waitForPages(page, expectedLayout(viewport) === 'spread' ? [4, 5] : [4]);
          state = await readReader(page);
          assert.deepEqual([state.page, state.hash], [4, '#page-4'], 'the internal link lands on page 4');
        });
      }
    });

    test('an image detail shows its picture; the backdrop closes the dialog; Tab stays inside it', TIMEOUT, async () => {
      await open(readerUrl('#page-2'), {context: {reducedMotion: 'reduce'}}, async ({page}) => {
        await page.click('#page-2-panel-1');
        const picture = await page.evaluate(() => {
          const image = document.querySelector<HTMLImageElement>('#comic-dialog .comic-detail-image img');
          return {alt: image?.alt, caption: document.querySelector('#comic-dialog figcaption')?.textContent ?? ''};
        });
        assert.equal(picture.alt, 'An extra picture, wider than tall.');
        assert.match(picture.caption, /The extra picture's caption\./);
        // Close is the only control in an image detail: Tab and Shift+Tab stay on it.
        await page.keyboard.press(tabKey(engine));
        assert.equal((await readReader(page)).focus, 'comic-dialog-close');
        await page.keyboard.press(`Shift+${tabKey(engine)}`);
        assert.equal((await readReader(page)).focus, 'comic-dialog-close');
        const box = await rectOf(page, '.comic-dialog-body');
        await page.mouse.click(Math.max(2, box.left / 2), Math.max(2, box.top / 2));
        const state = await readReader(page);
        assert.deepEqual([state.detailOpen, state.focus], [false, 'page-2-panel-1'], 'a click on the backdrop closes it');
      });
      await open(readerUrl(), {context: {reducedMotion: 'reduce'}}, async ({page}) => {
        await page.click('#page-1-panel-1');
        // A zoom holds Close and the zoom surface: Tab goes round the two.
        const order: string[] = [];
        for (let step = 0; step < 3; step += 1) {
          await page.keyboard.press(tabKey(engine));
          order.push(await page.evaluate(() => document.activeElement?.id || document.activeElement?.className || ''));
        }
        assert.deepEqual(order, ['comic-zoom', 'comic-dialog-close', 'comic-zoom']);
      });
    });

    test('A5: resize and rotation keep the logical page, a spread showing its pair', TIMEOUT, async () => {
      const [phone, , desktop] = VIEWPORTS;
      await open(sampleUrl(), at(desktop, {context: {reducedMotion: 'reduce'}}), async ({page}) => {
        await page.evaluate(() => window.papeleriaReader!.goTo(4));
        await waitForPages(page, [4, 5]);
        await page.setViewportSize(phone);
        await waitForPages(page, [4]);
        assert.deepEqual([(await readReader(page)).page, (await readReader(page)).layout, (await readReader(page)).hash], [4, 'single', '#page-4']);
        await page.keyboard.press('ArrowRight');
        await waitForPages(page, [5]);
        await page.setViewportSize(desktop);
        await waitForPages(page, [4, 5]);
        assert.equal((await readReader(page)).page, 5, 'the logical page, not the first of its pair');
        await page.setViewportSize(phone);
        await waitForPages(page, [5]);
        // Guided view keeps its panel across a resize.
        await page.evaluate(() => window.papeleriaReader!.enterGuided(6, 2));
        await page.setViewportSize(desktop);
        await page.waitForTimeout(100);
        const state = await readReader(page);
        assert.deepEqual([state.view, state.page, state.panel, state.hash], ['guided', 6, 2, '#page-6-panel-2']);
      });
    });

    test('A5: the transcript toggle shows the pages\' transcripts, and stays across turns and views', TIMEOUT, async () => {
      await open(sampleUrl(), {context: {reducedMotion: 'reduce'}}, async ({page}) => {
        const shownTranscripts = () =>
          page.evaluate(() =>
            Array.from(document.querySelectorAll<HTMLElement>('article.comic-sheet'))
              .filter((sheet) => getComputedStyle(sheet.querySelector('.comic-transcript')!).display !== 'none' && !sheet.hidden)
              .map((sheet) => Number(sheet.dataset['page'])),
          );
        assert.deepEqual(await shownTranscripts(), []);
        await page.click('#comic-transcript-toggle');
        assert.equal(await page.getAttribute('#comic-transcript-toggle', 'aria-pressed'), 'true');
        assert.deepEqual(await shownTranscripts(), [1]);
        await press(page, '#comic-next', [2, 3]);
        assert.deepEqual(await shownTranscripts(), [2, 3], 'it stays across a turn');
        await page.click('#comic-guided');
        assert.equal((await readReader(page)).transcript, true);
        assert.deepEqual(await shownTranscripts(), [2], 'and in guided view, the page shown');
        await page.click('#comic-guided');
        await page.click('#comic-transcript-toggle');
        assert.equal(await page.getAttribute('#comic-transcript-toggle', 'aria-pressed'), 'false');
        assert.deepEqual(await shownTranscripts(), []);
      });
    });

    test('A5 and DEP05: without JavaScript every page stacks at full width, art then transcript, every image in order', TIMEOUT, async () => {
      for (const viewport of VIEWPORTS) {
        await open(sampleUrl(), at(viewport, {context: {javaScriptEnabled: false}, reader: false}), async ({page}) => {
          const layout = await page.evaluate(() => ({
            enhanced: document.body.classList.contains('comic-enhanced'),
            status: document.getElementById('comic-status')?.textContent,
            buttons: Array.from(document.querySelectorAll('.comic-tools button')).filter((button) => getComputedStyle(button).display !== 'none').length,
            panels: Array.from(document.querySelectorAll('.comic-panel')).filter((panel) => getComputedStyle(panel).display !== 'none').length,
            book: getComputedStyle(document.getElementById('comic-book')!).display,
            sheets: Array.from(document.querySelectorAll<HTMLElement>('article.comic-sheet')).map((sheet) => {
              const image = sheet.querySelector('img')!;
              const figure = sheet.querySelector('figure')!.getBoundingClientRect();
              const transcript = sheet.querySelector('.comic-transcript')!.getBoundingClientRect();
              return {page: Number(sheet.dataset['page']), src: image.getAttribute('src') !== null, below: transcript.top >= figure.bottom - 1, width: Math.round(figure.width)};
            }),
            main: Math.round(document.getElementById('comic-main')!.getBoundingClientRect().width),
            scrollWidth: document.documentElement.scrollWidth,
          }));
          assert.deepEqual([layout.enhanced, layout.status, layout.buttons, layout.panels, layout.book], [false, EN['no_js'], 0, 0, 'none']);
          assert.deepEqual(layout.sheets.map((sheet) => sheet.page), [1, 2, 3, 4, 5, 6, 7, 8]);
          assert.ok(layout.sheets.every((sheet) => sheet.src && sheet.below), 'every page has its image, its transcript after it');
          assert.ok(layout.scrollWidth <= viewport.width, `${viewportLabel(viewport)}: no horizontal scrolling`);
          const tops = await page.evaluate(() => Array.from(document.querySelectorAll('article.comic-sheet')).map((sheet) => sheet.getBoundingClientRect().top));
          assert.ok(tops.every((top, index) => index === 0 || top > tops[index - 1]!), 'stacked, in order');
        });
      }
    });

    test('the address: pages and panels clamp, anything else under page- is page 1, ids inside a page keep the address, the skip link is the browser\'s', TIMEOUT, async () => {
      const cases: [string, {page: number; panel: number | null; view: string; hash: string}][] = [
        ['#page-3', {page: 3, panel: null, view: 'page', hash: '#page-3'}],
        ['#page-99', {page: 5, panel: null, view: 'page', hash: '#page-5'}],
        ['#page-0', {page: 1, panel: null, view: 'page', hash: '#page-1'}],
        ['#page-x', {page: 1, panel: null, view: 'page', hash: '#page-1'}],
        ['#nothing-here', {page: 1, panel: null, view: 'page', hash: '#page-1'}],
        ['#page-1-panel-2', {page: 1, panel: 2, view: 'guided', hash: '#page-1-panel-2'}],
        ['#page-1-panel-99', {page: 1, panel: 5, view: 'guided', hash: '#page-1-panel-5'}],
        ['#page-3-panel-1', {page: 3, panel: null, view: 'page', hash: '#page-3'}],
        ['#detail-2-1', {page: 2, panel: null, view: 'page', hash: '#detail-2-1'}],
      ];
      await open(readerUrl(), {context: {reducedMotion: 'reduce'}}, async ({page}) => {
        for (const [hash, expected] of cases) {
          // A load of its own each time, not a same-document jump.
          await page.goto('about:blank');
          await page.goto(readerUrl(hash));
          await page.waitForFunction(() => window.papeleriaReader !== undefined);
          await page.waitForFunction((want) => location.hash === want, expected.hash, {timeout: 5000});
          const state = await readReader(page);
          assert.deepEqual({page: state.page, panel: state.panel, view: state.view, hash: state.hash}, expected, `opened at ${hash}`);
          assert.equal(await page.evaluate(() => Math.round(window.scrollY)), 0, `${hash}: the page stays at the top, where the book is`);
        }
        // On hashchange: the same rules, and a dialog closes first.
        await page.goto('about:blank');
        await page.goto(readerUrl());
        await page.waitForFunction(() => window.papeleriaReader !== undefined);
        await page.click('#page-1-panel-1');
        await changeHash(page, '#page-99');
        await page.waitForFunction(() => location.hash === '#page-5');
        let state = await readReader(page);
        assert.deepEqual([state.page, state.detailOpen, state.visible], [5, false, [4, 5]]);
        await changeHash(page, '#page-2-panel-99');
        await page.waitForFunction(() => location.hash === '#page-2-panel-2');
        state = await readReader(page);
        assert.deepEqual([state.view, state.page, state.panel], ['guided', 2, 2]);
        await changeHash(page, '#page-2');
        await page.waitForFunction(() => window.papeleriaReader!.view === 'page');
        // The skip link: the browser takes #comic-main in, then the address names the page again.
        await page.focus('.skip-link');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => location.hash === '#page-2');
        state = await readReader(page);
        assert.deepEqual([state.page, state.visible], [2, [2, 3]], 'the skip link moves no page');
      });
    });

    test('gestures: a swipe turns, a click on a panel or in the middle never does, a click on bare art in an edge zone does', TIMEOUT, async () => {
      for (const motion of ['reduce', 'no-preference'] as const) {
        for (const viewport of VIEWPORTS) {
          const spread = expectedLayout(viewport) === 'spread';
          await open(sampleUrl(), at(viewport, {context: {reducedMotion: motion, hasTouch: true}}), async ({page}) => {
            const figure = await rectOf(page, '.comic-book figure[data-page="1"]');
            const book = await rectOf(page, '#comic-book');
            await dispatchSwipe(page, '#page-1-panel-3', {x: figure.left + figure.width * 0.7, y: figure.top + figure.height * 0.5}, {dx: -140, dy: 8});
            await waitForPages(page, spread ? [2, 3] : [2]);
            await page.evaluate(() => window.papeleriaReader!.goTo(1));
            await waitForPages(page, [1]);
            // A click on a panel, even in the edge zone, is the panel's (panel actions win, DEP05 item 3).
            const inPanel = {x: figure.left + figure.width * 0.93, y: figure.top + figure.height * 0.1};
            const inZone = inPanel.x > book.left + book.width * 0.8;
            await page.mouse.click(inPanel.x, inPanel.y);
            let state = await readReader(page);
            assert.deepEqual([state.page, state.detailOpen], [1, true], `${motion} ${viewportLabel(viewport)}: the panel's detail opened and nothing turned (in the edge zone: ${inZone})`);
            await page.keyboard.press('Escape');
            await page.mouse.click(figure.left + figure.width * 0.5, figure.top + figure.height * 0.98);
            await page.waitForTimeout(250);
            assert.equal((await readReader(page)).page, 1, 'a click on bare art away from the edges is not a turn');
            // Bare art at the right edge: the last 4% of the page carries no panel.
            const edge = {x: figure.left + figure.width * 0.985, y: figure.top + figure.height * 0.5};
            assert.ok(edge.x > book.left + book.width * 0.8, 'the point is in the right edge zone');
            await page.mouse.click(edge.x, edge.y);
            await waitForPages(page, spread ? [2, 3] : [2]);
            state = await readReader(page);
            assert.equal(state.page, 2, `${motion} ${viewportLabel(viewport)}: an edge-zone click on bare art turns`);
          });
        }
      }
    });

    test('never a turn: a selection, an open dialog, a form control, a zoom drag, or keys with a modifier', TIMEOUT, async () => {
      await open(sampleUrl(), {context: {reducedMotion: 'reduce', hasTouch: true}}, async ({page}) => {
        const figure = await rectOf(page, '.comic-book figure[data-page="1"]');
        const edge = {x: figure.left + figure.width * 0.985, y: figure.top + figure.height * 0.5};
        // A selection.
        await page.evaluate(() => {
          const selection = document.getSelection()!;
          selection.removeAllRanges();
          const range = document.createRange();
          range.selectNodeContents(document.querySelector('.comic-title')!);
          selection.addRange(range);
        });
        await dispatchSwipe(page, '.comic-book figure[data-page="1"] img', {x: figure.left + figure.width * 0.5, y: figure.top + figure.height * 0.5}, {dx: -140, dy: 5});
        await page.waitForTimeout(200);
        assert.equal((await readReader(page)).page, 1, 'a swipe with text selected is not a turn');
        await page.evaluate(() => document.getSelection()!.removeAllRanges());
        // A dialog: keys, a swipe and a drag on the zoom stay with it.
        await page.click('#page-1-panel-1');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('End');
        const zoom = await rectOf(page, '.comic-zoom');
        const before = await page.evaluate(() => (document.querySelector('.comic-zoom-art') as HTMLElement).style.transform);
        await page.mouse.dblclick(zoom.left + zoom.width / 2, zoom.top + zoom.height / 2);
        await page.mouse.move(zoom.left + zoom.width / 2, zoom.top + zoom.height / 2);
        await page.mouse.down();
        await page.mouse.move(zoom.left + zoom.width / 2 - 120, zoom.top + zoom.height / 2 - 40, {steps: 6});
        await page.mouse.up();
        const after = await page.evaluate(() => (document.querySelector('.comic-zoom-art') as HTMLElement).style.transform);
        assert.notEqual(after, before, 'the drag panned the zoom');
        let state = await readReader(page);
        assert.deepEqual([state.page, state.detailOpen], [1, true], 'nothing turned under the dialog');
        await page.keyboard.press('Escape');
        // A form control: its keys are its own.
        await page.evaluate(() => {
          const input = document.createElement('input');
          input.id = 'probe';
          document.querySelector('.comic-register')!.appendChild(input);
        });
        await page.focus('#probe');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('End');
        await page.keyboard.type('ab');
        state = await readReader(page);
        assert.deepEqual([state.page, await page.inputValue('#probe')], [1, 'ab']);
        // Modifiers.
        await page.focus('#comic-book');
        for (const chord of ['Alt+ArrowRight', 'Control+ArrowRight', 'Shift+ArrowRight', 'Meta+ArrowRight']) {
          await page.keyboard.press(chord);
        }
        assert.equal((await readReader(page)).page, 1);
        await page.mouse.click(edge.x, edge.y);
        await waitForPages(page, [2, 3]);
      });
    });

    test('full screen: a refusal says so in the status and changes nothing else', TIMEOUT, async () => {
      await open(sampleUrl(), {context: {reducedMotion: 'reduce'}}, async ({page}) => {
        await page.evaluate(() => {
          document.documentElement.requestFullscreen = () => Promise.reject(new TypeError('refused'));
        });
        await page.click('#comic-fullscreen');
        await page.waitForFunction((text) => document.getElementById('comic-status')?.textContent === text, EN['fullscreen_denied']);
        assert.equal(await page.evaluate(() => document.fullscreenElement), null);
        await press(page, '#comic-next', [2, 3]);
        assert.equal((await readReader(page)).status, pagesStatus([2, 3], 8), 'the next change names the place again');
      });
    });

    test('DEP05 item 6: from file:// it loads, enhances and turns, and asks for nothing outside its folder', TIMEOUT, async () => {
      for (const viewport of VIEWPORTS) {
        const dist = built().dist.sample;
        await open(fileUrl(dist), at(viewport, {context: {reducedMotion: 'reduce'}}), async ({page, requests}) => {
          const spread = expectedLayout(viewport) === 'spread';
          await press(page, '#comic-next', spread ? [2, 3] : [2]);
          const state = await readReader(page);
          assert.equal(state.page, 2);
          // A browser may refuse replaceState on file://; the page turns all the same.
          assert.ok(state.hash === '#page-2' || state.hash === '', state.hash);
          const folder = pathToFileURL(dist).href;
          assert.deepEqual(requests.filter((request) => !request.url.startsWith(`${folder}/`)).map((request) => request.url), [], 'every request stays in the folder');
          // Playwright's Firefox fires no request event for a file:// load (W3C, 2026-09-26).
          if (engine !== 'firefox') {
            assert.ok(requests.some((request) => request.url === `${folder}/reader.js`), 'the list sees file:// loads');
          }
        });
      }
    });

    test('C22 and C24: one script, only its own files, and no request of its own', TIMEOUT, async () => {
      await open(sampleUrl(), {context: {reducedMotion: 'reduce'}}, async ({page, requests}) => {
        await page.click('#page-1-panel-1');
        await page.waitForFunction(() => (document.querySelector('.comic-zoom-art') as HTMLImageElement | null)?.complete === true);
        await page.keyboard.press('Escape');
        await press(page, '#comic-next', [2, 3]);
        await page.waitForTimeout(200);
        assert.ok(requests.some((request) => request.url.endsWith('/sample/dist/assets/images/pages/01.png')), 'the zoom\'s original, from the piece');
        const origin = served().origin;
        for (const request of requests) {
          assert.ok(request.url.startsWith(`${origin}/sample/dist/`), `${request.type} request outside the piece: ${request.url}`);
          assert.ok(!['fetch', 'xhr', 'websocket', 'eventsource', 'ping', 'manifest'].includes(request.type), `${request.type} request ${request.url}`);
          const path = decodeURIComponent(new URL(request.url).pathname).slice('/sample/dist/'.length);
          assert.ok(existsSync(join(built().dist.sample, path)), `a request for a file dist/ lacks: ${path}`);
        }
        assert.deepEqual(requests.filter((request) => request.type === 'script').map((request) => request.url), [`${origin}/sample/dist/reader.js`]);
        assert.equal(await page.evaluate(() => document.scripts.length), 2, 'the strings block and reader.js');
        assert.equal(await page.evaluate(() => document.querySelectorAll('script:not([type="application/json"])').length), 1);
      });
    });

    test('the hook: window.papeleriaReader and pagechange serve the preview bridge (CONTRACT §6)', TIMEOUT, async () => {
      await open(sampleUrl(), {context: {reducedMotion: 'reduce'}, init: RECORD_CHANGES}, async ({page}) => {
        assert.deepEqual(await pageChanges(page), [], 'nothing on start');
        const hook = await page.evaluate(() => {
          const reader = window.papeleriaReader!;
          return {version: reader.version, total: reader.total, frozen: Object.isFrozen(reader), returned: reader.goTo(3), focus: document.activeElement === document.body};
        });
        assert.deepEqual(hook, {version: 1, total: 8, frozen: true, returned: 3, focus: true});
        await page.evaluate(() => window.papeleriaReader!.goTo(Number.NaN));
        await page.evaluate(() => window.papeleriaReader!.enterGuided(4, 2));
        await page.evaluate(() => window.papeleriaReader!.leaveGuided());
        await page.focus('#comic-book');
        await key(page, 'ArrowRight', [6, 7]);
        await press(page, '#comic-previous', [4, 5]);
        await changeHash(page, '#page-8');
        await waitForPages(page, [8]);
        const changes = await pageChanges(page);
        assert.deepEqual(
          changes.map((change) => [change.cause, change.view, change.page, change.panel, change.previous]),
          [
            ['api', 'page', 3, null, 1],
            ['api', 'guided', 4, 2, 3],
            ['api', 'page', 4, null, 4],
            ['key', 'page', 6, null, 4],
            ['button', 'page', 4, null, 6],
            ['hash', 'page', 8, null, 4],
          ],
          'NaN changed nothing; every other change is reported once, with its cause',
        );
        assert.deepEqual(changes.at(-1), {page: 8, previous: 4, panel: null, view: 'page', layout: 'spread', visible: [8], total: 8, cause: 'hash'});
      });
    });

    test('DEP05 item 8 on the real reader: print hands the page back as published, and the reader resumes where it was', TIMEOUT, async () => {
      await open(sampleUrl(), {init: ENGINE_TRAP}, async ({page}) => {
        const published = readFileSync(join(built().dist.sample, 'index.html'), 'utf8');
        // Every page fetched once, as a moment after load (D115).
        await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLImageElement>('figure.comic-figure img')).every((image) => (image.complete && image.naturalWidth > 0) || image.hasAttribute('data-papeleria-src')), undefined, {timeout: 15_000});
        /** Each sheet as a canonical string: attributes sorted, `loading` left out, parsed from the same serializer. */
        const canonical = (source: string | null) =>
          page.evaluate((html) => {
            const root = html === null ? document : new DOMParser().parseFromString(html, 'text/html');
            const write = (node: Node): string => {
              if (node.nodeType === Node.TEXT_NODE) {
                return node.textContent ?? '';
              }
              if (!(node instanceof Element)) {
                return '';
              }
              const attributes = Array.from(node.attributes)
                .filter((attribute) => attribute.name !== 'loading')
                .map((attribute) => `${attribute.name}=${JSON.stringify(attribute.value)}`)
                .sort();
              return `<${node.localName} ${attributes.join(' ')}>${Array.from(node.childNodes).map(write).join('')}</${node.localName}>`;
            };
            return Array.from(root.querySelectorAll('article.comic-sheet')).map(write);
          }, source);
        const sheets = await canonical(published);
        assert.equal(sheets.length, 8);
        await press(page, '#comic-next', [2, 3]);
        await page.click('#comic-guided');
        await page.emulateMedia({media: 'print'});
        await page.waitForFunction(() => !document.body.classList.contains('comic-enhanced'));
        const suspended = await page.evaluate(() => ({
          book: document.getElementById('comic-book')!.innerHTML,
          bookStyle: document.getElementById('comic-book')!.hasAttribute('style'),
          classes: document.body.className,
          engine: document.querySelectorAll('[class*="stf__"], .papeleria-engine, .comic-lens').length,
          sources: Array.from(document.querySelectorAll('article.comic-sheet img')).every((image) => image.hasAttribute('src') && image.hasAttribute('srcset') && !image.hasAttribute('data-papeleria-src')),
        }));
        assert.deepEqual(suspended, {book: '', bookStyle: false, classes: 'comic-body', engine: 0, sources: true}, 'the engine, its block and its classes are gone; every image has its sources back');
        assert.deepEqual(await canonical(null), sheets, 'every sheet is the published sheet: the figure back in it, no style, the same attributes');
        await page.emulateMedia({media: 'screen'});
        await page.waitForFunction(() => document.body.classList.contains('comic-enhanced') && window.papeleriaReader!.view === 'guided');
        const state = await readReader(page);
        assert.deepEqual([state.view, state.page, state.panel], ['guided', 2, 1], 'the reader resumed at the same place and view');
        assert.equal((await engineCalls(page)).engines, 2, 'a new engine after printing');
      });
    });

    test('CONTRACT §5: in a frame with no width the reader does not start and changes nothing; given room, the page reads as published (W5R-18)', TIMEOUT, async () => {
      // A page of the server's own framing the comic at no width, as a site might in a closed panel.
      writeFileSync(
        join(built().workspace, 'zero-width.html'),
        // Its own icon, so the browser asks the server for no favicon.ico.
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A comic in a frame</title><link rel="icon" href="data:,"></head><body>' +
          '<iframe id="comic" src="reader/dist/index.html" style="width:0;height:600px;border:0"></iframe></body></html>\n',
      );
      const context = await use().newContext({viewport: {width: 1280, height: 800}});
      try {
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(`page error: ${error.message}`));
        page.on('console', (message) => {
          if (message.type() === 'error') {
            errors.push(`console error: ${message.text()}`);
          }
        });
        await page.goto(`${served().origin}/zero-width.html`);
        // A frame with no width is never visible: waited for as attached.
        const frame = await (await page.waitForSelector('#comic', {state: 'attached'})).contentFrame();
        assert.ok(frame !== null, 'the frame');
        await frame.waitForLoadState('load');
        const published = readFileSync(join(built().dist.reader, 'index.html'), 'utf8');
        const started = await frame.evaluate(
          (html) => ({
            width: window.innerWidth,
            reader: 'papeleriaReader' in window,
            body: document.body.outerHTML === new DOMParser().parseFromString(html, 'text/html').body.outerHTML,
          }),
          published,
        );
        assert.deepEqual(started, {width: 0, reader: false, body: true}, 'no reader, and the body is the published body: no class, dialog, hint or label of the reader');

        await page.evaluate(() => {
          document.getElementById('comic')!.style.width = '1000px';
        });
        await frame.waitForFunction(() => window.innerWidth === 1000);
        const shown = await frame.evaluate(() => ({
          buttons: Array.from(document.querySelectorAll('.comic-tools button')).filter((button) => getComputedStyle(button).display !== 'none').length,
          art: Array.from(document.querySelectorAll('.comic-art'), (art) => art.getBoundingClientRect().height > 0),
          transcripts: Array.from(document.querySelectorAll('.comic-transcript'), (transcript) => getComputedStyle(transcript).display !== 'none'),
          titles: Array.from(document.querySelectorAll('.comic-sheet-title'), (title) => title.getBoundingClientRect().width > 1),
        }));
        assert.equal(shown.buttons, 0, 'no button shows that does nothing');
        assert.deepEqual(shown.art, [true, true, true, true, true], 'every page shows its art');
        assert.deepEqual(shown.transcripts, [true, true, true, true], 'every transcript shows (page 3 has none)');
        assert.deepEqual(shown.titles, [true, true, true, true, true], 'every sheet shows its title');
        assert.deepEqual(errors, [], 'the page reported errors');
      } finally {
        await context.close();
      }
    });

    test('print, then no room for the book: the page stays as published until the reader can resume (W5R-18)', TIMEOUT, async () => {
      await open(sampleUrl(), {context: {reducedMotion: 'reduce'}}, async ({page}) => {
        await press(page, '#comic-next', [2, 3]);
        await page.emulateMedia({media: 'print'});
        await page.waitForFunction(() => !document.body.classList.contains('comic-enhanced'));
        // A query made after the reader's reports its changes after the reader's own: once it has, the reader has answered.
        await page.evaluate(() => {
          const record = window as unknown as {printChanges: number};
          record.printChanges = 0;
          window.matchMedia('print').addEventListener('change', () => {
            record.printChanges += 1;
          });
          document.getElementById('comic-main')!.style.width = '0px';
        });
        await page.emulateMedia({media: 'screen'});
        await page.waitForFunction(() => (window as unknown as {printChanges: number}).printChanges === 1);
        const stayed = await page.evaluate(() => ({
          classes: document.body.className,
          book: document.getElementById('comic-book')!.outerHTML,
          sheets: Array.from(document.querySelectorAll<HTMLElement>('article.comic-sheet')).filter((sheet) => sheet.hidden).length,
        }));
        assert.deepEqual(stayed, {classes: 'comic-body', book: '<div class="comic-book" id="comic-book" tabindex="-1"></div>', sheets: 0}, 'no book, no class of the reader, every sheet shown');

        // With room again, the next time printing ends the reader resumes where it was.
        await page.evaluate(() => document.getElementById('comic-main')!.style.removeProperty('width'));
        await page.emulateMedia({media: 'print'});
        await page.waitForFunction(() => (window as unknown as {printChanges: number}).printChanges === 2);
        await page.emulateMedia({media: 'screen'});
        await page.waitForFunction(() => document.body.classList.contains('comic-enhanced'));
        await waitForPages(page, [2, 3]);
        assert.equal((await readReader(page)).page, 2);
      });
    });

    test('CONTRACT §5: an engine that fails to start, or that the adapter refuses as it loads, changes nothing: the page reads as published, and the error is reported', TIMEOUT, async () => {
      const published = readFileSync(join(built().dist.reader, 'index.html'), 'utf8');
      const failures = [
        ['constructor', /^The test engine refused to start\.$/],
        // After the engine has moved the pages into its own elements and set its start-up timer.
        ['load', /^The test engine failed after loading the pages\.$/],
        // The adapter's own refusal, also after the pages have moved (D103).
        ['frames', /asked for 2 animation frames while loading/],
      ] as const;
      for (const [failure, message] of failures) {
        const context = await use().newContext({viewport: {width: 1280, height: 800}});
        try {
          // The engine's own script sets `St` to an object and then its `PageFlip`, and the deferred reader starts as soon
          // as it has run: `PageFlip` is taken as the engine defines it, and the reader finds one that fails as
          // `failure` says.
          await context.addInitScript((mode: string) => {
            type EngineClass = new (block: HTMLElement, settings: object) => {loadFromHTML(items: HTMLElement[]): void};
            const failing = (Real: EngineClass): EngineClass =>
              class extends Real {
                constructor(block: HTMLElement, settings: object) {
                  if (mode === 'constructor') {
                    throw new Error('The test engine refused to start.');
                  }
                  super(block, settings);
                }

                override loadFromHTML(items: HTMLElement[]): void {
                  super.loadFromHTML(items);
                  if (mode === 'load') {
                    throw new Error('The test engine failed after loading the pages.');
                  }
                  if (mode === 'frames') {
                    window.requestAnimationFrame(() => undefined);
                  }
                }
              };
            let holder: object | undefined;
            Object.defineProperty(window, 'St', {
              configurable: true,
              get: () => holder,
              set: (value: object) => {
                holder = value;
                let engine: EngineClass | undefined;
                Object.defineProperty(value, 'PageFlip', {
                  configurable: true,
                  enumerable: true,
                  get: () => engine,
                  set: (Real: EngineClass) => {
                    engine = failing(Real);
                  },
                });
              },
            });
          }, failure);
          const page = await context.newPage();
          const errors: string[] = [];
          page.on('pageerror', (error) => errors.push(error.message));
          const reported = page.waitForEvent('pageerror');
          await page.goto(`${served().origin}/reader/dist/index.html`);
          await reported;
          // The engine's start-up timer, a millisecond after it loads, and a few frames have run by now.
          await page.evaluate(() => new Promise<void>((resolve) => window.setTimeout(() => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())), 50)));
          const state = await page.evaluate(
            (html) => ({
              reader: 'papeleriaReader' in window,
              body: document.body.outerHTML === new DOMParser().parseFromString(html, 'text/html').body.outerHTML,
            }),
            published,
          );
          assert.deepEqual(state, {reader: false, body: true}, `${failure}: no reader, and the body is the published body: no class, dialog, hint or label of the reader, no element of the engine, every page where it was`);
          assert.equal(errors.length, 1, `${failure}: the one error, reported: ${errors.join(' | ')}`);
          assert.match(errors[0]!, message);
        } finally {
          await context.close();
        }
      }
    });
  });
}
