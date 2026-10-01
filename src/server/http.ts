/**
 * M2.1: request guards and replies for the local server (IC06, D13, D78).
 *
 * Every origin binds 127.0.0.1 and accepts a request only when its `Host` is
 * exactly `127.0.0.1:<port>`, which is what a browser sends for the launch
 * address and what no DNS name can resolve into (DNS rebinding). The API also
 * needs the session token in `X-Papeleria-Token`; a supplied `Origin` other
 * than the editor's is refused on every route, and a method that changes
 * anything needs the editor's `Origin`. Nothing sends a CORS header, so a page
 * elsewhere can read no reply, and a preflight is refused outright.
 *
 * Replies are JSON with an `errorCode` and a `message` when they are errors
 * (IC06): never a finding with an invented rule.
 */
import {Buffer} from 'node:buffer';
import type {IncomingMessage, ServerResponse} from 'node:http';

import {INPUT_LIMITS} from '../core/index.js';
import {tokenMatches} from './session.js';

/** IC06 request limits. */
export const REQUEST_LIMITS = Object.freeze({
  /** A JSON request body. */
  bodyBytes: 10 * 1024 * 1024,
  /** The manifest text in a request, in UTF-8 bytes. */
  manifestBytes: INPUT_LIMITS.manifestBytes,
  /** One text buffer in a request, in UTF-8 bytes. */
  bufferBytes: INPUT_LIMITS.textBytes,
  /** Overlays in one preview or check request. */
  overlays: 50,
});

/** The header that carries the session token. */
export const TOKEN_HEADER = 'x-papeleria-token';

/** A request refused: the status, a code and a message for the reply, any extra fields, and any header the status needs. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Readonly<Record<string, unknown>>;
  /** Reply headers the status itself calls for, such as a 405's `Allow`. */
  readonly headers: Readonly<Record<string, string>>;

  constructor(status: number, code: string, message: string, extra: Readonly<Record<string, unknown>> = {}, headers: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.extra = extra;
    this.headers = headers;
  }
}

/** Headers every reply carries, whatever the origin. */
export function baseHeaders(): Record<string, string> {
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
    'cache-control': 'no-store',
  };
}

/** A `Host` header must name exactly this origin's loopback address and port. */
export function expectHost(request: IncomingMessage, host: string): void {
  if (request.headers.host !== host) {
    throw new HttpError(403, 'E_HOST', 'This server answers only requests addressed to its own loopback address.');
  }
}

/** The request's `Origin`, or null when it sent none. */
export function originOf(request: IncomingMessage): string | null {
  const value = request.headers.origin;
  return typeof value === 'string' ? value : null;
}

/**
 * A supplied `Origin` must be `allowed` (or one of them); with `required`, it
 * must be supplied. A browser sends one with every cross-origin request and
 * with every POST and PUT, so a page elsewhere is refused before anything runs.
 */
export function expectOrigin(request: IncomingMessage, allowed: string | readonly string[], required: boolean): void {
  const origin = originOf(request);
  if (origin === null ? required : !(typeof allowed === 'string' ? [allowed] : allowed).includes(origin)) {
    throw new HttpError(403, 'E_ORIGIN', required ? 'A change needs a request from the editor page itself.' : 'Requests from other pages are refused.');
  }
}

/** The session token, compared in constant time. */
export function expectToken(request: IncomingMessage, token: string): void {
  const supplied = request.headers[TOKEN_HEADER];
  if (typeof supplied !== 'string' || !tokenMatches(token, supplied)) {
    throw new HttpError(401, 'E_TOKEN', 'This request needs the session key from the address Papeleria printed in the terminal.');
  }
}

/** Reads a JSON body of at most `limit` bytes (413 over it, 415 not JSON, 400 malformed). */
export async function readJson(request: IncomingMessage, limit: number = REQUEST_LIMITS.bodyBytes): Promise<unknown> {
  const type = request.headers['content-type'] ?? '';
  if (!/^application\/json(?:\s*;|$)/i.test(type)) {
    throw new HttpError(415, 'E_MEDIA_TYPE', 'The request body must be JSON (Content-Type: application/json).');
  }
  const declared = Number(request.headers['content-length'] ?? Number.NaN);
  if (Number.isFinite(declared) && declared > limit) {
    request.resume();
    throw new HttpError(413, 'E_TOO_LARGE', `The request is larger than ${limit} bytes.`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) {
      request.resume();
      throw new HttpError(413, 'E_TOO_LARGE', `The request is larger than ${limit} bytes.`);
    }
    chunks.push(buffer);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks));
  } catch {
    throw new HttpError(400, 'E_BAD_REQUEST', 'The request body is not UTF-8.');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'E_BAD_REQUEST', 'The request body is not valid JSON.');
  }
}

/** Sends a JSON reply. */
export function sendJson(response: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    ...baseHeaders(),
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    ...headers,
  });
  response.end(text);
}

/** Sends an error reply with its code and message; anything that is not an `HttpError` is a 500 whose detail stays out of the reply. */
export function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  if (error instanceof HttpError) {
    sendJson(response, error.status, {errorCode: error.code, message: error.message, ...error.extra}, error.headers);
    return;
  }
  sendJson(response, 500, {errorCode: 'E_INTERNAL', message: 'The request failed inside Papeleria.'});
}

/** 405 with the methods a route takes, named in the message and in `Allow`, as HTTP requires of a 405 (D78). */
export function methodNotAllowed(allowed: readonly string[]): HttpError {
  return new HttpError(405, 'E_METHOD', `This address takes ${allowed.join(' and ')} only.`, {}, {allow: allowed.join(', ')});
}

/** A request's path and query, or a 400 for one that cannot be read. */
export function requestUrl(request: IncomingMessage): URL {
  try {
    return new URL(request.url ?? '/', 'http://127.0.0.1');
  } catch {
    throw new HttpError(400, 'E_BAD_REQUEST', 'The request address cannot be read.');
  }
}
