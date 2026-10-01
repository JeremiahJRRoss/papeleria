/**
 * A loopback static file server for browser fixtures and built pieces.
 *
 * Serves one directory at http://127.0.0.1 on a free port, never lists a
 * directory, refuses any path that leaves the root, and records every request
 * path so a test can show what a page loaded (C24). This is test tooling, not
 * the preview server of IC06.
 */
import {readFile, stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import {extname, resolve, sep} from 'node:path';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

export type StaticServer = {
  /** `http://127.0.0.1:<port>`, without a trailing slash. */
  readonly origin: string;
  /** Every request path in arrival order, percent-decoded, without the query. */
  readonly requests: readonly string[];
  close(): Promise<void>;
};

export async function serveDirectory(directory: string): Promise<StaticServer> {
  const root = resolve(directory);
  const requests: string[] = [];

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      let pathname: string;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        response.writeHead(400).end();
        return;
      }
      requests.push(pathname);
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, {allow: 'GET, HEAD'}).end();
        return;
      }
      const file = resolve(root, `.${pathname.endsWith('/') ? `${pathname}index.html` : pathname}`);
      if (!file.startsWith(root + sep)) {
        response.writeHead(403).end();
        return;
      }
      try {
        if (!(await stat(file)).isFile()) {
          response.writeHead(404).end();
          return;
        }
        const body = await readFile(file);
        response.writeHead(200, {
          'content-type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
          'content-length': body.length,
          'cache-control': 'no-store',
        });
        response.end(request.method === 'HEAD' ? undefined : body);
      } catch {
        response.writeHead(404).end();
      }
    })();
  });

  await new Promise<void>((resolveListening, rejectListening) => {
    server.once('error', rejectListening);
    server.listen(0, '127.0.0.1', () => resolveListening());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('the static server has no TCP address');
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolveClosed) => {
        server.closeAllConnections();
        server.close(() => resolveClosed());
      }),
  };
}
