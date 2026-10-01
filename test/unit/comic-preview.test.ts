/**
 * M4.4 (D117): the pieces of the comic's Grid that need no browser: the
 * readout's words, and the protocol's `grid`, `pointer` and `pointerLeft`
 * (D174) shapes, validated and clamped both ways (IC06). The grid itself, the
 * pointer over a page and off it, and Follow's panel mark are
 * test/browser/editor-grid.test.ts.
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {POINTER_PROMPT, pointerLine} from '../../src/editor/status.js';
import {acceptToEditor, acceptToFrame, validateToEditor} from '../../templates/shared/preview-protocol.js';

const ID = '1-0123456789ab';

test('the readout: the page, then x and y in percent with at most one decimal, the form a box is written in', () => {
  assert.equal(pointerLine(2, 12.5, 40), 'Page 2 · x 12.5% · y 40%');
  assert.equal(pointerLine(1, 0, 100), 'Page 1 · x 0% · y 100%');
  assert.equal(pointerLine(8, 33.333, 66.666), 'Page 8 · x 33.3% · y 66.7%');
});

test('IC06: pointer carries a page and two percentages, each clamped; grid carries a boolean and nothing else', () => {
  assert.deepEqual(validateToEditor({type: 'pointer', generationId: ID, page: 3, x: 101.5, y: -0.1}), {type: 'pointer', generationId: ID, page: 3, x: 100, y: 0});
  for (const bad of [
    {type: 'pointer', generationId: ID, page: 0, x: 1, y: 1},
    {type: 'pointer', generationId: ID, page: 1.5, x: 1, y: 1},
    {type: 'pointer', generationId: ID, page: 1, x: Number.NaN, y: 1},
    {type: 'pointer', generationId: ID, page: 1, x: 1, y: '2'},
    {type: 'pointer', generationId: ID, page: 1, x: 1, y: 2, extra: true},
  ]) {
    assert.equal(validateToEditor(bad), null, JSON.stringify(bad));
  }
  const context = {origin: 'http://127.0.0.1:4000', source: {}, generationId: ID};
  assert.deepEqual(acceptToFrame({origin: context.origin, source: context.source, data: {type: 'grid', generationId: ID, on: true}}, context), {type: 'grid', generationId: ID, on: true});
  assert.equal(acceptToFrame({origin: context.origin, source: context.source, data: {type: 'grid', generationId: ID, on: 'yes'}}, context), null);
  assert.equal(acceptToFrame({origin: 'http://127.0.0.1:4001', source: context.source, data: {type: 'grid', generationId: ID, on: true}}, context), null, 'another origin');
});

test('D174: the pointer leaving the pages is pointerLeft, the generation and nothing else; a pointer always has its place', () => {
  assert.deepEqual(validateToEditor({type: 'pointerLeft', generationId: ID}), {type: 'pointerLeft', generationId: ID});
  assert.equal(POINTER_PROMPT, 'Point at a page', 'what the readout says again once the pointer has left');
  for (const bad of [
    {type: 'pointerLeft', generationId: ID, page: 1},
    {type: 'pointerLeft', generationId: ID, x: null, y: null},
    {type: 'pointerLeft', generationId: 'nope'},
    {type: 'pointerLeft'},
    {type: 'pointer', generationId: ID, page: null, x: null, y: null},
    {type: 'pointer', generationId: ID},
  ]) {
    assert.equal(validateToEditor(bad), null, JSON.stringify(bad));
  }
  const context = {origin: 'http://127.0.0.1:4000', source: {}, generationId: ID};
  assert.deepEqual(acceptToEditor({origin: context.origin, source: context.source, data: {type: 'pointerLeft', generationId: ID}}, context), {type: 'pointerLeft', generationId: ID});
  assert.equal(acceptToEditor({origin: context.origin, source: context.source, data: {type: 'pointerLeft', generationId: '2-0123456789ab'}}, context), null, 'another generation');
  assert.equal(acceptToFrame({origin: context.origin, source: context.source, data: {type: 'pointerLeft', generationId: ID}}, context), null, 'never a message to the frame');
});
