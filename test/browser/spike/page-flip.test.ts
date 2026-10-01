/**
 * M4.1, DEP05: the vendored page-turn engine behind Papeleria's adapter
 * (templates/comic/client/engine-adapter.ts, D103), in Chromium, Firefox and
 * WebKit at 390×844, 834×1112 and 1280×800 (D51).
 *
 * The spike folder is assembled when the suite runs: page-flip.html beside
 * this file; spike.js, which is the engine's pinned bytes followed by the
 * adapter and spike-entry.ts bundled by esbuild (one classic script, the
 * shape W4's reader.js can take); and the eight generated pages of
 * examples/sample-comic. It is served from a loopback server and opened from
 * file:// as well.
 *
 * DEP05's items, one test each, every one at the three viewports: the cover
 * alone, then pairs, then a final unpaired page alone; resize keeping the
 * logical page; a panel's press winning over the edge turn, with the controls
 * that show the guard is what stops it; the no-JS DOM; src retention; file://;
 * reduced motion with the engine's animated calls counted; and destroy()
 * leaving no listener, observer, frame or engine element behind. The layout
 * rules are also checked as pure functions, without a browser.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, describe, test} from 'node:test';
import {pathToFileURL} from 'node:url';
import vm from 'node:vm';

import {build} from 'esbuild';
import type {Browser, BrowserContextOptions, Page} from 'playwright';

import {
  EDGE_ZONE,
  SPREAD_RULE,
  TAP_ECHO_MS,
  chooseLayout,
  clampPage,
  edgeZone,
  nextPage,
  previousPage,
  spreadOf,
  swipeDirection,
  type AdapterOptions,
} from '../../../templates/comic/client/engine-adapter.js';
import {applicationRoot, runCheckScript} from '../../helpers/paths.js';
import {launchEngine, selectedEngines} from '../helpers/engines.js';
import {dispatchSwipe} from '../helpers/gestures.js';
import {serveDirectory, type StaticServer} from '../helpers/static-server.js';

const TIMEOUT = {timeout: 180_000};
const TOTAL = 8;
const ENGINE_SHA256 = 'bbaca0bbef57a22bb66a3fc69d67baf9a17fb9a9c89ec9ed35e2b91abe4bd1e7';
const ENGINE_BYTES = 44_058;

type Viewport = {readonly width: number; readonly height: number};
const VIEWPORTS: readonly Viewport[] = [
  {width: 390, height: 844},
  {width: 834, height: 1112},
  {width: 1280, height: 800},
];

/** IC07: only the desktop viewport has room for two 320 px pages beside each other. */
function expectedLayout(viewport: Viewport): 'single' | 'spread' {
  return viewport.width >= 900 ? 'spread' : 'single';
}

function label(viewport: Viewport): string {
  return `${viewport.width}×${viewport.height}`;
}

// ---------------------------------------------------------------------------
// The spike folder.

const workspace = mkdtempSync(join(tmpdir(), 'papeleria-spike-'));
const SPIKE = join(workspace, 'spike');
const OWN = join(workspace, 'own.js');
const SPIKE_URL = pathToFileURL(join(SPIKE, 'page-flip.html')).href;
let server: StaticServer | undefined;
let inputs: string[] = [];

before(async () => {
  mkdirSync(join(SPIKE, 'images'), {recursive: true});
  copyFileSync(join(applicationRoot, 'test', 'browser', 'spike', 'page-flip.html'), join(SPIKE, 'page-flip.html'));
  // The public favicon (D05), so no browser asks the server for a missing /favicon.ico.
  copyFileSync(join(applicationRoot, 'theme', 'marks', 'papeleria-favicon.svg'), join(SPIKE, 'favicon.svg'));
  for (let page = 1; page <= TOTAL; page += 1) {
    const name = `0${page}.png`;
    copyFileSync(join(applicationRoot, 'examples', 'sample-comic', 'assets', 'images', 'pages', name), join(SPIKE, 'images', name));
  }
  const result = await build({
    absWorkingDir: applicationRoot,
    entryPoints: ['test/browser/spike/spike-entry.ts'],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome111', 'edge111', 'firefox111', 'safari16.4', 'ios16.4'],
    minify: false,
    sourcemap: false,
    metafile: true,
    logLevel: 'silent',
    write: false,
  });
  assert.deepEqual(result.warnings, [], 'the spike bundles without a warning');
  inputs = Object.keys(result.metafile.inputs).sort();
  const own = result.outputFiles[0]?.contents;
  assert.ok(own !== undefined);
  const engine = readFileSync(join(applicationRoot, 'vendor', 'page-flip', 'page-flip.browser.js'));
  writeFileSync(OWN, own);
  writeFileSync(join(SPIKE, 'spike.js'), Buffer.concat([engine, Buffer.from('\n'), Buffer.from(own)]));
  server = await serveDirectory(workspace);
});

after(async () => {
  await server?.close();
  rmSync(workspace, {recursive: true, force: true});
});

function origin(): string {
  if (server === undefined) {
    throw new Error('the spike server is not running');
  }
  return server.origin;
}

// ---------------------------------------------------------------------------
// Without a browser.

