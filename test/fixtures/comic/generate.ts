/**
 * M4.2–M4.7 (W4): the files the comic fixtures make when their tests run, so
 * no binary image is committed (test/fixtures/images/README.md). Pages are
 * the shared gradient at 1600 × 2200, the sample's proportions; the reader
 * fixture's extra picture is 1200 × 800.
 */
import {pngSource} from '../images/generate.js';

/** The reader fixture's generated files, by path in the piece. */
export async function readerFixtureImages(): Promise<Record<string, Uint8Array>> {
  const page = new Uint8Array(await pngSource(1600, 2200));
  return {
    'assets/images/pages/01.png': page,
    'assets/images/pages/02.png': page,
    'assets/images/pages/04.png': page,
    'assets/images/extra.png': new Uint8Array(await pngSource(1200, 800)),
  };
}
