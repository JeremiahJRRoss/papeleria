/**
 * DEP03 (M1.4): the five experiments docs/DEPENDENCIES.md names for the media
 * gate — WebP success, the AVIF-present path, a simulated AVIF-unavailable
 * path, cache invalidation on a settings change, and an unavailable sharp —
 * plus the IC04 promise that cold and warm builds write byte-identical files.
 *
 * Unavailability is simulated by injecting the module loader or wrapping the
 * real sharp; nothing is uninstalled. Sources are bytes (D155); a linked
 * source file is refused by `FileAccess` before any byte reaches this module.
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash, createHmac, randomBytes} from 'node:crypto';
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, join, relative, sep} from 'node:path';
import {after, test} from 'node:test';
import sharp from 'sharp';

import {
  DEFAULT_TRANSFORM_POLICY,
  ImageToolError,
  TRANSFORM_CONTRACT_VERSION,
  deriveImage,
  detectEncoders,
  loadSharp,
  probeImage,
  type DeriveImageInput,
  type ImageOptions,
  type ImageResult,
  type SharpModule,
  type TransformPolicy,
} from '../../src/core/images.js';
import {ImageCache, canonicalJson, derivativeCacheKey, sourceCacheKey, type CacheKeyParts} from '../../src/core/image-cache.js';
import {installationKey} from '../../src/core/installation-key.js';
import {pngSource} from '../fixtures/images/generate.js';

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    rmSync(root, {recursive: true, force: true});
  }
});

// The records' key comes from a state folder of this file's own, never the
// user's (D191): set before anything reads it.
const stateHome = mkdtempSync(join(tmpdir(), 'papeleria-dep03-state-'));
roots.push(stateHome);
process.env['PAPELERIA_STATE_HOME'] = stateHome;

function workspace(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `papeleria-dep03-${label}-`));
  roots.push(root);
  return root;
}

function files(directory: string): Map<string, Buffer> {
  const found = new Map<string, Buffer>();
  if (!existsSync(directory)) {
    return found;
  }
  for (const entry of readdirSync(directory, {recursive: true, withFileTypes: true})) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      found.set(relative(directory, path).split(sep).join('/'), readFileSync(path));
    }
  }
  return found;
}

type Wrap = {
  /** Every `avif()` call throws, as in a build without the encoder. */
  noAvif?: boolean;
  /** `avif()` works on the detection tile but throws on real sources. */
  avifFailsOnSources?: boolean;
  /** Every `webp()` call throws: a broken sharp. */
  noWebp?: boolean;
  vips?: string;
  /** A different libwebp under the same libvips, as with a system libvips. */
  webp?: string;
};

type Counters = {pipelines: number; avifCalls: number};

/** Wraps the real sharp so a test can take encoders away or change the reported versions. */
function wrapSharp(wrap: Wrap, counters: Counters = {pipelines: 0, avifCalls: 0}): SharpModule {
  const real = sharp as unknown as (...args: unknown[]) => Record<string, unknown>;
  const wrapped = (...args: unknown[]) => {
    counters.pipelines += 1;
    const instance = real(...args);
    const fromSource = args[0] instanceof Uint8Array;
    const originalAvif = instance['avif'] as (...options: unknown[]) => unknown;
    instance['avif'] = (...options: unknown[]) => {
      counters.avifCalls += 1;
      if (wrap.noAvif || (wrap.avifFailsOnSources && fromSource)) {
        throw new Error('simulated: this sharp build has no AVIF encoder');
      }
      return originalAvif.apply(instance, options);
    };
    if (wrap.noWebp) {
      instance['webp'] = () => {
        throw new Error('simulated: this sharp build cannot write WebP');
      };
    }
    return instance;
  };
  Object.assign(wrapped, {
    versions: {...sharp.versions, ...(wrap.vips === undefined ? {} : {vips: wrap.vips}), ...(wrap.webp === undefined ? {} : {webp: wrap.webp})},
    concurrency: sharp.concurrency,
    simd: sharp.simd,
    format: sharp.format,
  });
  return wrapped as unknown as SharpModule;
}

function loaderFor(module: SharpModule): ImageOptions {
  return {loadSharp: async () => module};
}

/** Small, wide sources: both IC04 widths are exercised while AVIF stays fast. */
const SOURCE_WIDTH = 1700;
const SOURCE_HEIGHT = 40;

