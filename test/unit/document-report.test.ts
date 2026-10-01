/**
 * M3.3 and M3.5: the report example, built by the compiled CLI on temporary
 * copies, so nothing is written into examples/ (D72).
 *
 * - A7 (the report): check and build give zero errors and zero warnings, the
 *   notices ship beside the page, and the first view is within 1,048,576
 *   bytes and is exactly the bytes `dist/` holds for it (IC04).
 * - A2: each CSV the report reads is changed, and the rebuilt page plots the
 *   new values and shows the new cells, for the bar chart and its table and
 *   for the line chart and its table, while the author's text — the summary
 *   file, byte for byte, and the charts' summaries — stays exactly as written,
 *   and nothing else on the page moves.
 */
import assert from 'node:assert/strict';
import {readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {after, before, describe, test} from 'node:test';

import {applicationRoot, runNode, type RunResult} from '../helpers/paths.js';
import {copyPiece, removeTemporaryFolders} from '../helpers/pieces.js';

after(removeTemporaryFolders);

const CLI = join(applicationRoot, 'lib', 'src', 'cli', 'index.js');
const REPORT = join(applicationRoot, 'examples', 'hours-report');
const BUDGET = 1_048_576;
const NOTICES = ['LICENSE', 'NOTICE.md', 'Poppins-OFL.txt', 'Inter-OFL.txt', 'THIRD_PARTY.md'];

type Report = {
  status: string;
  errors: number;
  warnings: number;
  findings: {file: string; line: number | null; rule: string; severity: string; message: string}[];
  weight: {firstViewBytes: number; budgetBytes: number | null; withinBudget: boolean};
  outputReason: string;
};

function build(piece: string): Promise<RunResult> {
  return runNode(CLI, ['build', piece]);
}

describe('examples/hours-report, built by the compiled CLI (A7, the report)', () => {
  let piece = '';
  let checked: RunResult;
  let built: RunResult;
  before(async () => {
    piece = copyPiece(REPORT, 'hours-report');
    checked = await runNode(CLI, ['check', piece, '--json']);
    built = await build(piece);
  });

  test('check and build report zero errors, and every warning is listed: none', (context) => {
    assert.equal(checked.code, 0, checked.stderr);
    const report = JSON.parse(checked.stdout) as Report;
    for (const finding of report.findings) {
      context.diagnostic(`${finding.severity}: ${finding.file}:${finding.line ?? '-'} ${finding.rule} ${finding.message}`);
    }
    assert.deepEqual([report.status, report.errors, report.warnings, report.outputReason], ['ok', 0, 0, 'check_only']);
    assert.equal(built.code, 0, built.stderr);
    assert.match(built.stderr, /^Built .*dist · 0 errors · 0 warnings · first view [\d,]+ of 1,048,576 bytes\n$/);
  });

  test('the notices ship beside the page, and the page has no script (C22)', () => {
    for (const notice of NOTICES) {
      assert.ok(statSync(join(piece, 'dist', notice)).isFile(), `${notice} is missing from dist/`);
    }
    const html = readFileSync(join(piece, 'dist', 'index.html'), 'utf8');
    assert.doesNotMatch(html, /<script\b/i);
    assert.equal(html.match(/<article class="template-page">/g)?.length, 2, '"Next action" starts the second sheet');
  });

  test('IC04: the first view is within 1,048,576 bytes, and is exactly the bytes dist/ holds for it', (context) => {
    const report = JSON.parse(checked.stdout) as Report;
    assert.equal(report.weight.budgetBytes, BUDGET);
    assert.equal(report.weight.withinBudget, true);
    // The report shows no image, so every viewport counts the same files: the
    // page, its five stylesheets (the print one too: a browser loads it), the
    // favicon and all eight fonts, each once; there is no script.
    const dist = join(piece, 'dist');
    const html = readFileSync(join(dist, 'index.html'), 'utf8');
    const referenced = [...html.matchAll(/<link rel="(?:stylesheet|icon)" href="([^"]+)"/g)].map((match) => match[1]!);
    assert.equal(referenced.length, 6, 'five stylesheets and the favicon');
    const fonts = readdirSync(join(dist, 'theme', 'fonts')).map((name) => `theme/fonts/${name}`);
    assert.equal(fonts.length, 8);
    const counted = ['index.html', ...referenced, ...fonts];
    const bytes = counted.reduce((sum, path) => sum + statSync(join(dist, path)).size, 0);
    assert.equal(report.weight.firstViewBytes, bytes, 'the report counts what dist/ holds');
    context.diagnostic(`hours-report: first view ${bytes.toLocaleString('en-US')} of ${BUDGET.toLocaleString('en-US')} bytes`);
  });
});

/** The page's parts: each chart's SVG and each table's body, in order, and the page with all of them taken out. */
function parts(html: string): {charts: string[]; tables: string[]; rest: string} {
  const charts = [...html.matchAll(/<svg\b[\s\S]*?<\/svg>/g)].map((match) => match[0]);
  const tables = [...html.matchAll(/<tbody>[\s\S]*?<\/tbody>/g)].map((match) => match[0]);
  const rest = html.replace(/<svg\b[\s\S]*?<\/svg>/g, '<svg/>').replace(/<tbody>[\s\S]*?<\/tbody>/g, '<tbody/>');
  return {charts, tables, rest};
}

/** The values a chart writes as text: its value labels, direct labels and ticks, without the bidi isolates (D164(i)). */
function drawnText(svg: string): string[] {
  return [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)].map((match) => match[1]!.replace(/<[^>]+>/g, '').replace(/[⁨⁩]/g, '').trim());
}

