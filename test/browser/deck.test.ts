/**
 * M1.6: the deck client in Chromium, Firefox and WebKit (D51).
 *
 * Every fixture is built at test time from reference/decks/brand-overview.html
 * by helpers/deck-fixture.ts and served from a loopback server; the file://
 * cases open the same files from disk. reference/ is only read.
 *
 * Covered in each engine: start-up state and re-labelling; keyboard navigation
 * and status text in English and Spanish; keys the deck must leave alone;
 * the Previous and Next buttons; the stacked view; speaker notes; reading,
 * clamping and correcting the address; hashchange and the skip link; swipes
 * and the gestures that must not turn a slide; focus on the title without
 * scrolling; the no-JS rendering; fullscreen refusal; print; the preview
 * hook point; reduced motion (A14, deck share); requests (C24, deck share);
 * one executable script and inert strings (C22); unusable strings blocks;
 * a start in a frame with no width (W5R-18); script placement; missing
 * tabindex; and file://.
 *
 * Expected status lines are built here from the strings files and the
 * reference titles, independently of the client's own formatting code.
 */
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, describe, test} from 'node:test';

import type {Browser, BrowserContext, BrowserContextOptions, Page} from 'playwright';

import type {PapeleriaDeck, SlideChangeDetail} from '../../templates/deck/client/deck-logic.js';
import {
  buildDeckFixture,
  readStringsFile,
  REFERENCE_DECK,
  type DeckFixture,
  type DeckFixtureOptions,
} from './helpers/deck-fixture.js';
import {launchEngine, selectedEngines} from './helpers/engines.js';
import {dispatchSwipe, trustedSwipe, type Point} from './helpers/gestures.js';
import {serveDirectory, type StaticServer} from './helpers/static-server.js';

type Strings = Readonly<Record<string, string>>;

const EN = readStringsFile('en');
const ES = readStringsFile('es');
const TOTAL = 16;
const TIMEOUT = {timeout: 90_000};

