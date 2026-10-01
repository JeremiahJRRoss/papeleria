/**
 * M2.1, M2.6: the preview messages of IC06 and the checks both ends apply to
 * them. The bridge in a preview page and the editor (or `serve`'s shell)
 * exchange exactly nine messages with `postMessage`:
 *
 * | Message                     | Direction          | Meaning |
 * | --- | --- | --- |
 * | `goto(target)`              | editor → frame     | Show a slide, page, panel or section, without taking focus |
 * | `grid(on)`                  | editor → frame     | The comic's percent grid on or off (M4.4 gives it behaviour) |
 * | `restoreScroll(y)`          | editor → frame     | Scroll the page to `y` CSS pixels, instantly |
 * | `ready(hash)`               | frame → editor     | The page is ready at `hash`; sent once loaded, and again after the reader moves (D83) |
 * | `pointer(page, x, y)`       | frame → editor     | The pointer over a comic page, in percent (M4.4) |
 * | `pointerLeft`               | frame → editor     | The pointer left the comic's page images after a `pointer` (D174) |
 * | `overflow(slides)`          | frame → editor     | A deck's slides that do not fit their printed page, measured once laid out (D167, D174) |
 * | `scroll(y)`                 | frame → editor     | The page scrolled to `y` |
 * | `returnFocus`               | frame → editor     | Escape reached the page with nothing else to close |
 *
 * Every message carries the generation id of the page it concerns, so a
 * message from a frame still showing an older generation, or addressed to
 * one, is ignored. A receiver accepts a message only when its origin is the
 * exact origin expected, its source is the exact window expected, its shape
 * is exactly one of the variants for its direction (no extra key, every
 * number finite) and its generation matches (IC06). Numbers that are
 * coordinates are clamped into range rather than refused.
 *
 * Pure: no DOM type and no Node API, so the same module compiles in the
 * browser program (the bridge, the editor) and the Node program (the
 * server's tests), and the tests exercise the very checks the pages run.
 */

/** IC06 `Target`, as `src/build/targets.ts` defines it. */
export type Target =
  | {readonly kind: 'slide'; readonly slide: number}
  | {readonly kind: 'page'; readonly page: number}
  | {readonly kind: 'panel'; readonly page: number; readonly panel: number}
  | {readonly kind: 'section'; readonly slug: string};

/** IC06 `SourceTarget`: a stretch of one source file and the place it produces. */
export type SourceTarget = {readonly target: Target; readonly file: string; readonly lineStart: number; readonly lineEnd: number};

/** A generation id as `src/build/write.ts` makes it: base-36 milliseconds, a hyphen, then 48 random bits in hex. */
export const GENERATION_ID_PATTERN = /^[0-9a-z]{1,12}-[0-9a-f]{12}$/;

export type ToFrameMessage =
  | {readonly type: 'goto'; readonly generationId: string; readonly target: Target}
  | {readonly type: 'grid'; readonly generationId: string; readonly on: boolean}
  | {readonly type: 'restoreScroll'; readonly generationId: string; readonly y: number};

export type ToEditorMessage =
  | {readonly type: 'ready'; readonly generationId: string; readonly hash: string}
  | {readonly type: 'pointer'; readonly generationId: string; readonly page: number; readonly x: number; readonly y: number}
  | {readonly type: 'pointerLeft'; readonly generationId: string}
  | {readonly type: 'overflow'; readonly generationId: string; readonly slides: readonly number[]}
  | {readonly type: 'scroll'; readonly generationId: string; readonly y: number}
  | {readonly type: 'returnFocus'; readonly generationId: string};

/** Bounds for the values a message may carry. */
export const MESSAGE_LIMITS = Object.freeze({
  /** A scroll offset in CSS pixels is clamped into [0, scrollMax]. */
  scrollMax: 10_000_000,
  /** A slide, page or panel number is an integer in [1, indexMax]. */
  indexMax: 100_000,
  /** The longest address fragment or section slug a message may carry, in UTF-16 code units. */
  textMax: 2_048,
  /** The most slide numbers an `overflow` report may carry: the most slides a deck may have (its schema's `slides`). */
  slidesMax: 1_000,
});

type Record_ = Readonly<Record<string, unknown>>;

