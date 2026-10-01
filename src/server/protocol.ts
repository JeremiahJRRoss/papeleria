/**
 * M2.1: the API's request bodies (IC06) and their checks.
 *
 * A body that is not exactly one of these shapes is a 400; one within the
 * shape that passes a limit is a 413 (IC06: 10 MiB of JSON, 1 MiB of manifest
 * text, 5 MiB per text buffer, 50 overlays). The data limits of IC01 still
 * apply when the pipeline reads the buffers.
 */
import {Buffer} from 'node:buffer';

import {MANIFEST_FILES, type ManifestFile} from '../core/index.js';
import {HttpError, REQUEST_LIMITS} from './http.js';

/** IC06 `Revision`: the SHA-256 of exact bytes, in lower-case hex. */
export type Revision = string;

export type Overlay = {readonly path: string; readonly content: string; readonly baseRevision: Revision};

export type PreviewRequest = {
  readonly requestId: number;
  readonly manifestPath: ManifestFile;
  readonly manifestText: string;
  readonly manifestBaseRevision: Revision;
  readonly overlays: readonly Overlay[];
  readonly cursor: {readonly path: string; readonly line: number; readonly column: number};
};

export type SaveRequest = {readonly path: string; readonly content: string; readonly expectedRevision: Revision};

export type BuildRequest = {readonly expectedRevisions: Readonly<Record<string, Revision | null>>};

/** What a page presents to `POST /api/session` for the session token: the launch token from its address (D192). */
export type SessionRequest = {readonly launchToken: string};

const REVISION = /^[0-9a-f]{64}$/;
const LAUNCH_TOKEN = /^[0-9a-f]{64}$/;

function bad(message: string): HttpError {
  return new HttpError(400, 'E_BAD_REQUEST', message);
}

function exactly(value: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw bad(`${what} must be an object.`);
  }
  const own = Object.keys(value);
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  const extra = own.filter((key) => !keys.includes(key));
  if (missing.length > 0 || extra.length > 0) {
    throw bad(`${what} must have exactly ${keys.join(', ')}${extra.length > 0 ? `; it also has ${extra.join(', ')}` : ''}.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, what: string): string {
  if (typeof value !== 'string') {
    throw bad(`${what} must be text.`);
  }
  return value;
}

function revision(value: unknown, what: string): Revision {
  if (typeof value !== 'string' || !REVISION.test(value)) {
    throw bad(`${what} must be a SHA-256 revision.`);
  }
  return value;
}

function positiveInteger(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw bad(`${what} must be a whole number of at least 1.`);
  }
  return value;
}

function bounded(text: string, limit: number, what: string): string {
  if (Buffer.byteLength(text, 'utf8') > limit) {
    throw new HttpError(413, 'E_TOO_LARGE', `${what} is larger than ${limit} bytes.`);
  }
  return text;
}

/** A `PreviewRequest`, as `POST /api/preview` and `POST /api/check` take it. */
export function parsePreviewRequest(body: unknown): PreviewRequest {
  const record = exactly(body, ['requestId', 'manifestPath', 'manifestText', 'manifestBaseRevision', 'overlays', 'cursor'], 'The request');
  const manifestPath = string(record['manifestPath'], 'manifestPath');
  if (!(MANIFEST_FILES as readonly string[]).includes(manifestPath)) {
    throw bad('manifestPath must be papeleria.yaml or papeleria.json.');
  }
  if (!Array.isArray(record['overlays'])) {
    throw bad('overlays must be a list.');
  }
  if (record['overlays'].length > REQUEST_LIMITS.overlays) {
    throw new HttpError(413, 'E_TOO_LARGE', `A request carries at most ${REQUEST_LIMITS.overlays} overlays.`);
  }
  const seen = new Set<string>();
  const overlays = record['overlays'].map((item: unknown, index: number): Overlay => {
    const overlay = exactly(item, ['path', 'content', 'baseRevision'], `Overlay ${index + 1}`);
    const path = string(overlay['path'], `Overlay ${index + 1}'s path`);
    if (seen.has(path)) {
      throw bad(`${path} is overlaid twice.`);
    }
    seen.add(path);
    return {
      path,
      content: bounded(string(overlay['content'], `Overlay ${index + 1}'s content`), REQUEST_LIMITS.bufferBytes, `The buffer for ${path}`),
      baseRevision: revision(overlay['baseRevision'], `Overlay ${index + 1}'s baseRevision`),
    };
  });
  const cursor = exactly(record['cursor'], ['path', 'line', 'column'], 'cursor');
  return {
    requestId: positiveInteger(record['requestId'], 'requestId'),
    manifestPath: manifestPath as ManifestFile,
    manifestText: bounded(string(record['manifestText'], 'manifestText'), REQUEST_LIMITS.manifestBytes, 'The manifest text'),
    manifestBaseRevision: revision(record['manifestBaseRevision'], 'manifestBaseRevision'),
    overlays,
    cursor: {
      path: string(cursor['path'], 'cursor.path'),
      line: positiveInteger(cursor['line'], 'cursor.line'),
      column: positiveInteger(cursor['column'], 'cursor.column'),
    },
  };
}

/** A save, as `PUT /api/file` takes it. */
export function parseSaveRequest(body: unknown): SaveRequest {
  const record = exactly(body, ['path', 'content', 'expectedRevision'], 'The save');
  return {
    path: string(record['path'], 'path'),
    // The file kind's own limit is applied once the path is known.
    content: bounded(string(record['content'], 'content'), REQUEST_LIMITS.bufferBytes, 'The content'),
    expectedRevision: revision(record['expectedRevision'], 'expectedRevision'),
  };
}

/** A redemption, as `POST /api/session` takes it: exactly a launch token of 64 lower-case hex digits. */
export function parseSessionRequest(body: unknown): SessionRequest {
  const record = exactly(body, ['launchToken'], 'The request');
  const launchToken = record['launchToken'];
  if (typeof launchToken !== 'string' || !LAUNCH_TOKEN.test(launchToken)) {
    throw bad('launchToken must be the 64 hexadecimal digits after #token= in the launch address.');
  }
  return {launchToken};
}

/** A build, as `POST /api/build` takes it: the revision the editor knows for every source it knows. */
export function parseBuildRequest(body: unknown): BuildRequest {
  const record = exactly(body, ['expectedRevisions'], 'The build');
  const map = record['expectedRevisions'];
  if (typeof map !== 'object' || map === null || Array.isArray(map)) {
    throw bad('expectedRevisions must map paths to revisions.');
  }
  const entries = Object.entries(map as Record<string, unknown>);
  if (entries.length > 10_000) {
    throw new HttpError(413, 'E_TOO_LARGE', 'expectedRevisions names more than 10,000 files.');
  }
  // A null-prototype object: a key such as `__proto__` or `constructor` is then a path like any other, refused later as not approved, never a prototype.
  const expectedRevisions: Record<string, Revision | null> = Object.create(null) as Record<string, Revision | null>;
  for (const [path, value] of entries) {
    expectedRevisions[path] = value === null ? null : revision(value, `The revision of ${path}`);
  }
  return {expectedRevisions};
}
