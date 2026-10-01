/**
 * M1.11 / IC03 / R13: build-time chart SVG. The six IC03 fixtures, plus four
 * more, as byte snapshots that must hold within one run and across separate
 * processes; the negative fixtures with their codes, fields and record lines;
 * escaping, ID prefixes, the title/desc hooks, the fixed locales, and geometry
 * that does not depend on the locale.
 */
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';

import {
  CHART_LOCALES,
  CHART_SERIES_COLOURS,
  MAX_CHART_PROBLEMS,
  MAX_CHART_SERIES,
  chartLabelWidth,
  renderChart,
  type ChartField,
  type ChartInput,
  type ChartProblem,
  type ChartResult,
} from '../../src/core/charts.js';
import {parseCsv, type CsvTable} from '../../src/core/csv.js';
import {
  CHART_FONT_SIZE,
  INTER_METRICS,
  UPPER_CASE_NAMES,
  denseBars,
  interWidth,
  labelsOutside,
  upperCaseCharts,
} from '../fixtures/charts/label-bounds.js';
import {POSITIVE_DIRECTORY, positiveFixtures, renderFixture, sha256, type ChartFixture} from '../fixtures/charts/render-fixtures.js';
import {applicationRoot, fixturePath, runNode} from '../helpers/paths.js';

const IC03_FIXTURES = [
  'positive-vertical-bar',
  'mixed-sign-horizontal-grouped-bar',
  'zero-bar',
  'numeric-single-series-line',
  'date-multi-series-line',
  'single-point-line',
];

function table(csv: string): CsvTable {
  const parsed = parseCsv(csv);
  assert.ok(parsed.ok, `fixture CSV must parse: ${JSON.stringify(parsed.ok ? null : parsed.problems)}`);
  return parsed.table;
}

function chart(csv: string, spec: Partial<ChartInput> & Pick<ChartInput, 'type' | 'x' | 'y'>): ChartResult {
  return renderChart({id: 'chart-test', summary: 'A summary.', locale: 'en', ...spec, table: table(csv)});
}

function drawn(result: ChartResult): string {
  assert.deepEqual(result.problems, [], 'expected a chart, got problems');
  assert.ok(result.svg !== null);
  return result.svg;
}

function fixture(name: string): ChartFixture {
  const found = positiveFixtures().find((candidate) => candidate.name === name);
  assert.ok(found, `missing chart fixture ${name}`);
  return found;
}

