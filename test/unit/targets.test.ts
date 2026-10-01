/**
 * M1.7 / IC06: the typed source targets the report carries and the editor
 * follows the cursor with (M2.3).
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {createMemoryLoaders, readPiece, type DeckPiece} from '../../src/core/index.js';
import {deckTargets, lastLine, targetAt} from '../../src/build/targets.js';

const MANIFEST = [
  'schema: 1', //                                  1
  'template: deck', //                             2
  'title: Targets', //                             3
  'slides:', //                                    4
  '  - layout: cover', //                          5
  '    title: One', //                             6
  '    notes: assets/text/notes.md', //            7
  '  - layout: two', //                            8
  '    title: Two', //                             9
  '    notes: assets/text/notes.md', //           10
  '    columns:', //                              11
  '      - {heading: A, text: assets/text/a.md}', // 12
  '      - {heading: B, text: Inline}', //        13
  '', //                                          14
].join('\n');

async function deck(): Promise<DeckPiece> {
  const {piece, findings} = await readPiece({
    loaders: createMemoryLoaders({
      'papeleria.yaml': MANIFEST,
      'assets/text/notes.md': 'First\n\nThird line\n',
      'assets/text/a.md': 'Only line',
    }),
  });
  assert.deepEqual(findings, []);
  return piece as DeckPiece;
}

test('a deck has each slide’s manifest lines, then every text file the slide reads, once per slide', async () => {
  assert.deepEqual(deckTargets(await deck()), [
    {target: {kind: 'slide', slide: 1}, file: 'papeleria.yaml', lineStart: 5, lineEnd: 7},
    {target: {kind: 'slide', slide: 1}, file: 'assets/text/notes.md', lineStart: 1, lineEnd: 3},
    {target: {kind: 'slide', slide: 2}, file: 'papeleria.yaml', lineStart: 8, lineEnd: 13},
    {target: {kind: 'slide', slide: 2}, file: 'assets/text/notes.md', lineStart: 1, lineEnd: 3},
    {target: {kind: 'slide', slide: 2}, file: 'assets/text/a.md', lineStart: 1, lineEnd: 1},
  ]);
});

test('the target at a position is the narrowest range that holds it, the first of equals, or none', async () => {
  const targets = deckTargets(await deck());
  assert.deepEqual(targetAt(targets, 'papeleria.yaml', 6), {kind: 'slide', slide: 1});
  assert.deepEqual(targetAt(targets, 'papeleria.yaml', 12), {kind: 'slide', slide: 2});
  assert.equal(targetAt(targets, 'papeleria.yaml', 2), null, 'the deck’s own lines produce no slide');
  assert.deepEqual(targetAt(targets, 'assets/text/notes.md', 2), {kind: 'slide', slide: 1}, 'a file two slides share: the first');
  assert.deepEqual(targetAt(targets, 'assets/text/a.md', 1), {kind: 'slide', slide: 2});
  assert.equal(targetAt(targets, 'assets/text/other.md', 1), null);
  const nested = [
    {target: {kind: 'section', slug: 'outer'} as const, file: 'f', lineStart: 1, lineEnd: 20},
    {target: {kind: 'section', slug: 'inner'} as const, file: 'f', lineStart: 5, lineEnd: 8},
  ];
  assert.deepEqual(targetAt(nested, 'f', 6), {kind: 'section', slug: 'inner'});
  assert.deepEqual(targetAt(nested, 'f', 9), {kind: 'section', slug: 'outer'});
});

test('a text’s last line: every line break counts, a final one opens no line, and an empty text has line 1', () => {
  assert.equal(lastLine(''), 1);
  assert.equal(lastLine('one'), 1);
  assert.equal(lastLine('one\n'), 1);
  assert.equal(lastLine('one\ntwo'), 2);
  assert.equal(lastLine('one\r\ntwo\rthree\n'), 3);
  assert.equal(lastLine('\n\n'), 2);
});
