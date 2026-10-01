/**
 * M1.4 / IC04: raster derivatives. Widths, aspect ratio and the no-upscale
 * rule (D40), EXIF orientation, sRGB conversion, metadata stripping, quality,
 * names, and the pixel limit. The DEP03 paths — AVIF present and absent, the
 * cache, and an unavailable sharp — are in images-cache.test.ts.
 *
 * Sources are bytes: an absent file, a link and the byte limit belong to
 * `FileAccess`, which reads them (D155, D159), and are tested there. The
 * author's problems come back as values (D157).
 */
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readdirSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, test} from 'node:test';
import sharp from 'sharp';

import {
  DEFAULT_TRANSFORM_POLICY,
  DERIVATIVE_WIDTHS,
  deriveImage,
  derivativeName,
  planWidths,
  pngFrameCount,
  probeImage,
  sniffRasterFormat,
  WEBP_MAX_DIMENSION,
  type DeriveImageInput,
  type ImageProblem,
  type ImageProblemCode,
  type ImageProbeResult,
  type ImageResult,
  type TransformPolicy,
} from '../../src/core/images.js';
import {INPUT_LIMITS} from '../../src/core/limits.js';
import {
  P3_FIXTURE_SRGB,
  SVG_MARKUP,
  animatedWebpSource,
  apngSource,
  gifSource,
  jpegSource,
  p3Source,
  pngHeaderOnly,
  pngSource,
  truncatedJpegSource,
  webpSource,
} from '../fixtures/images/generate.js';

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    rmSync(root, {recursive: true, force: true});
  }
});

function workspace(label: string): {root: string; out: string; cache: string} {
  const root = mkdtempSync(join(tmpdir(), `papeleria-images-${label}-`));
  roots.push(root);
  return {root, out: join(root, 'out'), cache: join(root, 'cache')};
}

/** Geometry tests do not need AVIF, which is by far the slowest encoder. */
const WEBP_ONLY: TransformPolicy = {...DEFAULT_TRANSFORM_POLICY, avif: 'off'};

function input(
  space: {out: string; cache: string},
  bytes: Uint8Array,
  relativePath: string,
  policy: TransformPolicy = WEBP_ONLY,
): DeriveImageInput {
  return {bytes, relativePath, outputDir: space.out, cacheDir: space.cache, policy};
}

/** The problem a call returned, checked for the IC01 shape of a binary finding. */
async function problemOf(pending: Promise<ImageResult | ImageProbeResult>, code: ImageProblemCode): Promise<ImageProblem> {
  const result = await pending;
  assert.ok(!result.ok, `expected the problem ${code}, but the call succeeded`);
  assert.equal(result.problem.code, code, result.problem.message);
  assert.equal(result.problem.rule, 'R09');
  assert.equal(result.problem.line, null, 'binary findings have no text line (IC01)');
  assert.ok(result.problem.message.length > 0 && result.problem.fix.length > 0);
  return result.problem;
}

/** A successful result, narrowed. */
async function completed(pending: Promise<ImageResult>): Promise<Extract<ImageResult, {ok: true}>> {
  const result = await pending;
  assert.ok(result.ok, result.ok ? '' : `unexpected problem ${result.problem.code}: ${result.problem.message}`);
  return result;
}

async function probed(pending: Promise<ImageProbeResult>): Promise<Extract<ImageProbeResult, {ok: true}>['probe']> {
  const result = await pending;
  assert.ok(result.ok, result.ok ? '' : `unexpected problem ${result.problem.code}: ${result.problem.message}`);
  return result.probe;
}

function listFiles(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory, {recursive: true, withFileTypes: true})
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

