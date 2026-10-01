/**
 * M1.4 / IC04 / DEP03: raster image derivatives.
 *
 * A raster source (PNG, JPEG or WebP) becomes WebP derivatives at the IC04
 * widths, plus AVIF derivatives when the installed encoder can write AVIF.
 * Every derivative has its EXIF orientation applied, is converted to sRGB and
 * carries no metadata. Widths never exceed the oriented source width (D40).
 *
 * It never reads the piece. A source arrives as bytes that the caller read
 * through `FileAccess` (D155), and this module's only IO is the cache it reads
 * and writes, whose records the installation key signs (D191), and the
 * derivatives it writes under the output directory it is given. The author's
 * problems come back as values; only a tool or machine failure throws (D157).
 * SVG sources never reach sharp: they are validated and copied by the vector
 * path (svg.ts), never rasterized here.
 *
 * sharp is loaded through an injectable loader. A loader that fails, or a
 * sharp that cannot encode WebP, is a hard failure (`ImageToolError`,
 * `E_SHARP_UNAVAILABLE`); there is no fallback. Only a missing AVIF encoder
 * degrades, to WebP-only output with a warning. Both encoders are probed once
 * per process for each loaded sharp module, by a real encode (D42).
 */
import {createHash} from 'node:crypto';
import type {SharpConstructor} from 'sharp';

import {ImageCache, derivativeCacheKey, sourceCacheKey, writeFileWithoutLinks, type CacheKeyParts} from './image-cache.js';
import {installationKey} from './installation-key.js';
import {INPUT_LIMITS} from './limits.js';

/** Version of the transformation contract. Bump it when a change alters derivative bytes or names. */
export const TRANSFORM_CONTRACT_VERSION = 1;
/** IC04 target widths: phone and desktop. */
export const DERIVATIVE_WIDTHS: readonly number[] = Object.freeze([800, 1600]);
export const WEBP_QUALITY = 80;
export const AVIF_QUALITY = 50;
/** The WebP format stores at most 16,383 pixels on each side. */
export const WEBP_MAX_DIMENSION = 16_383;

/**
 * Encoder settings pinned beyond quality. They are sharp's defaults today;
 * writing them out keeps a future default change from altering bytes silently,
 * and they are part of every cache key.
 */
const RESIZE_KERNEL = 'lanczos3';
const WEBP_ENCODER = Object.freeze({effort: 4});
const AVIF_ENCODER = Object.freeze({effort: 4, chromaSubsampling: '4:4:4', bitdepth: 8});

export type RasterFormat = 'png' | 'jpeg' | 'webp';
export type DerivativeFormat = 'webp' | 'avif';

export type TransformPolicy = {
  readonly widths: readonly number[];
  readonly webpQuality: number;
  readonly avifQuality: number;
  /** `auto` writes AVIF when the encoder is available; `off` never does. */
  readonly avif: 'auto' | 'off';
  /** The only policy: apply the EXIF orientation, then drop the tag with all other metadata. */
  readonly orientation: 'exif';
};

/** The IC04 settings. Production callers use these; other values exist to prove cache invalidation. */
export const DEFAULT_TRANSFORM_POLICY: TransformPolicy = Object.freeze({
  widths: DERIVATIVE_WIDTHS,
  webpQuality: WEBP_QUALITY,
  avifQuality: AVIF_QUALITY,
  avif: 'auto',
  orientation: 'exif',
});

