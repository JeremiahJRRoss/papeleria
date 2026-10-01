/**
 * R16: a video's duration is zero, unknown, not finite or over 15 seconds, or
 * the file is not an MP4 or WebM video it can be read from (IC04, C07).
 *
 * The video reader (`src/core/video.ts`) measures each video from its bytes
 * when the piece resolves, and resolve keeps what it found in
 * `VideoAsset.probe` rather than reporting it (D152, D158). This rule reports
 * each problem found there, once per file however many blocks use it: a
 * binary finding at the video with no line, and the manifest token that
 * first names it as the related location (IC01). It never measures anything
 * itself.
 */
import {globalLocation, traced, type TracedFinding} from '../../core/index.js';
import {assetReferences, manifestLocation} from '../locate.js';
import type {SourceRule} from '../rule.js';

export const rule: SourceRule = {
  id: 'R16',
  phase: 'source',
  check({piece}) {
    if (piece === null) {
      return [];
    }
    const references = assetReferences(piece).videos;
    const findings: TracedFinding[] = [];
    for (const path of Object.keys(piece.assets.videos).sort()) {
      const {probe} = piece.assets.videos[path]!;
      if (probe.ok) {
        continue;
      }
      const pointer = references.get(path);
      findings.push(
        traced({
          rule: 'R16',
          message: probe.problem.message,
          fix: probe.problem.fix,
          detail: 'Papeleria measures a video from its bytes; its name and anything written about it are not read (IC04).',
          location: globalLocation(path),
          sourcePath: `${path}#${probe.problem.code}`,
          ...(pointer === undefined ? {} : {relatedLocation: manifestLocation(piece, pointer)}),
        }),
      );
    }
    return findings;
  },
};
