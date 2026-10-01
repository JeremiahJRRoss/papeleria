/**
 * M2.1, M2.6: the preview origin (IC06, IC09, D79, D84).
 *
 * A second loopback server, on a port of its own, so a preview page is a
 * different origin from the editor: it cannot read the editor's page, its
 * storage or its token, and the editor's API refuses its requests. It serves
 * `GET /<generationId>/<path>` from the session's kept generations and nothing
 * else: no API, no write method, no directory listing, no file outside a
 * generation. It never receives the token. Every reply carries a Content
 * Security Policy that allows the page its own files only, its inline style
 * attributes (swatches, focal points, aligned table cells), no inline or
 * evaluated script, no form, no connection of any kind, and framing only by
 * the one origin that shows it (the editor, or `serve`'s shell). A request
 * that names another page in its `Origin` is refused, as on every route of
 * the other origins (D78).
 */
import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';

import {baseHeaders, expectHost, expectOrigin, HttpError, methodNotAllowed, requestUrl, sendError} from './http.js';
import {readGenerationFile, type PreviewGenerations} from './generations.js';

/** The preview page's policy, with the one origin allowed to frame it. */
export function previewPolicy(frameAncestor: string): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'",
    "img-src 'self'",
    "font-src 'self'",
    "media-src 'self'",
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${frameAncestor}`,
  ].join('; ');
}

export type PreviewOrigin = {
  readonly origin: string;
  readonly host: string;
  /** Sets the origin allowed to frame preview pages. */
  allowFrameAncestor(origin: string): void;
  close(): Promise<void>;
};

/** One `bytes=start-end` range of a file of `size` bytes, or null to send it whole; `invalid` for a range past its end. */
function rangeOf(header: string | undefined, size: number): {start: number; end: number} | null | 'invalid' {
  if (header === undefined) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null || (match[1] === '' && match[2] === '')) {
    return null;
  }
  let start: number;
  let end: number;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  return start > end || start >= size ? 'invalid' : {start, end};
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  context: {host: string; origins: readonly string[]; generations: PreviewGenerations; policy: () => string},
): Promise<void> {
  expectHost(request, context.host);
  expectOrigin(request, context.origins, false);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw methodNotAllowed(['GET', 'HEAD']);
  }
  const url = requestUrl(request);
  const match = /^\/([^/]+)\/(.*)$/.exec(url.pathname);
  const file = match === null ? null : await context.generations.open(match[1]!, match[2]!);
  if (file === null) {
    throw new HttpError(404, 'E_NOT_FOUND', 'No such preview file.');
  }
  const range = rangeOf(request.headers.range, file.size);
  const headers: Record<string, string> = {
    ...baseHeaders(),
    // A generation never changes, and a new one has a new id.
    'cache-control': 'private, max-age=31536000, immutable',
    'content-security-policy': context.policy(),
    'content-type': file.type,
    'accept-ranges': 'bytes',
  };
  if (range === 'invalid') {
    await file.handle.close();
    response.writeHead(416, {...headers, 'content-range': `bytes */${file.size}`}).end();
    return;
  }
  const from = range?.start ?? 0;
  const to = range?.end ?? file.size - 1;
  const body = request.method === 'HEAD' ? (await file.handle.close(), null) : await readGenerationFile(file, from, to);
  headers['content-length'] = String(to - from + 1);
  if (range !== null) {
    headers['content-range'] = `bytes ${from}-${to}/${file.size}`;
  }
  response.writeHead(range === null ? 200 : 206, headers);
  response.end(body ?? undefined);
}

/** Starts the preview origin on a free loopback port. */
export async function startPreviewOrigin(generations: PreviewGenerations): Promise<PreviewOrigin> {
  let frameAncestor: string | null = null;
  let host = '';
  const server: Server = createServer((request, response) => {
    // The pages that may ask: this origin's own, which a preview page's font requests name, and the one allowed to frame them.
    const origins = [`http://${host}`, ...(frameAncestor === null ? [] : [frameAncestor])];
    handle(request, response, {host, origins, generations, policy: () => previewPolicy(frameAncestor ?? "'none'")}).catch((error: unknown) => sendError(response, error));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('E_INTERNAL: the preview origin has no TCP address');
  }
  host = `127.0.0.1:${address.port}`;
  return {
    origin: `http://${host}`,
    host,
    allowFrameAncestor(origin: string): void {
      frameAncestor = origin;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