function job(root: string, bytes: Uint8Array, out: string, cache: string, policy?: TransformPolicy): DeriveImageInput {
  return {
    bytes,
    relativePath: 'assets/images/strip.png',
    outputDir: join(root, out),
    cacheDir: join(root, cache),
    ...(policy === undefined ? {} : {policy}),
  };
}

type Completed = Extract<ImageResult, {ok: true}>;

/** A successful result, narrowed; a returned problem fails the test with its message. */
async function completed(pending: Promise<ImageResult>): Promise<Completed> {
  const result = await pending;
  assert.ok(result.ok, result.ok ? '' : `unexpected problem ${result.problem.code}: ${result.problem.message}`);
  return result;
}

const formats = (result: Completed) => result.derivatives.map((derivative) => `${derivative.format}@${derivative.width}`);

test('DEP03 WebP success: both widths decode as WebP with the reported size', async () => {
  const root = workspace('webp');
  const result = await completed(deriveImage(job(root, await pngSource(SOURCE_WIDTH, SOURCE_HEIGHT), 'out', 'cache')));
  const webp = result.derivatives.filter((derivative) => derivative.format === 'webp');
  assert.deepEqual(webp.map((derivative) => derivative.width), [800, 1600]);
  for (const derivative of webp) {
    const bytes = readFileSync(join(root, 'out', derivative.path));
    assert.equal(bytes.length, derivative.bytes);
    assert.equal((await sharp(bytes).metadata()).format, 'webp');
  }
});

test('DEP03 AVIF present: detected once, written at both widths, quality 50', async () => {
  const support = await detectEncoders(sharp as unknown as SharpModule);
  if (process.platform === 'linux' && process.arch === 'x64') {
    // The reference platform's prebuilt libvips includes the AV1 encoder; losing
    // it would turn this into the absent path without anyone noticing.
    assert.equal(support.avif, true, `AVIF must be available on linux-x64: ${support.avifError ?? ''}`);
  }
  const root = workspace('avif');
  const source = await pngSource(SOURCE_WIDTH, SOURCE_HEIGHT);
  const result = await completed(deriveImage(job(root, source, 'out', 'cache')));
  if (!support.avif) {
    assert.deepEqual(formats(result), ['webp@800', 'webp@1600']);
    assert.equal(result.warnings[0]?.code, 'avif_unavailable');
    return;
  }
  assert.deepEqual(formats(result), ['webp@800', 'avif@800', 'webp@1600', 'avif@1600']);
  assert.deepEqual(result.warnings, []);
  const avif800 = result.derivatives.find((derivative) => derivative.format === 'avif' && derivative.width === 800);
  assert.ok(avif800);
  assert.match(avif800.path, /\.800\.avif$/);
  const written = readFileSync(join(root, 'out', avif800.path));
  const metadata = await sharp(written).metadata();
  assert.equal(metadata.format, 'heif');
  assert.equal(metadata.compression, 'av1');
  assert.equal(metadata.hasProfile, false);
  const reproduce = (quality: number) =>
    sharp(source, {autoOrient: true})
      .resize({width: 800, kernel: 'lanczos3'})
      .toColourspace('srgb')
      .avif({quality, effort: 4, chromaSubsampling: '4:4:4', bitdepth: 8})
      .toBuffer();
  assert.ok(written.equals(await reproduce(50)), 'the AVIF derivative is the quality-50 encode');
  assert.ok(!written.equals(await reproduce(60)));
});

test('DEP03 AVIF unavailable (simulated): one warning, WebP-only output, detection attempted once', async () => {
  const counters = {pipelines: 0, avifCalls: 0};
  const module = wrapSharp({noAvif: true}, counters);
  const support = await detectEncoders(module);
  assert.equal(support.avif, false);
  assert.match(support.avifError ?? '', /simulated/);

  const root = workspace('no-avif');
  const source = await pngSource(SOURCE_WIDTH, SOURCE_HEIGHT);
  const first = await completed(deriveImage(job(root, source, 'one', 'cache'), loaderFor(module)));
  const second = await completed(deriveImage(job(root, source, 'two', 'cache'), loaderFor(module)));
  for (const result of [first, second]) {
    assert.deepEqual(formats(result), ['webp@800', 'webp@1600']);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0]?.code, 'avif_unavailable');
    assert.equal(result.warnings[0]?.scope, 'toolchain');
    assert.match(result.warnings[0]?.message ?? '', /WebP images were written instead/);
  }
  assert.equal(counters.avifCalls, 1, 'the AVIF encoder is probed once per process, not per image');
  assert.equal(detectEncoders(module), detectEncoders(module), 'the detection is shared');
});

