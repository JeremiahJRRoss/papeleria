/**
 * M1.11 / IC03: CSV tables with honest record positions.
 *
 * d3-dsv's `csvParseRows` supplies every cell value (D12); the eval-based
 * object parser is never used. An owned scanner walks the same text with the
 * same quote and line-break rules to find where each record starts, so a
 * problem in a quoted multi-line record points at the line where that record
 * begins (IC01). The scanner is a line-for-line port of d3-dsv 3.0.1's
 * `parseRows` token loop with position bookkeeping added, and the two are
 * checked against each other on every parse: a disagreement is a Papeleria
 * bug and throws rather than mislabelling a line.
 *
 * Adapted from d3-dsv 3.0.1 (ISC licence, Copyright 2013-2021 Mike Bostock),
 * as THIRD_PARTY.md §2 records (D182).
 *
 * The scanner also reports the two malformed-quote cases `csvParseRows`
 * recovers from silently, because its recovery changes cell values without
 * saying so: a quoted cell that is never closed (the rest of the file, commas
 * and line breaks included, becomes that one cell), and text after a closing
 * quote (its first character is consumed as if it were a comma, so it
 * vanishes and the cell splits: `"closed"late` reads as `closed` and `ate`).
 *
 * Header names are exact and case-sensitive, must contain a non-whitespace
 * character and must be unique. Every data row has the header's cell count.
 * Fully empty trailing lines are ignored; any other blank record stays a row.
 * Cells keep their source text. Types are inferred per column ignoring empty
 * cells: `number` when every other cell is a finite decimal or scientific
 * number, `date` when every other cell is a valid YYYY-MM-DD calendar date
 * (UTC midnight), otherwise `text`; an all-empty column is `text`.
 *
 * Positions are 1-based lines of the text after a leading byte order mark is
 * removed; columns count UTF-16 code units from 1, as editors do. A line break
 * is LF, CRLF or a lone CR, exactly as d3-dsv splits records.
 *
 * The text comes from `FileAccess.readText`, which holds the IC01 byte limit;
 * this module owns the row limit (D159). The limits also bound the work: the
 * scanner counts records into typed arrays instead of building them, an empty
 * file and one over the row limit are refused before d3-dsv builds any row,
 * and problems past the cap are counted, not built.
 */
import {csvParseRows} from 'd3-dsv';

import {quoteValue} from './finding.js';
import {INPUT_LIMITS} from './limits.js';

/** Problems listed per file before the rest are summarized in one `too_many_problems`. */
export const MAX_CSV_PROBLEMS = 50;

export type ColumnType = 'number' | 'date' | 'text';
export type CsvColumn = {name: string; type: ColumnType};
export type CsvTable = {
  columns: CsvColumn[];
  /** One array per data record, each exactly as wide as the header, holding source text. */
  rows: string[][];
  /** The 1-based line where each data record starts, parallel to `rows`. */
  positions: number[];
  /** The 1-based line of the header record. */
  headerLine: number;
  /** True when the file has a header and no data rows: R13 warns for a table and fails a chart. */
  headerOnly: boolean;
};
export type CsvProblemCode =
  | 'empty'
  | 'header_empty'
  | 'header_duplicate'
  | 'row_width'
  | 'unterminated_quote'
  | 'invalid_quote'
  | 'too_many_rows'
  | 'too_many_problems';
export type CsvProblem = {
  code: CsvProblemCode;
  /** IC01 input limits are R09; everything else about a CSV is R13. */
  rule: 'R09' | 'R13';
  message: string;
  fix: string;
  /** The line where the offending record starts, or null for a whole-file problem. */
  line: number | null;
  /** Present only when the offending character is on `line`. */
  column?: number;
};
export type CsvResult = {ok: true; table: CsvTable} | {ok: false; problems: CsvProblem[]};

const QUOTE = 34;
const NEWLINE = 10;
const RETURN = 13;
const COMMA = 44;
const BYTE_ORDER_MARK = 0xfeff;

const numberFormat = new Intl.NumberFormat('en-US');

// The integer and fraction digits are split by the literal point alone, so the
// match is linear: `\d+\.?\d*` let a long run of digits before a stray character
// backtrack over every split (quadratic; 40,000 digits took two seconds).
const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A finite decimal or scientific number written with a decimal point, or null.
 * No whitespace, thousands separators, Infinity, NaN, hex or other coercion.
 */
export function parseNumberCell(text: string): number | null {
  if (!NUMBER_PATTERN.test(text)) {
    return null;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** The UTC-midnight timestamp of a valid YYYY-MM-DD calendar date, or null. */
export function parseDateCell(text: string): number | null {
  const match = DATE_PATTERN.exec(text);
  if (match === null) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) {
    return null;
  }
  const days = month === 2 && isLeapYear(year) ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0);
  if (day < 1 || day > days) {
    return null;
  }
  // Date.UTC maps years 0–99 to 1900–1999; setUTCFullYear does not.
  const date = new Date(Date.UTC(2000, 0, 1));
  date.setUTCFullYear(year, month - 1, day);
  return date.getTime();
}

