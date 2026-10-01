/**
 * Papeleria comic reader (M4.3).
 *
 * `scripts/bundle-clients.mjs` writes `lib/clients/reader.js` as one classic
 * script: the page-turn engine's pinned bytes, unchanged, then this file,
 * `reader-logic.ts` and the adapter bundled by esbuild (D109). The engine
 * defines the global `St` as it runs; the reader hands `St.PageFlip` to the
 * adapter (D103), which alone talks to the engine. CONTRACT.md beside this
 * file is the DOM the renderer writes and the hook the preview bridge uses;
 * D110–D115 record the choices below.
 *
 * - The address is the only state (ERD §12): `#page-N` in page view,
 *   `#page-N-panel-M` in guided view, written with `replaceState`.
 * - Page view: the adapter's book, the cover alone, then pairs, one page at a
 *   time where IC07 fits no spread. Previous, Next, ← →, Home, End, the
 *   engine's swipe and edge drag, a click in the edge zones.
 * - Guided view: the page image, panned and zoomed to the panel's box and 4%
 *   around it, step by step in reading order; instant always.
 * - A panel opens its detail in a modal dialog, or announces its transcript;
 *   a link detail is the panel itself, a link.
 * - Reduced motion: the adapter's instant mode, followed live; nothing here
 *   animates, and the kit stops every transition.
 * - Only the pages near the one shown keep their images once the reader has
 *   started; print gets the page as it reads without JavaScript.
 *
 * Every visible word comes from the page's strings block or the author's
 * text. Nothing is asked and nothing is stored.
 */
import {create, spreadOf, swipeDirection, nextPage, previousPage, type AdapterState, type EngineAdapter, type Layout, type PageFlipConstructor} from './engine-adapter.js';
import {
  clampIndex,
  containPlacement,
  fitBox,
  formatString,
  guidedSteps,
  guidedZone,
  hintLine,
  keptPages,
  lensPlacement,
  panelFragment,
  pageFragment,
  panPlacement,
  parseReaderFragment,
  readerKey,
  readReaderStrings,
  statusLine,
  stepIndex,
  zoomPlacement,
  type Box,
  type GuidedStep,
  type PageChangeCause,
  type PageChangeDetail,
  type PapeleriaReader,
  type Placement,
  type ReaderStrings,
  type ReaderView,
  type Size,
} from './reader-logic.js';

declare global {
  interface Window {
    papeleriaReader?: PapeleriaReader;
    /** Set by the vendored engine, which runs first in the same script (D109). */
    St?: {readonly PageFlip: PageFlipConstructor};
  }
}

type DetailKind = 'none' | 'zoom' | 'text' | 'image' | 'link';

type Panel = {
  readonly element: HTMLElement;
  readonly page: number;
  readonly number: number;
  readonly detail: DetailKind;
  readonly box: Box;
  readonly transcript: string;
};

type Page = {
  readonly number: number;
  readonly sheet: HTMLElement;
  readonly figure: HTMLElement;
  readonly art: HTMLElement;
  readonly image: HTMLImageElement;
  readonly sources: readonly HTMLSourceElement[];
  /** The art's pixel size, from the image's width and height: its aspect ratio. */
  readonly size: Size;
  readonly panels: readonly Panel[];
};

type Controls = {
  readonly previous: HTMLButtonElement;
  readonly next: HTMLButtonElement;
  readonly guided: HTMLButtonElement;
  readonly detail: HTMLButtonElement;
  readonly transcript: HTMLButtonElement;
  readonly fullscreen: HTMLButtonElement;
  readonly status: HTMLElement;
};

/** Where an address leads: a view at a page (and panel), and the address to write, or null to leave it. */
type Destination = {readonly view: ReaderView; readonly page: number; readonly panel: number | null; readonly address: string | null};

const DETAIL_KINDS: readonly DetailKind[] = ['none', 'zoom', 'text', 'image', 'link'];
const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
/** The book never gets less room than this, so a very short window still shows a page. */
const MIN_BOOK_HEIGHT = 240;
/** Space kept under the book, in CSS pixels. */
const BOOK_GAP = 8;
/** Two taps this close in time and place are a double tap on the zoom surface. */
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_RADIUS = 25;
/** The attributes an image's released `src` and `srcset` are kept in, to be put back (D114). */
const KEPT_SRC = 'data-papeleria-src';
const KEPT_SRCSET = 'data-papeleria-srcset';

// ---------------------------------------------------------------------------
// Finding the page

function findButton(id: string): HTMLButtonElement | null {
  const element = document.getElementById(id);
  return element instanceof HTMLButtonElement ? element : null;
}

function findControls(): Controls | null {
  const previous = findButton('comic-previous');
  const next = findButton('comic-next');
  const guided = findButton('comic-guided');
  const detail = findButton('comic-detail');
  const transcript = findButton('comic-transcript-toggle');
  const fullscreen = findButton('comic-fullscreen');
  const status = document.getElementById('comic-status');
  if (previous === null || next === null || guided === null || detail === null || transcript === null || fullscreen === null || status === null) {
    return null;
  }
  return {previous, next, guided, detail, transcript, fullscreen, status};
}

function readBox(value: string | undefined): Box | null {
  const numbers = (value ?? '').trim().split(/\s+/).map(Number);
  if (numbers.length !== 4 || !numbers.every(Number.isFinite)) {
    return null;
  }
  return [numbers[0]!, numbers[1]!, numbers[2]!, numbers[3]!];
}

function findPanels(art: HTMLElement, page: number): Panel[] | null {
  const panels: Panel[] = [];
  for (const element of Array.from(art.querySelectorAll<HTMLElement>(':scope > .comic-panel'))) {
    const number = Number(element.dataset['panel']);
    const detail = element.dataset['detail'] as DetailKind | undefined;
    const box = readBox(element.dataset['box']);
    const transcript = element.querySelector('.comic-panel-label')?.textContent ?? '';
    if (Number(element.dataset['page']) !== page || number !== panels.length + 1 || detail === undefined || !DETAIL_KINDS.includes(detail) || box === null) {
      return null;
    }
    panels.push({element, page, number, detail, box, transcript});
  }
  return panels;
}