test('DEP03 AVIF failing on one source only: that image degrades to WebP with an image-scoped warning', async () => {
  const module = wrapSharp({avifFailsOnSources: true});
  assert.equal((await detectEncoders(module)).avif, true, 'the tile probe succeeds');
  const root = workspace('avif-one');
  const result = await completed(deriveImage(job(root, await pngSource(SOURCE_WIDTH, SOURCE_HEIGHT), 'out', 'cache'), loaderFor(module)));
  assert.deepEqual(formats(result), ['webp@800', 'webp@1600'], 'no partial AVIF set');
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0]?.scope, 'image');
  assert.deepEqual([...files(join(root, 'out')).keys()].filter((path) => path.endsWith('.avif')), []);
});

test('DEP03 sharp unavailable: a failing loader is a hard error with a clear message, never a fallback', async () => {
  const root = workspace('no-sharp');
  const source = await pngSource(64, 64);
  const missing: ImageOptions = {
    loadSharp: async () => {
      throw Object.assign(new Error("Cannot find package 'sharp' imported from papeleria"), {code: 'ERR_MODULE_NOT_FOUND'});
    },
  };
  const check = (error: unknown) => {
    assert.ok(error instanceof ImageToolError, String(error));
    assert.equal(error.code, 'E_SHARP_UNAVAILABLE');
    assert.match(error.message, /sharp could not be loaded/);
    assert.match(error.message, /Cannot find package 'sharp'/);
    assert.match(error.message, /npm ci/);
    return true;
  };
  await assert.rejects(deriveImage(job(root, source, 'out', 'cache'), missing), check);
  await assert.rejects(probeImage(source, missing), check);
  await assert.rejects(loadSharp(missing.loadSharp), check);
  assert.equal(existsSync(join(root, 'out')), false, 'nothing is written');
  assert.equal(existsSync(join(root, 'cache')), false, 'not even the cache');

  await assert.rejects(loadSharp(async () => ({}) as unknown as SharpModule), (error: unknown) => {
    assert.ok(error instanceof ImageToolError);
    assert.equal(error.code, 'E_SHARP_UNAVAILABLE');
    assert.match(error.message, /no libvips version/);
    return true;
  });
});

test('DEP03 broken sharp: loads, but a WebP encode fails, which is a hard error too', async () => {
  const root = workspace('no-webp');
  const module = wrapSharp({noWebp: true});
  await assert.rejects(deriveImage(job(root, await pngSource(64, 64), 'out', 'cache'), loaderFor(module)), (error: unknown) => {
    assert.ok(error instanceof ImageToolError);
    assert.equal(error.code, 'E_SHARP_UNAVAILABLE');
    assert.match(error.message, /cannot encode WebP/);
    return true;
  });
  assert.equal(existsSync(join(root, 'out')), false);
});

test('a warm build reuses every derivative without opening a sharp pipeline', async () => {
  const counters = {pipelines: 0, avifCalls: 0};
  const module = wrapSharp({}, counters);
  const root = workspace('warm');
  const source = await pngSource(SOURCE_WIDTH, SOURCE_HEIGHT);
  const cold = await completed(deriveImage(job(root, source, 'cold', 'cache'), loaderFor(module)));
  assert.ok(cold.derivatives.every((derivative) => !derivative.cached));
  const afterCold = counters.pipelines;
  assert.ok(afterCold > 0);

  const warm = await completed(deriveImage(job(root, source, 'warm', 'cache'), loaderFor(module)));
  assert.ok(warm.derivatives.every((derivative) => derivative.cached));
  assert.equal(counters.pipelines, afterCold, 'no decode, no encode, no header read on a warm build');
  assert.deepEqual(warm.probe, cold.probe);
});

