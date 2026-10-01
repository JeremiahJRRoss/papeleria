/**
 * M1.11 / IC03: build-time chart SVG.
 *
 * `renderChart` is a pure function from a parsed CSV table and a chart
 * definition to an SVG string: no filesystem, clock, randomness or DOM, so the
 * same input always yields the same bytes. Data problems are reported, never
 * repaired. An empty, whitespace-only or invalid x, y or series cell, a
 * duplicate (x, series) pair, a missing column or a header-only file returns
 * problems carrying the record's line (IC01) and no SVG; nothing is converted
 * to zero or dropped.
 *
 * Semantics follow IC03. Bars keep the first-occurrence order of categories
 * and series and grow from a zero baseline in a domain that contains zero;
 * lines sort by x within each series, x being all numbers or all dates. An
 * all-zero domain is [-1, 1]. A line chart with one x value draws labelled
 * points.
 *
 * Drawing follows UX §09 and the theme tokens (D48): ink marks on white, 1 px
 * rule axes, hairline gridlines only behind lines, value labels at .78rem in
 * text colours, never in a series colour. Series take ink, muted, then the
 * process magenta, cyan and yellow, in that fixed order and never cycled; a
 * chart holds at most five. Colour never carries identity alone: two or more
 * series get a legend, bars keep series order inside every group and name
 * each series on its first bar, lines add dash patterns and direct end labels.
 *
 * Every text node is cleaned and escaped, and every name drawn (category or
 * series) is a bidi isolate, so right-to-left text or a bidi control in a name
 * never reorders the value drawn beside it. The caller's summary fills the
 * `<title>`/`<desc>` hooks as given: this module never writes a summary (R05 is
 * the manifest's rule) and reports whether the given one is blank. Every ID is
 * prefixed with the caller's chart id (D44). Numbers and dates are labelled
 * with fixed en/es locale definitions (D41); parsing never depends on locale.
 */
import {formatLocale, precisionFixed, type FormatLocaleDefinition, type FormatLocaleObject} from 'd3-format';
import {scaleBand, scaleLinear, scaleUtc} from 'd3-scale';
import {line as linePath} from 'd3-shape';
import {timeFormatLocale, type TimeLocaleDefinition} from 'd3-time-format';

import {parseDateCell, parseNumberCell, type CsvTable} from './csv.js';
import {listForMessage, quoteValue} from './finding.js';
import {deepFreeze} from './freeze.js';

export type ChartType = 'bar' | 'line';
export type ChartOrientation = 'vertical' | 'horizontal';
export type ChartLocale = 'en' | 'es';

export type ChartInput = {
  /** Caller-supplied prefix for every ID in the SVG: a letter, then letters, digits, `-` or `_`. */
  id: string;
  type: ChartType;
  /** Bar charts only; `vertical` when absent. */
  orientation?: ChartOrientation;
  table: CsvTable;
  x: string;
  y: string;
  series?: string;
  /** Rendered as given into the accessible name or description; never generated. */
  summary: string;
  /** Optional accessible name; when absent the summary is the name. */
  title?: string;
  locale: ChartLocale;
  /** The data file's name, used only in problem messages. */
  dataName?: string;
  /** Drawing width in CSS px, 240–2400; 640 when absent. */
  width?: number;
  /** Minimum drawing height for vertical bars and lines, 160–2400; 360 when absent. A horizontal bar chart's height follows its categories. */
  height?: number;
};

export type ChartField = 'x' | 'y' | 'series' | 'orientation';
export type ChartProblemCode =
  | 'column_missing'
  | 'header_only'
  | 'x_empty'
  | 'x_invalid'
  | 'y_empty'
  | 'y_invalid'
  | 'series_empty'
  | 'duplicate_point'
  | 'ambiguous_name'
  | 'too_many_series'
  | 'orientation_line'
  | 'too_many_problems';
export type ChartProblem = {
  code: ChartProblemCode;
  /** `orientation_line` is R09 (C14); everything else is R13. */
  rule: 'R09' | 'R13';
  message: string;
  fix: string;
  /** The CSV line where the offending record starts; null when the problem belongs to the manifest field in `field`. */
  line: number | null;
  field: ChartField | null;
};
export type ChartResult = {
  /** Null whenever `problems` is not empty. */
  svg: string | null;
  width: number;
  height: number;
  problems: ChartProblem[];
  /** True when the given summary has no non-whitespace character (R05 is reported by the caller). */
  summaryBlank: boolean;
};

export type ChartLocaleDefinition = {
  number: FormatLocaleDefinition;
  time: TimeLocaleDefinition;
  /** d3-time-format specifiers for date labels without and with the year. */
  day: string;
  dayWithYear: string;
};

/**
 * D41: fixed locale definitions, copied from d3-format 3.1.2 and
 * d3-time-format 4.1.0 (`locale/en-US.json`, `locale/es-ES.json`). A test
 * compares them with the installed files, so a d3 upgrade cannot change a
 * label without someone reading the difference. Both are ISC: THIRD_PARTY.md
 * lists the copy with its notice, and each package's licence file travels in
 * `licenses/packages/` (D126).
 */
export const CHART_LOCALES: Readonly<Record<ChartLocale, ChartLocaleDefinition>> = deepFreeze({
  en: {
    number: {decimal: '.', thousands: ',', grouping: [3], currency: ['$', '']},
    time: {
      dateTime: '%x, %X',
      date: '%-m/%-d/%Y',
      time: '%-I:%M:%S %p',
      periods: ['AM', 'PM'],
      days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
      shortDays: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
      months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
      shortMonths: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    },
    day: '%b %-d',
    dayWithYear: '%b %-d, %Y',
  },
  es: {
    number: {decimal: ',', thousands: '.', grouping: [3], currency: ['', `${String.fromCharCode(0xa0)}€`]},
    time: {
      dateTime: '%A, %e de %B de %Y, %X',
      date: '%d/%m/%Y',
      time: '%H:%M:%S',
      periods: ['AM', 'PM'],
      days: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'],
      shortDays: ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'],
      months: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
      shortMonths: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'],
    },
    day: '%-d %b',
    dayWithYear: '%-d %b %Y',
  },
});

/** Theme colours (theme/css/tokens.css). Text uses ink and muted only. */
const INK = '#1d1d1a';
const MUTED = '#5f5f57';
const RULE = '#d8d8d1';
const GRID = '#efefeb';
const SURFACE = '#ffffff';
/**
 * Series colours in fixed order (D48): ink, muted, then the process family.
 * Lightness rises monotonically, so series stay apart in a monochrome print.
 * Process key (#050708) is left out: it is ΔE 10.4 from ink, too close to tell apart.
 */
export const CHART_SERIES_COLOURS: readonly string[] = Object.freeze([INK, MUTED, '#eb3a96', '#32bce9', '#f5ee2f']);
/** Line dash patterns per series, drawn with round caps. */
const DASHES: ReadonlyArray<string | undefined> = [undefined, '10 6', '0.1 5', '10 5 0.1 5', '4 6'];
export const MAX_CHART_SERIES = CHART_SERIES_COLOURS.length;
export const MAX_CHART_PROBLEMS = 50;

