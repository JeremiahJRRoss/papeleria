/**
 * M1.11 / IC03 / R13: CSV parsing with honest record positions. BOM,
 * quoted-newline positions under LF, CRLF and CR, header rules, row widths,
 * blank records, type inference, quote errors, the IC01 row limit, and
 * agreement between the owned record scanner and d3-dsv on generated input.
 * The byte limit belongs to `FileAccess`, which reads the file (D159).
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {csvParseRows} from 'd3-dsv';

import {
  MAX_CSV_PROBLEMS,
  inferColumnType,
  parseCsv,
  parseDateCell,
  parseNumberCell,
  type CsvProblem,
  type CsvProblemCode,
  type CsvResult,
  type CsvTable,
} from '../../src/core/csv.js';
import {INPUT_LIMITS} from '../../src/core/limits.js';
import {applicationRoot, fixturePath} from '../helpers/paths.js';

const MAX_CSV_ROWS = INPUT_LIMITS.csvRows;

const BOM = String.fromCharCode(0xfeff);

function fixture(name: string): string {
  return readFileSync(fixturePath('csv', name), 'utf8');
}

function table(text: string): CsvTable {
  const result = parseCsv(text);
  assert.ok(result.ok, `expected a table, got ${JSON.stringify(result.ok ? null : result.problems, null, 2)}`);
  return result.table;
}

function problems(text: string): CsvProblem[] {
  const result = parseCsv(text);
  assert.ok(!result.ok, 'expected problems, got a table');
  for (const problem of result.problems) {
    assert.ok(problem.message.length > 0 && problem.fix.length > 0, 'every problem has a message and a fix');
  }
  return result.problems;
}

const summary = (list: readonly CsvProblem[]) =>
  list.map((problem) => ({code: problem.code, rule: problem.rule, line: problem.line, ...(problem.column === undefined ? {} : {column: problem.column})}));

/** The three line-ending styles d3-dsv accepts, applied to every line break in a fixture. */
const endings: Array<[string, (text: string) => string]> = [
  ['LF', (text) => text],
  ['CRLF', (text) => text.replace(/\n/g, '\r\n')],
  ['CR', (text) => text.replace(/\n/g, '\r')],
];

test('the seeded example CSVs parse with the expected columns, types and lines', () => {
  const phase = table(readFileSync(join(applicationRoot, 'examples/hours-report/assets/data/hours-by-phase.csv'), 'utf8'));
  assert.deepEqual(phase.columns, [
    {name: 'phase', type: 'text'},
    {name: 'hours', type: 'number'},
  ]);
  assert.deepEqual(phase.rows, [['Review', '41'], ['Build', '26'], ['Delivery', '9']]);
  assert.deepEqual(phase.positions, [2, 3, 4]);
  assert.equal(phase.headerLine, 1);
  assert.equal(phase.headerOnly, false);

  const week = table(readFileSync(join(applicationRoot, 'examples/hours-report/assets/data/hours-by-week.csv'), 'utf8'));
  assert.deepEqual(week.columns, [
    {name: 'week', type: 'date'},
    {name: 'phase', type: 'text'},
    {name: 'hours', type: 'number'},
  ]);
  assert.equal(week.rows.length, 6);
  assert.deepEqual(week.positions, [2, 3, 4, 5, 6, 7]);

  const starter = table(readFileSync(join(applicationRoot, 'examples/starter-deck/assets/data/hours-by-phase.csv'), 'utf8'));
  assert.deepEqual(starter, phase, 'the starter deck carries the same data');
});

test('a record keeps the line where it starts, across quoted newlines, under LF, CRLF and CR', () => {
  for (const [label, convert] of endings) {
    const parsed = table(convert(fixture('quoted-newlines.csv')));
    assert.deepEqual(parsed.positions, [2, 4, 5, 6, 9], label);
    assert.deepEqual(parsed.rows.map((row) => row[0]), ['1', '2', '3', '4', '5'], label);
    const newline = label === 'LF' ? '\n' : label === 'CRLF' ? '\r\n' : '\r';
    assert.equal(parsed.rows[0]?.[1], `first line${newline}second line`, `${label}: the embedded break is kept as written`);
    assert.equal(parsed.rows[2]?.[1], 'a "quoted" word, with a comma', `${label}: escaped quotes and commas`);
    assert.equal(parsed.rows[3]?.[1], `three${newline}line${newline}cell`, label);
  }
});

