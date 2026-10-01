/**
 * Pure logic of the comic reader (M4.3).
 *
 * Nothing here touches the DOM or a Node API. The file is checked by the
 * browser program (tsconfig.client.json), inlined into lib/clients/reader.js
 * by esbuild, and compiled by the Node program so
 * test/unit/comic-reader-logic.test.ts can exercise it without a browser.
 * CONTRACT.md beside this file is the DOM contract the reader relies on.
 */

/** The strings the reader reads from the page's strings block (UX §12). */
export const READER_STRING_KEYS = [
  'previous',
  'next',
  'page_of',
  'pages_of',
  'panel_of',
  'guided_view',
  'page_view',
  'detail',
  'close',
  'transcript',
  'panels_hint',
  'panels_hint_one',
  'fullscreen',
  'fullscreen_denied',
] as const;

export type ReaderStringKey = (typeof READER_STRING_KEYS)[number];
export type ReaderStrings = Readonly<Record<ReaderStringKey, string>>;

/**
 * Reads the JSON text of the strings block. Null when it cannot drive the
 * reader: invalid JSON, not a plain object, or a required key missing, not a
 * string or blank. Extra keys are ignored: the renderer emits every string.
 */
export function readReaderStrings(json: string): ReaderStrings | null {
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
  const strings: Partial<Record<ReaderStringKey, string>> = {};
  for (const key of READER_STRING_KEYS) {
    const value = Object.hasOwn(record, key) ? record[key] : undefined;
    if (typeof value !== 'string' || value.trim() === '') {
      return null;
    }
    strings[key] = value;
  }
  return strings as ReaderStrings;
}

/**
 * Replaces each `{name}` with its value in one pass, so a value holding
 * `{total}` or `$&` is inserted as written; an unknown placeholder stays
 * visible. The deck client keeps its own copy: each client bundle is bounded
 * to its own folder (D50, W1_RECONCILIATION §4).
 */
export function formatString(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{([a-z_]+)\}/g, (placeholder: string, name: string) => (Object.hasOwn(values, name) ? String(values[name]) : placeholder));
}

// ---------------------------------------------------------------------------
// The address (IC07, UX C5, ERD §09)

export type ReaderFragment =
  | {readonly kind: 'none'}
  | {readonly kind: 'page'; readonly page: number}
  | {readonly kind: 'panel'; readonly page: number; readonly panel: number}
  | {readonly kind: 'malformed'}
  | {readonly kind: 'other'; readonly id: string};

const PAGE_PREFIX = 'page-';

/**
 * Classifies `location.hash`. `#page-N` and `#page-N-panel-M`, with ASCII
 * digits and N and M from 1, name a page and a panel whether or not they are
 * in range; the caller clamps them. Every other fragment beginning `page-`,
 * a zero, and a fragment that cannot be percent-decoded are malformed: ids
 * beginning `page-` belong to the pages and panels alone (CONTRACT §2). Any
 * other fragment names some other element, returned decoded for the caller
 * to look up.
 */
export function parseReaderFragment(hash: string): ReaderFragment {
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
  if (!decoded.startsWith(PAGE_PREFIX)) {
    return {kind: 'other', id: decoded};
  }
  const match = /^page-([0-9]+)(?:-panel-([0-9]+))?$/.exec(decoded);
  if (match === null) {
    return {kind: 'malformed'};
  }
  const page = Number(match[1]);
  const panel = match[2] === undefined ? null : Number(match[2]);
  if (!(page >= 1) || (panel !== null && !(panel >= 1))) {
    return {kind: 'malformed'};
  }
  return panel === null ? {kind: 'page', page} : {kind: 'panel', page, panel};
}

export function pageFragment(page: number): string {
  return `#${PAGE_PREFIX}${page}`;
}

export function panelFragment(page: number, panel: number): string {
  return `#${PAGE_PREFIX}${page}-panel-${panel}`;
}

/** A 1-based index into 1…count: a number past the end is the last (IC07 clamps); anything below 1 is the first. */
export function clampIndex(index: number, count: number): number {
  const last = Math.max(1, Math.floor(count));
  if (!(index >= 1)) {
    return 1;
  }
  return index >= last ? last : Math.floor(index);
}

// ---------------------------------------------------------------------------
// Guided view (UX §06, IC07)

/** One step of guided view: a panel, or a whole page that has none. */
export type GuidedStep = {readonly page: number; readonly panel: number | null};

/** Every step in reading order: each page's panels in turn, and a page with no panels as one step (IC07). */
export function guidedSteps(panelCounts: readonly number[]): GuidedStep[] {
  const steps: GuidedStep[] = [];
  panelCounts.forEach((count, index) => {
    const page = index + 1;
    if (count <= 0) {
      steps.push({page, panel: null});
    } else {
      for (let panel = 1; panel <= count; panel += 1) {
        steps.push({page, panel});
      }
    }
  });
  return steps;
}

