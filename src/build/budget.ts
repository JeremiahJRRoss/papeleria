/**
 * M1.7 / IC04: the first-view weight budget.
 *
 * A deck or document may make a reader load at most 1,048,576 bytes before it
 * shows its first view, counted as uncompressed file bytes, the limit
 * included. What is counted: the page, its linked stylesheets, its script, all
 * eight font files, the favicon, and the images the first view shows, each
 * path once however many times the page uses it. An image counts the
 * derivative a browser would pick for its slot at each reference viewport: the
 * narrowest at least as wide as the slot at the viewport's pixel ratio, else
 * the widest. AVIF and WebP never both count for one slot: the AVIF scenario
 * (a browser that takes the `<source>`) and the WebP-only scenario are totalled
 * apart, at 390×844, 834×1112 and 1280×800, and the largest of the six totals
 * is the first view's weight. An SVG counts the bytes written, the validated
 * markup without a byte-order mark (D164(f)). Pure arithmetic over sizes the
 * build already knows.
 *
 * A comic (M4.2, W4, D106) has no first-view limit: its report measures the
 * cover and the next spread with `budgetBytes` null (IC04). Its limit is per
 * image instead: every phone format of every page — the narrowest derivative
 * the build wrote, in each format, or an SVG page's one file — is at most
 * 307,200 bytes, the limit included, and each is listed in the report's
 * `weight.phoneImages` (IC06).
 */
import {derivativesOf, type FirstViewImage, type PublishedFile, type PublishedImage} from '../../templates/shared/blocks.js';

/** IC04: a deck's or document's first view, inclusive. */
export const FIRST_VIEW_BUDGET_BYTES = 1_048_576;

export type Viewport = {readonly width: number; readonly height: number; readonly dpr: number};

/** IC04's three reference viewports, each at a device pixel ratio of 1. */
export const REFERENCE_VIEWPORTS: readonly Viewport[] = Object.freeze([
  {width: 390, height: 844, dpr: 1},
  {width: 834, height: 1112, dpr: 1},
  {width: 1280, height: 800, dpr: 1},
]);

export type Scenario = 'avif' | 'webp';
const SCENARIOS: readonly Scenario[] = ['avif', 'webp'];

/** One viewport and scenario: every file counted, each once, and their total. */
export type ScenarioTotal = {
  readonly viewport: Viewport;
  readonly scenario: Scenario;
  readonly bytes: number;
  readonly files: readonly PublishedFile[];
};

export type FirstViewMeasure = {
  readonly firstViewBytes: number;
  readonly budgetBytes: number | null;
  readonly withinBudget: boolean;
  /** The heaviest files of the worst total, largest first, at most ten. */
  readonly largest: readonly (readonly [string, number])[];
  readonly worst: ScenarioTotal;
  readonly totals: readonly ScenarioTotal[];
  /** A comic's phone images, each against its own limit (D106); absent for a deck or a document. */
  readonly phoneImages?: readonly PhoneImageMeasure[];
};

export type FirstViewInput = {
  /** Every file the first view always loads: the page, stylesheets, script, fonts, favicon. */
  readonly files: readonly PublishedFile[];
  /** The images the first view shows, with the slot each fills. */
  readonly images: readonly FirstViewImage[];
  /** The limit, or null where the first view has none (a comic, IC04). */
  readonly budgetBytes: number | null;
};

/** How many of the largest files a report names (R07 names them). */
export const LARGEST_COUNT = 10;

/**
 * The file a browser loads for an image in a slot `slotWidth` CSS pixels
 * wide: an SVG's one file; for a raster, from the AVIF derivatives when the
 * scenario is AVIF and the build wrote any, else from the WebP ones, the
 * narrowest at least `slotWidth × dpr` pixels wide, else the widest.
 */
