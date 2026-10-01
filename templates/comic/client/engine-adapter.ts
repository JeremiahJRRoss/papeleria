/**
 * The page-turn engine behind Papeleria's own API (M4.1, DEP05, D103).
 *
 * StPageFlip 2.0.7 (vendor/page-flip/, D100) supplies the swipe, the edge
 * drag and the curl, and nothing else. This adapter owns everything the reader
 * relies on: the logical page, IC07's choice between one page and a spread,
 * which presses the engine may see, and whether an animation may run at all.
 * The engine is handed in, not imported, so the adapter is typed without the
 * untyped vendored file and a test can give it a spying subclass.
 *
 * What the engine does on its own, read from its sources (blueprint/W3C.md),
 * and what the adapter does about it:
 *
 * - Its frame loop never ends, destroy() does not stop it, and each frame it
 *   hides every page it is not showing. The adapter swallows the loop while
 *   loadFromHTML starts it and calls the engine's render(timestamp) from a
 *   loop of its own, which destroy() cancels.
 * - destroy() removes the element it was given, with the pages it moved into
 *   it. The adapter gives it a block of its own and puts every page back first.
 *   A create() that fails, in the engine or in the adapter's own checks,
 *   leaves the page as it found it: the engine is stopped as far as it got,
 *   the block goes, every page is put back, and the error is thrown on.
 * - It picks portrait or landscape from the block width alone, and after a
 *   change it shows the spread of its own index. The adapter decides the
 *   layout, pins the engine to it, and shows its own logical page again.
 * - It starts a gesture on any press not aimed at an `a` or a `button` itself,
 *   so a press on a child of a panel button would turn the page, and a click
 *   anywhere on the book turns it. Its only setting against that,
 *   `disableFlipByClick`, also refuses its own flipPrev() and, when the book
 *   has room above it, flipNext(): both synthesize a point outside the book
 *   and then require it to be on a corner. The adapter keeps click turns on and
 *   lets a press through only in the edge zones (UX §06: 20% each side), never
 *   on a control; everywhere else the press is the reader's, and the adapter's
 *   own swipe turns the page.
 * - Every animation starts in flip(), flipNext(), flipPrev() or a gesture. In
 *   instant mode the adapter calls turnToPage() only and lets no press through;
 *   its own swipe and edge-zone click turn the page instantly.
 */

/** The engine's settings as the vendored file reads them (src/Settings.ts). */
export type EngineSettings = {
  startPage: number;
  size: 'fixed' | 'stretch';
  width: number;
  height: number;
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
  drawShadow: boolean;
  flippingTime: number;
  usePortrait: boolean;
  startZIndex: number;
  autoSize: boolean;
  maxShadowOpacity: number;
  showCover: boolean;
  mobileScrollSupport: boolean;
  clickEventForward: boolean;
  useMouseEvents: boolean;
  swipeDistance: number;
  showPageCorners: boolean;
  disableFlipByClick: boolean;
};

export type EngineEvent = {readonly data: unknown};
export type EngineCorner = 'top' | 'bottom';
export type EngineEventName = 'flip' | 'changeState' | 'changeOrientation' | 'init' | 'update';

/** The engine's renderer, which the adapter drives frame by frame (src/Render/Render.ts). */
export interface EngineRender {
  render(timestamp: number): void;
  finishAnimation(): void;
  setLeftPage(page: null): void;
  setRightPage(page: null): void;
  setBottomPage(page: null): void;
  setFlippingPage(page: null): void;
}

/** The engine's page collection (src/Collection/PageCollection.ts). */
export interface EnginePages {
  destroy(): void;
}