test('the spike\'s one script is the engine\'s pinned bytes, then own code the published-client scan passes unexcepted', async () => {
  const script = readFileSync(join(SPIKE, 'spike.js'));
  assert.equal(createHash('sha256').update(script.subarray(0, ENGINE_BYTES)).digest('hex'), ENGINE_SHA256, 'the engine part is the pinned file');
  assert.equal(script[ENGINE_BYTES], 0x0a);
  assert.ok(script.subarray(ENGINE_BYTES + 1).equals(readFileSync(OWN)));
  assert.deepEqual(inputs, ['templates/comic/client/engine-adapter.ts', 'test/browser/spike/spike-entry.ts'], 'own code only; the engine is not re-bundled');
  const scan = await runCheckScript('bundle-clients.mjs', ['--scan', OWN]);
  assert.equal(scan.code, 0, scan.stderr);
  assert.match(scan.stdout, /scan clean/);
  assert.doesNotThrow(() => new vm.Script(script.toString('utf8'), {filename: 'spike.js'}), 'the whole file compiles as one classic script');
});

test('the layout rules, without a browser: IC07\'s spread rule, spreads, turns, clamping, swipes and edge zones', () => {
  const page = {pageWidth: 1600, pageHeight: 2200};
  // 900 × 500 is the smallest viewport, and each fitted page must be 320 px wide or more (height-bound here).
  const area = (width: number, height: number) => ({viewportWidth: width, viewportHeight: height, areaWidth: width, areaHeight: height, ...page});
  assert.equal(chooseLayout(area(900, 500)), 'spread');
  assert.equal(chooseLayout(area(899, 500)), 'single');
  assert.equal(chooseLayout(area(900, 499)), 'single');
  assert.equal(chooseLayout({...area(1280, 800), areaHeight: 440}), 'spread', '440 × 8/11 = 320: inclusive');
  assert.equal(chooseLayout({...area(1280, 800), areaHeight: 439}), 'single');
  assert.equal(chooseLayout({...area(1280, 800), areaWidth: 640}), 'spread', 'half of 640 is 320');
  assert.equal(chooseLayout({...area(1280, 800), areaWidth: 639}), 'single');
  assert.equal(chooseLayout({...area(1280, 800), viewportWidth: Number.NaN}), 'single');
  assert.deepEqual(SPREAD_RULE, {minViewportWidth: 900, minViewportHeight: 500, minPageWidth: 320});
  for (const [viewport, expected] of VIEWPORTS.map((size) => [size, expectedLayout(size)] as const)) {
    // The spike's stage is the viewport less a 40 px register and a 48 px bar.
    assert.equal(chooseLayout({viewportWidth: viewport.width, viewportHeight: viewport.height, areaWidth: viewport.width, areaHeight: viewport.height - 88, ...page}), expected, label(viewport));
  }

  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => spreadOf(n, 8, 'spread')), [[1], [2, 3], [2, 3], [4, 5], [4, 5], [6, 7], [6, 7], [8]]);
  assert.deepEqual([6, 7].map((n) => spreadOf(n, 7, 'spread')), [[6, 7], [6, 7]], 'an odd count ends on a pair');
  assert.deepEqual(spreadOf(3, 8, 'single'), [3]);
  assert.deepEqual(spreadOf(99, 8, 'spread'), [8]);
  const walk = (layout: 'single' | 'spread'): number[] => {
    const pages = [1];
    for (let next = nextPage(1, 8, layout); next !== null; next = nextPage(next, 8, layout)) {
      pages.push(next);
    }
    return pages;
  };
  assert.deepEqual(walk('spread'), [1, 2, 4, 6, 8]);
  assert.deepEqual(walk('single'), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([8, 6, 4, 3, 2, 1].map((n) => previousPage(n, 8, 'spread')), [6, 4, 2, 1, 1, null], 'backward turns arrive at the first page of a spread');
  assert.deepEqual([0, -3, 2.7, 9, Number.NaN, Number.POSITIVE_INFINITY].map((n) => clampPage(n, 8)), [1, 1, 2, 8, 1, 1]);

  assert.equal(swipeDirection(-40, 0), 'next');
  assert.equal(swipeDirection(40, 0), 'previous');
  assert.equal(swipeDirection(-39.9, 0), null);
  const at = (degrees: number, length: number) => [Math.cos((degrees * Math.PI) / 180) * length, Math.sin((degrees * Math.PI) / 180) * length] as const;
  assert.equal(swipeDirection(-at(30, 60)[0], at(30, 60)[1]), 'next', '30° is inclusive');
  assert.equal(swipeDirection(-at(31, 60)[0], at(31, 60)[1]), null);

  assert.equal(EDGE_ZONE, 0.2);
  assert.deepEqual([0, 79, 80, 200, 320, 321, 400].map((x) => edgeZone(x, 400)), ['previous', 'previous', null, null, null, 'next', 'next']);
  assert.equal(edgeZone(10, 0), null);
});

// ---------------------------------------------------------------------------
// In the browsers.

type Shown = {page: number; left: number; right: number; top: number; bottom: number; width: number; height: number};
type Box = {left: number; right: number; top: number; bottom: number; width: number; height: number};
type View = {
  page: number;
  layout: string;
  visible: number[];
  state: string | null;
  shown: Shown[];
  stage: Box;
  calls: {flipNext: number; flipPrev: number; startAnimation: number; turnToPage: number};
  changes: [number, string][];
  panelClicks: string[];
  instant: boolean;
};

type Opened = {readonly page: Page; readonly requests: string[]};
type OpenOptions = {
  readonly manual?: boolean;
  readonly file?: boolean;
  readonly context?: BrowserContextOptions;
  readonly init?: () => void;
};