const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 360;
const FONT_FAMILY = "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif";
/** .78rem at a 16 px root (UX §09). */
const FONT_SIZE = 12.5;
/**
 * Label advances by character class, in em (D48). There is no text
 * measurement without a browser, so labels are laid out with this fixed table,
 * never with the fonts a machine has. It comes from the shipped Inter
 * (theme/fonts, latin and latin-ext subsets) measured character by character
 * in Chromium at 12.5 px with tabular figures: every class sits about 5% above
 * its widest member, so no label is laid out narrower than Inter sets it, and
 * kerning only makes one shorter. That margin also holds where an engine hints
 * the font at a whole 13 px and rounds each advance, as Chromium does on the CI
 * runners. The first class that holds a character gives
 * its advance; the widest members measured are in the comments. Twelve members
 * are not in the shipped subsets (ŉ Ǆ ‐ ‑ ‒ ― ‛ ‟ ‡ ‰ ‱ �): a fallback face
 * draws them, so their values are what one measured, an estimate rather than
 * a bound. The browser suite holds the table to every character Inter draws.
 */
const ADVANCE_CLASSES: ReadonlyArray<readonly [em: number, members: RegExp]> = [
  // Combining marks and format controls, the bidi isolates among them, take no room.
  [0, /[\p{Mn}\p{Me}\p{Cf}]/u],
  // Space, i j l I and the narrow punctuation: 0.300 (').
  [0.32, /[ !',.:;Iijl¡¦·¸‘’‚‛ı]/u],
  // f r t, brackets, slashes and bars: 0.391.
  [0.42, /[()/[\]{}\\|`´frt]/u],
  // Tabular figures and the signs set on their width, U+2212 among them: 0.648.
  [0.7, /[0-9#$&*+\-<=>~±×÷−]/u],
  // M m w and the ellipsis: 0.917 (ǣ); M 0.903, … 0.864.
  [0.96, /[MmwŵĲƊƜƢǌǣǽȸȹ…©¼½¾]/u],
  // W, % and @, the Æ and Œ ligatures and the em dash: 1.007 (W). ―, ‰ and U+FFFD are a fallback face's.
  [1.08, /[WŴ%@ÆŒæœƕǋǢǼ—―‰�]/u],
  // The Latin digraph letters, the dz digraph, the epigraphic archaic M and two currency signs: 1.391 (₯);
  // ꟿ 1.179, ʣ 1.075, which the 1.1 em default holds only unrounded.
  [1.46, /[ǄǅǆǇǊǱǲǳǶʣꟿ₨₯]/u],
  // Per ten thousand, which a fallback face draws: 1.735 in one, 1.84 in another.
  [1.82, /‱/u],
  // The other capitals of the Latin blocks, and the few other letters and signs as wide: 0.769 (ȡ); O 0.765.
  [0.82, /(?=[A-ZÀ-ɏ])[\p{Lu}\p{Lt}]|[ďƅƴǥȡȵ¤¬®€]/u],
  // Everything else the Latin blocks and the common punctuation hold, lower case first of all: 0.616 (ß).
  [0.66, /[ -ɏ‐‑‒–“”„‟†‡•‹›™]/u],
  // Emoji come from a colour fallback face: 1.248 there.
  [1.32, /\p{Extended_Pictographic}/u],
];
/**
 * Any other character. Inter's own beyond the Latin blocks (IPA, the modifier
 * letters, Latin Extended Additional, -C and -D) are all narrower; a character
 * Inter lacks is drawn by a fallback face whose widths are unknown, so for it
 * this is an estimate: CJK measured 1.023, Cyrillic 1.010.
 */
const FALLBACK_ADVANCE = 1.1;
const LINE_HEIGHT = 16;
const PAD = 8;
/** Surface gap between touching bars. */
const GAP = 2;
const BAR = 24;
const GROUPED_BAR = 16;
const NAME_MAX_WIDTH = 150;
/** The narrowest plot a chart may have; long labels widen the drawing rather than invert its scale. */
const MIN_PLOT_WIDTH = 120;
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
/** Beyond this many decimals a label switches to a general format rather than round to zero. */
const MAX_FIXED_DIGITS = 12;
const ELLIPSIS = '…';
const REPLACEMENT = String.fromCharCode(0xfffd);
/**
 * Default-ignorable characters: format controls such as the zero-width space,
 * the joiners, the soft hyphen and the bidi isolates, the variation selectors
 * and the tag characters. A name drawn with one looks like the name without it
 * (W5R-21). The format characters that are drawn, such as U+0600 ARABIC
 * NUMBER SIGN, are not among them.
 */
const DRAWN_AS_NOTHING = /\p{Default_Ignorable_Code_Point}/gu;

// ---------------------------------------------------------------- text

/** Replaces characters XML cannot carry and collapses whitespace, as SVG would display it. */
function clean(text: string): string {
  let result = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const allowed =
      code === 0x9 ||
      code === 0xa ||
      code === 0xd ||
      (code >= 0x20 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd) ||
      code >= 0x10000;
    result += allowed ? char : REPLACEMENT;
  }
  return result.replace(/\s+/g, ' ').trim();
}

/** True when a cell would show nothing once cleaned: empty, or only whitespace. */
function blank(text: string): boolean {
  return clean(text) === '';
}

/** How a blank cell reads in a message. */
function blankness(text: string): string {
  return text === '' ? 'is empty' : 'holds only whitespace';
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(text: string): string {
  return escapeText(text).replace(/"/g, '&quot;');
}

/** User text, ready for a text node. */
function userText(text: string): string {
  return escapeText(clean(text));
}

/** UAX #9 isolate controls: LRI, RLI and FSI open an isolate, PDI closes one. */
const LRI = 0x2066;
const RLI = 0x2067;
const FSI = 0x2068;
const PDI = 0x2069;

/**
 * An author's name, ready for a text node, as a bidi isolate: U+2068 FIRST
 * STRONG ISOLATE, the name cleaned and escaped, U+2069 POP DIRECTIONAL ISOLATE.
 * Right-to-left text or a bidi control in the name then stays inside it and
 * cannot reorder a value drawn after it in the same <text>; the closing PDI
 * also ends any embedding or override the name left open (UAX #9 X6a). The
 * name's own isolate controls are balanced first, so a stray PDI in it cannot
 * close the isolate early and an initiator it leaves open cannot take the
 * closing PDI. The controls are character references, so no raw bidi control
 * sits in the SVG source.
 */
function isolatedText(name: string): string {
  const text = clean(name);
  let open = 0;
  let stray = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === LRI || code === RLI || code === FSI) {
      open += 1;
    } else if (code === PDI) {
      if (open > 0) {
        open -= 1;
      } else {
        stray += 1;
      }
    }
  }
  return `${'&#x2068;'.repeat(stray + 1)}${escapeText(text)}${'&#x2069;'.repeat(open + 1)}`;
}

/** Largest of the values, or `floor` when there are none; never spreads a data-sized array. */
function maxOf(values: Iterable<number>, floor = 0): number {
  let result = floor;
  for (const value of values) {
    if (value > result) {
      result = value;
    }
  }
  return result;
}

const advances = new Map<string, number>();

/** One character's advance in px, from the first class in ADVANCE_CLASSES that holds it. */
function advance(char: string): number {
  let width = advances.get(char);
  if (width === undefined) {
    width = (ADVANCE_CLASSES.find(([, members]) => members.test(char))?.[0] ?? FALLBACK_ADVANCE) * FONT_SIZE;
    advances.set(char, width);
  }
  return width;
}

function textWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += advance(char);
  }
  return width;
}

/**
 * The width, in px, a chart lays `text` out with: the advance table summed,
 * never a measurement, so layout is the same on every machine (D48).
 */
export function chartLabelWidth(text: string): number {
  return textWidth(text);
}

/**
 * Shortens text to an estimated width by cutting the middle, so names that
 * differ only at the end ("… 2025", "… 2026") stay different. Characters are
 * kept from the two ends in turn, the start first, while they and the
 * ellipsis fit, and at least one from each end.
 */
function fit(text: string, maxWidth: number): string {
  const characters = [...text];
  if (characters.length < 3 || textWidth(text) <= maxWidth) {
    return text;
  }
  let head = 0;
  let tail = 0;
  let width = textWidth(ELLIPSIS);
  while (head + tail < characters.length - 1) {
    const fromHead = head <= tail;
    const next = advance(characters[fromHead ? head : characters.length - 1 - tail] ?? '');
    if (head > 0 && tail > 0 && width + next > maxWidth) {
      break;
    }
    width += next;
    if (fromHead) {
      head += 1;
    } else {
      tail += 1;
    }
  }
  return characters.slice(0, head).join('') + ELLIPSIS + characters.slice(characters.length - tail).join('');
}

/** Shortened names, or the full ones if shortening would make two of them look alike. */
function displayNames(names: readonly string[], maxWidth: number): string[] {
  const full = names.map((name) => clean(name));
  const fitted = full.map((name) => fit(name, maxWidth));
  return new Set(fitted).size === fitted.length ? fitted : full;
}

/** A cell as a problem quotes it: a JSON string, hidden characters shown, a long one cut (D175). */
function quoted(text: string): string {
  return quoteValue(text, 'json');
}

/** A column name, bare when nothing at its ends or inside could be misread, quoted otherwise. */
function quoteName(name: string): string {
  return quoteValue(name, /^[^\s,"'][^,"']*[^\s,"']$|^[^\s,"']$/.test(name) ? 'none' : 'json');
}

// ---------------------------------------------------------------- SVG

/** Coordinates to two decimals, with no negative zero. */
function num(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error('a chart coordinate is not finite; this is a Papeleria bug');
  }
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? '0' : String(rounded);
}

/** A 1 px line centred on a pixel row or column. */
function crisp(value: number): number {
  return Math.floor(value) + 0.5;
}

type AttributeValue = string | number | undefined;

function element(name: string, attributes: ReadonlyArray<readonly [string, AttributeValue]>, content?: string): string {
  const rendered = attributes
    .filter((pair): pair is readonly [string, string | number] => pair[1] !== undefined)
    .map(([key, value]) => ` ${key}="${typeof value === 'number' ? num(value) : escapeAttribute(value)}"`)
    .join('');
  return content === undefined ? `<${name}${rendered}/>` : `<${name}${rendered}>${content}</${name}>`;
}

function group(className: string, parts: readonly string[]): string {
  return parts.length === 0 ? '' : `<g class="${className}">\n${parts.join('\n')}\n</g>`;
}

// ---------------------------------------------------------------- labels

type Formats = {
  numbers: FormatLocaleObject;
  day: (date: Date) => string;
  dayWithYear: (date: Date) => string;
};

const formatsByLocale = new Map<ChartLocale, Formats>();

function formatsFor(locale: ChartLocale): Formats {
  let formats = formatsByLocale.get(locale);
  if (formats === undefined) {
    const definition = CHART_LOCALES[locale];
    const time = timeFormatLocale(definition.time);
    formats = {
      numbers: formatLocale(definition.number),
      day: time.utcFormat(definition.day),
      dayWithYear: time.utcFormat(definition.dayWithYear),
    };
    formatsByLocale.set(locale, formats);
  }
  return formats;
}

/**
 * A data value labelled with the precision its source text was written with:
 * `1.50` stays two places, `41` none. Scientific notation uses a general format.
 */
function valueLabel(formats: Formats, text: string, value: number, grouped = true): string {
  const plain = /^[+-]?\d*(?:\.(\d*))?$/.exec(text);
  const digits = plain === null ? null : (plain[1]?.length ?? 0);
  // Scientific notation, or more decimals than fixed notation shows faithfully: a general
  // format, so a tiny value never prints as zero.
  if (digits === null || digits > MAX_FIXED_DIGITS) {
    return formats.numbers.format(grouped ? ',~g' : '~g')(value);
  }
  return formats.numbers.format(`${grouped ? ',' : ''}.${digits}f`)(value);
}

/** Tick labels with the precision the tick step needs. */
function tickLabels(formats: Formats, ticks: readonly number[], grouped: boolean): string[] {
  const step = ticks.length > 1 ? Math.abs((ticks[1] ?? 0) - (ticks[0] ?? 0)) : 1;
  const digits = precisionFixed(step);
  const format = formats.numbers.format(
    digits > MAX_FIXED_DIGITS ? `${grouped ? ',' : ''}~g` : `${grouped ? ',' : ''}.${digits}f`,
  );
  return ticks.map((tick) => format(tick));
}

/** Date labels; the year appears on the first label and wherever it changes. */
function dateLabels(formats: Formats, times: readonly number[]): string[] {
  return times.map((time, index) => {
    const date = new Date(time);
    const previous = index === 0 ? null : new Date(times[index - 1] ?? 0);
    const withYear = previous === null || previous.getUTCFullYear() !== date.getUTCFullYear();
    return withYear ? formats.dayWithYear(date) : formats.day(date);
  });
}

// ---------------------------------------------------------------- validation

type XKind = 'category' | 'number' | 'date';

type Datum = {
  line: number;
  xText: string;
  /** Number or UTC milliseconds for line charts; null for bar categories. */
  xValue: number | null;
  yText: string;
  y: number;
  series: string;
};

type Model = {data: Datum[]; categories: string[]; series: string[]; xKind: XKind};

function problem(code: ChartProblemCode, field: ChartField | null, line: number | null, message: string, fix: string): ChartProblem {
  return {code, rule: code === 'orientation_line' ? 'R09' : 'R13', message, fix, line, field};
}

function capProblems(problems: ChartProblem[]): ChartProblem[] {
  if (problems.length <= MAX_CHART_PROBLEMS) {
    return problems;
  }
  const listed = problems.slice(0, MAX_CHART_PROBLEMS);
  const next = problems[MAX_CHART_PROBLEMS];
  listed.push(
    problem(
      'too_many_problems',
      null,
      next?.line ?? null,
      `${problems.length - MAX_CHART_PROBLEMS} more chart problems in this data are not listed.`,
      'Fix the problems listed above, then check again.',
    ),
  );
  return listed;
}

function analyse(input: ChartInput): {problems: ChartProblem[]; model: Model | null} {
  const problems: ChartProblem[] = [];
  const {table} = input;
  if (input.type === 'line' && input.orientation !== undefined) {
    problems.push(
      problem(
        'orientation_line',
        'orientation',
        null,
        'orientation applies to bar charts only; a line chart must not set it.',
        'Remove orientation, or change type to bar.',
      ),
    );
  }

  // Without its columns nothing else can be checked.
  const names = table.columns.map((column) => column.name);
  const where = input.dataName === undefined ? 'the data file' : input.dataName;
  let missing = false;
  const find = (field: ChartField, name: string): number => {
    const index = names.indexOf(name);
    if (index < 0) {
      missing = true;
      problems.push(
        problem(
          'column_missing',
          field,
          null,
          `${field} names a column that is not in ${where}: ${listForMessage(names, quoteName)}.`,
          'Use a column name exactly as the header writes it; names are case-sensitive.',
        ),
      );
    }
    return index;
  };
  const xIndex = find('x', input.x);
  const yIndex = find('y', input.y);
  const seriesIndex = input.series === undefined ? -1 : find('series', input.series);
  if (missing) {
    return {problems, model: null};
  }
  if (table.rows.length === 0) {
    problems.push(
      problem(
        'header_only',
        null,
        table.headerLine,
        `${input.dataName === undefined ? 'The data file' : input.dataName} has a header but no rows, so there is nothing to chart.`,
        'Add at least one row of data below the header.',
      ),
    );
    return {problems, model: null};
  }

  const cell = (row: readonly string[], index: number) => row[index] ?? '';
  const lineOf = (index: number) => table.positions[index] ?? table.headerLine;
  const xColumn = quoteName(input.x);
  const yColumn = quoteName(input.y);
  const seriesColumn = quoteName(input.series ?? '');

  // A column that cannot serve at all is one problem about the field, not one per row;
  // the other fields are still checked row by row.
  const yFilled = table.rows.some((row) => !blank(cell(row, yIndex)));
  const yUnusable = yFilled && !table.rows.some((row) => parseNumberCell(cell(row, yIndex)) !== null);
  if (yUnusable) {
    problems.push(problem('y_invalid', 'y', null, `y must name a column of numbers, but ${yColumn} holds no numbers.`, 'Choose a column of numbers for y.'));
  }
  let xKind: XKind = 'category';
  let xUnusable = false;
  if (input.type === 'line') {
    const type = table.columns[xIndex]?.type;
    if (type === 'number' || type === 'date') {
      xKind = type;
    } else {
      let numbers = 0;
      let dates = 0;
      for (const row of table.rows) {
        const text = cell(row, xIndex);
        if (parseNumberCell(text) !== null) {
          numbers += 1;
        } else if (parseDateCell(text) !== null) {
          dates += 1;
        }
      }
      if (numbers === 0 && dates === 0 && table.rows.some((row) => !blank(cell(row, xIndex)))) {
        xUnusable = true;
        problems.push(
          problem(
            'x_invalid',
            'x',
            null,
            `A line chart's x must hold numbers or dates, but ${xColumn} holds text.`,
            'Choose a column of numbers or YYYY-MM-DD dates for x, or use a bar chart for categories.',
          ),
        );
      }
      // Mixed: the kind most cells share decides, and every other cell is reported.
      xKind = dates > numbers ? 'date' : 'number';
    }
  }

  const data: Datum[] = [];
  const firstLine = new Map<string, number>();
  table.rows.forEach((row, index) => {
    const line = lineOf(index);
    const xText = cell(row, xIndex);
    const yText = cell(row, yIndex);
    const seriesText = seriesIndex < 0 ? '' : cell(row, seriesIndex);

    let xValue: number | null = null;
    let xUsable = !xUnusable;
    if (xUsable && blank(xText)) {
      problems.push(problem('x_empty', 'x', line, `The x value in column ${xColumn} ${blankness(xText)} on this row.`, 'Fill in the cell, or remove the row. Charts never treat a blank as zero.'));
      xUsable = false;
    } else if (xUsable && xKind !== 'category') {
      xValue = xKind === 'number' ? parseNumberCell(xText) : parseDateCell(xText);
      if (xValue === null) {
        problems.push(
          problem(
            'x_invalid',
            'x',
            line,
            `The x value ${quoted(xText)} in column ${xColumn} is not ${xKind === 'number' ? 'a number' : 'a YYYY-MM-DD date'} like the other x values.`,
            'Write every x value of a line chart as a number, or every one as a date in the form YYYY-MM-DD.',
          ),
        );
        xUsable = false;
      }
    }

    let y: number | null = null;
    if (!yUnusable) {
      if (blank(yText)) {
        problems.push(problem('y_empty', 'y', line, `The y value in column ${yColumn} ${blankness(yText)} on this row.`, 'Fill in the cell, or remove the row. Charts never treat a blank as zero.'));
      } else {
        y = parseNumberCell(yText);
        if (y === null) {
          problems.push(
            problem(
              'y_invalid',
              'y',
              line,
              `The y value ${quoted(yText)} in column ${yColumn} is not a number.`,
              'Write the value as a number with a decimal point, such as 41 or 12.5, without thousands separators or units.',
            ),
          );
        }
      }
    }

    const seriesUsable = seriesIndex < 0 || !blank(seriesText);
    if (!seriesUsable) {
      problems.push(problem('series_empty', 'series', line, `The series value in column ${seriesColumn} ${blankness(seriesText)} on this row.`, 'Fill in the series name, or remove the row.'));
    }

    // A repeated (x, series) pair is a problem whatever its y holds.
    let repeated = false;
    if (xUsable && seriesUsable) {
      const key = JSON.stringify([seriesText, xKind === 'category' ? xText : xValue]);
      const earlier = firstLine.get(key);
      if (earlier !== undefined) {
        repeated = true;
        const which = seriesIndex < 0 ? '' : ` in series ${quoted(seriesText)}`;
        problems.push(
          problem(
            'duplicate_point',
            seriesIndex < 0 ? 'x' : 'series',
            line,
            `This row repeats x ${quoted(xText)}${which} from line ${earlier}; each x appears once per series.`,
            'Combine the rows into one value, such as their total, before charting.',
          ),
        );
      } else {
        firstLine.set(key, line);
      }
    }
    if (xUsable && seriesUsable && !repeated && y !== null) {
      data.push({line, xText, xValue, yText, y, series: seriesText});
    }
  });

  // Names that differ only in spacing, in characters SVG cannot show, or in characters drawn as nothing would be
  // drawn alike. Those are taken out before the spaces they may separate are collapsed.
  const ambiguous = (field: 'x' | 'series', index: number) => {
    const seen = new Map<string, {raw: string; line: number}>();
    const reported = new Set<string>();
    table.rows.forEach((row, rowIndex) => {
      const raw = cell(row, index);
      if (blank(raw)) {
        return;
      }
      const shown = clean(raw.replace(DRAWN_AS_NOTHING, ''));
      const first = seen.get(shown);
      if (first === undefined) {
        seen.set(shown, {raw, line: lineOf(rowIndex)});
      } else if (first.raw !== raw && !reported.has(raw)) {
        reported.add(raw);
        problems.push(
          problem(
            'ambiguous_name',
            field,
            lineOf(rowIndex),
            `The ${field} values ${quoted(first.raw)} (line ${first.line}) and ${quoted(raw)} differ only in spacing or hidden characters, so the chart would show them with the same name.`,
            'Write the name the same way on every row, or make the names clearly different.',
          ),
        );
      }
    });
  };
  if (xKind === 'category') {
    ambiguous('x', xIndex);
  }
  if (seriesIndex >= 0) {
    ambiguous('series', seriesIndex);
  }

  // Finite values can still span more than a double holds (1e308 beside -1e308).
  const overflowing = (value: (datum: Datum) => number, withZero: boolean): Datum | null => {
    let low = withZero ? 0 : Number.POSITIVE_INFINITY;
    let high = withZero ? 0 : Number.NEGATIVE_INFINITY;
    let largest: Datum | null = null;
    for (const datum of data) {
      const current = value(datum);
      low = Math.min(low, current);
      high = Math.max(high, current);
      if (largest === null || Math.abs(current) > Math.abs(value(largest))) {
        largest = datum;
      }
    }
    return largest !== null && !Number.isFinite(high - low) ? largest : null;
  };
  const yExtreme = overflowing((datum) => datum.y, true);
  if (yExtreme !== null) {
    problems.push(
      problem(
        'y_invalid',
        'y',
        yExtreme.line,
        `The y value ${quoted(yExtreme.yText)} in column ${yColumn} is too large to draw beside the other values.`,
        'Rescale the data, for example into thousands or millions, before charting.',
      ),
    );
  }
  const xExtreme = xKind === 'number' ? overflowing((datum) => datum.xValue ?? 0, false) : null;
  if (xExtreme !== null) {
    problems.push(
      problem(
        'x_invalid',
        'x',
        xExtreme.line,
        `The x value ${quoted(xExtreme.xText)} in column ${xColumn} is too large to draw beside the other values.`,
        'Rescale the data before charting.',
      ),
    );
  }

  // Counted over every row, so it is reported together with any row problems.
  const seriesCount = seriesIndex < 0 ? 1 : new Set(table.rows.map((row) => cell(row, seriesIndex)).filter((text) => !blank(text))).size;
  if (seriesCount > MAX_CHART_SERIES) {
    problems.push(
      problem(
        'too_many_series',
        'series',
        null,
        `The series column ${seriesColumn} has ${seriesCount} different values; a chart shows at most ${MAX_CHART_SERIES} series.`,
        'Split the data into several charts, or combine the smaller series before charting.',
      ),
    );
  }
  if (problems.length > 0) {
    return {problems, model: null};
  }
  const categories = [...new Set(data.map((datum) => datum.xText))];
  const series = [...new Set(data.map((datum) => datum.series))];
  return {problems: [], model: {data, categories, series, xKind}};
}

