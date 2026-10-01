/**
 * Papeleria deck client (M1.6).
 *
 * A port of the kit's theme/js/slides.js that adds swipe, title focus and
 * localized strings. scripts/bundle-clients.mjs inlines deck-logic.ts and
 * emits one classic script, lib/clients/deck.js, that fetches and imports
 * nothing at run time. CONTRACT.md beside this file specifies the DOM and
 * data it relies on; D50–D54 record the choices behind it.
 *
 * Every visible word comes from the page's strings block. Nothing animates:
 * slides swap through the `hidden` attribute, and every scroll this script
 * makes is instant even though site.css asks the page for smooth scrolling.
 */
import {
  allShownLine,
  classifySwipe,
  clampSlide,
  formatString,
  keyAction,
  normalizeText,
  parseFragment,
  readDeckStrings,
  slideFragment,
  type DeckStrings,
  type KeyAction,
  type PapeleriaDeck,
  type SlideChangeCause,
  type SlideChangeDetail,
} from './deck-logic.js';

declare global {
  interface Window {
    papeleriaDeck?: PapeleriaDeck;
  }
}

type Controls = {
  readonly previous: HTMLButtonElement;
  readonly next: HTMLButtonElement;
  readonly showAll: HTMLButtonElement;
  readonly notes: HTMLButtonElement;
  readonly fullscreen: HTMLButtonElement;
  readonly print: HTMLButtonElement;
  readonly status: HTMLElement;
};

type Slide = {readonly article: HTMLElement; readonly title: HTMLElement};

/**
 * Where an address fragment leads: the slide to show, the address to write
 * (null leaves the address as it is) and, for a fragment naming an element
 * inside a slide, that element.
 */
type Destination = {readonly index: number; readonly address: string | null; readonly target: Element | null};

/** One finger on a slide canvas, from touchstart until it lifts. */
type Gesture = {
  readonly id: number;
  readonly slide: number;
  readonly startX: number;
  readonly startY: number;
  lastX: number;
  lastY: number;
};

const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

function findButton(id: string): HTMLButtonElement | null {
  const element = document.getElementById(id);
  return element instanceof HTMLButtonElement ? element : null;
}

function findControls(): Controls | null {
  const previous = findButton('prev-slide');
  const next = findButton('next-slide');
  const showAll = findButton('all-slides');
  const notes = findButton('toggle-notes');
  const fullscreen = findButton('full-deck');
  const print = findButton('print-deck');
  const status = document.getElementById('deck-status');
  if (
    previous === null ||
    next === null ||
    showAll === null ||
    notes === null ||
    fullscreen === null ||
    print === null ||
    status === null
  ) {
    return null;
  }
  return {previous, next, showAll, notes, fullscreen, print, status};
}

function findSlides(): Slide[] | null {
  const slides: Slide[] = [];
  for (const article of document.querySelectorAll<HTMLElement>('.deck-slide')) {
    const title = article.querySelector<HTMLElement>('.slide-title');
    if (title === null) {
      return null;
    }
    slides.push({article, title});
  }
  return slides.length > 0 ? slides : null;
}

function readStringsBlock(): DeckStrings | null {
  const block = document.getElementById('papeleria-strings');
  if (!(block instanceof HTMLScriptElement) || block.type.trim().toLowerCase() !== 'application/json') {
    return null;
  }
  return readDeckStrings(block.textContent ?? '');
}

/** The text a title reads as; a line break counts as a space (D54). */
function spokenText(node: Node): string {
  let text = '';
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      text += child.nodeValue ?? '';
    } else if (child instanceof HTMLBRElement) {
      text += ' ';
    } else if (child instanceof Element && child.getAttribute('aria-hidden') !== 'true') {
      text += spokenText(child);
    }
  }
  return text;
}

function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) {
    element.textContent = text;
  }
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return (target instanceof HTMLElement && target.isContentEditable) || target.closest(EDITABLE) !== null;
}

