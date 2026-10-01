/**
 * M2.1, M2.6: an editing session (IC05, IC06, D09, D13, D77–D82).
 *
 * Two loopback servers: the editor origin, which serves the editor's page
 * and the API, and the preview origin, which serves preview generations only
 * (`preview-origin.ts`). The API needs the session token on every request but
 * the one that gives it, and a change needs the editor's own Origin
 * (`http.ts`).
 *
 * | Route | What it does |
 * | --- | --- |
 * | `POST /api/session` | The session token and the page's next resume token, for the current launch token from the page's address, or for the resume token its tab kept, with the editor's own Origin; once per token (D192, D195) |
 * | `GET /api/piece` | The whole snapshot: manifest text and revision, the approved files and their revisions, the three bundled schemas, the preview origin; what a page needs to start or to recover after a lost connection |
 * | `GET /api/file?path=` | One approved file with its revision; CSV read-only |
 * | `PUT /api/file` | A save against the revision the editor last saw (IC05), or 409 with the revision on disk |
 * | `POST /api/preview` | A preview of the manifest buffer and every dirty Markdown buffer; the latest wins |
 * | `POST /api/check` | The same snapshot checked, nothing kept, `dist/` untouched |
 * | `POST /api/build` | The saved sources built to `dist/`, refused when a revision the editor knows moved |
 * | `GET /api/events` | The session's events, read with fetch streaming |
 *
 * Previews, checks, builds, saves and the watcher's look at the disk share
 * one queue (`queue.ts`), so they never interleave. Request ids must increase
 * for the whole session; a page that starts later learns the last one from
 * `GET /api/piece`. A buffer whose base revision is no longer the file's on
 * disk makes a preview or check a 409 until the author reloads it or keeps
 * theirs (IC06).
 */
import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';

import {bundledSchema, loadBrandFiles, locateToolRoot, parseManifest, resolveBrand, TEMPLATE_NAMES, type ManifestFile, type TemplateName} from '../core/index.js';
import {PipelineError, runPipeline} from '../build/pipeline.js';
import {targetAt} from '../build/targets.js';
import {readToolVersion} from '../build/version.js';
import {leftoverNote, removePreviewGeneration} from '../build/write.js';
import {editorPolicy, EDITOR_ASSETS} from './assets.js';
import {closeServer, listenOnLoopback, openPieceFolder, requireToolAssets, sendToolAsset} from './common.js';
import {EventHub} from './events.js';
import {
  approvedKind,
  currentRevision,
  findManifest,
  listApprovedFiles,
  openApprovedFile,
  saveApprovedFile,
  type ApprovedFile,
  type SaveHooks,
} from './files.js';
import {PreviewGenerations} from './generations.js';
import {expectHost, expectOrigin, expectToken, HttpError, methodNotAllowed, readJson, requestUrl, sendError, sendJson} from './http.js';
import {startPreviewOrigin} from './preview-origin.js';
import {parseBuildRequest, parsePreviewRequest, parseSaveRequest, parseSessionRequest, type PreviewRequest} from './protocol.js';
import {QueueClosedError, SessionQueue, SUPERSEDED, type Superseded} from './queue.js';
import {createToken, LaunchTokens, launchUrl, type LaunchReason} from './session.js';
import {filesUnder, watchPiece, type PieceWatch, type WatchOptions} from './watcher.js';

/** Test hooks: where a test may hold a job back, stop a save, refuse to watch or set the clock, as a slow build, a racing writer, a full watcher table or time passing would. */
export type SessionHooks = {
  /** Runs inside a preview's job before its pipeline starts. */
  readonly beforePreview?: (requestId: number, signal: AbortSignal) => Promise<void>;
  /** Runs before an event stream is opened, while its page waits for `hello`. */
  readonly beforeEvents?: () => Promise<void>;
  readonly save?: SaveHooks;
  /** The clock the first launch token's lifetime is measured by. */
  readonly now?: () => number;
  /** Stands in for `fs.watch`, to fail as a full watcher table does. */
  readonly watch?: WatchOptions['watch'];
};

export type {LaunchReason};

