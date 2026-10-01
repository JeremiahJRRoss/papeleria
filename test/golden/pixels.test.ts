/**
 * A4 (D70): the pixel comparison the visual golden test uses, on images
 * made here with sharp.
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';

import sharp from 'sharp';

import {comparePixels, differenceImage} from './pixels.js';

const THRESHOLDS = {weakDelta: 8, strongDelta: 64};

async function png(width: number, height: number, paint: (x: number, y: number) => readonly [number, number, number]): Promise<Uint8Array> {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data.set(paint(x, y), (y * width + x) * 3);
    }
  }
  return new Uint8Array(await sharp(data, {raw: {width, height, channels: 3}}).png().toBuffer());
}

const paper = (): readonly [number, number, number] => [252, 252, 250];

test('identical captures have no differing pixel', async () => {
  const image = await png(40, 30, paper);
  assert.deepEqual(await comparePixels(image, image, THRESHOLDS), {
    sameSize: true,
    width: 40,
    height: 30,
    expectedWidth: 40,
    expectedHeight: 30,
    weak: 0,
    strong: 0,
    largestDelta: 0,
  });
});

test('a faint change counts as weak only, a glyph-sized change as strong, and a tolerance of a few levels is ignored', async () => {
  const expected = await png(40, 30, paper);
  const faint = await png(40, 30, (x, y) => (x < 10 && y < 10 ? [240, 252, 250] : paper()));
  const within = await png(40, 30, (x, y) => (x < 10 && y < 10 ? [248, 252, 250] : paper()));
  const glyph = await png(40, 30, (x, y) => (x === 5 && y < 3 ? [29, 29, 26] : paper()));
  assert.deepEqual(await comparePixels(faint, expected, THRESHOLDS).then(({weak, strong, largestDelta}) => [weak, strong, largestDelta]), [100, 0, 12]);
  assert.deepEqual(await comparePixels(within, expected, THRESHOLDS).then(({weak, strong}) => [weak, strong]), [0, 0]);
  assert.deepEqual(await comparePixels(glyph, expected, THRESHOLDS).then(({weak, strong, largestDelta}) => [weak, strong, largestDelta]), [3, 3, 224]);
});

test('captures of different sizes differ everywhere', async () => {
  const result = await comparePixels(await png(40, 30, paper), await png(40, 31, paper), THRESHOLDS);
  assert.deepEqual([result.sameSize, result.weak, result.strong, result.expectedHeight], [false, 1240, 1240, 31]);
});

test('the difference image marks exactly the differing pixels', async () => {
  const expected = await png(20, 10, paper);
  const actual = await png(20, 10, (x, y) => (x === 3 && y === 4 ? [0, 0, 0] : paper()));
  const {data, info} = await sharp(await differenceImage(actual, expected, THRESHOLDS)).raw().toBuffer({resolveWithObject: true});
  const marked: number[] = [];
  for (let pixel = 0; pixel < info.width * info.height; pixel += 1) {
    const offset = pixel * info.channels;
    if (data[offset] === 235 && data[offset + 1] === 58 && data[offset + 2] === 150) {
      marked.push(pixel);
    }
  }
  assert.deepEqual(marked, [4 * 20 + 3]);
});