/** Every rectangle's size, the geometry of a bar chart. */
function bars(svg: string): string[] {
  return [...svg.matchAll(/<rect\b[^>]*\swidth="([^"]+)"[^>]*\sheight="([^"]+)"/g)].map((match) => `${match[1]}×${match[2]}`);
}

/** Every path's data, the geometry of a line chart. */
function paths(svg: string): string[] {
  return [...svg.matchAll(/<path\b[^>]*\sd="([^"]+)"/g)].map((match) => match[1]!);
}

test('A2: a changed CSV changes the plotted values and the table cells, bar and line, and the author’s summaries stay as written', async () => {
  const piece = copyPiece(REPORT, 'a2');
  const summaryPath = join(piece, 'assets', 'text', 'summary.md');
  const summaryBefore = readFileSync(summaryPath);
  assert.equal((await build(piece)).code, 0);
  const before = parts(readFileSync(join(piece, 'dist', 'index.html'), 'utf8'));
  assert.deepEqual([before.charts.length, before.tables.length], [2, 2], 'the bar chart and its table, then the line chart and its table');

  // Bar data: new values for two phases. Line data: a new value and a new week.
  const phase = join(piece, 'assets', 'data', 'hours-by-phase.csv');
  const week = join(piece, 'assets', 'data', 'hours-by-week.csv');
  writeFileSync(phase, readFileSync(phase, 'utf8').replace('Review,41', 'Review,52').replace('Build,26', 'Build,30'));
  writeFileSync(week, `${readFileSync(week, 'utf8').replace('2026-09-07,Review,14', '2026-09-07,Review,20')}2026-10-05,Review,23\n2026-10-05,Build,2\n`);
  const rebuilt = await build(piece);
  assert.equal(rebuilt.code, 0, rebuilt.stderr);
  const after = parts(readFileSync(join(piece, 'dist', 'index.html'), 'utf8'));

  // The bar chart plots the new values: its labels and its bars change.
  const [barBefore, lineBefore] = before.charts as [string, string];
  const [barAfter, lineAfter] = after.charts as [string, string];
  assert.ok(drawnText(barBefore).includes('41') && drawnText(barBefore).includes('26'));
  assert.ok(drawnText(barAfter).includes('52') && drawnText(barAfter).includes('30'), drawnText(barAfter).join(' | '));
  assert.ok(!drawnText(barAfter).includes('41') && !drawnText(barAfter).includes('26'));
  assert.notDeepEqual(bars(barAfter), bars(barBefore));
  // Its table shows the new cells.
  assert.match(before.tables[0]!, /<td class="num">41<\/td>/);
  assert.match(after.tables[0]!, /<td>Review<\/td><td class="num">52<\/td><\/tr><tr><td>Build<\/td><td class="num">30<\/td>/);
  assert.doesNotMatch(after.tables[0]!, />41</);

  // The line chart plots the new value and the new week; its table has both new rows.
  assert.notDeepEqual(paths(lineAfter), paths(lineBefore));
  assert.ok(drawnText(lineAfter).includes('20') || drawnText(lineAfter).some((text) => text.endsWith('23')), drawnText(lineAfter).join(' | '));
  assert.ok(drawnText(lineAfter).some((label) => /Oct/.test(label)), 'a tick for the new week');
  assert.match(after.tables[1]!, /<td>2026-09-07<\/td><td>Review<\/td><td class="num">20<\/td>/);
  assert.match(after.tables[1]!, /<td>2026-10-05<\/td><td>Review<\/td><td class="num">23<\/td><\/tr><tr><td>2026-10-05<\/td><td>Build<\/td><td class="num">2<\/td>/);

  // The author's words stay the author's: the summary file byte for byte, and
  // the charts' summaries, which name each drawing and show beneath it.
  assert.ok(readFileSync(summaryPath).equals(summaryBefore), 'assets/text/summary.md is unchanged');
  for (const summary of ['Review took the most hours and delivery the fewest.', 'Review hours rose through the quarter while build hours fell.']) {
    for (const {charts, rest} of [before, after]) {
      assert.ok(charts.some((svg) => svg.includes(summary)), `the drawing is named by "${summary}"`);
      assert.ok(rest.includes(`<p class="chart-summary" aria-hidden="true">${summary}</p>`), `the summary shows as written: ${summary}`);
    }
  }
  // And nothing outside the drawings and the tables moved.
  assert.equal(after.rest, before.rest);
});