/** The reference titles as the status line reads them: each line break is a space. */
const TITLES = [...readFileSync(REFERENCE_DECK, 'utf8').matchAll(/<h2 class="slide-title" id="title-\d+">([\s\S]*?)<\/h2>/g)].map(
  (match) =>
    (match[1] ?? '')
      .replace(/<br\s*\/?>/g, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim(),
);

/** Fills a template with split/join, a different mechanism from the client's. */
function fill(template: string | undefined, values: readonly (readonly [string, string])[]): string {
  let text = template ?? '';
  for (const [name, value] of values) {
    text = text.split(`{${name}}`).join(value);
  }
  return text;
}

function slideStatus(strings: Strings, slide: number): string {
  return fill(strings['slide_of'], [
    ['n', String(slide)],
    ['total', String(TOTAL)],
    ['title', TITLES[slide - 1] ?? ''],
  ]);
}

function allStatus(strings: Strings): string {
  return fill(strings['all_shown'], [['total', String(TOTAL)]]);
}

function labelsOf(strings: Strings): DeckState['labels'] {
  return {
    previous: strings['previous'] ?? '',
    next: strings['next'] ?? '',
    showAll: strings['show_all'] ?? '',
    notes: strings['show_notes'] ?? '',
    fullscreen: strings['fullscreen'] ?? '',
    print: strings['print'] ?? '',
  };
}

function withoutKey(strings: Strings, key: string): Record<string, string> {
  const copy = {...strings};
  delete copy[key];
  return copy;
}

const HOSTILE = {
  previous: '</script><script>window.hostileRan = true</script><!--',
  next: 'A & B &amp; <b>bold</b> \u2028 \u2029 $& $1',
} as const;

const FIXTURES = {
  en: {},
  es: {language: 'es'},
  relabel: {language: 'es', labels: 'reference'},
  hostile: {strings: {...EN, ...HOSTILE}},
  'no-strings': {strings: 'omit'},
  'invalid-json': {strings: {raw: '{"previous": "Previous",'}},
  'missing-key': {strings: withoutKey(EN, 'slide_of')},
  'blank-value': {strings: {...EN, next: '  '}},
  'body-end': {script: 'body-end'},
  'no-tabindex': {titleTabindex: false},
  'one-slide': {slides: 1},
} as const satisfies Record<string, DeckFixtureOptions>;

type FixtureName = keyof typeof FIXTURES;

const workspace = mkdtempSync(join(tmpdir(), 'papeleria-deck-'));
const fixtures = new Map<FixtureName, DeckFixture>();
let server: StaticServer | undefined;

before(async () => {
  for (const [name, options] of Object.entries(FIXTURES) as [FixtureName, DeckFixtureOptions][]) {
    fixtures.set(name, buildDeckFixture(join(workspace, name), options));
  }
  server = await serveDirectory(workspace);
});

after(async () => {
  await server?.close();
  rmSync(workspace, {recursive: true, force: true});
});

function fixture(name: FixtureName): DeckFixture {
  const built = fixtures.get(name);
  if (built === undefined) {
    throw new Error(`the ${name} fixture was not built`);
  }
  return built;
}

function origin(): string {
  if (server === undefined) {
    throw new Error('the fixture server is not running');
  }
  return server.origin;
}

type Opened = {
  readonly page: Page;
  readonly context: BrowserContext;
  readonly requests: {readonly url: string; readonly type: string}[];
};

type OpenOptions = {
  readonly hash?: string;
  readonly file?: boolean;
  readonly context?: BrowserContextOptions;
  /** Runs in the page before any of its own scripts, from the moment the document exists. */
  readonly init?: () => void;
  /**
   * Holds back every stylesheet response this many milliseconds, so the deck's
   * script starts first and the stylesheets are the last files the page loads.
   */
  readonly stylesheetDelay?: number;
};

/** Opens a fixture in a fresh context, runs `body`, and fails on any page or console error. */
async function withDeck(
  browser: Browser,
  name: FixtureName,
  options: OpenOptions,
  body: (opened: Opened) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext({viewport: {width: 1280, height: 800}, ...options.context});
  const page = await context.newPage();
  const errors: string[] = [];
  const requests: {url: string; type: string}[] = [];
  page.on('pageerror', (error) => errors.push(`page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`console error: ${message.text()}`);
    }
  });
  page.on('request', (request) => requests.push({url: request.url(), type: request.resourceType()}));
  try {
    if (options.init !== undefined) {
      await page.addInitScript(options.init);
    }
    const stylesheetDelay = options.stylesheetDelay;
    if (stylesheetDelay !== undefined) {
      await page.route('**/*.css', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, stylesheetDelay));
        await route.continue();
      });
    }
    const address =
      options.file === true
        ? `${fixture(name).fileUrl}${options.hash ?? ''}`
        : `${origin()}/${name}/index.html${options.hash ?? ''}`;
    await page.goto(address);
    if (options.context?.javaScriptEnabled !== false) {
      // theme/css/fonts.css uses font-display:swap, so a face that arrives late
      // reflows the slides and moves whatever a test is measuring. Settle all
      // eight faces first; the first-view budget counts all eight anyway (IC04).
      await page.evaluate(async () => {
        await Promise.allSettled(Array.from(document.fonts, (face) => face.load()));
        await document.fonts.ready;
      });
    }
    await body({page, context, requests});
    assert.deepEqual(errors, [], 'the page reported errors');
  } finally {
    await context.close();
  }
}

type DeckState = {
  enhanced: boolean;
  visible: string[];
  status: string;
  hash: string;
  focus: string;
  labels: {previous: string; next: string; showAll: string; notes: string; fullscreen: string; print: string};
  pressed: {showAll: string | null; notes: string | null};
  disabled: {previous: boolean; next: boolean};
  notesShown: boolean;
};

function readState(page: Page): Promise<DeckState> {
  return page.evaluate(() => {
    const byId = (id: string): HTMLElement | null => document.getElementById(id);
    const text = (id: string): string => byId(id)?.textContent ?? '';
    const disabled = (id: string): boolean => {
      const element = byId(id);
      return element instanceof HTMLButtonElement && element.disabled;
    };
    const active = document.activeElement;
    return {
      enhanced: document.body.classList.contains('deck-enhanced'),
      visible: Array.from(document.querySelectorAll<HTMLElement>('.deck-slide'))
        .filter((slide) => getComputedStyle(slide).display !== 'none')
        .map((slide) => slide.id),
      status: text('deck-status'),
      hash: location.hash,
      focus: active === null || active === document.body ? 'body' : active.id || active.tagName.toLowerCase(),
      labels: {
        previous: text('prev-slide'),
        next: text('next-slide'),
        showAll: text('all-slides'),
        notes: text('toggle-notes'),
        fullscreen: text('full-deck'),
        print: text('print-deck'),
      },
      pressed: {
        showAll: byId('all-slides')?.getAttribute('aria-pressed') ?? null,
        notes: byId('toggle-notes')?.getAttribute('aria-pressed') ?? null,
      },
      disabled: {previous: disabled('prev-slide'), next: disabled('next-slide')},
      notesShown: document.body.classList.contains('show-slide-notes'),
    };
  });
}

/** Asserts the single visible slide, the status in `strings`, and optionally the address and focus. */
async function expectSlide(
  page: Page,
  slide: number,
  what: string,
  expected: {strings?: Strings; hash?: string; focus?: string} = {},
): Promise<DeckState> {
  const state = await readState(page);
  assert.deepEqual(state.visible, [`slide-${slide}`], `${what}: visible slide`);
  assert.equal(state.status, slideStatus(expected.strings ?? EN, slide), `${what}: status`);
  if (expected.hash !== undefined) {
    assert.equal(state.hash, expected.hash, `${what}: address`);
  }
  if (expected.focus !== undefined) {
    assert.equal(state.focus, expected.focus, `${what}: focus`);
  }
  return state;
}

async function waitForStatus(page: Page, text: string): Promise<void> {
  await page.waitForFunction((expected) => document.getElementById('deck-status')?.textContent === expected, text, {
    timeout: 5000,
  });
}

/** Counts hashchange events with a listener added after the deck's, so the deck has handled each one counted. */
async function hashChangeCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const record = window as unknown as {hashChanges?: number};
    if (record.hashChanges === undefined) {
      record.hashChanges = 0;
      window.addEventListener('hashchange', () => {
        record.hashChanges = (record.hashChanges ?? 0) + 1;
      });
    }
    return record.hashChanges;
  });
}

async function waitForHashChange(page: Page, seen: number): Promise<void> {
  await page.waitForFunction((count) => ((window as unknown as {hashChanges?: number}).hashChanges ?? 0) > count, seen, {
    timeout: 5000,
  });
}

async function changeHash(page: Page, hash: string): Promise<void> {
  const seen = await hashChangeCount(page);
  await page.evaluate((next) => {
    location.hash = next;
  }, hash);
  await waitForHashChange(page, seen);
}

/**
 * Scrolls the page at once and returns the offset reached. site.css sets
 * smooth scrolling, and an engine may read a stale computed style when
 * scrollTo runs, so the override is applied and read back first.
 */
async function scrollPageTo(page: Page, y: number): Promise<number> {
  return page.evaluate((target) => {
    const root = document.documentElement;
    root.style.setProperty('scroll-behavior', 'auto', 'important');
    if (getComputedStyle(root).scrollBehavior !== 'auto') {
      throw new Error('the scroll-behavior override did not apply');
    }
    window.scrollTo(0, target);
    root.style.removeProperty('scroll-behavior');
    if (root.getAttribute('style') === '') {
      root.removeAttribute('style');
    }
    return window.scrollY;
  }, y);
}

/**
 * Returns the scroll offset once the page has held still for five animation
 * frames, after at least ten. A smooth scroll the browser has started is still
 * moving then, so this reads where it ends rather than where it began.
 */
async function settledScrollY(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let frames = 0;
        let still = 0;
        let last = window.scrollY;
        const tick = (): void => {
          const y = window.scrollY;
          still = Math.abs(y - last) < 0.5 ? still + 1 : 0;
          last = y;
          frames += 1;
          if ((frames >= 10 && still >= 5) || frames >= 600) {
            resolve(y);
          } else {
            requestAnimationFrame(tick);
          }
        };
        requestAnimationFrame(tick);
      }),
  );
}

/** An init script: keeps the farthest the page has ever been scrolled, from before the deck starts. */
function recordScrolling(): void {
  const record = window as unknown as {farthest: number};
  record.farthest = 0;
  window.addEventListener('scroll', () => {
    record.farthest = Math.max(record.farthest, Math.abs(window.scrollX), Math.abs(window.scrollY));
  });
}

async function farthestScroll(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as {farthest: number}).farthest);
}

async function waitForAddress(page: Page, hash: string): Promise<void> {
  await page.waitForFunction((expected) => location.hash === expected, hash, {timeout: 5000});
}

/** Scrolls the stacked view as a reader would, so that a slide's top edge meets the top of the viewport, and blurs. */
async function scrollToSlide(page: Page, slide: number): Promise<void> {
  const offset = await page.evaluate(
    (id) => Math.round((document.getElementById(id)?.getBoundingClientRect().top ?? NaN) + window.scrollY),
    `slide-${slide}`,
  );
  const reached = await scrollPageTo(page, offset);
  assert.ok(Math.abs(reached - offset) <= 1, `the page could not be scrolled to slide ${slide} (${reached} of ${offset})`);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
}

/**
 * Asserts that the stacked view brought a slide to the top of the viewport,
 * or as far towards it as the page scrolls, and focused its title.
 */
async function expectBroughtIn(page: Page, slide: number, what: string): Promise<DeckState> {
  const seen = await page.evaluate((id) => {
    const end = document.documentElement.scrollHeight - window.innerHeight;
    return {
      top: document.getElementById(id)?.getBoundingClientRect().top ?? NaN,
      atEnd: Math.abs(window.scrollY - end) <= 1,
      height: window.innerHeight,
    };
  }, `slide-${slide}`);
  const atTop = seen.top >= -1 && seen.top <= 26;
  const asFarAsItScrolls = seen.atEnd && seen.top >= -1 && seen.top < seen.height;
  assert.ok(atTop || asFarAsItScrolls, `${what}: slide ${slide} should be at the top of the viewport, found ${seen.top}`);
  const state = await readState(page);
  assert.equal(state.focus, `title-${slide}`, `${what}: focus`);
  return state;
}

/** Records, for every keydown, whether a handler before the window's (the deck's, on document) prevented it. */
async function recordKeys(page: Page): Promise<void> {
  await page.evaluate(() => {
    const record = window as unknown as {keys: {key: string; prevented: boolean}[]};
    record.keys = [];
    window.addEventListener('keydown', (event) => {
      record.keys.push({key: event.key, prevented: event.defaultPrevented});
    });
  });
}

async function lastKey(page: Page): Promise<{key: string; prevented: boolean} | undefined> {
  return page.evaluate(() => (window as unknown as {keys: {key: string; prevented: boolean}[]}).keys.at(-1));
}

async function centerOf(page: Page, selector: string): Promise<Point> {
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) {
    throw new Error(`${selector} has no layout box`);
  }
  return {x: box.x + box.width / 2, y: box.y + Math.min(box.height / 2, 200)};
}

async function swipe(page: Page, selector: string, dx: number, dy: number, fingers = 1): Promise<void> {
  await dispatchSwipe(page, selector, await centerOf(page, selector), {dx, dy}, {fingers});
}

async function injectProbes(page: Page, slide: number): Promise<void> {
  await page.evaluate((id) => {
    const host = document.querySelector(`#${id} .slide-content`);
    if (host === null) {
      throw new Error(`#${id} has no .slide-content`);
    }
    host.insertAdjacentHTML(
      'afterbegin',
      '<input id="probe-input" value="text"><textarea id="probe-textarea">text</textarea>' +
        '<select id="probe-select"><option>a</option><option>b</option></select>' +
        '<div id="probe-editable" contenteditable="true">text</div>' +
        '<div class="table-wrap" id="probe-region" tabindex="0" role="region" aria-label="probe">' +
        '<div style="width:4000px;height:48px">wide</div></div>',
    );
  }, `slide-${slide}`);
}

function deckApi(page: Page): {
  goTo: (slide: number, focus?: boolean) => Promise<number>;
  read: () => Promise<Omit<PapeleriaDeck, 'goTo'>>;
} {
  return {
    goTo: (slide, focus) =>
      page.evaluate(
        ([target, moveFocus]) =>
          (window as unknown as {papeleriaDeck: PapeleriaDeck}).papeleriaDeck.goTo(
            target,
            moveFocus === undefined ? undefined : {focus: moveFocus},
          ),
        [slide, focus] as const,
      ),
    read: () =>
      page.evaluate(() => {
        const deck = (window as unknown as {papeleriaDeck: PapeleriaDeck}).papeleriaDeck;
        return {version: deck.version, total: deck.total, current: deck.current, showAll: deck.showAll, notes: deck.notes};
      }),
  };
}

test('the fixture is the reference deck turned into what CONTRACT.md specifies', () => {
  assert.equal(TITLES.length, TOTAL);
  assert.equal(TITLES[0], 'Craft with care. Build for the long view.');
  const html = readFileSync(fixture('en').indexPath, 'utf8');
  assert.equal(html.match(/<script\b/g)?.length, 2, 'one strings block and one script');
  assert.equal(html.match(/id="papeleria-strings"/g)?.length, 1);
  assert.equal(html.match(/<script src="deck\.js" defer><\/script>/g)?.length, 1);
  assert.equal(html.match(/tabindex="-1"/g)?.length, TOTAL);
  assert.ok(html.includes(`role="status">${EN['no_js_slides']}</p>`));
  assert.ok(!html.includes('../../theme/'), 'every theme path is inside the fixture');

  // IC02: the hostile block holds no raw <, >, &, U+2028 or U+2029, yet parses back to the same strings.
  const hostile = readFileSync(fixture('hostile').indexPath, 'utf8');
  const block = /<script type="application\/json" id="papeleria-strings">([\s\S]*?)<\/script>/.exec(hostile)?.[1];
  assert.ok(block !== undefined, 'the hostile strings block is missing');
  assert.doesNotMatch(block, /[<>&\u2028\u2029]/);
  assert.deepEqual(JSON.parse(block), {...EN, ...HOSTILE});
});

const {run, excluded} = selectedEngines();

for (const engine of excluded) {
  test(`${engine}: not run`, {skip: `PAPELERIA_BROWSERS=${process.env['PAPELERIA_BROWSERS'] ?? ''} leaves ${engine} out`}, () => {});
}

for (const engine of run) {
  describe(`deck client in ${engine}`, () => {
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

    test('launches', TIMEOUT, (context) => {
      context.diagnostic(`${engine} ${use().version()}`);
    });

    test('starts on slide 1 with localized labels, without moving focus or writing the address', TIMEOUT, async () => {
      await withDeck(use(), 'en', {}, async ({page}) => {
        const state = await expectSlide(page, 1, 'on load', {hash: '', focus: 'body'});
        assert.equal(state.enhanced, true);
        assert.equal(state.status, 'Slide 1 of 16: Craft with care. Build for the long view.');
        assert.deepEqual(state.labels, labelsOf(EN));
        assert.deepEqual(state.pressed, {showAll: 'false', notes: 'false'});
        assert.deepEqual(state.disabled, {previous: true, next: false});
        assert.equal(await page.locator('.slide-title[tabindex="-1"]').count(), TOTAL);
        assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('style')), false);
      });
    });

    test('keys turn slides, announce them, move focus to the title and rewrite the address', TIMEOUT, async () => {
      await withDeck(use(), 'en', {}, async ({page}) => {
        const entries = await page.evaluate(() => history.length);
        const steps: [string, number][] = [
          ['ArrowRight', 2],
          ['ArrowDown', 3],
          ['PageDown', 4],
          ['ArrowLeft', 3],
          ['ArrowUp', 2],
          ['PageUp', 1],
          ['End', 16],
          ['ArrowRight', 16],
          ['PageDown', 16],
          ['End', 16],
          ['Home', 1],
          ['ArrowLeft', 1],
          ['Home', 1],
        ];
        await recordKeys(page);
        let shown = 1;
        for (const [key, slide] of steps) {
          await page.keyboard.press(key);
          await expectSlide(page, slide, key, {hash: `#slide-${slide}`, focus: `title-${slide}`});
          // A key that changes nothing at either end keeps its browser behaviour.
          assert.deepEqual(await lastKey(page), {key, prevented: slide !== shown}, `${key} on slide ${shown}`);
          shown = slide;
        }
        assert.deepEqual((await readState(page)).disabled, {previous: true, next: false});
        await page.keyboard.press('End');
        assert.deepEqual((await readState(page)).disabled, {previous: false, next: true});
        assert.equal(await page.evaluate(() => history.length), entries, 'replaceState must not add history entries');
      });
    });

    test('keys are left alone with modifiers, in editable controls, in scroll regions and when already handled', TIMEOUT, async () => {
      await withDeck(use(), 'en', {}, async ({page}) => {
        for (const combination of ['Shift+ArrowRight', 'Alt+ArrowRight', 'Control+ArrowRight', 'Meta+ArrowRight']) {
          await page.keyboard.press(combination);
          assert.deepEqual((await readState(page)).visible, ['slide-1'], combination);
        }
        await injectProbes(page, 1);
        for (const id of ['probe-input', 'probe-textarea', 'probe-select', 'probe-editable', 'probe-region']) {
          await page.focus(`#${id}`);
          for (const key of ['ArrowRight', 'ArrowDown', 'PageDown', 'End']) {
            await page.keyboard.press(key);
            assert.deepEqual((await readState(page)).visible, ['slide-1'], `${key} in #${id}`);
          }
        }
        await page.evaluate(() => {
          if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
          }
          window.addEventListener(
            'keydown',
            (event) => {
              if (event.key === 'ArrowRight') {
                event.preventDefault();
              }
            },
            {capture: true, once: true},
          );
        });
        await page.keyboard.press('ArrowRight');
        assert.deepEqual((await readState(page)).visible, ['slide-1'], 'a key another handler already took');

        // Escape belongs to the preview's precedence order (IC06); the deck never takes it.
        await page.evaluate(() => {
          const record = window as unknown as {escapeTaken: boolean | null};
          record.escapeTaken = null;
          window.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
              record.escapeTaken = event.defaultPrevented;
            }
          });
        });
        await page.keyboard.press('Escape');
        assert.equal(await page.evaluate(() => (window as unknown as {escapeTaken: boolean | null}).escapeTaken), false);

        // Unlike the kit script, a focused button no longer swallows the keys (D53).
        await page.focus('#all-slides');
        await page.keyboard.press('ArrowRight');
        await expectSlide(page, 2, 'ArrowRight on a focused button', {focus: 'title-2'});
      });
    });

    test('the Previous and Next buttons turn slides and move focus to the title', TIMEOUT, async () => {
      await withDeck(use(), 'en', {}, async ({page}) => {
        await page.click('#next-slide');
        await expectSlide(page, 2, 'Next', {hash: '#slide-2', focus: 'title-2'});
        await page.click('#next-slide');
        await expectSlide(page, 3, 'Next again', {hash: '#slide-3', focus: 'title-3'});
        await page.click('#prev-slide');
        await expectSlide(page, 2, 'Previous', {hash: '#slide-2', focus: 'title-2'});
        await page.focus('#prev-slide');
        await page.keyboard.press('Enter');
        const state = await expectSlide(page, 1, 'Previous from the keyboard', {hash: '#slide-1', focus: 'title-1'});
        assert.deepEqual(state.disabled, {previous: true, next: false});
      });
    });

    test('Show all slides stacks every slide and jumps between them at once', TIMEOUT, async () => {
      await withDeck(use(), 'en', {}, async ({page}) => {
        await page.click('#all-slides');
        let state = await readState(page);
        assert.equal(state.visible.length, TOTAL);
        assert.equal(state.pressed.showAll, 'true');
        assert.equal(state.labels.showAll, EN['show_one']);
        assert.equal(state.status, allStatus(EN));
        assert.equal(state.status, 'All 16 slides shown.');

        await page.keyboard.press('ArrowRight');
        state = await readState(page);
        assert.equal(state.hash, '#slide-2');
        assert.equal(state.focus, 'title-2');
        assert.equal(state.visible.length, TOTAL);
        assert.equal(state.status, allStatus(EN));
        // site.css asks for smooth scrolling; the jump must still land at once.
        const top = await page.evaluate(() => document.getElementById('slide-2')?.getBoundingClientRect().top ?? NaN);
        assert.ok(top >= -1 && top <= 26, `slide 2 should be at the top of the viewport at once, found ${top}`);
        assert.equal(await page.evaluate(() => document.documentElement.getAttribute('style')), null);

        await page.keyboard.press('ArrowDown');
        assert.equal((await readState(page)).hash, '#slide-2', 'the down arrow scrolls the stacked view');
        await page.keyboard.press('End');
        state = await readState(page);
        assert.equal(state.hash, '#slide-16');
        assert.equal(state.focus, 'title-16');

        await page.click('#all-slides');
        state = await expectSlide(page, 16, 'back to one slide', {hash: '#slide-16'});
        assert.equal(state.pressed.showAll, 'false');
        assert.equal(state.labels.showAll, EN['show_all']);
      });
    });

    test('in the stacked view keys count from the slide in view, and their slide always comes to the top with focus (D53)', TIMEOUT, async () => {
      await withDeck(use(), 'en', {}, async ({page}) => {
        await page.click('#all-slides');
        await recordKeys(page);
        const press = async (key: string, slide: number, hash: string): Promise<void> => {
          await page.keyboard.press(key);
          const state = await expectBroughtIn(page, slide, key);
          assert.equal(state.hash, hash, `${key}: address`);
          assert.deepEqual(await lastKey(page), {key, prevented: true});
        };

        // The reader scrolls down to slide 8 by themselves; slide 1 is still current.
        await scrollToSlide(page, 8);
        await press('Home', 1, '');
        await press('End', 16, '#slide-16');
        // Back up at slide 2, End asks for the current slide: it still comes to them.
        await scrollToSlide(page, 2);
        await press('End', 16, '#slide-16');
        await scrollToSlide(page, 8);
        await press('PageDown', 9, '#slide-9');
        await scrollToSlide(page, 8);
        await press('PageUp', 7, '#slide-7');
        await scrollToSlide(page, 12);
        await press('ArrowRight', 13, '#slide-13');
        await scrollToSlide(page, 12);
        await press('ArrowLeft', 11, '#slide-11');

        // Past either end the deck does nothing, so the key keeps its browser behaviour.
        assert.equal(await scrollPageTo(page, 0), 0);
        await page.keyboard.press('PageUp');
        assert.deepEqual(await lastKey(page), {key: 'PageUp', prevented: false});
        await scrollPageTo(page, 1_000_000);
        await page.keyboard.press('PageDown');
        assert.deepEqual(await lastKey(page), {key: 'PageDown', prevented: false});
        const state = await readState(page);
        assert.equal(state.hash, '#slide-11');
        assert.equal(state.focus, 'title-11');
      });
    });

    test('Show speaker notes toggles the notes, aria-pressed and the label', TIMEOUT, async () => {
      await withDeck(use(), 'en', {}, async ({page}) => {
        const notes = page.locator('#slide-1 .slide-notes');
        assert.equal(await notes.isVisible(), false);
        await page.click('#toggle-notes');
        let state = await readState(page);
        assert.equal(state.notesShown, true);
        assert.equal(state.pressed.notes, 'true');
        assert.equal(state.labels.notes, EN['hide_notes']);
        assert.equal(await notes.isVisible(), true);
        await page.click('#toggle-notes');
        state = await readState(page);
        assert.equal(state.notesShown, false);
        assert.equal(state.pressed.notes, 'false');
        assert.equal(state.labels.notes, EN['show_notes']);
        assert.equal(await notes.isVisible(), false);
      });
    });

    test('an address opens its slide, clamps out-of-range numbers and corrects malformed ones (IC07, C5)', TIMEOUT, async () => {
      const cases: [hash: string, slide: number, address: string][] = [
        ['#slide-5', 5, '#slide-5'],
        ['#slide-99', 16, '#slide-16'],
        ['#slide-0', 1, '#slide-1'],
        ['#slide-abc', 1, '#slide-1'],
        ['#slide-007', 7, '#slide-7'],
        ['#slide-%31%30', 10, '#slide-10'],
        ['#no-such-anchor', 1, '#slide-1'],
        ['#title-5', 5, '#title-5'],
        ['#deck-main', 1, '#deck-main'],
      ];
      for (const [hash, slide, address] of cases) {
        await withDeck(use(), 'en', {hash}, async ({page}) => {
          await waitForAddress(page, address);
          const state = await expectSlide(page, slide, `opening ${hash}`, {hash: address});
          // The client never moves focus on load. A browser may focus a focusable
          // fragment target by itself, as Chromium does for #title-5.
          const allowed = hash === '#title-5' ? ['body', 'title-5'] : ['body'];
          assert.ok(allowed.includes(state.focus), `opening ${hash} moved focus to ${state.focus}`);
        });
      }
    });

    const corrections: [name: FixtureName, hash: string, address: string][] = [
      ['en', '#slide-0', '#slide-1'],
      ['en', '#slide-99', '#slide-16'],
      ['en', '#slide-abc', '#slide-1'],
      ['en', '#no-such-anchor', '#slide-1'],
      ['one-slide', '#slide-5', '#slide-1'],
    ];

    async function expectCorrectedInPlace(page: Page, name: FixtureName, hash: string, address: string, when: string): Promise<void> {
      await waitForAddress(page, address);
      const settled = await settledScrollY(page);
      assert.equal(settled, 0, `opening ${hash} in ${name}${when} left the page at ${settled}`);
      assert.equal(await farthestScroll(page), 0, `opening ${hash} in ${name}${when} scrolled the page`);
      const state = await readState(page);
      assert.deepEqual(state.visible, [address.slice(1)], `opening ${hash} in ${name}${when}`);
      assert.equal(state.focus, 'body', `opening ${hash} in ${name}${when}`);
    }

    test('correcting the address the deck was opened with does not scroll the page (IC07, C5)', TIMEOUT, async () => {
      for (const [name, hash, address] of corrections) {
        await withDeck(use(), name, {hash, init: recordScrolling}, async ({page}) => {
          await expectCorrectedInPlace(page, name, hash, address, '');
        });
      }
    });

    test('correcting the address does not scroll the page when the stylesheets arrive after the script (D165)', TIMEOUT, async () => {
      // WebKit runs a deferred script without waiting for stylesheets and puts
      // off the fragment scroll until the last one arrives; the scroll then reads
      // the address as it stands, and with nothing else loading the page's load
      // event comes first.
      for (const [name, hash, address] of corrections) {
        await withDeck(use(), name, {hash, init: recordScrolling, stylesheetDelay: 300}, async ({page}) => {
          await expectCorrectedInPlace(page, name, hash, address, ' with late stylesheets');
        });
      }
    });

    test('hashchange shows the addressed slide; after the skip link the address names the slide again', TIMEOUT, async () => {
      await withDeck(use(), 'en', {}, async ({page}) => {
        await changeHash(page, '#slide-7');
        await expectSlide(page, 7, '#slide-7', {hash: '#slide-7', focus: 'title-7'});
        await changeHash(page, '#slide-99');
        await expectSlide(page, 16, '#slide-99', {hash: '#slide-16', focus: 'title-16'});
        await changeHash(page, '#slide-x');
        await expectSlide(page, 1, '#slide-x', {hash: '#slide-1', focus: 'title-1'});
        await changeHash(page, '#title-9');
        await expectSlide(page, 9, '#title-9', {hash: '#title-9', focus: 'title-9'});

        // The skip link is the browser's business (D54): it scrolls to main and
        // moves the focus starting point there. Once it has, the address goes
        // back to naming the slide, without a history entry or a focus move of
        // the deck's own, so a reload stays on slide 9.
        const entries = await page.evaluate(() => history.length);
        const seen = await hashChangeCount(page);
        await page.focus('a.skip-link');
        await page.keyboard.press('Enter');
        await waitForHashChange(page, seen);
        const state = await expectSlide(page, 9, 'the skip link', {hash: '#slide-9'});
        assert.ok(!state.focus.startsWith('title-'), `the skip link left focus on ${state.focus}`);
        assert.equal(await page.evaluate(() => history.length), entries + 1, 'history entries after the skip link');
        await page.reload();
        await expectSlide(page, 9, 'reloading after the skip link', {hash: '#slide-9'});
      });
    });

    test('a slide change by script, address bar or history leaves the page where it was (CONTRACT §5)', TIMEOUT, async () => {
      for (const motion of ['no-preference', 'reduce'] as const) {
        await withDeck(use(), 'en', {context: {reducedMotion: motion}}, async ({page}) => {
          const address = page.url();
          await changeHash(page, '#slide-5');
          await expectSlide(page, 5, `${motion}: script`, {hash: '#slide-5', focus: 'title-5'});
          assert.equal(await settledScrollY(page), 0, `${motion}: a script's hash change scrolled the page`);

          // From part-way down, so "where it was" is not simply the top.
          const start = await scrollPageTo(page, 30);
          assert.ok(start > 0, `${motion}: the page could not be scrolled`);
          let seen = await hashChangeCount(page);
          await page.goto(`${address}#slide-9`);
          await waitForHashChange(page, seen);
          await expectSlide(page, 9, `${motion}: address bar`, {hash: '#slide-9', focus: 'title-9'});
          let settled = await settledScrollY(page);
          assert.ok(Math.abs(settled - start) <= 1, `${motion}: the address bar scrolled the page from ${start} to ${settled}`);

          seen = await hashChangeCount(page);
          await page.evaluate(() => history.back());
          await waitForHashChange(page, seen);
          await expectSlide(page, 5, `${motion}: history`, {hash: '#slide-5', focus: 'title-5'});
          settled = await settledScrollY(page);
          assert.ok(Math.abs(settled - start) <= 1, `${motion}: going back scrolled the page from ${start} to ${settled}`);
        });
      }
    });

    test('a swipe on the canvas turns the slide; short, steep, two-finger, selecting and off-canvas gestures do not', TIMEOUT, async () => {
      await withDeck(use(), 'en', {context: {viewport: {width: 390, height: 844}, hasTouch: true}}, async ({page}) => {
        await swipe(page, '#slide-1 .slide-canvas', -120, 0);
        await expectSlide(page, 2, 'swipe left', {hash: '#slide-2', focus: 'title-2'});
        await swipe(page, '#slide-2 .slide-canvas', 120, 0);
        await expectSlide(page, 1, 'swipe right', {hash: '#slide-1', focus: 'title-1'});

        await swipe(page, '#slide-1 .slide-canvas', -30, 0);
        await expectSlide(page, 1, 'a 30 px swipe');
        await swipe(page, '#slide-1 .slide-canvas', -100, -100);
        await expectSlide(page, 1, 'a 45° swipe');
        await swipe(page, '#slide-1 .slide-canvas', -120, 0, 2);
        await expectSlide(page, 1, 'a two-finger swipe');
        await swipe(page, '#slide-1 .slide-canvas', -100, 50);
        await expectSlide(page, 2, 'a 27° swipe');
        await swipe(page, '#slide-2 .slide-canvas', 120, 0);
        await expectSlide(page, 1, 'back');

        await page.evaluate(() => {
          const range = document.createRange();
          const title = document.getElementById('title-1');
          const selection = window.getSelection();
          if (title === null || selection === null) {
            throw new Error('no title or selection');
          }
          range.selectNodeContents(title);
          selection.removeAllRanges();
          selection.addRange(range);
        });
        await swipe(page, '#slide-1 .slide-canvas', -120, 0);
        await expectSlide(page, 1, 'a swipe while text is selected');
        await page.evaluate(() => window.getSelection()?.removeAllRanges());

        await swipe(page, '.deck-tools', -120, 0);
        await expectSlide(page, 1, 'a swipe on the tools row');
        await swipe(page, '.deck-header', -120, 0);
        await expectSlide(page, 1, 'a swipe on the header');
        await injectProbes(page, 1);
        await swipe(page, '#probe-region', -120, 0);
        await expectSlide(page, 1, 'a swipe inside a scroll region');

        await swipe(page, '#slide-1 .slide-canvas', -120, 0);
        await expectSlide(page, 2, 'a plain swipe afterwards', {hash: '#slide-2'});
      });
    });

    test('in the stacked view a swipe moves on from the slide swiped, even onto the current slide', TIMEOUT, async () => {
      await withDeck(use(), 'en', {context: {viewport: {width: 390, height: 844}, hasTouch: true}}, async ({page}) => {
        await page.click('#all-slides');
        // Slide 1 is current, but the reader swipes on slide 5: slide 6 follows.
        await swipe(page, '#slide-5 .slide-canvas', -120, 0);
        let state = await readState(page);
        assert.equal(state.hash, '#slide-6');
        assert.equal(state.focus, 'title-6');

        // Back at the top, with focus elsewhere, the same swipe asks for slide 6,
        // which is already current. It must still come into view and take focus.
        assert.equal(await scrollPageTo(page, 0), 0);
        await page.focus('#all-slides');
        assert.equal(await page.evaluate(() => window.scrollY), 0, 'focusing the button moved the page');
        await swipe(page, '#slide-5 .slide-canvas', -120, 0);
        state = await readState(page);
        assert.equal(state.hash, '#slide-6');
        assert.equal(state.focus, 'title-6');
        const top = await page.evaluate(() => document.getElementById('slide-6')?.getBoundingClientRect().top ?? NaN);
        assert.ok(top >= -1 && top <= 26, `slide 6 should be at the top of the viewport, found ${top}`);
      });
    });

    test('in the stacked view an outward swipe on the first or last slide does nothing', TIMEOUT, async () => {
      await withDeck(use(), 'en', {context: {viewport: {width: 390, height: 844}, hasTouch: true}}, async ({page}) => {
        await page.click('#all-slides');
        assert.equal(await deckApi(page).goTo(5), 5);
        await page.evaluate(() => {
          const record = window as unknown as {changes: number};
          record.changes = 0;
          document.addEventListener('slidechange', () => {
            record.changes += 1;
          });
        });
        const cases: [slide: number, dx: number][] = [
          [16, -120],
          [1, 120],
        ];
        for (const [slide, dx] of cases) {
          // With the slide part-way down the viewport, as a reader would have it.
          const offset = await page.evaluate(
            (id) => Math.round((document.getElementById(id)?.getBoundingClientRect().top ?? NaN) + window.scrollY),
            `slide-${slide}`,
          );
          await scrollPageTo(page, Math.max(0, offset - 300));
          const before = await page.evaluate(() => ({scrollY: Math.round(window.scrollY), focus: document.activeElement?.id ?? ''}));
          await swipe(page, `#slide-${slide} .slide-canvas`, dx, 0);
          const after = await page.evaluate(() => ({scrollY: Math.round(window.scrollY), focus: document.activeElement?.id ?? ''}));
          assert.deepEqual(after, before, `an outward swipe on slide ${slide}`);
          assert.equal((await readState(page)).hash, '#slide-5', `an outward swipe on slide ${slide}: address`);
        }
        assert.equal(await page.evaluate(() => (window as unknown as {changes: number}).changes), 0, 'slidechange events');
      });
    });

    if (engine === 'chromium') {
      test('trusted touch input through the browser turns the slide, and a vertical drag does not (Chromium)', TIMEOUT, async () => {
        await withDeck(use(), 'en', {context: {viewport: {width: 390, height: 844}, hasTouch: true}}, async ({page}) => {
          await trustedSwipe(page, await centerOf(page, '#slide-1 .slide-canvas'), {dx: -150, dy: 0});
          await page.waitForFunction(() => location.hash === '#slide-2', undefined, {timeout: 5000});
          await expectSlide(page, 2, 'trusted swipe', {focus: 'title-2'});
          await trustedSwipe(page, await centerOf(page, '#slide-2 .slide-canvas'), {dx: -20, dy: -160});
          await expectSlide(page, 2, 'trusted vertical drag', {hash: '#slide-2'});
        });
      });
    }

    test('focus moves to the title without scrolling the page', TIMEOUT, async () => {
      await withDeck(use(), 'en', {context: {viewport: {width: 1280, height: 240}, hasTouch: true}}, async ({page}) => {
        const below = await page.evaluate(
          () => Math.ceil((document.getElementById('title-1')?.getBoundingClientRect().bottom ?? NaN) + window.scrollY) + 16,
        );
        const scrolled = await scrollPageTo(page, below);
        assert.ok(Math.abs(scrolled - below) <= 1, `the page could not be scrolled below the first title (${scrolled} of ${below})`);
        const check = async (slide: number, how: string): Promise<void> => {
          const seen = await page.evaluate(
            (id) => ({
              focus: document.activeElement?.id ?? '',
              scrollY: window.scrollY,
              bottom: document.getElementById(id)?.getBoundingClientRect().bottom ?? NaN,
            }),
            `title-${slide}`,
          );
          assert.equal(seen.focus, `title-${slide}`, `${how}: focus`);
          assert.ok(Math.abs(seen.scrollY - scrolled) <= 1, `${how} scrolled the page from ${scrolled} to ${seen.scrollY}`);
          assert.ok(seen.bottom < 0, `${how}: the focused title should still be above the viewport, at ${seen.bottom}`);
        };
        await page.keyboard.press('ArrowRight');
        await check(2, 'a key');
        await swipe(page, '#slide-2 .slide-canvas', -120, 0);
        await check(3, 'a swipe');
        await page.evaluate(() => {
          const next = document.getElementById('next-slide');
          if (next instanceof HTMLButtonElement) {
            next.click();
          }
        });
        await check(4, 'the Next button');
        assert.equal(await deckApi(page).goTo(6, true), 6);
        await check(6, 'goTo with focus');
      });
    });

    test('without JavaScript every slide and note shows, with the no_js_slides status', TIMEOUT, async () => {
      for (const [name, strings] of [
        ['en', EN],
        ['es', ES],
      ] as const) {
        await withDeck(use(), name, {context: {javaScriptEnabled: false}}, async ({page}) => {
          const slides = page.locator('.deck-slide');
          const notes = page.locator('.slide-notes');
          assert.equal(await slides.count(), TOTAL);
          for (let position = 0; position < TOTAL; position += 1) {
            assert.equal(await slides.nth(position).isVisible(), true, `${name} slide ${position + 1}`);
            assert.equal(await notes.nth(position).isVisible(), true, `${name} notes ${position + 1}`);
          }
          assert.equal(await page.locator('#deck-status').textContent(), strings['no_js_slides']);
          assert.equal(await page.locator('body.deck-enhanced').count(), 0);
          assert.equal(await page.locator('[hidden]').count(), 0);
        });
      }
    });

    test('Spanish strings drive every label and status line', TIMEOUT, async () => {
      await withDeck(use(), 'es', {}, async ({page}) => {
        let state = await expectSlide(page, 1, 'on load', {strings: ES});
        assert.equal(state.status, 'Diapositiva 1 de 16: Craft with care. Build for the long view.');
        assert.deepEqual(state.labels, labelsOf(ES));
        await page.keyboard.press('ArrowRight');
        await expectSlide(page, 2, 'ArrowRight', {strings: ES, hash: '#slide-2'});
        await page.click('#all-slides');
        state = await readState(page);
        assert.equal(state.status, allStatus(ES));
        assert.equal(state.status, 'Se muestran las 16 diapositivas.');
        assert.equal(state.labels.showAll, ES['show_one']);
        await page.click('#all-slides');
        await page.click('#toggle-notes');
        assert.equal((await readState(page)).labels.notes, ES['hide_notes']);
        await page.evaluate(() => {
          document.documentElement.requestFullscreen = () => Promise.reject(new TypeError('refused'));
        });
        await page.click('#full-deck');
        await waitForStatus(page, ES['fullscreen_denied'] ?? '');
      });
    });

    test('server-rendered labels are replaced from the strings block', TIMEOUT, async () => {
      await withDeck(use(), 'relabel', {}, async ({page}) => {
        const html = readFileSync(fixture('relabel').indexPath, 'utf8');
        assert.ok(html.includes('id="prev-slide">Previous</button>'), 'the markup keeps the English labels');
        assert.deepEqual((await readState(page)).labels, labelsOf(ES));
      });
    });

    test('a refused or missing fullscreen writes fullscreen_denied and changes nothing else', TIMEOUT, async () => {
      await withDeck(use(), 'en', {}, async ({page}) => {
        await page.keyboard.press('ArrowRight');
        await page.evaluate(() => {
          document.documentElement.requestFullscreen = () => Promise.reject(new TypeError('refused'));
        });
        await page.click('#full-deck');
        await waitForStatus(page, EN['fullscreen_denied'] ?? '');
        let state = await readState(page);
        assert.deepEqual(state.visible, ['slide-2']);
        assert.equal(state.hash, '#slide-2');
        assert.equal(await page.evaluate(() => document.fullscreenElement), null);
        await page.keyboard.press('ArrowRight');
        await expectSlide(page, 3, 'navigation after a refusal');

        await page.evaluate(() => {
          Object.defineProperty(document, 'fullscreenEnabled', {configurable: true, get: () => false});
        });
        await page.click('#full-deck');
        await waitForStatus(page, EN['fullscreen_denied'] ?? '');
        state = await readState(page);
        assert.deepEqual(state.visible, ['slide-3']);
      });
    });

    test('Print / Save PDF calls window.print', TIMEOUT, async () => {
      await withDeck(use(), 'en', {}, async ({page}) => {
        await page.evaluate(() => {
          const record = window as unknown as {printed: number};
          record.printed = 0;
          window.print = () => {
            record.printed += 1;
          };
        });
        await page.click('#print-deck');
        assert.equal(await page.evaluate(() => (window as unknown as {printed: number}).printed), 1);
      });
    });

    test('window.papeleriaDeck and slidechange serve the preview bridge (D52)', TIMEOUT, async () => {
      await withDeck(use(), 'en', {}, async ({page}) => {
        const deck = deckApi(page);
        await page.evaluate(() => {
          const record = window as unknown as {changes: SlideChangeDetail[]};
          record.changes = [];
          document.addEventListener('slidechange', (event) => {
            record.changes.push((event as CustomEvent<SlideChangeDetail>).detail);
          });
        });
        assert.deepEqual(await deck.read(), {version: 1, total: TOTAL, current: 1, showAll: false, notes: false});

        assert.equal(await deck.goTo(5), 5);
        await expectSlide(page, 5, 'goTo(5)', {hash: '#slide-5', focus: 'body'});
        assert.equal(await deck.goTo(99), 16);
        assert.equal(await deck.goTo(0), 1);
        assert.equal(await deck.goTo(Number.NaN), 1);
        assert.equal(await deck.goTo(3, true), 3);
        assert.equal((await readState(page)).focus, 'title-3');
        await page.keyboard.press('ArrowRight');
        await page.click('#all-slides');
        await page.click('#toggle-notes');
        assert.deepEqual(await deck.read(), {version: 1, total: TOTAL, current: 4, showAll: true, notes: true});

        const changes = await page.evaluate(() => (window as unknown as {changes: SlideChangeDetail[]}).changes);
        const common = {total: TOTAL, showAll: false, notes: false};
        assert.deepEqual(changes, [
          {slide: 5, previous: 1, ...common, cause: 'api'},
          {slide: 16, previous: 5, ...common, cause: 'api'},
          {slide: 1, previous: 16, ...common, cause: 'api'},
          {slide: 3, previous: 1, ...common, cause: 'api'},
          {slide: 4, previous: 3, ...common, cause: 'key'},
        ]);
      });
    });

    test('nothing moves on a slide change, and reduced motion leaves no transition at all (A14, deck share)', TIMEOUT, async () => {
      for (const motion of ['no-preference', 'reduce'] as const) {
        await withDeck(use(), 'en', {context: {reducedMotion: motion}}, async ({page}) => {
          const running = (): Promise<string[]> =>
            page.evaluate(() =>
              document.getAnimations().map((animation) => {
                const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
                const classes = target === null ? '' : Array.from(target.classList, (name) => `.${name}`).join('');
                const what = animation instanceof CSSTransition ? animation.transitionProperty : animation.constructor.name;
                return `${target === null ? 'nothing' : `${target.tagName.toLowerCase()}${classes}#${target.id}`}: ${what}`;
              }),
            );
          // Enabling Previous changes a button's opacity, which the theme animates
          // for 160 ms in normal motion (UX §01). Nothing else may move, and under
          // reduced motion nothing at all.
          const expectStill = async (when: string): Promise<void> => {
            const animations = await running();
            if (motion === 'reduce') {
              assert.deepEqual(animations, [], `${motion}: animations ${when}`);
            } else {
              for (const animation of animations) {
                assert.match(animation, /^button\.button[.a-z-]*#[a-z-]+: opacity$/, `${motion}: ${animation} ${when}`);
              }
            }
          };
          await page.keyboard.press('ArrowRight');
          await expectStill('after a key');
          assert.equal((await readState(page)).focus, 'title-2', `${motion}: focus after a key`);

          // Keyboard only from here, so no pointer hovers a button. At the top
          // of the stacked view slide 1 is in view: the first key brings the
          // current slide, 2, to the top and the second turns to slide 3 (D53).
          await page.focus('#all-slides');
          await page.keyboard.press('Enter');
          await page.keyboard.press('ArrowRight');
          await page.keyboard.press('ArrowRight');
          const top = await page.evaluate(() => document.getElementById('slide-3')?.getBoundingClientRect().top ?? NaN);
          assert.ok(top >= -1 && top <= 26, `${motion}: slide 3 should be at the top at once, found ${top}`);
          await expectStill('after a jump in the stacked view');

          const moving = await page.evaluate(() =>
            Array.from(document.querySelectorAll('*')).flatMap((element) => {
              const style = getComputedStyle(element);
              const seconds = (value: string): number[] => value.split(',').map((part) => Number.parseFloat(part) || 0);
              const transition = seconds(style.transitionDuration).some((value) => value > 0);
              const animation =
                style.animationName.split(',').some((name) => name.trim() !== 'none') &&
                seconds(style.animationDuration).some((value) => value > 0);
              if (!transition && !animation) {
                return [];
              }
              const classes = Array.from(element.classList, (name) => `.${name}`).join('');
              return [`${element.tagName.toLowerCase()}${classes}#${element.id}: ${style.transitionProperty} ${style.transitionDuration}`];
            }),
          );
          if (motion === 'reduce') {
            assert.deepEqual(moving, [], 'reduced motion must leave no transition or animation');
            assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior), 'auto');
          } else {
            // The theme's one motion is the buttons' 160 ms opacity change; the client adds none.
            assert.ok(moving.length > 0, 'the theme button transition is missing, so this check proves nothing');
            for (const item of moving) {
              assert.match(item, /^button\.button(?:\.secondary)?#[a-z-]+: opacity 0\.16s$/, item);
            }
          }
        });
      }
    });

    test('switched live: reduced motion stops the theme\'s one transition at once, and the slide and focus stay (A14, deck share, W4)', TIMEOUT, async () => {
      await withDeck(use(), 'en', {context: {reducedMotion: 'no-preference'}}, async ({page}) => {
        const moving = (): Promise<string[]> =>
          page.evaluate(() =>
            Array.from(document.querySelectorAll('*')).flatMap((element) => {
              const style = getComputedStyle(element);
              const seconds = (value: string): number[] => value.split(',').map((part) => Number.parseFloat(part) || 0);
              const transition = seconds(style.transitionDuration).some((value) => value > 0);
              const animation = style.animationName.split(',').some((name) => name.trim() !== 'none') && seconds(style.animationDuration).some((value) => value > 0);
              return transition || animation ? [`${element.tagName.toLowerCase()}#${element.id}: ${style.transitionProperty} ${style.transitionDuration}`] : [];
            }),
          );
        await page.keyboard.press('ArrowRight');
        const before = await readState(page);
        assert.ok((await moving()).length > 0, 'with motion, the theme\'s buttons fade');
        await page.emulateMedia({reducedMotion: 'reduce'});
        assert.deepEqual(await moving(), [], 'switched on, nothing moves');
        let state = await readState(page);
        assert.deepEqual([state.visible, state.focus], [before.visible, before.focus], 'the slide and focus stay');
        await page.keyboard.press('ArrowRight');
        await expectSlide(page, 3, 'a turn under reduced motion', {focus: 'title-3'});
        assert.deepEqual(await moving(), []);
        await page.emulateMedia({reducedMotion: 'no-preference'});
        assert.ok((await moving()).length > 0, 'switched off, the fade is back');
        state = await readState(page);
        assert.deepEqual(state.visible, ['slide-3']);
      });
    });

    test('it loads only its own files and makes no request of its own (C24, deck share)', TIMEOUT, async () => {
      await withDeck(use(), 'en', {context: {hasTouch: true}}, async ({page, requests}) => {
        await page.evaluate(() => {
          window.print = () => undefined;
          document.documentElement.requestFullscreen = () => Promise.reject(new TypeError('refused'));
        });
        for (const key of ['ArrowRight', 'End', 'Home']) {
          await page.keyboard.press(key);
        }
        for (const id of ['all-slides', 'all-slides', 'toggle-notes', 'full-deck', 'print-deck', 'next-slide', 'prev-slide']) {
          await page.click(`#${id}`);
        }
        await swipe(page, '#slide-1 .slide-canvas', -120, 0);
        await deckApi(page).goTo(4);
        await changeHash(page, '#slide-9');

        const root = `${origin()}/en/`;
        assert.ok(requests.some((request) => request.url === `${root}deck.js` && request.type === 'script'), 'deck.js was not loaded');
        for (const request of requests) {
          assert.ok(request.url.startsWith(root), `${request.type} request outside the fixture: ${request.url}`);
          assert.ok(
            !['fetch', 'xhr', 'websocket', 'eventsource', 'ping', 'manifest'].includes(request.type),
            `${request.type} request ${request.url}`,
          );
          const path = decodeURIComponent(new URL(request.url).pathname).slice('/en/'.length);
          assert.ok(existsSync(join(fixture('en').directory, path)), `a request for a file the fixture lacks: ${path}`);
        }
      });
    });

    test('one executable script, and a hostile strings block stays inert text (C22, IC02)', TIMEOUT, async () => {
      await withDeck(use(), 'hostile', {}, async ({page}) => {
        const scripts = await page.evaluate(() =>
          Array.from(document.scripts, (script) => ({src: script.getAttribute('src'), type: script.getAttribute('type'), id: script.id})),
        );
        assert.deepEqual(scripts, [
          {src: null, type: 'application/json', id: 'papeleria-strings'},
          {src: 'deck.js', type: null, id: ''},
        ]);
        assert.equal(await page.evaluate(() => 'hostileRan' in window), false);
        const state = await readState(page);
        assert.equal(state.enhanced, true);
        assert.equal(state.labels.previous, HOSTILE.previous);
        assert.equal(state.labels.next, HOSTILE.next);

        // A title holding markup-like text, "$&" and a placeholder is inserted as written.
        const title = 'Costs {total} $& <i>x</i>';
        await page.evaluate((text) => {
          const element = document.getElementById('title-2');
          if (element !== null) {
            element.textContent = text;
          }
        }, title);
        await page.keyboard.press('ArrowRight');
        assert.equal(
          (await readState(page)).status,
          fill(EN['slide_of'], [
            ['n', '2'],
            ['total', String(TOTAL)],
            ['title', title],
          ]),
        );
      });
    });

    test('a missing or unusable strings block leaves the page exactly as published', TIMEOUT, async () => {
      for (const name of ['no-strings', 'invalid-json', 'missing-key', 'blank-value'] as const) {
        await withDeck(use(), name, {}, async ({page}) => {
          let state = await readState(page);
          assert.equal(state.enhanced, false, name);
          assert.equal(state.visible.length, TOTAL, name);
          assert.equal(state.status, EN['no_js_slides'], name);
          assert.equal(await page.evaluate(() => 'papeleriaDeck' in window), false, name);
          await page.keyboard.press('ArrowRight');
          state = await readState(page);
          assert.equal(state.visible.length, TOTAL, `${name}: a key changed the page`);
          assert.equal(state.hash, '', name);
        });
      }
    });

    test('in a frame with no width the deck starts whole, since it measures nothing to start, and works once the frame has room (W5R-18)', TIMEOUT, async () => {
      // The comic's case (CONTRACT §5 there): a page of the server's own framing the deck at no width, with its own icon.
      writeFileSync(
        join(workspace, 'zero-width.html'),
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A deck in a frame</title><link rel="icon" href="data:,"></head><body>' +
          '<iframe id="deck" src="en/index.html" style="width:0;height:600px;border:0"></iframe></body></html>\n',
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
        await page.goto(`${origin()}/zero-width.html`);
        // A frame with no width is never visible: waited for as attached.
        const frame = await (await page.waitForSelector('#deck', {state: 'attached'})).contentFrame();
        assert.ok(frame !== null, 'the frame');
        await frame.waitForLoadState('load');
        const started = await frame.evaluate(() => ({
          width: window.innerWidth,
          deck: 'papeleriaDeck' in window,
          enhanced: document.body.classList.contains('deck-enhanced'),
          shown: Array.from(document.querySelectorAll<HTMLElement>('.deck-slide')).filter((slide) => !slide.hidden).map((slide) => slide.id),
          status: document.getElementById('deck-status')?.textContent,
        }));
        assert.deepEqual(started, {width: 0, deck: true, enhanced: true, shown: ['slide-1'], status: slideStatus(EN, 1)}, 'the whole start, not a part of it');

        await page.evaluate(() => {
          document.getElementById('deck')!.style.width = '1000px';
        });
        await frame.waitForFunction(() => window.innerWidth === 1000);
        await frame.click('#next-slide');
        await frame.waitForFunction((expected) => document.getElementById('deck-status')?.textContent === expected, slideStatus(EN, 2));
        assert.deepEqual(
          await frame.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.deck-slide')).filter((slide) => getComputedStyle(slide).display !== 'none').map((slide) => slide.id)),
          ['slide-2'],
        );
        assert.deepEqual(errors, [], 'the page reported errors');
      } finally {
        await context.close();
      }
    });

    test('it also runs as a classic script at the end of body', TIMEOUT, async () => {
      await withDeck(use(), 'body-end', {}, async ({page}) => {
        await expectSlide(page, 1, 'on load');
        await page.keyboard.press('ArrowRight');
        await expectSlide(page, 2, 'ArrowRight', {hash: '#slide-2', focus: 'title-2'});
      });
    });

    test('titles get tabindex="-1" when the markup lacks it', TIMEOUT, async () => {
      await withDeck(use(), 'no-tabindex', {}, async ({page}) => {
        assert.ok(!readFileSync(fixture('no-tabindex').indexPath, 'utf8').includes('tabindex'));
        assert.equal(await page.locator('.slide-title[tabindex="-1"]').count(), TOTAL);
        await page.keyboard.press('ArrowRight');
        await expectSlide(page, 2, 'ArrowRight', {focus: 'title-2'});
      });
    });

    test('it works when opened from a file:// URL', TIMEOUT, async () => {
      await withDeck(use(), 'en', {file: true}, async ({page}) => {
        assert.match(page.url(), /^file:\/\//);
        const state = await expectSlide(page, 1, 'on load');
        assert.equal(state.enhanced, true);
        await page.keyboard.press('ArrowRight');
        await expectSlide(page, 2, 'ArrowRight', {hash: '#slide-2', focus: 'title-2'});
        await changeHash(page, '#slide-5');
        await expectSlide(page, 5, 'hashchange', {hash: '#slide-5', focus: 'title-5'});
      });
      await withDeck(use(), 'en', {file: true, hash: '#slide-99'}, async ({page}) => {
        await waitForAddress(page, '#slide-16');
        await expectSlide(page, 16, 'opening #slide-99', {hash: '#slide-16', focus: 'body'});
      });
    });
  });
}