export type ImageProbe = {width: number; height: number; bytes: number; kind: 'raster'; format: RasterFormat};
export type Derivative = {
  /** Relative to the output directory, forward slashes, the source directory preserved. */
  path: string;
  width: number;
  height: number;
  format: DerivativeFormat;
  bytes: number;
  /** True when the bytes came from the cache rather than a fresh encode. */
  cached: boolean;
};
export type ImageWarning = {
  code: 'avif_unavailable';
  /** `toolchain` repeats for every image in a build and is reported once; `image` belongs to one source. */
  scope: 'toolchain' | 'image';
  message: string;
  fix: string;
};
export type ImageProblemCode = 'too_many_pixels' | 'too_tall' | 'unsupported_format' | 'animated' | 'undecodable';
/**
 * A problem the author can fix, always R09 (IC01, IC02). Binary sources have no
 * text line. An absent file, a link or an oversized file never gets this far:
 * `FileAccess` refuses it when the bytes are read (D155, D159).
 */
export type ImageProblem = {code: ImageProblemCode; rule: 'R09'; message: string; fix: string; line: null};

/** `probeImage`'s result: header facts, or the problem that stops the image (D157). */
export type ImageProbeResult = {ok: true; probe: ImageProbe} | {ok: false; problem: ImageProblem};
/** `deriveImage`'s result: the derivatives written, or the problem that stops the image (D157). */
export type ImageResult =
  | {ok: true; derivatives: Derivative[]; warnings: ImageWarning[]; probe: ImageProbe}
  | {ok: false; problem: ImageProblem};

export type ImageToolErrorCode = 'E_SHARP_UNAVAILABLE' | 'E_IMAGE_IO';

/** The tool or the machine is at fault; IC05 maps this to exit code 2, never to a rule. */
export class ImageToolError extends Error {
  readonly code: ImageToolErrorCode;

  constructor(code: ImageToolErrorCode, message: string, options?: {cause?: unknown}) {
    super(message, options);
    this.name = 'ImageToolError';
    this.code = code;
  }
}

export type SharpModule = SharpConstructor;
export type SharpLoader = () => Promise<SharpModule>;
export type ImageOptions = {
  loadSharp?: SharpLoader;
  /** The key the cache's records are signed with; the installation key when absent (D191). */
  recordKey?: Uint8Array;
};

export type DeriveImageInput = {
  /** The source file's bytes, read through `FileAccess` (D155). */
  bytes: Uint8Array;
  /** Source-relative path with forward slashes, e.g. `assets/images/team/pier.jpg`. */
  relativePath: string;
  /** Derivatives are written to `<outputDir>/<dirname(relativePath)>/<name>`. */
  outputDir: string;
  /** Normally `<piece>/.papeleria/cache`. */
  cacheDir: string;
  policy?: TransformPolicy;
};

export type EncoderSupport = {avif: boolean; avifError: string | null};

const defaultSharpLoader: SharpLoader = async () => (await import('sharp')).default;

const numberFormat = new Intl.NumberFormat('en-US');

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function problem(code: ImageProblemCode, message: string, fix: string): ImageProblem {
  return {code, rule: 'R09', message, fix, line: null};
}

/**
 * Loads sharp and checks that it is a real build. Any failure is final:
 * IC04 says no working sharp means a failed build, never a fallback.
 */
export async function loadSharp(loader: SharpLoader = defaultSharpLoader): Promise<SharpModule> {
  let loaded: unknown;
  try {
    loaded = await loader();
  } catch (error) {
    throw new ImageToolError(
      'E_SHARP_UNAVAILABLE',
      `The image library sharp could not be loaded, so images cannot be built: ${describe(error)}. ` +
        'Reinstall the dependencies with npm ci on this machine; Papeleria has no image fallback without sharp.',
      {cause: error},
    );
  }
  const versions = (loaded as {versions?: {vips?: unknown}} | null)?.versions;
  if (typeof loaded !== 'function' || typeof versions?.vips !== 'string') {
    throw new ImageToolError(
      'E_SHARP_UNAVAILABLE',
      'The image library sharp loaded but reports no libvips version, so it is not a working build. ' +
        'Reinstall the dependencies with npm ci on this machine.',
    );
  }
  return loaded as SharpModule;
}

const encoderSupport = new WeakMap<SharpModule, Promise<EncoderSupport>>();