test('a leading byte order mark is removed and moves nothing', () => {
  const parsed = table(fixture('bom.csv'));
  assert.equal(parsed.columns[0]?.name, 'phase', 'no BOM in the first header name');
  assert.deepEqual(parsed.positions, [2, 3]);
  const plain = table(fixture('bom.csv').slice(1));
  assert.deepEqual(parsed, plain);
  for (const [label, convert] of endings) {
    assert.deepEqual(table(BOM + convert(fixture('quoted-newlines.csv'))).positions, [2, 4, 5, 6, 9], `BOM + ${label}`);
  }
  // A BOM-looking character anywhere else is data.
  assert.equal(table(`a\n${BOM}x\n`).rows[0]?.[0], `${BOM}x`);
});

test('a duplicate header name is R13 at the header line and the second occurrence', () => {
  const found = problems(fixture('duplicate-header.csv'));
  assert.deepEqual(summary(found), [{code: 'header_duplicate', rule: 'R13', line: 1, column: 13}]);
  assert.match(found[0]?.message ?? '', /"phase" appears twice in the header \(columns 1 and 3\)/);
  // Names are exact and case-sensitive: these are two different columns.
  assert.deepEqual(table('Hours,hours\n1,2\n').columns.map((column) => column.name), ['Hours', 'hours']);
});

test('an empty or trailing empty header name is R13, and whitespace is not a name', () => {
  assert.deepEqual(summary(problems(fixture('empty-header.csv'))), [{code: 'header_empty', rule: 'R13', line: 1, column: 7}]);
  const trailing = problems(fixture('trailing-empty-header.csv'));
  assert.deepEqual(summary(trailing), [{code: 'header_empty', rule: 'R13', line: 1, column: 13}]);
  assert.match(trailing[0]?.message ?? '', /trailing comma/);
  assert.deepEqual(summary(problems('a,  ,b\n1,2,3\n')), [{code: 'header_empty', rule: 'R13', line: 1, column: 3}]);
  // A name with surrounding spaces is kept exactly; matching it is the chart's job.
  assert.equal(table(' hours ,x\n1,2\n').columns[0]?.name, ' hours ');
});

test('every row must be as wide as the header; each short, long or blank row is reported at its line', () => {
  for (const [label, convert] of endings) {
    const found = problems(convert(fixture('uneven-rows.csv')));
    assert.deepEqual(
      summary(found),
      [
        {code: 'row_width', rule: 'R13', line: 3},
        {code: 'row_width', rule: 'R13', line: 4},
        {code: 'row_width', rule: 'R13', line: 5},
      ],
      label,
    );
    assert.match(found[0]?.message ?? '', /This row has 3 cells; the header has 2/);
    assert.match(found[1]?.message ?? '', /This row has 1 cell; the header has 2/);
    assert.match(found[2]?.message ?? '', /blank inside the data/);
  }
});

test('fully empty trailing lines are ignored; a blank record inside the data stays a row', () => {
  for (const [label, convert] of endings) {
    const trailing = table(convert(fixture('trailing-blank-lines.csv')));
    assert.deepEqual(trailing.rows, [['Review', '41'], ['Build', '26']], label);
    const middle = table(convert(fixture('blank-record-middle.csv')));
    assert.deepEqual(middle.rows, [['first'], [''], ['third']], `${label}: one column, so a blank line is a row with an empty cell`);
    assert.deepEqual(middle.positions, [2, 3, 4], label);
  }
  // A line of spaces is not empty: it is a one-cell row.
  assert.deepEqual(summary(problems('a,b\n1,2\n   \n')), [{code: 'row_width', rule: 'R13', line: 3}]);
});

test('a blank first line is one problem at line 1, not a width problem on every row', () => {
  // Read as a header, a blank line is one empty name, and every real row is too wide for it: 51
  // problems for one stray line, with a fix that pointed at the header row.
  const rows = Array.from({length: 1000}, (_, index) => `p${index},${index}`);
  const cases: Array<[string, string]> = [
    ['LF', `\nphase,hours\n${rows.join('\n')}\n`],
    ['CR', `\rphase,hours\r${rows.join('\r')}\r`],
    ['BOM and CRLF', `${BOM}\r\nphase,hours\r\n${rows.join('\r\n')}\r\n`],
    ['two blank lines', `\n\nphase,hours\n${rows.join('\n')}\n`],
    ['a header and no rows', '\nphase,hours\n'],
  ];
  for (const [label, text] of cases) {
    const found = problems(text);
    assert.deepEqual(summary(found), [{code: 'header_empty', rule: 'R13', line: 1}], label);
    assert.equal(found[0]?.message, 'The file starts with a blank line; the header row naming the columns must be the first line.', label);
    assert.equal(found[0]?.fix, 'Remove the blank line at the top of the file.', label);
  }
  // The input limits still come first, and a line of spaces is a header with an empty name, as before.
  assert.deepEqual(summary(problems(`\nv\n${'1\n'.repeat(MAX_CSV_ROWS)}`)), [{code: 'too_many_rows', rule: 'R09', line: MAX_CSV_ROWS + 2}]);
  assert.deepEqual(summary(problems('   \nphase\n')), [{code: 'header_empty', rule: 'R13', line: 1, column: 1}]);
});

