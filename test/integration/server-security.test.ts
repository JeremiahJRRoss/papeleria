/**
 * M2.1: the local server's trust boundary (IC06, D13, D78; acceptance matrix,
 * "Server trust/session failures").
 *
 * Every refusal is an HTTP status with an error code, never a finding. The
 * requests are raw, so a test can send what a browser never would: a forged
 * `Host`, a foreign `Origin`, no token, a wrong one, a preflight, a path that
 * walks out of the piece, a body over each limit. The `postMessage` checks are
 * the pure functions both ends of the preview run, tested here without a DOM;
 * the same cases go through a real frame and editor under `test/browser/`.
 */
import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {after, before, describe, test} from 'node:test';

import {FIRST_LAUNCH_LIFETIME_MS, RESUME_TOKEN_LIMIT, revisionOf, type LaunchReason} from '../../src/server/index.js';
import {
  acceptToEditor,
  acceptToFrame,
  MESSAGE_LIMITS,
  validateTarget,
  validateToEditor,
  validateToFrame,
} from '../../templates/shared/preview-protocol.js';
import {removeTemporaryFolders, temporaryFolder} from '../helpers/pieces.js';
import {body, call, json, openEvents, rawCall, session, starterDeck, type Reply, type TestSession} from './server-helpers.js';

after(removeTemporaryFolders);

const API = ['/api/piece', '/api/file?path=papeleria.yaml', '/api/events'];
const GENERATION = 'mg1a2b3c-0123456789ab';