async function probeEncoders(sharpModule: SharpModule): Promise<EncoderSupport> {
  const tile = () =>
    sharpModule({create: {width: 16, height: 16, channels: 3, background: {r: 128, g: 64, b: 32}}});
  try {
    await tile().webp({quality: WEBP_QUALITY, ...WEBP_ENCODER}).toBuffer();
  } catch (error) {
    throw new ImageToolError(
      'E_SHARP_UNAVAILABLE',
      `The image library sharp is installed but cannot encode WebP, which every build needs: ${describe(error)}. ` +
        'Reinstall the dependencies with npm ci on this machine.',
      {cause: error},
    );
  }
  try {
    await tile().avif({quality: AVIF_QUALITY, ...AVIF_ENCODER}).toBuffer();
    return {avif: true, avifError: null};
  } catch (error) {
    return {avif: false, avifError: describe(error)};
  }
}

/**
 * Probes WebP (required) and AVIF (optional) by encoding a 16×16 tile. The
 * probe runs once per process for each sharp module; later calls share it.
 */
export function detectEncoders(sharpModule: SharpModule): Promise<EncoderSupport> {
  let pending = encoderSupport.get(sharpModule);
  if (pending === undefined) {
    pending = probeEncoders(sharpModule);
    encoderSupport.set(sharpModule, pending);
  }
  return pending;
}

/**
 * D40: every configured width that does not exceed the oriented source width;
 * a source narrower than all of them gets one derivative at its own width, so
 * it is still converted, oriented and stripped without being enlarged.
 */
export function planWidths(orientedWidth: number, widths: readonly number[] = DERIVATIVE_WIDTHS): number[] {
  if (!Number.isInteger(orientedWidth) || orientedWidth <= 0) {
    throw new TypeError(`the oriented source width is a positive integer, got ${String(orientedWidth)}`);
  }
  const sorted = [...new Set(widths)].sort((a, b) => a - b);
  const fitting = sorted.filter((width) => width <= orientedWidth);
  return fitting.length > 0 ? fitting : [orientedWidth];
}

/** Splits a source-relative path, refusing anything that could escape the output directory. */
function pathSegments(relativePath: string): string[] {
  if (
    typeof relativePath !== 'string' ||
    relativePath.length === 0 ||
    relativePath.startsWith('/') ||
    relativePath.includes('\\') ||
    relativePath.includes('\u0000') ||
    /^[A-Za-z]:/.test(relativePath)
  ) {
    throw new TypeError(`relativePath must be a source-relative path with forward slashes, got ${JSON.stringify(relativePath)}`);
  }
  const segments = relativePath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new TypeError(`relativePath must not contain empty, "." or ".." segments, got ${JSON.stringify(relativePath)}`);
  }
  return segments;
}

function splitFileName(fileName: string): {stem: string; extension: string} {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? {stem: fileName.slice(0, dot), extension: fileName.slice(dot)} : {stem: fileName, extension: ''};
}

/**
 * The 16-hex-digit name hash: SHA-256 over the original extension and the
 * source bytes, so `a.png` and `a.jpg` never share a derivative name (IC04).
 */
function nameHash(extension: string, sourceBytes: Uint8Array): string {
  return createHash('sha256')
    .update('papeleria-derivative-name\u0000')
    .update(extension)
    .update('\u0000')
    .update(sourceBytes)
    .digest('hex')
    .slice(0, 16);
}

/** `<stem>.<name hash>.<width>.<format>`, e.g. `pier.3f9a0c1d2e4b5a69.800.webp` (D43). */
export function derivativeName(
  relativePath: string,
  sourceBytes: Uint8Array,
  width: number,
  format: DerivativeFormat,
): string {
  const segments = pathSegments(relativePath);
  const {stem, extension} = splitFileName(segments[segments.length - 1] ?? '');
  return `${stem}.${nameHash(extension, sourceBytes)}.${width}.${format}`;
}

