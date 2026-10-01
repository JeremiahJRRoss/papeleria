/**
 * M4.4: the comic's Grid and pointer readout in the editor (UX §08, D3, D117),
 * in Chromium, Firefox and WebKit.
 *
 * The editor opens a copy of the sample comic. With Grid on, every page in the
 * preview carries a 10% grid labelled in percent, and moving the pointer over
 * a page shows where it is, in percent of the page image, beside Grid. The
 * measurement test moves the real pointer to points inside the sample's panel
 * boxes, read from its manifest, and holds the readout to them. Around it:
 * the hover outline, the readout's prompt again once the pointer leaves the
 * page image or the frame (W5R-20), the grid over guided view's lens, Grid kept across
 * generations, Follow marking a panel on its page, Grid off, and a published
 * comic that carries none of it.
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cpSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {after, before, describe, test} from 'node:test';

import type {Browser, Frame, Page} from 'playwright';
import {parse} from 'yaml';

import {applicationRoot} from '../helpers/paths.js';
import {copyPiece, removeTemporaryFolders} from '../helpers/pieces.js';
import {CLI} from './helpers/comic-fixture.js';
import {frameOf, lineOf, nextShown, openEditor, placeCursor, shown, TYPING, type EditorFixture} from './helpers/editor-session.js';
import {launchEngine, selectedEngines} from './helpers/engines.js';

const TIMEOUT = {timeout: 150_000};
const SAMPLE = join(applicationRoot, 'examples', 'sample-comic');
type Box = readonly [number, number, number, number];
const BOXES = (parse(readFileSync(join(SAMPLE, 'papeleria.yaml'), 'utf8')) as {pages: {panels: {box: Box}[]}[]}).pages.map((page) => page.panels.map((panel) => panel.box));

after(removeTemporaryFolders);

/**
 * The sample, built once so its image cache is warm: deriving eight pages
 * takes longer than a preview is waited for, and each session starts from a
 * copy with that cache, as an author's second session would.
 */
let warmCache: string | undefined;
before(() => {
  const piece = copyPiece(SAMPLE, 'grid-cache');
  const built = spawnSync(process.execPath, [CLI, 'build', piece], {encoding: 'utf8'});
  assert.equal(built.status, 0, built.stderr);
  warmCache = join(piece, '.papeleria', 'cache');
}, {timeout: 300_000});

/**
 * The console line a browser writes when the preview's policy (IC06,
 * `style-src 'self'`) refuses the style element the page-turn engine adds as
 * it loads. The refusal is the policy at work, and comic.css restates the
 * engine's four rules so the book is laid out all the same (D109); it is the
 * only console line a comic's preview may write, and it names style-src.
 */
function engineStyleRefused(problem: string): boolean {
  return /^console error: /.test(problem) && /style-src/.test(problem) && /inline style|stylesheet|style \(style-src-elem\)/i.test(problem);
}

/** The frame the editor shows now. */
async function front(page: Page): Promise<Frame> {
  const id = await shown(page);
  assert.ok(id !== undefined, 'a generation is shown');
  const frame = frameOf(page, id);
  await frame.waitForFunction(() => (window as unknown as {papeleriaReader?: unknown}).papeleriaReader !== undefined);
  return frame;
}

/**
 * Where, in the editor page, a point of an element in the shown frame is
 * drawn: the frame is scaled into the preview pane, so its CSS pixels are
 * mapped through the iframe's box.
 */
async function pagePoint(page: Page, frame: Frame, selector: string, fraction: {x: number; y: number}): Promise<{x: number; y: number}> {
  const inner = await frame.evaluate(
    ({target, at}) => {
      const rect = document.querySelector(target)!.getBoundingClientRect();
      return {x: rect.left + rect.width * at.x, y: rect.top + rect.height * at.y};
    },
    {target: selector, at: fraction},
  );
  const id = await shown(page);
  const outer = await page.evaluate((generation) => {
    const iframe = document.querySelector<HTMLIFrameElement>(`iframe[data-generation-id="${generation}"]`)!;
    const rect = iframe.getBoundingClientRect();
    return {left: rect.left, top: rect.top, scale: rect.width / iframe.offsetWidth};
  }, id);
  return {x: outer.left + inner.x * outer.scale, y: outer.top + inner.y * outer.scale};
}

