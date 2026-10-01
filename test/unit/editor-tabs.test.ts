/**
 * M2.2: a tab's answer to its file's revision on disk (IC05, D81), the pure
 * half of the editor's tabs: a clean buffer takes the disk's text, unsaved
 * work becomes a conflict and is never overwritten, and a conflict follows
 * the disk until the author chooses — or until the disk holds the tab's base
 * again (W5R-14).
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {diskOutcome, type TabRevisionState} from '../../src/editor/tab-state.js';

const BASE = 'a'.repeat(64);
const THEIRS = 'b'.repeat(64);
const AGAIN = 'c'.repeat(64);

test('the disk at the base changes nothing; another revision reloads a clean tab and makes unsaved work a conflict', () => {
  const clean: TabRevisionState = {baseRevision: BASE, conflict: null, dirty: false};
  const dirty: TabRevisionState = {...clean, dirty: true};
  assert.equal(diskOutcome(clean, BASE), 'unchanged');
  assert.equal(diskOutcome(dirty, BASE), 'unchanged');
  assert.equal(diskOutcome(clean, THEIRS), 'reload');
  assert.equal(diskOutcome(dirty, THEIRS), 'conflict');
  assert.equal(diskOutcome(clean, null), 'conflict', 'a removed file is said, never reloaded: the editor never creates files');
  assert.equal(diskOutcome(dirty, null), 'conflict');
});

test('a conflict follows the disk, and ends when the disk holds the tab’s base again (W5R-14)', () => {
  for (const [what, conflict] of [
    ['changed', {currentRevision: THEIRS}],
    ['removed', {currentRevision: null}],
  ] as const) {
    for (const dirty of [true, false]) {
      const tab: TabRevisionState = {baseRevision: BASE, conflict, dirty};
      const where = `${what} on disk, ${dirty ? 'unsaved work' : 'a clean buffer'}`;
      assert.equal(diskOutcome(tab, AGAIN), 'conflict', `${where}, then another revision`);
      assert.equal(diskOutcome(tab, null), 'conflict', `${where}, then removed`);
      assert.equal(diskOutcome(tab, BASE), 'resolved', `${where}, then back as the tab loaded it`);
    }
  }
});

test('typed, written elsewhere, then written back: the conflict ends and the next save matches the disk (W5R-14)', () => {
  const typed: TabRevisionState = {baseRevision: BASE, conflict: null, dirty: true};
  assert.equal(diskOutcome(typed, THEIRS), 'conflict');
  const conflicted: TabRevisionState = {...typed, conflict: {currentRevision: THEIRS}};
  // Left conflicted, Keep mine would adopt THEIRS, which the disk no longer holds, and the next save would be a 409;
  // Reload would throw the buffer away for nothing. Resolved, the buffer stays and its save expects BASE, the disk's.
  assert.equal(diskOutcome(conflicted, BASE), 'resolved');
});
