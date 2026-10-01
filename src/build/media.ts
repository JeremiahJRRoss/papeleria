/**
 * M1.7: the media stage. Every image the piece uses is published into the
 * generation, and what was published becomes the renderer's `media` (D63).
 *
 * A raster is read again through the snapshot's `FileAccess`, with the IC01
 * byte bound (D155), and its bytes go to `deriveImage`, which writes the IC04
 * derivatives into the generation and shares the piece's image cache. An SVG
 * is written from the markup the profile accepted, never read again (IC02,
 * D164(f)). The author's problems become findings — R09 at the image, with the
 * manifest token that names it as the related location (D46, D157); a
 * derivation can refuse an image resolve accepted, since the probe decodes
 * nothing and checks no derivative's height. A missing AVIF encoder is one R07
 * warning per build (D42, D66). Only `ImageToolError` escapes: exit 2.
 */
import {Buffer} from 'node:buffer';
import {createHash} from 'node:crypto';
import {join} from 'node:path';

import {
  deriveImage,
  FileChangedError,
  FileTooLargeError,
  globalLocation,
  INPUT_LIMITS,
  mebibytes,
  traced,
  type ImageOptions,
  type ImageWarning,
  type Loaders,
  type Piece,
  type TracedFinding,
} from '../core/index.js';
import {assetReferences, manifestLocation} from '../checks/locate.js';
import type {BuildMedia, PublishedImage} from '../../templates/shared/blocks.js';
import {STATE_FOLDER, recordGenerationFile, writeGenerationFile, type Generation} from './write.js';

export type PublishedMedia = {
  readonly media: BuildMedia;
  readonly findings: readonly TracedFinding[];
  /**
   * The SHA-256 hashes each source image's file may have, by path, for R12: a
   * raster's bytes as read; an SVG's validated text with and without a leading
   * byte-order mark, since the file is never read again (IC02) and the mark is
   * the one difference the text cannot show.
   */
  readonly sourceHashes: ReadonlyMap<string, readonly string[]>;
};

export type MediaOptions = ImageOptions & {
  /** How global findings name the piece folder. */
  readonly pieceLabel: string;
};

const numbers = new Intl.NumberFormat('en-US');

const BYTE_ORDER_MARK = Buffer.from([0xef, 0xbb, 0xbf]);

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Publishes every image of a piece into the generation. */
export async function publishMedia(piece: Piece, loaders: Loaders, generation: Generation, options: MediaOptions): Promise<PublishedMedia> {
  const images = new Map<string, PublishedImage>();
  const findings: TracedFinding[] = [];
  const sourceHashes = new Map<string, readonly string[]>();
  const references = assetReferences(piece).images;
  const cacheDir = join(generation.pieceRoot, STATE_FOLDER, 'cache');
  let toolchainWarning: ImageWarning | null = null;

  const at = (path: string) => {
    const pointer = references.get(path);
    return pointer === undefined ? undefined : manifestLocation(piece, pointer);
  };
  const problem = (path: string, code: string, message: string, fix: string, detail: string | null = null): void => {
    const related = at(path);
    findings.push(
      traced({
        rule: 'R09',
        message,
        fix,
        detail,
        location: globalLocation(path),
        sourcePath: `${path}#${code}`,
        ...(related === undefined ? {} : {relatedLocation: related}),
      }),
    );
  };

  for (const path of Object.keys(piece.assets.images).sort()) {
    const asset = piece.assets.images[path]!;
    if (asset.kind === 'vector') {
      // The text the profile accepted, written as it is: never the file read again (IC02).
      const bytes = await writeGenerationFile(generation, path, asset.markup);
      const text = Buffer.from(asset.markup, 'utf8');
      sourceHashes.set(path, [sha256(text), sha256(Buffer.concat([BYTE_ORDER_MARK, text]))]);
      images.set(path, {kind: 'vector', width: asset.width, height: asset.height, file: {path, bytes}});
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await loaders.readBytes(path, {maxBytes: INPUT_LIMITS.mediaBytes});
    } catch (error) {
      if (error instanceof FileTooLargeError) {
        problem(
          path,
          'size',
          `The image ${path} is ${numbers.format(error.bytes)} bytes; the limit is ${mebibytes(error.limit)} (${numbers.format(error.limit)} bytes).`,
          'Reduce the file before adding it to the piece.',
          `Input limit: ${numbers.format(error.limit)} bytes per image or video file (IC01).`,
        );
        continue;
      }
      if (error instanceof FileChangedError) {
        problem(
          path,
          'changed',
          `The image ${path} changed while Papeleria was reading it, and what was opened is not the file that was checked.`,
          'Build again once nothing else is changing the piece folder; replace any link with the file itself.',
        );
        continue;
      }
      throw error;
    }
    sourceHashes.set(path, [sha256(bytes)]);
    const result = await deriveImage({bytes, relativePath: path, outputDir: generation.directory, cacheDir}, options);
    if (!result.ok) {
      problem(path, result.problem.code, result.problem.message, result.problem.fix);
      continue;
    }
    for (const derivative of result.derivatives) {
      recordGenerationFile(generation, derivative.path, derivative.bytes);
    }
    images.set(path, {
      kind: 'raster',
      width: result.probe.width,
      height: result.probe.height,
      derivatives: result.derivatives.map(({path: file, width, height, format, bytes: size}) => ({path: file, width, height, format, bytes: size})),
    });
    for (const warning of result.warnings) {
      if (warning.scope === 'toolchain') {
        toolchainWarning ??= warning;
      } else {
        const related = at(path);
        findings.push(
          traced({
            rule: 'R07',
            severity: 'warning',
            message: warning.message,
            fix: warning.fix,
            location: globalLocation(path),
            sourcePath: `${path}#avif`,
            ...(related === undefined ? {} : {relatedLocation: related}),
          }),
        );
      }
    }
  }
  if (toolchainWarning !== null) {
    findings.push(
      traced({
        rule: 'R07',
        severity: 'warning',
        message: toolchainWarning.message,
        fix: toolchainWarning.fix,
        detail: 'The first-view budget was measured with WebP alone.',
        location: globalLocation(options.pieceLabel),
        sourcePath: `${options.pieceLabel}#avif`,
      }),
    );
  }
  return {media: {images}, findings, sourceHashes};
}