test('a header-only file is a table with no rows and the header-only flag', () => {
  for (const text of [fixture('header-only.csv'), 'phase,hours', 'phase,hours\r\n\r\n\r\n']) {
    const parsed = table(text);
    assert.equal(parsed.headerOnly, true);
    assert.deepEqual(parsed.rows, []);
    assert.deepEqual(parsed.positions, []);
    assert.deepEqual(parsed.columns, [
      {name: 'phase', type: 'text'},
      {name: 'hours', type: 'text'},
    ]);
  }
});

test('an empty file has no header, reported for the whole file', () => {
  for (const text of ['', '\n', '\n\n\r\n', BOM, `${BOM}\n`]) {
    assert.deepEqual(summary(problems(text)), [{code: 'empty', rule: 'R13', line: null}], JSON.stringify(text));
  }
});

test('types are inferred per column ignoring empty cells, with no coercion', () => {
  const parsed = table(fixture('types.csv'));
  assert.deepEqual(
    Object.fromEntries(parsed.columns.map((column) => [column.name, column.type])),
    {n: 'number', d: 'date', t: 'text', e: 'text', thousands: 'text', infinity: 'text', bad_date: 'text', sci: 'number'},
  );
});

test('cells keep their source text exactly', () => {
  const parsed = table(fixture('source-text.csv'));
  assert.deepEqual(parsed.rows, [['007', '1.50', ' spaced '], ['010', '2.00', 'quoted, comma']]);
  assert.deepEqual(parsed.columns.map((column) => column.type), ['number', 'number', 'text']);
});

test('the number and date grammars', () => {
  const numbers: Array<[string, number | null]> = [
    ['0', 0], ['41', 41], ['-1.5', -1.5], ['+7', 7], ['.5', 0.5], ['5.', 5], ['1e3', 1000], ['2.5E-2', 0.025], ['007', 7],
    ['', null], [' 1', null], ['1 ', null], ['1,000', null], ['1_000', null], ['Infinity', null], ['-Infinity', null],
    ['NaN', null], ['0x10', null], ['1e', null], ['e5', null], ['.', null], ['-', null], ['1e999', null], ['1.2.3', null], ['１', null],
  ];
  for (const [text, expected] of numbers) {
    assert.equal(parseNumberCell(text), expected, JSON.stringify(text));
  }
  const dates: Array<[string, number | null]> = [
    ['2026-07-06', Date.UTC(2026, 6, 6)], ['2024-02-29', Date.UTC(2024, 1, 29)], ['2000-02-29', Date.UTC(2000, 1, 29)],
    ['2026-12-31', Date.UTC(2026, 11, 31)], ['0099-01-01', -59042995200000],
    ['2026-02-29', null], ['1900-02-29', null], ['2026-02-30', null], ['2026-13-01', null], ['2026-00-10', null],
    ['2026-01-00', null], ['2026-7-6', null], ['26-07-06', null], ['2026-07-06T00:00', null], [' 2026-07-06', null], ['2026/07/06', null],
  ];
  for (const [text, expected] of dates) {
    assert.equal(parseDateCell(text), expected, JSON.stringify(text));
  }
  assert.equal(new Date(parseDateCell('0099-01-01') ?? 0).getUTCFullYear(), 99, 'years below 100 are not shifted into the 1900s');
  assert.equal(inferColumnType([]), 'text');
  assert.equal(inferColumnType(['', '']), 'text');
  assert.equal(inferColumnType(['1', '', '2']), 'number');
  assert.equal(inferColumnType(['2026-01-01', '']), 'date');
  assert.equal(inferColumnType(['2026', '2026-01-01']), 'text', 'numbers and dates together are text');
});