function validatePolicy(policy: TransformPolicy): TransformPolicy {
  const quality = (value: number) => Number.isInteger(value) && value >= 1 && value <= 100;
  if (
    !Array.isArray(policy.widths) ||
    policy.widths.length === 0 ||
    !policy.widths.every((width) => Number.isInteger(width) && width > 0) ||
    !quality(policy.webpQuality) ||
    !quality(policy.avifQuality) ||
    (policy.avif !== 'auto' && policy.avif !== 'off') ||
    policy.orientation !== 'exif'
  ) {
    throw new TypeError(`invalid image transform policy: ${JSON.stringify(policy)}`);
  }
  return policy;
}

/**
 * The caller read the bytes through `FileAccess` with the IC01 bound, which
 * owns that limit (D159); more bytes than that is a defect in the caller.
 */
function assertSourceSize(bytes: Uint8Array): void {
  if (bytes.length > INPUT_LIMITS.mediaBytes) {
    throw new RangeError(`an image source is at most ${INPUT_LIMITS.mediaBytes} bytes; ${bytes.length} were passed`);
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/** Identifies PNG, JPEG and WebP by their signatures; anything else never reaches a decoder. */
export function sniffRasterFormat(bytes: Uint8Array): RasterFormat | null {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') {
    return 'webp';
  }
  return null;
}

/**
 * The frame count an APNG declares in its acTL chunk, which must come before
 * the first IDAT; 1 for a still PNG. libvips does not report APNG frames, so
 * without this an animation would be flattened to its first frame silently.
 * Returns null when the bytes end before the answer is known (a truncated file,
 * which the decoder then refuses).
 */
export function pngFrameCount(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = ascii(bytes, offset + 4, offset + 8);
    if (type === 'acTL') {
      return offset + 12 <= bytes.length ? view.getUint32(offset + 8) : null;
    }
    if (type === 'IDAT' || type === 'IEND') {
      return 1;
    }
    offset += 12 + length;
  }
  return null;
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  return head.startsWith('<') && /<svg[\s>]/i.test(head);
}

function unsupportedFormat(bytes: Uint8Array): ImageProblem {
  if (looksLikeSvg(bytes)) {
    return problem(
      'unsupported_format',
      'The file holds SVG markup. SVG images are validated and copied as they are, not resized.',
      'Give the file the .svg extension so it is handled as a vector image.',
    );
  }
  return problem(
    'unsupported_format',
    'The file is not a PNG, JPEG or WebP image.',
    'Export the image as PNG, JPEG or WebP.',
  );
}

type SourceFacts = {width: number; height: number; format: RasterFormat};

function animated(frames: number): ImageProblem {
  return problem(
    'animated',
    `The image is animated (${frames} frames); only still images are supported.`,
    'Export one still frame as PNG, JPEG or WebP.',
  );
}

type Inspection = {ok: true; facts: SourceFacts} | {ok: false; problem: ImageProblem};