/** IC03 inference over one column's cells: empty cells are ignored; an all-empty column is text. */
export function inferColumnType(cells: readonly string[]): ColumnType {
  let sawValue = false;
  let allNumbers = true;
  let allDates = true;
  for (const cell of cells) {
    if (cell === '') {
      continue;
    }
    sawValue = true;
    if (allNumbers && parseNumberCell(cell) === null) {
      allNumbers = false;
    }
    if (allDates && parseDateCell(cell) === null) {
      allDates = false;
    }
    if (!allNumbers && !allDates) {
      return 'text';
    }
  }
  if (!sawValue) {
    return 'text';
  }
  return allNumbers ? 'number' : allDates ? 'date' : 'text';
}

type QuoteIssue = {kind: 'unterminated' | 'after_quote'; recordStart: number; offset: number};

/**
 * The records of a file, counted rather than built: one slot per record in
 * typed arrays, so a file of millions of blank or tiny lines costs a few
 * bytes per line instead of an object and an array each (IC01).
 */
type Scan = {
  /** How many records the file holds. */
  count: number;
  /** Offset of each record's first character. */
  starts: Int32Array;
  /** How many cells each record has. */
  cells: Int32Array;
  /** 1 for a line with nothing on it: one unquoted cell of length zero. */
  blank: Uint8Array;
  /** Offset where each cell of the first record, the header, starts (the opening quote for a quoted cell). */
  headerCells: number[];
  /** The first quote issues, one more than the problem cap lists. */
  issues: QuoteIssue[];
  /** Every quote issue found. */
  issueCount: number;
};

/**
 * Walks `text` exactly as d3-dsv 3.0.1 `parseRows` does (the loop conditions
 * are copied from it) and records where every record starts, how many cells
 * it has and whether it is blank. A record begins a line, so `lines` bounds
 * the number of records.
 */
function scanRecords(text: string, lines: number): Scan {
  const starts = new Int32Array(lines);
  const cells = new Int32Array(lines);
  const blank = new Uint8Array(lines);
  const headerCells: number[] = [];
  const issues: QuoteIssue[] = [];
  let issueCount = 0;
  let count = 0;
  let N = text.length;
  let I = 0;
  let eof = N <= 0;
  let eol = false;

  // Strip the trailing newline, as d3-dsv does.
  if (text.charCodeAt(N - 1) === NEWLINE) --N;
  if (text.charCodeAt(N - 1) === RETURN) --N;

  const EOF = -1;
  const EOL = -2;
  let tokenQuoted = false;
  let tokenLength = 0;
  let recordStart = 0;

  // Keeps as many issues as the cap can list, plus the first unlisted one, and counts the rest.
  const issue = (kind: QuoteIssue['kind'], offset: number): void => {
    issueCount += 1;
    if (issues.length <= MAX_CSV_PROBLEMS) {
      issues.push({kind, recordStart, offset});
    }
  };

  // Returns the offset where the next cell starts, or EOL / EOF.
  const token = (): number => {
    if (eof) return EOF;
    if (eol) {
      eol = false;
      return EOL;
    }
    const j = I;
    if (text.charCodeAt(j) === QUOTE) {
      tokenQuoted = true;
      // d3-dsv: while (I++ < N && text.charCodeAt(I) !== QUOTE || text.charCodeAt(++I) === QUOTE);
      while ((I++ < N && text.charCodeAt(I) !== QUOTE) || text.charCodeAt(++I) === QUOTE);
      if (I > N) {
        // The loop ran past the end without a closing quote.
        issue('unterminated', j);
      }
      const i = I;
      if (i >= N) {
        eof = true;
      } else {
        const c = text.charCodeAt(I++);
        if (c === NEWLINE) {
          eol = true;
        } else if (c === RETURN) {
          eol = true;
          if (text.charCodeAt(I) === NEWLINE) ++I;
        } else if (c !== COMMA) {
          // d3-dsv consumes this character as if it were the delimiter.
          issue('after_quote', i);
        }
      }
      return j;
    }
    tokenQuoted = false;
    while (I < N) {
      const i = I;
      const c = text.charCodeAt(I++);
      if (c === NEWLINE) {
        eol = true;
      } else if (c === RETURN) {
        eol = true;
        if (text.charCodeAt(I) === NEWLINE) ++I;
      } else if (c !== COMMA) {
        continue;
      }
      tokenLength = i - j;
      return j;
    }
    eof = true;
    tokenLength = N - j;
    return j;
  };

  for (;;) {
    recordStart = I;
    let t = token();
    if (t === EOF) {
      break;
    }
    if (count === lines) {
      throw new Error('CSV record scanner found more records than lines; this is a Papeleria bug');
    }
    starts[count] = t;
    let cellCount = 0;
    let lastQuoted = false;
    let lastLength = 0;
    while (t !== EOL && t !== EOF) {
      if (count === 0) {
        headerCells.push(t);
      }
      cellCount += 1;
      lastQuoted = tokenQuoted;
      lastLength = tokenLength;
      t = token();
    }
    cells[count] = cellCount;
    blank[count] = cellCount === 1 && !lastQuoted && lastLength === 0 ? 1 : 0;
    count += 1;
  }
  return {count, starts, cells, blank, headerCells, issues, issueCount};
}

