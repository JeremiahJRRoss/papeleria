/**
 * M2.6: the preview bridge (IC06, D52, D83). Preview builds only: the deck's
 * preview bundle is the deck client with this file bundled in, and a template
 * that publishes no script gets this file alone. A published piece never
 * carries it (`scripts/bundle-clients.mjs` bounds every bundle's inputs, and
 * the tests scan published output for it).
 *
 * The bridge talks to one window only, the page's parent: the editor, or
 * `serve`'s read-only shell. It learns two things at run time, since a
 * bundle holds no address (D164(j)): the parent's exact origin, from the
 * `parent` query parameter of the frame's own address, which must be a
 * loopback HTTP origin; and the page's generation id, from the first segment
 * of its path. Without both, or opened on its own (Open in a new tab), it does
 * nothing and the page behaves as published.
 *
 * Received messages pass `acceptToFrame`: the parent's origin and window,
 * one of IC06's shapes, this page's generation. Sent messages name that
 * origin as `targetOrigin`, never `*`.
 *
 * - `goto` shows a slide through `window.papeleriaDeck.goTo`, which never
 *   takes focus and counts as the bridge's own change (CONTRACT §6); never by
 *   assigning `location.hash`, which is a reader's navigation. In the stacked
 *   view `goTo` does nothing for the slide already current, so the bridge
 *   brings that slide to the top itself (D83; W1_RECONCILIATION §5.6). Other
 *   targets are announced to the page as a `papeleria-preview-goto` event, and
 *   when nothing handles it the element the target's fragment names is
 *   scrolled to the top.
 * - `ready(hash)` is sent once the page has loaded, from a timer set at
 *   `load`, so after the deck's own start-up address correction (D165); for a
 *   deck the hash is built from `papeleriaDeck.current`, and for a comic it
 *   is `papeleriaReader.address` (M4.4, D117), each right from the start. It
 *   is sent again whenever the reader moves (a slide or page change not made
 *   by the bridge, a changed address), so the editor knows the place to keep
 *   across a reload.
 * - `scroll(y)` reports the page's scroll position, at most once a frame.
 * - Escape that reaches the window unhandled leaves fullscreen when the page
 *   is fullscreen, and otherwise sends `returnFocus` (IC06's order; a comic's
 *   detail and guided view handle Escape first and stop it).
 * - `grid` and `pointer` are the comic's (M4.4): `grid` becomes a
 *   `papeleria-preview-grid` event on `document`, a
 *   `papeleria-preview-pointer` event the page dispatches becomes `pointer`,
 *   and `papeleria-preview-pointer-left` becomes `pointerLeft` (D174);
 *   `templates/comic/client/preview-comic.ts` draws the grid, reports the
 *   pointer and handles a page or panel `goto`.
 * - `overflow` is the deck's (D167, D174): once `ready` has gone at load, the
 *   bridge dispatches `papeleria-preview-loaded`, and the
 *   `papeleria-preview-overflow` event `{slides}` that
 *   `templates/deck/client/preview-deck.ts` answers with becomes `overflow`.
 * - A link to anything but a place in the page opens in a new tab, never in
 *   the frame, and only after an action of the reader's (IC06): their click,
 *   or a click a script makes while they act; a script's click alone opens
 *   nothing.
 * - Every message sent is the one `validateToEditor` returns: IC06's shape,
 *   its coordinates finite and clamped.
 */
import type {PageChangeDetail, PapeleriaReader} from '../comic/client/reader-logic.js';
import type {PapeleriaDeck, SlideChangeDetail} from '../deck/client/deck-logic.js';
import {
  acceptToFrame,
  GENERATION_ID_PATTERN,
  targetFragment,
  validateToEditor,
  type Target,
  type ToEditorMessage,
  type ToFrameMessage,
} from './preview-protocol.js';

declare global {
  interface Window {
    papeleriaDeck?: PapeleriaDeck;
  }
}

/** The parent's origin from the `parent` query parameter: a loopback HTTP origin exactly, or null. */
function parentOrigin(): string | null {
  const value = new URLSearchParams(location.search).get('parent');
  if (value === null) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const loopback = parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && /^[0-9]{1,5}$/.test(parsed.port);
  return loopback && parsed.origin === value ? value : null;
}

/** This page's generation id, the first segment of its path, or null. */
function generationOf(pathname: string): string | null {
  const first = pathname.split('/')[1] ?? '';
  return GENERATION_ID_PATTERN.test(first) ? first : null;
}

/**
 * Runs a scroll at once. `site.css` asks for smooth scrolling on `<html>`, so
 * the inline style is set to `auto` for the scroll and put back after, as the
 * deck client does for its own jumps.
 */
function instantly(scroll: () => void): void {
  const root = document.documentElement;
  const previous = root.style.getPropertyValue('scroll-behavior');
  const priority = root.style.getPropertyPriority('scroll-behavior');
  const hadStyle = root.hasAttribute('style');
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

function scrollToElement(id: string): boolean {
  const element = document.getElementById(id);
  if (element === null) {
    return false;
  }
  instantly(() => element.scrollIntoView({block: 'start'}));
  return true;
}

function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment.slice(1));
  } catch {
    return fragment.slice(1);
  }
}

