/**
 * Label bounds with the shipped Inter (D48). Charts lay labels out with a
 * fixed advance table, never a measurement; these helpers say where the labels
 * actually land when the theme's Inter draws them, so a test can hold every
 * label inside the viewBox.
 *
 * `inter-metrics.json` holds Inter's advances and text-box extent, measured
 * once in a browser at the charts' own settings (12.5 px, tabular figures).
 * The Node model below places each <text> from them: its anchor, dy, the dx of
 * its tspans and its translate/rotate transform, with the box running from the
 * font's ascent to its descent, as getBoundingClientRect reports it. The
 * browser suite (test/browser/charts.test.ts) renders the same charts with the
 * real font in every engine and checks the metrics against it.
 */
import {readFileSync} from 'node:fs';

import type {ChartInput} from '../../../src/core/charts.js';
import {parseCsv} from '../../../src/core/csv.js';
import {fixturePath} from '../../helpers/paths.js';

export type InterMetrics = {
  font: string;
  measured: string;
  unit: 'em';
  /** Top and bottom of a text box relative to its baseline. */
  boxTop: number;
  boxBottom: number;
  advances: Record<string, number>;
};

export const INTER_METRICS = JSON.parse(readFileSync(fixturePath('charts', 'inter-metrics.json'), 'utf8')) as InterMetrics;

/** The charts' font size in px (.78rem). */
export const CHART_FONT_SIZE = 12.5;

/** The width Inter draws `text` with, in px; throws for a character the metrics do not hold. */
export function interWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const advance = INTER_METRICS.advances[char];
    if (advance === undefined) {
      throw new Error(`inter-metrics.json has no advance for ${JSON.stringify(char)}`);
    }
    width += advance * CHART_FONT_SIZE;
  }
  return width;
}

export type TextBox = {text: string; left: number; top: number; right: number; bottom: number};

function decode(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/** Every <text> of a chart SVG as Inter would draw it, in viewBox units. */
export function interTextBoxes(svg: string): TextBox[] {
  return [...svg.matchAll(/<text\b([^>]*)>(.*?)<\/text>/g)].map((match) => {
    const attributes = new Map([...(match[1] ?? '').matchAll(/([\w:-]+)="([^"]*)"/g)].map((pair) => [pair[1] ?? '', pair[2] ?? '']));
    const markup = match[2] ?? '';
    // The bidi isolates around names have no width.
    const text = decode(markup).replace(/[⁦-⁩]/g, '');
    const shift = [...markup.matchAll(/<tspan\b[^>]*\bdx="([-\d.]+)"/g)].reduce((sum, dx) => sum + Number(dx[1]), 0);
    const width = interWidth(text) + shift;
    const anchor = attributes.get('text-anchor');
    const start = Number(attributes.get('x') ?? 0) - (anchor === 'middle' ? width / 2 : anchor === 'end' ? width : 0);
    const dy = attributes.get('dy') ?? '0';
    const baseline = Number(attributes.get('y') ?? 0) + (dy.endsWith('em') ? Number.parseFloat(dy) * CHART_FONT_SIZE : Number(dy));
    const top = baseline + INTER_METRICS.boxTop * CHART_FONT_SIZE;
    const bottom = baseline + INTER_METRICS.boxBottom * CHART_FONT_SIZE;
    let corners = [
      [start, top],
      [start + width, top],
      [start, bottom],
      [start + width, bottom],
    ] as Array<[number, number]>;
    const transform = /^translate\(([-\d.]+),([-\d.]+)\) rotate\(([-\d.]+)\)$/.exec(attributes.get('transform') ?? '');
    if (transform !== null) {
      const angle = (Number(transform[3]) * Math.PI) / 180;
      const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
      corners = corners.map(([x, y]) => [Number(transform[1]) + x * cos - y * sin, Number(transform[2]) + x * sin + y * cos]);
    }
    const xs = corners.map(([x]) => x);
    const ys = corners.map(([, y]) => y);
    return {text, left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys)};
  });
}

/** The labels whose box leaves the viewBox by more than `tolerance` px. */
export function labelsOutside(svg: string, tolerance = 0.5): TextBox[] {
  const [, , width = 0, height = 0] = (/viewBox="([^"]+)"/.exec(svg)?.[1] ?? '').split(' ').map(Number);
  return interTextBoxes(svg).filter(
    (box) => box.left < -tolerance || box.top < -tolerance || box.right > width + tolerance || box.bottom > height + tolerance,
  );
}

