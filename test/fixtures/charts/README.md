# Chart fixtures (M1.11, IC03)

## Positive: `positive/<name>/`

Each folder holds `data.csv`, `chart.json` (every `renderChart` input except the parsed table) and `expected.svg`, the byte snapshot. `test/unit/charts.test.ts` renders each fixture twice in one process and once more in each of two child processes, and requires all of them to equal the snapshot byte for byte. It also reads the six IC03 fixtures back and checks their geometry and labels, so a snapshot cannot drift into being wrong while still matching itself.

| Fixture | IC03 case |
| --- | --- |
| `positive-vertical-bar` | Positive vertical bar (the seeded `hours-by-phase.csv`) |
| `mixed-sign-horizontal-grouped-bar` | Mixed-sign horizontal grouped bar, in Spanish, with a zero value |
| `zero-bar` | Zero bar: an all-zero domain drawn as [-1, 1] |
| `numeric-single-series-line` | Numeric single-series line, rows deliberately out of x order |
| `date-multi-series-line` | Date multi-series line (the seeded `hours-by-week.csv`) |
| `single-point-line` | Single-point line |
| `three-series-vertical-grouped-bar` | Extra: three series, a missing (category, series) slot, first-bar names |
| `date-multi-series-line-es` | Extra: the same data with Spanish dates |
| `five-series-daily-line` | Extra: the full five-colour palette, dash patterns, label spreading, d3 ticks |
| `rotated-labels-vertical-bar` | Extra: long category names rotated with room reserved |

To change a snapshot on purpose: build, render, look at every changed chart in a browser, then write the snapshots and review the diff.

```sh
npm run build
UPDATE_CHART_SNAPSHOTS=1 node lib/test/fixtures/charts/render-fixtures.js
```

CI never sets that variable. A failing snapshot is a finding to explain, never a file to regenerate without looking.

## Label bounds: `inter-metrics.json`, `label-bounds.ts`

Charts lay labels out with a fixed advance table (D48), never a measurement. `inter-metrics.json` holds the shipped Inter's advances and text-box extent, measured once at the charts' own settings (12.5 px, tabular figures) by `measure-inter.mjs`. `label-bounds.ts` places every label of a chart from those metrics in Node, and builds charts with long upper-case names in every chart kind. `test/unit/charts.test.ts` requires every label of those charts inside its viewBox and the advance table to be at least Inter's width for every measured character; `test/browser/charts.test.ts` checks both again with the real font in each engine, for every character the shipped Inter draws. `inter-coverage.ts` reads that set from the font files' cmap tables, each face limited to its own `unicode-range`: a character outside it is drawn by a fallback face whose width depends on the machine, so no fixed table can bound it.

When the theme's Inter changes, measure again and review the diff (without `PAPELERIA_CHROMIUM_EXECUTABLE`, Playwright's own Chromium runs):

```sh
PAPELERIA_CHROMIUM_EXECUTABLE=/path/to/chromium node test/fixtures/charts/measure-inter.mjs
```

## Negative: `negative/`

`cases.json` lists each CSV with the chart definition and the problems it must produce: code, rule, the manifest field it belongs to, and the CSV line where the offending record starts (null when the problem is about a manifest field, such as a missing column). Every case must also draw nothing.

`.gitattributes` here marks everything `-text` so no checkout rewrites a byte.