/** A plain object carrying exactly `keys` (in any order), or null. */
function plain(data: unknown, keys: readonly string[]): Record_ | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(data) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    return null;
  }
  const own = Object.keys(data);
  if (own.length !== keys.length || !keys.every((key) => Object.hasOwn(data, key))) {
    return null;
  }
  return data as Record_;
}

function isGenerationId(value: unknown): value is string {
  return typeof value === 'string' && GENERATION_ID_PATTERN.test(value);
}

function index(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MESSAGE_LIMITS.indexMax ? value : null;
}

function clamp(value: unknown, low: number, high: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(value, low), high) : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length <= MESSAGE_LIMITS.textMax ? value : null;
}

/**
 * Slide numbers in increasing order, each once, at most `slidesMax` of them, in a plain array that holds nothing
 * else (no hole, no other key); or null. The copy returned is frozen.
 */
function slideList(value: unknown): readonly number[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > MESSAGE_LIMITS.slidesMax || Object.keys(value).length !== value.length) {
    return null;
  }
  const slides: number[] = [];
  for (const item of value as unknown[]) {
    const slide = index(item);
    if (slide === null || (slides.length > 0 && slide <= slides[slides.length - 1]!)) {
      return null;
    }
    slides.push(slide);
  }
  return Object.freeze(slides);
}

/** A `Target` of exactly one of the four shapes, or null. */
export function validateTarget(data: unknown): Target | null {
  const kind = typeof data === 'object' && data !== null ? (data as {kind?: unknown}).kind : undefined;
  switch (kind) {
    case 'slide': {
      const record = plain(data, ['kind', 'slide']);
      const slide = index(record?.['slide']);
      return slide === null ? null : {kind, slide};
    }
    case 'page': {
      const record = plain(data, ['kind', 'page']);
      const page = index(record?.['page']);
      return page === null ? null : {kind, page};
    }
    case 'panel': {
      const record = plain(data, ['kind', 'page', 'panel']);
      const page = index(record?.['page']);
      const panel = index(record?.['panel']);
      return page === null || panel === null ? null : {kind, page, panel};
    }
    case 'section': {
      const record = plain(data, ['kind', 'slug']);
      const slug = text(record?.['slug']);
      return slug === null || slug === '' ? null : {kind, slug};
    }
    default:
      return null;
  }
}

function typeOf(data: unknown): unknown {
  return typeof data === 'object' && data !== null ? (data as {type?: unknown}).type : undefined;
}

/** A message the editor may send to a preview page, exactly as IC06 shapes it, or null. */
export function validateToFrame(data: unknown): ToFrameMessage | null {
  switch (typeOf(data)) {
    case 'goto': {
      const record = plain(data, ['type', 'generationId', 'target']);
      const target = validateTarget(record?.['target']);
      return record === null || !isGenerationId(record['generationId']) || target === null
        ? null
        : {type: 'goto', generationId: record['generationId'], target};
    }
    case 'grid': {
      const record = plain(data, ['type', 'generationId', 'on']);
      return record === null || !isGenerationId(record['generationId']) || typeof record['on'] !== 'boolean'
        ? null
        : {type: 'grid', generationId: record['generationId'], on: record['on']};
    }
    case 'restoreScroll': {
      const record = plain(data, ['type', 'generationId', 'y']);
      const y = clamp(record?.['y'], 0, MESSAGE_LIMITS.scrollMax);
      return record === null || !isGenerationId(record['generationId']) || y === null
        ? null
        : {type: 'restoreScroll', generationId: record['generationId'], y};
    }
    default:
      return null;
  }
}