// ---------------------------------------------------------------- drawing

type Drawing = {width: number; height: number; parts: string[]; classes: string};

/** `width` is what the legend needs: more than the drawing when a name shown in full is wider than a row. */
type Legend = {parts: string[]; height: number; width: number};

function legend(series: readonly string[], kind: 'bar' | 'line', width: number, top: number): Legend {
  const swatch = kind === 'bar' ? 12 : 24;
  const parts: string[] = [];
  const names = displayNames(series, width - 2 * PAD - swatch - 6);
  let x = PAD;
  let row = 0;
  let right = 0;
  names.forEach((label, index) => {
    const entry = swatch + 6 + textWidth(label);
    if (x > PAD && x + entry > width - PAD) {
      row += 1;
      x = PAD;
    }
    right = Math.max(right, x + entry);
    const middle = top + row * 18 + 6;
    const colour = CHART_SERIES_COLOURS[index] ?? INK;
    parts.push(
      kind === 'bar'
        ? element('rect', [['x', x], ['y', middle - 6], ['width', 12], ['height', 12], ['fill', colour]])
        : element('line', [
            ['x1', x + 1],
            ['y1', middle],
            ['x2', x + swatch - 1],
            ['y2', middle],
            ['stroke', colour],
            ['stroke-width', 2],
            ['stroke-linecap', 'round'],
            ['stroke-dasharray', DASHES[index]],
          ]),
    );
    parts.push(element('text', [['x', x + swatch + 6], ['y', middle], ['dy', '0.35em']], isolatedText(label)));
    x += entry + 16;
  });
  return {parts, height: (row + 1) * 18, width: Math.ceil(right + PAD)};
}

