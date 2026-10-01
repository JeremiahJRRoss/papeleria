# Comic reader contract

Revision 3 · 2026-09-28 · Written by session W4 at M4.2 and M4.3; revised by W5C at M5.4 (the hint's singular, `panels_hint_one`, D130) and by W5E (a start or a resume with no room for the book, or with an engine that fails to start, changes nothing, W5R-18; a text detail's headings a level higher in the dialog, W5R-19; the preview's `pointerLeft`, D174). Decisions D103, D105–D117, D130 and D174 in `docs/DECISIONS.md`, in the development record, Dev_Papeleria, which is not public.

This is what the comic renderer ([`../render.ts`](../render.ts), M4.2) emits for `reader.js` to work, and what the preview bridge may rely on. The reader is [`reader.ts`](reader.ts), with its pure half in [`reader-logic.ts`](reader-logic.ts); it drives the page-turn engine only through [`engine-adapter.ts`](engine-adapter.ts) (D103). `npm run build` writes `lib/clients/reader.js`, one classic script in three parts (D109): a banner line naming both licences, then the vendored engine's pinned bytes exactly as in `vendor/page-flip/page-flip.browser.js`, then a newline and the esbuild IIFE of the three files above. The pipeline copies it into `dist/` beside `index.html`, with the engine's licence at `dist/vendor/page-flip/LICENSE`.

`test/unit/comic-reader-bundle.test.ts` reads every id, class, attribute, element and event name the reader's own code passes as a string to a DOM lookup, a class list, an attribute method, `dataset` or an event constructor, and every property it sets on `window`, and fails if this file does not mention one of them. Names built at run time, such as `page-N`, are written here by hand. `test/browser/comic.test.ts`, `comic-a11y.test.ts` and `motion.test.ts` drive the contract in Chromium, Firefox and WebKit.

## 1. The page

| Element | Required | Notes |
| --- | --- | --- |
| `html[lang]` | yes | From the manifest's `language`; the reader does not read it |
| `body.comic-body` | yes | Carries no state class in the published markup. The reader adds `comic-enhanced` first, then toggles `comic-guided`, `comic-spread` and `comic-show-transcript` (§7) |
| `a.skip-link[href="#comic-main"]` | yes | The `skip` string. The reader never touches it and leaves `#comic-main` to the browser (§5) |
| `header.comic-register` | yes | `h1.comic-title` (the title's inline HTML), `span.comic-format` (the manifest's `format`, else `format_comics`), `span.comic-status-label` and `span.wordmark`. The reader watches its height (§5, resize) and changes nothing in it |
| `div.comic-tools#comic-tools` | yes | The controls, §3, before the pages: UX C4's tab order (skip link, controls, then each panel) and §11's "DOM order equals visual order" |
| `main.comic#comic-main` | yes | Holds `div.comic-book#comic-book`, empty, then one `article.comic-sheet` per page (§2) |
| One `script[src="reader.js"]` | yes | Relative, classic, `defer` in `<head>`. No other executable script on the page (IC07, C22). The reader waits for `DOMContentLoaded` if the document is still loading |
| `link[rel=stylesheet]` | yes | `theme/css/fonts.css`, `tokens.css`, `site.css`, `print.css` (print only), `base.css`, then `comic.css`, which holds every rule the reader's classes need, the engine's four layout rules restated (D109) |

Resources the reader itself loads: none by request of its own. It sets `src` on an image in two places only, both to a URL already in the page: the lens takes the page image's `currentSrc` (§5, guided view), and a zoom detail takes its panel's `data-zoom-src`, the original, when that detail opens and never before (IC04). It fetches nothing and stores nothing.

## 2. Pages and panels

Each page, in order, on a line of its own:

```html
<article class="comic-sheet" id="page-N" data-page="N" data-source-line-start="…" data-source-line-end="…">
  <h2 class="comic-sheet-title" id="sheet-N-title">Page N of M</h2>
  <figure class="comic-figure" data-page="N" aria-labelledby="sheet-N-title">
    <div class="comic-art">
      <picture><source type="image/avif" srcset="…" sizes="…"><img src="…" srcset="…" sizes="…" width="W" height="H" alt="…" [loading="lazy"]></picture>
      <button class="comic-panel" type="button" id="page-N-panel-M" data-page="N" data-panel="M" data-detail="none|zoom|text|image"
              data-box="x y w h" data-source-line-start="…" data-source-line-end="…" style="left:x%;top:y%;width:w%;height:h%"
              [aria-haspopup="dialog"] [data-zoom-src="…"]>
        <span class="comic-panel-label">transcript</span>[<span class="comic-panel-hint" aria-hidden="true">Detail</span>]
      </button>
      <a class="comic-panel [link-external]" href="…" … data-detail="link" …>
        <span class="comic-panel-label">transcript</span><span class="comic-panel-hint">label[↗ and "(External link)"]</span>
      </a>
    </div>
  </figure>
  <p class="comic-credit"><span class="comic-credit-name">…</span><span class="comic-credit-rights">…</span></p>
  <div class="comic-transcript">
    <h3 class="comic-transcript-title">Transcript</h3>
    <ol class="comic-transcript-list">
      <li class="comic-transcript-item" data-panel="M"><p class="comic-transcript-text">…</p>[the detail, below]</li>
    </ol>
  </div>
  [<dl class="comic-credits">…</dl> on the last page]
</article>
```

| What | Rule |
| --- | --- |
| `id="page-N"` | On every sheet, N from 1 in order. **Ids beginning `page-` belong to the pages and panels alone**: the reader reads any `#page-…` fragment as a page or panel address (§5) |
| `figure.comic-figure` | The element the adapter hands to the engine, one per page: the reader moves it into the book and back. The sheet it leaves behind is the transcript strip under the book |
| `img` | The first image in `.comic-art`. Its `width` and `height` attributes give the art's aspect ratio; without them, or with a sheet, figure or art missing, the reader does not start. A `picture` holds AVIF `source`s before it; the reader treats their `srcset` as the image's (§5, preload) |
| `.comic-panel` | Direct children of `.comic-art`, in reading order: `data-panel` counts from 1 and `data-page` is the sheet's. `data-detail` is one of `none`, `zoom`, `text`, `image` and `link`; `data-box` is the manifest's box, four numbers. The inline style is the box in percent, the one inline style R08 allows on this class (D105). A malformed panel stops the reader from starting |
| `data-zoom-src` | On a zoom panel only: the page's original (a raster page) or its one published file (an SVG page), relative (D108) |
| `.comic-panel-label` | The transcript, visually hidden: the control's name |
| `.comic-panel-hint` | Shown on hover and focus only. On a button it is `aria-hidden`; on a link panel it holds the link's label and IC02's external indication, which stay in the link's name |
| Details | A text detail is `div.comic-detail.comic-detail-text#detail-N-M` and an image detail `div.comic-detail.comic-detail-image#detail-N-M`, each after its panel's transcript in the list, where they read without JavaScript and print; the reader moves one into the dialog while it is open and puts it back. There, under the dialog's `h2`, a text detail's headings, `h4`, `h5` and `h6` in the page (D105), are stood in for by headings a level higher, `h3`, `h4` and `h5`, with the same attributes and content, and `comic.css` gives them the look they have in the page; the page's own come back when it closes (W5R-19). A link detail is `p.comic-detail-link#detail-N-M` holding the link; the panel itself is that link. A zoom has no element: it is the art |
| `hidden` | Never in the published markup but on `#comic-detail`. The reader sets it on the sheets of pages not shown |

## 3. Controls

Every control is a `<button type="button">` in `div.comic-tools`, found by id.

| id | Label (strings key) | Behaviour |
| --- | --- | --- |
| `comic-previous` | `previous` | Page view: one page, or one spread, back; guided view: one step back. `disabled` at the start |
| `comic-status` | `no_js` in the markup | A `p` with `role="status"`: `page_of` or `pages_of` in page view, `panel_of` (or `page_of` for a page with no panels) in guided view; `fullscreen_denied` after a refused request |
| `comic-next` | `next` | As Previous, forward. `disabled` at the end |
| `comic-guided` | `guided_view`, then `page_view` | Enters guided view at the first panel of the current logical page; in guided view, returns to page view at the page shown |
| `comic-detail` | `detail` | `hidden` in the markup and in page view. In guided view it shows when the step's panel has a detail, and opens it (a link panel follows its link) |
| `comic-transcript-toggle` | `transcript` | Toggles `comic-show-transcript`, which stays across turns and views; `aria-pressed` `"false"`/`"true"` |
| `comic-fullscreen` | `fullscreen` | As the deck's: the whole page, so the bar stays; exits when already full screen; a refusal writes `fullscreen_denied` |

Without the reader `comic.css` hides every button, so the bar holds the status line alone, saying the pages are all available. The reader re-labels every button from the strings block when it starts. It adds two elements to the bar: `p.comic-hint#comic-hint`, the meta line under it (`panels_hint`, or `panels_hint_one` when the pages shown hold exactly one panel (D130), empty when they hold none, or a panel's transcript when announced), and `p.sr-only#comic-announce` with `role="status"`, where a transcript-only panel's transcript is announced.

## 4. The strings block

As the deck's (its §4): `script#papeleria-strings` with `type="application/json"` exactly, escaped per IC02, the whole strings file of the piece's language. The reader needs, as non-blank strings, `previous`, `next`, `page_of` (`{n}`, `{total}`), `pages_of` (`{a}`, `{b}`, `{total}`), `panel_of` (`{n}`, `{total}`, `{page}`), `guided_view`, `page_view`, `detail`, `close`, `transcript`, `panels_hint` (`{n}`), `panels_hint_one`, its singular for exactly one panel (D130), `fullscreen` and `fullscreen_denied`; without any of them it does not start. It inserts every string with `textContent` and fills placeholders in one pass.

## 5. Behaviour

| Event | Result |
| --- | --- |
| Start | If a page, a panel, a control, the strings or the engine (`window.St.PageFlip`) is missing or malformed, nothing changes: the page stays as published. Otherwise `comic-enhanced` goes on `body` first; the hint and the announcement line join the bar (§3); the book gets `tabindex="-1"`; the buttons are re-labelled; the dialog is appended to `body`; the book is sized to the viewport under the bar and the adapter builds it at the addressed page; images outside the preload window let go of their sources (below). Focus is not moved and an empty address is not written. If the sized book has no width or height, as in a hidden or zero-width frame, the adapter can build no book: the reader takes back every change above and does not start, `window.papeleriaReader` stays absent, and the page stays as published, which it still is when the frame is given room later (W5R-18). An engine that fails to start, or that the adapter refuses as it loads (D103), changes nothing either: the adapter stops what the engine began, removes its block and puts every page back as it found it, and the reader takes back its own changes, does not start, and reports the error once its start is over, so that code after it in the same script, such as the preview's bridge, still runs |
| Layout | The adapter's (IC07, D103): a spread of two pages when the viewport is at least 900 × 500 px and a page in it at least 320 px wide, the cover alone; otherwise one page. `comic-spread` is on `body` while a spread shows. Every page's art is fitted in the engine's page box at its own proportions |
| Page view: turns | Previous, Next, ← →, Home, End; the engine's swipe (40 px, within 30°) and its drag from an edge zone (20 % of the book's width each side), with its curl of about 600 ms; a click in an edge zone. A press that starts on a control never turns (panel actions win): the adapter's `INTERACTIVE` selector, `a[href]`, `button`, `input`, `select`, `textarea`, `label`, `summary`, `[contenteditable]`, `[role="button"]`, `[role="link"]`, a `[tabindex]` other than `-1` and `[data-no-turn]`. Nor does a press while text is selected, with a second finger down, when the page is pinch-zoomed, while the dialog is open or in guided view. Keys are ignored with Alt, Ctrl, Meta or Shift, during composition, after another handler's `preventDefault` and in an editable control (`input`, `textarea`, `select`, a `contenteditable` element); a key at either end does nothing and is not prevented |
| Any change of place | The address becomes `#page-N` (page view; N the logical page) or `#page-N-panel-M` (guided view) with `history.replaceState`, whose refusal on `file://` is caught; the status and the hint follow; focus, when it was in the book and the turn hid it, moves to the first panel shown, else the book; `pagechange` is dispatched (§6) |
| Guided view | Enters at the first panel of the current logical page, or the addressed panel. `div.comic-lens#comic-lens` covers the book and draws the page image (its `currentSrc`) with the box and 4 % of the page around it filling the lens; the book under it is `visibility:hidden`. The step's control is a copy of its panel, without ids, over the whole lens (`.comic-lens-panel`), or, for a page without panels, `div.comic-lens-page` with `role="img"`, `tabindex="-1"` and the page's alternative as its `aria-label`, one step addressed `#page-N`. The lens image is `draggable="false"`, `aria-hidden` and has an empty `alt`: the control names the step. Next, →, the right third and a leftward swipe step on, across pages; Previous, ←, the left third and a rightward swipe step back; Home and End go to the first and last step; the middle third, Enter or Space on the control, and Detail open the step's detail. Every step is instant, whatever the motion setting. Escape returns to page view at the page shown, focus on its panel |
| A panel | Enter, Space, a click or a tap opens its detail in the dialog. A panel without a detail writes its transcript to `#comic-announce` and to the hint, and opens nothing. A link panel is a link: the browser follows it |
| The dialog | `dialog.comic-dialog#comic-dialog` with `aria-modal="true"`, labelled by `h2#comic-dialog-title` (`panel_of`), opened with `showModal`; every other child of `body` is `inert` while it is open, and Tab and Shift+Tab wrap inside it. It holds `button#comic-dialog-close` (`close`), `div.comic-dialog-content` and `p#comic-dialog-transcript`, the panel's transcript, `aria-hidden` under a zoom, whose art it already names. Escape, Close or a click on the backdrop closes it; focus returns to the panel, or to the lens control when it was opened in guided view, and the view is the one it was opened from. A zoom is `div.comic-zoom` (`role="img"`, labelled by the transcript, `tabindex="0"`, `data-no-turn`) holding `img.comic-zoom-art`: the original, cropped to the box at first; pinch, the wheel, a drag, a double tap or double click (1× and 2×), the arrow keys, `+`, `-` and `0` move and zoom it, between the box and eight times it |
| Address on start and on `hashchange` | `#page-N`: page view at N, clamped into range, the address corrected when clamped; `#page-N-panel-M`: guided view at that panel, M clamped into the page's panels, or page view at N when the page has none; `#page-0`, any other `#page-…` fragment, a fragment that is not valid percent-encoding, and one naming nothing: page 1, the address corrected to `#page-1`; a fragment naming an element inside a page (such as `#detail-2-1`): that page, the address kept; one outside the pages (`#comic-main`) is left to the browser, and on `hashchange`, once the browser has taken it in, the current place is written back, which moves neither the page nor focus. A `hashchange` closes the dialog and scrolls the page to the top at once. On start the correction is written from a timer set at `load` (D165) |
| Preload (D114) | The spreads shown, before and after keep their images, with `loading="eager"`; every other page whose image has loaded keeps its `srcset` and `src` in `data-papeleria-srcset` and `data-papeleria-src` and drops them, keeping its `width` and `height`, so the layout never shifts; they are put back when its spread comes near. An image that has never loaded, lazy on a hidden page, is left as published until the reader asks for it: a second after `load`, one image at a time, the reader asks for each page image it has not loaded, outside the pages shown, and lets each go once it has (D115) |
| Resize, rotation, full screen | The book is sized again, the adapter decides the layout again and keeps the logical page, and the arts, the lens and an open zoom are fitted again. A change in the height of the register or the bar (a label, the Detail button, a font arriving) sizes the book again too |
| Reduced motion | The adapter's instant mode, followed live when the setting changes: turns swap at once and the engine's animated calls are never made. Nothing in the reader animates; `site.css` stops every transition |
| Print (D115) | On `beforeprint`, or the print media query turning on, the dialog closes, the adapter is destroyed, every image gets its sources back, every sheet is shown and the enhanced classes are removed: the page prints as published (IC08). A browser does not wait for an image asked for then, so print shows the art of every page whose image has loaded, which is every page from a moment after `load` (Preload, above). On `afterprint`, or the query turning off, the reader starts again at the same place and view; if the book has no room then, or the engine fails to start, the page stays as published until printing next ends (W5R-18) |

## 6. Hook point for the preview bridge

```ts
window.papeleriaReader: {
  readonly version: 1;
  readonly total: number;
  readonly page: number;              // the logical page, 1-based
  readonly panel: number | null;      // guided view's panel; null in page view and on a page without panels
  readonly view: 'page' | 'guided';
  readonly layout: 'single' | 'spread';
  readonly visible: readonly number[];
  readonly transcript: boolean;
  readonly detailOpen: boolean;
  readonly instant: boolean;          // turns are instant: reduced motion
  readonly address: string;           // '#page-N' or '#page-N-panel-M'
  goTo(page: number, options?: {focus?: boolean}): number;
  enterGuided(page: number, panel?: number | null, options?: {focus?: boolean}): void;
  leaveGuided(options?: {focus?: boolean}): void;
}
```

It exists only once the reader has started. `goTo` closes the dialog, returns to page view and shows the page, clamped (NaN changes nothing); `enterGuided` shows a page's panel, clamped, its first when none is given. Neither moves focus unless `options.focus` is `true`, so a preview that follows the editor's cursor never takes focus from the source text; neither writes a history entry.

`pagechange` is a `CustomEvent` dispatched on `document` after every change of place or view, never on start:

```ts
detail: {page: number; previous: number; panel: number | null; view: 'page' | 'guided';
         layout: 'single' | 'spread'; visible: readonly number[]; total: number;
         cause: 'key' | 'button' | 'gesture' | 'hash' | 'api' | 'resize'}
```

`cause: 'api'` marks what the bridge did itself. The types are exported from `reader-logic.ts` as `PapeleriaReader`, `PageChangeDetail` and `PageChangeCause`. The reader handles Escape in the capture phase only while the dialog is open or guided view is shown, and stops it there; any other Escape reaches the bridge (IC06).

In the editor's preview, and only there, `preview-comic.ts`, bundled into `reader-preview.js` after the reader and the bridge (D117), draws Grid and reports the pointer: while Grid is on, the pointer over a page image goes to the editor as `pointer(page, x, y)`, in percent of that image, and its leaving the page images, or the frame, as `pointerLeft` once, so the editor's readout keeps no place the pointer has left (D174). `reader.js` holds none of it.

## 7. What the reader adds

| Name | Where |
| --- | --- |
| `comic-enhanced`, `comic-guided`, `comic-spread`, `comic-show-transcript` | Classes on `body` (§1) |
| `comic-hint`, `comic-announce` | Paragraphs appended to the bar (§3) |
| `comic-lens`, `comic-lens-art`, `comic-lens-panel`, `comic-lens-page` | The guided view (§5) |
| `comic-dialog`, `comic-dialog-body`, `comic-dialog-head`, `comic-dialog-title`, `comic-dialog-close`, `comic-dialog-content`, `comic-dialog-transcript`, and the kit's `button` and `secondary` on Close | The dialog (§5) |
| `comic-zoom`, `comic-zoom-art`, `data-no-turn` | A zoom detail (§5); its image is `draggable="false"` so a drag pans it |
| `data-papeleria-src`, `data-papeleria-srcset` | Images outside the preload window (§5) |
| `papeleria-engine`, and the engine's `stf__parent`, `stf__wrapper`, `stf__block`, `stf__item`, `--left`, `--right`, `--soft`, `--hard`, `--simple` and its shadow elements | Inside `#comic-book`, the adapter's block and the engine's; `destroy()` removes them and puts every figure back (D103) |
| `papeleriaReader` | On `window` (§6). The engine defines `window.St` as it runs (D109) |
| `requestAnimationFrame` | The adapter replaces `window.requestAnimationFrame` with a stub while the engine loads, so the engine's endless frame loop never starts, and puts the browser's back at once (D103); the adapter runs the frames itself |
