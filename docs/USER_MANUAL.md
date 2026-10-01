# User manual

[README](../README.md) · [Installation](INSTALLATION.md) · [Architecture](ARCHITECTURE.md) · [Licensing](LICENSING.md)

For Papeleria 0.1.0, manifest schema 1. This manual covers creating, editing, checking, sharing, and reading all three formats. Commands assume `papeleria` is installed; for a source checkout, substitute `node lib/src/cli/index.js` while in the repository root. For a local tarball installation, substitute `npm exec --offline -- papeleria`.

## Contents

1. [First piece](#first-piece)
2. [Folders and manifests](#folders-and-manifests)
3. [The editor](#the-editor)
4. [Text and links](#text-and-links)
5. [Decks](#decks)
6. [Documents](#documents)
7. [Comics](#comics)
8. [Data and shared blocks](#data-and-shared-blocks)
9. [Images, video, and rights](#images-video-and-rights)
10. [Check, build, and publish](#check-build-and-publish)
11. [Reading and printing](#reading-and-printing)
12. [Diagnostics and troubleshooting](#diagnostics-and-troubleshooting)
13. [Command reference](#command-reference)

## First piece

```sh
papeleria new deck my-deck
papeleria edit my-deck
```

`new` copies a working sample into a new or empty folder. A nonempty destination is refused. Use `comic` or `document` in place of `deck` for the other formats.

1. In the editor, find the first entry in `slides` and change its `title`. The top-level `title` is also used as the browser page title; change that separately.
2. The preview refreshes after a short pause. Fix any error listed below the source editor.
3. Choose **Save all**, then **Build**. Build requires saved files and no unresolved conflicts.
4. Open `my-deck/dist/index.html` directly in a browser. The published page works without the editor.
5. Keep the source folder. To share the result, copy or ZIP the complete `dist/` folder.

Save before closing or reloading the editor. Stop it with **Ctrl+C** in its terminal. The sample is a starting point: replace its content, descriptions, and rights statements with your own accurate material before publication.

## Folders and manifests

A **piece** is one folder with one manifest and its referenced assets.

| Path relative to the piece | Purpose |
| --- | --- |
| `papeleria.yaml` **or** `papeleria.json` | The single manifest; never keep both |
| `assets/text/` | UTF-8 Markdown files; subfolders allowed |
| `assets/data/` | CSV files directly in this folder |
| `assets/images/` | Images and comic art; subfolders allowed |
| `assets/images/logos/` | Client logos used by a logo field |
| `assets/video/` | MP4 or WebM files directly in this folder |
| `dist/` | Complete generated output; replaced by a successful build |
| `.papeleria/` | Generated cache, staging, preview files, and editor backups |

Use forward slashes in manifest paths on every operating system. Referenced filenames are case-sensitive and use ASCII letters, digits, hyphens, underscores, and interior periods. Do not use spaces, leading/trailing periods, `..` segments, absolute paths, backslashes, symlinks, or reserved Windows device names. Extensions are lowercase. The relative path limit is 240 characters; an individual segment cannot exceed 255.

Use two-space indentation in YAML. Papeleria accepts one YAML 1.2 document with string keys and no duplicate keys, aliases, anchors, merge keys, or custom tags. JSON must be strict JSON: no duplicate keys, comments, or trailing commas. All object fields are checked; an unknown or misspelled field is an error. An optional field may be omitted, but a supplied text value must contain visible text.

### Common fields

Every manifest takes these fields plus those for its template:

| Field | Required | Value |
| --- | --- | --- |
| `schema` | Yes | Number `1` |
| `template` | Yes | `deck`, `comic`, or `document` |
| `title` | Yes | Nonempty inline Markdown title |
| `language` | No | `en` by default, or `es`; selects published control labels and page language, not automatic translation |
| `status` | No | `draft` by default; also `review`, `published`, `withheld` |
| `wordmark` | No | Plain text replacing the theme's default wordmark text |
| `credits` | No | List of objects, each with required plain-text `role` and `name` |

Credits appear on deck covers, the comic's last page, and document metadata. The default theme wordmark is `papeleria`. Template-specific visible titles still need editing where they occur.

### Input limits

All listed limits are inclusive.

| Input | Maximum |
| --- | --- |
| Manifest | 1 MiB, 32 nested collections |
| Slides, pages, or sections | 1,000 per piece; at least one required |
| Each Markdown or CSV file | 5 MiB |
| All resolved Markdown | 20 MiB; a referenced file counts again for each use |
| CSV data rows | 100,000 per file |
| Each source image or video | 100 MiB |
| Decoded image | 100 million pixels |
| Video duration | Greater than zero and no more than 15 seconds |

These input limits are separate from the smaller [published-output budgets](#output-budgets).

## The editor

`papeleria edit my-deck` starts the editor on this computer and opens your browser. Leave the terminal running. `--port 4321` chooses its port; omit the option to use a free one. Preview content uses a separate automatically selected local port.

### Opening and reconnecting

The terminal prints an address containing a one-time access token. Open the newest address on the same machine; it expires after two minutes and cannot be reused. A successful opening causes the terminal to print a fresh address for another opening. Keep these links private: they allow access to this editor session.

A tab can resume after a reload using its one-time resume token, but **unsaved buffers do not survive reload**. If an address is expired or already used, paste the newest terminal address into that tab. If the server has restarted, save or copy any unsaved text before opening a fresh session. A temporary disconnection retains buffers and retries; it does not make them durable backups.

### Controls and files

| Control | Behavior |
| --- | --- |
| **Open a file** | Opens Markdown in editable tabs or a read-only CSV preview, limited to its first 500 data rows |
| **Save** | Saves the active editable file |
| **Save all** | Saves dirty files in order; stops if a file conflicts |
| **Check** | Validates the current manifest and unsaved Markdown overlays; leaves `dist/` unchanged |
| **Build** | Builds saved source into `dist/`; disabled while files are dirty or conflicts remain |
| **Keys** | Shows the editor's keyboard help |
| **Follow** | Moves the preview to the slide, section, page, or panel associated with the source cursor |
| **Grid**, for comics | Adds a 10% grid and pointer coordinates to help measure panel rectangles |
| Preview width choices | 390, 834, or 1280 pixels |

Create, rename, or delete files with your normal file manager or text editor; Papeleria's file picker does not perform those operations. Edit CSV data outside Papeleria, then save it to refresh the preview.

Use **Ctrl+Space** for completion after a field/value prefix. Completion is available for supported manifest field names and top-level values; it is not offered everywhere in a blank line or nested value. Hover over a supported field for schema guidance. The preview updates roughly 500 ms after typing stops. At most 50 open Markdown overlays can be included in a request.

Diagnostics identify the source file, line, severity, and correction. Select a finding to go to its source. A failed preview leaves the last good preview visible but dimmed; before the first successful preview there is no generated page to show. The preview also detects slide overflow, which a CLI content check cannot measure.

Below 900 pixels of editor width, source and preview stack vertically. On wider screens the divider is adjustable by pointer or keyboard. Escape dismisses completion or reader detail/guided/full-screen states as applicable, then returns focus toward the source.

### Save conflicts and recovery

Papeleria compares each file's current byte revision with the version you opened. A clean tab follows an external change; a dirty tab reports a conflict.

| Choice | Result |
| --- | --- |
| **Reload** | Replace your unsaved buffer with the current disk file; copy anything you need first |
| **Keep mine** | Keep your buffer and acknowledge the disk revision; the next save checks that revision again before writing |

Preview, Check, and Build pause while conflicts are unresolved. Saves from cooperating Papeleria editors are serialized. External programs do not participate in that coordination: a very narrow external-write race can still occur during file replacement. Use one active writer for critical edits.

Successful saves retain the last ten saved versions of each file under `.papeleria/backups/`. Stop the editor before restoring a backup with your file manager, preserve the current file elsewhere, copy the chosen version back to its original path, then reopen and check the piece. Backups are not a substitute for version control or an independent copy. Deleting `.papeleria/` also deletes those backups.

## Text and links

**Full Markdown fields** accept text directly or a path such as `assets/text/introduction.md`. This applies to document text, column text, speaker notes, quote/note/callout text, panel text details, source notes, and captions. A file reference must begin exactly with `assets/text/` and end in lowercase `.md`; `notes.MD` will not load as a Markdown file.

Full Markdown supports paragraphs, headings, emphasis, strong text, inline/fenced code, lists, links, tables, strikethrough, and footnotes. Headings are adjusted to fit their containing section. Raw HTML is shown as text rather than executed. Markdown image syntax is refused: use an image block so its description and rights can be checked.

**Inline Markdown fields** are root titles, slide titles, and slide leads. They support inline formatting and explicit line breaks, not block headings, lists, or footnotes. End a line with two spaces or a backslash for a hard break.

**Plain-text fields** include section/column headings, labels, alt text, transcripts, chart summaries, credits, rights, attribution, source labels, registers, editions, and footers. Markdown markers in these fields are printed literally.

For multi-paragraph text in YAML, use a literal block:

```yaml
# Fragment: a document text block
text: |
  Our first paragraph has **emphasis**.

  - One point
  - Another point

  A note appears here.[^note]

  [^note]: This is the footnote text.
```

### Links and placeholders

Use Markdown links such as `[Project repository](https://github.com/JeremiahJRRoss/papeleria)` or `[Second slide](#slide-2)` in supported text fields. Allowed destinations are `https:`, `http:`, `mailto:`, `tel:`, fragments, and relative paths. Root-absolute paths, protocol-relative URLs, and `javascript:`, `data:`, or `file:` URLs are refused. Bare URLs remain plain text.

Papeleria checks links and fragments inside the published folder. Text and CSV source files are rendered, not copied, so linking to `assets/text/notes.md` in a published piece fails. A relative link leaving the folder, such as `../another-piece/index.html`, is not checked against that other publication. External links are marked in the rendered text and do not cause background downloads.

Square-bracketed words such as `[Client name]` are unfinished placeholders. They generate a warning in draft/review and an error in published status. Code, actual Markdown links, and valid footnote markers are treated according to their syntax. To keep literal brackets in Markdown, escape them as `\[` and `\]`. In a plain-text field, escapes print literally; use parentheses or different wording there.

## Decks

### Complete starter manifest

Create a piece folder and save this as `papeleria.yaml`. It requires no asset files.

```yaml
schema: 1
template: deck
title: A clearer plan
language: en
status: draft
register: Project update
edition: September 2026
credits:
  - role: Author
    name: Example team
slides:
  - layout: cover
    title: A clearer plan
    lead: Three decisions for the next stage.
  - layout: two
    title: What changes
    columns:
      - heading: Today
        text: We collect the facts in one place.
      - heading: Next
        text: We agree on the work and its owner.
    notes: Explain the decision before discussing the schedule.
  - layout: closing
    title: Agree on the next step
    lead: Record the decision and the date.
```

Then run `papeleria check` and `papeleria build` with that folder's name.

### Deck fields and layouts

Besides common fields, decks accept `register` (plain text at the top of slides), `edition` (default footer), `logo` (shared logo object), and required `slides`. Each slide requires `layout` and `title`. Every layout optionally takes `lead`, `footer` (overrides edition), and `notes`.

| Layout | Additional fields |
| --- | --- |
| `cover`, `closing` | None; opening/closing treatment |
| `statement` | None; a single idea |
| `two`, `three`, `four` | Required `columns`, exactly 2, 3, or 4 objects, each with required plain `heading` and Markdown/file `text` |
| `chart` | Exactly one required `chart` or `table` object |
| `image` | Required `image` object |
| `attributes` | Required nonempty `items`; each object has plain `label` and `text` |
| `palette` | Required nonempty `swatches`; each has plain `name`, quoted `value` such as `"#2f7fbf"`, and optional plain `use` |
| `type`, `wordmark` | None; display the theme's typography or wordmark treatment |

A layout rejects fields belonging to another layout. There is no general `blocks` array on slides. Use the shared object definitions below for charts, tables, images, and logos.

## Documents

### Complete starter manifest

Save as `papeleria.yaml` in a new piece folder; no assets are required.

```yaml
schema: 1
template: document
title: The next step is clear
language: en
status: draft
doc_type: Decision note
metadata:
  - label: Prepared for
    value: Example team
  - label: Date
    value: "2026-09-30"
sections:
  - heading: Recommendation
    blocks:
      - text: |
          Begin with one complete workflow.

          Capture what we learn before expanding the scope.
      - callout:
          text: Make the first result easy to review.
  - heading: Next action
    new_page: true
    blocks:
      - note:
          tone: default
          text: Assign an owner and agree on a review date.
source_note: Prepared from the team's working notes.
footer: Example team
```

### Document fields and blocks

Besides common fields, documents accept `doc_type` (defaults to `Document` or `Documento`), `metadata` (objects with required plain `label` and `value`), required `sections`, `source_note` (Markdown/file), and `footer` (plain).

Each section requires a plain `heading` and a nonempty `blocks` array; `new_page: true` starts a new logical sheet. Its default is false. Each block entry contains **exactly one** of the following keys:

| Key | Value |
| --- | --- |
| `text` | Markdown text or Markdown file path |
| `image` | Shared image object |
| `video` | Shared video object; documents only |
| `chart` | Shared chart object |
| `table` | Shared table object |
| `quote` | Required Markdown/file `text`; optional plain `attribution` |
| `note` | Required Markdown/file `text`; optional `tone: default` or `tone: warning` |
| `callout` | Object with required Markdown/file `text` |
| `logo` | Shared logo object |

The output is a continuous HTML document. Logical sheets help authoring and print breaks, but a long sheet can span several physical printed pages. Papeleria does not calculate physical page totals or guarantee that a footer repeats on every overflow page.

## Comics

### Complete starter manifest and artwork

Create `assets/images/page-01.svg` in a new piece folder with this small original example. It uses the supported SVG subset:

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 1000">
  <rect x="0" y="0" width="800" height="1000" fill="#ffffff"/>
  <rect x="40" y="40" width="720" height="440" fill="#dff4fa"/>
  <circle cx="400" cy="260" r="120" fill="#ffdc40"/>
  <rect x="40" y="520" width="720" height="440" fill="#20242a"/>
  <circle cx="400" cy="740" r="120" fill="#f5f5f5"/>
</svg>
```

Save this as `papeleria.yaml` beside the `assets` folder:

```yaml
schema: 1
template: comic
title: Day and night
language: en
status: draft
format: A short comic
pages:
  - image: assets/images/page-01.svg
    alt: Two panels show a yellow sun in daylight and a pale moon at night.
    credit: Papeleria documentation example
    rights: Apache-2.0; included with this documentation example.
    panels:
      - box: [5, 4, 90, 44]
        transcript: A yellow sun fills the daytime sky.
        detail:
          text: The first panel introduces the day.
      - box: [5, 52, 90, 44]
        transcript: A pale moon fills the night sky.
        detail:
          zoom: true
```

### Page and panel reference

Besides common fields, comics accept `format` (defaults to `Web Comics` or `Web Cómics`) and required `pages`. Each page requires an `image` path and nonempty plain `alt`; it optionally has plain `credit`, `rights`, and a `panels` array. Comic pages cannot be decorative. Missing credit and rights are separate warnings.

Each panel requires:

| Field | Meaning |
| --- | --- |
| `box` | Four finite numbers `[x, y, width, height]`, in percentages of the entire page image |
| `transcript` | Plain text containing the panel's words and relevant action |
| `detail` | Optional object, one of the four forms below |

Coordinates start at the image's top left. `x` and `y` are at least zero; width and height are greater than zero; `x + width` and `y + height` must each be at most 100. Write panels in reading order; their array order determines guided navigation, keyboard order, and transcript order. The editor's Grid can help estimate coordinates.

| Detail form | Required contents | Behavior |
| --- | --- | --- |
| Zoom | `zoom: true` | Enlarge the page art around the panel |
| Text | `text: ...` | Open Markdown text or a referenced Markdown file |
| Image | `image: {...}` | Open a shared image object |
| Link | `href: ...` and `label: ...` | A normal link with visible plain-text label; subject to the same URL rules |

Choose exactly one form. `label` belongs only to `href`. A panel without a detail still has its transcript and does not open an empty dialog. A page without panels is one guided step. Panel details supplement the transcript; do not move essential story information into a detail alone.

## Data and shared blocks

### CSV and a complete chart example

Save this as `assets/data/hours.csv` inside a new piece folder:

```csv
phase,hours
Research,12
Draft,18
Review,6
```

Save this complete `papeleria.yaml` at its root:

```yaml
schema: 1
template: document
title: Drafting takes the most time
status: draft
sections:
  - heading: Hours by phase
    blocks:
      - chart:
          type: bar
          data: assets/data/hours.csv
          x: phase
          y: hours
          summary: Drafting takes 18 of the 36 total hours.
          show_table: true
          source: Example planning data
```

CSV must be UTF-8 and comma-separated, with a nonempty, unique header row. A UTF-8 byte-order mark and CRLF line endings are accepted. Quote cells containing commas, newlines, or quotes; double a quote inside a quoted cell. Every row must have the header's number of cells. Field names are case-sensitive.

Numeric cells use a decimal point and may include a sign or exponent. Do not include spaces, units, currency signs, thousands separators, Infinity, or NaN. Dates use valid `YYYY-MM-DD` values. A column is inferred numeric/date only when all its nonempty values fit that type; otherwise it is text. Empty table cells display an em dash and an accessible “No value” label. A header-only table gives a warning; a chart without usable data gives an error.

### Chart object

| Field | Required | Value |
| --- | --- | --- |
| `type` | Yes | `bar` or `line` |
| `data` | Yes | CSV path under `assets/data/` |
| `x` | Yes | Header name: categories for bars; uniform numeric values or dates for lines |
| `y` | Yes | Header name containing finite numeric values |
| `summary` | Yes | Plain-text takeaway, written by the author |
| `orientation` | No | `vertical` by default or `horizontal`; bar charts only |
| `series` | No | Header identifying up to five series; series names must be nonempty |
| `show_table` | No | Boolean, false by default; adds the data table |
| `caption` | No | Markdown text/file |
| `source` | No | Plain-text provenance |

Duplicate `(x, series)` points are rejected rather than aggregated. Lines sort by x; bars retain file order. Series names that collide after normalization are refused. Both chart types include zero on the numeric y scale. The palette and labels/dashes are built in; there are no custom chart configuration or aggregation fields.

The chart summary stays exactly as authored after data changes. Recheck its numbers and conclusion whenever you replace a CSV. Use `show_table: true` when readers need the actual values.

### Table object

`data` is required. Optional `columns` selects and orders fields; omit it to show all headers. Each entry is either the exact header string or an object with required `field` and optional plain `label`. `caption` accepts Markdown/file and `source` accepts plain text. Table cells preserve their original numeric text formatting.

```yaml
# Fragment: a document block, or the table value of a chart slide
table:
  data: assets/data/hours.csv
  columns:
    - field: phase
      label: Phase
    - field: hours
      label: Planned hours
  caption: Time allocated to each phase.
  source: Example planning data
```

### Image, logo, and video objects

| Object | Required | Optional |
| --- | --- | --- |
| Image | `src`; exactly one of nonempty `alt` or `decorative: true` | Markdown/file `caption`; plain `credit`, `rights`; `focal_point: [x, y]` |
| Logo | `src` under `assets/images/logos/`; plain `alt` | None |
| Video | `src` under `assets/video/`; image path `poster`; plain `alt` | Markdown/file `caption`; plain `credit`, `rights` |

An image focal point is two percentages from 0 to 100, default `[50, 50]`; it influences layouts that crop, such as an image slide. `decorative` accepts only `true`. A logo cannot be decorative and does not accept credit/rights fields.

```yaml
# Fragment: an image block; supply the referenced file yourself
image:
  src: assets/images/workshop.jpg
  alt: Two participants compare paper prototypes at a table.
  caption: Reviewing the first draft.
  credit: Your photographer's name
  rights: Your actual license or permission
  focal_point: [55, 40]
```

```yaml
# Fragment: a document video block; supply both files yourself
video:
  src: assets/video/demo.mp4
  poster: assets/images/demo-poster.jpg
  alt: A hand folds a sheet in half, then unfolds it to show the center crease.
  credit: Your creator's name
  rights: Your actual license or permission
```

## Images, video, and rights

### Supported media

Still PNG, JPEG, and WebP images are resized into local WebP derivatives and, when the installed encoder supports it, AVIF. Papeleria targets widths of 800 and 1600 pixels without upscaling. A source between those widths may yield only the 800-pixel derivative; a source smaller than 800 keeps its own width. Derivatives apply orientation, convert to sRGB, and strip metadata. Very tall images are also constrained by the encoder's maximum dimension.

GIF, TIFF, HEIC, animated/multipage images, and unsupported formats are rejected. Keep original editable images elsewhere; the build does not turn arbitrary uploaded media into supported source formats.

SVG is accepted only through a restricted vector profile with a valid `viewBox`. Use basic vector shapes and supported presentation attributes. Scripts, style elements/attributes, embedded images, external references, `<use>`, links, event handlers, foreign objects, and document-type/entity declarations are refused. For a complex illustration, export a still raster image, or simplify the SVG. The comic example above demonstrates a valid small SVG.

Document videos must be MP4 or WebM with a readable video track and measured duration above zero and at most 15 seconds. Corrupt, unsupported, or fragmented MP4 files can fail duration validation. Papeleria copies video without transcoding or removing metadata. Use a browser-compatible codec when exporting. Playback uses native controls, starts muted, loops after the reader starts it, and never autoplays. Printing uses the poster and text alternative.

### Descriptions and rights

Write alt text for the information an image contributes, rather than its filename. Mark an image decorative only when it contributes no needed information. Comic page alt text describes the whole page; panel transcripts carry the reading sequence and dialogue. A chart summary states the actual takeaway. Video alt text must explain the action a reader would otherwise miss.

Give media a credit and an accurate license or permission statement. A nonempty rights field is **your statement**, not a verified clearance. Papeleria does not determine ownership, obtain permission, or guarantee that a file is legally shareable. Replace sample credits and rights when replacing an asset.

Only raster derivatives have their metadata stripped. Zoom originals and copied video can retain source metadata; inspect those originals before sharing. Preserve the generated license files with output; the [licensing document](LICENSING.md) explains their scope.

### Output budgets

| Format | Enforced budget |
| --- | --- |
| Deck or document | First view at most **1,048,576 bytes (1 MiB)** |
| Comic | Each page's phone-width image at most **307,200 bytes (300 KiB)**, separately for each generated format; the comic's overall first view is reported without a total cap |

First-view weight is the uncompressed size of unique files selected by a defined calculation, not a browser network measurement. The calculation considers 390×844, 834×1112, and 1280×800 viewports at device-pixel ratio 1 and uses the worst applicable format/viewport result. It counts the complete HTML, CSS, scripts, fonts, favicon, and initial media. For decks that means the first slide and deck logo. For documents it includes images/logos on the first logical sheet **and every video poster anywhere in the document**. Video data with `preload="none"` and license texts do not count. A long document's entire HTML still counts.

For comics, a copied SVG is counted at its file size; raster phone variants are checked individually. Zoom originals do not use the phone-image budget, although source-file limits still apply. Browsers may prefetch later images, so an actual initial download can differ from the model.

To reduce weight, simplify large art, reduce noise/texture, remove unnecessary initial images, shorten excessively large text, or move a document section to a later logical sheet with `new_page: true`. Moving a video later does not remove its poster from the budget. A WebP-only build after an AVIF warning is complete and usable.

## Check, build, and publish

```sh
papeleria check my-piece
papeleria check my-piece --json
papeleria build my-piece
```

Check performs the same validation and output-weight checks as Build but does not replace `dist/`. It can create temporary generated files and update media caches. Build prepares and validates a complete generation, then promotes it to `dist/` only when there are no errors and the piece is not withheld. Warnings alone allow a build.

If checking or building fails, any earlier `dist/` remains the earlier publication. Do not mistake that old output for the current source. If source changes during a build, `E_SOURCE_CHANGED` asks you to retry. Concurrent builds of one piece report `E_BUSY`. An interrupted promotion is recovered at the next build; preserve `.papeleria/` until recovery finishes.

### Status and distribution

| Manifest status | Visible meaning | Build behavior |
| --- | --- | --- |
| `draft` | Draft, not issued | Writes output; unfinished placeholders warn |
| `review` | Review edition, approval pending | Writes output; unfinished placeholders warn |
| `published` | Published | Writes only if placeholders and all other errors are resolved |
| `withheld` | Withheld | Validates and previews, but writes no new `dist/` |

**Withheld is not revocation or access control.** It leaves an older `dist/` untouched and cannot remove copies already uploaded or shared. Remove those separately if necessary. Draft/review labels do not prevent the output being read or copied.

### What to share

| Output | Files |
| --- | --- |
| Deck | `index.html`, `deck.js`, local theme/fonts and generated assets |
| Comic | `index.html`, `reader.js`, local theme/fonts and art, plus the page-turn engine's license |
| Document | `index.html`, local theme/fonts, images/posters/video; no published JavaScript |
| Every piece | `LICENSE`, `NOTICE.md`, `THIRD_PARTY.md`, `Poppins-OFL.txt`, `Inter-OFL.txt` |

Copy **everything inside `dist/` together** to a static web host, shared drive, or USB device. A reader opens `index.html`; no Node.js or server application is needed. There is no automatic upload, account, or deployment command. Readers following external links may need a connection.

To embed a hosted piece, point a normal iframe at its hosted URL, give it a meaningful title and suitable height, and permit full screen if needed. Test it at the actual embedding width; a comic initialized inside a hidden, zero-width container can require a reload once shown.

Keep source pieces in version control or another backup. Ignore `dist/` and `.papeleria/` in source-only version control unless you deliberately track generated releases. Never hand-edit generated output; the next build replaces it.

### Before sharing

- Run Check and read every warning; choose `published` only when the content is ready.
- Read the built result at narrow and wide widths, using keyboard navigation as well as a pointer.
- Confirm alt text, transcripts, chart summaries, credits, permissions, and external links.
- Inspect the print/PDF result, including long tables and overflowing slides.
- Open a copied `dist/index.html` offline and retain all license/notice files.

## Reading and printing

### Deck reader

Previous/Next buttons, arrow keys, Page Up/Page Down, and swipes change slides; Home/End jump to first/last. **Show all slides** switches to scrolling, **Show speaker notes** reveals notes, and **Full screen** expands the presentation. Escape exits full screen. **Print / Save PDF** uses the browser print dialog. Without JavaScript, all slides and notes remain readable in order.

Speaker notes are included in the published HTML even when hidden by the reader controls. Remove confidential notes before sharing.

### Comic reader

Page view presents the cover alone, then pairs 2–3, 4–5, and so on when the view is at least 900×500 and each page can be at least 320 pixels wide. Narrow views show single pages. The final unpaired page stands alone. Use navigation buttons, keys, or swipe/page-edge gestures.

Guided view is an opt-in sequence following panel order. Previous/Next, swipes, or the left/right thirds move through it; the middle opens a panel detail where available. Escape returns to Page view. A text/image detail is dismissible; a link detail behaves as a normal link. Zoom supports pinch/wheel, arrow-key panning, `+`/`-`, and `0` to reset, up to 8×. Reduced-motion preferences suppress ordinary animated navigation; the bundled page-turn engine's drag-edge behavior still needs final manual acceptance.

Without JavaScript, page art and transcripts remain in reading order. Reading position is reflected in the URL fragment; there is no account or cross-device reading history.

### Addresses

| Format | Fragment example |
| --- | --- |
| Deck | `#slide-2` |
| Comic page | `#page-2` |
| Comic guided panel | `#page-2-panel-1` |
| Document section | Heading slug such as `#hours-by-phase`; repeated headings receive `-2`, `-3`, etc. |

### Print and PDF

Use the browser's print command (**Ctrl+P** or **Cmd+P**) or the deck's print button, then choose a printer or Save as PDF.

| Format | Print behavior |
| --- | --- |
| Deck | A4 landscape, one slide per page; controls and speaker notes omitted |
| Document | A4 portrait with 18 mm margins; explicit section breaks honored; long content continues and table headers can repeat |
| Comic | Each page starts a printed page with complete art and transcript |

The comic reader begins loading its printable art in the background after opening. Wait for it to finish before printing. If hosted art disappears from print under `Cache-Control: no-store`, download the complete piece and print the local copy. Browser layout controls the final pagination; examine the preview. Papeleria does not calculate a physical document page count. Slide overflow must be corrected by reducing or splitting content.

## Diagnostics and troubleshooting

A finding gives a file, a 1-based line/column when available, severity, rule, message, and suggested fix. Binary/output findings can have no source line; a related location points to the manifest reference. Errors prevent new output; warnings do not. Fix syntax errors first because they can prevent later checks.

### Rules

| Rule | Meaning | Typical correction |
| --- | --- | --- |
| R01 | Unfilled bracketed placeholder; error when published, warning otherwise | Replace it or escape a literal bracket in Markdown |
| R02 | Referenced file missing | Correct the exact case-sensitive path or add the file |
| R03 | Missing/invalid image description or decorative flag | Supply nonempty alt, or mark an eligible image decorative, never both |
| R04 | Missing panel transcript | Describe the words and action |
| R05 | Missing chart summary | State the data's takeaway |
| R06 | Missing media credit or rights; warning | Add accurate provenance and permission terms |
| R07 | Output over its byte budget; also AVIF fallback warning | Reduce media/initial weight, or accept the documented WebP-only fallback |
| R08 | Generated HTML/output or published-link validation failed | Fix a bad link; report a reproducible template/output defect |
| R09 | Invalid manifest, unknown field, refused path/link/media/SVG, or input limit | Follow the indicated schema or input constraint |
| R10 | Missing video text alternative | Add a description of the action |
| R11 | Dependency license outside the release allowlist | Maintainer release check; not a content authoring repair |
| R12 | Owner-exclusive asset matched outside its permitted location | Remove the asset or use permitted material; installed builds have no default owner inventory, so absence of this finding is not a rights clearance |
| R13 | CSV structure, column, value, or chart data issue | Correct CSV/field names; a header-only table is a warning |
| R14 | Malformed or out-of-bounds panel rectangle | Correct all four percentage coordinates |
| R15 | Column count/layout mismatch | Supply exactly 2, 3, or 4 columns for the matching layout |
| R16 | Video type, track, duration, or container unreadable | Export a supported MP4/WebM video of 15 seconds or less |
| R17 | Manifest schema newer than this tool | Use the appropriate newer Papeleria release; do not just relabel incompatible data as schema 1 |

### Common problems

| Problem | What to do |
| --- | --- |
| Preview shows older content, dimmed | Fix the current error; the last good generation stays visible until validation succeeds |
| Build unavailable | Save every dirty file and resolve conflicts |
| Edited title does not change the first slide | Change that slide's `title` as well as the root title |
| A Markdown file appears as literal text | Use a path such as `assets/text/notes.md`; confirm lowercase extension and file existence |
| Chart fails after replacing a CSV | Check headers, row widths, numeric/date formats, duplicates, and series count; update the summary too |
| Check passes but a slide clips | Content checking cannot measure the browser layout; split or shorten the slide and inspect print preview |
| `E_SOURCE_CHANGED` | Stop simultaneous writes and repeat the build |
| `E_BUSY` | Let the other build finish; if it was interrupted, stop remaining processes and retry rather than deleting active staging files |
| `E_SHARP_UNAVAILABLE` | Reinstall dependencies on this platform; see [Installation](INSTALLATION.md#installation-troubleshooting) |
| Permission or I/O failure | Confirm the piece and installation are writable and files are not locked by another process |
| Unsaved work after a server restart | Copy the buffers somewhere safe before reopening the new session |
| Withheld content still visible on a website | Remove the older deployed publication; the status cannot revoke it |

For a reproducible defect, open an [issue](https://github.com/JeremiahJRRoss/papeleria/issues) with the version, OS/browser, exact command or action, full diagnostic, and a minimal nonprivate piece. Exclude editor access links and private content.

## Command reference

| Syntax | Result |
| --- | --- |
| `papeleria new <deck\|comic\|document> <folder>` | Copy a template sample into a new/empty destination |
| `papeleria edit <folder> [--port N]` | Local editor; browser opens when available |
| `papeleria serve <folder> [--port N]` | Read-only preview of saved files, reloaded after changes; open the printed address yourself |
| `papeleria check <folder> [--json]` | Validate without replacing `dist/` |
| `papeleria build <folder>` | Validate and write a complete eligible generation to `dist/` |
| `papeleria --version` or `-v` | Print version |
| `papeleria --help` or `-h` | Print usage |

Ports must be integers from 1 through 65535. Use `--` to end option parsing if a folder argument begins with a hyphen. Stop Edit/Serve with Ctrl+C. Serve has no save API or session key, stays on loopback, previews withheld pieces, and never replaces `dist/`.

Exit **0** means no content errors, including warning-only and withheld results; **1** means content errors; **2** means usage, I/O, or tool failure. An exit code alone does not prove that new output was written.

### JSON reports

`papeleria check my-piece --json` emits one JSON report on stdout and human-readable text on stderr. Redirect stdout to a file if needed. Consumers should inspect `errors`, `warnings`, `status`, and `outputReason` rather than parse terminal text.

| Field | Contents |
| --- | --- |
| `piece`, `tool` | Piece label; tool name and version |
| `status`, `errors`, `warnings` | `ok`/`failed` and finding counts |
| `findings` | `file`, nullable `line`/`column`, `rule`, `severity`, `message`, `fix`, nullable `detail`, and optional `relatedLocation` |
| `weight` | Nullable object with `firstViewBytes`, nullable `budgetBytes`, `withinBudget`, `largest` path/byte pairs, and optional comic `phoneImages` path/byte/pass triples |
| `targets` | Source ranges associated with rendered slides, sections, pages, and panels |
| `outputWritten`, `outputReason` | Whether output was written and why: `written`, `withheld`, `check_only`, `preview_only`, or `failed` across pipeline reports |

A CLI Check does not write output and reports `check_only`, including when content errors are present; read `status` and `errors` to determine whether it passed. `failed` is the unsuccessful publication-build reason. If the command itself cannot run, it emits an object with `errorCode` and `message` instead and exits 2.