/** What the adapter uses of StPageFlip's PageFlip class (src/PageFlip.ts). */
export interface PageFlipEngine {
  loadFromHTML(items: HTMLElement[]): void;
  turnToPage(index: number): void;
  flipNext(corner?: EngineCorner): void;
  flipPrev(corner?: EngineCorner): void;
  update(): void;
  destroy(): void;
  on(event: EngineEventName, callback: (event: EngineEvent) => void): unknown;
  off(event: EngineEventName): void;
  getSettings(): EngineSettings;
  getRender(): EngineRender;
  getPageCollection(): EnginePages;
  getState(): string;
  getCurrentPageIndex(): number;
  getOrientation(): string;
}

export type PageFlipConstructor = new (block: HTMLElement, settings: Partial<EngineSettings>) => PageFlipEngine;

// ---------------------------------------------------------------------------
// The rules, as pure functions.

export type Layout = 'single' | 'spread';

export type SpreadRule = {readonly minViewportWidth: number; readonly minViewportHeight: number; readonly minPageWidth: number};

/** IC07 and UX §06: a spread needs a viewport of at least 900 × 500 and room for each page to be at least 320 px wide. */
export const SPREAD_RULE: SpreadRule = Object.freeze({minViewportWidth: 900, minViewportHeight: 500, minPageWidth: 320});

export type LayoutSize = {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  /** The book's area: the block the engine fits its pages into. */
  readonly areaWidth: number;
  readonly areaHeight: number;
  /** The art's pixel size, for its aspect ratio. */
  readonly pageWidth: number;
  readonly pageHeight: number;
};

/**
 * One page or a spread. A spread's pages are fitted the way the engine fits
 * them: half the area's width each, unless the height binds first.
 */
export function chooseLayout(size: LayoutSize, rule: SpreadRule = SPREAD_RULE): Layout {
  if (!(size.viewportWidth >= rule.minViewportWidth && size.viewportHeight >= rule.minViewportHeight)) {
    return 'single';
  }
  if (!(size.pageWidth > 0 && size.pageHeight > 0)) {
    return 'single';
  }
  const fitted = Math.min(size.areaWidth / 2, size.areaHeight * (size.pageWidth / size.pageHeight));
  return fitted >= rule.minPageWidth ? 'spread' : 'single';
}

/** A page number within 1…total; anything that is not a finite number is page 1 (IC07 clamps). */
export function clampPage(page: number, total: number): number {
  if (!Number.isFinite(page)) {
    return 1;
  }
  return Math.min(Math.max(Math.trunc(page), 1), Math.max(total, 1));
}

/** The pages shown together: the cover alone, then 2–3, 4–5 and so on, and a final unpaired page alone (IC07). */
export function spreadOf(page: number, total: number, layout: Layout): readonly number[] {
  const current = clampPage(page, total);
  if (layout === 'single' || current === 1) {
    return [current];
  }
  const left = current % 2 === 0 ? current : current - 1;
  return left + 1 <= total ? [left, left + 1] : [left];
}

/** Where a forward turn arrives: the page after the last one shown, or null at the end. */
export function nextPage(page: number, total: number, layout: Layout): number | null {
  const shown = spreadOf(page, total, layout);
  const target = (shown[shown.length - 1] ?? total) + 1;
  return target <= total ? target : null;
}

/** Where a backward turn arrives: the first page of the spread before, or null at the start. */
export function previousPage(page: number, total: number, layout: Layout): number | null {
  const first = spreadOf(page, total, layout)[0] ?? 1;
  return first <= 1 ? null : (spreadOf(first - 1, total, layout)[0] ?? null);
}

/** UX §06: a swipe is 40 px or more in a straight line, within 30° of horizontal, both limits inclusive. */
export const SWIPE = Object.freeze({minDistance: 40, maxAngleDegrees: 30});

/** A leftward swipe turns forward. The rule and its measure are D53's for the deck. */
export function swipeDirection(dx: number, dy: number): 'next' | 'previous' | null {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < SWIPE.minDistance) {
    return null;
  }
  const angle = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI;
  if (angle > SWIPE.maxAngleDegrees + 1e-9) {
    return null;
  }
  return dx < 0 ? 'next' : 'previous';
}

