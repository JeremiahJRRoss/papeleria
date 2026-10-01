/**
 * Pure logic of the deck client (M1.6).
 *
 * Nothing here touches the DOM or a Node API. The same file is checked by the
 * browser program (tsconfig.client.json), inlined into lib/clients/deck.js by
 * esbuild, and compiled by the Node program so test/unit/deck-client.test.ts
 * can exercise it without a browser.
 */

/** The strings the deck client reads from the page's strings block (UX §12). */
export const DECK_STRING_KEYS = [
  'previous',
  'next',
  'show_all',
  'show_one',
  'show_notes',
  'hide_notes',
  'fullscreen',
  'fullscreen_denied',
  'print',
  'slide_of',
  'all_shown',
  'all_shown_one',
] as const;

export type DeckStringKey = (typeof DECK_STRING_KEYS)[number];
export type DeckStrings = Readonly<Record<DeckStringKey, string>>;

/**
 * Reads the JSON text of the strings block. Returns null when the block cannot
 * drive the client: invalid JSON, not a plain object, or any required key
 * missing, not a string, or blank. Extra keys are ignored, so a renderer may
 * emit every UI string or only the deck's.
 */
export function readDeckStrings(json: string): DeckStrings | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const strings: Partial<Record<DeckStringKey, string>> = {};
  for (const key of DECK_STRING_KEYS) {
    const value = Object.hasOwn(record, key) ? record[key] : undefined;
    if (typeof value !== 'string' || value.trim() === '') {
      return null;
    }
    strings[key] = value;
  }
  return strings as DeckStrings;
}

/**
 * Replaces each `{name}` with its value in a single pass, so a value that itself
 * contains `{total}` or `$&` is inserted literally and never substituted twice.
 * An unknown placeholder stays as written, which keeps a translation mistake
 * visible rather than blank.
 */
export function formatString(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{([a-z_]+)\}/g, (placeholder: string, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : placeholder,
  );
}

/**
 * The stacked view's status: `all_shown_one` for a deck of exactly one slide,
 * `all_shown` for any other count (D130). One is the only count English and
 * Spanish put in the singular.
 */
export function allShownLine(strings: DeckStrings, total: number): string {
  return formatString(total === 1 ? strings.all_shown_one : strings.all_shown, {total});
}

/** A classified address fragment. */
export type Fragment =
  | {kind: 'none'}
  | {kind: 'slide'; number: number}
  | {kind: 'malformed'}
  | {kind: 'other'; id: string};

const SLIDE_ID_PREFIX = 'slide-';

/**
 * Classifies `location.hash` (IC07, UX C5).
 *
 * `#slide-N` with ASCII digits is a slide reference whether or not N is in
 * range; the caller clamps it. Any other fragment starting with `slide-`, and a
 * fragment that cannot be percent-decoded, is malformed: the `slide-` id prefix
 * is reserved for slide articles (CONTRACT.md). Every other fragment names some
 * other element, such as the skip link's `#deck-main` or a title, and is
 * returned decoded for the caller to look up.
 */
export function parseFragment(hash: string): Fragment {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw === '') {
    return {kind: 'none'};
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return {kind: 'malformed'};
  }
  if (decoded.startsWith(SLIDE_ID_PREFIX)) {
    const digits = decoded.slice(SLIDE_ID_PREFIX.length);
    return /^[0-9]+$/.test(digits) ? {kind: 'slide', number: Number(digits)} : {kind: 'malformed'};
  }
  return {kind: 'other', id: decoded};
}

/**
 * Clamps a 1-based slide number into 1..total. A positive number past the end
 * becomes the last slide (IC07); zero, a negative number and NaN become the
 * first. Fractions are truncated.
 */
export function clampSlide(number: number, total: number): number {
  const last = Math.max(1, Math.floor(total));
  if (!(number >= 1)) {
    return 1;
  }
  if (number >= last) {
    return last;
  }
  return Math.floor(number);
}

/** The canonical address fragment of a 1-based slide number. */
export function slideFragment(number: number): string {
  return `#${SLIDE_ID_PREFIX}${number}`;
}

/** A swipe must travel at least this far, in CSS pixels (UX §05). */
export const SWIPE_MIN_DISTANCE = 40;

/** A swipe must stay within this angle of horizontal, in degrees (UX §05). */
export const SWIPE_MAX_ANGLE_DEGREES = 30;

/**
 * Classifies one finger's travel from touch start to touch end (D53). Both
 * limits are inclusive and the distance is the straight-line length. A finger
 * moving left (dx < 0) brings the next slide in, as a page does; moving right
 * brings the previous one back. Anything else is not a swipe.
 */
export function classifySwipe(dx: number, dy: number): 'next' | 'previous' | null {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    return null;
  }
  if (Math.hypot(dx, dy) < SWIPE_MIN_DISTANCE) {
    return null;
  }
  const angle = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI;
  // The epsilon keeps an exact 30° gesture inclusive despite floating point.
  if (angle > SWIPE_MAX_ANGLE_DEGREES + 1e-9) {
    return null;
  }
  return dx < 0 ? 'next' : 'previous';
}

/** What a navigation key asks the deck to do. */
export type KeyAction = 'previous' | 'next' | 'first' | 'last';

/**
 * Maps `KeyboardEvent.key` to a deck action (UX §05, C4). In the stacked
 * "show all" view the vertical arrows stay with the browser so the page still
 * scrolls line by line (D53); PageUp and PageDown keep the kit's slide jumps.
 */
export function keyAction(key: string, showAll: boolean): KeyAction | null {
  switch (key) {
    case 'ArrowLeft':
    case 'PageUp':
      return 'previous';
    case 'ArrowRight':
    case 'PageDown':
      return 'next';
    case 'ArrowUp':
      return showAll ? null : 'previous';
    case 'ArrowDown':
      return showAll ? null : 'next';
    case 'Home':
      return 'first';
    case 'End':
      return 'last';
    default:
      return null;
  }
}

/** Collapses runs of white space to one space and trims the ends. */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Why the current slide changed; carried by the `slidechange` event. */
export type SlideChangeCause = 'key' | 'button' | 'swipe' | 'hash' | 'api';

/** The `detail` of the `slidechange` event dispatched on `document` (D52). */
export type SlideChangeDetail = {
  readonly slide: number;
  readonly previous: number;
  readonly total: number;
  readonly showAll: boolean;
  readonly notes: boolean;
  readonly cause: SlideChangeCause;
};

/**
 * The hook point the preview bridge uses (D52), published as
 * `window.papeleriaDeck` once the deck is enhanced. Slide numbers are 1-based.
 */
export interface PapeleriaDeck {
  readonly version: 1;
  readonly total: number;
  readonly current: number;
  readonly showAll: boolean;
  readonly notes: boolean;
  /**
   * Shows a slide, clamped into range, and returns the slide now shown. NaN or
   * a non-number changes nothing. Focus moves to the slide title only when
   * `options.focus` is true, so a preview following the editor never takes
   * focus away from the source text.
   */
  goTo(slide: number, options?: {readonly focus?: boolean}): number;
}