export type EditorOptions = {
  readonly root: string;
  /** The folder as the author typed it, for messages and reports. */
  readonly label?: string;
  /** The editor origin's port; 0 or absent for a free one. The preview origin always takes a free one. */
  readonly port?: number;
  readonly toolRoot?: string;
  /** Routine diagnostics; never given a token. */
  readonly log?: (line: string) => void;
  /** Shows each launch address after the first, for the terminal (D192); never logged. */
  readonly announce?: (launchUrl: string, reason: LaunchReason) => void;
  readonly hooks?: SessionHooks;
};

export type EditorSession = {
  readonly editorOrigin: string;
  readonly previewOrigin: string;
  /** The first launch address: the editor origin with a launch token in the fragment, which opens the editor once (D192). */
  readonly launchUrl: string;
  /** The session token, for the process that started the session, which shows it nowhere: a page gets it only by redeeming a launch token. */
  readonly token: string;
  /** Ends every open event stream, as a dropped connection would; the session keeps running. */
  dropEventStreams(): void;
  close(): Promise<void>;
};

const API_ROUTES: Readonly<Record<string, readonly string[]>> = {
  '/api/session': ['POST'],
  '/api/piece': ['GET'],
  '/api/file': ['GET', 'PUT'],
  '/api/preview': ['POST'],
  '/api/check': ['POST'],
  '/api/build': ['POST'],
  '/api/events': ['GET'],
};

const LANGUAGES = ['en', 'es'] as const;
const STATUSES = ['draft', 'review', 'published', 'withheld'] as const;

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

