/**
 * M4.3: the comic reader's pure logic (templates/comic/client/reader-logic.ts)
 * without a browser: the address and its corrections (IC07, UX C5), guided
 * view's steps and thirds, the geometry that pans and zooms the page image,
 * the preload window, what the status line and the hint say, the keys, and
 * the strings it needs. The reader itself is driven in
 * test/browser/comic.test.ts.
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, test} from 'node:test';

import {
  GUIDED_PADDING,
  READER_STRING_KEYS,
  ZOOM_MAX,
  clampIndex,
  clampPlacement,
  containPlacement,
  fitBox,
  formatString,
  guidedSteps,
  guidedZone,
  hintLine,
  keptPages,
  lensPlacement,
  paddedBox,
  pageFragment,
  panPlacement,
  panelFragment,
  parseReaderFragment,
  percentAt,
  readReaderStrings,
  readerKey,
  statusLine,
  stepIndex,
  zoomPlacement,
  type Box,
  type Placement,
  type ReaderFragment,
} from '../../templates/comic/client/reader-logic.js';
import {applicationRoot} from '../helpers/paths.js';

function strings(language: 'en' | 'es'): Record<string, string> {
  return JSON.parse(readFileSync(join(applicationRoot, 'templates', 'shared', `strings.${language}.json`), 'utf8')) as Record<string, string>;
}

const close = (actual: number, expected: number, message?: string): void => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? ''} ${actual} is not ${expected}`);
};

describe('the address (IC07, UX C5, CONTRACT §5)', () => {
  const cases: [string, ReaderFragment][] = [
    ['', {kind: 'none'}],
    ['#', {kind: 'none'}],
    ['#page-1', {kind: 'page', page: 1}],
    ['#page-8', {kind: 'page', page: 8}],
    ['#page-99', {kind: 'page', page: 99}],
    ['#page-007', {kind: 'page', page: 7}],
    ['#page-2-panel-3', {kind: 'panel', page: 2, panel: 3}],
    ['#page-2-panel-99', {kind: 'panel', page: 2, panel: 99}],
    ['#page-%32-panel-%31', {kind: 'panel', page: 2, panel: 1}],
    ['#page-0', {kind: 'malformed'}],
    ['#page-2-panel-0', {kind: 'malformed'}],
    ['#page-', {kind: 'malformed'}],
    ['#page-x', {kind: 'malformed'}],
    ['#page--1', {kind: 'malformed'}],
    ['#page-1.5', {kind: 'malformed'}],
    ['#page-2-panel-', {kind: 'malformed'}],
    ['#page-2-panel-1-extra', {kind: 'malformed'}],
    ['#page-２', {kind: 'malformed'}],
    ['#page-2/', {kind: 'malformed'}],
    ['#%E0%A4%A', {kind: 'malformed'}],
    ['#comic-main', {kind: 'other', id: 'comic-main'}],
    ['#detail-2-1', {kind: 'other', id: 'detail-2-1'}],
    ['#Page-2', {kind: 'other', id: 'Page-2'}],
    ['#caf%C3%A9', {kind: 'other', id: 'café'}],
  ];
  for (const [hash, expected] of cases) {
    test(`${JSON.stringify(hash)} is ${expected.kind}`, () => {
      assert.deepEqual(parseReaderFragment(hash), expected);
    });
  }

  test('a page or panel number clamps into range: past the end is the last, below 1 the first', () => {
    const table: [number, number, number][] = [
      [1, 8, 1],
      [8, 8, 8],
      [9, 8, 8],
      [99, 8, 8],
      [0, 8, 1],
      [-3, 8, 1],
      [Number.NaN, 8, 1],
      [Number.POSITIVE_INFINITY, 8, 8],
      [2.9, 8, 2],
      [5, 0, 1],
    ];
    for (const [index, count, expected] of table) {
      assert.equal(clampIndex(index, count), expected, `clampIndex(${index}, ${count})`);
    }
    const huge = parseReaderFragment('#page-99999999999999999999999999999999');
    assert.equal(huge.kind, 'page');
    assert.equal(clampIndex(huge.kind === 'page' ? huge.page : 0, 8), 8);
  });

  test('the canonical addresses are #page-N and #page-N-panel-M', () => {
    assert.equal(pageFragment(3), '#page-3');
    assert.equal(panelFragment(3, 2), '#page-3-panel-2');
  });
});

describe('guided view (UX §06, IC07)', () => {
  test('the steps run through every panel in reading order, a page without panels as one step', () => {
    assert.deepEqual(guidedSteps([2, 0, 1]), [
      {page: 1, panel: 1},
      {page: 1, panel: 2},
      {page: 2, panel: null},
      {page: 3, panel: 1},
    ]);
    assert.deepEqual(guidedSteps([]), []);
  });

  test('a page\'s first step, a panel\'s own step, and the first step for a page outside the steps', () => {
    const steps = guidedSteps([2, 0, 3]);
    assert.equal(stepIndex(steps, 1, null), 0);
    assert.equal(stepIndex(steps, 1, 2), 1);
    assert.equal(stepIndex(steps, 2, null), 2);
    assert.equal(stepIndex(steps, 2, 4), 2, 'a panel a page does not have is its first step');
    assert.equal(stepIndex(steps, 3, 3), 5);
    assert.equal(stepIndex(steps, 9, 1), 0);
  });

  test('the left third steps back, the right third on, the middle opens the detail', () => {
    assert.equal(guidedZone(0, 300), 'previous');
    assert.equal(guidedZone(99.9, 300), 'previous');
    assert.equal(guidedZone(100, 300), 'detail');
    assert.equal(guidedZone(200, 300), 'detail');
    assert.equal(guidedZone(200.1, 300), 'next');
    assert.equal(guidedZone(300, 300), 'next');
    assert.equal(guidedZone(50, 0), 'detail', 'a lens with no width takes no step');
    assert.equal(guidedZone(Number.NaN, 300), 'detail');
  });
});

describe('geometry: a box of the page image filling a frame', () => {
  const art = {width: 1600, height: 2200};

  test('the box grows by 4% of the page on every side and stays on the page', () => {
    assert.equal(GUIDED_PADDING, 4);
    assert.deepEqual(paddedBox([10, 10, 30, 20]), [6, 6, 38, 28]);
    assert.deepEqual(paddedBox([0, 0, 50, 25]), [0, 0, 54, 29]);
    assert.deepEqual(paddedBox([52, 66, 44, 30]), [48, 62, 52, 38]);
    assert.deepEqual(paddedBox([0, 0, 100, 100]), [0, 0, 100, 100]);
  });

  test('a fitted box fills the frame on the side that binds first, centred, without cropping it', () => {
    const frame = {width: 400, height: 300};
    const box: Box = [4, 36, 92, 26];
    const placed = fitBox(box, art, frame);
    // The box is 92% of 1600 px = 1472 wide and 26% of 2200 = 572 tall: width binds (400 / 1472 < 300 / 572).
    close(placed.width, 400 / 0.92);
    close(placed.height, placed.width * (2200 / 1600));
    const left = placed.left + (box[0] / 100) * placed.width;
    const top = placed.top + (box[1] / 100) * placed.height;
    const width = (box[2] / 100) * placed.width;
    const height = (box[3] / 100) * placed.height;
    close(left, 0, 'the box starts at the frame\'s left edge');
    close(left + width, 400, 'and ends at its right edge');
    close(top + height / 2, 150, 'centred vertically');
    assert.ok(height <= 300 + 1e-9);
  });

  test('guided view shows the box and its padding; a page without panels is the whole page, contained', () => {
    const frame = {width: 390, height: 600};
    const box: Box = [64, 4, 32, 28];
    assert.deepEqual(lensPlacement(box, art, frame), fitBox(paddedBox(box), art, frame));
    const whole = containPlacement(art, frame);
    close(whole.width, 390);
    close(whole.height, 390 * (2200 / 1600));
    close(whole.left, 0);
    close(whole.top, (600 - whole.height) / 2);
  });

  test('a zoom scales about a point, never below the fitted box nor past eight times it, and keeps covering the frame', () => {
    const frame = {width: 600, height: 400};
    const minimum = fitBox([10, 10, 20, 20], art, frame);
    const doubled = zoomPlacement(minimum, 2, {x: 300, y: 200}, minimum, frame);
    close(doubled.width, minimum.width * 2);
    // The point under the pointer stays put while it can.
    const before = percentAt(minimum, 300, 200);
    const after = percentAt(doubled, 300, 200);
    close(before.x, after.x);
    close(before.y, after.y);
    assert.equal(ZOOM_MAX, 8);
    close(zoomPlacement(minimum, 100, {x: 0, y: 0}, minimum, frame).width, minimum.width * ZOOM_MAX, 'at most eight times');
    close(zoomPlacement(doubled, 0.01, {x: 0, y: 0}, minimum, frame).width, minimum.width, 'never below the fitted box');
  });

  test('a pan keeps a larger image over the frame and centres a smaller one', () => {
    const frame = {width: 100, height: 100};
    const large: Placement = {width: 300, height: 200, left: -50, top: -50};
    assert.deepEqual(panPlacement(large, 1000, 1000, frame), {width: 300, height: 200, left: 0, top: 0});
    assert.deepEqual(panPlacement(large, -1000, -1000, frame), {width: 300, height: 200, left: -200, top: -100});
    assert.deepEqual(clampPlacement({width: 50, height: 40, left: 90, top: -30}, frame), {width: 50, height: 40, left: 25, top: 30});
  });

  test('a point of the frame reads as percent of the page image, clamped to 0–100 (IC06 pointer)', () => {
    const view: Placement = {width: 800, height: 1100, left: 100, top: -50};
    assert.deepEqual(percentAt(view, 100, -50), {x: 0, y: 0});
    assert.deepEqual(percentAt(view, 500, 500), {x: 50, y: 50});
    assert.deepEqual(percentAt(view, 900, 1050), {x: 100, y: 100});
    assert.deepEqual(percentAt(view, -10, 5000), {x: 0, y: 100});
  });
});

/**
 * The pages shown with a page, written out a second time: one page alone, or
 * the cover alone and then pairs, a last even page alone (IC07). The adapter's
 * own `spreadOf` needs the DOM's types; test/browser/spike/page-flip.test.ts
 * holds it to the same rule.
 */