/** The index of a page's panel among the steps: the page's first step when `panel` is null, or its only one. */
export function stepIndex(steps: readonly GuidedStep[], page: number, panel: number | null): number {
  const exact = steps.findIndex((step) => step.page === page && step.panel === panel);
  if (exact >= 0) {
    return exact;
  }
  const first = steps.findIndex((step) => step.page === page);
  return first >= 0 ? first : 0;
}

/** The third of the guided view a tap lands in: the left steps back, the right on, the middle opens the detail (UX §06). */
export function guidedZone(x: number, width: number): 'previous' | 'detail' | 'next' {
  if (!(width > 0) || !Number.isFinite(x)) {
    return 'detail';
  }
  if (x < width / 3) {
    return 'previous';
  }
  return x > (width * 2) / 3 ? 'next' : 'detail';
}

// ---------------------------------------------------------------------------
// Geometry: a box of the page, in percent, drawn to fill a frame

export type Box = readonly [x: number, y: number, width: number, height: number];
export type Size = {readonly width: number; readonly height: number};
/** Where the page image is drawn in a frame: its size and its offset, in CSS pixels. */
export type Placement = {readonly width: number; readonly height: number; readonly left: number; readonly top: number};

/** Guided view shows the box with 4% of the page around it (UX §06). */
export const GUIDED_PADDING = 4;

/** The box grown by `padding` percent of the page on every side, kept on the page. */
export function paddedBox(box: Box, padding: number = GUIDED_PADDING): Box {
  const left = Math.max(0, box[0] - padding);
  const top = Math.max(0, box[1] - padding);
  const right = Math.min(100, box[0] + box[2] + padding);
  const bottom = Math.min(100, box[1] + box[3] + padding);
  return [left, top, right - left, bottom - top];
}

/**
 * The page image drawn so that `box` fills `frame` as far as it can without
 * cropping it (the frame's width or height, whichever binds first), centred.
 */
export function fitBox(box: Box, art: Size, frame: Size): Placement {
  const aspect = art.height / art.width;
  const boxWidth = Math.max(box[2], 1e-6) / 100;
  const boxHeight = (Math.max(box[3], 1e-6) / 100) * aspect;
  const width = Math.min(frame.width / boxWidth, frame.height / boxHeight);
  const height = width * aspect;
  const centreX = ((box[0] + box[2] / 2) / 100) * width;
  const centreY = ((box[1] + box[3] / 2) / 100) * height;
  return {width, height, left: frame.width / 2 - centreX, top: frame.height / 2 - centreY};
}

/** Guided view's placement: the box and its padding, filling the frame (UX §06: "the box, plus 4% padding, fills the width"). */
export function lensPlacement(box: Box, art: Size, frame: Size, padding: number = GUIDED_PADDING): Placement {
  return fitBox(paddedBox(box, padding), art, frame);
}

/** The page image contained in a frame, whole and centred: a page in the book, or a page with no panel in guided view. */
export function containPlacement(art: Size, frame: Size): Placement {
  return fitBox([0, 0, 100, 100], art, frame);
}

/** The most a zoom detail magnifies beyond the box filling its frame. */
export const ZOOM_MAX = 8;

/**
 * A zoom detail's placement scaled by `factor` about a point of the frame,
 * never smaller than `minimum` (the box fitted) nor more than `ZOOM_MAX`
 * times it, then kept covering the frame (`clampPlacement`).
 */
export function zoomPlacement(view: Placement, factor: number, point: {readonly x: number; readonly y: number}, minimum: Placement, frame: Size): Placement {
  const lowest = minimum.width;
  const highest = minimum.width * ZOOM_MAX;
  const width = Math.min(highest, Math.max(lowest, view.width * factor));
  const scale = width / view.width;
  const scaled = {
    width,
    height: view.height * scale,
    left: point.x - (point.x - view.left) * scale,
    top: point.y - (point.y - view.top) * scale,
  };
  return clampPlacement(scaled, frame);
}

/** A placement moved by (dx, dy) and kept covering the frame. */
export function panPlacement(view: Placement, dx: number, dy: number, frame: Size): Placement {
  return clampPlacement({...view, left: view.left + dx, top: view.top + dy}, frame);
}

/**
 * Keeps a drawn image over its frame: on each axis where it is larger than
 * the frame no edge may come inside it; where it is smaller it is centred.
 */
export function clampPlacement(view: Placement, frame: Size): Placement {
  const axis = (offset: number, size: number, room: number): number =>
    size <= room ? (room - size) / 2 : Math.min(0, Math.max(room - size, offset));
  return {...view, left: axis(view.left, view.width, frame.width), top: axis(view.top, view.height, frame.height)};
}