test('the IC04 settings are the fixed contract values', () => {
  assert.deepEqual([...DERIVATIVE_WIDTHS], [800, 1600]);
  assert.equal(DEFAULT_TRANSFORM_POLICY.webpQuality, 80);
  assert.equal(DEFAULT_TRANSFORM_POLICY.avifQuality, 50);
  assert.equal(DEFAULT_TRANSFORM_POLICY.avif, 'auto');
  assert.equal(DEFAULT_TRANSFORM_POLICY.orientation, 'exif');
  assert.equal(INPUT_LIMITS.mediaBytes, 104_857_600);
  assert.equal(INPUT_LIMITS.imagePixels, 100_000_000);
  assert.ok(Object.isFrozen(DEFAULT_TRANSFORM_POLICY));
});

test('D40: widths never exceed the oriented source width; a narrow source keeps its own width', () => {
  const cases: Array<[number, number[]]> = [
    [5000, [800, 1600]],
    [1601, [800, 1600]],
    [1600, [800, 1600]],
    [1599, [800]],
    [1000, [800]],
    [801, [800]],
    [800, [800]],
    [799, [799]],
    [600, [600]],
    [1, [1]],
  ];
  for (const [source, expected] of cases) {
    assert.deepEqual(planWidths(source), expected, `source width ${source}`);
  }
  assert.throws(() => planWidths(0), TypeError);
  assert.throws(() => planWidths(12.5), TypeError);
});

test('a 2000 px PNG yields WebP at 800 and 1600 px with the aspect ratio kept', async () => {
  const space = workspace('widths');
  const source = await pngSource(2000, 1000);
  const result = await completed(deriveImage(input(space, source, 'assets/images/wide.png')));

  assert.deepEqual(result.probe, {width: 2000, height: 1000, bytes: source.length, kind: 'raster', format: 'png'});
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(
    result.derivatives.map(({width, height, format}) => ({width, height, format})),
    [
      {width: 800, height: 400, format: 'webp'},
      {width: 1600, height: 800, format: 'webp'},
    ],
  );
  for (const derivative of result.derivatives) {
    const bytes = readFileSync(join(space.out, derivative.path));
    assert.equal(bytes.length, derivative.bytes, 'reported bytes are the file size');
    const metadata = await sharp(bytes).metadata();
    assert.equal(metadata.format, 'webp');
    assert.equal(metadata.width, derivative.width);
    assert.equal(metadata.height, derivative.height);
  }
});

test('a 1000 px source yields 800 only, a 1600 px source both, a 600 px source one at 600 (no upscaling)', async () => {
  const space = workspace('upscale');
  const cases: Array<[number, number, Array<[number, number]>]> = [
    [1000, 500, [[800, 400]]],
    [1600, 200, [[800, 100], [1600, 200]]],
    [600, 300, [[600, 300]]],
  ];
  for (const [width, height, expected] of cases) {
    const result = await completed(deriveImage(input(space, await pngSource(width, height), `assets/images/w${width}.png`)));
    assert.deepEqual(
      result.derivatives.map((derivative) => [derivative.width, derivative.height]),
      expected,
      `source ${width}×${height}`,
    );
  }
});

test('EXIF orientation is applied: a stored 400×200 JPEG with orientation 6 becomes 200×400', async () => {
  const space = workspace('orientation');
  const source = await jpegSource(400, 200, 6);
  const stored = await sharp(source).metadata();
  assert.equal(stored.width, 400, 'the fixture stores the pixels unrotated');
  assert.equal(stored.orientation, 6);

  const result = await completed(deriveImage(input(space, source, 'assets/images/turned.jpg')));
  assert.equal(result.probe.width, 200);
  assert.equal(result.probe.height, 400);
  const [derivative] = result.derivatives;
  assert.ok(derivative);
  assert.equal(derivative.width, 200);
  assert.equal(derivative.height, 400);

  const bytes = readFileSync(join(space.out, derivative.path));
  const metadata = await sharp(bytes).metadata();
  assert.equal(metadata.orientation, undefined, 'the orientation tag is gone once applied');
  // The fixture's red channel rises from left to right as stored. Turned 90°
  // clockwise, stored x becomes displayed y: red must rise from top to bottom.
  const {data, info} = await sharp(bytes).raw().toBuffer({resolveWithObject: true});
  const red = (x: number, y: number) => data[(y * info.width + x) * info.channels] ?? -1;
  assert.ok(red(100, 5) < 60, `top red ${red(100, 5)}`);
  assert.ok(red(100, 394) > 190, `bottom red ${red(100, 394)}`);
});