/** A message a preview page may send to the editor, exactly as IC06 shapes it, or null. */
export function validateToEditor(data: unknown): ToEditorMessage | null {
  switch (typeOf(data)) {
    case 'ready': {
      const record = plain(data, ['type', 'generationId', 'hash']);
      const hash = text(record?.['hash']);
      return record === null || !isGenerationId(record['generationId']) || hash === null || (hash !== '' && !hash.startsWith('#'))
        ? null
        : {type: 'ready', generationId: record['generationId'], hash};
    }
    case 'pointer': {
      const record = plain(data, ['type', 'generationId', 'page', 'x', 'y']);
      const page = index(record?.['page']);
      const x = clamp(record?.['x'], 0, 100);
      const y = clamp(record?.['y'], 0, 100);
      return record === null || !isGenerationId(record['generationId']) || page === null || x === null || y === null
        ? null
        : {type: 'pointer', generationId: record['generationId'], page, x, y};
    }
    case 'pointerLeft': {
      // A type of its own rather than a pointer without coordinates, so each shape stays exact (D174).
      const record = plain(data, ['type', 'generationId']);
      return record === null || !isGenerationId(record['generationId']) ? null : {type: 'pointerLeft', generationId: record['generationId']};
    }
    case 'overflow': {
      const record = plain(data, ['type', 'generationId', 'slides']);
      const slides = slideList(record?.['slides']);
      return record === null || !isGenerationId(record['generationId']) || slides === null
        ? null
        : {type: 'overflow', generationId: record['generationId'], slides};
    }
    case 'scroll': {
      const record = plain(data, ['type', 'generationId', 'y']);
      const y = clamp(record?.['y'], 0, MESSAGE_LIMITS.scrollMax);
      return record === null || !isGenerationId(record['generationId']) || y === null
        ? null
        : {type: 'scroll', generationId: record['generationId'], y};
    }
    case 'returnFocus': {
      const record = plain(data, ['type', 'generationId']);
      return record === null || !isGenerationId(record['generationId']) ? null : {type: 'returnFocus', generationId: record['generationId']};
    }
    default:
      return null;
  }
}

/** What a receiver expects of a message: the sender's exact origin and window, and the generation concerned. */
export type Expected = {readonly origin: string; readonly source: unknown; readonly generationId: string};

/** The parts of a `MessageEvent` the checks read; `source` is compared by identity. */
export type Envelope = {readonly origin: string; readonly source: unknown; readonly data: unknown};

function sameSender(envelope: Envelope, expected: Expected): boolean {
  return (
    typeof envelope.origin === 'string' &&
    envelope.origin !== '' &&
    envelope.origin !== 'null' &&
    envelope.origin === expected.origin &&
    envelope.source !== null &&
    envelope.source !== undefined &&
    envelope.source === expected.source
  );
}

/** The frame's check: from its parent, at the parent's exact origin, about this page's generation. */
export function acceptToFrame(envelope: Envelope, expected: Expected): ToFrameMessage | null {
  if (!sameSender(envelope, expected)) {
    return null;
  }
  const message = validateToFrame(envelope.data);
  return message !== null && message.generationId === expected.generationId ? message : null;
}

/** The editor's check: from the frame it loaded, at the preview origin, about the generation that frame holds. */
export function acceptToEditor(envelope: Envelope, expected: Expected): ToEditorMessage | null {
  if (!sameSender(envelope, expected)) {
    return null;
  }
  const message = validateToEditor(envelope.data);
  return message !== null && message.generationId === expected.generationId ? message : null;
}

/**
 * The address fragment that names a target (IC07, ERD 12): `#slide-3`,
 * `#page-4`, `#page-4-panel-2`, or a section's slug, URL-encoded.
 */
export function targetFragment(target: Target): string {
  switch (target.kind) {
    case 'slide':
      return `#slide-${target.slide}`;
    case 'page':
      return `#page-${target.page}`;
    case 'panel':
      return `#page-${target.page}-panel-${target.panel}`;
    case 'section':
      return `#${encodeURIComponent(target.slug)}`;
  }
}

/**
 * The target a source position belongs to, as `src/build/targets.ts`
 * `targetAt` decides it: of the targets whose file is `file` and whose range
 * holds `line`, the narrowest, and the first of equals; null for a line that
 * produces nothing on its own. The editor runs it on every cursor move, so it
 * lives here, in a module the browser program can compile; a unit test holds
 * the two copies to the same answers.
 */
export function targetAt(targets: readonly SourceTarget[], file: string, line: number): Target | null {
  let best: SourceTarget | null = null;
  for (const candidate of targets) {
    if (candidate.file !== file || line < candidate.lineStart || line > candidate.lineEnd) {
      continue;
    }
    if (best === null || candidate.lineEnd - candidate.lineStart < best.lineEnd - best.lineStart) {
      best = candidate;
    }
  }
  return best?.target ?? null;
}

/** Whether two targets name the same place. */
export function sameTarget(a: Target | null, b: Target | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return targetFragment(a) === targetFragment(b);
}
