/**
 * M2.1, M2.3: the preview protocol's pure half (IC06, D83) — what the editor
 * and the bridge accept from each other, and the targets the cursor follows.
 * The window checks run in test/integration/server-security.test.ts and, in
 * real frames, in test/browser/preview-bridge.test.ts.
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {targetAt as buildTargetAt, type SourceTarget} from '../../src/build/targets.js';
import {
  GENERATION_ID_PATTERN,
  MESSAGE_LIMITS,
  sameTarget,
  targetAt,
  targetFragment,
  validateTarget,
  validateToEditor,
  validateToFrame,
} from '../../templates/shared/preview-protocol.js';

const ID = 'muh985gl-0aecd9798909';

test('the generation id pattern is the one write.ts makes, and nothing that could leave its folder', () => {
  assert.match(ID, GENERATION_ID_PATTERN);
  for (const bad of ['', '..', 'muh985gl', 'muh985gl-0aecd979890', 'MUH985GL-0aecd9798909', 'muh985gl-0aecd9798909/..', 'muh985gl-0aecd9798909x', '../muh985gl-0aecd9798909']) {
    assert.doesNotMatch(bad, GENERATION_ID_PATTERN, bad);
  }
});

test('targets are validated by kind, with whole positive numbers and a bounded slug', () => {
  assert.deepEqual(validateTarget({kind: 'slide', slide: 3}), {kind: 'slide', slide: 3});
  assert.deepEqual(validateTarget({kind: 'panel', page: 2, panel: 4}), {kind: 'panel', page: 2, panel: 4});
  assert.deepEqual(validateTarget({kind: 'section', slug: 'the-basis'}), {kind: 'section', slug: 'the-basis'});
  for (const bad of [
    null,
    [],
    {kind: 'slide'},
    {kind: 'slide', slide: 0},
    {kind: 'slide', slide: 1.5},
    {kind: 'slide', slide: Number.NaN},
    {kind: 'slide', slide: '3'},
    {kind: 'slide', slide: MESSAGE_LIMITS.indexMax + 1},
    {kind: 'slide', slide: 3, extra: true},
    {kind: 'page', page: -1},
    {kind: 'section', slug: ''},
    {kind: 'section', slug: 'x'.repeat(MESSAGE_LIMITS.textMax + 1)},
    {kind: 'unknown', slide: 1},
  ]) {
    assert.equal(validateTarget(bad), null, JSON.stringify(bad));
  }
});

test('messages to the frame have exactly IC06’s shapes; scroll positions are clamped', () => {
  assert.deepEqual(validateToFrame({type: 'goto', generationId: ID, target: {kind: 'slide', slide: 2}}), {
    type: 'goto',
    generationId: ID,
    target: {kind: 'slide', slide: 2},
  });
  assert.deepEqual(validateToFrame({type: 'grid', generationId: ID, on: true}), {type: 'grid', generationId: ID, on: true});
  assert.deepEqual(validateToFrame({type: 'restoreScroll', generationId: ID, y: -5}), {type: 'restoreScroll', generationId: ID, y: 0});
  assert.deepEqual(validateToFrame({type: 'restoreScroll', generationId: ID, y: 1e12}), {type: 'restoreScroll', generationId: ID, y: MESSAGE_LIMITS.scrollMax});
  for (const bad of [
    {type: 'goto', generationId: ID, target: {kind: 'slide', slide: 2}, extra: 1},
    {type: 'goto', generationId: 'nope', target: {kind: 'slide', slide: 2}},
    {type: 'grid', generationId: ID, on: 'yes'},
    {type: 'restoreScroll', generationId: ID, y: Number.POSITIVE_INFINITY},
    {type: 'ready', generationId: ID, hash: ''},
    {type: 'navigate', generationId: ID, url: 'https://example.com'},
    Object.assign(Object.create({inherited: true}) as object, {type: 'grid', generationId: ID, on: true}),
    'goto',
    null,
  ]) {
    assert.equal(validateToFrame(bad), null, JSON.stringify(bad));
  }
});

test('messages to the editor have exactly IC06’s shapes; a pointer is a percentage and a hash is a fragment', () => {
  assert.deepEqual(validateToEditor({type: 'ready', generationId: ID, hash: '#slide-4'}), {type: 'ready', generationId: ID, hash: '#slide-4'});
  assert.deepEqual(validateToEditor({type: 'ready', generationId: ID, hash: ''}), {type: 'ready', generationId: ID, hash: ''});
  assert.deepEqual(validateToEditor({type: 'pointer', generationId: ID, page: 1, x: 120, y: -3}), {type: 'pointer', generationId: ID, page: 1, x: 100, y: 0});
  assert.deepEqual(validateToEditor({type: 'returnFocus', generationId: ID}), {type: 'returnFocus', generationId: ID});
  for (const bad of [
    {type: 'ready', generationId: ID, hash: 'slide-4'},
    {type: 'ready', generationId: ID, hash: `#${'x'.repeat(MESSAGE_LIMITS.textMax)}`},
    {type: 'ready', generationId: ID},
    {type: 'scroll', generationId: ID, y: '10'},
    {type: 'returnFocus', generationId: ID, token: 'abc'},
    {type: 'goto', generationId: ID, target: {kind: 'slide', slide: 1}},
  ]) {
    assert.equal(validateToEditor(bad), null, JSON.stringify(bad));
  }
});

test('D174: overflow carries a deck’s slide numbers, increasing, each once, in a plain array and nothing else', () => {
  assert.deepEqual(validateToEditor({type: 'overflow', generationId: ID, slides: [2, 5, 9]}), {type: 'overflow', generationId: ID, slides: [2, 5, 9]});
  assert.deepEqual(validateToEditor({type: 'overflow', generationId: ID, slides: []}), {type: 'overflow', generationId: ID, slides: []}, 'none overflows: said, not left unsaid');
  const every = Array.from({length: MESSAGE_LIMITS.slidesMax}, (_, index) => index + 1);
  assert.equal((validateToEditor({type: 'overflow', generationId: ID, slides: every}) as {slides: readonly number[]} | null)?.slides.length, MESSAGE_LIMITS.slidesMax);
  const accepted = validateToEditor({type: 'overflow', generationId: ID, slides: [3]}) as {slides: readonly number[]};
  assert.ok(Object.isFrozen(accepted.slides), 'a frozen copy');
  const holed = [1, 2, 3];
  delete holed[1];
  const keyed = Object.assign([1, 2], {extra: 3});
  for (const bad of [
    {type: 'overflow', generationId: ID},
    {type: 'overflow', generationId: ID, slides: [2], extra: true},
    {type: 'overflow', generationId: 'nope', slides: [2]},
    {type: 'overflow', generationId: ID, slides: '2'},
    {type: 'overflow', generationId: ID, slides: {0: 2, length: 1}},
    {type: 'overflow', generationId: ID, slides: [0]},
    {type: 'overflow', generationId: ID, slides: [2.5]},
    {type: 'overflow', generationId: ID, slides: ['2']},
    {type: 'overflow', generationId: ID, slides: [Number.NaN]},
    {type: 'overflow', generationId: ID, slides: [MESSAGE_LIMITS.indexMax + 1]},
    {type: 'overflow', generationId: ID, slides: [5, 2]},
    {type: 'overflow', generationId: ID, slides: [2, 2]},
    {type: 'overflow', generationId: ID, slides: holed},
    {type: 'overflow', generationId: ID, slides: keyed},
    {type: 'overflow', generationId: ID, slides: [...every, MESSAGE_LIMITS.slidesMax + 1]},
  ]) {
    assert.equal(validateToEditor(bad), null, JSON.stringify(bad));
  }
  assert.equal(validateToFrame({type: 'overflow', generationId: ID, slides: [2]}), null, 'never a message to the frame');
});

test('a target’s fragment is the id the built page gives it', () => {
  assert.equal(targetFragment({kind: 'slide', slide: 3}), '#slide-3');
  assert.equal(targetFragment({kind: 'page', page: 4}), '#page-4');
  assert.equal(targetFragment({kind: 'panel', page: 4, panel: 2}), '#page-4-panel-2');
  assert.equal(targetFragment({kind: 'section', slug: 'año-2026'}), '#a%C3%B1o-2026');
  assert.equal(sameTarget({kind: 'slide', slide: 2}, {kind: 'slide', slide: 2}), true);
  assert.equal(sameTarget({kind: 'slide', slide: 2}, {kind: 'page', page: 2}), false);
  assert.equal(sameTarget({kind: 'slide', slide: 2}, null), false);
});

test('the browser’s targetAt answers exactly as the build’s', () => {
  const targets: SourceTarget[] = [
    {target: {kind: 'slide', slide: 1}, file: 'papeleria.yaml', lineStart: 5, lineEnd: 7},
    {target: {kind: 'slide', slide: 1}, file: 'assets/text/notes.md', lineStart: 1, lineEnd: 3},
    {target: {kind: 'slide', slide: 2}, file: 'papeleria.yaml', lineStart: 8, lineEnd: 13},
    {target: {kind: 'slide', slide: 2}, file: 'assets/text/notes.md', lineStart: 1, lineEnd: 3},
    {target: {kind: 'slide', slide: 3}, file: 'papeleria.yaml', lineStart: 10, lineEnd: 11},
  ];
  for (const file of ['papeleria.yaml', 'assets/text/notes.md', 'assets/text/other.md']) {
    for (let line = 0; line <= 15; line += 1) {
      assert.deepEqual(targetAt(targets, file, line), buildTargetAt(targets, file, line), `${file}:${line}`);
    }
  }
});
