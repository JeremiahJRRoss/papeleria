/**
 * M1.7 / IC04: the first-view budget arithmetic (R07). Pure: sizes in, totals
 * out. The real build that stands exactly at the limit with an SVG saved with
 * a byte-order mark is in `test/integration/pipeline.test.ts`.
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  FIRST_VIEW_BUDGET_BYTES,
  LARGEST_COUNT,
  measureFirstView,
  REFERENCE_VIEWPORTS,
  selectCandidate,
  type FirstViewInput,
} from '../../src/build/budget.js';
import type {FirstViewImage, ImageSlot, PublishedDerivative, PublishedImage} from '../../templates/shared/blocks.js';

function derivative(path: string, width: number, format: 'webp' | 'avif', bytes: number): PublishedDerivative {
  return {path, width, height: Math.round(width / 2), format, bytes};
}

function raster(stem: string, sizes: {webp: [number, number]; avif?: [number, number]}): PublishedImage {
  const derivatives = [derivative(`${stem}.800.webp`, 800, 'webp', sizes.webp[0]), derivative(`${stem}.1600.webp`, 1600, 'webp', sizes.webp[1])];
  if (sizes.avif !== undefined) {
    derivatives.push(derivative(`${stem}.800.avif`, 800, 'avif', sizes.avif[0]), derivative(`${stem}.1600.avif`, 1600, 'avif', sizes.avif[1]));
  }
  return {kind: 'raster', width: 1600, height: 800, derivatives};
}

/** A slot as wide as the viewport, like a full-bleed image. */
const FULL: ImageSlot = {sizes: '100vw', slotWidth: (viewport) => viewport};
/** A slot of a fixed width, like a logo. */
const fixed = (width: number): ImageSlot => ({sizes: `${width}px`, slotWidth: () => width});

function input(files: readonly [string, number][], images: readonly FirstViewImage[] = [], budgetBytes: number | null = FIRST_VIEW_BUDGET_BYTES): FirstViewInput {
  return {files: files.map(([path, bytes]) => ({path, bytes})), images, budgetBytes};
}

test('IC04: the limit is 1,048,576 bytes at three reference viewports, each at a pixel ratio of 1', () => {
  assert.equal(FIRST_VIEW_BUDGET_BYTES, 1_048_576);
  assert.deepEqual(
    REFERENCE_VIEWPORTS.map((viewport) => [viewport.width, viewport.height, viewport.dpr]),
    [
      [390, 844, 1],
      [834, 1112, 1],
      [1280, 800, 1],
    ],
  );
});

test('R07: a first view of exactly 1,048,576 bytes is within the budget; one byte more is over', () => {
  const at = measureFirstView(input([['index.html', 48_576], ['theme/fonts/a.woff2', 1_000_000]]));
  assert.equal(at.firstViewBytes, 1_048_576);
  assert.equal(at.withinBudget, true);
  const over = measureFirstView(input([['index.html', 48_577], ['theme/fonts/a.woff2', 1_000_000]]));
  assert.equal(over.firstViewBytes, 1_048_577);
  assert.equal(over.withinBudget, false);
});

test('R07: a file used twice counts once, whether listed twice or chosen for two slots', () => {
  const logo: PublishedImage = {kind: 'vector', width: 100, height: 40, file: {path: 'assets/images/logos/client.svg', bytes: 5_000}};
  const measure = measureFirstView(
    input(
      [
        ['index.html', 1_000],
        ['theme/css/site.css', 2_000],
        ['theme/css/site.css', 2_000],
      ],
      [
        {image: logo, slot: fixed(80)},
        {image: logo, slot: fixed(120)},
      ],
    ),
  );
  assert.equal(measure.firstViewBytes, 8_000);
  assert.deepEqual(measure.worst.files.map((file) => file.path).sort(), ['assets/images/logos/client.svg', 'index.html', 'theme/css/site.css']);
});

test('the derivative a browser picks: the narrowest at least slot × ratio wide, else the widest', () => {
  const image = raster('photo', {webp: [50_000, 150_000]});
  assert.equal(selectCandidate(image, 390, 1, 'webp').path, 'photo.800.webp');
  assert.equal(selectCandidate(image, 800, 1, 'webp').path, 'photo.800.webp', 'exactly as wide is wide enough');
  assert.equal(selectCandidate(image, 801, 1, 'webp').path, 'photo.1600.webp');
  assert.equal(selectCandidate(image, 500, 2, 'webp').path, 'photo.1600.webp', 'the pixel ratio multiplies the slot');
  assert.equal(selectCandidate(image, 2000, 1, 'webp').path, 'photo.1600.webp', 'nothing is wide enough: the widest');
  const narrow: PublishedImage = {kind: 'raster', width: 600, height: 300, derivatives: [derivative('small.600.webp', 600, 'webp', 9_000)]};
  assert.equal(selectCandidate(narrow, 1280, 1, 'webp').path, 'small.600.webp', 'one derivative (D40)');
});