function findPages(main: HTMLElement): Page[] | null {
  const pages: Page[] = [];
  for (const sheet of Array.from(main.querySelectorAll<HTMLElement>(':scope > article.comic-sheet'))) {
    const number = pages.length + 1;
    const figure = sheet.querySelector<HTMLElement>(':scope > figure.comic-figure');
    const art = figure?.querySelector<HTMLElement>(':scope > .comic-art') ?? null;
    const image = art?.querySelector('img') ?? null;
    if (sheet.id !== pageFragment(number).slice(1) || figure === null || art === null || !(image instanceof HTMLImageElement)) {
      return null;
    }
    const width = Number(image.getAttribute('width'));
    const height = Number(image.getAttribute('height'));
    const panels = findPanels(art, number);
    if (!(width > 0 && height > 0) || panels === null) {
      return null;
    }
    const sources = Array.from(art.querySelectorAll<HTMLSourceElement>('picture > source'));
    pages.push({number, sheet, figure, art, image, sources, size: {width, height}, panels});
  }
  return pages.length > 0 ? pages : null;
}

function readStringsBlock(): ReaderStrings | null {
  const block = document.getElementById('papeleria-strings');
  if (!(block instanceof HTMLScriptElement) || block.type.trim().toLowerCase() !== 'application/json') {
    return null;
  }
  return readReaderStrings(block.textContent ?? '');
}

// ---------------------------------------------------------------------------
// Small helpers

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, attributes: Readonly<Record<string, string>> = {}): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag);
  made.className = className;
  for (const [name, value] of Object.entries(attributes)) {
    made.setAttribute(name, value);
  }
  return made;
}

function setText(target: HTMLElement, text: string): void {
  if (target.textContent !== text) {
    target.textContent = text;
  }
}

function isEditable(target: EventTarget | null): boolean {
  return target instanceof Element && ((target instanceof HTMLElement && target.isContentEditable) || target.closest(EDITABLE) !== null);
}

function isRendered(target: Element): boolean {
  return target.getClientRects().length > 0;
}

/** Runs a scroll at once: `site.css` asks for smooth scrolling on `<html>` (as the deck client does, D164(j)). */
function instantly(scroll: () => void): void {
  const root = document.documentElement;
  const hadStyle = root.hasAttribute('style');
  const previous = root.style.getPropertyValue('scroll-behavior');
  const priority = root.style.getPropertyPriority('scroll-behavior');
  root.style.setProperty('scroll-behavior', 'auto', 'important');
  void getComputedStyle(root).scrollBehavior;
  scroll();
  if (previous === '') {
    root.style.removeProperty('scroll-behavior');
  } else {
    root.style.setProperty('scroll-behavior', previous, priority);
  }
  if (!hadStyle && root.getAttribute('style') === '') {
    root.removeAttribute('style');
  }
}

function place(target: HTMLElement, placement: Placement): void {
  target.style.width = `${placement.width}px`;
  target.style.height = `${placement.height}px`;
  target.style.transform = `translate(${placement.left}px, ${placement.top}px)`;
}

/**
 * Takes away the style the reader wrote on an element the renderer writes none on. Written first, as the adapter does
 * (D103): Blink serializes an attribute left unsynchronized by a CSSOM write as style="".
 */
function dropStyle(target: HTMLElement): void {
  target.setAttribute('style', '');
  target.removeAttribute('style');
}

/**
 * Reports an error the reader met and survived, in the console and to the page's error listeners, once the code that
 * met it has finished: what runs after the reader in the same script, such as the preview's bridge, still runs.
 */
function reportLater(error: unknown): void {
  window.setTimeout(() => {
    throw error;
  }, 0);
}

/** A heading and the one standing in for it, a level higher, while its detail is in the dialog. */
type Raised = readonly [heading: HTMLElement, higher: HTMLElement];

/**
 * A text detail's headings start at h4 in the page, under the sheet's h2 and the transcript's h3 (D105); moved under
 * the dialog's h2 they would skip a level, so each stands in there for one a level higher, with its attributes and
 * what it holds (W5R-19). `lowerHeadings` puts the page's own back.
 */
function raiseHeadings(detail: HTMLElement): Raised[] {
  const raised: Raised[] = [];
  for (const heading of Array.from(detail.querySelectorAll<HTMLElement>('h4, h5, h6'))) {
    const higher = document.createElement(`h${Number(heading.localName.slice(1)) - 1}`);
    for (const attribute of Array.from(heading.attributes)) {
      higher.setAttribute(attribute.name, attribute.value);
    }
    higher.append(...Array.from(heading.childNodes));
    heading.replaceWith(higher);
    raised.push([heading, higher]);
  }
  return raised;
}

function lowerHeadings(raised: readonly Raised[]): void {
  for (const [heading, higher] of raised) {
    heading.append(...Array.from(higher.childNodes));
    higher.replaceWith(heading);
  }
}

// ---------------------------------------------------------------------------
// The reader