test('an unterminated quote is R13 at the line where its record starts', () => {
  // What d3-dsv would silently make of it: the rest of the file as one cell.
  assert.deepEqual(csvParseRows('a\n"open,x\ny'), [['a'], ['open,x\ny']]);
  for (const [label, convert] of endings) {
    assert.deepEqual(
      summary(problems(convert(fixture('unterminated-quote.csv')))),
      [{code: 'unterminated_quote', rule: 'R13', line: 2, column: 8}],
      label,
    );
  }
  // The quote opens on a later line than its record starts: the column is left
  // out of the location and named in the message instead.
  const later = problems('a,b,c\n1,"two\nlines",x"\n2,"open\n');
  assert.deepEqual(summary(later), [{code: 'unterminated_quote', rule: 'R13', line: 4, column: 3}]);
  const spread = problems('a,b\n"x\ny","z\n');
  assert.deepEqual(summary(spread), [{code: 'unterminated_quote', rule: 'R13', line: 2}]);
  assert.match(spread[0]?.message ?? '', /opens at line 3, column 4/);
});

test('text after a closing quote is R13 instead of the cell d3-dsv would silently invent', () => {
  // What d3-dsv would silently make of it: the "l" vanishes and the cell splits.
  assert.deepEqual(csvParseRows('Review,"closed"late'), [['Review', 'closed', 'ate']]);
  assert.deepEqual(csvParseRows('"a"b,c'), [['a', '', 'c']]);
  for (const [label, convert] of endings) {
    const found = problems(convert(fixture('invalid-quote.csv')));
    assert.deepEqual(summary(found), [{code: 'invalid_quote', rule: 'R13', line: 2, column: 16}], label);
  }
  assert.deepEqual(summary(problems('a\n"x" \n')), [{code: 'invalid_quote', rule: 'R13', line: 2, column: 4}], 'a space after the quote counts');
});

test('IC01: at most 100,000 data rows, inclusive; the first extra row is named', () => {
  const rows = (count: number) => `v\n${'1\n'.repeat(count)}`;
  const atLimit = table(rows(MAX_CSV_ROWS));
  assert.equal(atLimit.rows.length, MAX_CSV_ROWS);
  assert.equal(atLimit.positions.at(-1), MAX_CSV_ROWS + 1);
  assert.deepEqual(summary(problems(rows(MAX_CSV_ROWS + 1))), [{code: 'too_many_rows', rule: 'R09', line: MAX_CSV_ROWS + 2}]);
});

test('text over the IC01 byte limit is a caller defect; exactly the limit parses', () => {
  // FileAccess reads the file with the bound and owns the limit (D159). 100,000
  // rows so the row limit is not what stops it.
  const rowCount = MAX_CSV_ROWS;
  const header = 'v\n';
  const row = `${'x'.repeat(51)}\n`;
  const remaining = INPUT_LIMITS.textBytes - header.length - row.length * (rowCount - 1);
  const exact = header + row.repeat(rowCount - 1) + `${'x'.repeat(remaining - 1)}\n`;
  assert.equal(Buffer.byteLength(exact), INPUT_LIMITS.textBytes);
  assert.equal(table(exact).rows.length, rowCount);
  assert.throws(() => parseCsv(`${exact}x`), RangeError);
  // Two bytes per é: fewer characters than the limit, more bytes.
  const accented = `v\n${'é'.repeat(INPUT_LIMITS.textBytes / 2)}\n`;
  assert.ok(accented.length < INPUT_LIMITS.textBytes);
  assert.throws(() => parseCsv(accented), RangeError);
});

