/**
 * M2.1, M2.3: previews and checks through the API (IC05, IC06, D09, D79, D80).
 *
 * Every dirty buffer — the manifest and each Markdown overlay — reaches the
 * preview, nothing reaches the disk or `dist/`; a stale base revision is a
 * 409; request ids must increase; a newer preview supersedes an older one
 * waiting or running, under controlled delays; generation ids increase and
 * only the newest few are kept; a failed build keeps the last good preview;
 * a start removes only generations no running session has marked for an
 * hour; and a page that lost its connection gets the whole snapshot back.
 */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {after, before, describe, test} from 'node:test';

import {PipelineError, runPipeline} from '../../src/build/pipeline.js';
import {PreviewGenerations, STALE_MS} from '../../src/server/generations.js';
import {revisionOf} from '../../src/server/index.js';
import {applicationRoot} from '../helpers/paths.js';
import {removeTemporaryFolders} from '../helpers/pieces.js';
import {body, call, json, openEvents, session, starterDeck, type TestSession} from './server-helpers.js';

after(removeTemporaryFolders);

const NOTES = 'assets/text/01-cover-notes.md';

type PreviewReply = {
  requestId: number;
  superseded?: true;
  report: {status: string; errors: number; findings: {rule: string; file: string; line: number | null}[]; targets: {target: unknown; file: string; lineStart: number; lineEnd: number}[]; outputWritten: boolean; outputReason: string};
  cursorTarget: unknown;
  generationId: string | null;
  generationURL: string | null;
};

function request(editor: TestSession, requestId: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const manifestText = readFileSync(join(editor.root, 'papeleria.yaml'), 'utf8');
  return {
    requestId,
    manifestPath: 'papeleria.yaml',
    manifestText,
    manifestBaseRevision: revisionOf(manifestText),
    overlays: [],
    cursor: {path: 'papeleria.yaml', line: 1, column: 1},
    ...overrides,
  };
}

async function previewOf(editor: TestSession, payload: Record<string, unknown>, route = '/api/preview'): Promise<PreviewReply> {
  const reply = await editor.api(route, {method: 'POST', ...body(payload)});
  assert.equal(reply.status, 200, reply.body);
  return json(reply) as unknown as PreviewReply;
}

function generations(root: string): string[] {
  return existsSync(join(root, '.papeleria', 'preview')) ? readdirSync(join(root, '.papeleria', 'preview')).sort() : [];
}

