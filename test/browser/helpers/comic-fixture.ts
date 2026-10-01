/**
 * Built comics for the reader's browser suites (M4.3–M4.7, W4).
 *
 * `buildComics` copies the sample comic and the reader fixture into a
 * workspace, adds the files the fixture makes when its tests run, and builds
 * both with the compiled CLI, as an author would. `withComic` opens one in a
 * fresh context and fails the test on any page or console error. `readReader`
 * reads what a reader sees and what the hook reports, and `ENGINE_TRAP` is an
 * init script that wraps the engine the reader receives, `St.PageFlip`, in a
 * subclass counting every call that animates (D118).
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cpSync, mkdirSync, writeFileSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';
import {pathToFileURL} from 'node:url';

import type {Browser, BrowserContext, BrowserContextOptions, Page} from 'playwright';

import type {PapeleriaReader} from '../../../templates/comic/client/reader-logic.js';
import {readerFixtureImages} from '../../fixtures/comic/generate.js';
import {applicationRoot} from '../../helpers/paths.js';

declare global {
  interface Window {
    papeleriaReader?: PapeleriaReader;
  }
}

export const CLI = join(applicationRoot, 'lib', 'src', 'cli', 'index.js');

/** The three viewports of A5 and DEP05 (UX §10). */
export const VIEWPORTS = [
  {width: 390, height: 844},
  {width: 834, height: 1112},
  {width: 1280, height: 800},
] as const;

export type Viewport = (typeof VIEWPORTS)[number];

/** IC07's spread rule at the three viewports: only 1280 × 800 is 900 × 500 or more. */
export function expectedLayout(viewport: {readonly width: number; readonly height: number}): 'single' | 'spread' {
  return viewport.width >= 900 && viewport.height >= 500 ? 'spread' : 'single';
}

export function viewportLabel(viewport: {readonly width: number; readonly height: number}): string {
  return `${viewport.width}×${viewport.height}`;
}

export type BuiltComics = {
  /** The folder holding each piece. */
  readonly workspace: string;
  /** `sample/dist` and `reader/dist`, by name. */
  readonly dist: Readonly<Record<'sample' | 'reader', string>>;
};

const GENERATED = new Set(['dist', '.papeleria']);

/** Copies and builds the sample comic and the reader fixture into `workspace`. */
export async function buildComics(workspace: string): Promise<BuiltComics> {
  const sample = join(workspace, 'sample');
  const reader = join(workspace, 'reader');
  const copy = (source: string, target: string): void => cpSync(source, target, {recursive: true, filter: (path) => !GENERATED.has(basename(path))});
  copy(join(applicationRoot, 'examples', 'sample-comic'), sample);
  copy(join(applicationRoot, 'test', 'fixtures', 'comic', 'reader'), reader);
  for (const [path, bytes] of Object.entries(await readerFixtureImages())) {
    mkdirSync(dirname(join(reader, path)), {recursive: true});
    writeFileSync(join(reader, path), bytes);
  }
  for (const piece of [sample, reader]) {
    const built = spawnSync(process.execPath, [CLI, 'build', piece], {encoding: 'utf8'});
    assert.equal(built.status, 0, `papeleria build ${piece}: ${built.stderr}`);
  }
  return {workspace, dist: {sample: join(sample, 'dist'), reader: join(reader, 'dist')}};
}

export function fileUrl(dist: string, hash = ''): string {
  return `${pathToFileURL(join(dist, 'index.html')).href}${hash}`;
}

export type Opened = {
  readonly page: Page;
  readonly context: BrowserContext;
  /** Every request the page made, by URL and resource type. */
  readonly requests: {readonly url: string; readonly type: string}[];
};

export type OpenOptions = {
  readonly context?: BrowserContextOptions;
  /** Runs in the page before any of its own scripts. */
  readonly init?: string | (() => void);
  /** Waits for the reader to start (the default), or not, for a page without JavaScript. */
  readonly reader?: boolean;
};

/** Opens `url` in a fresh context, runs `body`, and fails on any page or console error. */
export async function withComic(browser: Browser, url: string, options: OpenOptions, body: (opened: Opened) => Promise<void>): Promise<void> {
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
    await page.goto(url);
    if (options.context?.javaScriptEnabled !== false) {
      // fonts.css swaps faces in as they arrive, which moves the bar and so the book: settle all eight first.
      await page.evaluate(async () => {
        await Promise.allSettled(Array.from(document.fonts, (face) => face.load()));
        await document.fonts.ready;
      });
      if (options.reader !== false) {
        await page.waitForFunction(() => window.papeleriaReader !== undefined, undefined, {timeout: 10_000});
        await page.waitForLoadState('load');
      }
    }
    await body({page, context, requests});
    assert.deepEqual(errors, [], 'the page reported errors');
  } finally {
    await context.close();
  }
}

export type ReaderState = {
  readonly enhanced: boolean;
  readonly page: number;
  readonly panel: number | null;
  readonly view: string;
  readonly layout: string;
  readonly visible: number[];
  /** The pages whose figure the engine shows (display is not none). */
  readonly shown: number[];
  readonly status: string;
  readonly hint: string;
  readonly hash: string;
  readonly focus: string;
  readonly detailOpen: boolean;
  readonly transcript: boolean;
  readonly instant: boolean;
  readonly disabled: {readonly previous: boolean; readonly next: boolean};
  readonly guidedLabel: string;
  readonly detailHidden: boolean;
  /** The sheets under the book that are not hidden. */
  readonly sheets: number[];
};