/**
 * Whether an element sits inside something that scrolls on its own within a
 * slide, such as a wide table region. Arrows and swipes there belong to that
 * region, not to the deck (D53).
 */
function inScrollRegion(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  const slide = target.closest('.deck-slide');
  if (slide === null) {
    return false;
  }
  for (let element: Element | null = target; element !== null && element !== slide; element = element.parentElement) {
    const style = getComputedStyle(element);
    const scrollsX = /auto|scroll|overlay/.test(style.overflowX) && element.scrollWidth > element.clientWidth;
    const scrollsY = /auto|scroll|overlay/.test(style.overflowY) && element.scrollHeight > element.clientHeight;
    if (scrollsX || scrollsY) {
      return true;
    }
  }
  return false;
}

function hasSelection(): boolean {
  const selection = window.getSelection();
  return selection !== null && selection.rangeCount > 0 && !selection.isCollapsed;
}

/** A pinch-zoomed page pans under a horizontal drag; that is not a swipe. */
function isPinchZoomed(): boolean {
  const viewport = window.visualViewport;
  return viewport !== null && viewport.scale > 1.01;
}

function findTouch(list: TouchList, id: number): Touch | null {
  for (let position = 0; position < list.length; position += 1) {
    const touch = list[position];
    if (touch !== undefined && touch.identifier === id) {
      return touch;
    }
  }
  return null;
}

/**
 * Runs a scroll at once. site.css sets `html{scroll-behavior:smooth}`, so a
 * plain scrollIntoView or scrollTo would animate; overriding the property for
 * the duration of the call keeps it instant in every engine, including those
 * without the "instant" behavior keyword.
 */
function instantly(scroll: () => void): void {
  const root = document.documentElement;
  const hadStyle = root.hasAttribute('style');
  const previous = root.style.getPropertyValue('scroll-behavior');
  const priority = root.style.getPropertyPriority('scroll-behavior');
  root.style.setProperty('scroll-behavior', 'auto', 'important');
  // Reading the computed value makes the engine apply the override now, not at
  // its next style pass, which could come after the scroll has started.
  void getComputedStyle(root).scrollBehavior;
  scroll();
  if (previous === '') {
    root.style.removeProperty('scroll-behavior');
  } else {
    root.style.setProperty('scroll-behavior', previous, priority);
  }
  // Engines write inline style back to the attribute lazily; reading it settles
  // that first, so an attribute this function created is removed for good
  // rather than reappearing later as style="".
  if (!hadStyle && root.getAttribute('style') === '') {
    root.removeAttribute('style');
  }
}

/** Brings an element to the top of the viewport at once. */
function scrollInstantly(element: Element): void {
  instantly(() => element.scrollIntoView({block: 'start'}));
}