describe('previews', () => {
  let editor: TestSession;
  before(async () => {
    editor = await session(starterDeck('server-preview'));
  });
  after(() => editor.close());

  test('every dirty buffer is in the preview, and nothing reaches the disk or dist/', async () => {
    const manifest = readFileSync(join(editor.root, 'papeleria.yaml'), 'utf8');
    const notes = readFileSync(join(editor.root, NOTES), 'utf8');
    const title = /title: (.+)/.exec(manifest)![1]!;
    const edited = manifest.replace(`title: ${title}`, 'title: A title typed but not saved');
    const reply = await previewOf(
      editor,
      request(editor, 1, {
        manifestText: edited,
        overlays: [{path: NOTES, content: 'Notes typed but not saved.\n', baseRevision: revisionOf(notes)}],
        cursor: {path: NOTES, line: 1, column: 1},
      }),
    );
    assert.equal(reply.report.status, 'ok');
    assert.equal(reply.report.outputReason, 'preview_only');
    assert.equal(reply.report.outputWritten, false);
    assert.match(reply.generationId ?? '', /^[0-9a-z]+-[0-9a-f]{12}$/);
    assert.equal(reply.generationURL, `${editor.previewOrigin}/${reply.generationId}/index.html`);
    assert.deepEqual(reply.cursorTarget, {kind: 'slide', slide: 1}, 'the notes file belongs to slide 1');
    const page = await call(reply.generationURL!);
    assert.equal(page.status, 200);
    assert.match(page.body, /A title typed but not saved/);
    assert.match(page.body, /Notes typed but not saved\./);
    assert.equal(readFileSync(join(editor.root, 'papeleria.yaml'), 'utf8'), manifest);
    assert.equal(readFileSync(join(editor.root, NOTES), 'utf8'), notes);
    assert.ok(!existsSync(join(editor.root, 'dist')), 'a preview never writes dist/');
  });

  test('the preview origin serves the generation with its policy, and the page’s script carries the bridge the published one lacks', async () => {
    const reply = await previewOf(editor, request(editor, 2));
    const page = await call(reply.generationURL!);
    const policy = String(page.headers['content-security-policy']);
    assert.match(policy, new RegExp(`frame-ancestors ${editor.editorOrigin.replaceAll('.', '\\.')}(?:;|$)`));
    assert.match(policy, /connect-src 'none'/);
    assert.match(policy, /script-src 'self'(?:;|$)/);
    assert.match(policy, /form-action 'none'/);
    assert.match(page.body, /<script src="deck\.js" defer><\/script>/, 'the page is the published page');
    const script = await call(`${editor.previewOrigin}/${reply.generationId}/deck.js`);
    assert.equal(script.status, 200);
    assert.match(script.body, /papeleria-preview-goto/, 'the preview script carries the bridge');
    const published = readFileSync(join(applicationRoot, 'lib', 'clients', 'deck.js'), 'utf8');
    assert.doesNotMatch(published, /papeleria-preview|postMessage|preview-protocol/, 'the published deck.js carries no bridge');
    assert.equal(script.body.startsWith('/* Papeleria deck-preview client.'), true);
  });

  test('a request id that does not increase is refused with the last one', async () => {
    const reply = await editor.api('/api/preview', {method: 'POST', ...body(request(editor, 2))});
    assert.equal(reply.status, 409);
    assert.deepEqual([json(reply)['errorCode'], json(reply)['lastRequestId']], ['E_STALE_REQUEST', 2]);
  });

  test('a buffer whose base revision is no longer the disk’s is a 409 naming it and the revision there', async () => {
    const notes = readFileSync(join(editor.root, NOTES), 'utf8');
    const reply = await editor.api('/api/preview', {
      method: 'POST',
      ...body(request(editor, 3, {overlays: [{path: NOTES, content: 'x', baseRevision: revisionOf('an older version\n')}]})),
    });
    assert.equal(reply.status, 409);
    assert.deepEqual(json(reply)['conflicts'], [{path: NOTES, currentRevision: revisionOf(notes)}]);
    const check = await editor.api('/api/check', {
      method: 'POST',
      ...body(request(editor, 4, {manifestBaseRevision: revisionOf('not the manifest')})),
    });
    assert.equal(check.status, 409, 'a check is blocked the same way');
  });

  test('a failed preview reports its findings where they are, and the last good generation stays served', async () => {
    const good = await previewOf(editor, request(editor, 5));
    const manifest = readFileSync(join(editor.root, 'papeleria.yaml'), 'utf8');
    const lines = manifest.split('\n');
    const at = lines.findIndex((line) => line.startsWith('title:'));
    lines.splice(at + 1, 0, 'titel: a misspelled key');
    const stream = await openEvents(`${editor.editorOrigin}/api/events`, editor.headers());
    try {
      const failed = await previewOf(editor, request(editor, 6, {manifestText: lines.join('\n')}));
      assert.equal(failed.report.status, 'failed');
      assert.equal(failed.generationId, null);
      const finding = failed.report.findings.find((item) => item.rule === 'R09');
      assert.deepEqual([finding?.file, finding?.line], ['papeleria.yaml', at + 2], 'the unknown key at its own line');
      const event = await stream.next((item) => item.event === 'build-failed');
      assert.deepEqual([event.data['requestId'], event.data['errors']], [6, 1]);
      assert.equal((await call(good.generationURL!)).status, 200, 'the last good preview is still served');
    } finally {
      stream.close();
    }
  });

  test('a check uses the same buffers, keeps nothing and never writes dist/', async () => {
    const before_ = generations(editor.root);
    const manifest = readFileSync(join(editor.root, 'papeleria.yaml'), 'utf8');
    const reply = await previewOf(editor, request(editor, 7, {manifestText: manifest.replace(/status: \w+/, 'status: published')}), '/api/check');
    assert.equal(reply.report.outputReason, 'check_only');
    assert.equal(reply.generationId, undefined, 'a check has no generation');
    assert.deepEqual(generations(editor.root), before_);
    assert.ok(!existsSync(join(editor.root, 'dist')));
  });

  test('generation ids increase, and only the newest three are kept and served', async () => {
    const ids: string[] = [];
    const urls: string[] = [];
    for (let requestId = 10; requestId < 15; requestId += 1) {
      const reply = await previewOf(editor, request(editor, requestId));
      ids.push(reply.generationId!);
      urls.push(reply.generationURL!);
    }
    const time = (id: string): number => Number.parseInt(id.slice(0, id.indexOf('-')), 36);
    for (let index = 1; index < ids.length; index += 1) {
      assert.ok(time(ids[index]!) > time(ids[index - 1]!), `${ids[index]} follows ${ids[index - 1]}`);
    }
    assert.deepEqual(generations(editor.root), ids.slice(-3).sort());
    assert.equal((await call(urls[0]!)).status, 404, 'a retired generation is gone');
    assert.equal((await call(urls[4]!)).status, 200);
  });

  test('after a lost connection a page gets the whole snapshot back, and a new stream carries on from the last event id', async () => {
    const first = await openEvents(`${editor.editorOrigin}/api/events`, editor.headers());
    const hello = await first.next((event) => event.event === 'hello');
    editor.dropEventStreams();
    const piece = json(await editor.api('/api/piece'));
    assert.deepEqual(Object.keys(piece).sort(), [
      'files',
      'folder',
      'language',
      'lastEventId',
      'lastRequestId',
      'manifestLineEnding',
      'manifestPath',
      'manifestRevision',
      'manifestText',
      'previewOrigin',
      'schemas',
      'status',
      'template',
      'tool',
      'wordmark',
    ]);
    assert.equal(piece['lastRequestId'], 14);
    assert.equal(piece['manifestRevision'], revisionOf(readFileSync(join(editor.root, 'papeleria.yaml'))));
    assert.deepEqual(Object.keys(piece['schemas'] as object), ['deck', 'comic', 'document']);
    const second = await openEvents(`${editor.editorOrigin}/api/events`, editor.headers());
    const again = await second.next((event) => event.event === 'hello');
    assert.ok(Number(again.data['lastEventId']) >= Number(hello.data['lastEventId']));
    assert.equal(again.data['lastRequestId'], 14);
    first.close();
    second.close();
  });

  test('a withheld piece still previews (IC05), and dist/ stays absent', async () => {
    const manifest = readFileSync(join(editor.root, 'papeleria.yaml'), 'utf8');
    const reply = await previewOf(editor, request(editor, 20, {manifestText: manifest.replace(/status: \w+/, 'status: withheld')}));
    assert.notEqual(reply.generationId, null);
    assert.ok(!existsSync(join(editor.root, 'dist')));
  });
});

