/**
 * M3.4: the video stage. Every video a document uses is published into the
 * generation as it is, at its own path (`assets/video/…`), for the page's
 * `<video>` to name (D96). Videos are never transcoded (IC04: no ffmpeg).
 *
 * A video is read again through the snapshot's `FileAccess` with the IC01
 * byte bound, as the media stage reads an image (D155): the piece is read one
 * way only, and a file that changed since resolve measured it is caught by
 * the revision record before promotion (IC05). A file that has grown past the
 * bound or been swapped meanwhile is R09 at the video, with the manifest token
 * that names it as the related location. Only a failure of the tool escapes.
 */
import {
  FileChangedError,
  FileTooLargeError,
  globalLocation,
  INPUT_LIMITS,
  mebibytes,
  traced,
  type Loaders,
  type Piece,
  type TracedFinding,
} from '../core/index.js';
import {assetReferences, manifestLocation} from '../checks/locate.js';
import {writeGenerationFile, type Generation} from './write.js';

const numbers = new Intl.NumberFormat('en-US');

export type PublishedVideos = {readonly findings: readonly TracedFinding[]};

/** Copies every video of a piece into the generation. */
export async function publishVideos(piece: Piece, loaders: Loaders, generation: Generation): Promise<PublishedVideos> {
  const findings: TracedFinding[] = [];
  const paths = Object.keys(piece.assets.videos).sort();
  if (paths.length === 0) {
    return {findings};
  }
  const references = assetReferences(piece).videos;
  const problem = (path: string, code: string, message: string, fix: string, detail: string | null = null): void => {
    const pointer = references.get(path);
    findings.push(
      traced({
        rule: 'R09',
        message,
        fix,
        detail,
        location: globalLocation(path),
        sourcePath: `${path}#${code}`,
        ...(pointer === undefined ? {} : {relatedLocation: manifestLocation(piece, pointer)}),
      }),
    );
  };
  for (const path of paths) {
    let bytes: Uint8Array;
    try {
      bytes = await loaders.readBytes(path, {maxBytes: INPUT_LIMITS.mediaBytes});
    } catch (error) {
      if (error instanceof FileTooLargeError) {
        problem(
          path,
          'size',
          `The video ${path} is ${numbers.format(error.bytes)} bytes; the limit is ${mebibytes(error.limit)} (${numbers.format(error.limit)} bytes).`,
          'Reduce the file before adding it to the piece.',
          `Input limit: ${numbers.format(error.limit)} bytes per image or video file (IC01).`,
        );
        continue;
      }
      if (error instanceof FileChangedError) {
        problem(
          path,
          'changed',
          `The video ${path} changed while Papeleria was reading it, and what was opened is not the file that was checked.`,
          'Build again once nothing else is changing the piece folder; replace any link with the file itself.',
        );
        continue;
      }
      throw error;
    }
    await writeGenerationFile(generation, path, bytes);
  }
  return {findings};
}