describe('the editor origin', () => {
  let editor: TestSession;
  let manifestRevision: string;
  let outside: string;

  before(async () => {
    const root = starterDeck('server-security');
    outside = temporaryFolder('outside');
    writeFileSync(join(outside, 'secret.md'), 'a secret outside the piece\n');
    mkdirSync(join(outside, 'folder'));
    writeFileSync(join(outside, 'folder', 'inside.md'), 'also outside\n');
    symlinkSync(join(outside, 'secret.md'), join(root, 'assets', 'text', 'link.md'));
    symlinkSync(join(outside, 'folder'), join(root, 'assets', 'text', 'linked'));
    writeFileSync(join(root, 'assets', 'text', '.hidden.md'), 'hidden\n');
    mkdirSync(join(root, 'brand'));
    writeFileSync(join(root, 'brand', 'owner.md'), 'owner\n');
    manifestRevision = revisionOf(readFileSync(join(root, 'papeleria.yaml')));
    editor = await session(root);
  });

  after(() => editor.close());

  const preview = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    requestId: 1,
    manifestPath: 'papeleria.yaml',
    manifestText: readFileSync(join(editor.root, 'papeleria.yaml'), 'utf8'),
    manifestBaseRevision: manifestRevision,
    overlays: [],
    cursor: {path: 'papeleria.yaml', line: 1, column: 1},
    ...overrides,
  });

  /** A request id above every one the session has taken. */
  const nextRequestId = async (): Promise<number> => Number(json(await editor.api('/api/piece'))['lastRequestId']) + 1;

  test('the token is 256 random bits, and the API refuses a missing or wrong one with 401', async () => {
    assert.match(editor.token, /^[0-9a-f]{64}$/);
    for (const path of API) {
      const missing = await call(`${editor.editorOrigin}${path}`);
      assert.equal(missing.status, 401, path);
      assert.equal(json(missing)['errorCode'], 'E_TOKEN');
      const wrong = await call(`${editor.editorOrigin}${path}`, {headers: {'x-papeleria-token': 'f'.repeat(64)}});
      assert.equal(wrong.status, 401, path);
      const short = await call(`${editor.editorOrigin}${path}`, {headers: {'x-papeleria-token': editor.token.slice(1)}});
      assert.equal(short.status, 401, path);
    }
    const right = await editor.api('/api/piece');
    assert.equal(right.status, 200);
  });

  test('a forged Host is refused on every route, and so is a name for the loopback address', async () => {
    const port = new URL(editor.editorOrigin).port;
    for (const host of [`localhost:${port}`, `127.0.0.1:${Number(port) + 1}`, 'evil.example', `127.0.0.1`, `[::1]:${port}`, `127.0.0.1:${port}.evil.example`]) {
      for (const path of ['/', ...API]) {
        const reply = await call(`${editor.editorOrigin}${path}`, {headers: {...editor.headers(), host}});
        assert.equal(reply.status, 403, `${host} ${path}`);
        assert.equal(json(reply)['errorCode'], 'E_HOST');
      }
    }
  });

  test('a request with no Host at all is refused on both origins (IC06’s exact Host)', async () => {
    const token = `X-Papeleria-Token: ${editor.token}\r\nOrigin: ${editor.editorOrigin}\r\n`;
    for (const [origin, path, headers] of [
      [editor.editorOrigin, '/', ''],
      [editor.editorOrigin, '/editor.js', ''],
      [editor.editorOrigin, '/api/piece', token],
      [editor.editorOrigin, '/api/events', token],
      [editor.previewOrigin, `/${GENERATION}/index.html`, ''],
    ] as const) {
      // HTTP/1.0 lets a client leave Host out, and Papeleria's own check refuses it.
      const old = await rawCall(origin, `GET ${path} HTTP/1.0\r\n${headers}\r\n`);
      assert.equal(old.status, 403, `HTTP/1.0 ${origin}${path}`);
      assert.equal(json(old)['errorCode'], 'E_HOST', `HTTP/1.0 ${origin}${path}`);
      // HTTP/1.1 requires Host, and Node's parser answers 400 before Papeleria sees the request.
      const current = await rawCall(origin, `GET ${path} HTTP/1.1\r\n${headers}Connection: close\r\n\r\n`);
      assert.equal(current.status, 400, `HTTP/1.1 ${origin}${path}`);
      assert.ok(!current.body.includes('manifestText') && !current.body.includes('<html'), `HTTP/1.1 ${origin}${path} is not served`);
    }
  });

  test('a foreign Origin is refused, and a change needs the editor’s own Origin', async () => {
    for (const origin of ['http://evil.example', editor.previewOrigin, 'null', editor.editorOrigin.replace('127.0.0.1', 'localhost')]) {
      const read = await editor.api('/api/piece', {headers: {origin}});
      assert.equal(read.status, 403, origin);
      assert.equal(json(read)['errorCode'], 'E_ORIGIN');
    }
    const withoutOrigin = await call(`${editor.editorOrigin}/api/file`, {
      method: 'PUT',
      headers: {'x-papeleria-token': editor.token, 'content-type': 'application/json'},
      body: JSON.stringify({path: 'papeleria.yaml', content: 'x', expectedRevision: manifestRevision}),
    });
    assert.equal(withoutOrigin.status, 403);
    assert.equal(json(withoutOrigin)['errorCode'], 'E_ORIGIN');
    const previewWithoutOrigin = await call(`${editor.editorOrigin}/api/preview`, {
      method: 'POST',
      headers: {'x-papeleria-token': editor.token, 'content-type': 'application/json'},
      body: JSON.stringify(preview()),
    });
    assert.equal(previewWithoutOrigin.status, 403);
    // A read with no Origin at all, as a browser sends a same-origin GET, is allowed with the token.
    const plain = await call(`${editor.editorOrigin}/api/piece`, {headers: {'x-papeleria-token': editor.token}});
    assert.equal(plain.status, 200);
  });

  test('no reply grants CORS, and a preflight is refused', async () => {
    const preflight = await call(`${editor.editorOrigin}/api/file`, {
      method: 'OPTIONS',
      headers: {origin: 'http://evil.example', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'x-papeleria-token'},
    });
    assert.equal(preflight.status, 403);
    for (const reply of [preflight, await editor.api('/api/piece'), await call(`${editor.editorOrigin}/api/piece`)]) {
      assert.deepEqual(Object.keys(reply.headers).filter((name) => name.startsWith('access-control-')), []);
    }
  });

  test('unsafe and unapproved paths are refused, links included, and never listed', async () => {
    const refused: [string, number][] = [
      ['../papeleria.yaml', 404],
      ['/etc/passwd', 404],
      ['assets/text/../../papeleria.yaml', 404],
      ['assets\\text\\01-cover-notes.md', 404],
      ['assets/text/%2e%2e/x.md', 404],
      ['assets/text/.hidden.md', 404],
      ['.papeleria/build.lock', 404],
      ['dist/index.html', 404],
      ['brand/owner.md', 404],
      ['assets/images/photo.png', 404],
      ['assets/text/missing.md', 404],
      ['assets/text/link.md', 403],
      ['assets/text/linked/inside.md', 403],
    ];
    for (const [path, status] of refused) {
      const reply = await editor.api(`/api/file?path=${encodeURIComponent(path)}`);
      assert.equal(reply.status, status, path);
      assert.ok(!reply.body.includes('secret') && !reply.body.includes('also outside'), path);
    }
    const piece = json(await editor.api('/api/piece')) as {files: {path: string}[]};
    assert.deepEqual(
      piece.files.map((file) => file.path),
      ['assets/text/01-cover-notes.md', 'assets/data/hours-by-phase.csv'],
    );
    // Saving through a link is refused too, and the file outside is untouched.
    const save = await editor.api('/api/file', {
      method: 'PUT',
      ...body({path: 'assets/text/link.md', content: 'overwritten', expectedRevision: revisionOf('a secret outside the piece\n')}),
    });
    assert.equal(save.status, 403);
    assert.equal(readFileSync(join(outside, 'secret.md'), 'utf8'), 'a secret outside the piece\n');
  });

  test('bodies over IC06’s limits are 413, malformed ones 400, non-JSON 415', async () => {
    const huge = await editor.api('/api/preview', {method: 'POST', headers: {'content-type': 'application/json'}, body: Buffer.alloc(10 * 1024 * 1024 + 1, 0x20)});
    assert.equal(huge.status, 413);
    const manifest = await editor.api('/api/preview', {method: 'POST', ...body(preview({manifestText: 'x'.repeat(1_048_577)}))});
    assert.equal(manifest.status, 413);
    const buffer = await editor.api('/api/preview', {
      method: 'POST',
      ...body(preview({overlays: [{path: 'assets/text/01-cover-notes.md', content: 'é'.repeat(2_621_441), baseRevision: manifestRevision}]})),
    });
    assert.equal(buffer.status, 413, 'a buffer is measured in UTF-8 bytes');
    const overlays = Array.from({length: 51}, (_, index) => ({path: `assets/text/n${index}.md`, content: '', baseRevision: manifestRevision}));
    assert.equal((await editor.api('/api/preview', {method: 'POST', ...body(preview({overlays}))})).status, 413);
    assert.equal((await editor.api('/api/preview', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{"requestId": 1,'})).status, 400);
    assert.equal((await editor.api('/api/preview', {method: 'POST', ...body({...preview(), extra: true})})).status, 400);
    assert.equal((await editor.api('/api/preview', {method: 'POST', ...body(preview({requestId: 0}))})).status, 400);
    assert.equal((await editor.api('/api/preview', {method: 'POST', ...body(preview({manifestPath: '../papeleria.yaml'}))})).status, 400);
    assert.equal((await editor.api('/api/preview', {method: 'POST', headers: {'content-type': 'text/plain'}, body: JSON.stringify(preview())})).status, 415);
    const csv = await editor.api('/api/preview', {
      method: 'POST',
      ...body(preview({overlays: [{path: 'assets/data/hours-by-phase.csv', content: 'a,b\n', baseRevision: manifestRevision}]})),
    });
    assert.equal(csv.status, 400);
    assert.equal(json(csv)['errorCode'], 'E_READ_ONLY');
    const saveCsv = await editor.api('/api/file', {
      method: 'PUT',
      ...body({path: 'assets/data/hours-by-phase.csv', content: 'a,b\n', expectedRevision: revisionOf(readFileSync(join(editor.root, 'assets', 'data', 'hours-by-phase.csv')))}),
    });
    assert.equal(saveCsv.status, 403);
    assert.equal(json(saveCsv)['errorCode'], 'E_READ_ONLY');
  });

  test('exactly at IC06’s limits a request is accepted and one byte or overlay over is 413, whole or chunked with no Content-Length', async () => {
    const MiB = 1024 * 1024;
    // The body: 10 MiB of JSON is read whole and refused only for its shape; one byte more is 413, whether it declares its length or streams in chunks.
    const framings: [string, Record<string, string>][] = [
      ['with Content-Length', {'content-type': 'application/json'}],
      ['chunked', {'content-type': 'application/json', 'transfer-encoding': 'chunked'}],
    ];
    for (const [framing, headers] of framings) {
      const atLimit = await editor.api('/api/preview', {method: 'POST', headers, body: `{${' '.repeat(10 * MiB - 2)}}`});
      assert.deepEqual([atLimit.status, json(atLimit)['errorCode']], [400, 'E_BAD_REQUEST'], `10 MiB ${framing}`);
      const over = await editor.api('/api/preview', {method: 'POST', headers, body: `{${' '.repeat(10 * MiB - 1)}}`});
      assert.deepEqual([over.status, json(over)['errorCode']], [413, 'E_TOO_LARGE'], `10 MiB and a byte ${framing}`);
    }
    // The manifest: 1 MiB of text previews; one byte more is 413.
    const manifest = readFileSync(join(editor.root, 'papeleria.yaml'), 'utf8');
    const full = `${manifest}#${'x'.repeat(MiB - Buffer.byteLength(manifest) - 2)}\n`;
    assert.equal(Buffer.byteLength(full), MiB);
    const previewed = await editor.api('/api/preview', {method: 'POST', ...body(preview({requestId: await nextRequestId(), manifestText: full}))});
    assert.equal(previewed.status, 200, previewed.body.slice(0, 300));
    assert.equal((json(previewed)['report'] as {errors: number}).errors, 0, 'a manifest of exactly 1 MiB is within every limit');
    const overManifest = await editor.api('/api/preview', {method: 'POST', ...body(preview({requestId: await nextRequestId(), manifestText: `${full}x`}))});
    assert.deepEqual([overManifest.status, json(overManifest)['errorCode']], [413, 'E_TOO_LARGE']);
    // A buffer of 5 MiB in UTF-8, and 50 overlays, pass the limits and reach the check of their base revisions; one byte, or one overlay, more is 413.
    const older = revisionOf('an older version\n');
    const buffer = 'é'.repeat((5 * MiB) / 2);
    const notes = (content: string) => [{path: 'assets/text/01-cover-notes.md', content, baseRevision: older}];
    const overlays = (count: number) => Array.from({length: count}, (_, index) => ({path: `assets/text/n${index}.md`, content: '', baseRevision: older}));
    for (const [what, atLimit, over] of [
      ['a buffer', notes(buffer), notes(`${buffer}x`)],
      ['the overlays', overlays(50), overlays(51)],
    ] as const) {
      const accepted = await editor.api('/api/preview', {method: 'POST', ...body(preview({requestId: await nextRequestId(), overlays: atLimit}))});
      assert.deepEqual([accepted.status, json(accepted)['errorCode']], [409, 'E_CONFLICT'], `${what} at the limit`);
      assert.equal((json(accepted)['conflicts'] as unknown[]).length, atLimit.length);
      const refused = await editor.api('/api/preview', {method: 'POST', ...body(preview({requestId: await nextRequestId(), overlays: over}))});
      assert.deepEqual([refused.status, json(refused)['errorCode']], [413, 'E_TOO_LARGE'], `${what} over the limit`);
    }
  });

  test('routes take only their methods, a 405 names them in Allow (D78), and unknown routes are 404', async () => {
    const refused: [string, Reply, string][] = [
      ['DELETE /api/piece', await editor.api('/api/piece', {method: 'DELETE'}), 'GET'],
      ['GET /api/preview', await editor.api('/api/preview'), 'POST'],
      ['DELETE /api/file', await editor.api('/api/file?path=papeleria.yaml', {method: 'DELETE'}), 'GET, PUT'],
      ['POST /', await call(`${editor.editorOrigin}/`, {method: 'POST'}), 'GET, HEAD'],
      ['PUT on the preview origin', await call(`${editor.previewOrigin}/${GENERATION}/index.html`, {method: 'PUT'}), 'GET, HEAD'],
    ];
    for (const [what, reply, allow] of refused) {
      assert.equal(reply.status, 405, what);
      assert.equal(json(reply)['errorCode'], 'E_METHOD', what);
      assert.equal(reply.headers['allow'], allow, what);
    }
    assert.equal((await editor.api('/api/nothing')).status, 404);
    assert.equal((await call(`${editor.editorOrigin}/nothing.js`)).status, 404);
  });

  test('a build request whose keys are prototype names is a plain 400, and pollutes nothing', async () => {
    // Sent as raw text: a `__proto__` key in a literal would set the prototype instead of a key.
    const polluting = await editor.api('/api/build', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: '{"expectedRevisions":{"__proto__":{"polluted":true}}}',
    });
    assert.equal(polluting.status, 400);
    assert.equal(json(polluting)['errorCode'], 'E_BAD_REQUEST', 'an object is not a revision');
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined, 'Object.prototype is untouched');
    const names = await editor.api('/api/build', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: '{"expectedRevisions":{"__proto__":null,"constructor":null,"toString":null}}',
    });
    assert.equal(names.status, 400);
    assert.equal(json(names)['errorCode'], 'E_NOT_APPROVED', 'a prototype name is a path the editor does not know, not a prototype');
  });

  test('the preview origin has no write API, no API at all, and never needs the token', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const reply = await call(`${editor.previewOrigin}/${GENERATION}/index.html`, {method, headers: editor.headers()});
      assert.equal(reply.status, 405, method);
    }
    for (const path of ['/api/piece', '/api/file?path=papeleria.yaml', '/api/events', '/', '/papeleria.yaml', `/${GENERATION}/index.html`]) {
      const reply = await call(`${editor.previewOrigin}${path}`, {headers: editor.headers()});
      assert.equal(reply.status, 404, path);
    }
    // Sent as written, never normalized by a client.
    for (const path of [`/${GENERATION}/../papeleria.yaml`, `/${GENERATION}/%2e%2e/papeleria.yaml`, '/../papeleria.yaml', `/${GENERATION}/..%2fpapeleria.yaml`]) {
      const reply = await call(`${editor.previewOrigin}/`, {path});
      assert.equal(reply.status, 404, path);
    }
    const port = new URL(editor.previewOrigin).port;
    assert.equal((await call(`${editor.previewOrigin}/${GENERATION}/index.html`, {headers: {host: `localhost:${port}`}})).status, 403);
  });

  test('the editor’s own page and files refuse what another page asks for, and serve the page itself (W5R-16, D78)', async () => {
    for (const path of ['/', '/editor.js', '/editor.css']) {
      assert.equal((await call(`${editor.editorOrigin}${path}`)).status, 200, `${path} with no Origin, as a browser loads the page`);
      assert.equal((await call(`${editor.editorOrigin}${path}`, {headers: {origin: editor.editorOrigin}})).status, 200, `${path} from the editor itself`);
      for (const origin of ['http://evil.example', 'null', editor.previewOrigin, editor.editorOrigin.replace('127.0.0.1', 'localhost')]) {
        const refused = await call(`${editor.editorOrigin}${path}`, {headers: {origin}});
        assert.equal(refused.status, 403, `${path} from ${origin}`);
        assert.equal(json(refused)['errorCode'], 'E_ORIGIN');
        assert.equal(refused.headers['access-control-allow-origin'], undefined);
      }
    }
  });

  test('the preview origin refuses what another page asks for, and serves its own pages and the editor (D78)', async () => {
    const built = json(await editor.api('/api/preview', {method: 'POST', ...body(preview({requestId: await nextRequestId()}))}));
    assert.notEqual(built['generationId'], null, JSON.stringify(built));
    const page = String(built['generationURL']);
    assert.equal((await call(page)).status, 200, 'no Origin, as a frame or a new tab loads the page');
    // A preview page asks for its own fonts with its own Origin; the editor is the one page allowed to frame it.
    for (const origin of [editor.previewOrigin, editor.editorOrigin]) {
      assert.equal((await call(page, {headers: {origin}})).status, 200, origin);
    }
    const port = Number(new URL(editor.previewOrigin).port);
    // A port next door, never the editor's own.
    const nextDoor = port + 1 === Number(new URL(editor.editorOrigin).port) ? port + 2 : port + 1;
    for (const origin of ['http://evil.example', 'null', `http://localhost:${port}`, `http://127.0.0.1:${nextDoor}`, "'none'"]) {
      for (const method of ['GET', 'HEAD', 'OPTIONS']) {
        const refused = await call(page, {method, headers: {origin}});
        assert.equal(refused.status, 403, `${method} from ${origin}`);
        assert.equal(refused.headers['access-control-allow-origin'], undefined);
        if (method === 'GET') {
          assert.equal(json(refused)['errorCode'], 'E_ORIGIN', origin);
        }
      }
    }
  });

  test('every reply carries nosniff, no-referrer, same-origin CORP and no-store (D78); a generation’s files are kept as immutable instead', async () => {
    const requestId = await nextRequestId();
    const built = json(await editor.api('/api/preview', {method: 'POST', ...body(preview({requestId}))}));
    const page = String(built['generationURL']);
    // The stream answered 200, or openEvents would have refused it.
    const stream = await openEvents(`${editor.editorOrigin}/api/events`, editor.headers());
    stream.close();
    const port = new URL(editor.editorOrigin).port;
    const replies: [string, {readonly status?: number; readonly headers: Readonly<Record<string, string | string[] | undefined>>}, number][] = [
      ['the editor page', await call(`${editor.editorOrigin}/`), 200],
      ['HEAD of the editor page', await call(`${editor.editorOrigin}/`, {method: 'HEAD'}), 200],
      ['the editor script', await call(`${editor.editorOrigin}/editor.js`), 200],
      ['a font', await call(`${editor.editorOrigin}/theme/fonts/inter-400-700-latin.woff2`), 200],
      ['the snapshot', await editor.api('/api/piece'), 200],
      ['a file', await editor.api('/api/file?path=papeleria.yaml'), 200],
      ['the event stream', {status: 200, headers: stream.headers}, 200],
      ['no token', await call(`${editor.editorOrigin}/api/piece`), 401],
      ['a forged Host', await call(`${editor.editorOrigin}/api/piece`, {headers: {...editor.headers(), host: `localhost:${port}`}}), 403],
      ['another page', await editor.api('/api/piece', {headers: {origin: 'http://evil.example'}}), 403],
      ['a preflight', await call(`${editor.editorOrigin}/api/file`, {method: 'OPTIONS'}), 403],
      ['an unknown route', await editor.api('/api/nothing'), 404],
      ['a file the editor does not open', await editor.api('/api/file?path=dist/index.html'), 404],
      ['a method the route does not take', await editor.api('/api/piece', {method: 'DELETE'}), 405],
      ['a stale request', await editor.api('/api/preview', {method: 'POST', ...body(preview({requestId}))}), 409],
      ['too many overlays', await editor.api('/api/preview', {method: 'POST', ...body(preview({overlays: Array.from({length: 51}, (_, index) => ({path: `assets/text/n${index}.md`, content: '', baseRevision: manifestRevision}))}))}), 413],
      ['not JSON', await editor.api('/api/preview', {method: 'POST', headers: {'content-type': 'text/plain'}, body: '{}'}), 415],
      ['malformed', await editor.api('/api/preview', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{'}), 400],
      ['no such generation, preview origin', await call(`${editor.previewOrigin}/${GENERATION}/index.html`), 404],
      ['a method it does not take, preview origin', await call(page, {method: 'PUT'}), 405],
      ['another page, preview origin', await call(page, {headers: {origin: 'http://evil.example'}}), 403],
    ];
    for (const [what, reply, status] of replies) {
      assert.equal(reply.status, status, what);
      assert.deepEqual(
        ['x-content-type-options', 'referrer-policy', 'cross-origin-resource-policy', 'cache-control'].map((name) => reply.headers[name]),
        ['nosniff', 'no-referrer', 'same-origin', 'no-store'],
        what,
      );
    }
    // A generation never changes, and a new one has a new id, so the preview origin lets the browser keep its files.
    for (const [what, reply, status] of [
      ['a generation page', await call(page), 200],
      ['a range of it', await call(page, {headers: {range: 'bytes=0-9'}}), 206],
      ['a range past its end', await call(page, {headers: {range: 'bytes=99999999-'}}), 416],
    ] as const) {
      assert.equal(reply.status, status, what);
      assert.deepEqual(
        ['x-content-type-options', 'referrer-policy', 'cross-origin-resource-policy', 'cache-control'].map((name) => reply.headers[name]),
        ['nosniff', 'no-referrer', 'same-origin', 'private, max-age=31536000, immutable'],
        what,
      );
    }
  });

  test('the token appears in no log line, reply header or error body', async () => {
    const replies = [
      await editor.api('/api/piece'),
      await editor.api('/api/file?path=../x'),
      await call(`${editor.editorOrigin}/api/piece`, {headers: {'x-papeleria-token': 'wrong'}}),
      await editor.api('/api/preview', {method: 'POST', ...body(preview({requestId: 99}))}),
    ];
    for (const reply of replies) {
      assert.ok(!reply.body.includes(editor.token));
      assert.ok(!JSON.stringify(reply.headers).includes(editor.token));
    }
    assert.ok(!editor.logs.join('\n').includes(editor.token));
  });
});

describe('the preview message checks (pure, no DOM)', () => {
  const frameWindow = {name: 'the frame'};
  const parentWindow = {name: 'the editor'};
  const editorOrigin = 'http://127.0.0.1:4400';
  const previewOrigin = 'http://127.0.0.1:4401';
  const toFrame = {origin: editorOrigin, source: parentWindow, generationId: GENERATION};
  const toEditor = {origin: previewOrigin, source: frameWindow, generationId: GENERATION};
  const goto = {type: 'goto', generationId: GENERATION, target: {kind: 'slide', slide: 3}};
  const ready = {type: 'ready', generationId: GENERATION, hash: '#slide-3'};

  test('origin: only the exact origin expected', () => {
    assert.deepEqual(acceptToFrame({origin: editorOrigin, source: parentWindow, data: goto}, toFrame), goto);
    for (const origin of ['http://127.0.0.1:44000', 'http://localhost:4400', 'http://127.0.0.1:4400/', 'null', '', 'http://evil.example']) {
      assert.equal(acceptToFrame({origin, source: parentWindow, data: goto}, toFrame), null, origin);
      assert.equal(acceptToEditor({origin, source: frameWindow, data: ready}, toEditor), null, origin);
    }
    // Each end expects the other's origin, never its own.
    assert.equal(acceptToFrame({origin: previewOrigin, source: parentWindow, data: goto}, toFrame), null);
    assert.equal(acceptToEditor({origin: editorOrigin, source: frameWindow, data: ready}, toEditor), null);
  });

  test('source: only the exact window expected', () => {
    assert.deepEqual(acceptToEditor({origin: previewOrigin, source: frameWindow, data: ready}, toEditor), ready);
    for (const source of [parentWindow, {name: 'the frame'}, null, undefined]) {
      assert.equal(acceptToEditor({origin: previewOrigin, source, data: ready}, toEditor), null);
      assert.equal(acceptToFrame({origin: editorOrigin, source: source === parentWindow ? frameWindow : source, data: goto}, toFrame), null);
    }
  });

  test('generation: only the generation the page holds', () => {
    for (const generationId of ['mg1a2b3c-0123456789ac', 'mg1a2b3d-0123456789ab', '', 'MG1A2B3C-0123456789AB', `${GENERATION} `, 'x'.repeat(40)]) {
      assert.equal(acceptToFrame({origin: editorOrigin, source: parentWindow, data: {...goto, generationId}}, toFrame), null, generationId);
      assert.equal(acceptToEditor({origin: previewOrigin, source: frameWindow, data: {...ready, generationId}}, toEditor), null, generationId);
    }
  });

  test('shape: exactly one of IC06’s variants per direction, no extra key, finite numbers, clamped coordinates', () => {
    const invalidToFrame: unknown[] = [
      null,
      'goto',
      [],
      42,
      {type: 'goto', generationId: GENERATION},
      {...goto, extra: 1},
      {...goto, target: {kind: 'slide', slide: 0}},
      {...goto, target: {kind: 'slide', slide: 1.5}},
      {...goto, target: {kind: 'slide', slide: '3'}},
      {...goto, target: {kind: 'slide', slide: 3, extra: true}},
      {...goto, target: {kind: 'section', slug: ''}},
      {...goto, target: {kind: 'section', slug: 'x'.repeat(MESSAGE_LIMITS.textMax + 1)}},
      {...goto, target: {kind: 'panel', page: 2}},
      {...goto, target: {kind: 'chart', slide: 1}},
      {type: 'grid', generationId: GENERATION, on: 'yes'},
      {type: 'restoreScroll', generationId: GENERATION, y: Number.NaN},
      {type: 'restoreScroll', generationId: GENERATION, y: Number.POSITIVE_INFINITY},
      {type: 'restoreScroll', generationId: GENERATION, y: '10'},
      ready,
      {type: 'returnFocus', generationId: GENERATION},
      Object.assign(Object.create({inherited: true}) as object, goto),
    ];
    for (const data of invalidToFrame) {
      assert.equal(validateToFrame(data), null, JSON.stringify(data));
    }
    const invalidToEditor: unknown[] = [
      {...ready, hash: 'slide-3'},
      {...ready, hash: `#${'x'.repeat(MESSAGE_LIMITS.textMax)}`},
      {type: 'pointer', generationId: GENERATION, page: 1, x: Number.NaN, y: 1},
      {type: 'pointer', generationId: GENERATION, page: 0, x: 1, y: 1},
      {type: 'scroll', generationId: GENERATION},
      {type: 'returnFocus', generationId: GENERATION, focus: true},
      goto,
      {type: 'restoreScroll', generationId: GENERATION, y: 1},
    ];
    for (const data of invalidToEditor) {
      assert.equal(validateToEditor(data), null, JSON.stringify(data));
    }
    assert.deepEqual(validateToFrame({type: 'restoreScroll', generationId: GENERATION, y: -50}), {type: 'restoreScroll', generationId: GENERATION, y: 0});
    assert.deepEqual(validateToFrame({type: 'restoreScroll', generationId: GENERATION, y: 1e12}), {
      type: 'restoreScroll',
      generationId: GENERATION,
      y: MESSAGE_LIMITS.scrollMax,
    });
    assert.deepEqual(validateToEditor({type: 'pointer', generationId: GENERATION, page: 2, x: -3, y: 250}), {
      type: 'pointer',
      generationId: GENERATION,
      page: 2,
      x: 0,
      y: 100,
    });
    assert.deepEqual(validateToEditor({type: 'returnFocus', generationId: GENERATION}), {type: 'returnFocus', generationId: GENERATION});
    assert.deepEqual(validateTarget({kind: 'panel', page: 2, panel: 3}), {kind: 'panel', page: 2, panel: 3});
    assert.deepEqual(validateTarget({kind: 'section', slug: 'año-2026'}), {kind: 'section', slug: 'año-2026'});
  });
});

describe('launch and resume tokens (security audit F10, D192, D195)', () => {
  type Announced = [address: string, reason: LaunchReason];

  /** The launch token in a launch address. */
  const launchTokenOf = (address: string): string => new URL(address).hash.slice('#token='.length);

  /** Presents a launch token as the editor page does, or with the headers given. */
  const redeem = (editor: TestSession, launchToken: string, headers: Readonly<Record<string, string>> = {origin: editor.editorOrigin}) =>
    call(`${editor.editorOrigin}/api/session`, {method: 'POST', headers: {'content-type': 'application/json', ...headers}, body: JSON.stringify({launchToken})});

  test('the launch address holds a launch token, which the editor page redeems once for the session token', async () => {
    const announced: Announced[] = [];
    const editor = await session(starterDeck('launch-once'), {announce: (address, reason) => announced.push([address, reason])});
    try {
      const launchToken = launchTokenOf(editor.launchUrl);
      assert.match(launchToken, /^[0-9a-f]{64}$/);
      assert.ok(!editor.launchUrl.includes(editor.token), 'the session token is never in an address');
      // Only the editor's own page: no Origin, a foreign one and the preview's are refused, and change nothing.
      const strangers: readonly Readonly<Record<string, string>>[] = [{}, {origin: 'http://evil.example'}, {origin: editor.previewOrigin}];
      for (const headers of strangers) {
        const reply = await redeem(editor, launchToken, headers);
        assert.deepEqual([reply.status, json(reply)['errorCode']], [403, 'E_ORIGIN'], JSON.stringify(headers));
      }
      // Only the current launch token: another one, the session token itself, a malformed body, a GET.
      for (const other of ['f'.repeat(64), editor.token]) {
        const reply = await redeem(editor, other);
        assert.deepEqual([reply.status, json(reply)['errorCode']], [401, 'E_LAUNCH_USED']);
      }
      for (const shape of [{launchToken: launchToken.toUpperCase()}, {launchToken, more: 1}, {}]) {
        const reply = await call(`${editor.editorOrigin}/api/session`, {method: 'POST', ...body(shape), headers: {origin: editor.editorOrigin, 'content-type': 'application/json'}});
        assert.equal(reply.status, 400, JSON.stringify(shape));
      }
      assert.equal((await call(`${editor.editorOrigin}/api/session`, {headers: {origin: editor.editorOrigin}})).status, 405);
      assert.equal(announced.length, 0, 'nothing was redeemed yet');

      const opened = await redeem(editor, launchToken);
      assert.equal(opened.status, 200, opened.body);
      const keys = json(opened);
      assert.deepEqual(Object.keys(keys).sort(), ['resumeToken', 'token']);
      assert.equal(keys['token'], editor.token);
      assert.match(String(keys['resumeToken']), /^[0-9a-f]{64}$/);
      assert.ok(![editor.token, launchToken].includes(String(keys['resumeToken'])), 'the resume token is a key of its own (D195)');
      assert.equal(opened.headers['cache-control'], 'no-store');
      assert.deepEqual(announced.map(([, reason]) => reason), ['redeemed'], 'the next address is shown');
      const twice = await redeem(editor, launchToken);
      assert.deepEqual([twice.status, json(twice)['errorCode']], [401, 'E_LAUNCH_USED'], 'once only');
      assert.ok(!twice.body.includes(editor.token));

      // The address shown next opens the session once too, on the same origin, and brings the one after it.
      const [next] = announced[0]!;
      assert.equal(new URL(next).origin, editor.editorOrigin);
      assert.equal((await redeem(editor, launchTokenOf(next))).status, 200);
      assert.equal((await redeem(editor, launchTokenOf(next))).status, 401);
      assert.equal(announced.length, 2);
      const logs = editor.logs.join('\n');
      for (const token of [editor.token, launchToken, launchTokenOf(next)]) {
        assert.ok(!logs.includes(token), 'no token is logged');
      }
    } finally {
      await editor.close();
    }
  });

  test('the first launch address stops opening the editor two minutes after the start; presenting it then brings a fresh one, which keeps', async () => {
    let now = Date.now();
    const announced: Announced[] = [];
    const editor = await session(starterDeck('launch-late'), {announce: (address, reason) => announced.push([address, reason]), hooks: {now: () => now}});
    try {
      const launchToken = launchTokenOf(editor.launchUrl);
      now += FIRST_LAUNCH_LIFETIME_MS + 1;
      const late = await redeem(editor, launchToken);
      assert.deepEqual([late.status, json(late)['errorCode']], [401, 'E_LAUNCH_EXPIRED']);
      assert.ok(!late.body.includes(editor.token));
      assert.deepEqual(announced.map(([, reason]) => reason), ['expired']);
      assert.equal((await redeem(editor, launchToken)).status, 401, 'and it stays spent');
      // The addresses shown in the terminal alone have no lifetime.
      now += 24 * 60 * 60_000;
      const fresh = await redeem(editor, launchTokenOf(announced[0]![0]));
      assert.equal(fresh.status, 200, fresh.body);
      assert.equal(json(fresh)['token'], editor.token);
    } finally {
      await editor.close();
    }
  });

  test('a tab reopens the session with its resume token after a reload: once, for the next one, with nothing shown in the terminal (D195)', async () => {
    const announced: Announced[] = [];
    const editor = await session(starterDeck('resume'), {announce: (address, reason) => announced.push([address, reason])});
    try {
      const first = json(await redeem(editor, launchTokenOf(editor.launchUrl)));
      const resumeToken = String(first['resumeToken']);
      assert.equal(announced.length, 1);

      // A foreign page cannot present it: the Origin rule is the launch token's.
      assert.equal((await redeem(editor, resumeToken, {origin: 'http://evil.example'})).status, 403);
      const reopened = await redeem(editor, resumeToken);
      assert.equal(reopened.status, 200, reopened.body);
      assert.equal(json(reopened)['token'], editor.token);
      const next = String(json(reopened)['resumeToken']);
      assert.match(next, /^[0-9a-f]{64}$/);
      assert.notEqual(next, resumeToken);
      assert.equal(announced.length, 1, 'a reload spends no address the terminal showed, and shows none');
      const again = await redeem(editor, resumeToken);
      assert.deepEqual([again.status, json(again)['errorCode']], [401, 'E_LAUNCH_USED'], 'once only');
      assert.ok(!again.body.includes(editor.token));
      assert.equal((await redeem(editor, next)).status, 200, 'the next one works');

      // One resume token per tab that opened the editor, up to the limit; beyond it the oldest stops working.
      const tabs: string[] = [];
      for (let tab = 0; tab <= RESUME_TOKEN_LIMIT; tab += 1) {
        const [address] = announced.at(-1)!;
        tabs.push(String(json(await redeem(editor, launchTokenOf(address)))['resumeToken']));
      }
      assert.equal((await redeem(editor, tabs[0]!)).status, 401, 'the oldest is dropped');
      assert.equal((await redeem(editor, tabs.at(-1)!)).status, 200, 'the newest works');
      const logs = editor.logs.join('\n');
      assert.ok(![resumeToken, next, ...tabs].some((token) => logs.includes(token)), 'no resume token is logged');
    } finally {
      await editor.close();
    }
  });

  test('the first launch address still works at the end of its two minutes', async () => {
    let now = Date.now();
    const editor = await session(starterDeck('launch-edge'), {hooks: {now: () => now}});
    try {
      now += FIRST_LAUNCH_LIFETIME_MS;
      assert.equal((await redeem(editor, launchTokenOf(editor.launchUrl))).status, 200);
    } finally {
      await editor.close();
    }
  });
});
