/**
 * M4.2: the zoom-original stage (IC04, D108). A comic panel whose detail is
 * `zoom: true` opens the original page image, cropped to its box, so the
 * build publishes the original of every raster page a zoom names, once, at
 * its own path beside its derivatives. The reader loads it only when that
 * detail opens: nothing names it for a browser to fetch before then (IC04:
 * "never preloaded"). An SVG page zooms into the file the media stage already
 * wrote from its validated markup, so it needs nothing here.
 *
 * An original is written from the bytes the snapshot's `FileAccess` reads,
 * with the IC01 byte bound, never copied by path (D155): the piece is read
 * one way only, and a file changed since resolve is caught by the revision
 * record before promotion (IC05). A file that has grown past the bound or
 * been swapped meanwhile is R09 at the image, with the manifest token that
 * names it as the related location, as the media stage reports it.
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
import {zoomOriginals} from '../../templates/comic/render.js';
import {assetReferences, manifestLocation} from '../checks/locate.js';
import {writeGenerationFile, type Generation} from './write.js';

const numbers = new Intl.NumberFormat('en-US');

export type PublishedOriginals = {readonly findings: readonly TracedFinding[]};

/** Writes the original of every raster page a comic's zoom details open. Other templates have none. */
export async function publishOriginals(piece: Piece, loaders: Loaders, generation: Generation): Promise<PublishedOriginals> {
  const findings: TracedFinding[] = [];
  const paths = piece.template === 'comic' ? zoomOriginals(piece) : [];
  if (paths.length === 0) {
    return {findings};
  }
  const references = assetReferences(piece).images;
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
    await writeGenerationFile(generation, path, bytes);
  }
  return {findings};
}
