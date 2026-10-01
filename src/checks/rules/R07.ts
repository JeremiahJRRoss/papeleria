/**
 * R07: the first view is over its weight budget (IC04).
 *
 * The build measured the generation (`budget.ts`): every file the first view
 * loads, each once, at three viewports in the AVIF and WebP-only scenarios,
 * the worst total kept. Over the inclusive limit is one error at the page,
 * naming the largest files of that total, with the first view's source as the
 * related location. The AVIF-unavailable warning is R07's too; the media stage
 * reports it, once per build (D42, D66).
 *
 * A comic's first view has no limit (IC04); its limit is per image (M4.2,
 * W4, D106): every phone format of every page — each format of the narrowest
 * width the build wrote, or an SVG page's file — at most 307,200 bytes, the
 * limit included. Each one over is its own error, at the page's source image,
 * which is what the author changes, with the manifest token that names it as
 * the related location; the message names the published file and its size.
 */
import {globalLocation, traced, type TracedFinding} from '../../core/index.js';
import {PHONE_IMAGE_BUDGET_BYTES} from '../../build/budget.js';
import {assetReferences, manifestLocation} from '../locate.js';
import type {OutputRule, OutputRuleContext} from '../rule.js';

const numbers = new Intl.NumberFormat('en-US');

/** What the first view is, for the fix: a deck's first slide, a document's first sheet and its posters (IC04, D96). */
const FIRST_VIEW_FIX: Readonly<Record<string, string>> = {
  deck: 'Use smaller or fewer images in the first view (a deck’s first slide and its logo), or move large images later. Stylesheets, the script and all eight font files always count.',
  document:
    'Use smaller or fewer images on the first sheet, or start their section with new_page so they move to a later sheet; every video poster counts wherever the video stands. Stylesheets and all eight font files always count.',
};

/** Each phone image over 307,200 bytes, one error each (IC04, D106). */
function phoneImageFindings({piece, output}: OutputRuleContext): TracedFinding[] {
  const over = (output.weight.phoneImages ?? []).filter((image) => !image.withinBudget);
  if (over.length === 0) {
    return [];
  }
  const references = assetReferences(piece).images;
  return over.map((image) => {
    const pointer = references.get(image.source);
    return traced({
      rule: 'R07',
      message: `The phone image ${image.path} is ${numbers.format(image.bytes)} bytes, ${numbers.format(image.bytes - PHONE_IMAGE_BUDGET_BYTES)} over the comic phone-image budget of ${numbers.format(PHONE_IMAGE_BUDGET_BYTES)}.`,
      fix: `Simplify or reduce ${image.source}: flatter colour, less fine texture or less noise make a smaller phone image. Each format a phone may load is held to the budget on its own.`,
      detail: 'A phone loads the narrowest size the build writes, 800 px wide or the page’s own width when that is less, as WebP and, where written, AVIF; each file counts its own uncompressed bytes (IC04). The original a zoom detail opens is not held to it.',
      location: globalLocation(image.source),
      sourcePath: `${image.path}#phone-budget`,
      ...(pointer === undefined ? {} : {relatedLocation: manifestLocation(piece, pointer)}),
    });
  });
}

export const rule: OutputRule = {
  id: 'R07',
  phase: 'output',
  async check(context) {
    const {piece, output} = context;
    const {weight} = output;
    const phone = phoneImageFindings(context);
    if (weight.withinBudget || weight.budgetBytes === null) {
      return phone;
    }
    const over = weight.firstViewBytes - weight.budgetBytes;
    const largest = weight.largest.map(([path, bytes]) => `${path} ${numbers.format(bytes)}`).join('; ');
    const {viewport, scenario} = weight.worst;
    return [
      traced({
        rule: 'R07',
        message: `The first view loads ${numbers.format(weight.firstViewBytes)} bytes, ${numbers.format(over)} over the budget of ${numbers.format(weight.budgetBytes)}. Largest files: ${largest}.`,
        fix: FIRST_VIEW_FIX[piece.template] ?? FIRST_VIEW_FIX['deck']!,
        detail: `Counted as uncompressed file bytes, each file once, at ${viewport.width}×${viewport.height} with ${scenario === 'avif' ? 'AVIF where written' : 'WebP only'}, the heaviest of the reference viewports and formats (IC04).`,
        location: globalLocation(`${output.label}/index.html`),
        sourcePath: `${output.label}/index.html#budget`,
        ...(output.firstViewSource === null ? {} : {relatedLocation: output.firstViewSource}),
      }),
      ...phone,
    ];
  },
};
