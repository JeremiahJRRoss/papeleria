/**
 * A4 (M1.9, D70): pixel comparison of two PNG captures with sharp, the image
 * library the build already depends on; no other diff tool is used.
 *
 * Both images are decoded to RGBA and compared pixel by pixel. A pixel's
 * difference is the largest difference in any of its four channels, 0 to
 * 255. Two counts come back: pixels that differ by more than `weakDelta`
 * (any visible change, such as a flat colour moving a few levels) and pixels
 * that differ by more than `strongDelta` (a glyph or an edge that moved). The
 * caller decides how many of each a capture may have.
 */
import sharp from 'sharp';

export type PixelThresholds = {readonly weakDelta: number; readonly strongDelta: number};

export type PixelComparison = {
  readonly sameSize: boolean;
  readonly width: number;
  readonly height: number;
  readonly expectedWidth: number;
  readonly expectedHeight: number;
  /** Pixels whose difference exceeds `weakDelta`; every pixel when the sizes differ. */
  readonly weak: number;
  /** Pixels whose difference exceeds `strongDelta`; every pixel when the sizes differ. */
  readonly strong: number;
  /** The largest difference of any pixel. */
  readonly largestDelta: number;
};

type Raster = {readonly data: Buffer; readonly width: number; readonly height: number};

async function decode(png: Uint8Array): Promise<Raster> {
  const {data, info} = await sharp(png).ensureAlpha().raw().toBuffer({resolveWithObject: true});
  return {data, width: info.width, height: info.height};
}

function delta(a: Buffer, b: Buffer, offset: number): number {
  let largest = 0;
  for (let channel = 0; channel < 4; channel += 1) {
    const difference = Math.abs(a[offset + channel]! - b[offset + channel]!);
    if (difference > largest) {
      largest = difference;
    }
  }
  return largest;
}

export async function comparePixels(actual: Uint8Array, expected: Uint8Array, thresholds: PixelThresholds): Promise<PixelComparison> {
  const [a, b] = await Promise.all([decode(actual), decode(expected)]);
  const sizes = {width: a.width, height: a.height, expectedWidth: b.width, expectedHeight: b.height};
  if (a.width !== b.width || a.height !== b.height) {
    const all = Math.max(a.width * a.height, b.width * b.height);
    return {sameSize: false, ...sizes, weak: all, strong: all, largestDelta: 255};
  }
  let weak = 0;
  let strong = 0;
  let largestDelta = 0;
  for (let offset = 0; offset < a.data.length; offset += 4) {
    const difference = delta(a.data, b.data, offset);
    if (difference > largestDelta) {
      largestDelta = difference;
    }
    if (difference > thresholds.weakDelta) {
      weak += 1;
    }
    if (difference > thresholds.strongDelta) {
      strong += 1;
    }
  }
  return {sameSize: true, ...sizes, weak, strong, largestDelta};
}

/**
 * A picture of the differences for a person to look at: the expected capture
 * faded to a light grey, every pixel that differs by more than `weakDelta` in
 * magenta. Captures of different sizes return the actual one unchanged.
 */
export async function differenceImage(actual: Uint8Array, expected: Uint8Array, thresholds: PixelThresholds): Promise<Uint8Array> {
  const [a, b] = await Promise.all([decode(actual), decode(expected)]);
  if (a.width !== b.width || a.height !== b.height) {
    return actual;
  }
  const out = Buffer.alloc(a.data.length);
  for (let offset = 0; offset < a.data.length; offset += 4) {
    if (delta(a.data, b.data, offset) > thresholds.weakDelta) {
      out.set([235, 58, 150, 255], offset);
    } else {
      const grey = (b.data[offset]! * 0.299 + b.data[offset + 1]! * 0.587 + b.data[offset + 2]! * 0.114) | 0;
      const faded = 255 - Math.round((255 - grey) * 0.25);
      out.set([faded, faded, faded, 255], offset);
    }
  }
  return new Uint8Array(await sharp(out, {raw: {width: a.width, height: a.height, channels: 4}}).png().toBuffer());
}