/** UX §06: an edge zone is 20% of the book's area on each side; a click or a drag there turns the page. */
export const EDGE_ZONE = 0.2;

/** A press that moves no further than this is a click (the engine's own measure, src/PageFlip.ts). */
export const CLICK_TOLERANCE = 5;

/**
 * A browser follows a tap with mouse events and a click at the same point unless the tap's touchend is
 * cancelled. After the adapter turns a page on a touch, a mouse press or click this soon and this near is that
 * echo, whatever the browser did with the cancelled touchend.
 */
export const TAP_ECHO_MS = 700;
export const TAP_ECHO_RADIUS = 25;

/** Which way an edge zone turns: x is the press's distance from the area's left edge. */
export function edgeZone(x: number, width: number, zone: number = EDGE_ZONE): 'next' | 'previous' | null {
  if (!(width > 0) || !Number.isFinite(x)) {
    return null;
  }
  if (x < width * zone) {
    return 'previous';
  }
  if (x > width * (1 - zone)) {
    return 'next';
  }
  return null;
}

// ---------------------------------------------------------------------------
// The adapter.

export type ChangeCause = 'api' | 'gesture' | 'resize';

export type AdapterState = {
  readonly page: number;
  readonly total: number;
  readonly layout: Layout;
  readonly visible: readonly number[];
  readonly cause: ChangeCause;
};

/**
 * Presses that start on these never reach the engine: they belong to the
 * control (IC07, panel actions win). `data-no-turn` lets the reader add any
 * other element, such as a zoom surface.
 */
export const INTERACTIVE =
  'a[href], button, input, select, textarea, label, summary, [contenteditable]:not([contenteditable="false"]), ' +
  '[role="button"], [role="link"], [tabindex]:not([tabindex="-1"]), [data-no-turn]';

export type AdapterOptions = {
  /** The vendored `St.PageFlip`, or a subclass of it. */
  readonly engine: PageFlipConstructor;
  /** The art's pixel size; every page is drawn at this aspect ratio. */
  readonly pageWidth: number;
  readonly pageHeight: number;
  /** 1-based, clamped. Default 1. */
  readonly startPage?: number;
  /** Reduced motion: no animated engine call, ever, and turns are instant. Default false. */
  readonly instant?: boolean;
  /** The curl's duration in ms (UX §06: about 600). */
  readonly flippingTime?: number;
  /** Presses starting on these never reach the engine. Default `INTERACTIVE`. */
  readonly interactive?: string;
  /** The share of the area's width on each side where the engine may take a press. Default `EDGE_ZONE`. */
  readonly edgeZone?: number;
  /** Called after the logical page or the layout changes, never during `create`. */
  readonly onChange?: (state: AdapterState) => void;
};

export type EngineAdapter = {
  readonly total: number;
  /** The logical page, 1-based: owned here, never read back from the engine's index. */
  readonly page: number;
  readonly layout: Layout;
  /** The pages on screen now, in order. */
  readonly visible: readonly number[];
  readonly instant: boolean;
  /** Shows a page at once, clamped; in a spread, the spread that contains it. */
  turnTo(page: number): void;
  /** One page forward, or one spread: the engine's curl, or an instant swap in instant mode. */
  next(): void;
  previous(): void;
  /**
   * Decides the layout again and keeps the logical page; a curl in progress completes first. The adapter
   * calls it on every resize it sees, and a call that finds nothing resized does nothing.
   */
  resize(): void;
  /** Live reduced-motion changes (A14): switching on finishes a curl in progress at once. */
  setInstant(instant: boolean): void;
  /** Off while the reader's dialog or guided view owns the pointer: no press then reaches the engine. */
  setInput(enabled: boolean): void;
  /** Removes every listener, observer and frame the adapter or the engine added, and puts the pages back as they were. */
  destroy(): void;
};