test('DEP03 cache invalidation: a changed setting re-encodes exactly the derivatives it affects', async () => {
  const root = workspace('invalidate');
  const source = await pngSource(SOURCE_WIDTH, SOURCE_HEIGHT);
  const avif = (await detectEncoders(sharp as unknown as SharpModule)).avif;
  const byKey = (result: Completed) =>
    new Map(result.derivatives.map((derivative) => [`${derivative.format}@${derivative.width}`, derivative]));

  const base = byKey(await completed(deriveImage(job(root, source, 'base', 'cache'))));
  const again = byKey(await completed(deriveImage(job(root, source, 'again', 'cache'))));
  assert.ok([...again.values()].every((derivative) => derivative.cached), 'same settings: every entry hits');

  // WebP quality 80 → 81: every WebP entry misses; AVIF entries are untouched.
  const quality: TransformPolicy = {...DEFAULT_TRANSFORM_POLICY, webpQuality: 81};
  const requality = byKey(await completed(deriveImage(job(root, source, 'quality', 'cache', quality))));
  for (const [label, derivative] of requality) {
    const isWebp = label.startsWith('webp');
    assert.equal(derivative.cached, !isWebp, `${label} after a WebP quality change`);
    const before = readFileSync(join(root, 'base', base.get(label)?.path ?? ''));
    const now = readFileSync(join(root, 'quality', derivative.path));
    assert.equal(before.equals(now), !isWebp, `${label} bytes`);
  }

  // A different libvips version: every entry misses, including the source record.
  const bumped = byKey(await completed(deriveImage(job(root, source, 'vips', 'cache'), loaderFor(wrapSharp({vips: '0.0.0-test'})))));
  assert.ok([...bumped.values()].every((derivative) => !derivative.cached), 'a library version change re-encodes everything');

  // A different libwebp under the same libvips (a system libvips can do this): every entry misses too.
  const encoder = byKey(await completed(deriveImage(job(root, source, 'libwebp', 'cache'), loaderFor(wrapSharp({webp: '0.0.0-test'})))));
  assert.ok([...encoder.values()].every((derivative) => !derivative.cached), 'an encoder library change re-encodes everything');

  // SIMD off: libvips may take different arithmetic paths, so nothing is reused.
  const simd = sharp.simd();
  try {
    sharp.simd(!simd);
    const switched = byKey(await completed(deriveImage(job(root, source, 'simd', 'cache'))));
    assert.ok([...switched.values()].every((derivative) => !derivative.cached), 'a SIMD change re-encodes');
  } finally {
    sharp.simd(simd);
  }

  // A different libvips thread count: AVIF misses (its bytes depend on it), WebP hits.
  if (avif) {
    const previous = sharp.concurrency();
    try {
      sharp.concurrency(previous === 2 ? 3 : 2);
      const threaded = byKey(await completed(deriveImage(job(root, source, 'threads', 'cache'))));
      for (const [label, derivative] of threaded) {
        assert.equal(derivative.cached, label.startsWith('webp'), `${label} after a thread-count change`);
      }
    } finally {
      sharp.concurrency(previous);
    }
    const restored = byKey(await completed(deriveImage(job(root, source, 'restored', 'cache'))));
    assert.ok([...restored.values()].every((derivative) => derivative.cached), 'the original entries are still valid');
  }
});

test('every key part changes the cache key', () => {
  const base: CacheKeyParts = {
    contractVersion: 1,
    sourceSha256: 'a'.repeat(64),
    width: 800,
    format: 'webp',
    quality: 80,
    orientation: 'exif',
    encoder: {kernel: 'lanczos3', effort: 4},
    sharpVersion: '0.35.4',
    libvipsVersion: '8.18.6',
    libraries: {vips: '8.18.6', webp: '1.6.0', aom: '3.15.0'},
    platform: 'linux',
    arch: 'x64',
    simd: true,
    threads: null,
  };
  const key = derivativeCacheKey(base);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(derivativeCacheKey({...base, encoder: {effort: 4, kernel: 'lanczos3'}}), key, 'field order does not matter');
  const variants: Array<Partial<CacheKeyParts> | Record<string, unknown>> = [
    {contractVersion: 2},
    {sourceSha256: 'b'.repeat(64)},
    {width: 1600},
    {format: 'avif'},
    {quality: 81},
    {orientation: 'none'},
    {encoder: {kernel: 'lanczos3', effort: 5}},
    {sharpVersion: '0.35.5'},
    {libvipsVersion: '8.18.7'},
    {libraries: {vips: '8.18.6', webp: '1.6.1', aom: '3.15.0'}},
    {libraries: {vips: '8.18.6', webp: '1.6.0', aom: '3.15.0', heif: '1.23.2'}},
    {platform: 'darwin'},
    {arch: 'arm64'},
    {simd: false},
    {threads: 4},
  ];
  const seen = new Set([key]);
  for (const variant of variants) {
    const changed = derivativeCacheKey({...base, ...variant} as CacheKeyParts);
    assert.ok(!seen.has(changed), `changing ${Object.keys(variant).join()} must change the key`);
    seen.add(changed);
  }
  const source = {
    contractVersion: 1,
    sourceSha256: 'a'.repeat(64),
    sharpVersion: '0.35.4',
    libvipsVersion: '8.18.6',
    libraries: {vips: '8.18.6'},
    platform: 'linux',
    arch: 'x64',
  };
  assert.notEqual(sourceCacheKey(source), sourceCacheKey({...source, libvipsVersion: '8.18.7'}));
  assert.notEqual(sourceCacheKey(source), sourceCacheKey({...source, arch: 'arm64'}));
  assert.notEqual(sourceCacheKey(source), key, 'source and derivative keys live in different domains');
});