export async function startEditor(options: EditorOptions): Promise<EditorSession> {
  const label = options.label ?? options.root;
  const log = options.log ?? (() => undefined);
  const hooks = options.hooks ?? {};
  const toolRoot = options.toolRoot ?? locateToolRoot();
  const toolVersion = readToolVersion();
  const opened = await openPieceFolder(options.root, label);
  await requireToolAssets(toolRoot, EDITOR_ASSETS);
  const root = opened.root;
  let manifest: ManifestFile | null = opened.manifest;

  const schemas = Object.fromEntries(TEMPLATE_NAMES.map((name) => [name, bundledSchema(name, toolRoot)])) as Record<TemplateName, unknown>;
  const wordmark = resolveBrand(loadBrandFiles(toolRoot)).wordmark;
  const token = createToken();
  let editorOrigin = '';
  const launches = new LaunchTokens((next, reason) => options.announce?.(launchUrl(editorOrigin, next), reason), hooks.now);
  const queue = new SessionQueue();
  const hub = new EventHub();
  const generations = new PreviewGenerations(root);
  await generations.removeStale();
  const preview = await startPreviewOrigin(generations);

  /** The kind and revision of every approved file as the session last saw it on disk, or wrote it. */
  const known = new Map<string, Pick<ApprovedFile, 'kind' | 'revision'>>();
  for (const file of await listApprovedFiles(root, manifest)) {
    known.set(file.path, {kind: file.kind, revision: file.revision});
  }
  let lastRequestId = 0;

  const claimRequestId = (requestId: number): void => {
    if (requestId <= lastRequestId) {
      throw new HttpError(409, 'E_STALE_REQUEST', `Request ${requestId} is not newer than request ${lastRequestId}.`, {lastRequestId});
    }
    lastRequestId = requestId;
  };

  /** 409 unless every buffer's base revision is the file's revision on disk now (IC06). */
  const checkBases = async (request: PreviewRequest): Promise<void> => {
    if (request.manifestPath !== manifest) {
      throw new HttpError(409, 'E_MANIFEST_CHANGED', `The piece's manifest is now ${manifest ?? 'missing'}. Reload the editor's view of the piece.`);
    }
    const conflicts: {path: string; currentRevision: string | null}[] = [];
    for (const [path, base] of [[request.manifestPath, request.manifestBaseRevision], ...request.overlays.map((overlay) => [overlay.path, overlay.baseRevision])] as const) {
      const now = await currentRevision(root, path, manifest);
      if (now !== base) {
        conflicts.push({path, currentRevision: now});
      }
    }
    if (conflicts.length > 0) {
      throw new HttpError(409, 'E_CONFLICT', `${conflicts.map((item) => item.path).join(', ')} changed on disk. Reload, or keep yours, first.`, {conflicts});
    }
  };

  const overlaysOf = (request: PreviewRequest): {path: string; content: string}[] => {
    for (const overlay of request.overlays) {
      const kind = approvedKind(overlay.path, manifest);
      if (kind !== 'text') {
        throw new HttpError(
          400,
          kind === 'data' ? 'E_READ_ONLY' : 'E_NOT_APPROVED',
          kind === 'data' ? 'CSV files are read-only; they cannot be overlaid.' : `${overlay.path} is not a Markdown file under assets/text/.`,
        );
      }
    }
    return [{path: request.manifestPath, content: request.manifestText}, ...request.overlays.map(({path, content}) => ({path, content}))];
  };

  const failure = (requestId: number | null, error: unknown): Record<string, unknown> => {
    const code = error instanceof PipelineError ? error.code : 'E_INTERNAL';
    const message = error instanceof Error ? error.message : String(error);
    log(`papeleria: ${code}: ${message}`);
    return {...(requestId === null ? {} : {requestId}), errorCode: code, message};
  };

  const runPreview = async (request: PreviewRequest, overlays: {path: string; content: string}[]): Promise<Record<string, unknown> | Superseded> =>
    queue.schedule('preview', async (signal) => {
      await hooks.beforePreview?.(request.requestId, signal);
      if (signal.aborted) {
        return SUPERSEDED;
      }
      await checkBases(request);
      let result;
      try {
        result = await runPipeline({root, label, overlays}, {kind: 'preview'}, {toolRoot, signal});
      } catch (error) {
        if (signal.aborted) {
          return SUPERSEDED;
        }
        const reply = failure(request.requestId, error);
        hub.send('build-failed', reply);
        return reply;
      }
      if (signal.aborted) {
        if (result.preview !== null) {
          await removePreviewGeneration(root, result.preview.generationId).catch(() => undefined);
        }
        return SUPERSEDED;
      }
      const report = result.report;
      const cursorTarget = targetAt(report.targets, request.cursor.path, request.cursor.line);
      if (result.preview === null) {
        hub.send('build-failed', {requestId: request.requestId, errors: report.errors, warnings: report.warnings});
        return {requestId: request.requestId, report, targets: report.targets, cursorTarget, generationId: null, generationURL: null};
      }
      const generationId = result.preview.generationId;
      await generations.add(generationId, result.preview.directory);
      const generationURL = `${preview.origin}/${generationId}/index.html`;
      hub.send('preview-built', {requestId: request.requestId, generationId, generationURL});
      return {requestId: request.requestId, report, targets: report.targets, cursorTarget, generationId, generationURL};
    });

  const runCheck = async (request: PreviewRequest, overlays: {path: string; content: string}[]): Promise<Record<string, unknown> | Superseded> =>
    queue.schedule('check', async () => {
      await checkBases(request);
      try {
        const result = await runPipeline({root, label, overlays}, {kind: 'check'}, {toolRoot});
        return {requestId: request.requestId, report: result.report};
      } catch (error) {
        return failure(request.requestId, error);
      }
    });

  const runBuild = async (expected: Readonly<Record<string, string | null>>): Promise<Record<string, unknown> | Superseded> =>
    queue.schedule('build', async () => {
      const changed: {path: string; currentRevision: string | null}[] = [];
      for (const [path, revision] of Object.entries(expected)) {
        if (approvedKind(path, manifest) === null) {
          throw new HttpError(400, 'E_NOT_APPROVED', `${path} is not a file the editor knows.`);
        }
        const now = await currentRevision(root, path, manifest);
        if (now !== revision) {
          changed.push({path, currentRevision: now});
        }
      }
      if (changed.length > 0) {
        throw new HttpError(409, 'E_CHANGED', `${changed.map((item) => item.path).join(', ')} changed on disk since the editor read it. Nothing was built.`, {changed});
      }
      try {
        const result = await runPipeline({root, label}, {kind: 'dist'}, {toolRoot});
        for (const leftover of result.leftovers) {
          log(`note: ${leftoverNote(leftover)}`);
        }
        return {report: result.report, olderDist: result.olderDist, recovery: result.recovery};
      } catch (error) {
        return failure(null, error);
      }
    });

  /** Looks at the disk after the watcher saw a change, and tells the pages what moved. */
  const scan = async (touched: ReadonlySet<string>): Promise<void> => {
    await queue
      .schedule('scan', async () => {
        manifest = await findManifest(root);
        const files = await listApprovedFiles(root, manifest);
        const seen = new Set<string>();
        // A path is announced at most once a scan: a Markdown file removed is text gone, not an asset as well.
        const announced = new Set<string>();
        for (const file of files) {
          seen.add(file.path);
          const before = known.get(file.path);
          if (before === undefined || before.revision !== file.revision) {
            known.set(file.path, {kind: file.kind, revision: file.revision});
            announced.add(file.path);
            hub.send('file-changed', {path: file.path, kind: file.kind, revision: file.revision});
          }
        }
        for (const [path, file] of [...known]) {
          if (!seen.has(path)) {
            known.delete(path);
            announced.add(path);
            hub.send('file-changed', {path, kind: file.kind, revision: null});
          }
        }
        // Images, video and anything else the piece uses: no revision, just a reason to preview again. A folder is
        // announced by the files under it, never as itself: an empty one changes nothing, and the files of one moved
        // in whole were there before it could be watched, so the folder is the only word of them.
        for (const path of await filesUnder(root, touched)) {
          if (!known.has(path) && !seen.has(path) && !announced.has(path) && path.startsWith('assets/')) {
            announced.add(path);
            hub.send('file-changed', {path, kind: 'asset', revision: null});
          }
        }
      })
      .catch(() => undefined);
  };

  const snapshot = async (): Promise<Record<string, unknown>> => {
    manifest = await findManifest(root);
    const files = await listApprovedFiles(root, manifest);
    const manifestFile = manifest === null ? null : await openApprovedFile(root, manifest, manifest).catch(() => null);
    const value = manifestFile === null ? null : (parseManifest(manifestFile.content, manifest!).manifest?.value ?? null);
    const template = pick(value?.['template'], TEMPLATE_NAMES);
    return {
      folder: label,
      tool: {name: 'papeleria', version: toolVersion},
      wordmark,
      template,
      language: pick(value?.['language'], LANGUAGES) ?? (template === null ? null : 'en'),
      status: pick(value?.['status'], STATUSES) ?? (template === null ? null : 'draft'),
      manifestPath: manifest,
      manifestText: manifestFile?.content ?? null,
      manifestRevision: manifestFile?.revision ?? null,
      manifestLineEnding: manifestFile?.lineEnding ?? 'lf',
      files: files.filter((file) => file.kind !== 'manifest'),
      schemas,
      previewOrigin: preview.origin,
      lastEventId: hub.lastId,
      lastRequestId,
    };
  };

  let host = '';

  /**
   * `POST /api/session`, the one route without the session token, since it is
   * how a page gets it (D192): the current launch token, or a resume token the
   * page's tab kept (D195), from the editor's own page, once each. The reply
   * carries the page's next resume token.
   */
  const redeem = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== 'POST') {
      throw methodNotAllowed(API_ROUTES['/api/session']!);
    }
    expectOrigin(request, editorOrigin, true);
    const redemption = launches.redeem(parseSessionRequest(await readJson(request)).launchToken);
    if (redemption.outcome === 'expired') {
      throw new HttpError(401, 'E_LAUNCH_EXPIRED', 'This address was not opened within two minutes, so it no longer opens the editor. Papeleria printed a new one in the terminal: paste it into this tab, or open it in a new one.');
    }
    if (redemption.outcome === 'refused') {
      throw new HttpError(401, 'E_LAUNCH_USED', 'This address has opened the editor already, and each address opens it once. Paste the newest address Papeleria printed in the terminal into this tab, or open it in a new one.');
    }
    sendJson(response, 200, {token, resumeToken: redemption.resumeToken});
  };

  const api = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
    if (request.method === 'OPTIONS') {
      throw new HttpError(403, 'E_PREFLIGHT', 'Requests from other pages are refused.');
    }
    const methods = Object.hasOwn(API_ROUTES, url.pathname) ? API_ROUTES[url.pathname]! : null;
    expectOrigin(request, editorOrigin, false);
    if (url.pathname === '/api/session') {
      await redeem(request, response);
      return;
    }
    expectToken(request, token);
    if (methods === null) {
      throw new HttpError(404, 'E_NOT_FOUND', 'No such API route.');
    }
    if (!methods.includes(request.method ?? '')) {
      throw methodNotAllowed(methods);
    }
    if (request.method !== 'GET') {
      expectOrigin(request, editorOrigin, true);
    }
    switch (`${request.method} ${url.pathname}`) {
      case 'GET /api/piece':
        sendJson(response, 200, await snapshot());
        return;
      case 'GET /api/file': {
        const path = url.searchParams.get('path');
        if (path === null) {
          throw new HttpError(400, 'E_BAD_REQUEST', 'Name the file with ?path=.');
        }
        sendJson(response, 200, await openApprovedFile(root, path, manifest));
        return;
      }
      case 'PUT /api/file': {
        const save = parseSaveRequest(await readJson(request));
        const revision = await queue.schedule('save', async () => {
          const written = await saveApprovedFile(root, save.path, save.content, save.expectedRevision, manifest, hooks.save);
          known.set(save.path, {kind: approvedKind(save.path, manifest)!, revision: written});
          return written;
        });
        sendJson(response, 200, {path: save.path, revision});
        return;
      }
      case 'POST /api/preview':
      case 'POST /api/check': {
        const body = parsePreviewRequest(await readJson(request));
        const overlays = overlaysOf(body);
        claimRequestId(body.requestId);
        const reply = url.pathname === '/api/preview' ? await runPreview(body, overlays) : await runCheck(body, overlays);
        sendJson(response, 200, 'superseded' in reply ? {requestId: body.requestId, superseded: true} : reply);
        return;
      }
      case 'POST /api/build': {
        const body = parseBuildRequest(await readJson(request));
        const reply = await runBuild(body.expectedRevisions);
        sendJson(response, 200, reply);
        return;
      }
      case 'GET /api/events':
        await hooks.beforeEvents?.();
        hub.attach(response, {lastRequestId});
        return;
    }
  };

  const app: Server = createServer((request, response) => {
    void (async () => {
      try {
        expectHost(request, host);
        const url = requestUrl(request);
        if (url.pathname.startsWith('/api/')) {
          await api(request, response, url);
        } else {
          // The rule of every route (D78), as serve's shell has it: the page's own requests, its fonts among them, name this origin.
          expectOrigin(request, editorOrigin, false);
          await sendToolAsset(request, response, EDITOR_ASSETS, toolRoot, (nonce) => editorPolicy(nonce, preview.origin));
        }
      } catch (error) {
        if (error instanceof QueueClosedError) {
          sendError(response, new HttpError(503, 'E_STOPPING', 'Papeleria is stopping.'));
          return;
        }
        if (!(error instanceof HttpError)) {
          log(`papeleria: E_INTERNAL: ${error instanceof Error ? error.message : String(error)}`);
        }
        sendError(response, error);
      }
    })();
  });

  let port: number;
  try {
    port = await listenOnLoopback(app, options.port ?? 0);
  } catch (error) {
    await preview.close();
    throw error;
  }
  host = `127.0.0.1:${port}`;
  editorOrigin = `http://${host}`;
  preview.allowFrameAncestor(editorOrigin);

  const watch: PieceWatch = await watchPiece(root, (touched) => void scan(touched), {log, ...(hooks.watch === undefined ? {} : {watch: hooks.watch})});
  let closing: Promise<void> | null = null;

  return {
    editorOrigin,
    previewOrigin: preview.origin,
    launchUrl: launchUrl(editorOrigin, launches.current),
    token,
    dropEventStreams: () => hub.closeAll(),
    close(): Promise<void> {
      closing ??= (async () => {
        watch.close();
        hub.closeAll();
        await queue.close();
        await Promise.all([closeServer(app), preview.close()]);
        await generations.removeAll();
      })();
      return closing;
    },
  };
}