function start(origin: string, generationId: string): void {
  const parent = window.parent;
  const deck = (): PapeleriaDeck | undefined => window.papeleriaDeck;
  const comic = (): PapeleriaReader | undefined => (window as unknown as {papeleriaReader?: PapeleriaReader}).papeleriaReader;

  const post = (message: ToEditorMessage): void => {
    // The same check the editor applies: nothing malformed leaves the page, and what leaves is clamped.
    const valid = validateToEditor(message);
    if (valid !== null) {
      parent.postMessage(valid, origin);
    }
  };

  const currentHash = (): string => {
    const current = deck();
    if (current !== undefined) {
      return `#slide-${current.current}`;
    }
    return comic()?.address ?? location.hash;
  };

  let loaded = false;
  let lastHash: string | null = null;
  const sendReady = (force: boolean): void => {
    const hash = currentHash();
    if (force || hash !== lastHash) {
      lastHash = hash;
      post({type: 'ready', generationId, hash});
    }
  };

  const goto = (target: Target): void => {
    const current = deck();
    if (target.kind === 'slide' && current !== undefined) {
      if (current.showAll && current.current === Math.min(target.slide, current.total)) {
        scrollToElement(`slide-${current.current}`);
      } else {
        current.goTo(target.slide);
      }
      return;
    }
    const event = new CustomEvent<Target>('papeleria-preview-goto', {detail: target, cancelable: true});
    if (document.dispatchEvent(event)) {
      scrollToElement(decodeFragment(targetFragment(target)));
    }
  };

  const handle = (message: ToFrameMessage): void => {
    switch (message.type) {
      case 'goto':
        goto(message.target);
        break;
      case 'grid':
        document.dispatchEvent(new CustomEvent<{on: boolean}>('papeleria-preview-grid', {detail: {on: message.on}}));
        break;
      case 'restoreScroll':
        instantly(() => window.scrollTo(0, message.y));
        break;
    }
  };

  window.addEventListener('message', (event: MessageEvent) => {
    const message = acceptToFrame({origin: event.origin, source: event.source, data: event.data}, {origin, source: parent, generationId});
    if (message !== null) {
      handle(message);
    }
  });

  // The reader moved: tell the editor where the page now is.
  document.addEventListener('slidechange', (event: Event) => {
    const detail = (event as CustomEvent<SlideChangeDetail>).detail;
    if (loaded && detail.cause !== 'api') {
      sendReady(false);
    }
  });
  document.addEventListener('pagechange', (event: Event) => {
    const detail = (event as CustomEvent<PageChangeDetail>).detail;
    if (loaded && detail.cause !== 'api') {
      sendReady(false);
    }
  });
  window.addEventListener('hashchange', () => {
    if (loaded) {
      sendReady(false);
    }
  });

  let scrollQueued = false;
  window.addEventListener(
    'scroll',
    () => {
      if (!scrollQueued) {
        scrollQueued = true;
        requestAnimationFrame(() => {
          scrollQueued = false;
          post({type: 'scroll', generationId, y: Math.max(0, window.scrollY)});
        });
      }
    },
    {passive: true},
  );

  document.addEventListener('papeleria-preview-pointer', (event: Event) => {
    const detail = (event as CustomEvent<{page: number; x: number; y: number}>).detail;
    if (typeof detail === 'object' && detail !== null) {
      post({type: 'pointer', generationId, page: detail.page, x: detail.x, y: detail.y});
    }
  });
  document.addEventListener('papeleria-preview-pointer-left', () => {
    post({type: 'pointerLeft', generationId});
  });

  document.addEventListener('papeleria-preview-overflow', (event: Event) => {
    const detail = (event as CustomEvent<{slides: readonly number[]}>).detail;
    if (typeof detail === 'object' && detail !== null) {
      post({type: 'overflow', generationId, slides: detail.slides});
    }
  });

  // A link the reader follows opens in a new tab, and only after an action of theirs (IC06): their own click, or a click
  // a script makes while they act, as the comic's Detail does for a link panel. A script's click with no action of
  // theirs opens nothing (W5R-G02). Either way the frame keeps its page.
  document.addEventListener('click', (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(anchor instanceof HTMLAnchorElement) || (anchor.getAttribute('href') ?? '').startsWith('#')) {
      return;
    }
    event.preventDefault();
    // A browser without `userActivation` (Firefox before 120) counts the reader's own click alone.
    if (event.isTrusted || navigator.userActivation?.isActive === true) {
      window.open(anchor.href, '_blank', 'noopener,noreferrer');
    }
  });

  // Escape that nothing in the page handled: fullscreen first, then back to the editor (IC06).
  window.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (document.fullscreenElement !== null) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    post({type: 'returnFocus', generationId});
  });

  const whenLoaded = (): void => {
    // A timer set at load runs after the deck's own address correction (D165).
    window.setTimeout(() => {
      loaded = true;
      sendReady(true);
      // What the page measures once laid out may go to the editor now: a deck's overflowing slides (D174).
      document.dispatchEvent(new CustomEvent('papeleria-preview-loaded'));
    }, 0);
  };
  if (document.readyState === 'complete') {
    whenLoaded();
  } else {
    window.addEventListener('load', whenLoaded, {once: true});
  }
}

(() => {
  if (window.parent === window) {
    return;
  }
  const origin = parentOrigin();
  const generationId = generationOf(location.pathname);
  if (origin !== null && generationId !== null) {
    start(origin, generationId);
  }
})();