/** Enhances the comic, or changes nothing and returns null when the book has no room (CONTRACT §5). */
function createReader(book: HTMLElement, pages: readonly Page[], strings: ReaderStrings, controls: Controls, PageFlip: PageFlipConstructor): PapeleriaReader | null {
  const body = document.body;
  const total = pages.length;
  const steps: readonly GuidedStep[] = guidedSteps(pages.map((page) => page.panels.length));
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const printing = window.matchMedia('print');

  let adapter: EngineAdapter | null = null;
  let view: ReaderView = 'page';
  let step = 0;
  let transcriptShown = false;
  let suspended = false;
  // The page the last pagechange named, for the next one's `previous`.
  let reported = 1;
  // A turn the reader asked for and its cause, until the adapter reports its page (a curl reports at its end).
  let expected: {readonly page: number; readonly cause: PageChangeCause} | null = null;
  // While the reader moves the book under guided view, the adapter's change is not a page-view change.
  let guiding = false;
  // Whether focus was last inside the book, so a turn that hides it can put it on the new page.
  let focusInBook = false;
  let detail: OpenDetail | null = null;

  // --- The elements only the enhanced reader has --------------------------

  const hint = element('p', 'comic-hint', {id: 'comic-hint'});
  // Transcripts of panels without a detail are announced here; the status line keeps the place (UX §06).
  const announcer = element('p', 'sr-only', {id: 'comic-announce', role: 'status'});
  const lens = element('div', 'comic-lens', {id: 'comic-lens'});
  const lensArt = element('img', 'comic-lens-art', {alt: '', 'aria-hidden': 'true', draggable: 'false'});
  lens.appendChild(lensArt);
  let lensControl: HTMLElement | null = null;

  const dialog = element('dialog', 'comic-dialog', {id: 'comic-dialog', 'aria-modal': 'true', 'aria-labelledby': 'comic-dialog-title'});
  const dialogBody = element('div', 'comic-dialog-body');
  const dialogHead = element('div', 'comic-dialog-head');
  const dialogTitle = element('h2', 'comic-dialog-title', {id: 'comic-dialog-title'});
  const dialogClose = element('button', 'button secondary comic-dialog-close', {type: 'button', id: 'comic-dialog-close'});
  dialogClose.textContent = strings.close;
  const dialogContent = element('div', 'comic-dialog-content');
  const dialogTranscript = element('p', 'comic-dialog-transcript', {id: 'comic-dialog-transcript'});
  dialogHead.append(dialogTitle, dialogClose);
  dialogBody.append(dialogHead, dialogContent, dialogTranscript);
  dialog.appendChild(dialogBody);

  // --- The book -------------------------------------------------------------

  // Where the book starts on the page, when it was last sized: the bar above it can gain or lose a line.
  let bookTop = Number.NaN;

  function sizeBook(): void {
    bookTop = book.getBoundingClientRect().top + window.scrollY;
    book.style.height = `${Math.max(MIN_BOOK_HEIGHT, Math.floor(window.innerHeight - bookTop - BOOK_GAP))}px`;
  }

  /** Whether the sized book has room: the adapter builds a book only on a stage with a width and a height (D103). */
  const hasRoom = (): boolean => book.clientWidth > 0 && book.clientHeight > 0;

  // True while the adapter is telling the reader of a change of place. The engine is then still inside its own
  // turn, and a resize would finish that turn a second time: the adapter's resize ends a curl in progress, and a
  // curl that is ending runs its completion again, which turns another page (D132).
  let notified = false;

  /** Sizes the book again when what stands above it has changed height: a longer label, the Detail button, a font arriving. */
  function followBar(): void {
    if (notified) {
      // After the engine's turn has returned, and before the page is painted.
      queueMicrotask(followBar);
      return;
    }
    if (!suspended && adapter !== null && book.getBoundingClientRect().top + window.scrollY !== bookTop) {
      resized();
    }
  }

  /** Fits each page's art, and so its panels, inside the page box the engine gives it, at the art's own proportions. */
  function fitArts(): void {
    const shown = pages.find((page) => page.figure.clientWidth > 0 && page.figure.clientHeight > 0);
    if (shown === undefined) {
      return;
    }
    const frame = {width: shown.figure.clientWidth, height: shown.figure.clientHeight};
    for (const page of pages) {
      const fitted = containPlacement(page.size, frame);
      page.art.style.width = `${fitted.width}px`;
      page.art.style.height = `${fitted.height}px`;
    }
  }

  function makeBook(startPage: number): EngineAdapter {
    const first = pages[0]!;
    return create(
      book,
      pages.map((page) => page.figure),
      {
        engine: PageFlip,
        pageWidth: first.size.width,
        pageHeight: first.size.height,
        startPage,
        instant: motion.matches,
        onChange: (state) => adapterChanged(state),
      },
    );
  }

  const layoutNow = (): Layout => adapter?.layout ?? 'single';
  const pageNow = (): number => adapter?.page ?? 1;
  const visibleNow = (): readonly number[] => adapter?.visible ?? [pageNow()];

  // --- Images near the place shown (D114) ----------------------------------

  /** Puts back what `release` kept aside, and, unless for print, asks for the image now. */
  function keep(page: Page, now = true): void {
    for (const source of page.sources) {
      const kept = source.getAttribute(KEPT_SRCSET);
      if (kept !== null) {
        source.setAttribute('srcset', kept);
        source.removeAttribute(KEPT_SRCSET);
      }
    }
    const srcset = page.image.getAttribute(KEPT_SRCSET);
    if (srcset !== null) {
      page.image.setAttribute('srcset', srcset);
      page.image.removeAttribute(KEPT_SRCSET);
    }
    const src = page.image.getAttribute(KEPT_SRC);
    if (src !== null) {
      page.image.setAttribute('src', src);
      page.image.removeAttribute(KEPT_SRC);
    }
    if (now && page.image.loading === 'lazy') {
      page.image.loading = 'eager';
    }
  }

  function release(page: Page): void {
    for (const source of page.sources) {
      const srcset = source.getAttribute('srcset');
      if (srcset !== null) {
        source.setAttribute(KEPT_SRCSET, srcset);
        source.removeAttribute('srcset');
      }
    }
    const srcset = page.image.getAttribute('srcset');
    if (srcset !== null) {
      page.image.setAttribute(KEPT_SRCSET, srcset);
      page.image.removeAttribute('srcset');
    }
    const src = page.image.getAttribute('src');
    if (src !== null) {
      page.image.setAttribute(KEPT_SRC, src);
      page.image.removeAttribute('src');
    }
  }

  /** Whether a page's image holds its bytes now: it has its source and has loaded it. */
  function loaded(page: Page): boolean {
    return page.image.getAttribute('src') !== null && page.image.complete && page.image.naturalWidth > 0;
  }

  /**
   * The current, previous and next spreads keep their images; the rest let theirs go, keeping their size (UX §06,
   * IC07). Only an image that has loaded lets go: one that never has, lazy and on a hidden page, loads nothing and
   * holds nothing, and a browser loads it for print as it would without the reader (IC08, D114).
   */
  function applyPreload(): void {
    if (adapter === null) {
      return;
    }
    const layout = layoutNow();
    const kept = keptPages(visibleNow(), total, (page) => spreadOf(page, total, layout));
    for (const page of pages) {
      if (kept.has(page.number)) {
        keep(page);
      } else if (loaded(page)) {
        release(page);
      }
    }
  }

  // --- Every page's art asked once, for print (IC08, D115) -----------------

  /**
   * A browser prints what its images hold when it prints: it does not wait for an image the reader asks for on
   * `beforeprint`, and a lazy image the reader kept hidden in the book is one it never saw. So, once the page has
   * loaded and a moment has passed, the reader asks for each page image it has not loaded, one at a time, outside
   * the pages shown; each then lets its source go like any other page outside the window (D114), its bytes in the
   * browser's cache, from which print gets it back at once.
   */
  const asked = new Set<number>();
  function askNext(): void {
    if (suspended || adapter === null) {
      window.setTimeout(askNext, 1000);
      return;
    }
    const layout = layoutNow();
    const kept = keptPages(visibleNow(), total, (number) => spreadOf(number, total, layout));
    const next = pages.find((page) => !asked.has(page.number) && !kept.has(page.number) && page.image.getAttribute('src') !== null && !loaded(page));
    if (next === undefined) {
      return;
    }
    asked.add(next.number);
    const done = (): void => {
      next.image.removeEventListener('load', done);
      next.image.removeEventListener('error', done);
      if (!suspended && adapter !== null) {
        applyPreload();
      }
      window.setTimeout(askNext, 0);
    };
    next.image.addEventListener('load', done);
    next.image.addEventListener('error', done);
    next.image.loading = 'eager';
  }

  // --- What the page says -----------------------------------------------

  function currentStep(): GuidedStep {
    return steps[step] ?? {page: 1, panel: null};
  }

  function panelOfStep(): Panel | null {
    const current = currentStep();
    return current.panel === null ? null : (pages[current.page - 1]?.panels[current.panel - 1] ?? null);
  }

  function address(): string {
    if (view === 'guided') {
      const current = currentStep();
      return current.panel === null ? pageFragment(current.page) : panelFragment(current.page, current.panel);
    }
    return pageFragment(pageNow());
  }

  function writeAddress(hash: string): void {
    if (location.hash === hash) {
      return;
    }
    try {
      history.replaceState(history.state, '', hash);
    } catch {
      // A browser may refuse to rewrite the address of a file:// page; the page has changed all the same.
    }
  }

  function render(): void {
    const guided = view === 'guided';
    const current = currentStep();
    const visible = guided ? [current.page] : visibleNow();
    body.classList.toggle('comic-guided', guided);
    body.classList.toggle('comic-show-transcript', transcriptShown);
    body.classList.toggle('comic-spread', !guided && layoutNow() === 'spread');
    for (const page of pages) {
      page.sheet.hidden = !visible.includes(page.number);
    }
    const panelCount = guided ? (pages[current.page - 1]?.panels.length ?? 0) : visible.reduce((sum, number) => sum + (pages[number - 1]?.panels.length ?? 0), 0);
    setText(
      controls.status,
      guided
        ? statusLine(strings, {kind: 'guided', page: current.page, panel: current.panel, panels: panelCount, total})
        : statusLine(strings, {kind: 'page', visible, total}),
    );
    setText(hint, hintLine(strings, panelCount));
    controls.previous.disabled = guided ? step === 0 : previousPage(pageNow(), total, layoutNow()) === null;
    controls.next.disabled = guided ? step === steps.length - 1 : nextPage(pageNow(), total, layoutNow()) === null;
    setText(controls.guided, guided ? strings.page_view : strings.guided_view);
    const panel = guided ? panelOfStep() : null;
    controls.detail.hidden = panel === null || panel.detail === 'none';
    controls.transcript.setAttribute('aria-pressed', String(transcriptShown));
    followBar();
  }

  function dispatch(cause: PageChangeCause): void {
    const detailOfChange: PageChangeDetail = {
      page: pageNow(),
      previous: reported,
      panel: view === 'guided' ? currentStep().panel : null,
      view,
      layout: layoutNow(),
      visible: view === 'guided' ? [currentStep().page] : [...visibleNow()],
      total,
      cause,
    };
    reported = pageNow();
    document.dispatchEvent(new CustomEvent<PageChangeDetail>('pagechange', {detail: detailOfChange}));
  }

  /** After a turn hides the element that had focus, focus goes to the first panel shown, or the book. */
  function keepFocus(): void {
    const active = document.activeElement;
    const lost = active === null || active === body ? focusInBook : book.contains(active) && !isRendered(active);
    if (!lost) {
      return;
    }
    const visible = visibleNow();
    const first = pages.filter((page) => visible.includes(page.number)).flatMap((page) => page.panels)[0];
    (first?.element ?? book).focus({preventScroll: true});
  }

  /** Everything a change of place in page view updates, once the adapter has made it. */
  function changed(cause: PageChangeCause): void {
    fitArts();
    applyPreload();
    render();
    writeAddress(address());
    keepFocus();
    dispatch(cause);
  }

  function adapterChanged(state: AdapterState): void {
    if (suspended || guiding) {
      return;
    }
    let cause: PageChangeCause = state.cause === 'resize' ? 'resize' : state.cause === 'gesture' ? 'gesture' : 'api';
    if (expected !== null && expected.page === state.page) {
      cause = expected.cause;
    }
    expected = null;
    if (view === 'guided') {
      // A resize while guided: the book behind the lens changed its layout; the lens keeps its panel.
      fitArts();
      placeLens();
      return;
    }
    notified = true;
    try {
      changed(cause);
    } finally {
      notified = false;
    }
  }

  // --- Page view -----------------------------------------------------------

  function turn(direction: 'next' | 'previous', cause: PageChangeCause): void {
    if (adapter === null) {
      return;
    }
    const target = direction === 'next' ? nextPage(pageNow(), total, layoutNow()) : previousPage(pageNow(), total, layoutNow());
    if (target === null) {
      return;
    }
    expected = {page: target, cause};
    if (direction === 'next') {
      adapter.next();
    } else {
      adapter.previous();
    }
  }

  function showPage(page: number, cause: PageChangeCause): void {
    if (adapter === null) {
      return;
    }
    const target = clampIndex(page, total);
    if (target === pageNow()) {
      changed(cause);
      return;
    }
    expected = {page: target, cause};
    adapter.turnTo(target);
  }

  // --- Guided view (D112) ------------------------------------------------------

  function placeLens(): void {
    if (view !== 'guided') {
      return;
    }
    const current = currentStep();
    const page = pages[current.page - 1];
    if (page === undefined) {
      return;
    }
    const frame = {width: lens.clientWidth, height: lens.clientHeight};
    if (!(frame.width > 0 && frame.height > 0)) {
      return;
    }
    const panel = panelOfStep();
    place(lensArt, panel === null ? containPlacement(page.size, frame) : lensPlacement(panel.box, page.size, frame));
  }

  /** The control guided view shows for its step: a copy of the panel, over the whole lens, or the page itself when it has none. */
  function makeLensControl(page: Page, panel: Panel | null): HTMLElement {
    if (panel === null) {
      const whole = element('div', 'comic-lens-page', {tabindex: '-1', role: 'img', 'aria-label': page.image.alt});
      return whole;
    }
    const copy = panel.element.cloneNode(true) as HTMLElement;
    copy.removeAttribute('id');
    copy.removeAttribute('style');
    for (const named of Array.from(copy.querySelectorAll('[id]'))) {
      named.removeAttribute('id');
    }
    copy.className = `comic-lens-panel${panel.element.classList.contains('link-external') ? ' link-external' : ''}`;
    return copy;
  }

  function showStep(index: number, cause: PageChangeCause, focus: boolean): void {
    if (adapter === null) {
      return;
    }
    step = Math.min(Math.max(index, 0), steps.length - 1);
    const current = currentStep();
    const page = pages[current.page - 1]!;
    if (pageNow() !== current.page) {
      guiding = true;
      try {
        adapter.turnTo(current.page);
      } finally {
        guiding = false;
      }
    }
    view = 'guided';
    adapter.setInput(false);
    applyPreload();
    lensArt.src = page.image.currentSrc !== '' ? page.image.currentSrc : (page.image.getAttribute('src') ?? '');
    const control = makeLensControl(page, panelOfStep());
    if (lensControl === null) {
      lens.appendChild(control);
    } else {
      lens.replaceChild(control, lensControl);
    }
    lensControl = control;
    render();
    placeLens();
    writeAddress(address());
    if (focus) {
      control.focus({preventScroll: true});
    }
    dispatch(cause);
  }

  function enterGuided(page: number, panel: number | null, cause: PageChangeCause, focus: boolean): void {
    const target = clampIndex(page, total);
    const count = pages[target - 1]!.panels.length;
    showStep(stepIndex(steps, target, count === 0 || panel === null ? null : clampIndex(panel, count)), cause, focus);
  }

  function leaveGuided(cause: PageChangeCause, focus: boolean): void {
    if (view !== 'guided' || adapter === null) {
      return;
    }
    const panel = panelOfStep();
    view = 'page';
    adapter.setInput(detail === null);
    if (lensControl !== null) {
      lensControl.remove();
      lensControl = null;
    }
    changed(cause);
    if (focus) {
      (panel !== null && isRendered(panel.element) ? panel.element : controls.guided).focus({preventScroll: true});
    }
  }

  // --- Details (D113) ----------------------------------------------------------

  type Zoom = {readonly surface: HTMLElement; readonly image: HTMLImageElement; readonly box: Box; readonly size: Size; view: Placement; minimum: Placement};

  type OpenDetail = {
    readonly panel: Panel;
    readonly from: ReaderView;
    /** A text or image detail moved here from the transcript list, and where it goes back; a text detail's headings raised. */
    readonly moved: {readonly element: HTMLElement; readonly parent: Node; readonly next: Node | null; readonly raised: readonly Raised[]} | null;
    readonly zoom: Zoom | null;
    readonly inerted: readonly HTMLElement[];
  };

  function announce(text: string): void {
    // Emptied first, so the same transcript announced twice is still a change.
    announcer.textContent = '';
    window.setTimeout(() => {
      announcer.textContent = text;
    }, 50);
    setText(hint, text);
  }

  function zoomFrame(zoom: Zoom): Size {
    return {width: zoom.surface.clientWidth, height: zoom.surface.clientHeight};
  }

  function layoutZoom(zoom: Zoom): void {
    const frame = zoomFrame(zoom);
    if (!(frame.width > 0 && frame.height > 0)) {
      return;
    }
    zoom.minimum = fitBox(zoom.box, zoom.size, frame);
    zoom.view = zoom.minimum;
    place(zoom.image, zoom.view);
  }

  function makeZoom(panel: Panel, page: Page): Zoom {
    const surface = element('div', 'comic-zoom', {tabindex: '0', role: 'img', 'aria-labelledby': 'comic-dialog-transcript', 'data-no-turn': ''});
    const image = element('img', 'comic-zoom-art', {alt: '', draggable: 'false'});
    // The original is asked for now, and only now (IC04: never preloaded).
    image.src = panel.element.dataset['zoomSrc'] ?? page.image.currentSrc;
    surface.appendChild(image);
    const zoom: Zoom = {surface, image, box: panel.box, size: page.size, view: {width: 0, height: 0, left: 0, top: 0}, minimum: {width: 0, height: 0, left: 0, top: 0}};
    const pointers = new Map<number, {x: number; y: number}>();
    let pinch: {distance: number} | null = null;
    let lastTap: {time: number; x: number; y: number} | null = null;
    const point = (event: {clientX: number; clientY: number}): {x: number; y: number} => {
      const rect = surface.getBoundingClientRect();
      return {x: event.clientX - rect.left, y: event.clientY - rect.top};
    };
    const set = (next: Placement): void => {
      zoom.view = next;
      place(image, next);
    };
    const toggle = (at: {x: number; y: number}): void => {
      set(zoom.view.width > zoom.minimum.width * 1.5 ? zoom.minimum : zoomPlacement(zoom.view, 2, at, zoom.minimum, zoomFrame(zoom)));
    };
    surface.addEventListener('pointerdown', (event) => {
      surface.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, point(event));
      pinch = null;
    });
    surface.addEventListener('pointermove', (event) => {
      const before = pointers.get(event.pointerId);
      if (before === undefined) {
        return;
      }
      const now = point(event);
      pointers.set(event.pointerId, now);
      if (pointers.size === 1) {
        set(panPlacement(zoom.view, now.x - before.x, now.y - before.y, zoomFrame(zoom)));
        return;
      }
      const [a, b] = [...pointers.values()] as [{x: number; y: number}, {x: number; y: number}];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch !== null && pinch.distance > 0) {
        set(zoomPlacement(zoom.view, distance / pinch.distance, {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2}, zoom.minimum, zoomFrame(zoom)));
      }
      pinch = {distance};
    });
    const lift = (event: PointerEvent): void => {
      const at = pointers.get(event.pointerId);
      pointers.delete(event.pointerId);
      if (pointers.size < 2) {
        pinch = null;
      }
      if (event.type !== 'pointerup' || at === undefined || event.pointerType === 'mouse') {
        return;
      }
      const now = performance.now();
      if (lastTap !== null && now - lastTap.time <= DOUBLE_TAP_MS && Math.hypot(at.x - lastTap.x, at.y - lastTap.y) <= DOUBLE_TAP_RADIUS) {
        lastTap = null;
        toggle(at);
      } else {
        lastTap = {time: now, x: at.x, y: at.y};
      }
    };
    surface.addEventListener('pointerup', lift);
    surface.addEventListener('pointercancel', lift);
    surface.addEventListener('dblclick', (event) => {
      event.preventDefault();
      toggle(point(event));
    });
    surface.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        set(zoomPlacement(zoom.view, Math.exp(-event.deltaY * 0.002), point(event), zoom.minimum, zoomFrame(zoom)));
      },
      {passive: false},
    );
    surface.addEventListener('keydown', (event) => {
      const frame = zoomFrame(zoom);
      const centre = {x: frame.width / 2, y: frame.height / 2};
      const moves: Readonly<Record<string, readonly [number, number]>> = {ArrowLeft: [0.1, 0], ArrowRight: [-0.1, 0], ArrowUp: [0, 0.1], ArrowDown: [0, -0.1]};
      const move = moves[event.key];
      if (move !== undefined) {
        set(panPlacement(zoom.view, move[0] * frame.width, move[1] * frame.height, frame));
      } else if (event.key === '+' || event.key === '=') {
        set(zoomPlacement(zoom.view, 1.25, centre, zoom.minimum, frame));
      } else if (event.key === '-') {
        set(zoomPlacement(zoom.view, 0.8, centre, zoom.minimum, frame));
      } else if (event.key === '0') {
        set(zoom.minimum);
      } else {
        return;
      }
      event.preventDefault();
    });
    image.addEventListener('load', () => layoutZoom(zoom));
    return zoom;
  }

  function openDetail(panel: Panel, from: ReaderView): void {
    if (detail !== null || adapter === null || panel.detail === 'none' || panel.detail === 'link') {
      return;
    }
    const page = pages[panel.page - 1]!;
    setText(dialogTitle, formatString(strings.panel_of, {n: panel.number, total: page.panels.length, page: panel.page}));
    setText(dialogTranscript, panel.transcript);
    // A zoom's art is named by the transcript already: shown under it, it is not read twice.
    if (panel.detail === 'zoom') {
      dialogTranscript.setAttribute('aria-hidden', 'true');
    } else {
      dialogTranscript.removeAttribute('aria-hidden');
    }
    dialogContent.replaceChildren();
    let moved: OpenDetail['moved'] = null;
    let zoom: Zoom | null = null;
    if (panel.detail === 'zoom') {
      zoom = makeZoom(panel, page);
      dialogContent.appendChild(zoom.surface);
    } else {
      const content = document.getElementById(`detail-${panel.page}-${panel.number}`);
      if (content !== null && content.parentNode !== null) {
        moved = {element: content, parent: content.parentNode, next: content.nextSibling, raised: panel.detail === 'text' ? raiseHeadings(content) : []};
        dialogContent.appendChild(content);
      }
    }
    // The page behind is inert, as the modal dialog makes it, and says so to any browser that reads the attribute.
    const inerted = Array.from(body.children).filter((child): child is HTMLElement => child instanceof HTMLElement && child !== dialog && !child.inert);
    for (const child of inerted) {
      child.inert = true;
    }
    adapter.setInput(false);
    detail = {panel, from, moved, zoom, inerted};
    dialog.showModal();
    if (zoom !== null) {
      layoutZoom(zoom);
    }
    dialogClose.focus({preventScroll: true});
  }

  function closeDetail(returnFocus: boolean): void {
    const open = detail;
    if (open === null) {
      return;
    }
    detail = null;
    if (dialog.open) {
      dialog.close();
    }
    if (open.moved !== null) {
      lowerHeadings(open.moved.raised);
      open.moved.parent.insertBefore(open.moved.element, open.moved.next !== null && open.moved.next.parentNode === open.moved.parent ? open.moved.next : null);
    }
    dialogContent.replaceChildren();
    for (const child of open.inerted) {
      child.inert = false;
    }
    adapter?.setInput(view === 'page');
    if (returnFocus) {
      // Closing returns to the view it was opened from, and focus to the panel (UX §06).
      const target = open.from === 'guided' && view === 'guided' ? lensControl : open.panel.element;
      if (target !== null && isRendered(target)) {
        target.focus({preventScroll: true});
      }
    }
  }

  function activate(panel: Panel, from: ReaderView): void {
    if (panel.detail === 'none') {
      announce(panel.transcript);
    } else if (panel.detail !== 'link') {
      openDetail(panel, from);
    }
  }

  // --- Print (D115) -----------------------------------------------------------

  let resumeAt: {readonly view: ReaderView; readonly page: number; readonly step: number} | null = null;

  /** The page as it reads without JavaScript, every image back, for the printer (IC08). */
  function suspend(): void {
    if (suspended || adapter === null) {
      return;
    }
    closeDetail(false);
    resumeAt = {view, page: pageNow(), step};
    suspended = true;
    adapter.destroy();
    adapter = null;
    // Every figure is back in its sheet: each image gets its sources and every sheet shows, as published. A lazy image
    // that never loaded stays lazy: a browser loads those for print, and waits for them, which it does not for a load
    // started now (D115).
    for (const page of pages) {
      keep(page, false);
      page.sheet.hidden = false;
      // The renderer writes no style on the art; the reader's fitted size goes with the attribute.
      dropStyle(page.art);
    }
    if (lensControl !== null) {
      lensControl.remove();
      lensControl = null;
    }
    lens.remove();
    dropStyle(book);
    body.classList.remove('comic-enhanced', 'comic-guided', 'comic-spread', 'comic-show-transcript');
  }

  function resume(): void {
    if (!suspended || resumeAt === null) {
      return;
    }
    body.classList.add('comic-enhanced');
    sizeBook();
    let made: EngineAdapter | null = null;
    if (hasRoom()) {
      try {
        made = makeBook(resumeAt.page);
      } catch (error) {
        reportLater(error);
      }
    }
    if (made === null) {
      // No room for the book now, as in a frame hidden while printing, or an engine that fails to start: the page
      // stays as it printed, as published, and the reader tries again the next time printing ends (W5R-18).
      body.classList.remove('comic-enhanced');
      dropStyle(book);
      return;
    }
    const at = resumeAt;
    resumeAt = null;
    suspended = false;
    adapter = made;
    book.appendChild(lens);
    view = 'page';
    if (at.view === 'guided') {
      showStep(at.step, 'api', false);
    } else {
      fitArts();
      applyPreload();
      render();
    }
  }

  // --- Addresses (D110) --------------------------------------------------------

  function resolveFragment(hash: string): Destination | null {
    const fragment = parseReaderFragment(hash);
    switch (fragment.kind) {
      case 'none':
        return {view: 'page', page: 1, panel: null, address: null};
      case 'page': {
        const page = clampIndex(fragment.page, total);
        return {view: 'page', page, panel: null, address: pageFragment(page)};
      }
      case 'panel': {
        const page = clampIndex(fragment.page, total);
        const count = pages[page - 1]!.panels.length;
        if (count === 0) {
          return {view: 'page', page, panel: null, address: pageFragment(page)};
        }
        const panel = clampIndex(fragment.panel, count);
        return {view: 'guided', page, panel, address: panelFragment(page, panel)};
      }
      case 'malformed':
        return {view: 'page', page: 1, panel: null, address: pageFragment(1)};
      case 'other': {
        const target = document.getElementById(fragment.id);
        if (target === null) {
          return {view: 'page', page: 1, panel: null, address: pageFragment(1)};
        }
        const owner = pages.find((page) => page.sheet.contains(target) || page.figure.contains(target));
        // An anchor outside the pages, such as the skip link's #comic-main, is the browser's business.
        return owner === undefined ? null : {view: 'page', page: owner.number, panel: null, address: null};
      }
    }
  }

  /** Corrects the address the reader was opened with once the page has loaded (as the deck does, D165). */
  function correctOnceLoaded(hash: string): void {
    const opened = location.hash;
    const correct = (): void => {
      if (location.hash === opened) {
        writeAddress(hash);
      }
    };
    if (document.readyState === 'complete') {
      window.setTimeout(correct, 0);
    } else {
      window.addEventListener('load', () => window.setTimeout(correct, 0), {once: true});
    }
  }

  // --- Start -------------------------------------------------------------------

  const resolved = resolveFragment(location.hash);
  const initial = resolved ?? {view: 'page' as const, page: 1, panel: null, address: null};
  const relabelled = [controls.previous, controls.next, controls.detail, controls.transcript, controls.fullscreen];
  const labels = relabelled.map((button) => Array.from(button.childNodes));

  // The first change the reader makes (CONTRACT §5); until here the page is as published.
  body.classList.add('comic-enhanced');
  controls.status.parentElement?.append(hint, announcer);
  book.tabIndex = -1;
  body.appendChild(dialog);
  setText(controls.previous, strings.previous);
  setText(controls.next, strings.next);
  setText(controls.detail, strings.detail);
  setText(controls.transcript, strings.transcript);
  setText(controls.fullscreen, strings.fullscreen);
  sizeBook();
  /** Takes back every change above, so the page is as published (CONTRACT §5). */
  const takeBack = (): void => {
    body.classList.remove('comic-enhanced');
    hint.remove();
    announcer.remove();
    book.removeAttribute('tabindex');
    dialog.remove();
    relabelled.forEach((button, index) => button.replaceChildren(...labels[index]!));
    dropStyle(book);
  };
  if (!hasRoom()) {
    // A comic opened in a hidden or zero-width frame has no room for the book, and the adapter builds none: every
    // change above is taken back and the reader does not start, so the page stays as published (W5R-18).
    takeBack();
    return null;
  }
  try {
    adapter = makeBook(initial.page);
  } catch (error) {
    // An engine that fails to start: the adapter has put the page back as it found it, the reader takes back its own
    // changes and does not start, and the error is reported once this start is over (CONTRACT §5).
    takeBack();
    reportLater(error);
    return null;
  }
  book.appendChild(lens);
  fitArts();
  if (initial.view === 'guided') {
    step = stepIndex(steps, initial.page, initial.panel);
    const current = currentStep();
    view = 'guided';
    adapter.setInput(false);
    lensArt.src = pages[current.page - 1]!.image.getAttribute('src') ?? '';
    lensControl = makeLensControl(pages[current.page - 1]!, panelOfStep());
    lens.appendChild(lensControl);
  }
  applyPreload();
  render();
  placeLens();
  reported = pageNow();
  if (resolved !== null && location.hash !== '') {
    // The browser may have scrolled to the fragment when parsing ended, before the reader started, where the page
    // stood without JavaScript; the book it names is at the top. Later jumps land there too (comic.css, D105).
    instantly(() => window.scrollTo(0, 0));
  }
  if (initial.address !== null && initial.address !== location.hash) {
    correctOnceLoaded(initial.address);
  }

  // --- Events -----------------------------------------------------------------

  controls.previous.addEventListener('click', () => {
    if (view === 'guided') {
      showStep(step - 1, 'button', false);
    } else {
      turn('previous', 'button');
    }
  });
  controls.next.addEventListener('click', () => {
    if (view === 'guided') {
      showStep(step + 1, 'button', false);
    } else {
      turn('next', 'button');
    }
  });
  controls.guided.addEventListener('click', () => {
    if (view === 'guided') {
      leaveGuided('button', false);
    } else {
      enterGuided(pageNow(), null, 'button', false);
    }
  });
  controls.detail.addEventListener('click', () => {
    const panel = panelOfStep();
    if (view !== 'guided' || panel === null) {
      return;
    }
    if (panel.detail === 'link') {
      lensControl?.click();
    } else {
      activate(panel, 'guided');
    }
  });
  controls.transcript.addEventListener('click', () => {
    transcriptShown = !transcriptShown;
    render();
  });
  controls.fullscreen.addEventListener('click', () => {
    void (async () => {
      try {
        if (document.fullscreenElement !== null) {
          await document.exitFullscreen();
        } else if (document.fullscreenEnabled && typeof document.documentElement.requestFullscreen === 'function') {
          await document.documentElement.requestFullscreen();
        } else {
          setText(controls.status, strings.fullscreen_denied);
        }
      } catch {
        setText(controls.status, strings.fullscreen_denied);
      }
    })();
  });

  book.addEventListener('focusin', () => {
    focusInBook = true;
  });
  document.addEventListener('focusin', (event) => {
    if (!(event.target instanceof Node) || !book.contains(event.target)) {
      focusInBook = false;
    }
  });

  // A panel in the book: its detail, or its transcript announced; a link panel is the browser's (IC07: panel actions win).
  book.addEventListener('click', (event) => {
    if (view !== 'page') {
      return;
    }
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('.comic-panel') : null;
    if (target === null) {
      return;
    }
    const panel = pages.flatMap((page) => page.panels).find((each) => each.element === target);
    if (panel === undefined || panel.detail === 'link') {
      return;
    }
    event.preventDefault();
    activate(panel, 'page');
  });

  // Guided view: the left and right thirds step, the middle opens the detail; a key on the panel is the middle (UX §06).
  lens.addEventListener('click', (event) => {
    if (view !== 'guided') {
      return;
    }
    const rect = lens.getBoundingClientRect();
    const zone = event.detail === 0 ? 'detail' : guidedZone(event.clientX - rect.left, rect.width);
    if (zone !== 'detail') {
      event.preventDefault();
      showStep(step + (zone === 'next' ? 1 : -1), 'gesture', false);
      return;
    }
    const panel = panelOfStep();
    if (panel === null || panel.detail === 'link') {
      return;
    }
    event.preventDefault();
    activate(panel, 'guided');
  });
  let lensTouch: {x: number; y: number; id: number} | null = null;
  lens.addEventListener(
    'touchstart',
    (event) => {
      const touch = event.touches.length === 1 ? event.touches.item(0) : null;
      lensTouch = touch === null ? null : {x: touch.clientX, y: touch.clientY, id: touch.identifier};
    },
    {passive: true},
  );
  lens.addEventListener('touchend', (event) => {
    const start = lensTouch;
    lensTouch = null;
    const touch = start === null ? undefined : Array.from(event.changedTouches).find((each) => each.identifier === start.id);
    if (start === null || touch === undefined) {
      return;
    }
    const direction = swipeDirection(touch.clientX - start.x, touch.clientY - start.y);
    if (direction !== null && view === 'guided') {
      // A swipe steps as the thirds do; the tap it is not must not follow it.
      if (event.cancelable) {
        event.preventDefault();
      }
      showStep(step + (direction === 'next' ? 1 : -1), 'gesture', false);
    }
  });

  dialogClose.addEventListener('click', () => closeDetail(true));
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeDetail(true);
  });
  dialog.addEventListener('click', (event) => {
    // The backdrop: a click on the dialog element itself, outside its body (UX §06).
    if (event.target === dialog) {
      closeDetail(true);
    }
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') {
      return;
    }
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button, a[href], [tabindex]:not([tabindex="-1"]), input, select, textarea')).filter(
      (candidate) => !candidate.hasAttribute('disabled') && isRendered(candidate),
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) {
      return;
    }
    // Focus stays in the dialog, both ways (UX §06).
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  // Escape: the detail first, then guided view; anything else is the page's or the preview's (IC06).
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) {
        return;
      }
      if (detail !== null) {
        event.preventDefault();
        event.stopPropagation();
        closeDetail(true);
      } else if (view === 'guided') {
        event.preventDefault();
        event.stopPropagation();
        leaveGuided('key', true);
      }
    },
    true,
  );

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }
    const key = readerKey(event.key);
    if (key === null || detail !== null || suspended || isEditable(event.target)) {
      return;
    }
    if (view === 'guided') {
      const target = key === 'first' ? 0 : key === 'last' ? steps.length - 1 : step + (key === 'next' ? 1 : -1);
      if (target < 0 || target >= steps.length || target === step) {
        return;
      }
      event.preventDefault();
      showStep(target, 'key', true);
      return;
    }
    if (key === 'first' || key === 'last') {
      const target = key === 'first' ? 1 : total;
      if (target === pageNow()) {
        return;
      }
      event.preventDefault();
      showPage(target, 'key');
      return;
    }
    const target = key === 'next' ? nextPage(pageNow(), total, layoutNow()) : previousPage(pageNow(), total, layoutNow());
    if (target === null) {
      return;
    }
    event.preventDefault();
    turn(key, 'key');
  });

  window.addEventListener('hashchange', () => {
    if (suspended) {
      return;
    }
    const destination = resolveFragment(location.hash);
    if (destination === null) {
      // The browser has taken the anchor in; the address names the place again, which moves neither the page nor focus.
      writeAddress(address());
      return;
    }
    closeDetail(false);
    if (destination.view === 'guided') {
      enterGuided(destination.page, destination.panel, 'hash', true);
    } else {
      if (view === 'guided') {
        view = 'page';
        adapter?.setInput(true);
        lensControl?.remove();
        lensControl = null;
      }
      showPage(destination.page, 'hash');
    }
    if (destination.address !== null) {
      writeAddress(destination.address);
    }
    // The book is the place a page is shown: bring it to the top, as a fragment jump would.
    instantly(() => window.scrollTo(0, 0));
  });

  function resized(): void {
    if (suspended || adapter === null) {
      return;
    }
    sizeBook();
    adapter.resize();
    fitArts();
    placeLens();
    if (detail?.zoom !== null && detail?.zoom !== undefined) {
      layoutZoom(detail.zoom);
    }
  }
  window.addEventListener('resize', resized);
  document.addEventListener('fullscreenchange', resized);
  const bar = new ResizeObserver(() => followBar());
  for (const above of [controls.status.parentElement, document.querySelector('.comic-register')]) {
    if (above !== null) {
      bar.observe(above);
    }
  }

  motion.addEventListener('change', (event) => {
    adapter?.setInstant(event.matches);
  });

  const askLater = (): void => {
    window.setTimeout(askNext, 1000);
  };
  if (document.readyState === 'complete') {
    askLater();
  } else {
    window.addEventListener('load', askLater, {once: true});
  }

  window.addEventListener('beforeprint', suspend);
  window.addEventListener('afterprint', resume);
  printing.addEventListener('change', (event) => {
    if (event.matches) {
      suspend();
    } else {
      resume();
    }
  });

  return Object.freeze({
    version: 1 as const,
    get total(): number {
      return total;
    },
    get page(): number {
      return pageNow();
    },
    get panel(): number | null {
      return view === 'guided' ? currentStep().panel : null;
    },
    get view(): ReaderView {
      return view;
    },
    get layout(): Layout {
      return layoutNow();
    },
    get visible(): readonly number[] {
      return view === 'guided' ? [currentStep().page] : [...visibleNow()];
    },
    get transcript(): boolean {
      return transcriptShown;
    },
    get detailOpen(): boolean {
      return detail !== null;
    },
    get instant(): boolean {
      return adapter?.instant ?? motion.matches;
    },
    get address(): string {
      return address();
    },
    goTo(page: number, options?: {readonly focus?: boolean}): number {
      if (typeof page !== 'number' || Number.isNaN(page) || suspended) {
        return pageNow();
      }
      closeDetail(false);
      if (view === 'guided') {
        view = 'page';
        adapter?.setInput(true);
        lensControl?.remove();
        lensControl = null;
      }
      showPage(page, 'api');
      if (options?.focus === true) {
        keepFocus();
        const first = pages[pageNow() - 1]?.panels[0]?.element;
        (first ?? book).focus({preventScroll: true});
      }
      return pageNow();
    },
    enterGuided(page: number, panel?: number | null, options?: {readonly focus?: boolean}): void {
      if (typeof page !== 'number' || Number.isNaN(page) || suspended) {
        return;
      }
      closeDetail(false);
      enterGuided(page, typeof panel === 'number' && !Number.isNaN(panel) ? panel : null, 'api', options?.focus === true);
    },
    leaveGuided(options?: {readonly focus?: boolean}): void {
      leaveGuided('api', options?.focus === true);
    },
  });
}

function start(): void {
  if (window.papeleriaReader !== undefined) {
    // Already enhanced, for example because the script was included twice.
    return;
  }
  const main = document.getElementById('comic-main');
  const book = document.getElementById('comic-book');
  const strings = readStringsBlock();
  const controls = findControls();
  const PageFlip = window.St?.PageFlip;
  const pages = main === null ? null : findPages(main);
  if (main === null || book === null || strings === null || controls === null || pages === null || typeof PageFlip !== 'function') {
    // Without its pages, strings, controls or engine the comic stays exactly as published: every page and transcript readable.
    return;
  }
  const reader = createReader(book, pages, strings, controls, PageFlip);
  if (reader !== null) {
    window.papeleriaReader = reader;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, {once: true});
} else {
  start();
}
