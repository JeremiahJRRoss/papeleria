# Deck client contract

Revision 4 · 2026-09-28 · Written by session W1C at M1.6; revised by W1R (the notes aside's strings, D161; the stacked-view keys, address-driven changes and the skip link's address, D164(j)), by W5C at M5.4 (the singular stacked-view status, D130; the deck's own no-JS status, D131) and by W5E (the preview's overflow check, D167, D174). Decisions D50–D54, D130, D131, D161, D164, D167 and D174 in `docs/DECISIONS.md`, in the development record, Dev_Papeleria, which is not public.

This is what the deck renderer (M1.5) must emit for `deck.js` to work, and what the preview bridge (M2) may rely on. The client is [`deck.ts`](deck.ts) with its pure half in [`deck-logic.ts`](deck-logic.ts). `npm run build` bundles them into `lib/clients/deck.js`, one classic script that the pipeline copies into `dist/` beside `index.html`. The reference deck, `reference/decks/brand-overview.html`, already has this shape except where the table in §7 says otherwise.

`test/unit/deck-client.test.ts` reads every id, class, attribute, element and event name the bundle passes as a string to a DOM lookup, a class list, an attribute method or an event constructor (in place, through a string constant, or through a helper that hands its one parameter to a lookup), and every property it sets on `window`, and fails if this file does not mention one of them. Names built at run time, such as `slide-N`, are written down here by hand. `test/browser/deck.test.ts` drives the contract in Chromium, Firefox and WebKit against a fixture built from the reference deck.

## 1. The page

| Element | Required | Notes |
| --- | --- | --- |
| `html[lang]` | yes | From the manifest's `language`; the client does not read it |
| `body` | yes | Carries no state class in the published markup. The client adds `deck-enhanced` and toggles `show-slide-notes` |
| `a.skip-link[href="#deck-main"]` | yes | Text is the `skip` string, rendered by the renderer. The client never touches it, and it leaves the `#deck-main` fragment to the browser, then names the current slide in the address again (§5) |
| `main.deck#deck-main` | yes | Holds the slide articles in order |
| One `script[src="deck.js"]` | yes | Relative URL, classic script, **no** `type="module"`. Either `defer` in `<head>` (as the reference does) or at the end of `<body>`; the client waits for `DOMContentLoaded` if the document is still loading. No other executable script on the page (IC07, C22) |

Resources the client itself loads: none. It makes no request of any kind.

## 2. Slides

Each slide, in order, is:

```html
<article class="deck-slide slide-layout-LAYOUT" id="slide-N" aria-labelledby="title-N">
  <div class="slide-canvas">
    <div class="slide-register"><span>…</span><span class="wordmark">…</span></div>
    <h2 class="slide-title" id="title-N" tabindex="-1">…</h2>
    <p class="slide-lead">…</p>
    <div class="slide-content">…</div>
    <footer class="slide-footer"><span>…</span><span>NN / TOTAL</span></footer>
  </div>
  <aside class="slide-notes" aria-label="…">…</aside>
</article>
```

| What | Rule |
| --- | --- |
| `.deck-slide` | Every slide article. N counts from 1 in document order. **Ids that begin with `slide-` are reserved for these articles**: the client reads any `#slide-…` fragment as a slide reference (D54) |
| `.slide-title` | Required inside every article; without one the client does not start. It receives focus on every slide change, so it carries `tabindex="-1"` (the client sets it when the markup lacks it, but the renderer should emit it so the no-JS and enhanced DOM agree). A `<br>` inside it reads as a space in the status line (D54); an `aria-hidden="true"` descendant is left out of the status |
| `.slide-canvas` | The surface a touch swipe must start on (UX §05) |
| `.slide-notes` | Hidden by `slides.css` only when `body.deck-enhanced` is present and `show-slide-notes` is absent, so notes are visible without JavaScript. The renderer takes its `aria-label` from the `notes_label` string and the `<strong>` label that begins it from `notes_heading` (D161); the client reads neither |
| `hidden` attribute | Never in the published markup. The client sets it on every slide but the current one; `site.css` makes `[hidden]` `display:none` and `slides.css` prints every slide regardless |

## 3. Tools

The tools row is the reference's `div.deck-tools`; the UX calls for a `nav`, and either works because the client finds the controls by id alone. Each control is a real `<button>`; `type="button"` is recommended.

