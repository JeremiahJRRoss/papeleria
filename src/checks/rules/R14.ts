/**
 * R14: a panel box runs off the page (ERD R14, C11, D107).
 *
 * The schema mapping reports all of R14, once, at the box: its shape, a bound
 * of each slot (x and y from 0 to 100, width and height above 0 and at most
 * 100), a number that is not finite (D149, D164(c)), and, with the manifest's
 * other errors rather than after them, that the box stays on the page: x +
 * width and y + height each at most 100, the exact edge accepted
 * (`panelExtentProblem`, W5R-33). A manifest with a box off the page therefore
 * never resolves, and this module finds nothing in a piece read with
 * `readPiece`. It judges the extent again, in the same words and under the same
 * source path, for a piece whose manifest was validated some other way, so the
 * two settle into one finding.
 */
import {PANEL_EXTENT_TOLERANCE, panelExtentProblem, traced, type TracedFinding} from '../../core/index.js';
import {manifestLocation} from '../locate.js';
import type {SourceRule} from '../rule.js';

/** How far past 100 a sum of two percentages may be and still be at the edge: rounding, never an author's number. */
export const EXTENT_TOLERANCE = PANEL_EXTENT_TOLERANCE;

export const rule: SourceRule = {
  id: 'R14',
  phase: 'source',
  check({piece}) {
    if (piece === null || piece.template !== 'comic') {
      return [];
    }
    const findings: TracedFinding[] = [];
    for (const page of piece.pages) {
      for (const panel of page.panels) {
        const problem = panelExtentProblem(panel.box, page.number, panel.number);
        if (problem === null) {
          continue;
        }
        findings.push(
          traced({
            rule: 'R14',
            ...problem,
            location: manifestLocation(piece, `${panel.pointer}/box`),
            sourcePath: `${piece.manifestFile}#${panel.pointer}/box#extent`,
          }),
        );
      }
    }
    return findings;
  },
};