function spreadOf(page: number, total: number, layout: 'single' | 'spread'): number[] {
  if (layout === 'single' || page === 1) {
    return [page];
  }
  const first = page % 2 === 0 ? page : page - 1;
  return first + 1 <= total ? [first, first + 1] : [first];
}

describe('the preload window (UX §06, D114)', () => {
  test('a single page keeps itself and its neighbours', () => {
    const spread = (page: number) => spreadOf(page, 8, 'single');
    assert.deepEqual([...keptPages([1], 8, spread)].sort((a, b) => a - b), [1, 2]);
    assert.deepEqual([...keptPages([4], 8, spread)].sort((a, b) => a - b), [3, 4, 5]);
    assert.deepEqual([...keptPages([8], 8, spread)].sort((a, b) => a - b), [7, 8]);
  });

  test('a spread keeps itself, the spread before and the spread after: the cover alone, then pairs, a final page alone', () => {
    const spread = (page: number) => spreadOf(page, 8, 'spread');
    assert.deepEqual([...keptPages([1], 8, spread)].sort((a, b) => a - b), [1, 2, 3]);
    assert.deepEqual([...keptPages([2, 3], 8, spread)].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
    assert.deepEqual([...keptPages([4, 5], 8, spread)].sort((a, b) => a - b), [2, 3, 4, 5, 6, 7]);
    assert.deepEqual([...keptPages([8], 8, spread)].sort((a, b) => a - b), [6, 7, 8]);
  });
});

describe('what the reader says (UX §06, §12)', () => {
  const en = readReaderStrings(JSON.stringify(strings('en')))!;
  const es = readReaderStrings(JSON.stringify(strings('es')))!;

  test('both languages hold every string the reader needs, with its placeholders', () => {
    for (const language of ['en', 'es'] as const) {
      const all = strings(language);
      for (const key of READER_STRING_KEYS) {
        assert.equal(typeof all[key], 'string', `${language} ${key}`);
      }
      assert.match(all['page_of']!, /\{n\}.*\{total\}/);
      assert.match(all['pages_of']!, /\{a\}.*\{b\}.*\{total\}/);
      for (const placeholder of ['{n}', '{total}', '{page}']) {
        assert.ok(all['panel_of']!.includes(placeholder), `${language} panel_of has ${placeholder}`);
      }
      assert.ok(all['panels_hint']!.includes('{n}'), `${language} panels_hint`);
    }
    assert.notEqual(en, null);
    assert.notEqual(es, null);
  });

  test('the status line: one page, a spread, a panel, and a page without panels in guided view', () => {
    assert.equal(statusLine(en, {kind: 'page', visible: [1], total: 8}), 'Page 1 of 8');
    assert.equal(statusLine(en, {kind: 'page', visible: [2, 3], total: 8}), 'Pages 2–3 of 8');
    assert.equal(statusLine(en, {kind: 'guided', page: 3, panel: 2, panels: 5, total: 8}), 'Panel 2 of 5 on page 3');
    assert.equal(statusLine(en, {kind: 'guided', page: 3, panel: null, panels: 0, total: 8}), 'Page 3 of 8');
    assert.equal(statusLine(es, {kind: 'page', visible: [2, 3], total: 8}), formatString(strings('es')['pages_of']!, {a: 2, b: 3, total: 8}));
  });

  test('the hint counts the panels shown, in the singular for exactly one (D130), and says nothing for none', () => {
    assert.equal(hintLine(en, 5), formatString(strings('en')['panels_hint']!, {n: 5}));
    assert.equal(hintLine(en, 5), '5 panels · explore transcripts and available details');
    assert.equal(hintLine(en, 1), '1 panel · explore its transcript and any available detail');
    assert.equal(hintLine(en, 2), '2 panels · explore transcripts and available details');
    assert.equal(hintLine(en, 0), '');
    assert.equal(hintLine(en, Number.NaN), '', 'a count that is not one stays silent, as before');
    for (const [language, reader] of [
      ['en', en],
      ['es', es],
    ] as const) {
      const all = strings(language);
      assert.notEqual(all['panels_hint_one'], all['panels_hint'], `${language}: the singular is its own sentence`);
      assert.equal(hintLine(reader, 1), formatString(all['panels_hint_one']!, {n: 1}), `${language} one`);
      for (const n of [2, 3, 8, 1000]) {
        assert.equal(hintLine(reader, n), formatString(all['panels_hint']!, {n}), `${language} ${n}`);
      }
      assert.equal(hintLine(reader, 0), '', `${language} none`);
    }
  });

  test('the status line in Spanish, from the Spanish file: a page, a spread, a panel, and a page without panels', () => {
    const all = strings('es');
    assert.equal(statusLine(es, {kind: 'page', visible: [1], total: 8}), formatString(all['page_of']!, {n: 1, total: 8}));
    assert.equal(statusLine(es, {kind: 'page', visible: [2, 3], total: 8}), formatString(all['pages_of']!, {a: 2, b: 3, total: 8}));
    assert.equal(statusLine(es, {kind: 'guided', page: 3, panel: 2, panels: 5, total: 8}), formatString(all['panel_of']!, {n: 2, total: 5, page: 3}));
    assert.equal(statusLine(es, {kind: 'guided', page: 3, panel: null, panels: 0, total: 8}), formatString(all['page_of']!, {n: 3, total: 8}));
    for (const line of [statusLine(es, {kind: 'page', visible: [4, 5], total: 8}), hintLine(es, 1), hintLine(es, 5)]) {
      assert.doesNotMatch(line, /[{}]/, line);
    }
  });

  test('a value is inserted as written, in one pass', () => {
    assert.equal(formatString('{n} of {total}', {n: '{total}', total: '$&'}), '{total} of $&');
    assert.equal(formatString('{missing} stays', {}), '{missing} stays');
  });

  test('the strings block drives the reader only when every key is a non-blank string', () => {
    const full = strings('en');
    assert.equal(readReaderStrings('not json'), null);
    assert.equal(readReaderStrings('[]'), null);
    assert.equal(readReaderStrings('null'), null);
    for (const key of READER_STRING_KEYS) {
      const without = {...full};
      delete without[key];
      assert.equal(readReaderStrings(JSON.stringify(without)), null, `without ${key}`);
      assert.equal(readReaderStrings(JSON.stringify({...full, [key]: '  '})), null, `blank ${key}`);
      assert.equal(readReaderStrings(JSON.stringify({...full, [key]: 7})), null, `${key} not a string`);
    }
    assert.notEqual(readReaderStrings(JSON.stringify({...full, extra: 1})), null, 'another key is ignored');
  });
});

describe('keys (UX C4)', () => {
  test('← → turn or step; Home and End go to either end; nothing else is the reader\'s', () => {
    assert.equal(readerKey('ArrowLeft'), 'previous');
    assert.equal(readerKey('ArrowRight'), 'next');
    assert.equal(readerKey('Home'), 'first');
    assert.equal(readerKey('End'), 'last');
    for (const key of ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Escape', 'Enter', ' ', 'Tab', 'a']) {
      assert.equal(readerKey(key), null, key);
    }
  });
});