/** Reads the header only (no pixel decoding) and applies the IC01 pixel limit. */
async function inspectSource(sharpModule: SharpModule, bytes: Uint8Array, format: RasterFormat): Promise<Inspection> {
  if (format === 'png') {
    const frames = pngFrameCount(bytes);
    if (frames !== null && frames > 1) {
      return {ok: false, problem: animated(frames)};
    }
  }
  let metadata;
  try {
    metadata = await sharpModule(bytes, {limitInputPixels: false, failOn: 'warning'}).metadata();
  } catch (error) {
    return {ok: false, problem: undecodable(error)};
  }
  if (metadata.format !== format) {
    return {ok: false, problem: unsupportedFormat(bytes)};
  }
  if (typeof metadata.pages === 'number' && metadata.pages > 1) {
    return {ok: false, problem: animated(metadata.pages)};
  }
  const storedWidth = metadata.width;
  const storedHeight = metadata.height;
  if (!Number.isInteger(storedWidth) || !Number.isInteger(storedHeight) || storedWidth <= 0 || storedHeight <= 0) {
    return {ok: false, problem: undecodable(new Error('the header reports no usable dimensions'))};
  }
  const pixels = storedWidth * storedHeight;
  if (pixels > INPUT_LIMITS.imagePixels) {
    return {
      ok: false,
      problem: problem(
        'too_many_pixels',
        `The image is ${numberFormat.format(storedWidth)} × ${numberFormat.format(storedHeight)} = ` +
          `${numberFormat.format(pixels)} pixels; decoding is limited to ${numberFormat.format(INPUT_LIMITS.imagePixels)} pixels.`,
        'Resize the image before adding it. Published images are at most 1,600 px wide.',
      ),
    };
  }
  const rotated = typeof metadata.orientation === 'number' && metadata.orientation >= 5;
  const width = metadata.autoOrient?.width ?? (rotated ? storedHeight : storedWidth);
  const height = metadata.autoOrient?.height ?? (rotated ? storedWidth : storedHeight);
  return {ok: true, facts: {width, height, format}};
}

function undecodable(error: unknown): ImageProblem {
  return problem(
    'undecodable',
    `The image could not be decoded: ${describe(error)}.`,
    'Re-export the image from its original; the file may be truncated or damaged.',
  );
}

function checkDerivativeHeights(facts: SourceFacts, widths: readonly number[]): ImageProblem | null {
  for (const width of widths) {
    const height = Math.round((facts.height * width) / facts.width);
    if (height > WEBP_MAX_DIMENSION) {
      return problem(
        'too_tall',
        `At ${numberFormat.format(width)} px wide the image would be ${numberFormat.format(height)} px tall; ` +
          `WebP images are limited to ${numberFormat.format(WEBP_MAX_DIMENSION)} px on each side.`,
        'Crop the image or split it into several images.',
      );
    }
  }
  return null;
}

/**
 * Header facts for `Loaders.probeImage`: oriented width and height, byte count
 * and the format the bytes are (D160). Reads the header only; nothing is
 * decoded. Returns the problem for an image the author must fix and throws
 * `ImageToolError` only when sharp is unusable.
 */
export async function probeImage(bytes: Uint8Array, options: ImageOptions = {}): Promise<ImageProbeResult> {
  assertSourceSize(bytes);
  // Sniff before loading sharp: an unsupported file never reaches a decoder.
  const format = sniffRasterFormat(bytes);
  if (format === null) {
    return {ok: false, problem: unsupportedFormat(bytes)};
  }
  const sharpModule = await loadSharp(options.loadSharp);
  const inspected = await inspectSource(sharpModule, bytes, format);
  if (!inspected.ok) {
    return inspected;
  }
  const {facts} = inspected;
  return {ok: true, probe: {width: facts.width, height: facts.height, bytes: bytes.length, kind: 'raster', format: facts.format}};
}

/** Everything about the toolchain that can change output bytes, for the cache keys (D43). */
function toolchain(sharpModule: SharpModule): {
  sharpVersion: string;
  libvipsVersion: string;
  libraries: Record<string, string>;
  platform: string;
  arch: string;
} {
  const libraries: Record<string, string> = {};
  for (const [name, version] of Object.entries(sharpModule.versions)) {
    if (typeof version === 'string') {
      libraries[name] = version;
    }
  }
  return {
    sharpVersion: sharpModule.versions.sharp ?? 'unknown',
    libvipsVersion: sharpModule.versions.vips,
    libraries,
    platform: process.platform,
    arch: process.arch,
  };
}

function simdState(sharpModule: SharpModule): boolean | null {
  return typeof sharpModule.simd === 'function' ? sharpModule.simd() : null;
}

function threadCount(sharpModule: SharpModule): number | null {
  return typeof sharpModule.concurrency === 'function' ? sharpModule.concurrency() : null;
}