type Readout = {page: number; x: number; y: number};

async function readout(page: Page, previous: string): Promise<{text: string; value: Readout}> {
  await page.waitForFunction((before) => {
    const text = document.getElementById('pointer-readout')?.textContent ?? '';
    return text !== before && /^Page \d+ · x [\d.]+% · y [\d.]+%$/.test(text);
  }, previous, {timeout: 5000});
  const text = (await page.textContent('#pointer-readout')) ?? '';
  const match = /^Page (\d+) · x ([\d.]+)% · y ([\d.]+)%$/.exec(text)!;
  return {text, value: {page: Number(match[1]), x: Number(match[2]), y: Number(match[3])}};
}

/** Grid's grids in a frame: the page arts' and the lens's, with their line and label counts. */
function grids(frame: Frame): Promise<{arts: number; lens: number; lines: number[]; labels: string[]}> {
  return frame.evaluate(() => {
    const all = Array.from(document.querySelectorAll<HTMLElement>('[data-papeleria-preview="grid"]'));
    const first = all[0];
    return {
      arts: all.filter((grid) => grid.parentElement?.classList.contains('comic-art') === true).length,
      lens: all.filter((grid) => grid.parentElement?.id === 'comic-lens').length,
      lines: all.map((grid) => grid.querySelectorAll('div').length),
      labels: first === undefined ? [] : Array.from(first.querySelectorAll('span'), (label) => label.textContent ?? ''),
    };
  });
}

const {run, excluded} = selectedEngines();

for (const engine of excluded) {
  test(`${engine}: not run`, {skip: `PAPELERIA_BROWSERS=${process.env['PAPELERIA_BROWSERS'] ?? ''} leaves ${engine} out`}, () => {});
}