test('derivatives carry no EXIF, XMP or ICC profile and are sRGB', async () => {
  const space = workspace('metadata');
  const source = await jpegSource(900, 300);
  const original = await sharp(source).metadata();
  assert.ok(original.exif && original.xmp, 'the fixture really carries EXIF and XMP');

  const result = await completed(deriveImage(input(space, source, 'assets/images/tagged.jpg')));
  for (const derivative of result.derivatives) {
    const metadata = await sharp(readFileSync(join(space.out, derivative.path))).metadata();
    assert.equal(metadata.exif, undefined);
    assert.equal(metadata.xmp, undefined);
    assert.equal(metadata.icc, undefined);
    assert.equal(metadata.hasProfile, false);
    assert.equal(metadata.space, 'srgb');
  }
});

test('a Display P3 source is converted to sRGB, not merely stripped of its profile', async () => {
  const space = workspace('p3');
  const source = await p3Source();
  const stored = await sharp(source, {ignoreIcc: true}).raw().toBuffer();
  const storedPixel = [...stored.subarray(0, 3)];
  const distance = (a: readonly number[], b: readonly number[]) => Math.max(...a.map((value, index) => Math.abs(value - (b[index] ?? 0))));
  assert.ok(distance(storedPixel, P3_FIXTURE_SRGB) >= 8, `stored P3 numbers ${storedPixel} must differ from the sRGB colour`);

  const result = await completed(deriveImage(input(space, source, 'assets/images/p3.png')));
  const [derivative] = result.derivatives;
  assert.ok(derivative);
  const bytes = readFileSync(join(space.out, derivative.path));
  assert.equal((await sharp(bytes).metadata()).hasProfile, false);
  const derived = [...(await sharp(bytes).raw().toBuffer()).subarray(0, 3)];
  assert.ok(distance(derived, P3_FIXTURE_SRGB) <= 4, `derived ${derived} must be the sRGB colour ${P3_FIXTURE_SRGB}`);
});

test('WebP is written at quality 80 exactly', async () => {
  const space = workspace('quality');
  const source = await webpSource(1000, 250);
  const result = await completed(deriveImage(input(space, source, 'assets/images/q.webp')));
  const [derivative] = result.derivatives;
  assert.ok(derivative);
  const written = readFileSync(join(space.out, derivative.path));
  const reproduce = (quality: number) =>
    sharp(source, {autoOrient: true})
      .resize({width: 800, kernel: 'lanczos3'})
      .toColourspace('srgb')
      .webp({quality, effort: 4})
      .toBuffer();
  assert.ok(written.equals(await reproduce(80)), 'the derivative is the quality-80 encode');
  assert.ok(!written.equals(await reproduce(79)), 'and not the quality-79 one, so the check can fail');
});

test('names keep the directory and combine stem, content hash with extension, width and format', async () => {
  const space = workspace('names');
  const bytes = await pngSource(900, 90);
  const name = derivativeName('assets/images/team/pier.png', bytes, 800, 'webp');
  assert.match(name, /^pier\.[0-9a-f]{16}\.800\.webp$/);
  assert.equal(derivativeName('assets/images/team/pier.png', bytes, 800, 'webp'), name, 'stable');
  assert.notEqual(derivativeName('assets/images/a.png', bytes, 800, 'webp'), derivativeName('assets/images/a.jpg', bytes, 800, 'webp'));
  assert.notEqual(derivativeName('assets/images/a.png', bytes, 800, 'webp'), derivativeName('assets/images/a.png', bytes, 1600, 'webp'));
  assert.notEqual(derivativeName('assets/images/a.png', bytes, 800, 'webp'), derivativeName('assets/images/a.png', bytes, 800, 'avif'));
  assert.equal(derivativeName('assets/images/photo.v2.png', bytes, 800, 'webp').split('.').slice(0, 2).join('.'), 'photo.v2');

  const first = await completed(deriveImage(input(space, bytes, 'assets/images/team/a.png')));
  const second = await completed(deriveImage(input(space, bytes, 'assets/images/team/a.jpg')));
  const [one] = first.derivatives;
  const [two] = second.derivatives;
  assert.ok(one && two);
  assert.match(one.path, /^assets\/images\/team\/a\.[0-9a-f]{16}\.800\.webp$/);
  assert.notEqual(one.path, two.path, 'same stem and bytes, different extension: no collision');
  assert.equal(listFiles(space.out).length, 2);
  assert.equal(sniffRasterFormat(bytes), 'png');
});

