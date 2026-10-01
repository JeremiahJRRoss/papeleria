/**
 * M2.5: the words of the editor's status line (UX §08 "States and copy").
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {failedLine, formatAge, formatBytes, overflowLine, previewLine, savedLine, tally, weightTone, type Weight} from '../../src/editor/status.js';

const MB = 1024 * 1024;

function weight(firstViewBytes: number, largest: [string, number][] = []): Weight {
  return {firstViewBytes, budgetBytes: MB, withinBudget: firstViewBytes <= MB, largest};
}

test('Ready: "Updated 0.6 s ago · 412 KB of 1 MB", in the success colour under 90% of the budget', () => {
  assert.deepEqual(previewLine(weight(412 * 1024), 0.64), {text: 'Updated 0.6 s ago · 412 KB of 1 MB', tone: 'success'});
  assert.deepEqual(previewLine(weight(412 * 1024), 12.9), {text: 'Updated 12 s ago · 412 KB of 1 MB', tone: 'success'});
  assert.equal(previewLine(weight(0), 200).text, 'Updated 3 min ago · 0 KB of 1 MB');
});

test('within 10% of the budget is a warning; over it names the largest files', () => {
  assert.equal(weightTone(weight(Math.ceil(MB * 0.9) - 1)), 'success');
  assert.equal(weightTone(weight(Math.ceil(MB * 0.9))), 'warning');
  assert.equal(weightTone(weight(MB)), 'warning');
  assert.equal(weightTone(weight(MB + 1)), 'error');
  assert.deepEqual(
    previewLine(
      weight(Math.round(1.2 * MB), [
        ['pages/03.png', 640 * 1024],
        ['pages/01.png', 300 * 1024],
        ['fonts/inter.woff2', 90 * 1024],
        ['deck.js', 18 * 1024],
      ]),
      1,
    ),
    {text: '1.2 MB of 1 MB. Largest: pages/03.png 640 KB, pages/01.png 300 KB, fonts/inter.woff2 90 KB', tone: 'error'},
  );
});

test('no budget, or no weight, is neutral', () => {
  assert.deepEqual(previewLine({firstViewBytes: 2048, budgetBytes: null, withinBudget: true, largest: []}, 1), {text: 'Updated 1.0 s ago · 2 KB first view', tone: 'neutral'});
  assert.deepEqual(previewLine(null, 1), {text: 'Updated 1.0 s ago', tone: 'neutral'});
});

test('a deck’s slides too big for their printed page follow, in the warning colour unless over budget (D167, D174)', () => {
  assert.equal(overflowLine([]), '');
  assert.equal(overflowLine([2]), 'Slide 2 overflows');
  assert.equal(overflowLine([2, 5]), 'Slides 2 and 5 overflow');
  assert.equal(overflowLine([2, 5, 9]), 'Slides 2, 5 and 9 overflow');
  assert.deepEqual(previewLine(weight(412 * 1024), 0.64, [2]), {text: 'Updated 0.6 s ago · 412 KB of 1 MB · Slide 2 overflows', tone: 'warning'});
  assert.deepEqual(previewLine(weight(412 * 1024), 0.64, []), previewLine(weight(412 * 1024), 0.64), 'none: the line as it was');
  assert.deepEqual(previewLine(null, 1, [3, 4]), {text: 'Updated 1.0 s ago · Slides 3 and 4 overflow', tone: 'warning'});
  assert.deepEqual(previewLine(weight(2 * MB, [['pages/03.png', MB]]), 1, [2]), {text: '2 MB of 1 MB. Largest: pages/03.png 1 MB · Slide 2 overflows', tone: 'error'});
});

test('bytes: whole kilobytes, then megabytes with one decimal; a byte is never shown as nothing', () => {
  assert.equal(formatBytes(0), '0 KB');
  assert.equal(formatBytes(1), '1 KB');
  assert.equal(formatBytes(1536), '2 KB');
  assert.equal(formatBytes(MB), '1 MB');
  assert.equal(formatBytes(1.25 * MB), '1.3 MB');
  assert.equal(formatAge(0), '0.0 s');
  assert.equal(formatAge(9.99), '9.9 s');
  assert.equal(formatAge(119), '119 s');
});

test('Build failed, Saved and a report’s tally', () => {
  assert.equal(failedLine(2, true), '2 errors. The preview shows the last good build.');
  assert.equal(failedLine(1, false), '1 error. There is no preview until they are fixed.');
  assert.equal(savedLine(new Date(2026, 8, 25, 12, 4)), 'Saved 12:04');
  assert.equal(savedLine(new Date(2026, 8, 25, 9, 30)), 'Saved 09:30');
  assert.equal(tally(0, 1), '0 errors · 1 warning');
  assert.equal(tally(1, 2), '1 error · 2 warnings');
});