/** Long upper-case names, the widest text Inter sets: capitals average 0.68 em and W is a full em. */
export const UPPER_CASE_NAMES = [
  'WORKFORCE MANAGEMENT',
  'NET PROMOTER SCORE',
  'GROSS MERCHANDISE VALUE',
  'CUSTOMER ACQUISITION COST',
  'MONTHLY ACTIVE USERS',
  'AVERAGE WAGE MOVEMENT',
  'OPERATING EXPENSES',
];

function table(csv: string): ChartInput['table'] {
  const parsed = parseCsv(csv);
  if (!parsed.ok) {
    throw new Error(`label-bounds CSV has problems: ${JSON.stringify(parsed.problems)}`);
  }
  return parsed.table;
}

/**
 * Vertical bars for `categories` categories of `k` series (Design, Review,
 * Build, Delivery, Support), values 10–39: dense enough, at a narrow width,
 * that the drawing must widen to keep each group in its band.
 */
export function denseBars(categories: number, k: number, width: number): ChartInput {
  const series = ['Design', 'Review', 'Build', 'Delivery', 'Support'].slice(0, k);
  const rows = Array.from({length: categories}, (_, c) => series.map((name, s) => `C${c + 1},${name},${10 + ((c * k + s) % 30)}`));
  return {
    id: 'dense',
    summary: 'Summary.',
    locale: 'en',
    type: 'bar',
    x: 'c',
    y: 'y',
    ...(k > 1 ? {series: 's'} : {}),
    width,
    table: table(`c,s,y\n${rows.flat().join('\n')}\n`),
  };
}

/**
 * One chart of every kind with long upper-case category and series names:
 * rotated category labels, first-bar names above and below bars, names
 * beside values on both sides of a zero line, line end labels and legends,
 * a single point, and names shortened with an ellipsis — at 240 and 640 px,
 * in English and Spanish.
 */
export function upperCaseCharts(): Array<{name: string; input: ChartInput}> {
  const series = [UPPER_CASE_NAMES[0] ?? '', UPPER_CASE_NAMES[3] ?? '', 'MWMWMWMWMWMWMWMW'];
  const categories = UPPER_CASE_NAMES;
  const signed = (index: number) => `${index % 2 === 0 ? '' : '-'}${1234 + index * 111}.5`;
  const kinds: Array<[string, Omit<ChartInput, 'id' | 'summary' | 'locale' | 'width'>]> = [
    ['vertical bars', {type: 'bar', x: 'c', y: 'y', table: table(`c,y\n${categories.map((name, index) => `${name},${1234 + index * 111}`).join('\n')}\n`)}],
    [
      'vertical grouped bars',
      {type: 'bar', x: 'c', y: 'y', series: 's', table: table(`c,s,y\n${['Q1', 'Q2'].flatMap((c, row) => series.map((s, index) => `${c},${s},${signed(row + index)}`)).join('\n')}\n`)},
    ],
    [
      'horizontal bars',
      {type: 'bar', orientation: 'horizontal', x: 'c', y: 'y', table: table(`c,y\n${categories.map((name, index) => `${name},${signed(index)}`).join('\n')}\n`)},
    ],
    [
      'horizontal grouped bars',
      {
        type: 'bar',
        orientation: 'horizontal',
        x: 'c',
        y: 'y',
        series: 's',
        table: table(`c,s,y\n${categories.slice(0, 3).flatMap((c, row) => series.map((s, index) => `${c},${s},${signed(row + index)}`)).join('\n')}\n`),
      },
    ],
    [
      'lines',
      {type: 'line', x: 'x', y: 'y', series: 's', table: table(`x,s,y\n${series.flatMap((s, index) => [1, 2, 3, 4, 5, 6].map((x) => `${x},${s},${1234 + 10 * x * (3 - index)}`)).join('\n')}\n`)},
    ],
    [
      'dated lines',
      {type: 'line', x: 'x', y: 'y', series: 's', table: table(`x,s,y\n${series.flatMap((s, index) => ['2026-01-05', '2026-06-01', '2027-01-04'].map((x, step) => `${x},${s},-${1234 + step * 55 + index}`)).join('\n')}\n`)},
    ],
    ['single point', {type: 'line', x: 'x', y: 'y', series: 's', table: table(`x,s,y\n${series.map((s, index) => `2026-07-06,${s},${1234 + index}`).join('\n')}\n`)}],
  ];
  const charts: Array<{name: string; input: ChartInput}> = [];
  for (const width of [240, 640]) {
    for (const locale of ['en', 'es'] as const) {
      for (const [kind, spec] of kinds) {
        charts.push({name: `${kind}, ${width} px, ${locale}`, input: {id: 'bounds', summary: 'Summary.', locale, width, ...spec}});
      }
    }
  }
  return charts;
}
