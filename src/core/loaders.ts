/**
 * The `Loaders` the resolver reads a piece through (D158): file access, plus
 * the readers that turn file content into data. Each reader is the function of
 * the module that owns the format, used as it is — `parseCsv` from `csv.ts`,
 * `probeImage` from `images.ts`, `probeVideo` from `video.ts` (M3.4) — so
 * there is nothing between a reader and the resolver to translate. Readers
 * take content, never paths: the file access is the only way a piece file is
 * read (D155).
 */
import {parseCsv} from './csv.js';
import {probeImage} from './images.js';
import {createMemoryFileAccess, createNodeFileAccess, type MemoryEntries, type NodeFileAccessOptions} from './paths.js';
import type {Loaders, VideoProbeResult} from './types.js';
import {probeVideo} from './video.js';

/**
 * A video reader that knows no duration: every video it is given is an R16
 * problem. The build used it until `video.ts` arrived at M3.4; tests keep it
 * as a stand-in reader that never parses anything.
 */
export async function probeVideoUnavailable(_bytes: Uint8Array): Promise<VideoProbeResult> {
  return {
    ok: false,
    problem: {
      code: 'unavailable',
      rule: 'R16',
      message: 'This build cannot read video durations yet; video blocks arrive in milestone 3.',
      fix: 'Remove the video block, or build with a Papeleria version that supports video.',
      line: null,
    },
  };
}

/** Loaders over a piece folder on disk, with the real readers. */
export function createNodeLoaders(root: string, options: NodeFileAccessOptions = {}): Loaders {
  return {...createNodeFileAccess(root, options), parseCsv, probeImage, probeVideo};
}

/**
 * Loaders over an in-memory piece, with the real readers unless a test passes
 * its own. Only the file access is in memory.
 */
export function createMemoryLoaders(
  entries: MemoryEntries,
  readers: Partial<Pick<Loaders, 'parseCsv' | 'probeImage' | 'probeVideo'>> = {},
): Loaders {
  return {...createMemoryFileAccess(entries), parseCsv, probeImage, probeVideo, ...readers};
}