test('a damaged cache entry reads as a miss and is repaired', async () => {
  const root = workspace('damaged');
  const source = await pngSource(900, 60);
  const policy: TransformPolicy = {...DEFAULT_TRANSFORM_POLICY, avif: 'off'};
  const first = await completed(deriveImage(job(root, source, 'one', 'cache', policy)));
  const cached = [...files(join(root, 'cache')).keys()].filter((path) => path.endsWith('.webp'));
  assert.equal(cached.length, 1);
  writeFileSync(join(root, 'cache', cached[0] ?? ''), 'damaged');

  const second = await completed(deriveImage(job(root, source, 'two', 'cache', policy)));
  assert.equal(second.derivatives[0]?.cached, false, 'the digest check catches the damage');
  assert.ok(files(join(root, 'one')).get(first.derivatives[0]?.path ?? '')?.equals(readFileSync(join(root, 'two', second.derivatives[0]?.path ?? ''))));
  const third = await completed(deriveImage(job(root, source, 'three', 'cache', policy)));
  assert.equal(third.derivatives[0]?.cached, true, 'the entry was rewritten');
});

/** Absolute paths of the files under `cacheDir` whose cache-relative path matches `pattern`. */
function cacheFiles(cacheDir: string, pattern: RegExp): string[] {
  return [...files(cacheDir).keys()].filter((path) => pattern.test(path)).map((path) => join(cacheDir, path));
}

/** `text` with some JSON fields replaced, as a damaged or hand-edited entry would read. */
function edited(text: string, changes: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({...(JSON.parse(text) as Record<string, unknown>), ...changes}, null, 2);
}

/** What a build reports about each derivative, apart from whether it came from the cache. */
const reported = (result: Completed) =>
  result.derivatives.map((derivative) => `${derivative.path} ${derivative.width}×${derivative.height} ${derivative.bytes}`);