/** A point of the frame as percent of the page image drawn at `view`, each clamped to 0–100 (IC06 `pointer`). */
export function percentAt(view: Placement, x: number, y: number): {readonly x: number; readonly y: number} {
  const clamp = (value: number): number => Math.min(100, Math.max(0, value));
  return {x: clamp(((x - view.left) / view.width) * 100), y: clamp(((y - view.top) / view.height) * 100)};
}

// ---------------------------------------------------------------------------
// The preload window (UX §06, ERD READER_STATE, IC07)

/**
 * The pages whose images stay loaded: the spread shown, the one before it and
 * the one after it. `spreadAt` gives the pages shown together with a page in
 * the current layout.
 */
export function keptPages(visible: readonly number[], total: number, spreadAt: (page: number) => readonly number[]): Set<number> {
  const kept = new Set<number>(visible);
  const first = visible[0];
  const last = visible[visible.length - 1];
  if (first !== undefined && first > 1) {
    for (const page of spreadAt(first - 1)) {
      kept.add(page);
    }
  }
  if (last !== undefined && last < total) {
    for (const page of spreadAt(last + 1)) {
      kept.add(page);
    }
  }
  return kept;
}

// ---------------------------------------------------------------------------
// What the status line and the hint say

export type StatusView =
  | {readonly kind: 'page'; readonly visible: readonly number[]; readonly total: number}
  | {readonly kind: 'guided'; readonly page: number; readonly panel: number | null; readonly panels: number; readonly total: number};

/** "Page 3 of 8", "Pages 2–3 of 8", or in guided view "Panel 2 of 5 on page 3" (UX §06, §12). */
export function statusLine(strings: ReaderStrings, view: StatusView): string {
  if (view.kind === 'guided') {
    return view.panel === null
      ? formatString(strings.page_of, {n: view.page, total: view.total})
      : formatString(strings.panel_of, {n: view.panel, total: view.panels, page: view.page});
  }
  const first = view.visible[0] ?? 1;
  const last = view.visible[view.visible.length - 1] ?? first;
  return last === first ? formatString(strings.page_of, {n: first, total: view.total}) : formatString(strings.pages_of, {a: first, b: last, total: view.total});
}

/**
 * The meta line under the bar: how many panels the pages shown hold, and that
 * they can be explored; `panels_hint_one` when they hold exactly one, the only
 * count English and Spanish put in the singular (D130); nothing for none.
 */
export function hintLine(strings: ReaderStrings, panels: number): string {
  if (!(panels > 0)) {
    return '';
  }
  return formatString(panels === 1 ? strings.panels_hint_one : strings.panels_hint, {n: panels});
}

// ---------------------------------------------------------------------------
// Keys (UX C4, Appendix C)

export type ReaderKey = 'previous' | 'next' | 'first' | 'last';

/** ← and → turn the page, or step in guided view; Home and End go to the first and the last. */
export function readerKey(key: string): ReaderKey | null {
  switch (key) {
    case 'ArrowLeft':
      return 'previous';
    case 'ArrowRight':
      return 'next';
    case 'Home':
      return 'first';
    case 'End':
      return 'last';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// The hook the preview bridge uses (CONTRACT §6)

export type ReaderView = 'page' | 'guided';
export type ReaderLayout = 'single' | 'spread';

/** Why the reader moved; carried by the `pagechange` event. */
export type PageChangeCause = 'key' | 'button' | 'gesture' | 'hash' | 'api' | 'resize';

/** The `detail` of the `pagechange` event dispatched on `document`. */
export type PageChangeDetail = {
  readonly page: number;
  readonly previous: number;
  readonly panel: number | null;
  readonly view: ReaderView;
  readonly layout: ReaderLayout;
  readonly visible: readonly number[];
  readonly total: number;
  readonly cause: PageChangeCause;
};

/** `window.papeleriaReader`, once the reader has enhanced the page. Page and panel numbers are 1-based. */
export interface PapeleriaReader {
  readonly version: 1;
  readonly total: number;
  /** The logical page: in a spread, the page the reader is at, not always the first shown. */
  readonly page: number;
  /** The panel shown in guided view; null in page view, and for a page with no panels. */
  readonly panel: number | null;
  readonly view: ReaderView;
  readonly layout: ReaderLayout;
  readonly visible: readonly number[];
  readonly transcript: boolean;
  readonly detailOpen: boolean;
  readonly instant: boolean;
  /** The address fragment of the place shown: `#page-N` or `#page-N-panel-M`. */
  readonly address: string;
  /** Page view at a page, clamped; focus moves only when asked. Returns the page now shown. */
  goTo(page: number, options?: {readonly focus?: boolean}): number;
  /** Guided view at a page's panel (its first when null), clamped; focus moves only when asked. */
  enterGuided(page: number, panel?: number | null, options?: {readonly focus?: boolean}): void;
  /** Back to page view at the page shown in guided view. */
  leaveGuided(options?: {readonly focus?: boolean}): void;
}