test('the AVIF scenario takes AVIF where the build wrote it and WebP where it did not; an SVG is its one file', () => {
  const both = raster('both', {webp: [40_000, 90_000], avif: [30_000, 70_000]});
  const webpOnly = raster('webp-only', {webp: [40_000, 90_000]});
  assert.equal(selectCandidate(both, 390, 1, 'avif').path, 'both.800.avif');
  assert.equal(selectCandidate(both, 390, 1, 'webp').path, 'both.800.webp');
  assert.equal(selectCandidate(webpOnly, 390, 1, 'avif').path, 'webp-only.800.webp');
  const vector: PublishedImage = {kind: 'vector', width: 10, height: 10, file: {path: 'a.svg', bytes: 321}};
  assert.deepEqual(selectCandidate(vector, 1280, 1, 'avif'), {path: 'a.svg', bytes: 321});
});

test('R07: AVIF and WebP never both count for a slot, and the heavier scenario is enforced', () => {
  // AVIF is lighter for one image and heavier for the other, so the worst total mixes neither.
  const lighter = raster('lighter', {webp: [100_000, 300_000], avif: [60_000, 200_000]});
  const heavier = raster('heavier', {webp: [100_000, 300_000], avif: [180_000, 500_000]});
  const measure = measureFirstView(
    input([['index.html', 10_000]], [
      {image: lighter, slot: FULL},
      {image: heavier, slot: FULL},
    ]),
  );
  assert.equal(measure.totals.length, 6, 'three viewports, two scenarios');
  for (const total of measure.totals) {
    const formats = new Set(total.files.filter((file) => file.path !== 'index.html').map((file) => file.path.slice(file.path.lastIndexOf('.') + 1)));
    assert.equal(formats.size, 1, `${total.scenario} at ${total.viewport.width} counts one format`);
  }
  // From 834 px both images take their 1600 px derivative: AVIF 700,000 against WebP 600,000.
  // 834 and 1280 tie; the first in viewport order is kept.
  assert.equal(measure.worst.scenario, 'avif');
  assert.equal(measure.worst.viewport.width, 834);
  assert.equal(measure.firstViewBytes, 10_000 + 200_000 + 500_000);
  const phone = measure.totals.filter((total) => total.viewport.width === 390).map((total) => [total.scenario, total.bytes]);
  assert.deepEqual(phone, [
    ['avif', 10_000 + 60_000 + 180_000],
    ['webp', 10_000 + 100_000 + 100_000],
  ]);
  const webpAt1280 = measure.totals.find((total) => total.scenario === 'webp' && total.viewport.width === 1280);
  assert.equal(webpAt1280?.bytes, 10_000 + 300_000 + 300_000);
});

test('R07: the widest viewport is not always the heaviest; the maximum over all of them is enforced', () => {
  // Full width up to 900 px, then a 400 px column: only the tablet needs the 1600 px derivative.
  const image = raster('hero', {webp: [100_000, 300_000]});
  const slot: ImageSlot = {sizes: '(max-width: 900px) 100vw, 400px', slotWidth: (viewport) => (viewport <= 900 ? viewport : 400)};
  const measure = measureFirstView(input([['index.html', 1_000]], [{image, slot}]));
  assert.equal(measure.firstViewBytes, 301_000);
  assert.equal(measure.worst.viewport.width, 834);
  const desktop = measure.totals.find((total) => total.viewport.width === 1280 && total.scenario === 'webp');
  assert.equal(desktop?.bytes, 101_000);
});

test('R07: the largest files are the worst total’s, heaviest first and at most ten', () => {
  const files: [string, number][] = Array.from({length: 12}, (_, index) => [`file-${String(index).padStart(2, '0')}`, 1_000 + index]);
  files.push(['tie-b', 500], ['tie-a', 500]);
  const measure = measureFirstView(input(files));
  assert.equal(measure.largest.length, LARGEST_COUNT);
  assert.deepEqual(measure.largest[0], ['file-11', 1_011]);
  assert.deepEqual(measure.largest.at(-1), ['file-02', 1_002]);
  const ties = measureFirstView(input([['tie-b', 500], ['tie-a', 500]]));
  assert.deepEqual(ties.largest, [
    ['tie-a', 500],
    ['tie-b', 500],
  ], 'equal sizes in path order');
});

test('a first view without a budget is never over it', () => {
  const measure = measureFirstView(input([['index.html', 5_000_000]], [], null));
  assert.equal(measure.budgetBytes, null);
  assert.equal(measure.withinBudget, true);
});
