# Reference compatibility and provenance

Revision 1 · 2026-09-22.

reference/ is immutable source-kit material. It supports design comparison and explains earlier decisions; it is not the current Papeleria implementation specification. Do not edit historical pages/guides to conceal a mismatch.

## Authority by source

| Source | Use in Papeleria | Boundary |
| --- | --- | --- |
| theme/css, design-tokens.json, fonts, JS | Reusable visual/source assets; tokens.css is token authority | Core behavior must implement current contracts; copying an old script is not acceptance evidence |
| reference/decks/brand-overview.html | A4 structural/text/notes and visual baseline for 16 slides | Explicit differences below require a reviewed comparison allowlist |
| reference/decks/work-conversation.html and SLIDE_OUTLINES | Additional layout/content examples | Not an extra required worked-example deliverable |
| reference/documents/professional/project-report.html | Document visual hierarchy, spacing, metadata and print appearance | Static hand-composed sheet numbers are not a pagination engine |
| Other professional/marketing HTML | Design examples and block styles | Historical editable fields/inline scripts and specialized calculations do not enter the three-template MVP by default |
| reference/manifests/blocks.yaml | Historical illustration of the source kit's blocks | Not a schema-1 piece fixture; do not feed it to papeleria check as a complete piece |
| reference/guides and their sources | Historical voice, rights, source and design context | Rust build commands, original site layout, deployment/Pages instructions and absent original-site links are not active Papeleria setup requirements |

The Folio PRD and tooling research cited in earlier drafts are not included in this repository; do not invent their contents or treat their citations as reviewed source. Current behavior is defined in docs/ revision 1 and DECISIONS/IMPLEMENTATION_CONTRACTS.

## Deliberate differences to test

| Difference | Current requirement / evidence |
| --- | --- |
| Configurable brand | Default papeleria matches theme/brand.default.json; owner mark inventory and public/client exceptions follow D05. Citations of Ross.moda are preserved |
| Type weights | Poppins 600 for display h1/h2/deck title matches shipped CSS; quote weight 500 and document callout body weight 400 follow their selectors. Verify computed styles, not only DOM tags |
| Deck behavior | Added swipe/title focus/localized status and controls; maintain all slide text, classes and notes. Use a narrow A4 diff allowlist |
| Deck script (`theme/js/slides.js` → `lib/clients/deck.js`) | The port keeps every kit behaviour and deliberately changes these: ↑ and ↓ turn slides as UX §05 and C4 list, but stay native in the stacked view; keys work on focused buttons and links, and Shift counts as a modifier; the status reads a title's line break as a space; labels and statuses come from the strings block, including `fullscreen_denied` where the kit had its own "unavailable" sentence; Home and End scroll the stacked view to their slide, instantly, although `site.css` sets smooth scrolling; in the stacked view ←, →, PageUp and PageDown count from the slide in view, and a key the deck does not act on keeps its browser behaviour; out-of-range and malformed addresses are clamped and corrected (IC07) without scrolling the page, and a slide change from the address never scrolls it; after the skip link the address names the current slide again; focus moves to the title. The markup the client needs differs from the reference as `templates/deck/client/CONTRACT.md` §7 lists: the strings block, `tabindex="-1"` on titles, the skip link's text (the `skip` string, "Skip to content", where the reference reads "Skip to slides") and the script name. The no-JavaScript status is the `no_js_slides` string, which in English is the reference's own sentence (D131). The notes aside's `aria-label` and label come from `notes_label` and `notes_heading`, which match the reference's English text (D161). D53, D54, D164(j) |
| Chart/image layouts | New in MVP; dedicated fixtures supplement the brand reference, which does not demonstrate all new layouts |
| Comic | Reader/panel/guided/engine behavior is new; historical format label alone is not a working baseline |
| Document scripts | Generated document has no executable script. Historical contenteditable widgets/inline actions are replaced by author-file content |
| Video | Native user-started document video; historical visibility/autoplay interaction is not retained |
| Reduced motion | Instant navigation, no UI transition. Historical crossfade prose is superseded |
| Physical pagination | Browser flow plus explicit starts; no generated physical N/total, no clipping long content. Long print fixtures replace a page-count-only test |
| URLs | Local resources, allowed reader-clicked outbound links; original-site navigation links are not copied blindly into standalone pieces |
| Distribution | Required notices/font licenses accompany outputs; original HTML references alone do not prove redistribution inventory |

## Proposed A4 allowlist entries from the brand-overview transcription