type Encoded = {data: Uint8Array; width: number; height: number};

async function encode(
  sharpModule: SharpModule,
  bytes: Uint8Array,
  width: number,
  format: DerivativeFormat,
  policy: TransformPolicy,
): Promise<Encoded> {
  const pipeline = sharpModule(bytes, {limitInputPixels: INPUT_LIMITS.imagePixels, failOn: 'warning', autoOrient: true})
    .resize({width, withoutEnlargement: true, kernel: RESIZE_KERNEL})
    .toColourspace('srgb');
  const encoder =
    format === 'webp'
      ? pipeline.webp({quality: policy.webpQuality, ...WEBP_ENCODER})
      : pipeline.avif({quality: policy.avifQuality, ...AVIF_ENCODER});
  const {data, info} = await encoder.toBuffer({resolveWithObject: true});
  return {data, width: info.width, height: info.height};
}

function keyParts(
  sourceSha256: string,
  width: number,
  format: DerivativeFormat,
  policy: TransformPolicy,
  sharpModule: SharpModule,
): CacheKeyParts {
  return {
    contractVersion: TRANSFORM_CONTRACT_VERSION,
    sourceSha256,
    width,
    format,
    quality: format === 'webp' ? policy.webpQuality : policy.avifQuality,
    orientation: policy.orientation,
    encoder: format === 'webp' ? {kernel: RESIZE_KERNEL, ...WEBP_ENCODER} : {kernel: RESIZE_KERNEL, ...AVIF_ENCODER},
    ...toolchain(sharpModule),
    simd: simdState(sharpModule),
    // Measured: AVIF bytes change with the libvips thread count, WebP bytes do not (D43).
    threads: format === 'avif' ? threadCount(sharpModule) : null,
  };
}

/** Writes a derivative under the output directory without following a symbolic link (IC02). */
async function writeOutput(outputDir: string, directory: readonly string[], name: string, data: Uint8Array): Promise<void> {
  try {
    await writeFileWithoutLinks(outputDir, directory, name, data);
  } catch (error) {
    throw new ImageToolError('E_IMAGE_IO', `The derivative ${[...directory, name].join('/')} could not be written: ${describe(error)}`, {cause: error});
  }
}

async function cacheIo<T>(operation: () => Promise<T>, what: string): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new ImageToolError('E_IMAGE_IO', `The image cache could not ${what}: ${describe(error)}`, {cause: error});
  }
}

const FORMAT_ORDER: Record<DerivativeFormat, number> = {webp: 0, avif: 1};

/**
 * Derives the IC04 raster set for one source, using and filling the cache.
 * Returns the problem for a source the author must fix and throws
 * `ImageToolError` for tool, cache or output failures (D157).
 */
