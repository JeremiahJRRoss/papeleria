/**
 * M1.7 / IC06: the report object and the human text the CLI prints from it.
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {traced, settleFindings, type Finding} from '../../src/core/index.js';
import {createReport, formatFinding, formatLocation, formatReport, type ReportInput} from '../../src/build/report.js';

const ESC = String.fromCharCode(0x1b);

function finding(rule: string, severity: 'error' | 'warning', line: number | null, file = 'papeleria.yaml'): Finding {
  return traced({rule, severity, message: `${rule} message`, fix: `${rule} fix`, location: {file, line, column: line === null ? null : 3}, sourcePath: `${file}#${rule}`}).finding;
}

function input(findings: readonly Finding[], overrides: Partial<ReportInput> = {}): ReportInput {
  return {piece: 'my-deck', toolVersion: '0.0.0', findings, weight: null, targets: [], outputWritten: false, outputReason: 'check_only', ...overrides};
}

test('IC06: the report has exactly its keys, and counts the findings it lists', () => {
  const findings = [finding('R01', 'warning', 4), finding('R02', 'error', 2), finding('R06', 'warning', null)];
  const report = createReport(input(findings));
  assert.deepEqual(Object.keys(report), ['piece', 'tool', 'status', 'errors', 'warnings', 'findings', 'weight', 'targets', 'outputWritten', 'outputReason']);
  assert.deepEqual(report.tool, {name: 'papeleria', version: '0.0.0'});
  assert.equal(report.status, 'failed');
  assert.equal(report.errors, 1);
  assert.equal(report.warnings, 2);
  const clean = createReport(input([finding('R06', 'warning', 1)]));
  assert.equal(clean.status, 'ok', 'warnings never fail a report');
  assert.equal(createReport(input([], {outputReason: 'withheld'})).status, 'ok', 'withheld is an output reason, not an error');
});

test('a location is file:line:column, or the file alone without a line; the file is escaped for a terminal', () => {
  assert.equal(formatLocation({file: 'papeleria.yaml', line: 3, column: 7}), 'papeleria.yaml:3:7');
  assert.equal(formatLocation({file: 'assets/data/a.csv', line: 12, column: null}), 'assets/data/a.csv:12');
  assert.equal(formatLocation({file: 'assets/images/a.png', line: null, column: null}), 'assets/images/a.png');
  assert.equal(formatLocation({file: `assets/images/${ESC}[31mred.png`, line: null, column: null}), 'assets/images/\\u001b[31mred.png');
});

test('a finding prints its location, severity, rule, message, fix, detail and related location', () => {
  const item = traced({
    rule: 'R09',
    message: `The image ${ESC}[2J is too tall.`,
    fix: 'Crop it.',
    detail: 'Input limit.',
    location: {file: 'assets/images/tall.png', line: null, column: null},
    relatedLocation: {file: 'papeleria.yaml', line: 9, column: 10},
    sourcePath: 'x',
  }).finding;
  assert.deepEqual(formatFinding(item), [
    'assets/images/tall.png error R09: The image \\u001b[2J is too tall.',
    '  fix: Crop it.',
    '  Input limit.',
    '  see papeleria.yaml:9:10',
  ]);
});

test('the report text lists the findings in IC01 order, then one line that says what was written', () => {
  const findings = settleFindings([
    traced({rule: 'R06', message: 'b', fix: 'f', location: {file: 'papeleria.yaml', line: 9, column: 1}, sourcePath: 'b'}),
    traced({rule: 'R02', message: 'a', fix: 'f', location: {file: 'papeleria.yaml', line: 3, column: 1}, sourcePath: 'a'}),
  ]);
  const weight = {firstViewBytes: 236_286, budgetBytes: 1_048_576, withinBudget: true, largest: [['index.html', 8_063] as const]};
  const text = formatReport(createReport(input(findings, {outputReason: 'written', outputWritten: true, weight, piece: 'decks/q3/'})));
  assert.deepEqual(text.split('\n'), [
    'papeleria.yaml:3:1 error R02: a',
    '  fix: f',
    'papeleria.yaml:9:1 warning R06: b',
    '  fix: f',
    'Built decks/q3/dist · 1 error · 1 warning · first view 236,286 of 1,048,576 bytes',
  ]);
  const summaries = {
    withheld: 'my-deck is withheld: nothing was written to dist/ · 0 errors · 0 warnings',
    check_only: 'Checked my-deck · 0 errors · 0 warnings',
    preview_only: 'Previewed my-deck · 0 errors · 0 warnings',
    failed: 'my-deck was not built: nothing was written to dist/ · 0 errors · 0 warnings',
  } as const;
  for (const [reason, line] of Object.entries(summaries)) {
    assert.equal(formatReport(createReport(input([], {outputReason: reason as keyof typeof summaries}))), line);
  }
  assert.equal(
    formatReport(createReport(input([], {piece: `evil${ESC}]0;title`}))),
    'Checked evil\\u001b]0;title · 0 errors · 0 warnings',
    'the piece label is escaped too',
  );
});