Proposed by W1D (D55) for W2B, which accepted, narrowed or rejected each one when it wrote the A4 allowlist (D70); the outcome is in the last column, and the entries themselves are in the A4 allowlist section below. Each is reference content the manifest cannot express. `npm run check:brand-overview-content` lists the page-level items on every run, and fails on any slide text that no manifest field or documented template content accounts for, so this list is complete for the slides' text nodes. Differences in page chrome and attributes are listed here and in `templates/deck/client/CONTRACT.md` §7; the skip link's text and the notes aside's labels are covered there and by D161.

| Reference content | Why the manifest cannot express it | Proposed treatment | Outcome (W2B, D70) |
| --- | --- | --- | --- |
| Page `<title>`: "Brand overview · Papeleria slides" | The manifest `title` is the cover title (PRD §02, D55); no field names the page separately | Allow exactly the generated title: the manifest title with its line break read as a space ("Craft with care. Build for the long view."), in the form W2A records. W2B pins that string; any other text fails | Accepted as proposed: `page-title` pins the string |
| The comment before `<html>`: "Papeleria starter. Adapted from the Ross.moda design language kit…" | A comment is not content, and a piece has no field for one | No entry if the comparison reads elements only; otherwise allow it by its exact text | Rejected: the comparison reads the doctype and the elements only, so no entry is needed |
| `header.deck-header` and `<meta name="robots" content="noindex,nofollow">` | Chrome of the kit's own example page | Generated output omits both (execution plan, refinement 5): allow their absence, and nothing else about them | Accepted: `kit-header` pins the header's exact markup, `robots-meta` the meta's two attributes |
| Notes label boundary: on slides 3 and 8 the notes text follows "Speaker notes & source detail" after a space, on the other fourteen after a newline | Whitespace inside template chrome; a notes file holds only the text after the label | Normalize whitespace at the label boundary; the label text itself stays compared, text for text | Narrowed: `notes-label-boundary` allows only a space where the kit has a newline, only there, on exactly 14 slides |
| Notes line structure: each aside holds newline-separated text shown with `white-space: pre-line`, while the piece's Markdown notes render one `p` per line | Markdown notes are paragraphs, so the renderer emits elements where the kit has newlines. The match is structural: the same lines, text for text. The spacing a reader sees differs — paragraph margins where the kit has line breaks — and only in the notes view and without JavaScript; print leaves notes out | Compare the notes as an ordered list of paragraphs, one per reference line, each compared exactly, never as one whitespace-normalized string (adjacent paragraphs would run together). This allows `p` elements inside `.slide-notes`; it ignores no notes text. The renderer keeps whitespace between the label and the first paragraph | Accepted: `notes-paragraphs` allows the form alone; every line is compared exactly with its paragraph, and markup, text or whitespace between paragraphs fails |

## Deck renderer output (W2A, M1.5)

Every deliberate difference between a page `templates/deck/render.ts` writes and `reference/decks/brand-overview.html`, beyond those `templates/deck/client/CONTRACT.md` §7 and the proposed entries above already list. W2B's A4 comparison allows exactly these. `test/unit/deck-render.test.ts` compares the rendered brand-overview piece with the reference slide by slide (layout class, title, lead, register, footer text, counter and slide content).

| Difference | Current requirement / evidence |
| --- | --- |
| Page `<title>` | The manifest title as plain text: `InlineText.text`, a line break read as a space and inline markup dropped, with nothing added. For brand-overview: "Craft with care. Build for the long view." The reference's "Brand overview · Papeleria slides" is the proposed entry above; this is the form it names (D69) |
| Kit header and robots meta | Both omitted, and nothing stands in for the header: the skip link is followed directly by the tools. As proposed above |
| Doctype | `<!DOCTYPE html>`, where the reference writes `<!doctype html>`: html-validate's `doctype-style` (D65) |
| Head | `<meta name="generator" content="Papeleria <version>">` added (IC07, D69); `theme/css/base.css` linked after `slides.css` (D62); every path relative inside the output, so `../../theme/…` becomes `theme/…`; the strings block and `deck.js` in place of `../../theme/js/slides.js` (CONTRACT §7) |
| Tool buttons | `type="button"` on all six: html-validate's `no-implicit-button-type` (D65). `base.css` hides them until `deck.js` has enhanced the page; the status line stays (D69) |
| Slide articles | `data-source-line-start` and `data-source-line-end` on every article: the slide's lines in the manifest, which the editor's preview follows (IC06) and R08 reports as the related location (D65). Each article starts a line of its own, so the whitespace between elements differs |
| Slide footer | A third span, `span.slide-status`, holds the localized status label between the footer text and the counter (D61) |
| `class="slide-columns "` | The three-column slides write `class="slide-columns"`: the reference's trailing space is gone, the class list is the same |
| Notes | Paragraphs after the label, one space between (the notes entries above). A slide with no notes has no aside (D69); every reference slide has notes, so the comparison is unaffected |
| Cover credits | A deck's `credits` render as `dl.slide-credits` on the cover above the footer (UX §05, D69). The brand-overview manifest has none (D55), so its cover matches |
| Attributes items | Markup unchanged; `base.css` shows each item's `<strong>` label as a block, where the kit's inline label ran into its text (D69). Slides 5 and 15 of brand-overview look different: W2B's visual comparison allows that change and nothing else on them |
| Chart, table and image slides; a logo in the register | New markup (D64): `figure.chart-figure`, `figure.table-figure`, `figure.image-figure` with `picture`, and `img.slide-logo`. The reference demonstrates none of them; `test/fixtures/deck/layouts/` holds the exact markup |