for (const engine of run) {
  describe(`Grid and the pointer readout in ${engine}`, () => {
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

    async function withEditor(body: (fixture: EditorFixture) => Promise<void>): Promise<void> {
      const cache = warmCache;
      assert.ok(cache !== undefined, 'the sample was built');
      const fixture = await openEditor(use(), SAMPLE, {label: 'grid', prepare: (root) => cpSync(cache, join(root, '.papeleria', 'cache'), {recursive: true})});
      try {
        await body(fixture);
        assert.deepEqual(fixture.problems.filter((problem) => !engineStyleRefused(problem)), []);
      } finally {
        await fixture.close();
      }
    }

    test('D3: Grid lays a labelled 10% grid over every page, and the readout gives the pointer\'s place in percent of the page image', TIMEOUT, async (context) => {
      await withEditor(async ({page}) => {
        assert.equal(await page.isVisible('#grid'), true, 'Grid is offered for a comic');
        assert.equal(await page.isHidden('#pointer-readout'), true);
        // The phone width, as D3's author does.
        await page.click('.preview-widths button[data-width="390"]');
        await page.click('#grid');
        assert.equal(await page.getAttribute('#grid', 'aria-pressed'), 'true');
        assert.equal(await page.textContent('#pointer-readout'), 'Point at a page');
        const frame = await front(page);
        await frame.waitForFunction(() => document.querySelectorAll('[data-papeleria-preview="grid"]').length > 0);
        const drawn = await grids(frame);
        assert.equal(drawn.arts, 8, 'a grid over every page');
        assert.ok(drawn.lines.every((count) => count === 18), 'nine lines each way');
        assert.deepEqual(drawn.labels, ['10', '10', '20', '20', '30', '30', '40', '40', '50', '50', '60', '60', '70', '70', '80', '80', '90', '90']);

        // The measurement: points inside each box of page 1, read back within a pixel's worth of percent.
        let previous = 'Point at a page';
        const art = '.comic-book figure[data-page="1"] .comic-art';
        const errors: number[] = [];
        for (const [index, box] of BOXES[0]!.entries()) {
          for (const [fx, fy] of [
            [0.25, 0.25],
            [0.75, 0.6],
          ] as const) {
            const expected = {x: box[0] + box[2] * fx, y: box[1] + box[3] * fy};
            const point = await pagePoint(page, frame, art, {x: expected.x / 100, y: expected.y / 100});
            await page.mouse.move(point.x, point.y);
            const read = await readout(page, previous);
            previous = read.text;
            assert.equal(read.value.page, 1);
            errors.push(Math.abs(read.value.x - expected.x), Math.abs(read.value.y - expected.y));
            assert.ok(Math.abs(read.value.x - expected.x) <= 0.8 && Math.abs(read.value.y - expected.y) <= 0.8, `panel ${index + 1}: read ${read.text}, expected x ${expected.x} y ${expected.y}`);
          }
        }
        context.diagnostic(`${engine}: ${errors.length / 2} points, largest difference ${Math.max(...errors).toFixed(2)}%`);

        // Hovering a panel shows its outline (UX §06).
        const outline = await frame.evaluate(() => {
          const hovered = document.querySelector('.comic-panel:hover');
          const style = hovered === null ? null : getComputedStyle(hovered);
          return style === null ? null : {id: hovered!.id, style: style.outlineStyle, width: style.outlineWidth};
        });
        assert.deepEqual(outline, {id: 'page-1-panel-5', style: 'solid', width: '2px'});

        // Off the page image the readout keeps no place the pointer has left (W5R-20, D174): onto the comic's own bar, back
        // onto the art, then out of the frame onto the editor's toolbar.
        const prompt = (): Promise<unknown> =>
          page.waitForFunction(() => document.getElementById('pointer-readout')?.textContent === 'Point at a page', undefined, {timeout: 5000});
        const bar = await pagePoint(page, frame, '#comic-tools', {x: 0.5, y: 0.5});
        await page.mouse.move(bar.x, bar.y);
        await prompt();
        const middle = await pagePoint(page, frame, art, {x: 0.5, y: 0.5});
        await page.mouse.move(middle.x, middle.y);
        const again = await readout(page, 'Point at a page');
        assert.ok(again.value.page === 1 && Math.abs(again.value.x - 50) <= 0.8 && Math.abs(again.value.y - 50) <= 0.8, `back on the art: ${again.text}`);
        const follow = await page.locator('#follow').boundingBox();
        assert.ok(follow !== null);
        await page.mouse.move(follow.x + follow.width / 2, follow.y + follow.height / 2);
        await prompt();

        // An author reads a place, then types while the pointer rests on the art: the next generation has reported
        // nothing, and the readout still shows the older one's place, which its first move off the art clears too.
        await page.mouse.move(middle.x, middle.y);
        await readout(page, 'Point at a page');
        const before = (await shown(page))!;
        await placeCursor(page, await lineOf(page, 'title: The ferry'));
        await page.keyboard.type(' again', TYPING);
        await nextShown(page, before);
        const next = await front(page);
        await next.waitForFunction(() => document.querySelectorAll('[data-papeleria-preview="grid"]').length > 0);
        assert.match((await page.textContent('#pointer-readout')) ?? '', /^Page 1 · /, 'the place the older generation reported');
        const nextBar = await pagePoint(page, next, '#comic-tools', {x: 0.5, y: 0.5});
        await page.mouse.move(nextBar.x, nextBar.y);
        await prompt();
      });
    });

    test('the grid follows guided view\'s lens, stays on for the next generation, and goes when Grid is off', TIMEOUT, async () => {
      await withEditor(async ({page}) => {
        await page.click('#grid');
        let frame = await front(page);
        await frame.waitForFunction(() => document.querySelectorAll('[data-papeleria-preview="grid"]').length === 9);
        await frame.evaluate(() => (window as unknown as {papeleriaReader: {enterGuided(page: number, panel: number): void}}).papeleriaReader.enterGuided(1, 2));
        const lens = await frame.evaluate(() => {
          const art = document.querySelector<HTMLElement>('.comic-lens-art')!;
          const grid = document.querySelector<HTMLElement>('#comic-lens > [data-papeleria-preview="grid"]')!;
          const a = art.getBoundingClientRect();
          const g = grid.getBoundingClientRect();
          return {same: Math.abs(a.left - g.left) < 1 && Math.abs(a.top - g.top) < 1 && Math.abs(a.width - g.width) < 1 && Math.abs(a.height - g.height) < 1, shown: getComputedStyle(document.getElementById('comic-lens')!).display};
        });
        assert.deepEqual(lens, {same: true, shown: 'block'}, 'the lens\'s grid covers the lens\'s art exactly');
        // In guided view the readout reads the lens: the middle of panel 2's box.
        const box = BOXES[0]![1]!;
        const point = await pagePoint(page, frame, '.comic-lens-art', {x: (box[0] + box[2] / 2) / 100, y: (box[1] + box[3] / 2) / 100});
        const shownBefore = (await page.textContent('#pointer-readout')) ?? '';
        await page.mouse.move(point.x, point.y);
        const read = await readout(page, shownBefore);
        assert.equal(read.value.page, 1);
        assert.ok(Math.abs(read.value.x - (box[0] + box[2] / 2)) <= 0.8 && Math.abs(read.value.y - (box[1] + box[3] / 2)) <= 0.8, read.text);

        // A new generation keeps Grid on.
        const before = (await shown(page))!;
        await placeCursor(page, await lineOf(page, 'title: The ferry'));
        await page.keyboard.type(' again', TYPING);
        await nextShown(page, before);
        frame = await front(page);
        await frame.waitForFunction(() => document.querySelectorAll('.comic-art > [data-papeleria-preview="grid"]').length === 8);
        assert.equal(await page.getAttribute('#grid', 'aria-pressed'), 'true');

        await page.click('#grid');
        await frame.waitForFunction(() => document.querySelectorAll('[data-papeleria-preview="grid"]').length === 0);
        assert.equal(await page.isHidden('#pointer-readout'), true);
      });
    });

    test('Follow: the cursor on a panel shows its page, in page view, with the panel marked', TIMEOUT, async () => {
      await withEditor(async ({page}) => {
        const frame = await front(page);
        await placeCursor(page, await lineOf(page, 'box: [64, 4, 32, 28]'));
        await frame.waitForFunction(() => document.getElementById('page-1-panel-2')?.getAttribute('data-papeleria-preview') === 'marked');
        const state = await frame.evaluate(() => {
          const reader = (window as unknown as {papeleriaReader: {view: string; page: number}}).papeleriaReader;
          const panel = document.getElementById('page-1-panel-2')!;
          return {view: reader.view, page: reader.page, outline: getComputedStyle(panel).outlineStyle};
        });
        assert.deepEqual(state, {view: 'page', page: 1, outline: 'solid'});
        await placeCursor(page, await lineOf(page, 'Page 3, panel 2: a closer view.'));
        await frame.waitForFunction(() => document.getElementById('page-3-panel-2')?.getAttribute('data-papeleria-preview') === 'marked');
        assert.equal(await frame.evaluate(() => document.querySelectorAll('[data-papeleria-preview="marked"]').length), 1, 'one panel marked at a time');
        assert.equal(await frame.evaluate(() => (window as unknown as {papeleriaReader: {visible: number[]}}).papeleriaReader.visible.includes(3)), true);
      });
    });

    test('a published comic carries none of it: no grid, no readout, no mark', TIMEOUT, async () => {
      assert.ok(warmCache !== undefined, 'the sample was built');
      const dist = join(warmCache, '..', '..', 'dist');
      for (const file of ['index.html', 'reader.js', 'theme/css/comic.css']) {
        assert.doesNotMatch(readFileSync(join(dist, file), 'utf8'), /papeleria-preview|data-papeleria-preview/, file);
      }
      const context = await use().newContext();
      try {
        const page = await context.newPage();
        await page.goto(`file://${join(dist, 'index.html')}`);
        await page.waitForFunction(() => (window as unknown as {papeleriaReader?: unknown}).papeleriaReader !== undefined);
        await page.evaluate(() => document.dispatchEvent(new CustomEvent('papeleria-preview-grid', {detail: {on: true}})));
        assert.equal(await page.evaluate(() => document.querySelectorAll('[data-papeleria-preview]').length), 0);
      } finally {
        await context.close();
      }
    });
  });
}