export function selectCandidate(image: PublishedImage, slotWidth: number, dpr: number, scenario: Scenario): PublishedFile {
  if (image.kind === 'vector') {
    return image.file;
  }
  const avif = derivativesOf(image, 'avif');
  const candidates = scenario === 'avif' && avif.length > 0 ? avif : derivativesOf(image, 'webp');
  const needed = slotWidth * dpr;
  const chosen = candidates.find((candidate) => candidate.width >= needed) ?? candidates.at(-1);
  if (chosen === undefined) {
    throw new Error('E_INTERNAL: a published raster has no derivative to load');
  }
  return {path: chosen.path, bytes: chosen.bytes};
}

function total(input: FirstViewInput, viewport: Viewport, scenario: Scenario): ScenarioTotal {
  const counted = new Map<string, number>();
  for (const file of input.files) {
    counted.set(file.path, file.bytes);
  }
  for (const {image, slot} of input.images) {
    const file = selectCandidate(image, slot.slotWidth(viewport.width), viewport.dpr, scenario);
    counted.set(file.path, file.bytes);
  }
  const files = [...counted].map(([path, bytes]) => ({path, bytes}));
  return {viewport, scenario, bytes: files.reduce((sum, file) => sum + file.bytes, 0), files};
}

/** Measures the first view at every reference viewport in both scenarios and keeps the worst. */
export function measureFirstView(input: FirstViewInput, viewports: readonly Viewport[] = REFERENCE_VIEWPORTS): FirstViewMeasure {
  const totals = viewports.flatMap((viewport) => SCENARIOS.map((scenario) => total(input, viewport, scenario)));
  const worst = totals.reduce((heaviest, candidate) => (candidate.bytes > heaviest.bytes ? candidate : heaviest));
  const largest = [...worst.files]
    .sort((a, b) => b.bytes - a.bytes || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, LARGEST_COUNT)
    .map((file) => [file.path, file.bytes] as const);
  return {
    firstViewBytes: worst.bytes,
    budgetBytes: input.budgetBytes,
    withinBudget: input.budgetBytes === null || worst.bytes <= input.budgetBytes,
    largest,
    worst,
    totals,
  };
}

// ---------------------------------------------------------------------------
// The comic's phone images (IC04, D106)

/** IC04: every phone format of every comic page, inclusive. */
export const PHONE_IMAGE_BUDGET_BYTES = 307_200;

/** A page image the build published, by the piece path of its source. */
export type PhoneImageSource = {readonly source: string; readonly image: PublishedImage};

/** One phone-format file of a page, its size as written, and whether it keeps the limit. */
export type PhoneImageMeasure = {
  /** The page image's source path in the piece, which the author changes. */
  readonly source: string;
  /** The published file, relative to the output folder. */
  readonly path: string;
  readonly bytes: number;
  readonly withinBudget: boolean;
};

/**
 * The files a phone loads for an image: the narrowest width the build wrote,
 * in every format it wrote at that width (800 px from a source at least that
 * wide, else the one derivative at the source's own width, D40); for an SVG,
 * the file as written (IC04: "approved SVG comic art counts its copied bytes").
 */
export function phoneFormats(image: PublishedImage): PublishedFile[] {
  if (image.kind === 'vector') {
    return [image.file];
  }
  const narrowest = Math.min(...image.derivatives.map((derivative) => derivative.width));
  return image.derivatives
    .filter((derivative) => derivative.width === narrowest)
    .map((derivative) => ({path: derivative.path, bytes: derivative.bytes}));
}

/** Every phone format of every page image, each file once, against the 307,200-byte limit. */
export function measurePhoneImages(images: readonly PhoneImageSource[]): PhoneImageMeasure[] {
  const measured = new Map<string, PhoneImageMeasure>();
  for (const {source, image} of images) {
    for (const file of phoneFormats(image)) {
      if (!measured.has(file.path)) {
        measured.set(file.path, {source, path: file.path, bytes: file.bytes, withinBudget: file.bytes <= PHONE_IMAGE_BUDGET_BYTES});
      }
    }
  }
  return [...measured.values()];
}