## A4 allowlist (W2B, M1.9, D70)

`test/golden/brand-overview.allowlist.json` names every difference `test/browser/golden/brand-overview.test.ts` may find between `examples/brand-overview`, built by the CLI, and `reference/decks/brand-overview.html`, both opened from disk in Chromium with JavaScript off. The comparison (`test/golden/dom-compare.ts`) reads the doctype and every element from `<html>` down — tag, id, ordered class list and every other attribute — and every text node with runs of ASCII whitespace collapsed; it reads each notes aside apart: the label exactly, the whitespace after it, and its lines or paragraphs as an ordered list, each exactly, and it reports any attribute or markup on the label or a paragraph, or anything else in the aside, as stray, which no entry can allow. It does not read comments. A difference is allowed only when exactly one entry covers it, and an entry must cover exactly the number of differences it states, so no entry can hide more than it names or outlive its difference. An entry for a missing or extra element names its whole canonical markup or, when the element holds no other element, its text and exact attributes; an element with markup inside is covered only by its whole markup. The slides' text, classes, ARIA and links, and every line of the notes, have no entry: they must match.

| Entry | Difference | Count | Justification |
| --- | --- | --- | --- |
| `page-title` | `<title>` reads "Craft with care. Build for the long view." where the reference reads "Brand overview · Papeleria slides" | 1 | The manifest title as plain text, its line break read as a space (D69); the proposed entry above, pinned |
| `robots-meta` | No `<meta name="robots" content="noindex,nofollow">` | 1 | Kit page chrome; a piece is for publishing. Proposed above |
| `generator-meta` | `<meta name="generator" content="Papeleria <version>">`, the package's version | 1 | IC07, D69 (W2A table, Head) |
| `local-paths` | The favicon and the four kit stylesheets link `theme/…` where the reference links `../../theme/…` | 5 | The same files, relative inside `dist/` (CONTRACT §7, D62); only that prefix may change |
| `base-stylesheet` | `<link rel="stylesheet" href="theme/css/base.css">` after `slides.css` | 1 | D62 (W2A table, Head) |
| `strings-block` | `script#papeleria-strings` of `type="application/json"`, holding exactly the piece's strings file | 1 | CONTRACT §4 and §7, IC02, C22 |
| `deck-script` | The page's one script is `deck.js` where the reference loads `../../theme/js/slides.js` | 1 | CONTRACT §7, D50, D62 |
| `skip-text` | The skip link reads the `skip` string where the reference reads "Skip to slides" | 1 | CONTRACT §7 |
| `kit-header` | No `header.deck-header`, whose heading and `../../README.md` link are pinned exactly | 1 | Kit page chrome (execution plan, refinement 5), with nothing in its place. Proposed above |
| `tool-button-type` | `type="button"` on the six tool buttons | 6 | D65, html-validate's `no-implicit-button-type` (W2A table, Tool buttons) |
| `source-lines` | `data-source-line-start` and `data-source-line-end` on each article, each equal to that slide's lines in `papeleria.yaml` from the report's targets | 32 | IC06, D65 (W2A table, Slide articles) |
| `title-tabindex` | `tabindex="-1"` on each slide title | 16 | CONTRACT §2 and §7 |
| `slide-status` | A `span.slide-status` between the footer text and the counter, with no attribute but its class and nothing inside it but the `status_review` label | 16 | D61 (W2A table, Slide footer) |
| `notes-label-boundary` | One space between the notes label and the first paragraph where the kit has a newline | 14 | The notes label boundary, narrowed (above); on slides 3 and 8 the kit already has a space |
| `notes-paragraphs` | Each aside's lines are `p` elements, one per reference line, where the kit has newline-separated text | 16 | The notes line structure (above, D55); each paragraph is compared exactly with its line |
| `configured-wordmark` | The register's wordmark on each slide and the two samples on the wordmark slide show the configured wordmark | 18, and 0 while it is `papeleria` | D04, D05. With the repository's defaults the build shows `papeleria`, as the reference does, and the entry covers nothing; it lets an owner's `brand/brand.json` change those 18 texts and nothing else |

