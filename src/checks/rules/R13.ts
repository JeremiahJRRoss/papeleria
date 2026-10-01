/**
 * R13: CSV data a chart or table cannot use (IC01, IC03, C13).
 *
 * Three sources, none of which resolve reports (D158):
 *
 * - the problems `csv.ts` kept in each `DataAsset`, once per file, at the line
 *   where the record starts, with the manifest token that first names the file;
 * - a table `columns` entry that names no header of its CSV, at the entry;
 * - the problems `renderChart` returned for each chart the build drew: at the
 *   CSV line of the record, or, with `line: null`, at the manifest field its
 *   `field` names. A header-only CSV is an error for a chart (the chart says
 *   so) and a warning for a table (said here), at the header line.
 *
 * A file that did not parse is reported once, and nothing that reads it is
 * checked further: its columns are not known.
 */
import {globalLocation, joinPointer, listForMessage, quoteValue, traced, type Location, type TracedFinding} from '../../core/index.js';
import {assetReferences, manifestLocation} from '../locate.js';
import type {SourceRule} from '../rule.js';
import {isResolvedChart, isResolvedTable, visitContent} from '../walk.js';

/** A column name as a message quotes it: hidden characters shown, a long one cut (D175). */
function quoteName(name: string): string {
  return quoteValue(name, 'json');
}

export const rule: SourceRule = {
  id: 'R13',
  phase: 'source',
  check({piece, charts}) {
    if (piece === null) {
      return [];
    }
    const findings: TracedFinding[] = [];
    const file = piece.manifestFile;
    const references = assetReferences(piece).data;
    const named = (path: string): Location | undefined => {
      const pointer = references.get(path);
      return pointer === undefined ? undefined : manifestLocation(piece, pointer);
    };

    // The files' own problems, once each.
    for (const path of Object.keys(piece.assets.data).sort()) {
      const csv = piece.assets.data[path]!.csv;
      if (csv.ok) {
        continue;
      }
      const related = named(path);
      csv.problems.forEach((problem, index) => {
        if (problem.rule !== 'R13') {
          return;
        }
        findings.push(
          traced({
            rule: 'R13',
            severity: 'error',
            message: problem.message,
            fix: problem.fix,
            location: problem.line === null ? globalLocation(path) : {file: path, line: problem.line, column: problem.column ?? null},
            sourcePath: `${path}#csv-${index}`,
            ...(related === undefined ? {} : {relatedLocation: related}),
          }),
        );
      });
    }

    visitContent(piece, (value) => {
      if (isResolvedTable(value)) {
        const {data} = value;
        if (!data.csv.ok) {
          return;
        }
        const table = data.csv.table;
        const dataField = manifestLocation(piece, joinPointer(value.pointer, 'data'));
        if (table.headerOnly) {
          findings.push(
            traced({
              rule: 'R13',
              severity: 'warning',
              message: `${data.path} has a header but no rows, so the table is empty.`,
              fix: 'Add rows below the header, or remove the table.',
              location: {file: data.path, line: table.headerLine, column: null},
              relatedLocation: dataField,
              sourcePath: `${file}#${value.pointer}#header-only`,
            }),
          );
        }
        const headers = table.columns.map((column) => column.name);
        (value.columns ?? []).forEach((column, index) => {
          if (headers.includes(column.field)) {
            return;
          }
          const pointer = joinPointer(joinPointer(value.pointer, 'columns'), index);
          findings.push(
            traced({
              rule: 'R13',
              severity: 'error',
              message: `The table names the column ${quoteName(column.field)}, which ${data.path} does not have. Its headers are ${listForMessage(headers, quoteName)}.`,
              fix: 'Use a column name exactly as the header writes it; names are case-sensitive.',
              // A mapping's field, or the entry itself when it is written as a name.
              location: manifestLocation(piece, joinPointer(pointer, 'field')),
              relatedLocation: {file: data.path, line: table.headerLine, column: null},
              sourcePath: `${file}#${pointer}`,
            }),
          );
        });
        return;
      }
      if (isResolvedChart(value)) {
        const drawn = charts.get(value.pointer);
        if (drawn === undefined) {
          return;
        }
        const dataField = manifestLocation(piece, joinPointer(value.pointer, 'data'));
        drawn.problems.forEach((problem, index) => {
          if (problem.rule !== 'R13') {
            return;
          }
          const atField = problem.line === null && problem.field !== null;
          const location: Location = atField
            ? manifestLocation(piece, joinPointer(value.pointer, problem.field!))
            : problem.line === null
              ? globalLocation(value.data.path)
              : {file: value.data.path, line: problem.line, column: null};
          findings.push(
            traced({
              rule: 'R13',
              severity: 'error',
              message: problem.message,
              fix: problem.fix,
              location,
              ...(atField ? {} : {relatedLocation: dataField}),
              sourcePath: `${file}#${value.pointer}#chart-${index}`,
            }),
          );
        });
      }
    });
    return findings;
  },
};