describe('superseded previews, under controlled delays', () => {
  test('a newer preview supersedes one waiting and one running; only the newest is built and announced', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: number[] = [];
    const editor = await session(starterDeck('server-supersede'), {
      hooks: {
        beforePreview: async (requestId) => {
          started.push(requestId);
          if (requestId === 1) {
            await held;
          }
        },
      },
    });
    const stream = await openEvents(`${editor.editorOrigin}/api/events`, editor.headers());
    try {
      const first = editor.api('/api/preview', {method: 'POST', ...body(request(editor, 1))});
      while (!started.includes(1)) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const second = editor.api('/api/preview', {method: 'POST', ...body(request(editor, 2))});
      await new Promise((resolve) => setTimeout(resolve, 50));
      const third = editor.api('/api/preview', {method: 'POST', ...body(request(editor, 3))});
      await new Promise((resolve) => setTimeout(resolve, 50));
      release();
      const replies = await Promise.all([first, second, third].map(async (reply) => json(await reply)));
      assert.deepEqual(replies[0], {requestId: 1, superseded: true}, 'aborted while running');
      assert.deepEqual(replies[1], {requestId: 2, superseded: true}, 'replaced while waiting');
      assert.equal(replies[2]!['requestId'], 3);
      assert.notEqual(replies[2]!['generationId'], null);
      assert.deepEqual(started, [1, 3], 'request 2 never ran');
      await stream.next((event) => event.event === 'preview-built');
      assert.deepEqual(
        stream.events.filter((event) => event.event === 'preview-built').map((event) => event.data['requestId']),
        [3],
      );
      assert.equal(generations(editor.root).length, 1, 'no superseded generation is kept');
    } finally {
      stream.close();
      await editor.close();
    }
  });

  test('stopping the session removes its generations', async () => {
    const editor = await session(starterDeck('server-stop'));
    await previewOf(editor, request(editor, 1));
    assert.equal(generations(editor.root).length, 1);
    await editor.close();
    assert.deepEqual(generations(editor.root), []);
  });
});

