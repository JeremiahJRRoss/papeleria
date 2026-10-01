/**
 * Helpers for the server's integration tests (M2.1): raw HTTP requests whose
 * every header a test chooses — `fetch` cannot forge `Host` — and a piece
 * copied into a temporary folder with an editing session on it.
 */
import {Buffer} from 'node:buffer';
import {request as httpRequest, type IncomingHttpHeaders} from 'node:http';
import {connect} from 'node:net';
import {join} from 'node:path';

import {startEditor, type EditorOptions, type EditorSession} from '../../src/server/index.js';
import {applicationRoot} from '../helpers/paths.js';
import {copyPiece} from '../helpers/pieces.js';

export type Reply = {readonly status: number; readonly headers: Readonly<Record<string, string | string[] | undefined>>; readonly body: string};

export type Call = {
  readonly method?: string;
  /** The request target exactly as sent, un-normalized, in place of the URL's path. */
  readonly path?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Buffer;
};

/** Sends one request exactly as given, `Host` included, and reads the whole reply. */
export function call(url: string, options: Call = {}): Promise<Reply> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: options.path ?? `${target.pathname}${target.search}`,
        method: options.method ?? 'GET',
        headers: {host: target.host, ...options.headers},
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve({status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8')}));
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    request.end(options.body);
  });
}

/**
 * Writes `text` to the origin's port as it is, and reads the reply until the
 * server closes the connection: for what no HTTP client sends, such as an
 * HTTP/1.0 request with no `Host` at all.
 */
export function rawCall(origin: string, text: string): Promise<Reply> {
  const target = new URL(origin);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect({host: target.hostname, port: Number(target.port)}, () => socket.write(text));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const split = raw.indexOf('\r\n\r\n');
      const [statusLine = '', ...lines] = raw.slice(0, split < 0 ? raw.length : split).split('\r\n');
      const headers: Record<string, string> = {};
      for (const line of lines) {
        const colon = line.indexOf(':');
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      resolve({status: Number(/^HTTP\/1\.[01] ([0-9]{3})/.exec(statusLine)?.[1] ?? 0), headers, body: split < 0 ? '' : raw.slice(split + 4)});
    });
  });
}

/** A JSON reply's body. */
export function json(reply: Reply): Record<string, unknown> {
  return JSON.parse(reply.body) as Record<string, unknown>;
}

/** The starter deck, copied into a temporary folder. */
export function starterDeck(label: string): string {
  return copyPiece(join(applicationRoot, 'templates', 'deck', 'sample'), label);
}

export type TestSession = EditorSession & {
  readonly token: string;
  readonly root: string;
  readonly logs: string[];
  /** Headers of a request from the editor page itself. */
  headers(extra?: Readonly<Record<string, string>>): Record<string, string>;
  api(path: string, options?: Call): Promise<Reply>;
};

/** Starts an editing session on `root`, collecting its log lines. */
export async function session(root: string, options: Partial<EditorOptions> = {}): Promise<TestSession> {
  const logs: string[] = [];
  const started = await startEditor({root, label: 'piece', log: (line) => logs.push(line), ...options});
  // The session token as the process that started the session holds it; a page redeems a launch token for it (D192).
  const token = started.token;
  const headers = (extra: Readonly<Record<string, string>> = {}): Record<string, string> => ({
    'x-papeleria-token': token,
    origin: started.editorOrigin,
    ...extra,
  });
  return {
    ...started,
    token,
    root,
    logs,
    headers,
    api: (path: string, options_: Call = {}) => call(`${started.editorOrigin}${path}`, {...options_, headers: headers(options_.headers)}),
  };
}

/** A JSON request body with its type. */
export function body(value: unknown): Call {
  return {headers: {'content-type': 'application/json'}, body: JSON.stringify(value)};
}

export type ServerEventRecord = {readonly id: number; readonly event: string; readonly data: Record<string, unknown>};

export type EventStream = {
  /** The stream reply's headers. */
  readonly headers: IncomingHttpHeaders;
  readonly events: ServerEventRecord[];
  /** Resolves with the first event, seen already or still to come, that `match` accepts. */
  next(match: (event: ServerEventRecord) => boolean, timeoutMs?: number): Promise<ServerEventRecord>;
  close(): void;
};

/** Reads a server-sent event stream with every header a test chooses, as the editor reads it with fetch. */
export function openEvents(url: string, headers: Readonly<Record<string, string>>): Promise<EventStream> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const events: ServerEventRecord[] = [];
    const waiters: {match: (event: ServerEventRecord) => boolean; resolve: (event: ServerEventRecord) => void}[] = [];
    const request = httpRequest({host: target.hostname, port: target.port, path: target.pathname, headers: {host: target.host, ...headers}}, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`the event stream answered ${response.statusCode}`));
        return;
      }
      let buffer = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const fields = new Map<string, string>();
          for (const line of frame.split('\n')) {
            const colon = line.indexOf(':');
            if (colon > 0) {
              fields.set(line.slice(0, colon), line.slice(colon + 1).replace(/^ /, ''));
            }
          }
          if (fields.has('event')) {
            const record = {id: Number(fields.get('id')), event: fields.get('event')!, data: JSON.parse(fields.get('data') ?? 'null') as Record<string, unknown>};
            events.push(record);
            for (const waiter of [...waiters]) {
              if (waiter.match(record)) {
                waiters.splice(waiters.indexOf(waiter), 1);
                waiter.resolve(record);
              }
            }
          }
        }
      });
      resolve({
        headers: response.headers,
        events,
        next(match, timeoutMs = 10_000) {
          const seen = events.find(match);
          if (seen !== undefined) {
            return Promise.resolve(seen);
          }
          return new Promise((resolveEvent, rejectEvent) => {
            const timer = setTimeout(() => rejectEvent(new Error('no matching event arrived')), timeoutMs);
            waiters.push({
              match,
              resolve: (event) => {
                clearTimeout(timer);
                resolveEvent(event);
              },
            });
          });
        },
        close() {
          request.destroy();
        },
      });
    });
    request.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') {
        reject(error);
      }
    });
    request.end();
  });
}

/** Waits a moment, for tests that must show nothing happens. */
export function pause(milliseconds: number): Promise<void> {
  return new Promise((resolvePause) => setTimeout(resolvePause, milliseconds));
}