/** What the reader shows and reports now. */
export function readReader(page: Page): Promise<ReaderState> {
  return page.evaluate(() => {
    const reader = window.papeleriaReader;
    const byId = (id: string): HTMLElement | null => document.getElementById(id);
    const active = document.activeElement;
    const focus =
      active === null || active === document.body
        ? 'body'
        : active.id !== ''
          ? active.id
          : `${active.tagName.toLowerCase()}.${Array.from(active.classList).join('.')}`;
    const disabled = (id: string): boolean => {
      const element = byId(id);
      return element instanceof HTMLButtonElement && element.disabled;
    };
    return {
      enhanced: document.body.classList.contains('comic-enhanced'),
      page: reader?.page ?? 0,
      panel: reader?.panel ?? null,
      view: reader?.view ?? '',
      layout: reader?.layout ?? '',
      visible: [...(reader?.visible ?? [])],
      shown: Array.from(document.querySelectorAll<HTMLElement>('figure.comic-figure'))
        .filter((figure) => getComputedStyle(figure).display !== 'none' && figure.closest('.comic-book') !== null)
        .map((figure) => Number(figure.dataset['page']))
        .sort((one, two) => one - two),
      status: byId('comic-status')?.textContent ?? '',
      hint: byId('comic-hint')?.textContent ?? '',
      hash: location.hash,
      focus,
      detailOpen: reader?.detailOpen ?? false,
      transcript: reader?.transcript ?? false,
      instant: reader?.instant ?? false,
      disabled: {previous: disabled('comic-previous'), next: disabled('comic-next')},
      guidedLabel: byId('comic-guided')?.textContent ?? '',
      detailHidden: byId('comic-detail')?.hidden ?? true,
      sheets: Array.from(document.querySelectorAll<HTMLElement>('article.comic-sheet'))
        .filter((sheet) => !sheet.hidden)
        .map((sheet) => Number(sheet.dataset['page'])),
    };
  });
}

/** Waits until the reader shows `page` with nothing turning: its status names it and the engine shows exactly those pages. */
export async function waitForPages(page: Page, visible: readonly number[], timeout = 5000): Promise<void> {
  await page.waitForFunction(
    (expected) => {
      const reader = window.papeleriaReader;
      if (reader === undefined) {
        return false;
      }
      const shown = Array.from(document.querySelectorAll<HTMLElement>('.comic-book figure.comic-figure'))
        .filter((figure) => getComputedStyle(figure).display !== 'none')
        .map((figure) => Number(figure.dataset['page']))
        .sort((one, two) => one - two);
      return JSON.stringify([...reader.visible]) === JSON.stringify(expected) && JSON.stringify(shown) === JSON.stringify(expected);
    },
    [...visible],
    {timeout},
  );
}

/** The calls that animate, counted on the engine the reader receives (D118). */
export type EngineCalls = {readonly flipNext: number; readonly flipPrev: number; readonly flip: number; readonly startAnimation: number; readonly turnToPage: number; readonly engines: number};

/**
 * An init script: when the vendored engine assigns `window.St` and then
 * `St.PageFlip`, the class is replaced by a subclass that counts flipNext,
 * flipPrev, flip, turnToPage and the renderer's startAnimation, which every
 * curl goes through, in `window.papeleriaEngineCalls`. The engine's bytes are
 * untouched: the trap is two property setters on the objects it assigns to.
 */
export const ENGINE_TRAP = `(() => {
  const calls = {flipNext: 0, flipPrev: 0, flip: 0, startAnimation: 0, turnToPage: 0, engines: 0};
  Object.defineProperty(window, 'papeleriaEngineCalls', {value: calls, configurable: true});
  const counting = (Engine) => class extends Engine {
    constructor(...args) { super(...args); calls.engines += 1; }
    loadFromHTML(items) {
      super.loadFromHTML(items);
      const render = this.getRender();
      const start = render.startAnimation.bind(render);
      render.startAnimation = (...args) => { calls.startAnimation += 1; return start(...args); };
    }
    flipNext(corner) { calls.flipNext += 1; return super.flipNext(corner); }
    flipPrev(corner) { calls.flipPrev += 1; return super.flipPrev(corner); }
    flip(page, corner) { calls.flip += 1; return super.flip(page, corner); }
    turnToPage(index) { calls.turnToPage += 1; return super.turnToPage(index); }
  };
  Object.defineProperty(window, 'St', {
    configurable: true,
    get() { return undefined; },
    set(exports) {
      let wrapped;
      Object.defineProperty(exports, 'PageFlip', {
        configurable: true,
        enumerable: true,
        get() { return wrapped; },
        set(Engine) { wrapped = counting(Engine); },
      });
      Object.defineProperty(window, 'St', {value: exports, writable: true, configurable: true});
    },
  });
})();`;

export function engineCalls(page: Page): Promise<EngineCalls> {
  return page.evaluate(() => ({...(window as unknown as {papeleriaEngineCalls: EngineCalls}).papeleriaEngineCalls}));
}