describe('generations other sessions left (D79)', () => {
  const HOUR = 60 * 60 * 1000;

  /** A generation folder as the pipeline leaves one: its id made at `madeAt`, its folder last marked at `markedAt`. */
  function generation(root: string, madeAt: number, markedAt: number): {id: string; directory: string} {
    const id = `${madeAt.toString(36)}-${randomBytes(6).toString('hex')}`;
    const directory = join(root, '.papeleria', 'preview', id);
    mkdirSync(directory, {recursive: true});
    writeFileSync(join(directory, 'index.html'), '<!doctype html><title>kept</title>\n');
    utimesSync(directory, new Date(markedAt), new Date(markedAt));
    return {id, directory};
  }

  test('a start removes only what no session has marked for an hour, however old a running session’s generation is', async () => {
    const root = starterDeck('generations-stale');
    const now = Date.now();
    // A session that has run for three hours: the generation it shows was made then, and it has marked it since.
    const running = new PreviewGenerations(root);
    const shown = generation(root, now - 3 * HOUR, now - 3 * HOUR);
    await running.add(shown.id, shown.directory);
    // A session that stopped without cleaning up two hours ago, and one that did so half an hour ago.
    const gone = generation(root, now - 3 * HOUR, now - 2 * HOUR);
    const recent = generation(root, now - 3 * HOUR, now - HOUR / 2);
    try {
      const starting = new PreviewGenerations(root);
      await starting.removeStale();
      assert.deepEqual(generations(root), [shown.id, recent.id].sort(), `${gone.id}, unmarked for two hours, is removed`);
      assert.ok(Date.now() - statSync(shown.directory).mtimeMs < STALE_MS, 'keeping a generation marks it');

      // Half an hour on, the running session has marked its generation again; the other leftover is now an hour and a half old.
      await running.mark(now + HOUR / 2);
      await new PreviewGenerations(root).removeStale(now + HOUR);
      assert.deepEqual(generations(root), [shown.id]);
    } finally {
      await running.removeAll();
    }
    assert.deepEqual(generations(root), [], 'stopping removes the session’s own');
  });

  test('a running session marks the generations it keeps on a timer, and stops when it stops', async () => {
    const root = starterDeck('generations-mark');
    const running = new PreviewGenerations(root, 20);
    const kept = generation(root, Date.now(), Date.now());
    await running.add(kept.id, kept.directory);
    const long = Date.now() - 2 * STALE_MS;
    utimesSync(kept.directory, new Date(long), new Date(long));
    const age = (directory: string): number => Date.now() - statSync(directory).mtimeMs;
    const deadline = Date.now() + 5_000;
    while (age(kept.directory) > STALE_MS) {
      assert.ok(Date.now() < deadline, 'the timer never marked the generation');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await running.removeAll();
    const leftover = generation(root, Date.now(), long);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(age(leftover.directory) > STALE_MS, 'a stopped session marks nothing');
  });
});

describe('the pipeline’s preview target and cancellation', () => {
  test('an aborted signal stops a run with E_CANCELLED and leaves no generation behind', async () => {
    const root = starterDeck('pipeline-cancel');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      runPipeline({root}, {kind: 'preview'}, {signal: controller.signal}),
      (error: unknown) => error instanceof PipelineError && error.code === 'E_CANCELLED',
    );
    assert.ok(!existsSync(join(root, '.papeleria', 'staging')) || readdirSync(join(root, '.papeleria', 'staging')).length === 0);
    assert.deepEqual(generations(root), []);
  });

  test('a preview measures and scans the published page, then keeps the page with the bridge', async () => {
    const root = starterDeck('pipeline-preview');
    const checked = await runPipeline({root}, {kind: 'check'});
    const previewed = await runPipeline({root}, {kind: 'preview'});
    assert.deepEqual(previewed.report.weight, checked.report.weight, 'the weight is the published page’s');
    assert.deepEqual(previewed.report.findings, checked.report.findings);
    assert.equal(previewed.report.outputReason, 'preview_only');
    const kept = previewed.preview!;
    assert.deepEqual(generations(root), [kept.generationId]);
    assert.ok(readFileSync(join(kept.directory, 'deck.js')).equals(readFileSync(join(applicationRoot, 'lib', 'clients', 'deck-preview.js'))));
    assert.ok(!existsSync(join(root, 'dist')));
    writeFileSync(join(root, 'papeleria.yaml'), 'schema: 1\ntemplate: deck\n');
    const failed = await runPipeline({root}, {kind: 'preview'});
    assert.equal(failed.preview, null, 'a report with errors keeps nothing');
    assert.deepEqual(generations(root), [kept.generationId]);
  });
});
