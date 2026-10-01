/**
 * W5E (IC08, D167, D174): what a deck does in the editor's preview and nowhere else.
 *
 * `scripts/bundle-clients.mjs` bundles this file into `deck-preview.js`, after
 * the deck client and the preview bridge; `deck.js`, the published script,
 * never holds it. It waits for the bridge's `papeleria-preview-loaded`, so a
 * preview opened on its own behaves as the published page.
 *
 * Overflow: a deck prints one slide to an A4 landscape page, and a slide whose
 * content does not fit its printed page is an authoring defect (IC08). The CLI
 * has no layout engine to find one (D167); the preview has the browser's. Once
 * the page and every font face it declares have loaded, the check lays the
 * deck out as it prints: every print rule of its stylesheets applies, and a
 * rule for a width is judged at the printed page's width, not the frame's. It
 * measures each slide as the print suite does (`overflowingSlides` in
 * test/browser/print-deck.test.ts): the slide's canvas scrolls, or something in
 * it reaches past its edges. Everything is put back in the same task, before
 * the browser draws again, and the scroll position with it. The slides that
 * do not fit go to the bridge as a `papeleria-preview-overflow` event
 * `{slides}`, which it sends to the editor as `overflow` (D174); the editor
 * names them in its status line. The verdict does not depend on the preview's
 * width, so it is made once for each generation.
 *
 * Own code, Apache-2.0.
 */

/** The printed page's width less its margins (A4 landscape, 8 mm each side, slides.css), in CSS pixels. */
const PRINT_WIDTH = (281 / 25.4) * 96;

/** Whether one part of a media query (a medium, or a condition in parentheses) holds for the printed page. */
function holdsInPrint(part: string): boolean {
  if (part === 'all' || part === 'print') {
    return true;
  }
  if (/^[a-z-]+$/.test(part)) {
    // Another medium: screen, speech.
    return false;
  }
  const width = /^\((min|max)-width:\s*([\d.]+)(px|r?em)\)$/.exec(part);
  if (width !== null) {
    const pixels = Number(width[2]) * (width[3] === 'px' ? 1 : 16);
    return width[1] === 'min' ? PRINT_WIDTH >= pixels : PRINT_WIDTH <= pixels;
  }
  // Anything else, such as forced colours or reduced motion, is the same printed as shown: as the browser has it now.
  return window.matchMedia(part).matches;
}

/** Whether a media query list holds for the printed page: any of its queries, each a medium and conditions joined by `and`. */
function listHoldsInPrint(media: MediaList): boolean {
  return Array.from(media).some((query) => {
    const text = query.trim().toLowerCase();
    const negated = text.startsWith('not ');
    const holds = text
      .replace(/^(?:not|only)\s+/, '')
      .split(/\s+and\s+/)
      .every((part) => holdsInPrint(part.trim()));
    return negated ? !holds : holds;
  });
}

/** Makes every media list in `rules` say whether it holds in print, keeping what it said to put back. */
function printRules(rules: CSSRuleList, kept: {readonly media: MediaList; readonly text: string}[]): void {
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSMediaRule || rule instanceof CSSImportRule) {
      if (rule.media.length > 0) {
        kept.push({media: rule.media, text: rule.media.mediaText});
        rule.media.mediaText = listHoldsInPrint(rule.media) ? 'all' : 'not all';
      }
    }
    if (rule instanceof CSSImportRule) {
      if (rule.styleSheet !== null) {
        printRules(rule.styleSheet.cssRules, kept);
      }
    } else if (rule instanceof CSSGroupingRule) {
      printRules(rule.cssRules, kept);
    }
  }
}

/** The slides, numbered from 1, whose content does not fit their canvas as laid out now. */
function overflowing(): number[] {
  return Array.from(document.querySelectorAll('article.deck-slide'), (slide, index) => {
    const canvas = slide.querySelector('.slide-canvas');
    if (canvas === null) {
      return 0;
    }
    const edge = canvas.getBoundingClientRect();
    const reaching = Array.from(canvas.querySelectorAll('*')).some((element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && (box.bottom > edge.bottom + 1 || box.right > edge.right + 1 || box.top < edge.top - 1 || box.left < edge.left - 1);
    });
    const scrolls = canvas.scrollHeight > canvas.clientHeight + 1 || canvas.scrollWidth > canvas.clientWidth + 1;
    return reaching || scrolls ? index + 1 : 0;
  }).filter((number) => number > 0);
}

/** The slides that do not fit their printed page, found as described above and with the page put back as it was. */
function overflowingInPrint(): number[] {
  const root = document.documentElement;
  const style = root.getAttribute('style');
  const x = window.scrollX;
  const y = window.scrollY;
  const kept: {readonly media: MediaList; readonly text: string}[] = [];
  try {
    for (const sheet of Array.from(document.styleSheets)) {
      if (sheet.media.length > 0) {
        kept.push({media: sheet.media, text: sheet.media.mediaText});
        sheet.media.mediaText = listHoldsInPrint(sheet.media) ? 'all' : 'not all';
      }
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        // A sheet from another origin keeps its rules to itself; a preview has none.
        continue;
      }
      printRules(rules, kept);
    }
    // The printed page's width, and no scroll anchoring to move the page while it is laid out so.
    root.style.setProperty('width', `${PRINT_WIDTH}px`);
    root.style.setProperty('overflow-anchor', 'none');
    return overflowing();
  } finally {
    for (const {media, text} of kept.reverse()) {
      media.mediaText = text;
    }
    if (style === null) {
      root.removeAttribute('style');
    } else {
      root.setAttribute('style', style);
    }
    if (window.scrollX !== x || window.scrollY !== y) {
      // site.css asks for smooth scrolling: back at once, as the deck client scrolls.
      root.style.setProperty('scroll-behavior', 'auto', 'important');
      void getComputedStyle(root).scrollBehavior;
      window.scrollTo(x, y);
      if (style === null) {
        root.removeAttribute('style');
      } else {
        root.setAttribute('style', style);
      }
    }
  }
}

document.addEventListener(
  'papeleria-preview-loaded',
  () => {
    // Every face first: a slide shown only in print must not be measured in a fallback font.
    void Promise.allSettled(Array.from(document.fonts, (face) => face.load())).then(() => {
      document.dispatchEvent(new CustomEvent('papeleria-preview-overflow', {detail: {slides: overflowingInPrint()}}));
    });
  },
  {once: true},
);
