/**
 * M2.6: `papeleria serve`, in process (IC09, D87). A read-only preview of the
 * piece's saved files: a shell and one event stream on the serve origin, the
 * generations on a preview origin, no token, no write API, the last good
 * generation kept after a failure, and never a `dist/`.
 */
import assert from 'node:assert/strict';
import {existsSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {after, test} from 'node:test';

import {startServe, type ServeSession} from '../../src/server/index.js';
import {removeTemporaryFolders} from '../helpers/pieces.js';
import {call, openEvents, starterDeck, type EventStream} from './server-helpers.js';

after(removeTemporaryFolders);

type Started = ServeSession & {readonly root: string; readonly logs: string[]};

async function serve(label: string, edit?: (manifest: string) => string): Promise<Started> {
  const root = starterDeck(label);
  if (edit !== undefined) {
    const manifest = join(root, 'papeleria.yaml');
    writeFileSync(manifest, edit(readFileSync(manifest, 'utf8')));
  }
  const logs: string[] = [];
  const session = await startServe({root, label, log: (line) => logs.push(line)});
  return {...session, root, logs};
}

function generationsLeft(root: string): string[] {
  const folder = join(root, '.papeleria', 'preview');
  return existsSync(folder) ? readdirSync(folder) : [];
}

async function shownNow(stream: EventStream): Promise<{generationId: string; generationURL: string}> {
  const hello = await stream.next((event) => event.event === 'hello');
  const shown = hello.data['shown'];
  assert.ok(typeof shown === 'object' && shown !== null, 'a stream opened after the first build is told what is shown');
  return shown as {generationId: string; generationURL: string};
}

test('serve offers its shell and one event stream, and nothing that writes', async () => {
  const session = await serve('serve-surface');
  try {
    await session.settled();
    const page = await call(`${session.origin}/`);
    assert.equal(page.status, 200);
    assert.match(String(page.headers['content-type']), /^text\/html/);
    const policy = String(page.headers['content-security-policy']);
    assert.match(policy, new RegExp(`frame-src ${session.previewOrigin.replace(/[.]/g, '\\.')}(;|$)`));
    assert.match(policy, /connect-src 'self'/);
    assert.match(policy, /frame-ancestors 'none'/);
    assert.doesNotMatch(page.body, /#token=|x-papeleria-token|[0-9a-f]{64}/i, 'the shell carries no token');
    for (const path of ['/serve.js', '/serve.css', '/theme/css/tokens.css']) {
      assert.equal((await call(`${session.origin}${path}`)).status, 200, path);
    }
    for (const path of ['/api/piece', '/api/file?path=papeleria.yaml', '/api/preview', '/editor.js', '/papeleria.yaml', '/assets/text/01-cover-notes.md', '/theme/css/site.css']) {
      assert.equal((await call(`${session.origin}${path}`)).status, 404, path);
    }
    for (const method of ['PUT', 'POST', 'DELETE', 'PATCH']) {
      // Each 405 names what the address does take (D78).
      for (const [path, headers, allow] of [
        ['/', {}, 'GET, HEAD'],
        ['/events', {}, 'GET'],
        ['/api/preview', {origin: session.origin}, 'GET, HEAD'],
      ] as const) {
        const refused = await call(`${session.origin}${path}`, {method, headers});
        assert.equal(refused.status, 405, `${method} ${path}`);
        assert.equal(refused.headers['allow'], allow, `${method} ${path}`);
      }
    }
    assert.equal((await call(`${session.origin}/events`, {method: 'OPTIONS', headers: {origin: 'http://evil.example', 'access-control-request-method': 'GET'}})).status, 403);
    // Every reply of the shell's origin carries the headers every Papeleria reply does (D78). The stream answered 200, or openEvents would have refused it.
    const stream = await openEvents(`${session.origin}/events`, {});
    stream.close();
    for (const [what, reply, status] of [
      ['the shell', page, 200],
      ['its script', await call(`${session.origin}/serve.js`), 200],
      ['the event stream', {status: 200, headers: stream.headers}, 200],
      ['an unknown address', await call(`${session.origin}/papeleria.yaml`), 404],
      ['a method it does not take', await call(`${session.origin}/`, {method: 'POST'}), 405],
      ['another page', await call(`${session.origin}/events`, {headers: {origin: 'http://evil.example'}}), 403],
    ] as const) {
      assert.equal(reply.status, status, what);
      assert.deepEqual(
        ['x-content-type-options', 'referrer-policy', 'cross-origin-resource-policy', 'cache-control'].map((name) => reply.headers[name]),
        ['nosniff', 'no-referrer', 'same-origin', 'no-store'],
        what,
      );
    }
  } finally {
    await session.close();
  }
});

test('serve checks the exact Host, and refuses its event stream to another page', async () => {
  const session = await serve('serve-trust');
  try {
    const port = new URL(session.origin).port;
    for (const host of [`localhost:${port}`, `127.0.0.1`, `evil.example`, `127.0.0.1:${Number(port) + 1}`]) {
      assert.equal((await call(`${session.origin}/`, {headers: {host}})).status, 403, host);
      assert.equal((await call(`${session.origin}/events`, {headers: {host}})).status, 403, host);
    }
    for (const origin of ['http://evil.example', session.previewOrigin, `http://localhost:${port}`, 'null']) {
      const refused = await call(`${session.origin}/events`, {headers: {origin}});
      assert.equal(refused.status, 403, origin);
      assert.equal(refused.headers['access-control-allow-origin'], undefined);
    }
    const own = await openEvents(`${session.origin}/events`, {origin: session.origin});
    await own.next((event) => event.event === 'hello');
    own.close();
    const direct = await openEvents(`${session.origin}/events`, {});
    await direct.next((event) => event.event === 'hello');
    direct.close();
  } finally {
    await session.close();
  }
});

test('the preview origin serves generations for serve’s shell to frame, and nothing else', async () => {
  const session = await serve('serve-preview-origin');
  try {
    await session.settled();
    const stream = await openEvents(`${session.origin}/events`, {});
    const shown = await shownNow(stream);
    stream.close();
    assert.ok(shown.generationURL.startsWith(`${session.previewOrigin}/${shown.generationId}/`));
    const page = await call(shown.generationURL);
    assert.equal(page.status, 200);
    assert.match(String(page.headers['content-security-policy']), new RegExp(`frame-ancestors ${session.origin.replace(/[.]/g, '\\.')}(;|$)`));
    assert.match(page.body, /<script src="deck\.js" defer><\/script>/);
    const script = await call(`${session.previewOrigin}/${shown.generationId}/deck.js`);
    assert.match(script.body, /papeleria-preview-goto/, 'the preview page carries the bridge');
    for (const method of ['PUT', 'POST', 'DELETE']) {
      assert.equal((await call(shown.generationURL, {method})).status, 405, method);
    }
    assert.equal((await call(`${session.previewOrigin}/`)).status, 404);
    assert.equal((await call(`${session.previewOrigin}/events`)).status, 404);
    // Only the shell may frame the page, and only the page itself or the shell may ask for its files (D78).
    for (const origin of [session.origin, session.previewOrigin]) {
      assert.equal((await call(shown.generationURL, {headers: {origin}})).status, 200, origin);
    }
    for (const origin of ['http://evil.example', 'null']) {
      assert.equal((await call(shown.generationURL, {headers: {origin}})).status, 403, origin);
    }
  } finally {
    await session.close();
  }
});

test('serve prints a build\'s report only once the preview it names is the one a page is shown', async () => {
  // The terminal's "Previewed" line came before the generation was the one shown, so a page that connected
  // on seeing it could be told that nothing was shown yet (an intermittent failure of server-cli.test.ts).
  let reached!: () => void;
  const atHook = new Promise<void>((resolve) => (reached = resolve));
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const root = starterDeck('serve-report-order');
  const logs: string[] = [];
  const session = await startServe({
    root,
    label: 'serve-report-order',
    log: (line) => logs.push(line),
    hooks: {
      beforeShow: async () => {
        reached();
        await held;
      },
    },
  });
  try {
    await atHook;
    assert.ok(!logs.some((line) => line.startsWith('Previewed ')), 'no report while the preview is not yet the one shown');
    const early = await openEvents(`${session.origin}/events`, {});
    assert.equal((await early.next((event) => event.event === 'hello')).data['shown'], null);
    early.close();
    release();
    await session.settled();
    assert.ok(logs.some((line) => line.startsWith('Previewed ')), logs.join('\n'));
    const stream = await openEvents(`${session.origin}/events`, {});
    await shownNow(stream);
    stream.close();
  } finally {
    release();
    await session.close();
  }
});

test('serve rebuilds on a saved change, keeps the last good generation after a failure, and never writes dist/', async () => {
  const session = await serve('serve-rebuild');
  try {
    await session.settled();
    const stream = await openEvents(`${session.origin}/events`, {});
    const first = await shownNow(stream);

    const manifest = join(session.root, 'papeleria.yaml');
    const original = readFileSync(manifest, 'utf8');
    writeFileSync(manifest, original.replace('layout: statement', 'layout: poster'));
    const failed = await stream.next((event) => event.event === 'build-failed');
    assert.ok(Number(failed.data['errors']) >= 1);
    await session.settled();
    assert.ok(session.logs.includes('Still showing the last good build.'), session.logs.join('\n'));
    assert.ok(session.logs.some((line) => /papeleria\.yaml:[0-9]+:[0-9]+ error R09: /.test(line)));
    assert.equal((await call(first.generationURL)).status, 200, 'the last good generation is still served');
    assert.equal(stream.events.filter((event) => event.event === 'reload').length, 0, 'no reload for a failed build');

    writeFileSync(manifest, original.replace('Care should be visible in the work.', 'Care should be visible everywhere.'));
    const reload = await stream.next((event) => event.event === 'reload');
    assert.notEqual(reload.data['generationId'], first.generationId);
    const page = await call(String(reload.data['generationURL']));
    assert.equal(page.status, 200);
    assert.match(page.body, /Care should be visible everywhere\./);
    stream.close();
    assert.equal(existsSync(join(session.root, 'dist')), false);
  } finally {
    await session.close();
  }
  assert.deepEqual(generationsLeft(session.root), [], 'stopping removes every generation');
});

test('a withheld piece previews in serve, and dist/ stays absent', async () => {
  const session = await serve('serve-withheld', (manifest) => manifest.replace('status: draft', 'status: withheld'));
  try {
    await session.settled();
    const stream = await openEvents(`${session.origin}/events`, {});
    const shown = await shownNow(stream);
    stream.close();
    assert.equal((await call(shown.generationURL)).status, 200);
    assert.ok(session.logs.some((line) => /^Previewed serve-withheld · /m.test(line)), session.logs.join('\n'));
    assert.equal(existsSync(join(session.root, 'dist')), false);
  } finally {
    await session.close();
  }
});

test('a piece that fails from the start shows nothing yet, and says so', async () => {
  const session = await serve('serve-broken', (manifest) => manifest.replace('layout: statement', 'layout: poster'));
  try {
    await session.settled();
    const stream = await openEvents(`${session.origin}/events`, {});
    const hello = await stream.next((event) => event.event === 'hello');
    stream.close();
    assert.equal(hello.data['shown'], null);
    assert.ok(session.logs.includes('Nothing to show until the errors are fixed.'), session.logs.join('\n'));
    assert.deepEqual(generationsLeft(session.root), []);
  } finally {
    await session.close();
  }
});