Not needed: the doctype's case, since the comparison reads the doctype's name; the comment before `<html>`, rejected above; the trailing space of `class="slide-columns "`, since class lists are compared; and cover credits, slides without notes and the chart, table, image and logo markup, which this piece does not have.

Screenshots (D70): the committed baselines under `test/golden/baselines/brand-overview/` are the built deck, not the reference, captured in CI and pending the design maintainer's review against the reference (`REVIEW_PENDING.md` there). They show three deliberate differences from the kit: the status label in every footer (D61), each attributes label on a line of its own on slides 5 and 15 (D69), and, at 390 px, a footer whose text and status wrap between words while the counter stays whole (D73). Nothing on the captured slides varies from run to run, so nothing is masked.

## Document renderer output (W3B, M3.1)

Every deliberate difference between a page `templates/document/render.ts` writes and `reference/documents/professional/project-report.html`. The reference is a hand-composed template with bracketed fields; the renderer fills the same structure from a piece's files. `test/unit/document-render.test.ts` holds the page's markup (`test/fixtures/document/page.html`), and `test/browser/document.test.ts` the kit's computed styles in three engines.

| Difference | Current requirement / evidence |
| --- | --- |
| Historical widgets and kit chrome | Absent: the comment before `<html>`, `<meta name="robots">`, the `.editor-toolbar` with its buttons and notes, every `span.edit-field[contenteditable]` (the author's files fill the fields), `data-filename` on `body`, and the closing inline script. A document has no script of any kind (C22, D94) |
| Head | `<!DOCTYPE html>` (D65); `<meta name="generator" content="Papeleria <version>">` added; `<title>` is the takeaway as plain text where the reference reads "Project report · Papeleria"; the reference's `meta description` has no manifest field and is not written. The reference's inline stylesheets become linked files, in order `theme/css/fonts.css`, `tokens.css`, `site.css`, `print.css` (`media="print"`) and `base.css` (D94), so the kit's rules come from its own files rather than a copy |
| Quote | 1.5rem, from `theme/css/site.css`, where the reference page's inline rule and UX §07 have 1.65rem (D90) |
| Metadata | Two columns at every width, as the kit and the reference style it, where UX §07 draws four (D90); the manifest's labels and values, then the credits |
| Sections | Each is a `section.doc-section` with its manifest lines (`data-source-line-*`); its `h2` has the slug as id (IC07, D95) and its text links to that address (`a.doc-anchor`). The reference's headings are bare `h2`s inside `.doc-content` (D94) |
| Sheet titles | The reference's second sheet opens with `h2.document-page-title`; no manifest field names a sheet, so a sheet opens with its first section's heading, and that class and its inline style are not written |
| Footer | The footer text, when the manifest gives one, then `span.doc-status` with the status label. The reference's "01 / 02" and "02 / 02" are not written: no generated physical or sheet N/total (IC08) |
| Skip link | Its text is the `skip` string ("Skip to content"), where the reference reads "Skip to document"; its target, `#document`, is the same |
| Tables | The shared table block (D64): the region is named by its section's heading (`aria-labelledby`) where the reference writes `aria-label="Scrollable reference table"`; header cells come from the CSV or the manifest's column labels; numbers align right (`td.num`) |
| Blocks | Charts, images, video, quotes, notes, callouts and logos in a section are new markup (D64, D97); the reference shows only its tables, and other kit documents the note and callout styles. `base.css` adds only the rules D90 and D98 list, print ones included |

## Link and snapshot policy

Active Markdown links must resolve to present files, or be explicit external primary sources. Future implementation/test paths use code formatting and a due milestone, not broken clickable links. References within immutable historical HTML/guides may point to the original site's unprovided directories; these are known provenance limitations, not instructions to fetch or recreate that site.

The 2026-09-22 readiness review remains unchanged as the baseline audit. Its original inventory and 68/100 grade describe the pre-remediation snapshot. The current remediation record states what changed and what remains untested.

MANIFEST.sha256 is a scoped snapshot of the repository root, not a checksum of every Git blob. It excludes itself, Git/macOS metadata, dependencies, generated lib and piece dist/.papeleria. Font binaries are included. The missing .gitignore identified by the original review is now supplied. Regeneration must hash actual bytes and run verification after all document changes.
