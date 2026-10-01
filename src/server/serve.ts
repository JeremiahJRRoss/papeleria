/**
 * M2.6: `papeleria serve`, a read-only preview (IC09, D87).
 *
 * The same safe pipeline as the editor's preview, on the piece's saved files
 * only: no overlay, no save, no build, no token. It keeps the last good
 * generation when a build fails, previews a withheld piece like any other,
 * and never writes `dist/`.
 *
 * Two loopback servers, as for `edit`: the serve origin (`--port`, or a free
 * port) with a read-only shell — its page, script and stylesheet — and one
 * read-only event stream, `GET /events`, that says which generation to show;
 * and a preview origin on a free port with the generations themselves, which
 * only the shell may frame. Every other address is a 404 and every other
 * method a 405. The event stream needs no token because it carries nothing a
 * page could use to change anything; a request whose Origin is some other
 * page is still refused.
 */
import {createServer, type Server} from 'node:http';

import {locateToolRoot} from '../core/index.js';
import {PipelineError, runPipeline} from '../build/pipeline.js';
import {formatReport} from '../build/report.js';
import {SERVE_ASSETS, servePolicy} from './assets.js';
import {closeServer, listenOnLoopback, openPieceFolder, requireToolAssets, sendToolAsset} from './common.js';
import {EventHub} from './events.js';
import {PreviewGenerations} from './generations.js';
import {expectHost, expectOrigin, HttpError, methodNotAllowed, requestUrl, sendError} from './http.js';
import {startPreviewOrigin} from './preview-origin.js';
import {QueueClosedError, SessionQueue} from './queue.js';
import {watchPiece} from './watcher.js';

export type ServeOptions = {
  readonly root: string;
  readonly label?: string;
  /** The serve origin's port; 0 or absent for a free one. */
  readonly port?: number;
  readonly toolRoot?: string;
  /** Each build's report and the stop line, for the terminal. */
  readonly log?: (line: string) => void;
  readonly hooks?: ServeHooks;
};

/** Test hooks: `beforeShow` runs once a build's generation is in place and before it is the one shown. */
export type ServeHooks = {readonly beforeShow?: () => Promise<void>};

export type ServeSession = {
  readonly origin: string;
  readonly previewOrigin: string;
  /** Resolves once the build that is running or waiting has finished. */
  settled(): Promise<void>;
  close(): Promise<void>;
};

type Shown = {readonly generationId: string; readonly generationURL: string};

export async function startServe(options: ServeOptions): Promise<ServeSession> {
  const label = options.label ?? options.root;
  const log = options.log ?? (() => undefined);
  const toolRoot = options.toolRoot ?? locateToolRoot();
  const {root} = await openPieceFolder(options.root, label);
  await requireToolAssets(toolRoot, SERVE_ASSETS);
  const queue = new SessionQueue();
  const hub = new EventHub();
  const generations = new PreviewGenerations(root);
  await generations.removeStale();
  const preview = await startPreviewOrigin(generations);
  let shown: Shown | null = null;

  const rebuild = (): Promise<unknown> =>
    queue
      .schedule('preview', async (signal) => {
        let result;
        try {
          result = await runPipeline({root, label}, {kind: 'preview'}, {toolRoot, signal});
        } catch (error) {
          if (signal.aborted) {
            return;
          }
          const code = error instanceof PipelineError ? error.code : 'E_INTERNAL';
          const message = error instanceof Error ? error.message : String(error);
          log(`papeleria: ${code}: ${message}`);
          hub.send('build-failed', {errorCode: code, message});
          return;
        }
        if (signal.aborted) {
          return;
        }
        if (result.preview === null) {
          log(formatReport(result.report));
          log(shown === null ? 'Nothing to show until the errors are fixed.' : 'Still showing the last good build.');
          hub.send('build-failed', {errors: result.report.errors, warnings: result.report.warnings});
          return;
        }
        await generations.add(result.preview.generationId, result.preview.directory);
        await options.hooks?.beforeShow?.();
        shown = {generationId: result.preview.generationId, generationURL: `${preview.origin}/${result.preview.generationId}/index.html`};
        // The report says the piece was previewed, so it is printed once the preview is the one a page connecting now is told about.
        log(formatReport(result.report));
        hub.send('reload', shown);
      })
      .catch(() => undefined);

  let host = '';
  let origin = '';
  const server: Server = createServer((request, response) => {
    void (async () => {
      try {
        expectHost(request, host);
        expectOrigin(request, origin, false);
        const url = requestUrl(request);
        if (url.pathname === '/events') {
          if (request.method !== 'GET') {
            throw methodNotAllowed(['GET']);
          }
          hub.attach(response, {shown, folder: label});
          return;
        }
        await sendToolAsset(request, response, SERVE_ASSETS, toolRoot, () => servePolicy(preview.origin));
      } catch (error) {
        sendError(response, error instanceof QueueClosedError ? new HttpError(503, 'E_STOPPING', 'Papeleria is stopping.') : error);
      }
    })();
  });

  let port: number;
  try {
    port = await listenOnLoopback(server, options.port ?? 0);
  } catch (error) {
    await preview.close();
    throw error;
  }
  host = `127.0.0.1:${port}`;
  origin = `http://${host}`;
  preview.allowFrameAncestor(origin);
  const watch = await watchPiece(root, () => void rebuild(), {log});
  const first = rebuild();

  let closing: Promise<void> | null = null;
  return {
    origin,
    previewOrigin: preview.origin,
    settled: async () => {
      await first;
      await queue.idle();
    },
    close(): Promise<void> {
      closing ??= (async () => {
        watch.close();
        hub.closeAll();
        await queue.close();
        await Promise.all([closeServer(server), preview.close()]);
        await generations.removeAll();
      })();
      return closing;
    },
  };
}
