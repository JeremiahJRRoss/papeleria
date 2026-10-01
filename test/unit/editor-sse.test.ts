/**
 * M2.1: the editor's reader of its event stream (IC06, D80). The editor reads
 * the stream with `fetch`, so the token travels in a header, and parses the
 * text/event-stream format itself; chunks can split anywhere.
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {SseParser, type ServerEvent} from '../../src/editor/sse.js';

const STREAM = ': papeleria\n\nid: 0\nevent: hello\ndata: {"lastEventId":0}\n\nid: 1\nevent: preview-built\ndata: {"requestId":1}\n\n: keep-alive\n\n';

const EXPECTED: ServerEvent[] = [
  {id: '0', event: 'hello', data: '{"lastEventId":0}'},
  {id: '1', event: 'preview-built', data: '{"requestId":1}'},
];

test('events are read whole, and comments and blank lines alone make none', () => {
  assert.deepEqual(new SseParser().push(STREAM), EXPECTED);
});

test('a stream split at every position gives the same events', () => {
  for (let cut = 0; cut <= STREAM.length; cut += 1) {
    const parser = new SseParser();
    assert.deepEqual([...parser.push(STREAM.slice(0, cut)), ...parser.push(STREAM.slice(cut))], EXPECTED, `cut at ${cut}`);
  }
  const parser = new SseParser();
  assert.deepEqual([...STREAM].flatMap((character) => parser.push(character)), EXPECTED, 'one character at a time');
});

test('CR, LF and CRLF all end a line, even when a CRLF is split between chunks', () => {
  const crlf = STREAM.replaceAll('\n', '\r\n');
  const parser = new SseParser();
  const cut = crlf.indexOf('\r\n') + 1;
  assert.deepEqual([...parser.push(crlf.slice(0, cut)), ...parser.push(crlf.slice(cut))], EXPECTED);
  assert.deepEqual(new SseParser().push(STREAM.replaceAll('\n', '\r')), EXPECTED);
});

test('data lines join with a line break; an unnamed event is a message; the id carries over', () => {
  assert.deepEqual(new SseParser().push('id: 7\ndata: one\ndata: two\n\ndata:three\n\n'), [
    {id: '7', event: 'message', data: 'one\ntwo'},
    {id: '7', event: 'message', data: 'three'},
  ]);
});

test('an id holding NUL is ignored, and unknown fields and retry mean nothing', () => {
  assert.deepEqual(new SseParser().push('id: 3\n\nid: a\u0000b\nretry: 10\nfoo: bar\nevent: x\ndata\n\n'), [
    {id: '3', event: 'message', data: ''},
    {id: '3', event: 'x', data: ''},
  ]);
});