test('D43: source facts are used only when the whole record is intact, is its key\'s and names the format the bytes are', async () => {
  const counters = {pipelines: 0, avifCalls: 0};
  const options = loaderFor(wrapSharp({}, counters));
  const root = workspace('facts');
  const policy: TransformPolicy = {...DEFAULT_TRANSFORM_POLICY, avif: 'off'};
  const source = await pngSource(SOURCE_WIDTH, SOURCE_HEIGHT);
  const build = (out: string) => completed(deriveImage(job(root, source, out, 'cache', policy), options));
  const cold = await build('cold');
  const [facts] = cacheFiles(join(root, 'cache'), /\/sources\//);
  assert.ok(facts !== undefined);
  const intact = readFileSync(facts, 'utf8');
  await completed(deriveImage(job(root, await pngSource(900, 60), 'other', 'cache-other', policy), options));
  const [otherFacts] = cacheFiles(join(root, 'cache-other'), /\/sources\//);
  assert.ok(otherFacts !== undefined);

  const damaged: ReadonlyArray<readonly [string, () => Promise<void>]> = [
    // Would plan one 700 px derivative instead of 800 and 1600.
    ['a narrower width', async () => writeFileSync(facts, edited(intact, {width: 700}))],
    // Would refuse a valid image as too_tall, an author error for a cache fault.
    ['a taller height', async () => writeFileSync(facts, edited(intact, {height: 49_000}))],
    // Would report a PNG as a JPEG.
    ['another format', async () => writeFileSync(facts, edited(intact, {format: 'jpeg'}))],
    // A number JSON reads as Infinity: damage, not a tool failure.
    ['an infinite width', async () => writeFileSync(facts, intact.replace(/"width": \d+/, '"width": 1e999'))],
    // Whole and valid, but for another source.
    ["another source's record", async () => writeFileSync(facts, readFileSync(otherFacts))],
    // Whole and for this key, but naming a format the bytes are not.
    [
      'a record naming another format',
      async () =>
        new ImageCache(join(root, 'cache'), TRANSFORM_CONTRACT_VERSION, (await installationKey()).bytes).writeSource(basename(facts, '.json'), {
          width: SOURCE_WIDTH,
          height: SOURCE_HEIGHT,
          format: 'jpeg',
        }),
    ],
  ];
  for (const [index, [label, damage]] of damaged.entries()) {
    await damage();
    const before = counters.pipelines;
    const warm = await build(`warm-${index}`);
    assert.equal(counters.pipelines - before, 1, `${label}: a miss, so the header is read again`);
    assert.deepEqual(warm.probe, cold.probe, `${label}: probe`);
    assert.deepEqual(reported(warm), reported(cold), `${label}: derivatives`);
    assert.deepEqual(files(join(root, `warm-${index}`)), files(join(root, 'cold')), `${label}: files`);
    const repaired = counters.pipelines;
    await build(`again-${index}`);
    assert.equal(counters.pipelines, repaired, `${label}: the record was rewritten and now hits`);
  }
});

test('D43: a derivative is served only when its whole sidecar is intact and is its key\'s', async () => {
  const root = workspace('sidecars');
  const policy: TransformPolicy = {...DEFAULT_TRANSFORM_POLICY, avif: 'off'};
  const source = await pngSource(SOURCE_WIDTH, SOURCE_HEIGHT);
  const build = (out: string) => completed(deriveImage(job(root, source, out, 'cache', policy)));
  const cold = await build('cold');
  const sidecars = new Map(
    cacheFiles(join(root, 'cache'), /\/derivatives\/.+\.json$/).map(
      (path) => [(JSON.parse(readFileSync(path, 'utf8')) as {width: number}).width, path] as const,
    ),
  );
  const narrow = sidecars.get(800);
  const wide = sidecars.get(1600);
  assert.ok(narrow !== undefined && wide !== undefined && sidecars.size === 2);

  // Dimensions edited; the size and SHA-256 of the bytes left as they were.
  for (const path of [narrow, wide]) {
    writeFileSync(path, edited(readFileSync(path, 'utf8'), {width: 1234, height: 99}));
  }
  const resized = await build('resized');
  assert.deepEqual(resized.derivatives.map((derivative) => derivative.cached), [false, false]);
  assert.deepEqual(reported(resized), reported(cold));

  // The 800 px entry, bytes and sidecar together, copied over the 1600 px one:
  // whole and consistent, but another key's.
  copyFileSync(narrow.replace(/\.json$/, '.webp'), wide.replace(/\.json$/, '.webp'));
  copyFileSync(narrow, wide);
  const moved = await build('moved');
  assert.deepEqual(moved.derivatives.map((derivative) => derivative.cached), [true, false]);
  assert.deepEqual(reported(moved), reported(cold));

  const again = await build('again');
  assert.ok(again.derivatives.every((derivative) => derivative.cached), 'both entries were rewritten');
  for (const out of ['resized', 'moved', 'again']) {
    assert.deepEqual(files(join(root, out)), files(join(root, 'cold')), `${out}: the cold build's files`);
  }
});

type Fields = Record<string, unknown>;

/** A record's check under `recordKey`, as image-cache.ts signs one (D191). */
function signedCheck(recordKey: Uint8Array, key: string, fields: Fields): string {
  return createHmac('sha256', recordKey).update(`papeleria-image-derivatives-record\u0000${canonicalJson({key, fields})}`).digest('hex');
}

/** A record's check as anyone could compute it before D191: SHA-256 with no key. */
function unkeyedCheck(key: string, fields: Fields): string {
  return createHash('sha256').update(`papeleria-image-derivatives-record\u0000${canonicalJson({key, fields})}`).digest('hex');
}

test('F6 (D191): a cache that came with the piece is never published; only records this installation signed are served', async () => {
  const root = workspace('forged');
  const policy: TransformPolicy = {...DEFAULT_TRANSFORM_POLICY, avif: 'off'};
  const source = await pngSource(900, 60);
  const mine = (await installationKey()).bytes;
  const theirs = randomBytes(32);
  const build = (out: string, recordKey?: Uint8Array) => completed(deriveImage(job(root, source, out, 'cache', policy), recordKey === undefined ? {} : {recordKey}));
  const cold = await build('cold');
  assert.deepEqual(cold.derivatives.map((derivative) => `${derivative.width}×${derivative.height}`), ['800×53']);
  const [sidecar] = cacheFiles(join(root, 'cache'), /\/derivatives\/.+\.json$/);
  assert.ok(sidecar !== undefined);
  const key = basename(sidecar, '.json');
  // What a shipped cache can carry: other pixels, of the same size and format, with a sidecar that matches them.
  const other = await sharp({create: {width: 800, height: 53, channels: 3, background: {r: 200, g: 0, b: 0}}}).webp().toBuffer();
  const forge = (sign: (fields: Fields) => string): void => {
    const {check: _check, ...fields} = JSON.parse(readFileSync(sidecar, 'utf8')) as Fields;
    const forged = {...fields, bytes: other.length, sha256: createHash('sha256').update(other).digest('hex')};
    writeFileSync(sidecar.replace(/\.json$/, '.webp'), other);
    writeFileSync(sidecar, JSON.stringify({...forged, check: sign(forged)}, null, 2));
  };
  const forgeries: ReadonlyArray<readonly [string, (fields: Fields) => string]> = [
    ['a check with no key, which anyone can compute', (fields) => unkeyedCheck(key, fields)],
    ['a check signed by another installation', (fields) => signedCheck(theirs, key, fields)],
  ];
  for (const [index, [label, sign]] of forgeries.entries()) {
    forge(sign);
    const warm = await build(`forged-${index}`);
    assert.equal(warm.derivatives[0]?.cached, false, `${label}: a miss`);
    assert.deepEqual(files(join(root, `forged-${index}`)), files(join(root, 'cold')), `${label}: the derivative published is the source's own`);
  }
  // Signed with this installation's key, the same forgery would be served: the key is what keeps it out.
  forge((fields) => signedCheck(mine, key, fields));
  const trusted = await build('trusted');
  assert.equal(trusted.derivatives[0]?.cached, true);
  assert.ok(readFileSync(join(root, 'trusted', trusted.derivatives[0]!.path)).equals(other));
  // A cache another installation wrote reads as misses throughout, and is its own again once written.
  const elsewhere = await build('elsewhere', theirs);
  assert.ok(elsewhere.derivatives.every((derivative) => !derivative.cached));
  assert.ok((await build('elsewhere-again', theirs)).derivatives.every((derivative) => derivative.cached));
  assert.throws(() => new ImageCache(join(root, 'cache'), TRANSFORM_CONTRACT_VERSION, new Uint8Array(16)), /a record key of at least 32 bytes/);
});

/**
 * Opens a FIFO for writing without blocking and closes it, which releases a
 * reader blocked opening it. False when nobody has it open for reading (ENXIO).
 */
function releaseFifoReader(fifo: string): boolean {
  try {
    closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
    return true;
  } catch {
    return false;
  }
}

test(
  'D43: a FIFO in place of a cache entry is a miss, never opened, and is replaced by the entry',
  {skip: process.platform === 'win32' ? 'Windows has no FIFOs' : false},
  async () => {
    const root = workspace('fifo');
    const policy: TransformPolicy = {...DEFAULT_TRANSFORM_POLICY, avif: 'off'};
    const source = await pngSource(900, 60);
    const build = (out: string) => completed(deriveImage(job(root, source, out, 'cache', policy)));
    const cold = await build('cold');
    const entries: ReadonlyArray<readonly [string, RegExp]> = [
      ['source facts', /\/sources\/.+\.json$/],
      ['a derivative sidecar', /\/derivatives\/.+\.json$/],
      ['derivative bytes', /\/derivatives\/.+\.webp$/],
    ];
    for (const [index, [label, pattern]] of entries.entries()) {
      const [entry] = cacheFiles(join(root, 'cache'), pattern);
      assert.ok(entry !== undefined, label);
      rmSync(entry);
      execFileSync('mkfifo', [entry]);
      // A build blocked opening the FIFO would never settle, and the process
      // could not even exit; release it so this fails instead of hanging.
      let released = false;
      const watchdog = setInterval(() => {
        released ||= releaseFifoReader(entry);
      }, 2_000);
      let warm: Completed;
      try {
        warm = await build(`warm-${index}`);
      } finally {
        clearInterval(watchdog);
      }
      assert.equal(released, false, `${label}: the build blocked opening the FIFO`);
      assert.deepEqual(reported(warm), reported(cold), label);
      assert.ok(lstatSync(entry).isFile(), `${label}: the entry was written again as a regular file`);
    }
  },
);

test('IC04: cold and warm builds write byte-identical files on the same toolchain', async () => {
  const root = workspace('identity');
  const sources = [
    ['assets/images/strip.png', await pngSource(SOURCE_WIDTH, SOURCE_HEIGHT)],
    ['assets/images/nested/small.png', await pngSource(500, 250)],
  ] as const;
  const build = async (out: string, cache: string) => {
    for (const [relativePath, bytes] of sources) {
      await completed(deriveImage({bytes, relativePath, outputDir: join(root, out), cacheDir: join(root, cache)}));
    }
    return files(join(root, out));
  };
  const cold = await build('cold', 'cache-a');
  const warm = await build('warm', 'cache-a');
  const coldAgain = await build('cold-again', 'cache-b');

  assert.ok(cold.size >= 3, `expected several derivatives, got ${cold.size}`);
  for (const [label, other] of [['warm', warm], ['second cold', coldAgain]] as const) {
    assert.deepEqual([...other.keys()].sort(), [...cold.keys()].sort(), `${label} build writes the same paths`);
    for (const [path, bytes] of cold) {
      assert.ok(other.get(path)?.equals(bytes), `${label} build: ${path} differs`);
    }
  }
});

test('IC02: nothing is read or written through a symbolic link', async () => {
  const root = workspace('links');
  const source = await pngSource(900, 60);
  const outside = join(root, 'outside');
  mkdirSync(outside);
  const policy: TransformPolicy = {...DEFAULT_TRANSFORM_POLICY, avif: 'off'};

  // A linked directory inside the output tree would send the derivative elsewhere.
  mkdirSync(join(root, 'out-b', 'assets'), {recursive: true});
  symlinkSync(outside, join(root, 'out-b', 'assets', 'images'));
  await assert.rejects(
    deriveImage({bytes: source, relativePath: 'assets/images/strip.png', outputDir: join(root, 'out-b'), cacheDir: join(root, 'cache-b'), policy}),
    (error: unknown) => error instanceof ImageToolError && error.code === 'E_IMAGE_IO' && /symbolic link/.test(error.message),
  );
  assert.deepEqual(readdirSync(outside), [], 'nothing reached the link target');

  // The same inside the cache.
  mkdirSync(join(root, 'cache-c'), {recursive: true});
  symlinkSync(outside, join(root, 'cache-c', 'images'));
  await assert.rejects(
    deriveImage({bytes: source, relativePath: 'assets/images/strip.png', outputDir: join(root, 'out-c'), cacheDir: join(root, 'cache-c'), policy}),
    (error: unknown) => error instanceof ImageToolError && error.code === 'E_IMAGE_IO' && /symbolic link/.test(error.message),
  );
  assert.deepEqual(readdirSync(outside), []);

  // A link where the derivative file will go is replaced, never written through.
  const first = await completed(deriveImage({bytes: source, relativePath: 'assets/images/strip.png', outputDir: join(root, 'out-d'), cacheDir: join(root, 'cache-d'), policy}));
  const target = join(root, 'out-d', first.derivatives[0]?.path ?? '');
  const victim = join(outside, 'victim.txt');
  writeFileSync(victim, 'untouched');
  rmSync(target);
  symlinkSync(victim, target);
  await completed(deriveImage({bytes: source, relativePath: 'assets/images/strip.png', outputDir: join(root, 'out-d'), cacheDir: join(root, 'cache-d'), policy}));
  assert.equal(readFileSync(victim, 'utf8'), 'untouched');
  assert.equal(lstatSync(target).isSymbolicLink(), false, 'the link was replaced by the derivative');
});