/** The classes the engine puts on page elements (src/Page/HTMLPage.ts). */
const ENGINE_PAGE_CLASSES = ['stf__item', '--soft', '--hard', '--left', '--right', '--simple'];

type PageRecord = {
  readonly element: HTMLElement;
  readonly parent: Node | null;
  readonly next: Node | null;
  readonly className: string | null;
  readonly style: string | null;
};

/** A press the engine does not see: where it started, which finger, and the edge zone it may click. */
type Swipe = {readonly x: number; readonly y: number; readonly touch: number | null; readonly zone: 'next' | 'previous' | null};

/**
 * Runs `load` with `requestAnimationFrame` swapped for a stub that keeps the
 * callback instead of scheduling it, so the engine's endless loop never
 * starts. The engine asks for exactly one frame while loading, from
 * Render.start(); anything else means the file is not the pinned one.
 */
function withoutEngineLoop(load: () => void): void {
  const own = Object.getOwnPropertyDescriptor(window, 'requestAnimationFrame');
  let asked = 0;
  window.requestAnimationFrame = (): number => {
    asked += 1;
    return 0;
  };
  try {
    load();
  } finally {
    if (own === undefined) {
      Reflect.deleteProperty(window, 'requestAnimationFrame');
    } else {
      Object.defineProperty(window, 'requestAnimationFrame', own);
    }
  }
  if (asked !== 1) {
    throw new Error(`The page-turn engine asked for ${asked} animation frames while loading; the adapter expects one, its render loop (D103).`);
  }
}

/**
 * Stops an engine whose start failed, as destroy() stops a running one: whatever it still runs later, its start-up
 * timer included, finds nothing to show or restyle, and its listeners and elements go. It may have failed before it
 * made a part a step undoes, so each step is tried on its own.
 */
function abandonEngine(engine: PageFlipEngine): void {
  const steps: readonly (() => void)[] = [
    () => engine.off('flip'),
    () => {
      const render = engine.getRender();
      render.setLeftPage(null);
      render.setRightPage(null);
      render.setBottomPage(null);
      render.setFlippingPage(null);
    },
    () => engine.getPageCollection().destroy(),
    () => engine.destroy(),
  ];
  for (const step of steps) {
    try {
      step();
    } catch {
      // A part the engine never made: nothing of it to undo.
    }
  }
}

function hasSelection(): boolean {
  const selection = document.getSelection();
  return selection !== null && selection.rangeCount > 0 && !selection.isCollapsed;
}

function pinchZoomed(): boolean {
  return window.visualViewport !== null && window.visualViewport.scale > 1.01;
}