/** Every element of one kind, as attribute maps, in document order. */
function elements(svg: string, name: string): Array<Record<string, string>> {
  return [...svg.matchAll(new RegExp(`<${name}\\b([^>]*?)/?>`, 'g'))].map((match) =>
    Object.fromEntries([...(match[1] ?? '').matchAll(/([\w:-]+)="([^"]*)"/g)].map((pair) => [pair[1] ?? '', pair[2] ?? ''])),
  );
}

/** Markup without the invisible bidi isolate controls (U+2066–U+2069) that wrap every drawn name. */
function visible(markup: string): string {
  return markup.replace(/&#x206[6-9];/g, '');
}

/** The visible text of every <text> element, tags inside it removed. */
function texts(svg: string): string[] {
  return [...svg.matchAll(/<text\b[^>]*>(.*?)<\/text>/g)].map((match) =>
    visible(match[1] ?? '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

function section(svg: string, className: string): string {
  const match = new RegExp(`<g class="${className}">\\n([\\s\\S]*?)\\n</g>`).exec(svg);
  return match?.[1] ?? '';
}

const number = (value: string | undefined) => Number(value ?? Number.NaN);

// ------------------------------------------------------------ snapshots

test('the six IC03 minimum fixtures are present', () => {
  const names = positiveFixtures().map((candidate) => candidate.name);
  for (const name of IC03_FIXTURES) {
    assert.ok(names.includes(name), `IC03 fixture ${name} is missing from ${POSITIVE_DIRECTORY}`);
  }
  assert.ok(names.length >= 10);
});

test('every positive fixture matches its committed snapshot byte for byte, rendered twice', () => {
  for (const candidate of positiveFixtures()) {
    assert.ok(
      existsSync(candidate.expectedPath),
      `${candidate.name}: no expected.svg; review the output, then write it with UPDATE_CHART_SNAPSHOTS=1 node lib/test/fixtures/charts/render-fixtures.js`,
    );
    const first = renderFixture(candidate);
    const second = renderFixture(candidate);
    assert.equal(first.svg, second.svg, `${candidate.name}: two renders in one process differ`);
    assert.equal(first.svg, readFileSync(candidate.expectedPath, 'utf8'), `${candidate.name}: differs from its snapshot`);
  }
});

test('the snapshots are byte-stable across two separate processes', async () => {
  const script = join(applicationRoot, 'lib', 'test', 'fixtures', 'charts', 'render-fixtures.js');
  const runs = await Promise.all([runNode(script), runNode(script)]);
  for (const run of runs) {
    assert.equal(run.code, 0, run.stderr);
  }
  const [first, second] = runs.map((run) => JSON.parse(run.stdout) as Record<string, string>);
  assert.deepEqual(first, second);
  for (const candidate of positiveFixtures()) {
    assert.equal(first?.[candidate.name], sha256(readFileSync(candidate.expectedPath, 'utf8')), candidate.name);
  }
});

// ------------------------------------------------------------ the IC03 fixtures, read back

test('positive vertical bar: three ink bars in first-occurrence order, heights in proportion, values at the tips', () => {
  const svg = drawn(renderFixture(fixture('positive-vertical-bar')));
  const bars = elements(section(svg, 'chart-marks'), 'rect');
  assert.equal(bars.length, 3);
  assert.ok(bars.every((bar) => bar['fill'] === CHART_SERIES_COLOURS[0]));
  const xs = bars.map((bar) => number(bar['x']));
  assert.deepEqual([...xs].sort((a, b) => a - b), xs, 'Review, Build, Delivery from left to right');
  const heights = bars.map((bar) => number(bar['height']));
  assert.ok(Math.abs(heights[0]! / heights[1]! - 41 / 26) < 0.01 && Math.abs(heights[0]! / heights[2]! - 41 / 9) < 0.01, `${heights}`);
  assert.ok(bars.every((bar) => number(bar['width']) <= 24), 'bars are capped at 24 px');
  assert.deepEqual(texts(section(svg, 'chart-labels')), ['41', '26', '9', 'Review', 'Build', 'Delivery']);
  assert.equal(section(svg, 'chart-legend'), '', 'one series needs no legend');
});

test('mixed-sign horizontal grouped bar: negatives run left of one zero baseline, Spanish labels, each series named once', () => {
  const svg = drawn(renderFixture(fixture('mixed-sign-horizontal-grouped-bar')));
  const [axis] = elements(section(svg, 'chart-axes'), 'line');
  const zero = number(axis?.['x1']);
  const bars = elements(section(svg, 'chart-marks'), 'rect');
  const values = [12.5, -3.25, -8, 4.75, 0, -1.5];
  bars.forEach((bar, index) => {
    const left = number(bar['x']);
    const right = left + number(bar['width']);
    if ((values[index] ?? 0) < 0) {
      assert.ok(Math.abs(right - zero) < 1, `bar ${index} ends at zero`);
    } else {
      assert.ok(Math.abs(left - zero) < 1, `bar ${index} starts at zero`);
    }
  });
  assert.deepEqual(
    bars.map((bar) => bar['fill']),
    [0, 1, 0, 1, 0, 1].map((index) => CHART_SERIES_COLOURS[index]),
    'series keep their order inside every group',
  );
  const labels = texts(section(svg, 'chart-labels'));
  for (const expected of ['12,5 Studio', 'Print −3,25', '−8', '4,75', '0', '−1,5']) {
    assert.ok(labels.includes(expected), `label ${expected} in ${JSON.stringify(labels)}`);
  }
  assert.equal(texts(section(svg, 'chart-legend')).join('|'), 'Studio|Print');
  assert.match(svg, /<title id="chart-change-title">Cambio de horas por trimestre<\/title>/);
  assert.match(svg, /<desc id="chart-change-desc">El estudio creció/);
});

test('zero bar: an all-zero domain is [-1, 1], so the baseline sits mid-plot and every bar is empty', () => {
  const svg = drawn(renderFixture(fixture('zero-bar')));
  const bars = elements(section(svg, 'chart-marks'), 'rect');
  assert.ok(bars.length === 3 && bars.every((bar) => number(bar['height']) === 0));
  const [axis] = elements(section(svg, 'chart-axes'), 'line');
  const baseline = number(axis?.['y1']);
  // Plot top 24 (labels above), plot bottom 360 - 8 - 16 - 6 = 330: the middle is 177.
  assert.ok(Math.abs(baseline - 177) <= 1, `baseline at ${baseline}`);
  assert.deepEqual(texts(section(svg, 'chart-labels')).slice(0, 3), ['0', '0', '0']);
});

test('numeric single-series line: sorted by x although the rows are not, a marker per point, the last value labelled', () => {
  const svg = drawn(renderFixture(fixture('numeric-single-series-line')));
  const [path] = elements(svg, 'path');
  const xs = [...(path?.['d'] ?? '').matchAll(/[ML]([\d.]+),/g)].map((match) => Number(match[1]));
  assert.equal(xs.length, 6);
  assert.deepEqual([...xs].sort((a, b) => a - b), xs, 'the path runs left to right');
  assert.equal(elements(svg, 'circle').length, 6);
  assert.equal(path?.['stroke-width'], '2');
  assert.ok(texts(section(svg, 'chart-labels')).includes('27.5'));
});

test('date multi-series line: two series told apart by dash, legend and end labels; dates on the data points', () => {
  const svg = drawn(renderFixture(fixture('date-multi-series-line')));
  const paths = elements(svg, 'path');
  assert.equal(paths.length, 2);
  assert.equal(paths[0]?.['stroke-dasharray'], undefined);
  assert.ok(paths[1]?.['stroke-dasharray'], 'the second series is dashed');
  const labels = texts(section(svg, 'chart-labels'));
  for (const expected of ['Jul 6, 2026', 'Aug 3', 'Sep 7', 'Review 14', 'Build 3']) {
    assert.ok(labels.includes(expected), `label ${expected} in ${JSON.stringify(labels)}`);
  }
  assert.equal(texts(section(svg, 'chart-legend')).join('|'), 'Review|Build');
});

test('single-point line: one labelled point and no line', () => {
  const svg = drawn(renderFixture(fixture('single-point-line')));
  assert.equal(elements(svg, 'path').length, 0);
  assert.equal(elements(svg, 'circle').length, 1);
  const labels = texts(section(svg, 'chart-labels'));
  assert.ok(labels.includes('14') && labels.includes('Sep 7, 2026'), JSON.stringify(labels));
});

// ------------------------------------------------------------ negative fixtures

type NegativeCase = {
  name: string;
  note: string;
  csv: string;
  chart: Omit<ChartInput, 'table'>;
  problems: Array<{code: string; rule: string; field: ChartField | null; line: number | null}>;
};

test('negative fixtures report the expected codes, rules, fields and record lines, and draw nothing', () => {
  const cases = JSON.parse(readFileSync(fixturePath('charts', 'negative', 'cases.json'), 'utf8')) as NegativeCase[];
  assert.ok(cases.length >= 15);
  for (const negative of cases) {
    const csv = readFileSync(fixturePath('charts', 'negative', negative.csv), 'utf8');
    const result = renderChart({...negative.chart, table: table(csv)});
    assert.equal(result.svg, null, `${negative.name}: no SVG may be drawn from invalid data`);
    assert.deepEqual(
      result.problems.map(({code, rule, field, line}) => ({code, rule, field, line})),
      negative.problems,
      `${negative.name}: ${negative.note}`,
    );
    for (const found of result.problems) {
      assert.ok(found.message.length > 0 && found.fix.length > 0, `${negative.name}: message and fix`);
    }
  }
});

test('a missing column is named against the header, as in UX journey D2', () => {
  const result = chart('phase,hours\nReview,41\n', {type: 'bar', x: 'phse', y: 'hours', dataName: 'hours-by-phase.csv'});
  assert.equal(result.problems[0]?.message, 'x names a column that is not in hours-by-phase.csv: phase, hours.');
  const spaced = chart(' hours,x\n1,2\n', {type: 'bar', x: 'hours', y: 'x'});
  assert.match(spaced.problems[0]?.message ?? '', /: " hours", x\./, 'a name with surrounding spaces is quoted so the spaces show');
});

test('problems past the cap are summarized at the first unlisted line', () => {
  const csv = `phase,hours\n${Array.from({length: MAX_CHART_PROBLEMS + 10}, (_, index) => `p${index},x\n`).join('')}ok,1\n`;
  const result = chart(csv, {type: 'bar', x: 'phase', y: 'hours'});
  assert.equal(result.problems.length, MAX_CHART_PROBLEMS + 1);
  const last = result.problems.at(-1) as ChartProblem;
  assert.equal(last.code, 'too_many_problems');
  assert.equal(last.line, MAX_CHART_PROBLEMS + 2);
  assert.match(last.message, /^10 more/);
});

// ------------------------------------------------------------ safety

test('every piece of text is escaped and characters XML cannot carry are replaced', () => {
  const csv = 'phase,team,hours\n"<script>alert(""x"")</script> & co",A&B,1\nplain,"line\none",2\n';
  const svg = drawn(
    chart(csv, {
      type: 'bar',
      x: 'phase',
      y: 'hours',
      series: 'team',
      summary: `</title><script>bad()</script>${String.fromCharCode(7)}`,
      title: '<b>"quoted"</b>',
    }),
  );
  assert.ok(!svg.includes('<script'), 'no markup from data');
  assert.ok(!svg.includes('<b>'), 'no markup from the title');
  assert.match(svg, /&lt;script&gt;alert\("x"\)&lt;\/script&gt; &amp; co/);
  assert.match(svg, /A&amp;B/);
  assert.match(svg, /line one/, 'an embedded line break is shown as a space');
  assert.match(svg, /&lt;\/title&gt;&lt;script&gt;bad\(\)&lt;\/script&gt;\uFFFD<\/desc>/u);
  assert.equal(svg.match(/<title\b/g)?.length, 1);
  // Every character is legal XML 1.0.
  assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(svg));
});

/** Text content as a parser reads it: tags dropped, entities and character references decoded. */
function decoded(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/**
 * For each <text>, the characters outside every bidi isolate, embedding and
 * override, with the explicit controls matched as the Unicode Bidirectional
 * Algorithm matches them (BD9, X1–X8; no depth limit), and how many scopes are
 * still open at its end. A <text> is one bidi paragraph here: `dx` does not
 * start a new text chunk, so a name and the value after it are ordered together.
 */
function outsideIsolates(svg: string): Array<{text: string; outside: string; open: number}> {
  return [...svg.matchAll(/<text\b[^>]*>(.*?)<\/text>/g)].map((match) => {
    const text = decoded(match[1] ?? '');
    const scopes: boolean[] = []; // true for an isolate
    let outside = '';
    for (const char of text) {
      const code = char.codePointAt(0) ?? 0;
      if (code === 0x202a || code === 0x202b || code === 0x202d || code === 0x202e) {
        scopes.push(false); // LRE, RLE, LRO, RLO
      } else if (code === 0x202c) {
        if (scopes.length > 0 && scopes.at(-1) === false) {
          scopes.pop(); // PDF closes an embedding or override, never an isolate
        }
      } else if (code >= 0x2066 && code <= 0x2068) {
        scopes.push(true); // LRI, RLI, FSI
      } else if (code === 0x2069) {
        if (scopes.includes(true)) {
          while (scopes.pop() === false); // PDI closes its isolate and everything opened inside it
        }
      } else if (scopes.length === 0) {
        outside += char;
      }
    }
    return {text, outside, open: scopes.length};
  });
}

test('D48: a right-to-left name, or a bidi control in one, never reorders a value drawn beside it', () => {
  // The review's cases: an unclosed RLO, a Hebrew name, a trailing RLM, an
  // unclosed RLI (which would take the isolate's closing PDI) and a stray PDI
  // (which would close the isolate early) followed by an RLO.
  const names = ['Design‮', 'עיצוב', 'Review‏', 'Build⁧', 'Ship⁩‮it'];
  const lineRows = names.flatMap((name, index) => [1, 2, 3].map((x) => `${x},${name},${1230 + x + index}`));
  const barRows = names.flatMap((category, row) => names.map((name, index) => `${category},${name},${(row + index) % 2 === 0 ? '' : '-'}1234.5`));
  const charts: Array<[string, ChartResult]> = [
    ['line', chart(`x,s,y\n${lineRows.join('\n')}\n`, {type: 'line', x: 'x', y: 'y', series: 's'})],
    ['vertical bars', chart(`c,s,y\n${barRows.join('\n')}\n`, {type: 'bar', x: 'c', y: 'y', series: 's', width: 1600})],
    ['horizontal bars', chart(`c,s,y\n${barRows.join('\n')}\n`, {type: 'bar', orientation: 'horizontal', x: 'c', y: 'y', series: 's'})],
    ['one category', chart(`c,y\n${names.map((name, index) => `${name},-${index + 1}`).join('\n')}\n`, {type: 'bar', orientation: 'horizontal', x: 'c', y: 'y'})],
  ];
  for (const [kind, result] of charts) {
    const svg = drawn(result);
    for (const {text, outside, open} of outsideIsolates(`${section(svg, 'chart-legend')}\n${section(svg, 'chart-labels')}`)) {
      assert.equal(open, 0, `${kind}: ${JSON.stringify(text)} leaves a bidi scope open`);
      // Generated text only: values and ticks. Every name sits in its own isolate.
      assert.match(outside, /^[\d.,−]*$/, `${kind}: ${JSON.stringify(text)} has name text outside an isolate: ${JSON.stringify(outside)}`);
    }
  }
  // No raw bidi control reaches the SVG source: the isolates are character references.
  assert.match(drawn(chart('c,y\nDesign,1\n', {type: 'bar', x: 'c', y: 'y'})), />&#x2068;Design&#x2069;</);
});

test('every ID carries the caller prefix, so charts on one page never collide', () => {
  const csv = 'week,phase,hours\n2026-07-06,A,1\n2026-08-03,A,2\n2026-07-06,B,3\n';
  const one = drawn(chart(csv, {id: 'slide-3-chart', type: 'line', x: 'week', y: 'hours', series: 'phase', title: 'T'}));
  const two = drawn(chart(csv, {id: 'slide-4-chart', type: 'line', x: 'week', y: 'hours', series: 'phase', title: 'T'}));
  const ids = (svg: string) => [...svg.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1] ?? '');
  assert.deepEqual(ids(one), ['slide-3-chart-title', 'slide-3-chart-desc']);
  assert.ok(ids(two).every((id) => id.startsWith('slide-4-chart-')));
  assert.ok(!ids(one).some((id) => ids(two).includes(id)));
  for (const reference of [...one.matchAll(/aria-(?:labelledby|describedby)="([^"]+)"/g)].map((match) => match[1] ?? '')) {
    assert.ok(ids(one).includes(reference), `${reference} resolves inside the SVG`);
  }
  for (const id of ['', '1chart', 'a b', 'a"b', 'chart<', '-x', 'chárt']) {
    assert.throws(() => chart(csv, {id, type: 'line', x: 'week', y: 'hours'}), TypeError, JSON.stringify(id));
  }
});

test('the title and desc hooks carry the caller text as given; a blank summary is reported, never replaced', () => {
  const csv = 'phase,hours\nReview,41\n';
  const plain = drawn(chart(csv, {type: 'bar', x: 'phase', y: 'hours', summary: 'Review took 41 hours.'}));
  assert.match(plain, /aria-labelledby="chart-test-title">/);
  assert.match(plain, /<title id="chart-test-title">Review took 41 hours\.<\/title>/);
  assert.ok(!plain.includes('<desc'), 'no description duplicating the name');

  const titled = drawn(chart(csv, {type: 'bar', x: 'phase', y: 'hours', summary: 'Review took 41 hours.', title: 'Hours by phase'}));
  assert.match(titled, /aria-labelledby="chart-test-title" aria-describedby="chart-test-desc"/);
  assert.match(titled, /<title id="chart-test-title">Hours by phase<\/title>\n<desc id="chart-test-desc">Review took 41 hours\.<\/desc>/);

  const blank = chart(csv, {type: 'bar', x: 'phase', y: 'hours', summary: '  \n '});
  assert.equal(blank.summaryBlank, true);
  assert.match(drawn(blank), /<title id="chart-test-title"><\/title>/, 'nothing is invented in its place');
  assert.equal(chart(csv, {type: 'bar', x: 'phase', y: 'hours'}).summaryBlank, false);
});

test('a malformed call is a programming error, not a data problem', () => {
  const csv = 'phase,hours\nReview,41\n';
  const bad: Array<Partial<ChartInput>> = [
    {type: 'pie' as ChartInput['type']},
    {orientation: 'diagonal' as ChartInput['orientation']},
    {locale: 'fr' as ChartInput['locale']},
    {width: 100},
    {width: Number.NaN},
    {height: 5000},
  ];
  for (const override of bad) {
    assert.throws(() => chart(csv, {type: 'bar', x: 'phase', y: 'hours', ...override}), TypeError, JSON.stringify(override));
  }
});

// ------------------------------------------------------------ locales and styling

test('D41: the locale definitions are the fixed copies of the installed d3 files', () => {
  const read = (path: string) => JSON.parse(readFileSync(join(applicationRoot, 'node_modules', path), 'utf8')) as unknown;
  assert.deepEqual(CHART_LOCALES.en.number, read('d3-format/locale/en-US.json'));
  assert.deepEqual(CHART_LOCALES.es.number, read('d3-format/locale/es-ES.json'));
  assert.deepEqual(CHART_LOCALES.en.time, read('d3-time-format/locale/en-US.json'));
  assert.deepEqual(CHART_LOCALES.es.time, read('d3-time-format/locale/es-ES.json'));
  assert.ok(Object.isFrozen(CHART_LOCALES.es.number.grouping));
});

test('the locale changes labels only: marks are identical in en and es, and parsing never changes', () => {
  const marks = (svg: string) => `${section(svg, 'chart-marks')}\n${section(svg, 'chart-axes')}`;
  for (const name of ['date-multi-series-line', 'mixed-sign-horizontal-grouped-bar', 'numeric-single-series-line']) {
    const base = fixture(name);
    const en = drawn(renderChart({...base.input, locale: 'en'}));
    const es = drawn(renderChart({...base.input, locale: 'es'}));
    assert.equal(marks(en), marks(es), `${name}: geometry must not depend on the locale`);
    assert.notEqual(en, es);
  }
  // Source data always uses a decimal point; "12,5" in a Spanish chart's CSV is not a number.
  const spanish = chart('x,y\na,"12,5"\n', {type: 'bar', x: 'x', y: 'y', locale: 'es'});
  assert.equal(spanish.problems[0]?.code, 'y_invalid');
});

test('series take ink, muted, magenta, cyan and yellow in that order; text never wears a series colour', () => {
  assert.deepEqual([...CHART_SERIES_COLOURS], ['#1d1d1a', '#5f5f57', '#eb3a96', '#32bce9', '#f5ee2f']);
  assert.equal(MAX_CHART_SERIES, 5);
  const rows = ['A', 'B', 'C', 'D', 'E'].map((series, index) => `q1,${series},${index + 1}`).join('\n');
  const svg = drawn(chart(`quarter,series,value\n${rows}\n`, {type: 'bar', x: 'quarter', y: 'value', series: 'series'}));
  assert.deepEqual(
    elements(section(svg, 'chart-marks'), 'rect').map((bar) => bar['fill']),
    [...CHART_SERIES_COLOURS],
  );
  for (const colour of CHART_SERIES_COLOURS.slice(2)) {
    assert.ok(!new RegExp(`<t(?:ext|span)\\b[^>]*fill="${colour}"`).test(svg), `no text in ${colour}`);
  }
  const lines = drawn(renderFixture(fixture('five-series-daily-line')));
  const paths = elements(lines, 'path');
  assert.deepEqual(paths.map((path) => path['stroke']), [...CHART_SERIES_COLOURS]);
  assert.equal(new Set(paths.map((path) => path['stroke-dasharray'] ?? 'solid')).size, 5, 'five distinct line patterns');
});

test('IC03 order: bars keep first-occurrence categories and series, numeric categories are not sorted', () => {
  // Values 5–8 cannot be mistaken for the categories 10, 2 and 1.
  const svg = drawn(chart('x,s,y\n10,b,5\n2,a,6\n1,b,7\n2,b,8\n', {type: 'bar', x: 'x', y: 'y', series: 's'}));
  const categoryLabels = texts(section(svg, 'chart-labels')).filter((label) => ['10', '2', '1'].includes(label));
  assert.deepEqual(categoryLabels, ['10', '2', '1']);
  assert.equal(texts(section(svg, 'chart-legend')).join('|'), 'b|a');
  // Bar categories compare by source text; on a line chart 1 and 1.0 would collide.
  assert.deepEqual(chart('x,y\n1,5\n1.0,6\n', {type: 'bar', x: 'x', y: 'y'}).problems, []);
});

test('a positive-only bar chart still grows from zero', () => {
  const svg = drawn(chart('phase,hours\nA,100\nB,101\n', {type: 'bar', x: 'phase', y: 'hours'}));
  const heights = elements(section(svg, 'chart-marks'), 'rect').map((bar) => number(bar['height']));
  assert.ok(Math.abs(heights[0]! / heights[1]! - 100 / 101) < 0.01, 'no truncated axis exaggerates the difference');
});

test('a 100,000-row line chart renders in linear time', () => {
  const rows = Array.from({length: 100_000}, (_, index) => `${index},${index % 97}`).join('\n');
  const input = {id: 'chart-big', type: 'line' as const, x: 'x', y: 'y', summary: 'S.', locale: 'en' as const, table: table(`x,y\n${rows}\n`)};
  const started = performance.now();
  const result = renderChart(input);
  const elapsed = performance.now() - started;
  assert.ok(result.svg !== null);
  assert.equal(elements(result.svg, 'circle').length, 0, 'no marker per point on a dense line');
  assert.ok(elapsed < 10_000, `took ${Math.round(elapsed)} ms`);
});

test('long labels on a narrow chart widen the drawing instead of inverting the scale', () => {
  const long = 'A category name far longer than any sensible label';
  const csv = `x,s,y\n${long},${long} one,-1234.567\n${long},${long} two,9876.54\n`;
  for (const spec of [
    {type: 'bar' as const, orientation: 'horizontal' as const},
    {type: 'line' as const},
  ]) {
    const input = spec.type === 'line' ? `x,s,y\n1,${long} one,-1234.567\n2,${long} one,9876.54\n` : csv;
    const result = chart(input, {...spec, x: 'x', y: 'y', series: 's', width: 240});
    const svg = drawn(result);
    assert.ok(result.width >= 240, `${spec.type}: width ${result.width}`);
    assert.match(svg, new RegExp(`viewBox="0 0 ${result.width} `));
    for (const bar of elements(section(svg, 'chart-marks'), 'rect')) {
      assert.ok(number(bar['width']) >= 0 && number(bar['x']) >= 0 && number(bar['x']) + number(bar['width']) <= result.width, JSON.stringify(bar));
    }
    for (const point of elements(svg, 'circle')) {
      assert.ok(number(point['cx']) > 0 && number(point['cx']) < result.width, JSON.stringify(point));
    }
  }
  const single = chart('x,y\n2026-01-01,5\n', {type: 'line', x: 'x', y: 'y', width: 240});
  assert.ok(single.width >= 240);
  const svg = drawn(single);
  const [label] = elements(section(svg, 'chart-labels'), 'text').filter((text) => text['dy'] === '0.35em' && text['text-anchor'] === undefined);
  assert.ok(number(label?.['x']) + 7.5 * 1 <= single.width - 8, 'the point label stays inside the drawing');
});

test('too many series is reported together with the row problems, not after them', () => {
  const rows = Array.from({length: 6}, (_, index) => `2026-07-06,S${index},${index === 2 ? '' : index}`).join('\n');
  const result = chart(`week,phase,hours\n${rows}\n`, {type: 'line', x: 'week', y: 'hours', series: 'phase'});
  assert.deepEqual(
    result.problems.map(({code, line}) => ({code, line})),
    [
      {code: 'y_empty', line: 4},
      {code: 'too_many_series', line: null},
    ],
  );
});

test('shortened labels keep distinct series distinct', () => {
  const base = 'Quarterly revenue reported by the northern studio in';
  const csv = `q,s,y\nQ1,${base} 2025,1\nQ1,${base} 2026,2\n`;
  const svg = drawn(chart(csv, {type: 'bar', x: 'q', y: 'y', series: 's', width: 320}));
  const legendNames = texts(section(svg, 'chart-legend'));
  assert.equal(new Set(legendNames).size, 2, JSON.stringify(legendNames));
  assert.ok(legendNames.every((name) => name.includes('…') && /202[56]$/.test(name)), 'the middle is cut, the ends are kept');
  // Names that would still collide once shortened are shown in full.
  const twins = `q,s,y\nQ1,${base} A ${base},1\nQ1,${base} B ${base},2\n`;
  const full = texts(section(drawn(chart(twins, {type: 'bar', x: 'q', y: 'y', series: 's'})), 'chart-legend'));
  assert.deepEqual(full, [`${base} A ${base}`, `${base} B ${base}`]);
});

test('A2 precursor: editing a report CSV moves the plotted marks while the authored summary stays byte for byte', () => {
  const report = join(applicationRoot, 'examples', 'hours-report', 'assets', 'data');
  const cases = [
    {file: 'hours-by-phase.csv', spec: {type: 'bar' as const, orientation: 'horizontal' as const, x: 'phase', y: 'hours'}, from: 'Review,41', to: 'Review,44'},
    {file: 'hours-by-week.csv', spec: {type: 'line' as const, x: 'week', y: 'hours', series: 'phase'}, from: '2026-08-03,Review,8', to: '2026-08-03,Review,11'},
  ];
  for (const {file, spec, from, to} of cases) {
    const original = readFileSync(join(report, file), 'utf8');
    assert.ok(original.includes(from), `${file} still holds ${from}`);
    const summary = 'An authored summary, never regenerated from the data.';
    const before = drawn(chart(original, {...spec, summary}));
    const after = drawn(chart(original.replace(from, to), {...spec, summary}));
    assert.notEqual(section(before, 'chart-marks'), section(after, 'chart-marks'), `${file}: the marks follow the data`);
    const hooks = (svg: string) => /<title id="chart-test-title">(.*)<\/title>/.exec(svg)?.[1];
    assert.equal(hooks(before), summary);
    assert.equal(hooks(after), summary, `${file}: the summary is untouched`);
  }
});

test('values whose span overflows a double are a problem at their row, not a crash', () => {
  const bars = chart('x,y\na,1e308\nb,-1e308\n', {type: 'bar', x: 'x', y: 'y'});
  assert.deepEqual(bars.problems.map(({code, field, line}) => ({code, field, line})), [{code: 'y_invalid', field: 'y', line: 2}]);
  assert.match(bars.problems[0]?.message ?? '', /too large to draw/);
  const lines = chart('x,y\n1e308,1\n-1e308,2\n', {type: 'line', x: 'x', y: 'y'});
  assert.deepEqual(lines.problems.map(({code, field, line}) => ({code, field, line})), [{code: 'x_invalid', field: 'x', line: 2}]);
  // Large values that fit are drawn.
  drawn(chart('x,y\na,1.7e308\nb,1e300\n', {type: 'bar', x: 'x', y: 'y'}));
  drawn(chart('x,y\n1,1.7e308\n2,1e300\n', {type: 'line', x: 'x', y: 'y'}));
});

test('tiny values are labelled with their digits, never as zero', () => {
  const bars = drawn(chart('x,y\na,0.00000000000004\nb,0.00000000000009\n', {type: 'bar', x: 'x', y: 'y'}));
  const labels = texts(section(bars, 'chart-labels'));
  assert.ok(labels.includes('4e-14') && labels.includes('9e-14'), JSON.stringify(labels));
  const lines = drawn(chart('x,y\n1,0.00000000000004\n2,0.00000000000009\n', {type: 'line', x: 'x', y: 'y'}));
  assert.ok(!texts(section(lines, 'chart-labels')).some((label) => /^0\.0+$/.test(label)), 'no tick or value reads as zero');
});

test('a thinned date axis still shows the year on every kept tick where it changes', () => {
  const rows: string[] = [];
  for (let day = 0; day <= 400; day += 10) {
    rows.push(`${new Date(Date.UTC(2025, 2, 3 + day)).toISOString().slice(0, 10)},${day % 7}`);
  }
  const csv = `day,y\n${rows.join('\n')}\n`;
  const months = CHART_LOCALES.en.time.shortMonths as readonly string[];
  for (const width of [340, 480, 640, 960]) {
    const svg = drawn(chart(csv, {type: 'line', x: 'day', y: 'y', width}));
    const labels = texts(section(svg, 'chart-labels')).filter((label) => /^[A-Z][a-z]{2} \d/.test(label));
    assert.match(labels[0] ?? '', /, 2025$/, `${width}: the first tick names its year`);
    // Read the labels back with a running year: a missing year would put a date before its predecessor.
    let year = 0;
    let previous = Number.NEGATIVE_INFINITY;
    for (const label of labels) {
      const match = /^([A-Z][a-z]{2}) (\d+)(?:, (\d{4}))?$/.exec(label);
      assert.ok(match, label);
      year = match[3] === undefined ? year : Number(match[3]);
      const time = Date.UTC(year, months.indexOf(match[1] ?? ''), Number(match[2]));
      assert.ok(time > previous, `${width}: ${JSON.stringify(labels)} goes back in time at ${label}`);
      previous = time;
    }
  }
  // The case the review found: at 340 px the April 2026 tick used to read "Apr 1", as if 2025.
  const narrow = texts(section(drawn(chart(csv, {type: 'line', x: 'day', y: 'y', width: 340})), 'chart-labels'));
  assert.ok(narrow.includes('Apr 1, 2026') && !narrow.includes('Apr 1'), JSON.stringify(narrow));
});

test('shortened category labels stay distinct, and names that differ only in spacing or hidden characters are refused', () => {
  const prefix = 'A very long category name that has to be shortened';
  const svg = drawn(chart(`x,y\n${prefix} 1 end,1\n${prefix} 2 end,2\n`, {type: 'bar', orientation: 'horizontal', x: 'x', y: 'y', width: 240}));
  const categories = texts(section(svg, 'chart-labels')).filter((label) => label.startsWith('A '));
  assert.equal(new Set(categories).size, 2, JSON.stringify(categories));

  const spaced = chart('x,y\nReview,1\nReview ,2\na  b,3\na b,4\n', {type: 'bar', x: 'x', y: 'y'});
  assert.deepEqual(
    spaced.problems.map(({code, field, line}) => ({code, field, line})),
    [
      {code: 'ambiguous_name', field: 'x', line: 3},
      {code: 'ambiguous_name', field: 'x', line: 5},
    ],
  );
  const series = chart('x,s,y\n1,North,1\n2,North ,2\n', {type: 'line', x: 'x', y: 'y', series: 's'});
  assert.deepEqual(series.problems.map(({code, field}) => ({code, field})), [{code: 'ambiguous_name', field: 'series'}]);

  // A character the chart draws as nothing counts as nothing, in a series name as in a category (W5R-21), and the
  // message shows it. The negative fixture hidden-characters.csv holds the category cases.
  const hidden = chart('x,s,y\n1,North,1\n2,North⁠,2\n3,No͏rth,3\n4,North\u{e0001},4\n5,N o r t h,5\n', {type: 'line', x: 'x', y: 'y', series: 's'});
  assert.deepEqual(
    hidden.problems.map(({code, field, line}) => ({code, field, line})),
    [
      {code: 'ambiguous_name', field: 'series', line: 3},
      {code: 'ambiguous_name', field: 'series', line: 4},
      {code: 'ambiguous_name', field: 'series', line: 5},
    ],
  );
  assert.equal(
    hidden.problems[0]?.message,
    'The series values "North" (line 2) and "North\\u2060" differ only in spacing or hidden characters, so the chart would show them with the same name.',
  );
  // Hidden characters between spaces leave the spaces together, and together they are one space.
  const separated = chart('x,y\na b,1\na ​ b,2\n', {type: 'bar', x: 'x', y: 'y'});
  assert.deepEqual(separated.problems.map(({code, line}) => ({code, line})), [{code: 'ambiguous_name', line: 3}]);
});

test('an orientation or field problem does not hide the row problems beside it', () => {
  // One valid y keeps the column usable, so the other rows are judged one by one.
  const oriented = chart('x,y\n1,\n2,a\n3,5\n', {type: 'line', orientation: 'vertical', x: 'x', y: 'y'});
  assert.deepEqual(
    oriented.problems.map(({code, line}) => ({code, line})),
    [
      {code: 'orientation_line', line: null},
      {code: 'y_empty', line: 2},
      {code: 'y_invalid', line: 3},
    ],
  );
  const textX = chart('phase,hours\nReview,\nBuild,26\n', {type: 'line', x: 'phase', y: 'hours'});
  assert.deepEqual(
    textX.problems.map(({code, field, line}) => ({code, field, line})),
    [
      {code: 'x_invalid', field: 'x', line: null},
      {code: 'y_empty', field: 'y', line: 2},
    ],
  );
  // A repeated (x, series) pair is reported even when its y is also wrong.
  const both = chart('x,y\na,1\na,oops\n', {type: 'bar', x: 'x', y: 'y'});
  assert.deepEqual(both.problems.map(({code, line}) => ({code, line})), [
    {code: 'y_invalid', line: 3},
    {code: 'duplicate_point', line: 3},
  ]);
});

test('a cell holding only whitespace is empty: never an unlabelled bar, point or series', () => {
  const codes = (result: ChartResult) => result.problems.map(({code, field, line}) => ({code, field, line}));
  const bars = chart('x,y\n  ,1\n\t,2\nb, \nc,3\n', {type: 'bar', x: 'x', y: 'y'});
  assert.deepEqual(codes(bars), [
    {code: 'x_empty', field: 'x', line: 2},
    {code: 'x_empty', field: 'x', line: 3},
    {code: 'y_empty', field: 'y', line: 4},
  ]);
  assert.equal(bars.svg, null);
  assert.match(bars.problems[0]?.message ?? '', /holds only whitespace/);
  assert.match(chart('x,y\n,1\n', {type: 'bar', x: 'x', y: 'y'}).problems[0]?.message ?? '', /is empty/, 'an empty cell keeps its wording');
  const series = chart('x,s,y\na,North,1\na,\t,2\n', {type: 'bar', x: 'x', y: 'y', series: 's'});
  assert.deepEqual(codes(series), [{code: 'series_empty', field: 'series', line: 3}]);
  // A blank x on a line chart is empty, not text that makes the whole column unusable.
  assert.deepEqual(codes(chart('x,y\n  ,1\n', {type: 'line', x: 'x', y: 'y'})), [{code: 'x_empty', field: 'x', line: 2}]);
  // A y column of blanks is empty row by row, not a column without numbers.
  assert.deepEqual(codes(chart('x,y\na, \nb,  \n', {type: 'bar', x: 'x', y: 'y'})), [
    {code: 'y_empty', field: 'y', line: 2},
    {code: 'y_empty', field: 'y', line: 3},
  ]);
});

test('D48: the label advance table is never narrower than the shipped Inter, and not far wider', () => {
  for (const [char, advance] of Object.entries(INTER_METRICS.advances)) {
    const inter = advance * CHART_FONT_SIZE;
    assert.ok(chartLabelWidth(char) >= inter, `${JSON.stringify(char)} is laid out at ${chartLabelWidth(char)} px; Inter sets it at ${inter} px`);
  }
  for (const text of [...UPPER_CASE_NAMES, 'Review', 'Delivery', 'Cambio de horas por trimestre', '−1,234.5', '1.234,5', 'Jul 6, 2026']) {
    const ratio = chartLabelWidth(text) / interWidth(text);
    assert.ok(ratio >= 1 && ratio <= 1.25, `${text}: laid out at ${ratio.toFixed(2)} times its width in Inter`);
  }
  // Characters no shipped face draws get a wide allowance; the bidi isolates and other controls none.
  assert.equal(chartLabelWidth('⁨⁩‍́'), 0);
  assert.ok(chartLabelWidth('漢') >= CHART_FONT_SIZE && chartLabelWidth('Ж') >= CHART_FONT_SIZE);
});

test('D48: drawn with the shipped Inter, no label of any chart kind leaves the viewBox, even a long upper-case name', () => {
  // Capitals average 0.68 em in Inter and W is a full em; a 0.6 em estimate
  // clipped "WORKFORCE MANAGEMENT" to "ORKFORCE MANAGEMENT" and a value's last digit.
  for (const {name, input} of upperCaseCharts()) {
    const svg = drawn(renderChart(input));
    assert.deepEqual(labelsOutside(svg), [], `${name}: labels outside the viewBox`);
  }
});

test('D48: dense vertical bars widen the drawing, so bars keep their order and rotated values neither collide nor leave it', () => {
  // The review's thresholds: bars of neighbouring categories began to cross at 47 × 5, 87 × 3 and
  // 151 × 2 categories at 640 px and at 17 × 5 at 240 px; the last rotated value left the viewBox at
  // 15, 22 and 60 × 5 at 240 px and at 100 × 5 at 640 px; 36 × 5 at 640 px printed values over one
  // another. One series needs a line per value too.
  const cases: Array<[categories: number, k: number, width: number]> = [
    [47, 5, 640], [87, 3, 640], [151, 2, 640], [17, 5, 240], [15, 5, 240], [22, 5, 240], [60, 5, 240], [100, 5, 640], [36, 5, 640], [40, 1, 240],
  ];
  for (const [categories, k, width] of cases) {
    const label = `${categories} × ${k} at ${width} px`;
    const svg = drawn(renderChart(denseBars(categories, k, width)));
    // Bars are drawn category by category, series by series; left to right they must come in that order, apart.
    const bars = elements(section(svg, 'chart-marks'), 'rect').map((bar) => ({left: number(bar['x']), right: number(bar['x']) + number(bar['width']), fill: bar['fill']}));
    const ordered = [...bars].sort((a, b) => a.left - b.left);
    assert.deepEqual(ordered.map((bar) => bar.fill), bars.map((bar) => bar.fill), `${label}: series order inside every group`);
    const crossing = ordered.filter((bar, index) => index > 0 && bar.left - (ordered[index - 1]?.right ?? 0) < 2 - 0.02);
    assert.equal(crossing.length, 0, `${label}: ${crossing.length} bars closer than the 2 px gap to the one before`);
    // Values turned upright need a line each.
    const centres = [...new Set([...section(svg, 'chart-labels').matchAll(/<text transform="translate\(([-\d.]+),[-\d.]+\) rotate\(-90\)"/g)].map((match) => Number(match[1])))];
    assert.ok(centres.length > 0, `${label}: the values are upright`);
    const pitch = Math.min(...centres.slice(1).map((centre, index) => centre - (centres[index] ?? 0)));
    assert.ok(pitch >= 16 - 0.02, `${label}: upright labels ${pitch.toFixed(2)} px apart`);
    assert.deepEqual(labelsOutside(svg), [], `${label}: labels outside the viewBox`);
  }
});

test('names shown in full to stay distinct widen the drawing instead of running off its edge', () => {
  const name = (word: string) => `Library visits counted by volunteers at the ${word} branch entrance on weekday mornings before the doors open to the public`;
  const north = name('north');
  const south = name('south');
  // The width the shipped Inter draws the name with.
  const estimate = interWidth;
  for (const width of [240, 640]) {
    // A category label turned 45° reaches left of its bar by about 0.71 of its length.
    const result = chart(`x,y\n${north},4\n${south},7\n`, {type: 'bar', x: 'x', y: 'y', width});
    const svg = drawn(result);
    assert.match(svg, new RegExp(`viewBox="0 0 ${result.width} ${result.height}"`));
    const rotated = [...visible(section(svg, 'chart-labels')).matchAll(/<text transform="translate\(([-\d.]+),([-\d.]+)\) rotate\(-45\)"[^>]*>([^<]*)<\/text>/g)];
    assert.deepEqual(
      rotated.map((match) => match[3]),
      [north, south],
      `${width}: shortened, the two names would look alike, so they are shown in full`,
    );
    for (const [, x, y, label] of rotated) {
      const reach = estimate(label ?? '') * Math.SQRT1_2;
      assert.ok(number(x) - reach >= 0, `${width}: the label starts at x ${number(x) - reach}`);
      assert.ok(number(y) + reach <= result.height, `${width}: the label ends below the drawing`);
    }

    // A legend entry wider than the drawing widens it too.
    for (const spec of [
      {type: 'bar' as const, csv: `q,s,y\nQ1,${north},4\nQ1,${south},7\n`},
      {type: 'bar' as const, orientation: 'horizontal' as const, csv: `q,s,y\nQ1,${north},4\nQ1,${south},7\n`},
      {type: 'line' as const, csv: `q,s,y\n1,${north},4\n2,${north},5\n1,${south},7\n2,${south},6\n`},
    ]) {
      const keyed = chart(spec.csv, {type: spec.type, orientation: spec.orientation, x: 'q', y: 'y', series: 's', width});
      const drawing = drawn(keyed);
      assert.match(drawing, new RegExp(`viewBox="0 0 ${keyed.width} ${keyed.height}"`));
      const names = texts(section(drawing, 'chart-legend'));
      assert.deepEqual(names, [north, south], `${width} ${spec.type} ${spec.orientation ?? ''}: the legend shows the names in full`);
      elements(section(drawing, 'chart-legend'), 'text').forEach((entry, index) => {
        const right = number(entry['x']) + estimate(names[index] ?? '');
        assert.ok(right + 8 <= keyed.width, `${width} ${spec.type} ${spec.orientation ?? ''}: a legend entry ends at ${right} of ${keyed.width}`);
      });
    }
  }
});