test('more than 100 MiB of source bytes is a caller defect; exactly 100 MiB is read as an image', async () => {
  const space = workspace('size');
  // FileAccess owns the byte limit (D159): bytes over it never reach this module
  // from resolve or the pipeline, so passing them is a programming error.
  const over = Buffer.alloc(INPUT_LIMITS.mediaBytes + 1);
  pngHeaderOnly(64, 64).copy(over);
  await assert.rejects(probeImage(over), RangeError);
  await assert.rejects(deriveImage(input(space, over, 'assets/images/big.png')), RangeError);

  // Exactly at the limit the bytes are accepted; the header reads as a 64×64
  // PNG whose pixels are missing, which is a decode failure instead.
  const exact = over.subarray(0, INPUT_LIMITS.mediaBytes);
  const atLimit = await probed(probeImage(exact));
  assert.equal(atLimit.bytes, INPUT_LIMITS.mediaBytes);
  await problemOf(deriveImage(input(space, exact, 'assets/images/exact.png')), 'undecodable');
  assert.deepEqual(listFiles(space.out), []);
});

test('decoding is limited to 100,000,000 pixels, inclusive, checked from the header', async () => {
  const space = workspace('pixels');
  const probe = await probed(probeImage(pngHeaderOnly(10_000, 10_000)));
  assert.equal(probe.width * probe.height, INPUT_LIMITS.imagePixels);

  const refused = await problemOf(probeImage(pngHeaderOnly(10_000, 10_001)), 'too_many_pixels');
  assert.match(refused.message, /10,000 × 10,001 = 100,010,000 pixels/);
  await problemOf(deriveImage(input(space, pngHeaderOnly(20_000, 6_000), 'assets/images/huge.png')), 'too_many_pixels');
  assert.deepEqual(listFiles(space.out), []);
});

test('a derivative taller than WebP allows is refused before encoding', async () => {
  const space = workspace('tall');
  const refused = await problemOf(deriveImage(input(space, pngHeaderOnly(800, 16_400), 'assets/images/strip.png')), 'too_tall');
  assert.match(refused.message, /16,400 px tall/);
});

test('the WebP height limit is judged after the EXIF turn, at exactly 16,383 and 16,384 pixels (G12)', async () => {
  const space = workspace('turned-strip');
  // Stored 16,383 × 1 and tagged to turn 90°: shown 1 px wide and 16,383 tall, the tallest WebP there is.
  const tallest = await jpegSource(WEBP_MAX_DIMENSION, 1, 6);
  assert.equal((await sharp(tallest).metadata()).width, WEBP_MAX_DIMENSION, 'the fixture stores the pixels unturned');
  const kept = await completed(deriveImage(input(space, tallest, 'assets/images/tallest.jpg')));
  assert.deepEqual([kept.probe.width, kept.probe.height], [1, WEBP_MAX_DIMENSION]);
  assert.deepEqual(kept.derivatives.map((derivative) => [derivative.format, derivative.width, derivative.height]), [['webp', 1, WEBP_MAX_DIMENSION]]);
  // One pixel more is refused before anything is decoded, and nothing is written.
  const written = listFiles(space.out).length;
  const refused = await problemOf(deriveImage(input(space, await jpegSource(WEBP_MAX_DIMENSION + 1, 1, 6), 'assets/images/taller.jpg')), 'too_tall');
  assert.equal(refused.message, 'At 1 px wide the image would be 16,384 px tall; WebP images are limited to 16,383 px on each side.');
  assert.equal(listFiles(space.out).length, written);
  // Unturned, the same stored strip is 16,384 wide and one pixel tall: nothing near the limit.
  const flat = await completed(deriveImage(input(space, await jpegSource(WEBP_MAX_DIMENSION + 1, 1), 'assets/images/flat.jpg')));
  assert.deepEqual([flat.probe.width, flat.probe.height], [WEBP_MAX_DIMENSION + 1, 1]);
});

