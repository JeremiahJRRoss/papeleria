/**
 * M2.1, M2.6: what `edit` and `serve` share when they start and stop (D77).
 */
import {randomBytes} from 'node:crypto';
import {lstat, realpath, stat} from 'node:fs/promises';
import type {IncomingMessage, Server, ServerResponse} from 'node:http';
import {join} from 'node:path';

import {escapeControls} from '../core/index.js';
import {findManifest} from './files.js';
import {baseHeaders, HttpError, methodNotAllowed, requestUrl} from './http.js';
import {NONCE_PLACEHOLDER, readToolAsset, type ToolAsset} from './assets.js';

export type StartErrorCode = 'E_PORT' | 'E_PIECE_FOLDER' | 'E_TOOL_RESOURCE' | 'E_USAGE';

/** A session could not start: exit 2 with the code (IC05). */
export class ServerStartError extends Error {
  readonly code: StartErrorCode;

  constructor(code: StartErrorCode, message: string) {
    super(message);
    this.name = 'ServerStartError';
    this.code = code;
  }
}

/** The piece folder's canonical path; it must be a folder holding exactly one manifest. */
export async function openPieceFolder(root: string, label: string): Promise<{root: string; manifest: 'papeleria.yaml' | 'papeleria.json'}> {
  const shown = escapeControls(label);
  let canonical: string;
  try {
    canonical = await realpath(root);
  } catch {
    throw new ServerStartError('E_PIECE_FOLDER', `The piece folder ${shown} does not exist. Make one with papeleria new deck ${shown}.`);
  }
  if (!(await lstat(canonical)).isDirectory()) {
    throw new ServerStartError('E_PIECE_FOLDER', `${shown} is not a folder. Give the folder that holds papeleria.yaml or papeleria.json.`);
  }
  const manifest = await findManifest(canonical);
  if (manifest === null) {
    throw new ServerStartError(
      'E_PIECE_FOLDER',
      `${shown} needs exactly one manifest, papeleria.yaml or papeleria.json. Make a piece with papeleria new deck <folder>.`,
    );
  }
  return {root: canonical, manifest};
}

/** Every file an origin serves must be installed before it starts, so a missing bundle stops the command, not a page. */
export async function requireToolAssets(toolRoot: string, assets: Readonly<Record<string, ToolAsset>>): Promise<void> {
  for (const asset of Object.values(assets)) {
    const found = await stat(join(toolRoot, ...asset.source.split('/'))).catch(() => null);
    if (found === null || !found.isFile()) {
      throw new ServerStartError('E_TOOL_RESOURCE', `${asset.source} is missing from this installation. Run npm run build, or reinstall Papeleria.`);
    }
  }
}

/** A port for `--port`: a whole number from 1 to 65535; 0 asks for a free one. */
export function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 0 && port <= 65_535;
}

/** Listens on 127.0.0.1 and returns the port; a port in use or not allowed is E_PORT. */
export async function listenOnLoopback(server: Server, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const failed = (error: NodeJS.ErrnoException): void => {
      const detail =
        error.code === 'EADDRINUSE'
          ? `Port ${port} is in use. Choose another with --port, or leave --port out to use a free one.`
          : error.code === 'EACCES'
            ? `Port ${port} is not allowed for this user. Choose one above 1023 with --port.`
            : `Port ${port} could not be opened: ${error.message}`;
      reject(new ServerStartError('E_PORT', detail));
    };
    server.once('error', failed);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', failed);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new ServerStartError('E_PORT', 'The server has no TCP address.');
  }
  return address.port;
}

/** Stops accepting connections and ends the open ones. */
export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/**
 * Answers a GET or HEAD for one of an origin's tool assets. The page at `/`
 * gets a fresh style nonce, which `policy` puts in its Content Security Policy.
 */
export async function sendToolAsset(
  request: IncomingMessage,
  response: ServerResponse,
  assets: Readonly<Record<string, ToolAsset>>,
  toolRoot: string,
  policy: (nonce: string) => string,
): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw methodNotAllowed(['GET', 'HEAD']);
  }
  const {pathname} = requestUrl(request);
  const asset = Object.hasOwn(assets, pathname) ? assets[pathname] : undefined;
  if (asset === undefined) {
    throw new HttpError(404, 'E_NOT_FOUND', 'Not found.');
  }
  const bytes = await readToolAsset(toolRoot, asset);
  if (bytes === null) {
    throw new HttpError(500, 'E_TOOL_RESOURCE', `${asset.source} is missing from this installation. Run npm run build, or reinstall Papeleria.`);
  }
  const nonce = randomBytes(16).toString('base64');
  const body = pathname === '/' ? Buffer.from(bytes.toString('utf8').split(NONCE_PLACEHOLDER).join(nonce), 'utf8') : bytes;
  response.writeHead(200, {
    ...baseHeaders(),
    ...(pathname === '/' ? {'content-security-policy': policy(nonce)} : {}),
    'content-type': asset.type,
    'content-length': String(body.length),
  });
  response.end(request.method === 'HEAD' ? undefined : body);
}