test('IC01: a file inside the byte limit is parsed or refused in bounded time, however many records or problems it holds', () => {
  // Each blank or tiny record used to cost a scanner object and a d3-dsv row
  // before the empty-file and row-limit checks, and every problem an object
  // before the cap: 5 MiB of line breaks took seconds and 2.5 GB, and aborted
  // Node with a 2 GB heap. Outcomes are what they were; only the cost changed.
  const limit = INPUT_LIMITS.textBytes;
  const fill = (unit: string, budget: number) => unit.repeat(Math.floor(budget / unit.length));
  const refused = (code: CsvProblemCode, line: number | null, message: string) => (result: CsvResult) => {
    assert.ok(!result.ok);
    assert.deepEqual(summary(result.problems), [{code, rule: code === 'too_many_rows' ? 'R09' : 'R13', line}]);
    assert.equal(result.problems[0]?.message, message);
  };
  const capped = (code: CsvProblemCode, line: number, rest: string) => (result: CsvResult) => {
    assert.ok(!result.ok);
    assert.equal(result.problems.length, MAX_CSV_PROBLEMS + 1);
    assert.ok(result.problems.slice(0, -1).every((problem) => problem.code === code), code);
    assert.deepEqual(summary(result.problems.slice(-1)), [{code: 'too_many_problems', rule: 'R13', line}]);
    assert.equal(result.problems.at(-1)?.message, `${rest} more problems in this file are not listed.`);
  };
  const tooManyRows = (rows: string) =>
    refused('too_many_rows', MAX_CSV_ROWS + 2, `The data file has ${rows} data rows; a CSV is limited to 100,000.`);
  const padded = `week,phase,hours,notes\n${'2026-01-05,Design,12,\n'.repeat(40)}`;
  const cases: Array<[label: string, text: string, check: (result: CsvResult) => void]> = [
    ['5 MiB of line breaks', '\n'.repeat(limit), refused('empty', null, 'The data file is empty; it needs a header row naming its columns.')],
    ['a header, then line breaks', `a,b\n${'\n'.repeat(limit - 4)}`, (result) => {
      assert.ok(result.ok);
      assert.deepEqual(result.table.columns.map((column) => column.name), ['a', 'b']);
      assert.equal(result.table.headerOnly, true);
    }],
    ['a header, line breaks, then a row', `a,b\n${'\n'.repeat(limit - 8)}1,2`, tooManyRows('5,242,873')],
    ['2.6 million one-cell rows', `a\n${fill('1\n', limit - 2)}`, tooManyRows('2,621,439')],
    ['a spreadsheet export padded with empty rows', padded + fill(',,,\n', limit - padded.length), tooManyRows('1,310,534')],
    ['blank rows inside the row limit, then line breaks', `a,b\n${'\n'.repeat(99_999)}1,2\n${'\n'.repeat(limit - 100_011)}`, capped('row_width', 52, '99,949')],
    ['a header of 5 million commas', `${fill(',', limit - 3)}\n1\n`, capped('header_empty', 1, '5,242,829')],
    ['a header of 2.6 million equal names', `${fill('a,', limit - 3)}a\n`, capped('header_duplicate', 1, '2,621,388')],
    ['text after a closing quote on a million lines', `a\n${fill('"a"b\n', limit - 2)}`, capped('invalid_quote', 52, '1,048,525')],
  ];
  for (const [label, text, check] of cases) {
    assert.ok(Buffer.byteLength(text) <= limit, `${label}: inside the limit`);
    const started = performance.now();
    const result = parseCsv(text);
    const elapsed = performance.now() - started;
    check(result);
    assert.ok(elapsed < 2_000, `${label}: ${Math.round(elapsed)} ms`);
  }
});

test('problems past the cap are summarized once, at the first unlisted line', () => {
  const text = `a,b\n${'1\n'.repeat(MAX_CSV_PROBLEMS + 10)}`;
  const found = problems(text);
  assert.equal(found.length, MAX_CSV_PROBLEMS + 1);
  const last = found.at(-1);
  assert.equal(last?.code, 'too_many_problems');
  assert.equal(last?.line, MAX_CSV_PROBLEMS + 2);
  assert.match(last?.message ?? '', /^10 more problems/);
});

/**
 * An independent reading of where each record starts, for well-formed text: a
 * plain character walk written separately from the scanner in csv.ts, which is
 * a port of d3-dsv's token loop. Only the d3-dsv conventions are shared: one
 * trailing LF and then one trailing CR are dropped, and a line break that is
 * not the dropped one always opens another record, even at the very end.
 */
function referenceStartLines(text: string): number[] {
  if (text.length === 0) {
    return [];
  }
  let end = text.length;
  if (text[end - 1] === '\n') {
    end -= 1;
  }
  if (end > 0 && text[end - 1] === '\r') {
    end -= 1;
  }
  const breakAt = (index: number) => (text[index] === '\n' ? 1 : text[index] === '\r' ? (text[index + 1] === '\n' ? 2 : 1) : 0);
  const starts: number[] = [];
  let line = 1;
  let index = 0;
  for (;;) {
    starts.push(line);
    for (;;) {
      if (index < end && text[index] === '"') {
        index += 1;
        for (;;) {
          if (text[index] === '"') {
            if (text[index + 1] === '"') {
              index += 2;
              continue;
            }
            index += 1;
            break;
          }
          const size = breakAt(index);
          line += size > 0 ? 1 : 0;
          index += size > 0 ? size : 1;
        }
      } else {
        while (index < end && text[index] !== ',' && breakAt(index) === 0) {
          index += 1;
        }
      }
      if (index >= end) {
        return starts;
      }
      if (text[index] === ',') {
        index += 1;
        continue;
      }
      line += 1;
      index += breakAt(index);
      break;
    }
  }
}

