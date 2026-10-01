/**
 * M2.2: a CSV file as a read-only table (UX §08; IC06: CSV is read-only).
 *
 * The file is parsed with d3-dsv's `csvParseRows`, as the build parses it
 * (IC03), and shown in the kit's scrolling table region: the header row, then
 * the first `SHOWN_ROWS` records, with a note of how many there are. Nothing
 * here can change the file.
 */
import {csvParseRows} from 'd3-dsv';

import {baseName, element} from './dom.js';

/** Records shown; a file may hold 100,000 (IC01), which no table should render at once. */
export const SHOWN_ROWS = 500;

export function csvTable(path: string, text: string): HTMLElement {
  const rows = csvParseRows(text.startsWith('﻿') ? text.slice(1) : text).filter((row, index, all) => !(index === all.length - 1 && row.length === 1 && row[0] === ''));
  const [header = [], ...records] = rows;
  const name = baseName(path);
  const region = element('div', {class: 'table-wrap editor-csv', role: 'region', 'aria-label': `${name}, read-only`, tabindex: '0'});
  const table = element('table');
  const shown = records.slice(0, SHOWN_ROWS);
  table.append(
    element(
      'caption',
      {},
      `${name} · read-only · ${records.length.toLocaleString('en-US')} ${records.length === 1 ? 'row' : 'rows'}${
        records.length > shown.length ? `, the first ${SHOWN_ROWS} shown` : ''
      }`,
    ),
  );
  const head = element('thead');
  const headRow = element('tr');
  for (const cell of header) {
    headRow.append(element('th', {scope: 'col'}, cell));
  }
  head.append(headRow);
  const body = element('tbody');
  for (const record of shown) {
    const row = element('tr');
    for (const cell of record) {
      row.append(element('td', {}, cell));
    }
    body.append(row);
  }
  table.append(head, body);
  region.append(table);
  return region;
}