/** Enhances a deck whose slides, strings and controls have all been found. */
function createDeck(slides: readonly Slide[], strings: DeckStrings, controls: Controls): PapeleriaDeck {
  const total = slides.length;
  const body = document.body;

  let index = 0;
  let allShown = false;
  let notesShown = false;
  let gesture: Gesture | null = null;
  // Counts position holds, so that a newer one retires any still running.
  let holds = 0;

  function render(): void {
    slides.forEach((slide, position) => {
      slide.article.hidden = !allShown && position !== index;
    });
    body.classList.toggle('show-slide-notes', notesShown);
    controls.previous.disabled = index === 0;
    controls.next.disabled = index === total - 1;
    controls.showAll.setAttribute('aria-pressed', String(allShown));
    setText(controls.showAll, allShown ? strings.show_one : strings.show_all);
    controls.notes.setAttribute('aria-pressed', String(notesShown));
    setText(controls.notes, notesShown ? strings.hide_notes : strings.show_notes);
    setText(
      controls.status,
      allShown
        ? allShownLine(strings, total)
        : formatString(strings.slide_of, {
            n: index + 1,
            total,
            title: normalizeText(spokenText(slides[index].title)),
          }),
    );
  }

  function writeAddress(address: string): void {
    if (location.hash === address) {
      return;
    }
    try {
      history.replaceState(history.state, '', address);
    } catch {
      // A browser may refuse to rewrite the address of a file:// page. The
      // slide has already changed; only the address stays behind.
    }
  }

  /**
   * Corrects the address the deck was opened with once the page has loaded.
   * Chromium and WebKit scroll to the fragment in the address as it stands
   * when parsing ends, after this script has started; corrected any earlier,
   * the address would name a slide and the page would glide down to it,
   * where a link that names nothing should fall back quietly (IC07, UX C5).
   * WebKit runs this script without waiting for stylesheets, and when parsing
   * ends with one still loading it scrolls in a task queued as the last one
   * arrives, reading the address as it stands then; with nothing else to
   * load, the load event comes before that task. A timer set at load runs
   * after it, so the correction is written from one (D165).
   */
  function correctOnceLoaded(address: string): void {
    const opened = location.hash;
    const correct = (): void => {
      // A reader who has moved on in the meantime has rewritten it already.
      if (location.hash === opened) {
        writeAddress(address);
      }
    };
    const correctSoon = (): void => {
      window.setTimeout(correct, 0);
    };
    if (document.readyState === 'complete') {
      correctSoon();
    } else {
      window.addEventListener('load', correctSoon, {once: true});
    }
  }

  /**
   * Shows a slide. At either end, or when the slide is already shown, nothing
   * happens (UX §05) apart from writing an explicitly requested address, which
   * is how an out-of-range fragment is corrected. Returns whether the slide
   * changed.
   */
  function show(
    target: number,
    cause: SlideChangeCause,
    options: {readonly focus: boolean; readonly address?: string | null},
  ): boolean {
    const next = Math.min(Math.max(target, 0), total - 1);
    if (next === index) {
      if (options.address !== undefined && options.address !== null) {
        writeAddress(options.address);
      }
      return false;
    }
    const previous = index;
    index = next;
    render();
    const address = options.address === undefined ? slideFragment(index + 1) : options.address;
    if (address !== null) {
      writeAddress(address);
    }
    const slide = slides[index];
    if (allShown) {
      scrollInstantly(slide.article);
    }
    if (options.focus) {
      slide.title.focus({preventScroll: true});
    }
    const detail: SlideChangeDetail = {
      slide: index + 1,
      previous: previous + 1,
      total,
      showAll: allShown,
      notes: notesShown,
      cause,
    };
    document.dispatchEvent(new CustomEvent<SlideChangeDetail>('slidechange', {detail}));
    return true;
  }

  /** The slide an action asks for, counted from slide `from` and not clamped. */
  function targetOf(action: KeyAction, from: number): number {
    return action === 'first' ? 0 : action === 'last' ? total - 1 : from + (action === 'next' ? 1 : -1);
  }

  function perform(action: KeyAction, cause: SlideChangeCause): void {
    show(targetOf(action, index), cause, {focus: true});
  }

  /**
   * The slide a reader of the stacked view is looking at: the last one whose
   * top edge has reached the upper third of the viewport, or the first while
   * the page header still fills that third (D53).
   */
  function slideInView(): number {
    const line = window.innerHeight / 3;
    let found = 0;
    for (let position = 1; position < total; position += 1) {
      if (slides[position].article.getBoundingClientRect().top > line) {
        break;
      }
      found = position;
    }
    return found;
  }

  /**
   * Moves to a slide a reader asked for. In the stacked view they may be
   * looking at a slide other than the current one, and the slide they asked
   * for can be the current one already; it still comes to them (D53).
   */
  function go(target: number, cause: SlideChangeCause): void {
    if (!show(target, cause, {focus: true}) && allShown) {
      const slide = slides[target];
      scrollInstantly(slide.article);
      slide.title.focus({preventScroll: true});
    }
  }

  /**
   * Keeps the page at (x, y) after an address change has shown a slide that
   * was hidden, since the page must not move on a slide change (CONTRACT.md
   * §5). WebKit scrolls to the newly visible article in a task after its next
   * layout, smoothly since site.css asks for it, and Chromium would too at
   * its next layout had the caller not settled that first; Firefox makes no
   * such scroll. Putting the position back at once on each of the next three
   * frames cancels the scroll whenever it starts, before a frame shows it.
   */
  function holdScroll(x: number, y: number): void {
    holds += 1;
    const hold = holds;
    let frames = 3;
    const restore = (): void => {
      if (hold !== holds || allShown) {
        return;
      }
      instantly(() => window.scrollTo(x, y));
      frames -= 1;
      if (frames > 0) {
        requestAnimationFrame(restore);
      }
    };
    requestAnimationFrame(restore);
  }

  /** Classifies a fragment against this deck's slides (IC07, UX C5, D54). */
  function resolveFragment(hash: string): Destination | null {
    const fragment = parseFragment(hash);
    switch (fragment.kind) {
      case 'none':
        return {index: 0, address: null, target: null};
      case 'slide': {
        const number = clampSlide(fragment.number, total);
        return {index: number - 1, address: slideFragment(number), target: null};
      }
      case 'malformed':
        return {index: 0, address: slideFragment(1), target: null};
      case 'other': {
        const target = document.getElementById(fragment.id);
        if (target === null) {
          return {index: 0, address: slideFragment(1), target: null};
        }
        const owner = slides.findIndex((slide) => slide.article.contains(target));
        // An anchor outside the slides, such as the skip link's #deck-main, is
        // the browser's business.
        return owner < 0 ? null : {index: owner, address: null, target};
      }
    }
  }

  async function toggleFullscreen(): Promise<void> {
    const root = document.documentElement;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (document.fullscreenEnabled && typeof root.requestFullscreen === 'function') {
        await root.requestFullscreen();
      } else {
        setText(controls.status, strings.fullscreen_denied);
      }
    } catch {
      setText(controls.status, strings.fullscreen_denied);
    }
  }

  const initial = resolveFragment(location.hash) ?? {index: 0, address: null, target: null};
  index = initial.index;

  // The first change this script makes to the page (CONTRACT.md). Until this
  // line the no-JS rendering is untouched.
  body.classList.add('deck-enhanced');
  for (const slide of slides) {
    slide.title.setAttribute('tabindex', '-1');
  }
  setText(controls.previous, strings.previous);
  setText(controls.next, strings.next);
  setText(controls.fullscreen, strings.fullscreen);
  setText(controls.print, strings.print);
  render();
  if (initial.address !== null) {
    correctOnceLoaded(initial.address);
  }

  controls.previous.addEventListener('click', () => perform('previous', 'button'));
  controls.next.addEventListener('click', () => perform('next', 'button'));
  controls.showAll.addEventListener('click', () => {
    allShown = !allShown;
    render();
  });
  controls.notes.addEventListener('click', () => {
    notesShown = !notesShown;
    render();
  });
  controls.print.addEventListener('click', () => window.print());
  controls.fullscreen.addEventListener('click', () => {
    void toggleFullscreen();
  });

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.isComposing) {
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }
    const action = keyAction(event.key, allShown);
    if (action === null || isEditable(event.target) || inScrollRegion(event.target)) {
      return;
    }
    // In the stacked view keys count from the slide in view, as swipes count
    // from the slide swiped (D53).
    const target = targetOf(action, allShown ? slideInView() : index);
    if (target < 0 || target >= total || (target === index && !allShown)) {
      // Past either end, or on the slide asked for, the deck does nothing, so
      // the key keeps its browser behaviour.
      return;
    }
    event.preventDefault();
    go(target, 'key');
  });

  window.addEventListener('hashchange', () => {
    const destination = resolveFragment(location.hash);
    if (destination === null) {
      // An anchor outside the slides, such as the skip link's #deck-main. The
      // browser has taken it in: its scroll and the focus starting point are
      // bound to that element now. Naming the slide shown in the address again
      // moves neither, and keeps a reload or a shared link on it (D54).
      writeAddress(slideFragment(index + 1));
      return;
    }
    // Read while the slide is still hidden: the layout this forces is where
    // Chromium settles the scroll to the fragment, which then finds nothing.
    const x = window.scrollX;
    const y = window.scrollY;
    const changed = show(destination.index, 'hash', {focus: true, address: destination.address});
    if (changed && destination.target !== null) {
      // The browser tried to scroll to this anchor while its slide was hidden.
      scrollInstantly(destination.target);
    } else if (changed && !allShown) {
      holdScroll(x, y);
    }
  });

  document.addEventListener(
    'touchstart',
    (event) => {
      gesture = null;
      // A second finger means a pinch or a zoom, never a swipe.
      if (event.touches.length !== 1) {
        return;
      }
      const touch = event.touches[0];
      const target = event.target;
      if (touch === undefined || !(target instanceof Element)) {
        return;
      }
      const canvas = target.closest('.slide-canvas');
      const slide = canvas === null ? -1 : slides.findIndex((candidate) => candidate.article.contains(canvas));
      if (slide < 0 || hasSelection() || isEditable(target) || inScrollRegion(target) || isPinchZoomed()) {
        return;
      }
      gesture = {
        id: touch.identifier,
        slide,
        startX: touch.clientX,
        startY: touch.clientY,
        lastX: touch.clientX,
        lastY: touch.clientY,
      };
    },
    {passive: true},
  );

  document.addEventListener(
    'touchmove',
    (event) => {
      if (gesture === null) {
        return;
      }
      const touch = event.touches.length === 1 ? findTouch(event.touches, gesture.id) : null;
      if (touch === null) {
        gesture = null;
        return;
      }
      gesture.lastX = touch.clientX;
      gesture.lastY = touch.clientY;
    },
    {passive: true},
  );

  document.addEventListener(
    'touchend',
    (event) => {
      const ended = gesture;
      gesture = null;
      if (ended === null) {
        return;
      }
      const touch = findTouch(event.changedTouches, ended.id);
      const endX = touch === null ? ended.lastX : touch.clientX;
      const endY = touch === null ? ended.lastY : touch.clientY;
      // A finger that finished with text selected was selecting, not swiping.
      if (hasSelection()) {
        return;
      }
      const direction = classifySwipe(endX - ended.startX, endY - ended.startY);
      if (direction === null) {
        return;
      }
      const target = ended.slide + (direction === 'next' ? 1 : -1);
      if (target < 0 || target >= total) {
        // Past either end nothing happens, as with a key (UX §05).
        return;
      }
      go(target, 'swipe');
    },
    {passive: true},
  );

  document.addEventListener(
    'touchcancel',
    () => {
      gesture = null;
    },
    {passive: true},
  );

  return Object.freeze({
    version: 1 as const,
    get total(): number {
      return total;
    },
    get current(): number {
      return index + 1;
    },
    get showAll(): boolean {
      return allShown;
    },
    get notes(): boolean {
      return notesShown;
    },
    goTo(slide: number, options?: {readonly focus?: boolean}): number {
      if (typeof slide === 'number' && !Number.isNaN(slide)) {
        show(clampSlide(Math.trunc(slide), total) - 1, 'api', {focus: options?.focus === true});
      }
      return index + 1;
    },
  });
}

function start(): void {
  if (window.papeleriaDeck !== undefined) {
    // Already enhanced, for example because the script was included twice.
    return;
  }
  const slides = findSlides();
  const strings = readStringsBlock();
  const controls = findControls();
  if (slides === null || strings === null || controls === null) {
    // Without its slides, strings or controls the deck stays exactly as
    // published: every slide and note readable, the no-JS status in place.
    return;
  }
  window.papeleriaDeck = createDeck(slides, strings, controls);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, {once: true});
} else {
  start();
}