/** Offsets where each line starts; LF, CRLF and a lone CR each end a line. Counted first, then filled. */
function lineStarts(text: string): Int32Array {
  const endsLine = (index: number): boolean => {
    const code = text.charCodeAt(index);
    return code === NEWLINE || (code === RETURN && text.charCodeAt(index + 1) !== NEWLINE);
  };
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (endsLine(index)) {
      lines += 1;
    }
  }
  const starts = new Int32Array(lines);
  let line = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (endsLine(index)) {
      line += 1;
      starts[line] = index + 1;
    }
  }
  return starts;
}

function locate(starts: Int32Array, offset: number): {line: number; column: number} {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((starts[middle] ?? 0) <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return {line: low + 1, column: offset - (starts[low] ?? 0) + 1};
}

/** A header name as a problem quotes it: hidden characters shown, a long one cut (D175). */
function quoted(name: string): string {
  return quoteValue(name, 'json');
}

/**
 * Every problem up to the cap, or the first `MAX_CSV_PROBLEMS` and one
 * `too_many_problems` at the first unlisted line. `built` holds at most one
 * problem past the cap and `total` counts them all, so a mangled file never
 * builds millions of problems only to drop them.
 */
function capProblems(built: CsvProblem[], total: number): CsvProblem[] {
  if (total <= MAX_CSV_PROBLEMS) {
    return built;
  }
  const listed = built.slice(0, MAX_CSV_PROBLEMS);
  const rest = total - MAX_CSV_PROBLEMS;
  listed.push({
    code: 'too_many_problems',
    rule: 'R13',
    message: `${numberFormat.format(rest)} more problems in this file are not listed.`,
    fix: 'Fix the problems listed above, then check again.',
    line: built[MAX_CSV_PROBLEMS]?.line ?? null,
  });
  return listed;
}

/** Parses CSV text into a table, or lists every problem found (up to the cap). */
export function parseCsv(text: string): CsvResult {
  if (typeof text !== 'string') {
    throw new TypeError('parseCsv takes the CSV file as a string');
  }
  // The file was read with the IC01 byte bound, which owns that limit (D159);
  // more text than that is a defect in the caller.
  if (Buffer.byteLength(text, 'utf8') > INPUT_LIMITS.textBytes) {
    throw new RangeError(`a CSV file is at most ${INPUT_LIMITS.textBytes} bytes`);
  }

  const body = text.charCodeAt(0) === BYTE_ORDER_MARK ? text.slice(1) : text;
  const starts = lineStarts(body);
  const at = (offset: number) => locate(starts, offset);
  const scan = scanRecords(body, starts.length);

  if (scan.issueCount > 0) {
    const problems = scan.issues.map((issue): CsvProblem => {
      const record = at(issue.recordStart);
      const where = at(issue.offset);
      const sameLine = where.line === record.line;
      const position = sameLine ? `column ${where.column}` : `line ${where.line}, column ${where.column}`;
      const common = {rule: 'R13' as const, line: record.line, ...(sameLine ? {column: where.column} : {})};
      return issue.kind === 'unterminated'
        ? {
            ...common,
            code: 'unterminated_quote',
            message: `The quoted cell that opens at ${position} is never closed, so the rest of the file would read as one cell.`,
            fix: 'Add the closing double quote, or remove the opening one. Inside a quoted cell, write a double quote as two ("").',
          }
        : {
            ...common,
            code: 'invalid_quote',
            message: `Text follows a closing quote at ${position}; a quoted cell must end at a comma or the end of the line.`,
            fix: 'Put the whole cell inside the quotes, and write any double quote inside it as two ("").',
          };
    });
    return {ok: false, problems: capProblems(problems, scan.issueCount)};
  }

  // Fully empty trailing lines are ignored (IC03); earlier blank records stay rows.
  let count = scan.count;
  while (count > 0 && scan.blank[count - 1] === 1) {
    count -= 1;
  }
  if (count === 0) {
    return {
      ok: false,
      problems: [
        {
          code: 'empty',
          rule: 'R13',
          message: 'The data file is empty; it needs a header row naming its columns.',
          fix: 'Add a header row such as "phase,hours" and at least one row of data.',
          line: null,
        },
      ],
    };
  }

  const dataCount = count - 1;
  if (dataCount > INPUT_LIMITS.csvRows) {
    return {
      ok: false,
      problems: [
        {
          code: 'too_many_rows',
          rule: 'R09',
          message: `The data file has ${numberFormat.format(dataCount)} data rows; a CSV is limited to ${numberFormat.format(INPUT_LIMITS.csvRows)}.`,
          fix: 'Aggregate or split the data so each file has at most 100,000 rows.',
          line: at(scan.starts[INPUT_LIMITS.csvRows + 1] ?? 0).line,
        },
      ],
    };
  }

  // A blank first line would be read as a header with one empty name, and every row as too wide for
  // it. The line is the problem, so it is reported once and nothing is checked against it.
  if (scan.blank[0] === 1) {
    return {
      ok: false,
      problems: [
        {
          code: 'header_empty',
          rule: 'R13',
          line: at(scan.starts[0] ?? 0).line,
          message: 'The file starts with a blank line; the header row naming the columns must be the first line.',
          fix: 'Remove the blank line at the top of the file.',
        },
      ],
    };
  }

  // Only now are cells built, and only for the records kept: dropped trailing
  // blank lines never reach d3-dsv. Cut after a record's line break, d3-dsv
  // strips that break as it strips any final one, so the rows are the same.
  const values = csvParseRows(count < scan.count ? body.slice(0, scan.starts[count]) : body);
  if (values.length !== count || values.some((row, index) => row.length !== scan.cells[index])) {
    throw new Error('CSV record scanner and d3-dsv disagree about the records in this file; this is a Papeleria bug');
  }

  const built: CsvProblem[] = [];
  let total = 0;
  // Past the cap a problem is only counted (see capProblems).
  const report = (problem: () => CsvProblem): void => {
    total += 1;
    if (built.length <= MAX_CSV_PROBLEMS) {
      built.push(problem());
    }
  };

  const header = values[0] ?? [];
  const headerStart = scan.starts[0] ?? 0;
  const headerLine = at(headerStart).line;
  const headerColumn = (index: number) => {
    const where = at(scan.headerCells[index] ?? headerStart);
    return where.line === headerLine ? {column: where.column} : {};
  };
  const firstSeen = new Map<string, number>();
  header.forEach((name, index) => {
    if (name.trim() === '') {
      const trailing = index === header.length - 1 && header.length > 1;
      report(() => ({
        code: 'header_empty',
        rule: 'R13',
        line: headerLine,
        ...headerColumn(index),
        message: trailing
          ? `The header ends with an empty column name (column ${index + 1}); a trailing comma is the usual cause.`
          : `Column ${index + 1} of the header has no name.`,
        fix: trailing ? 'Remove the trailing comma from the header row, or name the column.' : 'Give every column a name in the header row.',
      }));
      return;
    }
    const earlier = firstSeen.get(name);
    if (earlier !== undefined) {
      report(() => ({
        code: 'header_duplicate',
        rule: 'R13',
        line: headerLine,
        ...headerColumn(index),
        message: `The column name ${quoted(name)} appears twice in the header (columns ${earlier + 1} and ${index + 1}); names must be unique.`,
        fix: 'Rename one of the columns. Names are matched exactly, including case.',
      }));
      return;
    }
    firstSeen.set(name, index);
  });

  const width = header.length;
  for (let index = 1; index < count; index += 1) {
    const cells = values[index]?.length ?? width;
    if (cells === width) {
      continue;
    }
    report(() => {
      const line = at(scan.starts[index] ?? 0).line;
      return scan.blank[index] === 1
        ? {
            code: 'row_width',
            rule: 'R13',
            line,
            message: `This line is blank inside the data; the header has ${width} cells.`,
            fix: 'Remove the blank line, or fill it in as a row of data.',
          }
        : {
            code: 'row_width',
            rule: 'R13',
            line,
            message: `This row has ${cells} ${cells === 1 ? 'cell' : 'cells'}; the header has ${width}.`,
            fix: 'Give every row exactly as many cells as the header. Quote a cell that contains a comma.',
          };
    });
  }

  if (total > 0) {
    return {ok: false, problems: capProblems(built, total)};
  }

  const rows = values.slice(1);
  const columns = header.map((name, index): CsvColumn => ({
    name,
    type: inferColumnType(rows.map((row) => row[index] ?? '')),
  }));
  return {
    ok: true,
    table: {
      columns,
      rows,
      positions: Array.from(scan.starts.subarray(1, count), (start) => at(start).line),
      headerLine,
      headerOnly: rows.length === 0,
    },
  };
}
