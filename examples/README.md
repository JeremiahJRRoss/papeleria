# Examples

Papeleria pieces. Three were seeded from the specification and the fourth, the brand overview, was written in milestone 1. Milestone 1 builds and checks both decks, milestone 3 the report and milestone 4 the comic, so every example builds. For the 0.1.0 release candidate (M5.5) all four check and build with 0 errors and 0 warnings, from the repository's build and from the CLI installed from the release tarball; no warning is suppressed, and none has been accepted (the release inventory, `Dev_Docs/docs/RELEASE_INVENTORY_0.1.0.md` in the Dev_Papeleria repository, "Examples").

| Piece | Template | Status | Note |
| --- | --- | --- | --- |
| `starter-deck/` | deck | builds and checks | Five slides; the same files as `templates/deck/sample/`, which `papeleria new deck` copies (D60). The A1 and A3 tests edit and rebuild copies of it |
| `brand-overview/` | deck | builds and checks | Reproduces `reference/decks/brand-overview.html`: the input to the A4 golden and visual tests, with every difference on `test/golden/brand-overview.allowlist.json` |
| `hours-report/` | document | builds and checks | A bar chart, a line chart and a table from two CSV files, over two sheets; the same files as `templates/document/sample/`, which `papeleria new document` copies (D60, D99). The A2 test changes copies of its CSV files and rebuilds; the print suites print it (A6) |
| `sample-comic/` | comic | builds and checks | Eight placeholder pages drawn by `scripts/gen-sample-comic.mjs` (W3C, D102), 26 panels with a zoom, a text note and transcript-only panels; the same files as `templates/comic/sample/`, which `papeleria new comic` copies (D60, D119). The A5 browser suite reads it at three viewports; its art changes only through the script |

Each piece is one folder with `papeleria.yaml` and `assets/`. Build one with `papeleria build examples/starter-deck`, or all four with `npm run examples`, which checks each one, prints every warning with its rule, then builds it (D139). A warning must be fixed, or listed in `ACCEPTED_WARNINGS` in `scripts/build-examples.mjs` with the reason it is acceptable, before the run passes; the script would also list as pending any example whose template did not render yet.