| id | Label (strings key) | Client behaviour |
| --- | --- | --- |
| `prev-slide` | `previous` | Previous slide; `disabled` on the first slide |
| `next-slide` | `next` | Next slide; `disabled` on the last slide |
| `all-slides` | `show_all`, then `show_one` | Toggles the stacked view; `aria-pressed` `"false"`/`"true"` |
| `toggle-notes` | `show_notes`, then `hide_notes` | Toggles `body.show-slide-notes`; `aria-pressed` `"false"`/`"true"` |
| `full-deck` | `fullscreen` | Requests fullscreen on the whole page, so the tools stay; exits when already fullscreen. A refusal or a missing API writes `fullscreen_denied` to the status and changes nothing else |
| `print-deck` | `print` | `window.print()`; `slides.css` prints one slide per A4 landscape page |
| `deck-status` | `no_js_slides` in the markup | A `p.deck-status` with `role="status"`. Its published text **must be the `no_js_slides` string** (D54, D131). The client replaces it with `slide_of`, or in the stacked view with `all_shown`, or `all_shown_one` for a deck of one slide (D130) |

The renderer emits every label from the strings of the piece's language, and `aria-pressed="false"` on the two toggles. The client re-labels all six buttons from the strings block on start, so a stale label cannot survive enhancement. If any of the seven ids is missing, or is not the element listed, the client does not start.

## 4. The strings block

```html
<script type="application/json" id="papeleria-strings">{"previous":"Previous",…}</script>
```

| Rule | Detail |
| --- | --- |
| Element | `script#papeleria-strings` with `type="application/json"` exactly, so it never executes and does not count as a script (IC07) |
| Place | Anywhere before `deck.js` runs; the `<head>` is simplest |
| Content | One JSON object. It must hold, as non-blank strings, `previous`, `next`, `show_all`, `show_one`, `show_notes`, `hide_notes`, `fullscreen`, `fullscreen_denied`, `print`, `slide_of` (with `{n}`, `{total}` and `{title}`), `all_shown` (with `{total}`) and `all_shown_one`, its singular, for a count of exactly one (D130). Other keys are ignored, so the whole strings file may be emitted |
| Source | `templates/shared/strings.en.json` or `strings.es.json`, chosen by the manifest's `language`. The client contains no interface text of its own |
| Escaping | IC02: after `JSON.stringify`, replace `<`, `>`, `&`, U+2028 and U+2029 with `\u003c`, `\u003e`, `\u0026`, `\u2028` and `\u2029`, so no value can close the element or start a comment |
| Failure | A missing block, invalid JSON, a missing or blank key: the client does not start and the page stays exactly as published |

The client inserts every string with `textContent` and fills placeholders in a single pass, so a value or a title that contains markup, `$&` or a literal `{total}` appears as written.

## 5. Behaviour

