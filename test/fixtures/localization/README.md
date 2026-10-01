# Localization fixtures (M5.4, W5C)

Pieces for A12's EN/ES matrix (D133): each is written once in English (`en/`) and once in Spanish (`es/`), with its author text in its own language.

| Folder | Used by | What it holds |
| --- | --- | --- |
| `deck/` | the matrix, the withheld suite, the browser suite | Four slides: a cover with notes from a file, three columns with an external link, a table on a chart slide from a CSV with a blank cell, a closing slide with inline notes |
| `deck-one/` | the browser suite | One slide, for the singular stacked-view status, `all_shown_one` (D130) |
| `comic/` | the matrix, the withheld suite, the browser suite | Four drawn (SVG) pages, so a build derives no raster: page 1 has five panels, one of each detail kind (a zoom, a text with an external link, none, a link to page 4, an external link); page 2 one panel with a picture; page 3 none; page 4 two |
| `document/` | the matrix, the withheld suite | Two logical sheets, metadata, footer text and a source note; text with an external link, a note and a warning, a table from a CSV with a blank cell, a bar chart with four-digit values and a line chart over July dates (D41's forms) |

The rules they keep, which `test/integration/localization.test.ts` checks before it builds anything:

- No author text holds a control-string value of either language as a whole word (`control-strings.ts` defines the search), so every control string a page shows came from the strings file and none can hide behind the author's words.
- No manifest sets `format` or `doc_type`, so the localized defaults render; the override cases add them at test time, as author text that is no control string.
- Every manifest says `status: draft` once; the suites write the other three statuses over it.

The suites copy a fixture into a temporary folder before building it, so `dist/` and `.papeleria/` never appear here. `control-strings.ts` reads both strings files and holds the whole-word search that the integration and browser suites share.