export function create(container: HTMLElement, pages: readonly HTMLElement[], options: AdapterOptions): EngineAdapter {
  const total = pages.length;
  if (total === 0) {
    throw new Error('The page-turn adapter needs at least one page.');
  }
  if (!(options.pageWidth > 0 && options.pageHeight > 0 && Number.isFinite(options.pageWidth) && Number.isFinite(options.pageHeight))) {
    throw new Error('The page-turn adapter needs the art\'s width and height in pixels.');
  }
  const interactive = options.interactive ?? INTERACTIVE;
  const zoneShare = options.edgeZone ?? EDGE_ZONE;
  const records: PageRecord[] = pages.map((element) => ({
    element,
    parent: element.parentNode,
    next: element.nextSibling,
    className: element.getAttribute('class'),
    style: element.getAttribute('style'),
  }));
  const own = new Set<Element>(pages);

  // A block of the adapter's own, in the pages' place: the engine removes it on destroy().
  const block = document.createElement('div');
  block.className = 'papeleria-engine';
  block.style.width = '100%';
  block.style.height = '100%';
  const first = pages[0];
  if (first !== undefined && first.parentNode === container) {
    container.insertBefore(block, first);
  } else {
    container.appendChild(block);
  }
  if (block.clientWidth === 0 || block.clientHeight === 0) {
    block.remove();
    throw new Error('The page-turn adapter needs a container with a width and a height: give the reader\'s stage a size before calling create().');
  }

  /** What a resize changes: the block's size and the viewport's. */
  const sizeKey = (): string => `${block.clientWidth}x${block.clientHeight}@${window.innerWidth}x${window.innerHeight}`;
  const measure = (): Layout =>
    chooseLayout({
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      areaWidth: block.clientWidth,
      areaHeight: block.clientHeight,
      pageWidth: options.pageWidth,
      pageHeight: options.pageHeight,
    });

  let page = clampPage(options.startPage ?? 1, total);
  let layout = measure();
  let instant = options.instant === true;
  let inputEnabled = true;
  let destroyed = false;
  // Engine calls the adapter makes itself: a flip event inside one is the adapter's own doing.
  let programmatic = 0;
  // Why the curl in progress was started, when the adapter started it.
  let pendingCause: ChangeCause | null = null;
  let frame = 0;
  // The time last given to the engine's clock. The engine stamps a curl's start with it, so from the first draw
  // it is now, not 0: a curl stamped 0, asked for before the adapter's first frame, is long over by that frame
  // (DEP05 spike test 10), and the adapter draws just before it asks for a curl (test 11). It never goes back,
  // so a frame whose timestamp is a little earlier than a draw made between frames shows the curl's first step
  // again rather than a step before it.
  let clock = 0;
  let swipe: Swipe | null = null;
  // Where and when the adapter last turned the page on a touch, for the tap's echo.
  let touchTurn: {readonly x: number; readonly y: number; readonly time: number} | null = null;

  const notify = (cause: ChangeCause): void => {
    options.onChange?.({page, total, layout, visible: spreadOf(page, total, layout), cause});
  };

  const settle = (next: number, cause: ChangeCause): void => {
    if (next !== page) {
      page = next;
      notify(cause);
    }
  };

  /** Puts every page back where the adapter found it, with its class and style. Last page first, so a page's recorded next sibling is back before it is needed. */
  const restorePages = (): void => {
    for (const record of [...records].reverse()) {
      const {element} = record;
      element.classList.remove(...ENGINE_PAGE_CLASSES);
      const before = record.className === null ? [] : record.className.split(/\s+/).filter((name) => name !== '');
      if (element.classList.length === before.length && before.every((name, index) => element.classList.item(index) === name)) {
        if (record.className === null) {
          element.removeAttribute('class');
        } else {
          element.setAttribute('class', record.className);
        }
      }
      // The engine writes style.cssText every frame, and Blink leaves the attribute unsynchronized after such
      // a write: removed as it is, it is serialized again as style="". Writing the attribute first brings it
      // back in step with the declaration, and removing it then removes both.
      element.setAttribute('style', record.style ?? '');
      if (record.style === null) {
        element.removeAttribute('style');
      }
      if (record.parent !== null) {
        record.parent.insertBefore(element, record.next !== null && record.next.parentNode === record.parent ? record.next : null);
      }
    }
  };

  /**
   * The engine, built in the block and given the pages, with its render and live settings. A start that fails, for
   * any reason, leaves the page as the adapter found it (the reader's CONTRACT §5): the engine is stopped as far as it
   * got, the block is gone and every page is back, and the error is thrown on.
   */
  const startEngine = (): {readonly engine: PageFlipEngine; readonly render: EngineRender; readonly settings: EngineSettings} => {
    let made: PageFlipEngine | null = null;
    try {
      const single = layout === 'single';
      const engine = new options.engine(block, {
        startPage: page - 1,
        size: 'stretch',
        width: options.pageWidth,
        height: options.pageHeight,
        // The engine turns portrait when the block is narrower than 2 × minWidth. At start-up that
        // is the width the block has; afterwards pinLayout() moves it out of reach (see below).
        minWidth: single ? Math.floor(block.clientWidth / 2) + 1 : 1,
        maxWidth: Number.MAX_SAFE_INTEGER,
        minHeight: 1,
        maxHeight: Number.MAX_SAFE_INTEGER,
        drawShadow: true,
        flippingTime: options.flippingTime ?? 600,
        usePortrait: single,
        startZIndex: 0,
        autoSize: false,
        maxShadowOpacity: 1,
        showCover: true,
        mobileScrollSupport: true,
        clickEventForward: true,
        // Also what makes the engine's destroy() remove its window resize listener.
        useMouseEvents: true,
        swipeDistance: SWIPE.minDistance,
        // Nothing is drawn at rest (UX §06): no corner folds on hover.
        showPageCorners: false,
        // A click turns the page; the adapter lets a press reach the engine only in an edge zone (see onPress).
        // true would also refuse the engine's own flipPrev() and, often, flipNext().
        disableFlipByClick: false,
      });
      made = engine;

      engine.on('flip', (event) => {
        if (destroyed || programmatic > 0) {
          return;
        }
        // A turn the engine completed: a gesture, or a curl the adapter asked for.
        const index = typeof event.data === 'number' ? event.data : Number.NaN;
        const cause = pendingCause ?? 'gesture';
        pendingCause = null;
        settle(clampPage(index + 1, total), cause);
      });

      withoutEngineLoop(() => {
        programmatic += 1;
        try {
          engine.loadFromHTML([...pages]);
        } finally {
          programmatic -= 1;
        }
      });
      // The engine wrote its start-up minimum sizes onto the block; the reader's stage decides its size.
      block.style.minWidth = '';
      block.style.minHeight = '';
      return {engine, render: engine.getRender(), settings: engine.getSettings()};
    } catch (error) {
      destroyed = true;
      if (made !== null) {
        abandonEngine(made);
      }
      block.remove();
      restorePages();
      throw error;
    }
  };

  const {engine, render, settings} = startEngine();
  const pinLayout = (): void => {
    // The live settings object: portrait for one page whatever the width, landscape for a spread.
    settings.usePortrait = layout === 'single';
    settings.minWidth = layout === 'single' ? Number.MAX_SAFE_INTEGER : 1;
  };
  pinLayout();

  const draw = (): void => {
    // performance.now() and requestAnimationFrame's timestamps share the document's time origin.
    clock = Math.max(clock, performance.now());
    render.render(clock);
  };

  const tick = (timestamp: number): void => {
    frame = 0;
    if (destroyed) {
      return;
    }
    clock = Math.max(clock, timestamp);
    render.render(clock);
    // A reader may destroy the adapter from onChange, inside this frame.
    if (!destroyed) {
      frame = window.requestAnimationFrame(tick);
    }
  };

  /** A curl in progress ends at once, and its flip event settles the page. */
  const finishTurn = (): void => {
    if (engine.getState() === 'flipping') {
      render.finishAnimation();
      draw();
    }
  };

  const show = (next: number, cause: ChangeCause): void => {
    programmatic += 1;
    try {
      engine.turnToPage(next - 1);
    } finally {
      programmatic -= 1;
    }
    draw();
    settle(next, cause);
  };

  const turn = (direction: 'next' | 'previous', cause: ChangeCause): void => {
    if (destroyed || engine.getState() === 'user_fold') {
      // A drag in progress keeps the page it holds.
      return;
    }
    finishTurn();
    if (destroyed) {
      return;
    }
    const target = direction === 'next' ? nextPage(page, total, layout) : previousPage(page, total, layout);
    if (target === null) {
      return;
    }
    if (instant) {
      show(target, cause);
      return;
    }
    pendingCause = cause;
    // The engine stamps the curl's start with its clock, which otherwise reads the last frame's time: after a
    // task longer than a turn, the first frame would take the curl for over (DEP05 spike test 11).
    draw();
    if (direction === 'next') {
      engine.flipNext('top');
    } else {
      engine.flipPrev('top');
    }
    if (engine.getState() !== 'flipping') {
      pendingCause = null;
    }
  };

  let measured = sizeKey();
  const resize = (): void => {
    // The ResizeObserver's first notice, and a resize event that changes nothing here, must not end a curl.
    if (destroyed || sizeKey() === measured) {
      return;
    }
    measured = sizeKey();
    finishTurn();
    if (destroyed) {
      return;
    }
    const next = measure();
    const changed = next !== layout;
    layout = next;
    programmatic += 1;
    try {
      pinLayout();
      engine.update();
      // After a change of orientation the engine shows the spread of its own index; show the logical page again.
      engine.turnToPage(page - 1);
    } finally {
      programmatic -= 1;
    }
    draw();
    if (changed) {
      notify('resize');
    }
  };

  // Presses: which ones the engine may see, and the adapter's own swipe and edge-zone click for the rest.
  // The mouse events and click a browser derives from a tap the adapter turned on (TAP_ECHO_MS).
  const isTapEcho = (event: MouseEvent): boolean =>
    touchTurn !== null &&
    event.timeStamp - touchTurn.time <= TAP_ECHO_MS &&
    Math.hypot(event.clientX - touchTurn.x, event.clientY - touchTurn.y) <= TAP_ECHO_RADIUS;

  const onPress = (event: MouseEvent | TouchEvent): void => {
    if (!('touches' in event) && isTapEcho(event)) {
      // Neither the adapter nor the engine takes the echo of a tap already turned on.
      event.stopPropagation();
      event.preventDefault();
      swipe = null;
      return;
    }
    const touches = 'touches' in event ? event.touches : null;
    const point = touches === null ? (event as MouseEvent) : touches.item(0);
    const target = event.target instanceof Element ? event.target : null;
    const control = target?.closest(interactive) ?? null;
    const onControl = control !== null && block.contains(control);
    const multiple = touches !== null && touches.length > 1;
    const primary = touches !== null || (event as MouseEvent).button === 0;
    const blocked = point === null || hasSelection() || multiple || pinchZoomed() || !primary;
    const area = block.getBoundingClientRect();
    const zone = point === null ? null : edgeZone(point.clientX - area.left, area.width, zoneShare);
    const engineTakes = inputEnabled && !instant && !onControl && !blocked && zone !== null;
    if (engineTakes) {
      swipe = null;
      return;
    }
    event.stopPropagation();
    if (!inputEnabled || blocked || point === null) {
      swipe = null;
      return;
    }
    if (touches === null && !onControl) {
      // As the engine does for its own presses: no native drag of the page image, no selection.
      event.preventDefault();
    }
    swipe = {x: point.clientX, y: point.clientY, touch: point instanceof MouseEvent ? null : point.identifier, zone: onControl ? null : zone};
  };

  /** Ends a press the adapter took; true when it turned the page. */
  const endSwipe = (x: number, y: number): boolean => {
    const start = swipe;
    swipe = null;
    if (start === null || destroyed || !inputEnabled) {
      return false;
    }
    const direction = swipeDirection(x - start.x, y - start.y);
    if (direction !== null) {
      turn(direction, 'gesture');
      return true;
    }
    if (start.zone !== null && Math.hypot(x - start.x, y - start.y) <= CLICK_TOLERANCE) {
      // A click in an edge zone the engine was not there to take: instant mode.
      turn(start.zone, 'gesture');
      return true;
    }
    return false;
  };

  const onMouseUp = (event: MouseEvent): void => {
    if (swipe !== null && swipe.touch === null) {
      endSwipe(event.clientX, event.clientY);
    }
  };

  const onTouchEnd = (event: TouchEvent): void => {
    if (swipe === null || swipe.touch === null) {
      return;
    }
    const id = swipe.touch;
    const lifted = Array.from(event.changedTouches).find((touch) => touch.identifier === id);
    if (lifted !== undefined && endSwipe(lifted.clientX, lifted.clientY)) {
      // A tap the adapter turned on is done: cancelling its touchend tells the browser to send no mouse events
      // and no click after it, which would turn again or press a control on the page just shown.
      touchTurn = {x: lifted.clientX, y: lifted.clientY, time: event.timeStamp};
      if (event.cancelable) {
        event.preventDefault();
      }
    }
  };

  const onClick = (event: MouseEvent): void => {
    if (isTapEcho(event)) {
      event.stopPropagation();
      event.preventDefault();
    }
  };

  const onTouchStartAnywhere = (event: TouchEvent): void => {
    // A second finger makes it a pinch, not a swipe.
    if (event.touches.length > 1) {
      swipe = null;
    }
  };

  // A copy of a page the engine shows during a portrait turn (HTMLPage.newTemporaryCopy) is a
  // picture of the page, not a second set of its controls and ids.
  const hideCopies = (mutations: MutationRecord[]): void => {
    for (const mutation of mutations) {
      for (const node of Array.from(mutation.addedNodes)) {
        if (node instanceof HTMLElement && !own.has(node) && node.classList.contains('stf__item')) {
          node.inert = true;
          node.setAttribute('aria-hidden', 'true');
          node.removeAttribute('id');
          for (const named of Array.from(node.querySelectorAll('[id]'))) {
            named.removeAttribute('id');
          }
        }
      }
    }
  };

  const copies = new MutationObserver(hideCopies);
  const stage = block.querySelector('.stf__block');
  if (stage !== null) {
    copies.observe(stage, {childList: true});
  }
  const sizes = new ResizeObserver(() => resize());
  sizes.observe(container);

  block.addEventListener('mousedown', onPress, true);
  block.addEventListener('touchstart', onPress, {capture: true, passive: true});
  window.addEventListener('mouseup', onMouseUp, true);
  // Not passive: the adapter cancels the touchend of a tap it turned on.
  window.addEventListener('touchend', onTouchEnd, {capture: true, passive: false});
  window.addEventListener('click', onClick, true);
  window.addEventListener('touchstart', onTouchStartAnywhere, {capture: true, passive: true});
  window.addEventListener('resize', resize);

  draw();
  frame = window.requestAnimationFrame(tick);

  const destroy = (): void => {
    if (destroyed) {
      return;
    }
    destroyed = true;
    window.cancelAnimationFrame(frame);
    copies.disconnect();
    sizes.disconnect();
    block.removeEventListener('mousedown', onPress, true);
    block.removeEventListener('touchstart', onPress, true);
    window.removeEventListener('mouseup', onMouseUp, true);
    window.removeEventListener('touchend', onTouchEnd, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('touchstart', onTouchStartAnywhere, true);
    window.removeEventListener('resize', resize);
    engine.off('flip');
    // Whatever the engine still runs later, its start-up timer included, then finds nothing to show or restyle.
    render.setLeftPage(null);
    render.setRightPage(null);
    render.setBottomPage(null);
    render.setFlippingPage(null);
    engine.getPageCollection().destroy();
    restorePages();
    // Removes the engine's listeners, its wrapper, its shadows and the block.
    engine.destroy();
  };

  return {
    total,
    get page() {
      return page;
    },
    get layout() {
      return layout;
    },
    get visible() {
      return spreadOf(page, total, layout);
    },
    get instant() {
      return instant;
    },
    turnTo(target: number): void {
      if (destroyed || engine.getState() === 'user_fold') {
        return;
      }
      finishTurn();
      if (!destroyed) {
        show(clampPage(target, total), 'api');
      }
    },
    next(): void {
      turn('next', 'api');
    },
    previous(): void {
      turn('previous', 'api');
    },
    resize,
    setInstant(value: boolean): void {
      if (destroyed) {
        return;
      }
      instant = value;
      if (instant) {
        finishTurn();
      }
    },
    setInput(enabled: boolean): void {
      inputEnabled = enabled;
      if (!enabled) {
        swipe = null;
      }
    },
    destroy,
  };
}