| Event | Result |
| --- | --- |
| Start | `deck-enhanced` is added to `body` before anything else changes; every title gets `tabindex="-1"`; buttons are re-labelled; all slides but the addressed one get `hidden`; the status reads `slide_of`. Focus is not moved and an empty address is not written |
| ← ↑ PageUp · → ↓ PageDown · Home · End | Previous · next · first · last. In the stacked view ↑ and ↓ are left to the browser so the page scrolls, and the other keys count from the slide in view, the last one whose top edge has reached the upper third of the viewport; their slide is brought to the top and focused even when it is already the current slide (D53). A key the deck does not act on, past either end or Home and End on the slide already shown, is not prevented, so it keeps its browser behaviour. Ignored with Alt, Ctrl, Meta or Shift held, during IME composition, after another handler called `preventDefault`, in `input`, `textarea`, `select` or contenteditable, and inside an element that scrolls on its own within a slide, such as a wide `.table-wrap` region (D53). Escape is never handled, so the preview's Escape order (IC06) is untouched |
| Swipe on `.slide-canvas` | One finger, at least 40 CSS px in a straight line, within 30° of horizontal, both inclusive: a leftward swipe shows the next slide, a rightward one the previous. Ignored when text is selected at the start or the end, with a second finger down, when the page is pinch-zoomed, and when it starts in an editable control or a scroll region. In the stacked view it moves relative to the slide swiped, and that slide's neighbour is brought to the top and focused even when it is already the current slide (D53); a swipe outwards on the first or last slide does nothing |
| Any slide change | Writes `#slide-N` with `history.replaceState` (no history entry; a refusal on `file://` is caught and the slide still changes), updates the status, moves focus to the title with `preventScroll`, so the page does not move, and dispatches `slidechange`. When the address brought the change (script, address bar or history), Chromium and WebKit would scroll to the newly shown article by themselves; in the single view the client keeps the page where it was, restoring the position at once on each of the next three frames. In the stacked view the slide is first scrolled to the top of the viewport, instantly. At either end nothing happens |
| Address on start and on `hashchange` | `#slide-N` shows slide N; a positive N past the end shows the last slide and corrects the address; `#slide-0` and any other `#slide-…` shows slide 1 and corrects the address; a fragment naming an element inside a slide (such as `#title-5`) shows that slide and keeps the address; a fragment naming an element outside the slides (`#deck-main`) is left to the browser, and on `hashchange`, once the browser has taken it in, the client writes the current slide's `#slide-N` back with `replaceState`, which moves neither the page nor focus, so a reload stays on that slide; a fragment naming nothing shows slide 1 and corrects the address to `#slide-1` (IC07, UX C5). On start the slide shows at once, but the correction is written from a timer set at `load` (set at once if the page has already loaded): Chromium and WebKit scroll to whatever the address names when parsing ends, and WebKit, when a stylesheet is still loading then, does so in a task queued as the last one arrives, which can run after `load`; a correction written any earlier would move the page (D165). A bridge that reports the address should read it once that timer has run, in a later task than `load` |
| Resize, rotation, reduced motion | Nothing. The client adds no transition or animation. Its scrolls (the stacked view's jump, a fragment inside a slide, putting the page back after an address change) are instant even though `site.css` sets `html{scroll-behavior:smooth}`: each sets `scroll-behavior: auto !important` in the inline `style` of `<html>` for its duration, then restores what was there |

## 6. Hook point for the preview bridge

The bridge (W3A, `templates/shared/preview-bridge.ts`) is not part of the published client. It may rely on:

```ts
window.papeleriaDeck: {
  readonly version: 1;
  readonly total: number;      // slide count
  readonly current: number;    // 1-based
  readonly showAll: boolean;
  readonly notes: boolean;
  goTo(slide: number, options?: {focus?: boolean}): number;
}
```

`window.papeleriaDeck` exists only once the deck has been enhanced; if it is absent the deck did not start. `goTo` clamps its argument into range (NaN changes nothing), writes the address, updates the status and dispatches `slidechange`, and returns the slide now shown. It moves focus to the title **only** when `options.focus` is `true`, so a preview that follows the editor's cursor never takes focus from the source text. For the same reason the bridge should call `goTo` for a `goto(Target)` message rather than assign `location.hash`, which counts as a reader's navigation and moves focus.

`slidechange` is a `CustomEvent` dispatched on `document` (listen there; it does not bubble to `window`) after every slide change, never on start, never for the two toggles:

```ts
detail: {slide: number; previous: number; total: number; showAll: boolean; notes: boolean;
         cause: 'key' | 'button' | 'swipe' | 'hash' | 'api'}
```

`cause: 'api'` identifies changes the bridge made itself, so it can ignore them when mirroring the preview back to the editor. The types are exported from `deck-logic.ts` as `PapeleriaDeck`, `SlideChangeDetail` and `SlideChangeCause`; importing them as types adds nothing to a bundle. The deck never handles Escape and never stops an event's propagation, so the bridge's own `keydown` handling for IC06 is unaffected.

In the editor's preview, and only there, [`preview-deck.ts`](preview-deck.ts), bundled into `deck-preview.js` after the client and the bridge, finds the slides whose content does not fit their printed page (IC08, D167). When the bridge dispatches `papeleria-preview-loaded`, once its first `ready` has gone, it loads every font face the page declares, lays the deck out as it prints (the stylesheets' print rules applied, a rule for a width judged at the printed page's width of 281 mm) and measures each `.slide-canvas` as the print suite does: it scrolls, or something in it reaches past its edges. It puts every rule, the root's style and the scroll position back in the same task, before anything is drawn, and dispatches `papeleria-preview-overflow` with `{slides}`, the slide numbers in order, which the bridge sends to the editor as `overflow(slides)`; the editor names them in its status line (D174). `deck.js` holds none of it, byte for byte the published client.

## 7. Differences from the reference deck the renderer must make

| Reference (`reference/decks/brand-overview.html`) | Generated output |
| --- | --- |
| `<script src="../../theme/js/slides.js" defer>` | `<script src="deck.js" defer>` (or at the end of `<body>`) |
| No strings block | `script#papeleria-strings` per §4 |
| Status text "All slides are available without JavaScript." | The `no_js_slides` string of the piece's language, which in English is the reference's sentence (D54, D131) |
| Titles without `tabindex` | `tabindex="-1"` on every `.slide-title` |
| Skip link text "Skip to slides" | The `skip` string |
| `../../theme/...` stylesheet and favicon paths | Relative paths inside `dist/` |

Everything else the client touches — the ids, the classes, `aria-labelledby`, `aria-pressed` on the toggles and `role="status"` — is already in the reference and stays as it is.