async function withSpike(browser: Browser, viewport: Viewport, options: OpenOptions, body: (opened: Opened) => Promise<void>): Promise<void> {
  const context = await browser.newContext({viewport, ...options.context});
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
    if (options.init !== undefined) {
      await page.addInitScript(options.init);
    }
    const query = options.manual === true ? '?manual' : '';
    await page.goto(options.file === true ? `${SPIKE_URL}${query}` : `${origin()}/spike/page-flip.html${query}`);
    if (options.context?.javaScriptEnabled !== false) {
      await page.waitForFunction(() => window.papeleriaSpike !== undefined);
      if (options.manual !== true) {
        await page.waitForFunction(() => window.papeleriaSpike?.adapter !== null);
      }
    }
    await body({page, requests});
    assert.deepEqual(errors, [], 'the page reported errors');
  } finally {
    await context.close();
  }
}

function start(page: Page, options: Partial<Pick<AdapterOptions, 'instant' | 'interactive' | 'startPage'>> = {}): Promise<void> {
  return page.evaluate((given) => {
    window.papeleriaSpike!.start(given);
  }, options);
}

function view(page: Page): Promise<View> {
  return page.evaluate(() => {
    const spike = window.papeleriaSpike!;
    const adapter = spike.adapter!;
    const box = (element: Element): Box => {
      const rect = element.getBoundingClientRect();
      return {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height};
    };
    const shown = Array.from(document.querySelectorAll<HTMLElement>('.spike-page'))
      // The engine's copy of a page during a portrait turn has no id (the adapter removes it).
      .filter((figure) => figure.id !== '' && getComputedStyle(figure).display !== 'none')
      .map((figure) => ({page: Number(figure.dataset['page']), ...box(figure)}))
      .sort((one, two) => one.left - two.left);
    return {
      page: adapter.page,
      layout: adapter.layout,
      visible: [...adapter.visible],
      state: spike.engineState(),
      shown,
      stage: box(document.getElementById('stage')!),
      calls: {...spike.calls},
      changes: spike.changes.map((change): [number, string] => [change.page, change.cause]),
      panelClicks: [...spike.panelClicks],
      instant: adapter.instant,
    };
  });
}

async function settled(page: Page): Promise<View> {
  await page.waitForFunction(() => window.papeleriaSpike?.engineState() === 'read');
  return view(page);
}

function near(actual: number, expected: number, what: string, tolerance = 1): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} is not within ${tolerance} of ${expected}`);
}

/** What the reader sees matches what the adapter says, and the book sits where IC07 puts it. */
function assertShown(state: View, expected: readonly number[], where: string): void {
  assert.deepEqual(state.visible, expected, `${where}: the adapter's pages`);
  assert.deepEqual(state.shown.map((shown) => shown.page), expected, `${where}: the pages on screen`);
  const {stage} = state;
  for (const shown of state.shown) {
    near(shown.width / shown.height, 1600 / 2200, `${where}: page ${shown.page}'s aspect`, 0.01);
    assert.ok(shown.left >= stage.left - 1 && shown.right <= stage.right + 1 && shown.top >= stage.top - 1 && shown.bottom <= stage.bottom + 1, `${where}: page ${shown.page} is inside the stage`);
  }
  const [first, second] = state.shown;
  assert.ok(first !== undefined);
  if (state.layout === 'single') {
    assert.ok(Math.abs(first.width - stage.width) <= 1 || Math.abs(first.height - stage.height) <= 1, `${where}: one page fitted to the stage`);
    near(first.left - stage.left, stage.right - first.right, `${where}: the page is centred`);
  } else if (second !== undefined) {
    near(first.right, second.left, `${where}: the pair meets at the spine`);
    near(first.width, second.width, `${where}: the pair has one size`);
    near(first.left - stage.left, stage.right - second.right, `${where}: the pair is centred`);
  } else {
    // Alone in a spread, the engine keeps the book's place: the cover on the right of the spine, the last page on its left.
    const spine = stage.left + stage.width / 2;
    near(first.page === 1 ? first.left : first.right, spine, `${where}: page ${first.page} beside the spine`);
  }
}

const {run, excluded} = selectedEngines();

for (const engine of excluded) {
  test(`${engine}: not run`, {skip: `PAPELERIA_BROWSERS=${process.env['PAPELERIA_BROWSERS'] ?? ''} leaves ${engine} out`}, () => {});
}

