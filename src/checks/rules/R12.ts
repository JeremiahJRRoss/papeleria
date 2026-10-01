/**
 * R12: an owner-exclusive file is copied outside `brand/` (D05).
 *
 * The inventory is the tool's `brand/owner-assets.sha256`, read with the logic
 * `scripts/brand-check.mjs` uses (`owner-inventory.ts`). Every file of the
 * generation is hashed against it, and so is every source image, whose
 * derivatives could never match: a copy is reported where the author can
 * remove it, at the source image with the manifest token that names it, and
 * an output file that is that same image published is not reported again.
 * An absent inventory means no owner assets are supplied; the build then has
 * nothing to compare and says nothing, and `npm run check:brand` is where a
 * maintainer reads that note. A malformed inventory is the installation's
 * failure, not the piece's: it throws, and the build exits 2.
 */
import {join} from 'node:path';

import {outputReadError} from '../../build/write.js';
import {globalLocation, traced, type TracedFinding} from '../../core/index.js';
import {assetReferences, manifestLocation} from '../locate.js';
import {checkTree, INVENTORY_PATH, readInventory} from '../owner-inventory.js';
import type {OutputRule} from '../rule.js';

const FIX = 'Remove the copy. Owner-exclusive assets stay under the tool’s brand/ folder; public theme files, the favicon and a client’s own logo are allowed (D05).';

export const rule: OutputRule = {
  id: 'R12',
  phase: 'output',
  async check({piece, output}) {
    const owners = readInventory(join(output.toolRoot, INVENTORY_PATH));
    if (owners === null || owners.size === 0) {
      return [];
    }
    const findings: TracedFinding[] = [];
    const references = assetReferences(piece).images;
    const reported = new Set<string>();
    for (const [path, hashes] of [...output.sourceImages].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const hash = hashes.find((candidate) => owners.has(candidate));
      if (hash === undefined) {
        continue;
      }
      reported.add(path);
      const pointer = references.get(path);
      findings.push(
        traced({
          rule: 'R12',
          message: `The image ${path} is a copy of the owner asset ${owners.get(hash)!}.`,
          fix: FIX,
          detail: `SHA-256 ${hash}, listed in ${INVENTORY_PATH.split('\\').join('/')}.`,
          location: globalLocation(path),
          sourcePath: `${path}#owner`,
          ...(pointer === undefined ? {} : {relatedLocation: manifestLocation(piece, pointer)}),
        }),
      );
    }
    let tree;
    try {
      tree = checkTree(output.directory, owners);
    } catch (error) {
      // The walk reads only the generation this run wrote: its failure is the output's, not the tool's (W5R-11).
      throw outputReadError('R12', error);
    }
    for (const match of tree.matches) {
      if (reported.has(match.path)) {
        continue;
      }
      findings.push(
        traced({
          rule: 'R12',
          message: `The generated ${match.path} is a copy of the owner asset ${match.owner}.`,
          fix: FIX,
          detail: `SHA-256 ${match.hash}, listed in ${INVENTORY_PATH.split('\\').join('/')}.`,
          location: globalLocation(`${output.label}/${match.path}`),
          sourcePath: `${output.label}/${match.path}#owner`,
        }),
      );
    }
    return findings;
  },
};