test('the record scanner agrees with d3-dsv, and with an independent reading of start lines, on 5,000 generated inputs', () => {
  // A small deterministic generator over the characters that matter.
  let seed = 20260922;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const alphabet = ['a', 'b', ',', ',', '"', '\n', '\n', '\r', '\r\n', ' ', '1'];
  let tables = 0;
  let refused = 0;
  let compared = 0;
  for (let index = 0; index < 5000; index += 1) {
    const length = Math.floor(random() * 24);
    let text = '';
    for (let position = 0; position < length; position += 1) {
      text += alphabet[Math.floor(random() * alphabet.length)];
    }
    // parseCsv throws if its scanner and csvParseRows ever disagree.
    const result = parseCsv(text);
    const lines = text.split(/\r\n|\r|\n/).length;
    if (result.ok) {
      tables += 1;
      const reference = referenceStartLines(text);
      assert.deepEqual(result.table.positions, reference.slice(1, 1 + result.table.positions.length), `start lines of ${JSON.stringify(text)}`);
      compared += result.table.positions.length;
      for (const position of result.table.positions) {
        assert.ok(position >= 2 && position <= lines, `position ${position} in ${JSON.stringify(text)}`);
      }
    } else {
      refused += 1;
      const quoted = result.problems.some((problem) => problem.code === 'unterminated_quote' || problem.code === 'invalid_quote');
      const reference = quoted ? [] : referenceStartLines(text);
      for (const problem of result.problems) {
        assert.ok(problem.line === null || (problem.line >= 1 && problem.line <= lines));
        if (!quoted && problem.line !== null) {
          assert.ok(reference.includes(problem.line), `${problem.code} at line ${problem.line} is a record start in ${JSON.stringify(text)}`);
        }
      }
    }
  }
  assert.ok(tables > 100 && refused > 100 && compared > 100, `exercised: ${tables} tables, ${refused} refused, ${compared} positions compared`);
});

test('problem codes stay within the documented set', () => {
  const documented: CsvProblemCode[] = [
    'empty', 'header_empty', 'header_duplicate', 'row_width', 'unterminated_quote', 'invalid_quote', 'too_many_rows', 'too_many_problems',
  ];
  const seen = new Set<string>();
  for (const name of ['duplicate-header.csv', 'empty-header.csv', 'trailing-empty-header.csv', 'uneven-rows.csv', 'unterminated-quote.csv', 'invalid-quote.csv']) {
    for (const problem of problems(fixture(name))) {
      seen.add(problem.code);
    }
  }
  for (const code of seen) {
    assert.ok(documented.includes(code as CsvProblemCode), code);
  }
});

test('IC01: one cell that looks like a number until its last character is inferred in linear time', () => {
  // NUMBER_PATTERN once read `\d+\.?\d*`: a run of digits before a stray
  // character backtracked over every split, quadratic in the cell. A 5 MiB
  // cell was hours of blocked event loop in the editor and serve processes.
  const digits = '1'.repeat(INPUT_LIMITS.textBytes - 64);
  const started = performance.now();
  assert.equal(parseNumberCell(`${digits}x`), null);
  assert.equal(parseNumberCell(`${digits}.5.`), null);
  assert.equal(parseNumberCell(`${digits}e`), null);
  assert.ok(performance.now() - started < 2_000, 'a cell of the largest size is refused in well under a second');
  for (const [text, value] of [['1', 1], ['-1.5', -1.5], ['.5', 0.5], ['5.', 5], ['1e10', 1e10], ['1.5E-3', 0.0015], ['+.5e+2', 50]] as const) {
    assert.equal(parseNumberCell(text), value, text);
  }
  for (const text of ['abc', '1x', '1.2.3', 'e5', '1e', '--1', ' 1', '1 ', '', '.', '+', 'Infinity', 'NaN', '0x10']) {
    assert.equal(parseNumberCell(text), null, JSON.stringify(text));
  }
});