export async function deriveImage(input: DeriveImageInput, options: ImageOptions = {}): Promise<ImageResult> {
  const policy = validatePolicy(input.policy ?? DEFAULT_TRANSFORM_POLICY);
  const segments = pathSegments(input.relativePath);
  if (typeof input.outputDir !== 'string' || input.outputDir.length === 0) {
    throw new TypeError('deriveImage needs an output directory');
  }
  const {bytes} = input;
  assertSourceSize(bytes);
  // Sniff before loading sharp: an unsupported file never reaches a decoder.
  const format = sniffRasterFormat(bytes);
  if (format === null) {
    return {ok: false, problem: unsupportedFormat(bytes)};
  }

  const sharpModule = await loadSharp(options.loadSharp);
  const support = await detectEncoders(sharpModule);
  const recordKey = options.recordKey ?? (await installationKey()).bytes;
  const cache = new ImageCache(input.cacheDir, TRANSFORM_CONTRACT_VERSION, recordKey);
  const sourceSha256 = createHash('sha256').update(bytes).digest('hex');

  const sourceKey = sourceCacheKey({contractVersion: TRANSFORM_CONTRACT_VERSION, sourceSha256, ...toolchain(sharpModule)});
  let facts: SourceFacts | null = await cacheIo(() => cache.readSource(sourceKey, format), 'be read');
  if (facts === null) {
    const inspected = await inspectSource(sharpModule, bytes, format);
    if (!inspected.ok) {
      return inspected;
    }
    const record = inspected.facts;
    facts = record;
    await cacheIo(() => cache.writeSource(sourceKey, record), 'be written');
  }

  const widths = planWidths(facts.width, policy.widths);
  const tooTall = checkDerivativeHeights(facts, widths);
  if (tooTall !== null) {
    return {ok: false, problem: tooTall};
  }

  const warnings: ImageWarning[] = [];
  const wantAvif = policy.avif === 'auto';
  if (wantAvif && !support.avif) {
    warnings.push({
      code: 'avif_unavailable',
      scope: 'toolchain',
      message: `AVIF images were not written because this installation of sharp cannot encode AVIF (${support.avifError ?? 'unknown reason'}). WebP images were written instead.`,
      fix: 'Nothing is required: WebP output is complete. To add AVIF, reinstall with npm ci on a platform whose sharp build includes the AVIF encoder.',
    });
  }

  const {stem, extension} = splitFileName(segments[segments.length - 1] ?? '');
  const hash = nameHash(extension, bytes);
  const directory = segments.slice(0, -1);

  const produce = async (width: number, format: DerivativeFormat): Promise<{entry: Encoded; cached: boolean}> => {
    const parts = keyParts(sourceSha256, width, format, policy, sharpModule);
    const key = derivativeCacheKey(parts);
    const hit = await cacheIo(() => cache.readDerivative(key, format), 'be read');
    if (hit !== null) {
      return {entry: hit, cached: true};
    }
    const entry = await encode(sharpModule, bytes, width, format, policy);
    await cacheIo(() => cache.writeDerivative(key, {...entry, format}, parts), 'be written');
    return {entry, cached: false};
  };

  const results: Array<{width: number; format: DerivativeFormat; entry: Encoded; cached: boolean}> = [];
  for (const width of widths) {
    let made;
    try {
      made = await produce(width, 'webp');
    } catch (error) {
      if (error instanceof ImageToolError) {
        throw error;
      }
      return {ok: false, problem: undecodable(error)};
    }
    results.push({width, format: 'webp', ...made});
  }
  if (wantAvif && support.avif) {
    // All or nothing per source: a picture element never offers a partial AVIF set.
    const avif: typeof results = [];
    try {
      for (const width of widths) {
        avif.push({width, format: 'avif', ...(await produce(width, 'avif'))});
      }
      results.push(...avif);
    } catch (error) {
      if (error instanceof ImageToolError) {
        throw error;
      }
      warnings.push({
        code: 'avif_unavailable',
        scope: 'image',
        message: `AVIF could not be written for this image (${describe(error)}); WebP was written instead.`,
        fix: 'Nothing is required: WebP output is complete. Re-export the image if AVIF matters for it.',
      });
    }
  }

  results.sort((a, b) => a.width - b.width || FORMAT_ORDER[a.format] - FORMAT_ORDER[b.format]);
  const derivatives: Derivative[] = [];
  for (const result of results) {
    const name = `${stem}.${hash}.${result.width}.${result.format}`;
    const relative = [...directory, name];
    await writeOutput(input.outputDir, directory, name, result.entry.data);
    derivatives.push({
      path: relative.join('/'),
      width: result.entry.width,
      height: result.entry.height,
      format: result.format,
      bytes: result.entry.data.length,
      cached: result.cached,
    });
  }

  return {
    ok: true,
    derivatives,
    warnings,
    probe: {width: facts.width, height: facts.height, bytes: bytes.length, kind: 'raster', format: facts.format},
  };
}