for (const engine of run) {
  describe(`DEP05 in ${engine}`, () => {
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

    test('1. the cover alone, then pairs 2–3, 4–5, 6–7, and the final page 8 alone; one page at a time where no spread fits', TIMEOUT, async (context) => {
      context.diagnostic(`${engine} ${use().version()}`);
      for (const viewport of VIEWPORTS) {
        await withSpike(use(), viewport, {manual: true}, async ({page}) => {
          await start(page, {instant: true});
          const spread = expectedLayout(viewport) === 'spread';
          const steps = spread ? [[1], [2, 3], [4, 5], [6, 7], [8]] : [[1], [2], [3], [4], [5], [6], [7], [8]];
          let state = await view(page);
          assert.equal(state.layout, expectedLayout(viewport), label(viewport));
          for (const [index, expected] of steps.entries()) {
            assertShown(state, expected, `${label(viewport)} step ${index + 1}`);
            await page.evaluate(() => window.papeleriaSpike!.adapter!.next());
            state = await view(page);
          }
          assertShown(state, [8], `${label(viewport)} past the end`);
          for (const [index, expected] of [...steps].reverse().entries()) {
            assertShown(state, expected, `${label(viewport)} back ${index + 1}`);
            await page.evaluate(() => window.papeleriaSpike!.adapter!.previous());
            state = await view(page);
          }
          assertShown(state, [1], `${label(viewport)} before the start`);

          // The curl reaches the same spread, through the engine's own animated path.
          await start(page, {instant: false});
          await page.evaluate(() => {
            window.papeleriaSpike!.resetCalls();
            window.papeleriaSpike!.adapter!.next();
          });
          assert.equal((await view(page)).state, 'flipping', `${label(viewport)}: a curl is running`);
          state = await settled(page);
          assertShown(state, spread ? [2, 3] : [2], `${label(viewport)} after the curl`);
          assert.equal(state.calls.flipNext, 1);
          assert.ok(state.calls.startAnimation >= 1);
          assert.deepEqual(state.changes, [[2, 'api']]);
          context.diagnostic(`${label(viewport)}: ${state.layout}; ${steps.map((step) => step.join('–')).join(', ')}`);
        });
      }
    });

    test('2. resizing keeps the logical page, shows its containing spread, and returns to that page', TIMEOUT, async () => {
      const [phone, tablet, desktop] = VIEWPORTS as [Viewport, Viewport, Viewport];
      const resizeTo = async (page: Page, viewport: Viewport): Promise<View> => {
        await page.setViewportSize(viewport);
        await page.waitForFunction((layout) => window.papeleriaSpike?.adapter?.layout === layout, expectedLayout(viewport));
        return view(page);
      };
      for (const first of VIEWPORTS) {
        await withSpike(use(), first, {manual: true}, async ({page}) => {
          await start(page, {instant: true});
          await page.evaluate(() => window.papeleriaSpike!.adapter!.turnTo(3));
          let state = await resizeTo(page, desktop);
          assertShown(state, [2, 3], `from ${label(first)} at page 3, widened`);
          assert.equal(state.page, 3, 'the logical page is still 3');
          state = await resizeTo(page, phone);
          assertShown(state, [3], 'narrowed again: page 3, not the spread\'s first page');
          state = await resizeTo(page, desktop);
          await page.evaluate(() => window.papeleriaSpike!.adapter!.next());
          state = await resizeTo(page, tablet);
          assertShown(state, [4], 'a turn in a spread lands on its first page, and single keeps it');
          await page.evaluate(() => window.papeleriaSpike!.adapter!.turnTo(8));
          state = await resizeTo(page, desktop);
          assertShown(state, [8], 'the final unpaired page stays alone');
          state = await resizeTo(page, phone);
          assertShown(state, [8], 'and single shows it');
          assert.ok(state.changes.some(([, cause]) => cause === 'resize'), 'a layout change is reported');
        });
      }
      // A resize during a curl completes the curl at once and keeps its page.
      await withSpike(use(), desktop, {manual: true}, async ({page}) => {
        await start(page, {instant: false});
        await page.evaluate(() => window.papeleriaSpike!.adapter!.next());
        const state = await resizeTo(page, phone);
        assert.equal(state.state, 'read');
        assertShown(state, [2], 'the curl finished, then page 2 alone');
      });
    });

    test('3. a press on a panel is the panel\'s: its click runs and the page does not turn; the guard is what stops the engine', TIMEOUT, async (context) => {
      for (const viewport of VIEWPORTS) {
        await withSpike(use(), viewport, {manual: true, context: {hasTouch: true}}, async ({page}) => {
          await start(page, {instant: false});
          // A point inside panel 1-2, which reaches the page's top right corner: in the right edge zone, and on the
          // button's label, a child of the button, which the engine alone takes for the page.
          const target = await page.evaluate((zone) => {
            const figure = document.getElementById('page-1')!.getBoundingClientRect();
            const stage = document.getElementById('stage')!.getBoundingClientRect();
            const x = figure.left + figure.width * 0.93;
            const y = figure.top + figure.height * 0.1;
            const hit = document.elementFromPoint(x, y);
            return {
              x,
              y,
              hit: hit?.className ?? '',
              panel: hit?.closest<HTMLElement>('.spike-panel')?.dataset['panel'] ?? '',
              inZone: x > stage.left + stage.width * (1 - zone),
              corner: {x: figure.left + figure.width * 0.985, y: figure.top + figure.height * 0.985},
              middle: {x: figure.left + figure.width * 0.5, y: figure.top + figure.height * 0.8},
              middleInZone: figure.left + figure.width * 0.5 > stage.left + stage.width * (1 - zone),
            };
          }, EDGE_ZONE);
          assert.equal(target.hit, 'spike-panel-label', 'the press lands on the label inside the button');
          assert.equal(target.panel, '1-2');
          assert.ok(target.inZone, `${label(viewport)}: the point is in the right edge zone`);

          await page.mouse.click(target.x, target.y);
          await page.waitForTimeout(150);
          let state = await view(page);
          assert.deepEqual(state.panelClicks, ['1-2'], 'the panel\'s click ran');
          assert.deepEqual([state.page, state.state, state.calls.startAnimation], [1, 'read', 0], `${label(viewport)}: a mouse click on a panel does not turn`);

          await page.touchscreen.tap(target.x, target.y);
          await page.waitForTimeout(400);
          state = await view(page);
          assert.deepEqual(state.panelClicks, ['1-2', '1-2'], 'the tap ran the panel\'s click too');
          assert.deepEqual([state.page, state.state, state.calls.startAnimation], [1, 'read', 0], `${label(viewport)}: a tap on a panel does not turn`);

          // Bare art away from the edges does nothing; bare art at the corner, in the edge zone, turns (the edge turn works).
          assert.ok(!target.middleInZone);
          await page.mouse.click(target.middle.x, target.middle.y);
          await page.waitForTimeout(150);
          state = await view(page);
          assert.deepEqual([state.page, state.calls.startAnimation, state.panelClicks.length], [1, 0, 2], 'a click in the middle of the art is not a turn');
          await page.mouse.click(target.corner.x, target.corner.y);
          state = await settled(page);
          assert.equal(state.page, 2, `${label(viewport)}: a click on bare art in the edge zone turns the page`);
          assert.ok(state.calls.startAnimation >= 1);

          // The control: with nothing counted as a control, the engine takes the same panel press for a page turn.
          await start(page, {instant: false, interactive: '[data-spike-nothing]'});
          await page.evaluate(() => window.papeleriaSpike!.resetCalls());
          await page.mouse.click(target.x, target.y);
          state = await settled(page);
          assert.equal(state.page, 2, `${label(viewport)}: without the guard the panel press turns the page`);
          assert.ok(state.calls.startAnimation >= 1);
          context.diagnostic(`${label(viewport)}: panel 1-2 at (${Math.round(target.x)}, ${Math.round(target.y)}) wins; bare corner turns; unguarded, the panel turns`);
        });
      }
    });

    test('4. without JavaScript every page and its <img src> is there, in order; with it, every page stays in the DOM', TIMEOUT, async () => {
      for (const viewport of VIEWPORTS) {
        await withSpike(use(), viewport, {context: {javaScriptEnabled: false}}, async ({page, requests}) => {
          const figures = page.locator('.spike-page');
          assert.equal(await figures.count(), TOTAL);
          for (let index = 0; index < TOTAL; index += 1) {
            const figure = figures.nth(index);
            assert.equal(await figure.getAttribute('id'), `page-${index + 1}`);
            assert.equal(await figure.locator('img').getAttribute('src'), `images/0${index + 1}.png`);
            assert.ok(await figure.isVisible(), `${label(viewport)}: page ${index + 1} shows`);
            assert.equal(await figure.locator('.spike-panel').count(), index === 0 ? 5 : 3);
          }
          assert.equal((await page.locator('#status').textContent())?.trim(), 'All pages are available without JavaScript.');
          assert.equal(await page.locator('html.js').count(), 0);
          assert.equal(await page.locator('[class*="stf__"]').count(), 0);
          for (let index = 1; index <= TOTAL; index += 1) {
            assert.ok(requests.some((url) => url.endsWith(`/images/0${index}.png`)), `page ${index}'s image is requested`);
          }
        });
        await withSpike(use(), viewport, {}, async ({page}) => {
          const pages = await page.evaluate(() =>
            Array.from(document.querySelectorAll<HTMLElement>('.spike-page[id]')).map((figure) => [figure.id, figure.querySelector('img')?.getAttribute('src'), figure.closest('.papeleria-engine') !== null]),
          );
          assert.deepEqual(pages, Array.from({length: TOTAL}, (_unused, index) => [`page-${index + 1}`, `images/0${index + 1}.png`, true]));
        });
      }
    });

    test('5. every <img> keeps its src after initialization and after turns, and is the same element', TIMEOUT, async () => {
      for (const viewport of VIEWPORTS) {
        await withSpike(use(), viewport, {manual: true}, async ({page}) => {
          await page.evaluate(() => {
            (window as unknown as {spikeImages: HTMLImageElement[]}).spikeImages = Array.from(document.querySelectorAll('img'));
          });
          const images = () =>
            page.evaluate(() => {
              const before = (window as unknown as {spikeImages: HTMLImageElement[]}).spikeImages;
              const now = Array.from(document.querySelectorAll<HTMLImageElement>('.spike-page[id] img'));
              return {
                same: now.length === before.length && now.every((image, index) => image === before[index]),
                src: now.map((image) => image.getAttribute('src')),
                srcset: now.map((image) => image.getAttribute('srcset')),
              };
            });
          const expected = Array.from({length: TOTAL}, (_unused, index) => `images/0${index + 1}.png`);
          await start(page, {instant: true});
          let state = await images();
          assert.deepEqual(state, {same: true, src: expected, srcset: Array(TOTAL).fill(null)}, `${label(viewport)} after initialization`);
          await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLImageElement>('.spike-page[id] img')).every((image) => image.complete && image.naturalWidth === 1600));
          for (let turn = 0; turn < TOTAL; turn += 1) {
            await page.evaluate(() => window.papeleriaSpike!.adapter!.next());
          }
          state = await images();
          assert.deepEqual(state, {same: true, src: expected, srcset: Array(TOTAL).fill(null)}, `${label(viewport)} after turns`);

          if (expectedLayout(viewport) === 'single') {
            // A soft page turning forward in portrait is shown as the engine's copy of it: inert, hidden, with no ids.
            await start(page, {instant: false, startPage: 2});
            await page.evaluate(() => window.papeleriaSpike!.adapter!.next());
            const copy = await page.evaluate(() => {
              const copies = Array.from(document.querySelectorAll<HTMLElement>('.spike-page')).filter((figure) => figure.id === '');
              const first = copies[0];
              return {
                count: copies.length,
                inert: first?.inert ?? null,
                hidden: first?.getAttribute('aria-hidden') ?? null,
                ids: first === undefined ? -1 : first.querySelectorAll('[id]').length,
                src: first?.querySelector('img')?.getAttribute('src') ?? null,
              };
            });
            assert.deepEqual(copy, {count: 1, inert: true, hidden: 'true', ids: 0, src: 'images/02.png'}, `${label(viewport)}: the engine's copy during the turn`);
            await settled(page);
            assert.equal(await page.evaluate(() => document.querySelectorAll('.spike-page:not([id])').length), 0, 'the copy is gone after the turn');
            assert.deepEqual((await images()).src, expected);
          }
        });
      }
    });

    test('6. from file:// the spike enhances, turns, and requests nothing outside its folder', TIMEOUT, async () => {
      for (const viewport of VIEWPORTS) {
        await withSpike(use(), viewport, {file: true}, async ({page, requests}) => {
          let state = await view(page);
          assert.equal(state.layout, expectedLayout(viewport));
          assertShown(state, [1], `${label(viewport)} from file://`);
          await page.evaluate(() => window.papeleriaSpike!.adapter!.next());
          state = await settled(page);
          assertShown(state, expectedLayout(viewport) === 'spread' ? [2, 3] : [2], `${label(viewport)} turned from file://`);
          const folder = pathToFileURL(SPIKE).href;
          assert.deepEqual(requests.filter((url) => !url.startsWith(`${folder}/`)), [], 'every request stays in the folder');
          // Playwright's Firefox fires no request event for a file:// load (CI, 2026-09-26): there the list holds network
          // requests alone, which test 4 shows it sees, and the enhanced, turning page is what shows spike.js loaded.
          if (engine !== 'firefox') {
            assert.ok(requests.includes(`${folder}/spike.js`), 'the request list sees file:// loads');
          }
        });
      }
    });

    test('7. reduced motion: every turn is an instant swap and no animated engine path is ever called; switching live finishes a curl', TIMEOUT, async (context) => {
      for (const viewport of VIEWPORTS) {
        await withSpike(use(), viewport, {context: {reducedMotion: 'reduce', hasTouch: true}}, async ({page}) => {
          let state = await view(page);
          assert.equal(state.instant, true, 'prefers-reduced-motion starts the adapter in instant mode');
          await page.evaluate(() => window.papeleriaSpike!.resetCalls());
          const spread = expectedLayout(viewport) === 'spread';
          // Each call is complete when it returns: the new page is on screen in the same task.
          const now = (action: 'next' | 'previous' | 'first' | 'five') =>
            page.evaluate((what) => {
              const adapter = window.papeleriaSpike!.adapter!;
              if (what === 'next') adapter.next();
              else if (what === 'previous') adapter.previous();
              else adapter.turnTo(what === 'first' ? 1 : 5);
              return Array.from(document.querySelectorAll<HTMLElement>('.spike-page[id]'))
                .filter((figure) => getComputedStyle(figure).display !== 'none')
                .map((figure) => Number(figure.dataset['page']))
                .sort((one, two) => one - two);
            }, action);
          assert.deepEqual(await now('next'), spread ? [2, 3] : [2]);
          assert.deepEqual(await now('next'), spread ? [4, 5] : [3]);
          assert.deepEqual(await now('previous'), spread ? [2, 3] : [2]);
          assert.deepEqual(await now('five'), spread ? [4, 5] : [5]);
          assert.deepEqual(await now('first'), [1]);

          // Gestures: a swipe on the art, a click in the edge zone and a drag are the adapter's, and instant.
          const figure = await page.evaluate(() => {
            const rect = document.getElementById('page-1')!.getBoundingClientRect();
            return {x: rect.left, y: rect.top, width: rect.width, height: rect.height};
          });
          await dispatchSwipe(page, '#page-1 img', {x: figure.x + figure.width * 0.6, y: figure.y + figure.height * 0.5}, {dx: -120, dy: 10});
          state = await view(page);
          assert.deepEqual(state.visible, spread ? [2, 3] : [2], `${label(viewport)}: the swipe turned instantly`);
          await page.evaluate(() => window.papeleriaSpike!.adapter!.turnTo(1));
          const corner = {x: figure.x + figure.width * 0.985, y: figure.y + figure.height * 0.985};
          await page.mouse.click(corner.x, corner.y);
          state = await view(page);
          assert.deepEqual(state.visible, spread ? [2, 3] : [2], `${label(viewport)}: the edge-zone click turned instantly`);
          await page.evaluate(() => window.papeleriaSpike!.adapter!.turnTo(1));
          await page.mouse.move(corner.x, figure.y + figure.height * 0.5);
          await page.mouse.down();
          await page.mouse.move(corner.x - figure.width * 0.3, figure.y + figure.height * 0.5, {steps: 5});
          await page.mouse.up();
          state = await view(page);
          assert.deepEqual(state.visible, spread ? [2, 3] : [2], `${label(viewport)}: the drag turned instantly`);
          assert.deepEqual(state.panelClicks, [], 'no panel was pressed');
          assert.deepEqual(
            {flipNext: state.calls.flipNext, flipPrev: state.calls.flipPrev, startAnimation: state.calls.startAnimation},
            {flipNext: 0, flipPrev: 0, startAnimation: 0},
            `${label(viewport)}: no animated engine call`,
          );
          assert.ok(state.calls.turnToPage >= 8);
          const motion = await page.evaluate(() => {
            const figure = document.getElementById('page-2')!;
            const style = getComputedStyle(figure);
            return [style.transitionDuration, style.animationName];
          });
          assert.deepEqual(motion, ['0s', 'none'], 'nothing on the page is a CSS transition or animation');
          context.diagnostic(`${label(viewport)}: ${state.calls.turnToPage} instant turns, 0 animated calls`);
        });

        // Live: a curl that is running when reduced motion comes on finishes at once, and the next turn is instant.
        await withSpike(use(), viewport, {}, async ({page}) => {
          let state = await view(page);
          assert.equal(state.instant, false);
          await page.evaluate(() => {
            window.papeleriaSpike!.resetCalls();
            window.papeleriaSpike!.adapter!.next();
          });
          assert.equal((await view(page)).state, 'flipping');
          await page.emulateMedia({reducedMotion: 'reduce'});
          await page.waitForFunction(() => window.papeleriaSpike?.adapter?.instant === true);
          state = await view(page);
          assert.equal(state.state, 'read', 'the curl finished at once');
          assert.equal(state.page, 2);
          await page.evaluate(() => window.papeleriaSpike!.adapter!.next());
          state = await view(page);
          assert.equal(state.page, expectedLayout(viewport) === 'spread' ? 4 : 3);
          assert.equal(state.calls.startAnimation, 1, 'only the curl already running was animated');
          assert.equal(state.calls.flipNext, 1);
        });
      }
    });

    test('8. destroy() removes every listener, observer, frame and element the adapter and the engine added, and restores the page DOM exactly', TIMEOUT, async () => {
      const track = (): void => {
        type Entry = {target: EventTarget; type: string; listener: unknown; capture: boolean; generation: number};
        const active: Entry[] = [];
        const observing: {observer: object; generation: number}[] = [];
        let generation = 0;
        let frames = 0;
        const capture = (options: unknown): boolean => (typeof options === 'boolean' ? options : typeof options === 'object' && options !== null && (options as {capture?: unknown}).capture === true);
        const add = EventTarget.prototype.addEventListener;
        const remove = EventTarget.prototype.removeEventListener;
        EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, listener: unknown, options?: unknown) {
          const flag = capture(options);
          if (listener !== null && !active.some((entry) => entry.target === this && entry.type === type && entry.listener === listener && entry.capture === flag)) {
            active.push({target: this, type, listener, capture: flag, generation});
          }
          return add.call(this, type, listener as EventListener, options as AddEventListenerOptions);
        } as typeof EventTarget.prototype.addEventListener;
        EventTarget.prototype.removeEventListener = function (this: EventTarget, type: string, listener: unknown, options?: unknown) {
          const flag = capture(options);
          const index = active.findIndex((entry) => entry.target === this && entry.type === type && entry.listener === listener && entry.capture === flag);
          if (index >= 0) {
            active.splice(index, 1);
          }
          return remove.call(this, type, listener as EventListener, options as EventListenerOptions);
        } as typeof EventTarget.prototype.removeEventListener;
        const frame = window.requestAnimationFrame;
        window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
          frames += 1;
          return frame.call(window, callback);
        };
        for (const kind of [ResizeObserver, MutationObserver]) {
          const observe = kind.prototype.observe as (this: object, ...args: unknown[]) => void;
          const disconnect = kind.prototype.disconnect as (this: object) => void;
          kind.prototype.observe = function (this: object, ...args: unknown[]) {
            if (!observing.some((entry) => entry.observer === this)) {
              observing.push({observer: this, generation});
            }
            observe.apply(this, args);
          } as never;
          kind.prototype.disconnect = function (this: object) {
            const index = observing.findIndex((entry) => entry.observer === this);
            if (index >= 0) {
              observing.splice(index, 1);
            }
            disconnect.call(this);
          } as never;
        }
        const name = (target: EventTarget): string => (target === window ? 'window' : target === document ? 'document' : target instanceof Element ? `${target.tagName.toLowerCase()}.${target.className}` : 'other');
        (window as unknown as {spikeTrack: unknown}).spikeTrack = {
          mark(): void {
            generation += 1;
          },
          left(): string[] {
            return [
              ...active.filter((entry) => entry.generation === generation).map((entry) => `${name(entry.target)} ${entry.type}${entry.capture ? ' (capture)' : ''}`),
              ...observing.filter((entry) => entry.generation === generation).map(() => 'an observer still observing'),
            ];
          },
          frames(): number {
            return frames;
          },
        };
      };
      type Track = {mark(): void; left(): string[]; frames(): number};
      const tracker = (page: Page) => ({
        mark: () => page.evaluate(() => (window as unknown as {spikeTrack: Track}).spikeTrack.mark()),
        left: () => page.evaluate(() => (window as unknown as {spikeTrack: Track}).spikeTrack.left()),
        frames: () => page.evaluate(() => (window as unknown as {spikeTrack: Track}).spikeTrack.frames()),
      });
      const snapshot = (page: Page) => page.evaluate(() => document.getElementById('stage')!.innerHTML);

      for (const viewport of VIEWPORTS) {
        await withSpike(use(), viewport, {manual: true, init: track}, async ({page}) => {
          const tracking = tracker(page);
          const original = await snapshot(page);
          await tracking.mark();
          await start(page, {instant: false});
          await page.evaluate(() => window.papeleriaSpike!.adapter!.next());
          await settled(page);
          await page.evaluate(() => {
            const adapter = window.papeleriaSpike!.adapter!;
            adapter.setInstant(true);
            adapter.next();
            adapter.turnTo(8);
          });
          assert.ok((await tracking.left()).length > 0, 'the tracking sees the adapter\'s and the engine\'s listeners');
          await page.evaluate(() => window.papeleriaSpike!.adapter!.destroy());
          assert.deepEqual(await tracking.left(), [], `${label(viewport)}: nothing is left listening or observing`);
          assert.equal(await snapshot(page), original, `${label(viewport)}: the page DOM is exactly as it was`);
          assert.equal(await page.evaluate(() => document.querySelectorAll('[class*="stf__"], .papeleria-engine').length), 0);
          const frames = await tracking.frames();
          await page.waitForTimeout(300);
          assert.equal(await tracking.frames(), frames, 'no frame is asked for after destroy()');
          assert.equal(await snapshot(page), original, 'and nothing restyles the pages later');

          // At once after create, and in the middle of a curl.
          await tracking.mark();
          await page.evaluate(() => {
            window.papeleriaSpike!.start({instant: false}).destroy();
          });
          await page.waitForTimeout(100);
          assert.deepEqual([await tracking.left(), await snapshot(page)], [[], original], `${label(viewport)}: destroyed at once`);
          await tracking.mark();
          await page.evaluate(() => {
            const adapter = window.papeleriaSpike!.start({instant: false});
            adapter.next();
            adapter.destroy();
          });
          await page.waitForTimeout(300);
          assert.deepEqual([await tracking.left(), await snapshot(page)], [[], original], `${label(viewport)}: destroyed mid-curl`);

          // And the book can be made again.
          await start(page, {instant: true});
          assertShown(await view(page), [1], `${label(viewport)} made again`);
        });
      }
    });

    test('9. one tap, one turn: under reduced motion the adapter takes a tap on bare art in an edge zone, and the mouse events a browser sends after the tap turn nothing more', TIMEOUT, async (context) => {
      const corner = (page: Page) =>
        page.evaluate(() => {
          const rect = document.getElementById('page-1')!.getBoundingClientRect();
          return {x: rect.left + rect.width * 0.985, y: rect.top + rect.height * 0.985};
        });
      for (const viewport of VIEWPORTS) {
        const spread = expectedLayout(viewport) === 'spread';
        // The browser's own tap: its touch events, then the mouse events and click it derives from them.
        await withSpike(use(), viewport, {manual: true, context: {hasTouch: true}}, async ({page}) => {
          await start(page, {instant: true});
          await page.evaluate(() => window.papeleriaSpike!.resetCalls());
          const at = await corner(page);
          await page.touchscreen.tap(at.x, at.y);
          await page.waitForTimeout(TAP_ECHO_MS);
          const state = await view(page);
          assert.deepEqual(state.visible, spread ? [2, 3] : [2], `${label(viewport)}: one tap turned one ${spread ? 'spread' : 'page'}`);
          assert.deepEqual(state.panelClicks, [], 'nothing was pressed on the page the tap revealed');
          assert.equal(state.calls.startAnimation, 0);
        });
        // The guard itself, whatever a browser does with a tap it saw prevented: a click where a touch has just
        // turned the page, at once, is that tap's echo and turns nothing; the same click after the echo window turns.
        await withSpike(use(), viewport, {manual: true, context: {hasTouch: true}}, async ({page}) => {
          await start(page, {instant: true});
          const at = await corner(page);
          await dispatchSwipe(page, '#page-1 img', at, {dx: 0, dy: 0}, {steps: 0});
          assert.equal((await view(page)).page, 2, 'the touch alone turned the page');
          await page.mouse.click(at.x, at.y);
          assert.equal((await view(page)).page, 2, `${label(viewport)}: a click at once, at the same point, is the tap's echo`);
          await page.waitForTimeout(TAP_ECHO_MS + 100);
          await page.mouse.click(at.x, at.y);
          assert.equal((await view(page)).page, spread ? 4 : 3, `${label(viewport)}: a click after the echo window turns`);
        });
        context.diagnostic(`${label(viewport)}: one tap, one turn; an echo within ${TAP_ECHO_MS} ms turns nothing`);
      }
    });

    test('10. a curl asked for at once, before the adapter has drawn a frame, still runs its whole length', TIMEOUT, async () => {
      for (const viewport of VIEWPORTS) {
        await withSpike(use(), viewport, {manual: true}, async ({page}) => {
          // Made and turned in one task, so no frame comes between: the engine's clock must still read the
          // current frame's time when the curl starts, or the first frame takes the curl for long over.
          const states = await page.evaluate(async () => {
            const spike = window.papeleriaSpike!;
            const adapter = spike.start({instant: false});
            adapter.next();
            const seen = [spike.engineState()];
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            seen.push(spike.engineState());
            return seen;
          });
          assert.deepEqual(states, ['flipping', 'flipping'], `${label(viewport)}: two frames on, the curl is still running`);
          const state = await settled(page);
          assert.equal(state.page, 2, `${label(viewport)}: and it ends on the next page`);
        });
      }
    });

    test('11. a curl asked for after a long task, with no frame since the last, still runs its whole length', TIMEOUT, async () => {
      for (const viewport of VIEWPORTS) {
        await withSpike(use(), viewport, {manual: true}, async ({page}) => {
          // The loop is running, then a task holds the thread for longer than a whole turn and asks for a curl as
          // it ends: the engine's clock must read the time the curl is asked for, not the last frame's.
          const states = await page.evaluate(async () => {
            const spike = window.papeleriaSpike!;
            const adapter = spike.start({instant: false});
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const until = performance.now() + 1000;
            while (performance.now() < until) {
              // No frame can come while this task runs.
            }
            adapter.next();
            const seen = [spike.engineState()];
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            seen.push(spike.engineState());
            return seen;
          });
          assert.deepEqual(states, ['flipping', 'flipping'], `${label(viewport)}: two frames on, the curl is still running`);
          const state = await settled(page);
          assert.equal(state.page, 2, `${label(viewport)}: and it ends on the next page`);
        });
      }
    });
  });
}