function valueDomain(values: readonly number[]): [number, number] {
  let low = 0;
  let high = 0;
  for (const value of values) {
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  return low === 0 && high === 0 ? [-1, 1] : [low, high];
}

type BarLabel = {datum: Datum; seriesIndex: number; value: string; name: string | null};

function barLabels(model: Model, formats: Formats): BarLabel[] {
  const named = new Set<string>();
  const labels: BarLabel[] = [];
  const grouped = model.series.length > 1;
  const names = displayNames(model.series, NAME_MAX_WIDTH);
  const byKey = new Map(model.data.map((datum) => [JSON.stringify([datum.xText, datum.series]), datum]));
  // Walk in drawing order so each series is named on its first bar.
  for (const category of model.categories) {
    model.series.forEach((series, seriesIndex) => {
      const datum = byKey.get(JSON.stringify([category, series]));
      if (datum === undefined) {
        return;
      }
      const first = grouped && !named.has(series);
      if (first) {
        named.add(series);
      }
      labels.push({
        datum,
        seriesIndex,
        value: valueLabel(formats, datum.yText, datum.y),
        name: first ? (names[seriesIndex] ?? '') : null,
      });
    });
  }
  return labels;
}

/** Vertical bar bands: the gap between two categories and the room at each plot end, as fractions of a step. */
const BAND_GAP = 0.3;
const BAND_END = 0.15;

function drawVerticalBars(model: Model, formats: Formats, requestedWidth: number, minimumHeight: number): Drawing {
  const k = model.series.length;
  let width = requestedWidth;
  const bands = (start: number) =>
    scaleBand<string>().domain(model.categories).range([start, width - PAD]).paddingInner(BAND_GAP).paddingOuter(BAND_END);
  const categoryText = model.categories.map((category) => clean(category));
  const rotateCategories = maxOf(categoryText.map(textWidth)) > bands(PAD).step() - 6;
  const categoryLabels = rotateCategories ? displayNames(model.categories, 200) : categoryText;
  const widestCategory = maxOf(categoryLabels.map(textWidth));
  // A label turned 45° reaches left of its bar by about 0.71 of its length, so the first ones need room.
  // Names shown in full to stay distinct can be long; they widen the drawing rather than run off its edge.
  const inset = rotateCategories ? widestCategory * Math.SQRT1_2 : 0;
  width = Math.max(width, Math.ceil(PAD + inset + MIN_PLOT_WIDTH + PAD));
  const key = k > 1 ? legend(model.series, 'bar', width, PAD) : null;
  width = Math.max(width, key?.width ?? 0);
  const contentTop = PAD + (key === null ? 0 : key.height + 8);
  const labels = barLabels(model, formats);
  const widest = maxOf(labels.map((label) => textWidth(label.value)));
  // A category's bars share its band, in series order with a 2 px gap. Values that must stand upright
  // need a line each (a series name stands on its first bar's line), so the band must then hold k bars a
  // line apart, or a step of a line for one series. A narrower band widens the drawing, as long labels
  // do, rather than let bars of neighbouring categories cross and values print over one another. With
  // every group inside its band, the 8 px pad is the half line the first and last upright values need.
  const layout = () => {
    const band = bands(PAD + inset);
    const thickness = Math.max(1, Math.min(BAR, (band.bandwidth() - GAP * (k - 1)) / k));
    return {band, thickness, rotateValues: widest > (k > 1 ? thickness + GAP : band.step()) - 4};
  };
  let {band, thickness, rotateValues} = layout();
  if (rotateValues) {
    const step = k > 1 ? (k * (LINE_HEIGHT - GAP) + GAP * (k - 1)) / (1 - BAND_GAP) : LINE_HEIGHT;
    const needed = Math.ceil(PAD + inset + step * (model.categories.length - BAND_GAP + 2 * BAND_END) + PAD);
    if (needed > width) {
      width = needed;
      ({band, thickness, rotateValues} = layout());
    }
  }
  const bandwidth = band.bandwidth();
  const groupWidth = thickness * k + GAP * (k - 1);
  const pitch = thickness + GAP;
  const valueExtent = rotateValues ? widest + 4 : LINE_HEIGHT;
  const nameExtent = maxOf(labels.filter((label) => label.name !== null).map((label) => textWidth(label.name ?? '') + 6));
  const up = labels.filter((label) => label.datum.y >= 0);
  const down = labels.filter((label) => label.datum.y < 0);
  const topReserve = (up.length > 0 ? valueExtent : 0) + (up.some((label) => label.name !== null) ? nameExtent : 0);
  const bottomReserve = (down.length > 0 ? valueExtent : 0) + (down.some((label) => label.name !== null) ? nameExtent : 0);

  const categoryExtent = rotateCategories ? widestCategory * Math.SQRT1_2 + FONT_SIZE : LINE_HEIGHT;

  const plotTop = contentTop + topReserve;
  const height = Math.ceil(Math.max(minimumHeight, plotTop + 120 + bottomReserve + 6 + categoryExtent + PAD));
  const plotBottom = height - PAD - categoryExtent - 6 - bottomReserve;
  const y = scaleLinear().domain(valueDomain(model.data.map((datum) => datum.y))).range([plotBottom, plotTop]);
  const zero = y(0);

  const marks: string[] = [];
  const text: string[] = [];
  for (const label of labels) {
    const {datum, seriesIndex} = label;
    const centre = (band(datum.xText) ?? 0) + (bandwidth - groupWidth) / 2 + seriesIndex * pitch + thickness / 2;
    const end = y(datum.y);
    const barTop = Math.min(zero, end);
    const barBottom = Math.max(zero, end);
    marks.push(
      element('rect', [
        ['x', centre - thickness / 2],
        ['y', barTop],
        ['width', thickness],
        ['height', barBottom - barTop],
        ['fill', CHART_SERIES_COLOURS[seriesIndex] ?? INK],
      ]),
    );
    const upward = datum.y >= 0;
    const valueAttributes: Array<readonly [string, AttributeValue]> = rotateValues
      ? [
          ['transform', `translate(${num(centre)},${num(upward ? barTop - 4 : barBottom + 4)}) rotate(-90)`],
          ['dy', '0.35em'],
          ['text-anchor', upward ? 'start' : 'end'],
        ]
      : [
          ['x', centre],
          ['y', upward ? barTop - 4 : barBottom + 4],
          ['dy', upward ? undefined : '0.71em'],
          ['text-anchor', 'middle'],
        ];
    text.push(element('text', valueAttributes, userText(label.value)));
    if (label.name !== null) {
      const at = upward ? barTop - 4 - valueExtent : barBottom + 4 + valueExtent;
      text.push(
        element(
          'text',
          [
            ['transform', `translate(${num(centre)},${num(at)}) rotate(-90)`],
            ['dy', '0.35em'],
            ['text-anchor', upward ? 'start' : 'end'],
            ['fill', MUTED],
          ],
          isolatedText(label.name),
        ),
      );
    }
  }

  const axis = [
    element('line', [['x1', PAD + inset], ['y1', crisp(zero)], ['x2', width - PAD], ['y2', crisp(zero)], ['stroke', RULE], ['stroke-width', 1]]),
  ];
  const labelTop = plotBottom + bottomReserve + 6;
  model.categories.forEach((category, index) => {
    const centre = (band(category) ?? 0) + bandwidth / 2;
    const content = isolatedText(categoryLabels[index] ?? '');
    text.push(
      rotateCategories
        ? element('text', [['transform', `translate(${num(centre)},${num(labelTop)}) rotate(-45)`], ['dy', '0.35em'], ['text-anchor', 'end']], content)
        : element('text', [['x', centre], ['y', labelTop], ['dy', '0.71em'], ['text-anchor', 'middle']], content),
    );
  });

  return {
    width,
    height,
    classes: 'chart chart-bar chart-vertical',
    parts: [group('chart-legend', key?.parts ?? []), group('chart-axes', axis), group('chart-marks', marks), group('chart-labels', text)],
  };
}

function drawHorizontalBars(model: Model, formats: Formats, requestedWidth: number): Drawing {
  const k = model.series.length;
  let width = requestedWidth;
  const key = k > 1 ? legend(model.series, 'bar', width, PAD) : null;
  width = Math.max(width, key?.width ?? 0);
  const categoryLabels = displayNames(model.categories, width * 0.3);
  const labelColumn = maxOf(categoryLabels.map(textWidth));
  const left = PAD + labelColumn + 8;
  const thickness = k > 1 ? GROUPED_BAR : BAR;
  const groupHeight = thickness * k + GAP * (k - 1);
  const categoryGap = k > 1 ? 14 : 10;

  const labels = barLabels(model, formats);
  const extent = (label: BarLabel) => textWidth(label.value) + (label.name === null ? 0 : 6 + textWidth(label.name)) + 6;
  const rightExtent = maxOf(labels.filter((label) => label.datum.y >= 0).map(extent));
  const leftExtent = maxOf(labels.filter((label) => label.datum.y < 0).map(extent));
  width = Math.max(width, Math.ceil(left + leftExtent + MIN_PLOT_WIDTH + rightExtent + PAD));
  const x = scaleLinear()
    .domain(valueDomain(model.data.map((datum) => datum.y)))
    .range([left + leftExtent, width - PAD - rightExtent]);
  const zero = x(0);

  const plotTop = PAD + (key === null ? 0 : key.height + 8);
  const height = Math.ceil(plotTop + model.categories.length * (groupHeight + categoryGap) + PAD);
  const categoryIndex = new Map(model.categories.map((category, index) => [category, index]));

  const marks: string[] = [];
  const text: string[] = [];
  categoryLabels.forEach((label, index) => {
    const groupTop = plotTop + index * (groupHeight + categoryGap) + categoryGap / 2;
    text.push(element('text', [['x', left - 8], ['y', groupTop + groupHeight / 2], ['dy', '0.35em'], ['text-anchor', 'end']], isolatedText(label)));
  });
  for (const label of labels) {
    const {datum, seriesIndex} = label;
    const row = categoryIndex.get(datum.xText) ?? 0;
    const barTop = plotTop + row * (groupHeight + categoryGap) + categoryGap / 2 + seriesIndex * (thickness + GAP);
    const end = x(datum.y);
    const start = Math.min(zero, end);
    const finish = Math.max(zero, end);
    marks.push(
      element('rect', [
        ['x', start],
        ['y', barTop],
        ['width', finish - start],
        ['height', thickness],
        ['fill', CHART_SERIES_COLOURS[seriesIndex] ?? INK],
      ]),
    );
    const rightward = datum.y >= 0;
    // The value sits against the bar end; the series name, on a series' first bar, sits beyond it.
    const value = userText(label.value);
    const content =
      label.name === null
        ? value
        : rightward
          ? `${value}${element('tspan', [['dx', 6], ['fill', MUTED]], isolatedText(label.name))}`
          : `${element('tspan', [['fill', MUTED]], isolatedText(label.name))}${element('tspan', [['dx', 6]], value)}`;
    text.push(
      element(
        'text',
        [
          ['x', rightward ? finish + 4 : start - 4],
          ['y', barTop + thickness / 2],
          ['dy', '0.35em'],
          ['text-anchor', rightward ? 'start' : 'end'],
        ],
        content,
      ),
    );
  }
  const axis = [
    element('line', [['x1', crisp(zero)], ['y1', plotTop], ['x2', crisp(zero)], ['y2', height - PAD], ['stroke', RULE], ['stroke-width', 1]]),
  ];
  return {
    width,
    height,
    classes: 'chart chart-bar chart-horizontal',
    parts: [group('chart-legend', key?.parts ?? []), group('chart-axes', axis), group('chart-marks', marks), group('chart-labels', text)],
  };
}

/** Moves labels apart to at least `gap`, keeping their order, inside [low, high] where possible. */
function spread(targets: readonly number[], gap: number, low: number, high: number): number[] {
  const order = targets.map((value, index) => ({value, index})).sort((a, b) => a.value - b.value || a.index - b.index);
  const placed = order.map((item) => item.value);
  for (let index = 0; index < placed.length; index += 1) {
    const previous = index === 0 ? low : (placed[index - 1] ?? low) + gap;
    placed[index] = Math.max(placed[index] ?? 0, previous);
  }
  for (let index = placed.length - 1; index >= 0; index -= 1) {
    const next = index === placed.length - 1 ? high : (placed[index + 1] ?? high) - gap;
    placed[index] = Math.min(placed[index] ?? 0, next);
  }
  const result = new Array<number>(targets.length);
  order.forEach((item, position) => {
    result[item.index] = placed[position] ?? item.value;
  });
  return result;
}

type Tick = {position: number; label: string; value?: number};

/** Where a tick label's centre lands once it is kept inside the drawing. */
function labelCentre(tick: Tick, width: number): number {
  const half = textWidth(tick.label) / 2;
  return Math.min(Math.max(tick.position, PAD + half), width - PAD - half);
}

/** True when no two neighbouring labels overlap (with an 8 px gap) after clamping. */
function fits(ticks: readonly Tick[], width: number): boolean {
  return ticks.every((tick, index) => {
    const next = ticks[index + 1];
    return (
      next === undefined ||
      labelCentre(next, width) - labelCentre(tick, width) >= (textWidth(tick.label) + textWidth(next.label)) / 2 + 8
    );
  });
}

/**
 * Keeps every n-th tick, for the smallest n whose labels fit. Labels are made
 * for the ticks that stay, because a date label depends on its neighbour: the
 * year shows where it changes from the previous kept tick.
 */
function thin(values: readonly number[], position: (value: number) => number, label: (kept: readonly number[]) => string[], width: number): Tick[] {
  const ticksFor = (kept: readonly number[]) => {
    const labels = label(kept);
    return kept.map((value, index) => ({position: position(value), label: labels[index] ?? '', value}));
  };
  for (let every = 1; every <= values.length; every += 1) {
    const ticks = ticksFor(values.filter((_, index) => index % every === 0));
    if (fits(ticks, width)) {
      return ticks;
    }
  }
  return ticksFor(values.slice(0, 1));
}

function drawLines(model: Model, formats: Formats, requestedWidth: number, height: number): Drawing {
  const k = model.series.length;
  let width = requestedWidth;
  const key = k > 1 ? legend(model.series, 'line', width, PAD) : null;
  width = Math.max(width, key?.width ?? 0);
  const bySeries = model.series.map((series) =>
    model.data.filter((datum) => datum.series === series).sort((a, b) => (a.xValue ?? 0) - (b.xValue ?? 0)),
  );
  const distinct = [...new Set(model.data.map((datum) => datum.xValue ?? 0))].sort((a, b) => a - b);
  const single = distinct.length === 1;

  const plotTop = PAD + (key === null ? 0 : key.height + 8) + FONT_SIZE / 2;
  const plotBottom = height - PAD - LINE_HEIGHT - 6;
  const tickCount = Math.max(2, Math.round((plotBottom - plotTop) / 56));
  const y = scaleLinear().domain(valueDomain(model.data.map((datum) => datum.y))).nice(tickCount).range([plotBottom, plotTop]);
  const yTicks = y.ticks(tickCount);
  const yLabels = tickLabels(formats, yTicks, true);
  const left = PAD + maxOf(yLabels.map(textWidth)) + 8;

  const names = displayNames(model.series, NAME_MAX_WIDTH);
  const ends = bySeries.map((points, index) => {
    const last = points[points.length - 1];
    const value = last === undefined ? '' : valueLabel(formats, last.yText, last.y);
    const name = k > 1 ? (names[index] ?? '') : null;
    return {last, value, name, width: textWidth(value) + (name === null ? 0 : 6 + textWidth(name))};
  });
  const labelSpace = maxOf(ends.map((end) => end.width)) + 14;
  // A single point sits mid-plot with its label to the right, so it needs the label space on both halves.
  width = Math.max(width, Math.ceil(left + PAD + (single ? Math.max(MIN_PLOT_WIDTH, 2 * labelSpace) : MIN_PLOT_WIDTH + labelSpace)));
  const plotLeft = left;
  const plotRight = width - PAD - (single ? 0 : labelSpace);

  let xPosition: (value: number) => number;
  let ticks: Tick[];
  // The label of an x value keeps the precision of the first cell that wrote it.
  const firstTexts = new Map<number, string>();
  for (const datum of model.data) {
    if (datum.xValue !== null && !firstTexts.has(datum.xValue)) {
      firstTexts.set(datum.xValue, datum.xText);
    }
  }
  const firstText = (value: number) => firstTexts.get(value) ?? '';
  const dataLabels =
    model.xKind === 'date' ? dateLabels(formats, distinct) : distinct.map((value) => valueLabel(formats, firstText(value), value, false));
  if (single) {
    const centre = (plotLeft + width - PAD) / 2;
    xPosition = () => centre;
    ticks = [{position: centre, label: dataLabels[0] ?? ''}];
  } else {
    const low = distinct[0] ?? 0;
    const high = distinct[distinct.length - 1] ?? 1;
    if (model.xKind === 'date') {
      const scale = scaleUtc().domain([new Date(low), new Date(high)]).range([plotLeft, plotRight]);
      xPosition = (value) => scale(new Date(value));
    } else {
      const scale = scaleLinear().domain([low, high]).range([plotLeft, plotRight]);
      xPosition = (value) => scale(value);
    }
    const aligned = distinct.map((value, index) => ({position: xPosition(value), label: dataLabels[index] ?? ''}));
    if (distinct.length <= 12 && fits(aligned, width)) {
      ticks = aligned;
    } else {
      const count = Math.max(2, Math.floor((plotRight - plotLeft) / 90));
      if (model.xKind === 'date') {
        const scale = scaleUtc().domain([new Date(low), new Date(high)]).range([plotLeft, plotRight]);
        const times = scale.ticks(count).map((date) => date.getTime());
        ticks = thin(times, xPosition, (kept) => dateLabels(formats, kept), width);
      } else {
        const values = scaleLinear().domain([low, high]).ticks(count);
        // Precision follows the full tick step, so a kept label reads the same either way.
        const labels = new Map(values.map((value, index) => [value, tickLabels(formats, values, false)[index] ?? '']));
        ticks = thin(values, xPosition, (kept) => kept.map((value) => labels.get(value) ?? ''), width);
      }
    }
  }

  const axes: string[] = [];
  const text: string[] = [];
  const gridRight = single ? width - PAD : plotRight;
  yTicks.forEach((tick, index) => {
    const position = crisp(y(tick));
    axes.push(
      element('line', [['x1', plotLeft], ['y1', position], ['x2', gridRight], ['y2', position], ['stroke', tick === 0 ? RULE : GRID], ['stroke-width', 1]]),
    );
    text.push(element('text', [['x', left - 8], ['y', y(tick)], ['dy', '0.35em'], ['text-anchor', 'end'], ['fill', MUTED]], userText(yLabels[index] ?? '')));
  });
  for (const tick of ticks) {
    const centre = labelCentre(tick, width);
    text.push(element('text', [['x', centre], ['y', plotBottom + 6], ['dy', '0.71em'], ['text-anchor', 'middle'], ['fill', MUTED]], userText(tick.label)));
  }

  const marks: string[] = [];
  const path = linePath<Datum>()
    .x((datum) => xPosition(datum.xValue ?? 0))
    .y((datum) => y(datum.y))
    .digits(2);
  bySeries.forEach((points, index) => {
    if (points.length > 1) {
      marks.push(
        element('path', [
          ['d', path(points) ?? ''],
          ['fill', 'none'],
          ['stroke', CHART_SERIES_COLOURS[index] ?? INK],
          ['stroke-width', 2],
          ['stroke-linejoin', 'round'],
          ['stroke-linecap', 'round'],
          ['stroke-dasharray', DASHES[index]],
        ]),
      );
    }
  });
  const markAll = model.data.length <= 60;
  bySeries.forEach((points, index) => {
    for (const datum of points) {
      if (markAll || points.length === 1) {
        marks.push(
          element('circle', [
            ['cx', xPosition(datum.xValue ?? 0)],
            ['cy', y(datum.y)],
            ['r', 4],
            ['fill', CHART_SERIES_COLOURS[index] ?? INK],
            ['stroke', SURFACE],
            ['stroke-width', 2],
          ]),
        );
      }
    }
  });

  // Direct labels: the series name and its last value, beside the line end.
  const anchors = ends.map((end) => ({x: end.last === undefined ? plotRight : xPosition(end.last.xValue ?? 0), y: end.last === undefined ? plotBottom : y(end.last.y)}));
  const placed = spread(anchors.map((anchor) => anchor.y), LINE_HEIGHT, plotTop, plotBottom);
  const leaders: string[] = [];
  ends.forEach((end, index) => {
    const anchor = anchors[index];
    const labelY = placed[index];
    if (anchor === undefined || labelY === undefined || end.last === undefined) {
      return;
    }
    const labelX = single ? anchor.x + 10 : plotRight + 10;
    if (Math.abs(labelY - anchor.y) > 2 || labelX - anchor.x > 12) {
      leaders.push(element('line', [['x1', anchor.x + 6], ['y1', anchor.y], ['x2', labelX - 3], ['y2', labelY], ['stroke', RULE], ['stroke-width', 1]]));
    }
    const value = userText(end.value);
    const content = end.name === null ? value : `${isolatedText(end.name)}<tspan dx="6" fill="${MUTED}">${value}</tspan>`;
    text.push(element('text', [['x', labelX], ['y', labelY], ['dy', '0.35em']], content));
  });

  return {
    width,
    height,
    classes: 'chart chart-line',
    parts: [group('chart-legend', key?.parts ?? []), group('chart-axes', axes), group('chart-marks', [...leaders, ...marks]), group('chart-labels', text)],
  };
}

// ---------------------------------------------------------------- entry point

function checkContract(input: ChartInput): void {
  if (typeof input.id !== 'string' || !ID_PATTERN.test(input.id)) {
    throw new TypeError(`a chart id starts with a letter and holds only letters, digits, "-" and "_", got ${JSON.stringify(input.id)}`);
  }
  if (input.type !== 'bar' && input.type !== 'line') {
    throw new TypeError(`a chart type is bar or line, got ${JSON.stringify(input.type)}`);
  }
  if (input.orientation !== undefined && input.orientation !== 'vertical' && input.orientation !== 'horizontal') {
    throw new TypeError(`a chart orientation is vertical or horizontal, got ${JSON.stringify(input.orientation)}`);
  }
  if (input.locale !== 'en' && input.locale !== 'es') {
    throw new TypeError(`a chart locale is en or es, got ${JSON.stringify(input.locale)}`);
  }
  if (typeof input.summary !== 'string' || typeof input.x !== 'string' || typeof input.y !== 'string') {
    throw new TypeError('a chart needs string x, y and summary values');
  }
  const inRange = (value: number | undefined, low: number) =>
    value === undefined || (Number.isFinite(value) && value >= low && value <= 2400);
  if (!inRange(input.width, 240) || !inRange(input.height, 160)) {
    throw new TypeError(`a chart size is 240–2400 px wide and 160–2400 px tall, got ${String(input.width)}×${String(input.height)}`);
  }
}

/** Draws one chart, or reports why it cannot be drawn honestly. */
export function renderChart(input: ChartInput): ChartResult {
  checkContract(input);
  const width = Math.round(input.width ?? DEFAULT_WIDTH);
  const minimumHeight = Math.round(input.height ?? DEFAULT_HEIGHT);
  const summaryBlank = input.summary.trim() === '';
  const {problems, model} = analyse(input);
  if (model === null || problems.length > 0) {
    return {svg: null, width, height: minimumHeight, problems: capProblems(problems), summaryBlank};
  }
  const formats = formatsFor(input.locale);
  const drawing =
    input.type === 'line'
      ? drawLines(model, formats, width, minimumHeight)
      : input.orientation === 'horizontal'
        ? drawHorizontalBars(model, formats, width)
        : drawVerticalBars(model, formats, width, minimumHeight);

  const titleGiven = input.title !== undefined && input.title.trim() !== '';
  const titleId = `${input.id}-title`;
  const descId = `${input.id}-desc`;
  const describe = titleGiven && !summaryBlank;
  const head = [
    element('title', [['id', titleId]], userText(titleGiven ? (input.title ?? '') : input.summary)),
    ...(describe ? [element('desc', [['id', descId]], userText(input.summary))] : []),
  ];
  const body = drawing.parts.filter((part) => part !== '');
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" class="${drawing.classes}" viewBox="0 0 ${drawing.width} ${drawing.height}" width="${drawing.width}" height="${drawing.height}" role="img" aria-labelledby="${titleId}"${describe ? ` aria-describedby="${descId}"` : ''}>`,
    ...head,
    `<g font-family="${escapeAttribute(FONT_FAMILY)}" font-size="${num(FONT_SIZE)}" font-variant="tabular-nums" fill="${INK}">`,
    ...body,
    '</g>',
    '</svg>',
  ].join('\n');
  return {svg: `${svg}\n`, width: drawing.width, height: drawing.height, problems: [], summaryBlank};
}