test('formats outside PNG, JPEG and WebP never reach a decoder', async () => {
  const space = workspace('formats');
  const text = await problemOf(deriveImage(input(space, Buffer.from('not an image'), 'assets/images/note.png')), 'unsupported_format');
  assert.match(text.message, /not a PNG, JPEG or WebP/);
  const svg = await problemOf(deriveImage(input(space, SVG_MARKUP, 'assets/images/mark.png')), 'unsupported_format');
  assert.match(svg.message, /SVG markup/);
  assert.match(svg.fix, /\.svg extension/);
  await problemOf(probeImage(SVG_MARKUP), 'unsupported_format');
  await problemOf(deriveImage(input(space, await gifSource(), 'assets/images/anim.png')), 'unsupported_format');
  const animated = await problemOf(deriveImage(input(space, await animatedWebpSource(), 'assets/images/anim.webp')), 'animated');
  assert.match(animated.message, /2 frames/);
  // An APNG is a PNG to libvips, which reports no frames: its acTL chunk gives it away.
  const apng = apngSource();
  assert.equal((await sharp(apng).metadata()).pages, undefined, 'libvips alone would not notice');
  const refused = await problemOf(deriveImage(input(space, apng, 'assets/images/anim.png')), 'animated');
  assert.match(refused.message, /2 frames/);
  await problemOf(probeImage(apng), 'animated');
  assert.equal(pngFrameCount(await pngSource(8, 8)), 1);
  assert.equal(pngFrameCount(apng), 2);
  assert.equal(pngFrameCount(apng.subarray(0, 40)), null, 'bytes that end before the answer say so');
  assert.deepEqual(listFiles(space.out), []);
});

test('a truncated JPEG probes from its header but fails to decode, writing nothing', async () => {
  const space = workspace('truncated');
  const source = await truncatedJpegSource();
  const probe = await probed(probeImage(source));
  assert.deepEqual([probe.width, probe.height, probe.format], [400, 300, 'jpeg']);
  const refused = await problemOf(deriveImage(input(space, source, 'assets/images/cut.jpg')), 'undecodable');
  assert.match(refused.message, /could not be decoded/);
  assert.deepEqual(listFiles(space.out), []);
});

test('the format recorded is what the bytes are, whatever the raster extension says (D160)', async () => {
  const space = workspace('mislabelled');
  const png = await pngSource(900, 300);
  assert.equal((await probed(probeImage(png))).format, 'png');
  const result = await completed(deriveImage(input(space, png, 'assets/images/labelled-as.jpg')));
  assert.equal(result.probe.format, 'png');
  assert.equal(result.derivatives.length, 1);
});

test('a relative path that could escape the output directory is a programming error', async () => {
  const space = workspace('paths');
  const bytes = await pngSource(64, 64);
  for (const relativePath of ['../escape.png', '/abs.png', 'a\\b.png', 'a//b.png', './a.png', 'C:/x.png', '']) {
    await assert.rejects(deriveImage(input(space, bytes, relativePath)), TypeError, relativePath);
  }
  assert.throws(() => derivativeName('../x.png', bytes, 800, 'webp'), TypeError);
});
