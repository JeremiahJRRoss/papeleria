/**
 * M2.2–M2.5: the editor page (UX §08, IC06, D09, D75–D86).
 *
 * Starts from the launch address: the launch token is taken from the fragment
 * and the fragment removed, so it is never in the address bar, the history,
 * storage or a request's address again (IC06), and the page redeems it, once,
 * for the session token it then keeps in memory (D192). The tab keeps only a
 * one-time resume token, with which a reload reopens the editor (D195). Then
 * the piece's snapshot (`GET /api/piece`) opens the manifest tab, the event
 * stream is read, and the first preview is asked for.
 *
 * Shortcuts: Ctrl or Cmd S saves the current tab, Ctrl or Cmd B builds, Ctrl
 * Space completes (CodeMirror's keymap). Escape closes completion first
 * (CodeMirror handles it and marks it handled); inside the preview the page's
 * own Escape order runs, and what reaches the bridge comes back as
 * `returnFocus`, which returns focus and selection to the last source tab.
 */
import {ApiError, ConnectionError, createApi, redeemLaunchToken, type Api, type EventSubscription} from './api.js';
import {documentValue} from './completion.js';
import {Diagnostics, locationText, type Location} from './diagnostics.js';
import {baseName, byId, element} from './dom.js';
import {DEVICE_WIDTHS, Preview, type Report, type Snapshot} from './preview.js';
import {failedLine, POINTER_PROMPT, pointerLine, previewLine, savedLine, tally, type Weight} from './status.js';
import {TabSet, type FileEntry, type Tab} from './tabs.js';

type TemplateName = 'deck' | 'comic' | 'document';

type PieceSnapshot = {
  readonly folder: string;
  readonly tool: {readonly name: string; readonly version: string};
  readonly wordmark: string;
  readonly template: TemplateName | null;
  readonly language: string | null;
  readonly status: string | null;
  readonly manifestPath: 'papeleria.yaml' | 'papeleria.json' | null;
  readonly manifestText: string | null;
  readonly manifestRevision: string | null;
  readonly manifestLineEnding: 'lf' | 'crlf';
  readonly files: readonly FileEntry[];
  readonly schemas: Readonly<Record<TemplateName, unknown>>;
  readonly previewOrigin: string;
  readonly lastEventId: number;
  readonly lastRequestId: number;
};

type BuildReply = {report?: Report & {outputWritten: boolean; outputReason: string; piece: string}; errorCode?: string; message?: string};

type HeldEvent = {readonly id: number; readonly name: string; readonly data: Readonly<Record<string, unknown>>};

const STOPPED = 'Papeleria stopped. Start it again from the terminal.';
const BUILD_HINT = 'Save all changed files before building.';
const TEMPLATES: readonly TemplateName[] = ['deck', 'comic', 'document'];

/** Takes the launch token from `#token=…` and removes the fragment, whatever it held. */
function takeLaunchToken(): string | null {
  const match = /^#token=([0-9a-f]{64})$/.exec(location.hash);
  if (location.hash !== '' || location.href.endsWith('#')) {
    history.replaceState(null, '', `${location.pathname}${location.search}`);
  }
  return match?.[1] ?? null;
}

/**
 * Whether the preview has an origin of its own (IC06): the loopback address at
 * another port than the editor's. Its frame lets scripts run on their own
 * origin, and on the editor's that would be the page that holds the token. The
 * server always gives another port; the editor does not take it on trust
 * (security audit F15).
 */
function previewIsolated(previewOrigin: unknown): boolean {
  if (typeof previewOrigin !== 'string') {
    return false;
  }
  let address: URL;
  try {
    address = new URL(previewOrigin);
  } catch {
    return false;
  }
  return address.origin === previewOrigin && address.protocol === 'http:' && address.hostname === '127.0.0.1' && previewOrigin !== location.origin;
}

function fatal(message: string): void {
  byId('piece-line').textContent = message;
  byId('preview-empty').textContent = message;
  for (const id of ['save', 'save-all', 'build', 'check']) {
    byId<HTMLButtonElement>(id).disabled = true;
  }
}

/**
 * Where the tab keeps its one-time resume token, so that a reload reopens the
 * editor by itself (D195): session storage, which belongs to this tab and this
 * origin alone. Never the session token, which stays in memory.
 */
const RESUME_KEY = 'papeleria-resume';

/** Takes the tab's resume token out of storage, so it is never presented twice; null when there is none or storage is off. */
function takeResumeToken(): string | null {
  try {
    const resumeToken = sessionStorage.getItem(RESUME_KEY);
    sessionStorage.removeItem(RESUME_KEY);
    return resumeToken !== null && /^[0-9a-f]{64}$/.test(resumeToken) ? resumeToken : null;
  } catch {
    return null;
  }
}

/** Keeps the tab's next resume token for a reload. */
function keepResumeToken(resumeToken: string): void {
  try {
    sessionStorage.setItem(RESUME_KEY, resumeToken);
  } catch {
    // Storage is off in this browser: a reload asks for an address, as before D195.
  }
}

const NO_ADDRESS = 'Open the editor with the newest address Papeleria printed in the terminal: paste it into this tab, or open it in a new one.';
const RESUME_REFUSED = 'This tab could not reopen the editor by itself. Paste the newest address Papeleria printed in the terminal into this tab, or open it in a new one.';

/**
 * Whether the page holds the session token or is redeeming a token for it.
 * Until then, a launch address pasted into this tab, which changes only the
 * fragment and so does not reload the page, is read on `hashchange`; from
 * then on a fragment is removed unread, so a page holding this window cannot
 * start it again by setting its fragment (D192). A token refused, or a start
 * that fails after it, lets it go, and the page reads the next address (D173).
 */
let redeeming = false;

async function main(): Promise<void> {
  addEventListener('hashchange', () => {
    if (!location.hash.startsWith('#token=')) {
      return;
    }
    const launchToken = takeLaunchToken();
    if (launchToken !== null && !redeeming) {
      void open(launchToken, 'address');
    }
  });
  // An address the page was opened with comes first; the tab's resume token stays until an opening replaces it.
  const launchToken = takeLaunchToken();
  if (launchToken !== null) {
    await open(launchToken, 'address');
    return;
  }
  const resumeToken = takeResumeToken();
  if (resumeToken !== null) {
    await open(resumeToken, 'resume');
    return;
  }
  fatal(NO_ADDRESS);
}

/**
 * Redeems a launch token, or the tab's resume token after a reload, for the
 * session token (D192, D195), keeps the next resume token, takes the piece
 * and starts; or says why not, and waits for an address.
 */
async function open(launchToken: string, from: 'address' | 'resume'): Promise<void> {
  redeeming = true;
  let token: string;
  try {
    const keys = await redeemLaunchToken(launchToken);
    token = keys.token;
    keepResumeToken(keys.resumeToken);
  } catch (error) {
    redeeming = false;
    const refused = error instanceof ApiError && error.status === 401;
    fatal(error instanceof ConnectionError ? STOPPED : from === 'resume' && refused ? RESUME_REFUSED : (error as Error).message);
    return;
  }
  const api: Api = createApi(token);
  // From here a start that fails lets the session token go with the address it came from, and the page waits for
  // another, as for a refused address (D173): the editor never ran, so no pasted address can cost a buffer (PRR-03).
  const failed = (message: string): void => {
    redeeming = false;
    fatal(message);
  };
  let piece: PieceSnapshot;
  try {
    piece = await api.get<PieceSnapshot>('/api/piece');
  } catch (error) {
    failed(error instanceof ConnectionError || (error instanceof ApiError && error.status === 401) ? STOPPED : `The piece could not be opened: ${(error as Error).message}`);
    return;
  }
  if (!previewIsolated(piece.previewOrigin)) {
    failed('The preview has no address of its own, so the editor did not open. Stop Papeleria and start it again.');
    return;
  }
  if (piece.manifestPath === null || piece.manifestText === null || piece.manifestRevision === null) {
    failed(`${piece.folder} has no single manifest to edit.`);
    return;
  }
  new App(api, piece).start();
}

class App {
  readonly #api: Api;
  readonly #piece: PieceSnapshot;
  readonly #tabs: TabSet;
  readonly #diagnostics: Diagnostics;
  readonly #preview: Preview;
  /** Every approved file's revision as last known: the snapshot, then events and saves. */
  readonly #known = new Map<string, {kind: 'text' | 'data'; revision: string | null}>();
  #template: TemplateName;
  #schema: unknown;
  #lastChangeAt = performance.now();
  #shownAt = 0;
  #shownWeight: Weight | null = null;
  /** A deck's slides that do not fit their printed page, in the generation shown (D167, D174). */
  #overflow: readonly number[] = [];
  #dirtySince: number | null = null;
  #note = '';
  #stopped = false;
  #stream: EventSubscription | null = null;
  /** Events that came on a stream while the page was taking a new snapshot for it, applied after it (#greeted). */
  #held: {readonly stream: EventSubscription; readonly events: HeldEvent[]} | null = null;
  #retry: number | null = null;
  #lastAppliedReport = 0;

  constructor(api: Api, piece: PieceSnapshot) {
    this.#api = api;
    this.#piece = piece;
    this.#template = piece.template ?? 'deck';
    this.#schema = piece.schemas[this.#template];
    for (const file of piece.files) {
      this.#known.set(file.path, {kind: file.kind, revision: file.revision});
    }
    const nonce = document.querySelector<HTMLMetaElement>('meta[name="papeleria-style-nonce"]')?.content ?? '';
    this.#tabs = new TabSet({
      api,
      tablist: byId('tabs'),
      panels: byId('panels'),
      nonce,
      manifestMode: piece.manifestPath!.endsWith('.json') ? 'json' : 'yaml',
      schema: () => this.#schema,
      onEdit: (tab) => {
        this.#lastChangeAt = tab.lastInputAt;
        this.#preview.schedule();
      },
      onCursor: (tab, line) => {
        this.#diagnostics.cursorAt(tab.path, line);
        this.#preview.cursorAt(tab.path, line);
      },
      onChange: () => this.#chrome(),
      onActivate: (tab) => this.#diagnostics.tabOpened(tab),
      note: (text) => this.#setNote(text),
    });
    this.#diagnostics = new Diagnostics({
      tabs: this.#tabs,
      errors: byId<HTMLButtonElement>('count-errors'),
      warnings: byId<HTMLButtonElement>('count-warnings'),
      cursor: byId('cursor-message'),
      list: byId('diagnostics-list'),
      openAt: (location) => this.#openAt(location),
    });
    this.#preview = new Preview(
      {
        api,
        stage: byId('stage'),
        stale: byId('preview-stale'),
        empty: byId('preview-empty'),
        previewOrigin: piece.previewOrigin,
        editorOrigin: location.origin,
        snapshot: () => this.#snapshot(),
        onReport: (report, requestId) => this.#report(report, requestId),
        onShown: (report) => {
          this.#shownAt = performance.now();
          this.#shownWeight = report.weight;
          byId<HTMLButtonElement>('open-tab').disabled = false;
          this.#tick();
        },
        onFailed: (reason, shownBefore) => {
          const status = byId('status-preview');
          status.className = 'tone-error';
          status.textContent = 'errors' in reason ? failedLine(reason.errors, shownBefore) : reason.message;
          if (!shownBefore) {
            byId('preview-empty').textContent = status.textContent;
          }
        },
        onWaiting: () => {
          byId('preview-empty').textContent = 'Building the preview…';
        },
        onBlocked: (reason) => this.#setNote(reason),
        onPointer: (page, x, y) => {
          byId('pointer-readout').textContent = pointerLine(page, x, y);
        },
        // Off the page images the readout keeps no place the pointer has left (W5R-20).
        onPointerLeft: () => {
          byId('pointer-readout').textContent = POINTER_PROMPT;
        },
        onOverflow: (slides) => {
          this.#overflow = slides;
          this.#tick();
        },
        onConflict: (conflicts) => {
          for (const conflict of conflicts) {
            void this.#tabs.diskChanged(conflict.path, conflict.currentRevision);
          }
        },
        onConnectionLost: () => this.#lost(),
        onReturnFocus: () => this.#returnFocus(),
      },
      piece.lastRequestId,
    );
  }

  start(): void {
    const piece = this.#piece;
    byId('wordmark').textContent = piece.wordmark;
    document.title = `${piece.folder} · Papeleria editor`;
    this.#pieceLine();
    this.#tabs.openManifest(piece.manifestPath!, piece.manifestText!, piece.manifestRevision!, piece.manifestLineEnding);
    this.#files();
    this.#wire();
    // The first preview is asked for once the event stream is open (#greeted).
    this.#connect(piece.lastEventId);
    window.setInterval(() => this.#tick(), 1000);
  }

  // ---------------------------------------------------------------------------
  // What a request carries

  #snapshot(): Snapshot | {blocked: string} {
    // The template, language and status as typed, once per request: a template whose renderer is still to come gives no report.
    this.#followTemplate();
    const conflicted = this.#tabs.tabs.find((tab) => tab.conflict !== null);
    if (conflicted !== undefined) {
      return {blocked: `Preview paused: ${conflicted.path} changed on disk. Reload it, or keep yours.`};
    }
    const manifest = this.#tabs.manifest!;
    const active = this.#tabs.active ?? manifest;
    const view = active.view ?? manifest.view!;
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    return {
      manifestPath: manifest.path,
      manifestText: this.#tabs.text(manifest),
      manifestBaseRevision: manifest.baseRevision!,
      overlays: this.#tabs.tabs
        .filter((tab) => tab.kind === 'text' && tab.dirty && tab.baseRevision !== null)
        .map((tab) => ({path: tab.path, content: this.#tabs.text(tab), baseRevision: tab.baseRevision!})),
      cursor: {path: active.view === null ? manifest.path : active.path, line: line.number, column: head - line.from + 1},
      lastInputAt: this.#lastChangeAt,
    };
  }

  #report(report: Report, requestId: number): void {
    if (requestId > this.#lastAppliedReport) {
      this.#lastAppliedReport = requestId;
      this.#diagnostics.apply(report.findings);
    }
  }

  /** The manifest buffer's template, language and status, for the header and the schema. */
  #followTemplate(): void {
    const view = this.#tabs.manifest?.view;
    if (view === null || view === undefined) {
      return;
    }
    const value = documentValue(view.state, this.#tabs.manifest!.path.endsWith('.json') ? 'json' : 'yaml') as Record<string, unknown> | undefined;
    const template = value?.['template'];
    if (typeof template === 'string' && (TEMPLATES as readonly string[]).includes(template) && template !== this.#template) {
      this.#template = template as TemplateName;
      this.#schema = this.#piece.schemas[this.#template];
      this.#tabs.setSchema(this.#schema);
    }
    const language = typeof value?.['language'] === 'string' ? value['language'] : 'en';
    const status = typeof value?.['status'] === 'string' ? value['status'] : 'draft';
    this.#pieceLine(language, status);
    byId('grid').hidden = this.#template !== 'comic';
    byId('pointer-readout').hidden = this.#template !== 'comic' || byId('grid').getAttribute('aria-pressed') !== 'true';
  }

  #pieceLine(language = this.#piece.language ?? 'en', status = this.#piece.status ?? 'draft'): void {
    byId('piece-line').textContent = [this.#piece.folder, this.#template, language, status].join(' · ');
  }

  // ---------------------------------------------------------------------------
  // Status, buttons and the banner

  #setNote(text: string): void {
    this.#note = text;
    byId('status-note').textContent = text;
  }

  #tick(): void {
    const status = byId('status-preview');
    if (!this.#preview.stale && this.#preview.shown !== null) {
      const line = previewLine(this.#shownWeight, (performance.now() - this.#shownAt) / 1000, this.#overflow);
      status.className = `tone-${line.tone}`;
      status.textContent = line.text;
    }
    const dirty = this.#tabs.anyDirty();
    if (!dirty) {
      this.#dirtySince = null;
    } else {
      this.#dirtySince ??= performance.now();
      if (performance.now() - this.#dirtySince >= 30_000 && this.#note !== 'Unsaved changes') {
        this.#setNote('Unsaved changes');
      }
    }
  }

  #chrome(): void {
    const active = this.#tabs.active;
    const dirty = this.#tabs.anyDirty();
    const conflicted = this.#tabs.anyConflict();
    const off = this.#stopped;
    byId<HTMLButtonElement>('save').disabled = off || active === null || !active.dirty || active.kind === 'data';
    byId<HTMLButtonElement>('save-all').disabled = off || !dirty;
    const build = byId<HTMLButtonElement>('build');
    build.disabled = off || dirty || conflicted;
    byId('build-hint').hidden = !(dirty || conflicted);
    byId<HTMLButtonElement>('check').disabled = off || conflicted;
    this.#banner();
  }

  #banner(): void {
    const banner = byId('banner');
    const text = byId('banner-text');
    const reload = byId<HTMLButtonElement>('banner-reload');
    const keep = byId<HTMLButtonElement>('banner-keep');
    if (this.#stopped) {
      banner.hidden = false;
      banner.classList.add('is-stopped');
      text.textContent = STOPPED;
      reload.hidden = true;
      keep.hidden = true;
      return;
    }
    banner.classList.remove('is-stopped');
    const active = this.#tabs.active;
    const tab = active?.conflict !== null && active !== null ? active : this.#tabs.tabs.find((each) => each.conflict !== null);
    if (tab === undefined || tab.conflict === null) {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    banner.dataset['path'] = tab.path;
    const gone = tab.conflict.currentRevision === null;
    text.textContent = gone ? `${tab.path} was removed from disk. Copy what you need, then close its tab.` : `${tab.path} changed on disk. Reload it, or keep yours.`;
    reload.hidden = gone;
    keep.hidden = gone;
  }

  // ---------------------------------------------------------------------------
  // Files

  #files(): void {
    const list = byId('files');
    const groups: [string, 'text' | 'data'][] = [
      ['Markdown', 'text'],
      ['Data, read-only', 'data'],
    ];
    const content = document.createDocumentFragment();
    for (const [title, kind] of groups) {
      const paths = [...this.#known].filter(([, file]) => file.kind === kind && file.revision !== null).map(([path]) => path).sort();
      if (paths.length === 0) {
        continue;
      }
      content.append(element('h2', {}, title));
      const items = element('ul');
      for (const path of paths) {
        const button = element('button', {type: 'button', 'data-path': path}, path);
        button.addEventListener('click', () => {
          this.#toggleFiles(false);
          void this.#open(path);
        });
        const item = element('li');
        item.append(button);
        items.append(item);
      }
      content.append(items);
    }
    if (content.childNodes.length === 0) {
      content.append(element('p', {class: 'preview-empty'}, 'No Markdown or CSV files under assets/ yet.'));
    }
    list.replaceChildren(content);
  }

  #toggleFiles(open?: boolean): void {
    const list = byId('files');
    const toggle = byId('files-toggle');
    const show = open ?? list.hidden;
    list.hidden = !show;
    toggle.setAttribute('aria-expanded', String(show));
    if (show) {
      list.querySelector<HTMLButtonElement>('button')?.focus();
    }
  }

  async #open(path: string): Promise<Tab | null> {
    try {
      const tab = await this.#tabs.open(path);
      this.#diagnostics.tabOpened(tab);
      tab.view?.focus();
      return tab;
    } catch (error) {
      this.#failure(error, `${path} could not be opened`);
      return null;
    }
  }

  async #openAt(location: Location): Promise<boolean> {
    const openable = location.file === this.#tabs.manifest?.path || this.#known.has(location.file);
    if (!openable) {
      this.#setNote(`${locationText(location)} is not a file the editor opens.`);
      return false;
    }
    const tab = this.#tabs.tab(location.file) ?? (await this.#open(location.file));
    if (tab === null) {
      return false;
    }
    this.#tabs.reveal(tab, location.line, location.column);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Saving, building, checking

  async #save(): Promise<void> {
    const tab = this.#tabs.active;
    if (tab === null || this.#stopped) {
      return;
    }
    try {
      const outcome = await this.#tabs.save(tab);
      if (outcome === 'saved') {
        this.#known.set(tab.path, {kind: tab.kind === 'data' ? 'data' : 'text', revision: tab.baseRevision});
        this.#setNote(savedLine(new Date()));
      } else if (outcome === 'conflict') {
        this.#setNote(`${tab.path} was not saved: it changed on disk.`);
      }
    } catch (error) {
      this.#failure(error, `${tab.path} was not saved`);
    }
  }

  async #saveAll(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    try {
      const {saved, stoppedAt} = await this.#tabs.saveAll();
      for (const path of saved) {
        const tab = this.#tabs.tab(path);
        if (tab !== undefined && tab.kind === 'text') {
          this.#known.set(path, {kind: 'text', revision: tab.baseRevision});
        }
      }
      const count = `${saved.length} ${saved.length === 1 ? 'file' : 'files'}`;
      this.#setNote(
        stoppedAt === null
          ? `${savedLine(new Date())} · ${count}`
          : `Saved ${count}, then stopped: ${stoppedAt} changed on disk. The files after it were not saved.`,
      );
    } catch (error) {
      this.#failure(error, 'Save all stopped');
    }
  }

  async #build(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    if (this.#tabs.anyDirty() || this.#tabs.anyConflict()) {
      this.#setNote(BUILD_HINT);
      return;
    }
    const expectedRevisions: Record<string, string | null> = {};
    for (const [path, file] of this.#known) {
      expectedRevisions[path] = file.revision;
    }
    for (const tab of this.#tabs.tabs) {
      expectedRevisions[tab.path] = tab.baseRevision;
    }
    this.#setNote('Building…');
    try {
      const reply = await this.#api.send<BuildReply>('POST', '/api/build', {expectedRevisions});
      if (reply.report === undefined) {
        this.#setNote(reply.message ?? 'The build could not run.');
        return;
      }
      const report = reply.report;
      this.#diagnostics.apply(report.findings);
      const counts = tally(report.errors, report.warnings);
      this.#setNote(
        report.outputReason === 'written'
          ? `Built ${this.#piece.folder}/dist · ${counts}`
          : report.outputReason === 'withheld'
            ? `${this.#piece.folder} is withheld: nothing was written to dist/ · ${counts}`
            : `${this.#piece.folder} was not built: nothing was written to dist/ · ${counts}`,
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && Array.isArray(error.body['changed'])) {
        for (const changed of error.body['changed'] as {path: string; currentRevision: string | null}[]) {
          await this.#tabs.diskChanged(changed.path, changed.currentRevision);
        }
        this.#setNote('Nothing was built: files changed on disk since the editor read them.');
        return;
      }
      this.#failure(error, 'The build did not run');
    }
  }

  async #check(): Promise<void> {
    const snapshot = this.#snapshot();
    if ('blocked' in snapshot) {
      this.#setNote(snapshot.blocked);
      return;
    }
    const requestId = this.#preview.nextRequestId();
    this.#setNote('Checking the open buffers…');
    try {
      const reply = await this.#api.send<{report?: Report; message?: string}>('POST', '/api/check', {
        requestId,
        manifestPath: snapshot.manifestPath,
        manifestText: snapshot.manifestText,
        manifestBaseRevision: snapshot.manifestBaseRevision,
        overlays: snapshot.overlays,
        cursor: snapshot.cursor,
      });
      if (reply.report === undefined) {
        this.#setNote(reply.message ?? 'The check could not run.');
        return;
      }
      if (requestId > this.#lastAppliedReport) {
        this.#lastAppliedReport = requestId;
        this.#diagnostics.apply(reply.report.findings);
      }
      this.#setNote(`Checked the open buffers, unsaved changes included · ${tally(reply.report.errors, reply.report.warnings)}`);
    } catch (error) {
      this.#failure(error, 'The check did not run');
    }
  }

  #failure(error: unknown, what: string): void {
    if (error instanceof ConnectionError) {
      this.#lost();
      return;
    }
    this.#setNote(`${what}: ${error instanceof Error ? error.message : String(error)}`);
  }

  // ---------------------------------------------------------------------------
  // The event stream and a lost connection

  /** Opens the event stream for a page whose snapshot was taken at event `since`. */
  #connect(since: number): void {
    const stream = this.#api.events(
      (event) => {
        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(event.data) as Record<string, unknown>;
        } catch {
          return;
        }
        if (event.event === 'hello') {
          void this.#greeted(stream, since, data);
        } else if (this.#held?.stream === stream) {
          this.#held.events.push({id: Number(event.id), name: event.event, data});
        } else {
          this.#event(event.event, data);
        }
      },
      () => {
        this.#stream = null;
        this.#lost();
      },
    );
    this.#stream = stream;
  }

  /**
   * The stream is open, and its `hello` names the last event the server sent
   * before it. The server keeps no events for a stream not yet open, so one
   * sent after the page's snapshot and before `hello` never reaches the page:
   * when the ids differ, it takes a new snapshot, holding the events that
   * come meanwhile and applying those newer than it. Only then does it ask
   * for a preview, whose `preview-built` would otherwise be lost the same way,
   * leaving the preview waiting for it. A stream that ends meanwhile leaves
   * the rest to recovery, which takes its own snapshot.
   */
  async #greeted(stream: EventSubscription, since: number, hello: Readonly<Record<string, unknown>>): Promise<void> {
    if (hello['lastEventId'] !== since) {
      const held = {stream, events: [] as HeldEvent[]};
      this.#held = held;
      const release = (): void => {
        if (this.#held === held) {
          this.#held = null;
        }
      };
      let snapshot: PieceSnapshot;
      try {
        snapshot = await this.#api.get<PieceSnapshot>('/api/piece');
      } catch {
        release();
        if (this.#stream === stream) {
          this.#lost();
        }
        return;
      }
      if (this.#stream !== stream) {
        release();
        return;
      }
      await this.#reconcile(snapshot);
      release();
      for (const event of held.events) {
        if (!(event.id <= snapshot.lastEventId)) {
          this.#event(event.name, event.data);
        }
      }
    }
    if (this.#stream === stream) {
      this.#preview.schedule(0);
    }
  }

  #event(name: string, data: Readonly<Record<string, unknown>>): void {
    switch (name) {
      case 'preview-built':
      case 'build-failed':
        this.#preview.event(name, data);
        break;
      case 'file-changed': {
        const path = typeof data['path'] === 'string' ? data['path'] : '';
        const kind = data['kind'];
        const revision = typeof data['revision'] === 'string' ? data['revision'] : null;
        if (kind === 'text' || kind === 'data') {
          if (revision === null) {
            this.#known.delete(path);
          } else {
            this.#known.set(path, {kind, revision});
          }
          this.#files();
        }
        if (kind === 'text' || kind === 'data' || kind === 'manifest') {
          void this.#tabs.diskChanged(path, revision);
        }
        this.#lastChangeAt = performance.now();
        this.#preview.schedule();
        break;
      }
    }
  }

  #lost(): void {
    if (!this.#stopped) {
      this.#stopped = true;
      this.#stream?.close();
      this.#stream = null;
      this.#chrome();
    }
    if (this.#retry === null) {
      this.#retry = window.setTimeout(() => {
        this.#retry = null;
        void this.#recover();
      }, 2000);
    }
  }

  /** The server answers again: take its whole snapshot, recheck every open tab, then carry on. */
  async #recover(): Promise<void> {
    let snapshot: PieceSnapshot;
    try {
      snapshot = await this.#api.get<PieceSnapshot>('/api/piece');
    } catch {
      this.#lost();
      return;
    }
    await this.#reconcile(snapshot);
    this.#stopped = false;
    this.#lastChangeAt = performance.now();
    // The preview is asked for once the new stream is open (#greeted).
    this.#connect(snapshot.lastEventId);
    this.#chrome();
  }

  /** Takes a snapshot's files and revisions as the page's, and rechecks every open tab against them. */
  async #reconcile(snapshot: PieceSnapshot): Promise<void> {
    this.#known.clear();
    for (const file of snapshot.files) {
      this.#known.set(file.path, {kind: file.kind, revision: file.revision});
    }
    this.#files();
    for (const tab of this.#tabs.tabs) {
      const revision = tab.kind === 'manifest' ? snapshot.manifestRevision : (this.#known.get(tab.path)?.revision ?? null);
      await this.#tabs.diskChanged(tab.path, revision);
    }
  }

  /**
   * Escape came back from the preview (IC06 `returnFocus`): the last source
   * tab takes focus again, its selection as it was. The frame holds focus at
   * that moment, and not every engine moves it out of a frame on a focus()
   * call alone: Firefox keeps it there until this page's window is focused
   * again. So the window is focused first, and the move is checked once more
   * after the key event that caused it has finished.
   */
  #returnFocus(): void {
    const take = (): void => {
      window.focus();
      this.#tabs.focusActive();
    };
    take();
    window.setTimeout(() => {
      if (document.activeElement instanceof HTMLIFrameElement) {
        take();
      }
    }, 50);
  }

  // ---------------------------------------------------------------------------
  // Controls

  #wire(): void {
    byId('save').addEventListener('click', () => void this.#save());
    byId('save-all').addEventListener('click', () => void this.#saveAll());
    byId('build').addEventListener('click', () => void this.#build());
    byId('check').addEventListener('click', () => void this.#check());
    byId('files-toggle').addEventListener('click', () => this.#toggleFiles());
    byId('banner-reload').addEventListener('click', () => {
      const tab = this.#tabs.tab(byId('banner').dataset['path'] ?? '');
      if (tab !== undefined) {
        void this.#tabs.reload(tab).catch((error: unknown) => this.#failure(error, `${tab.path} could not be reloaded`));
      }
    });
    byId('banner-keep').addEventListener('click', () => {
      const tab = this.#tabs.tab(byId('banner').dataset['path'] ?? '');
      if (tab !== undefined && this.#tabs.keepMine(tab)) {
        this.#setNote(`Kept your ${baseName(tab.path)}. Saving checks the disk again.`);
      }
    });

    for (const button of document.querySelectorAll<HTMLButtonElement>('.preview-widths button')) {
      button.addEventListener('click', () => {
        for (const other of document.querySelectorAll<HTMLButtonElement>('.preview-widths button')) {
          other.setAttribute('aria-pressed', String(other === button));
        }
        this.#preview.setWidth(Number(button.dataset['width'] ?? DEVICE_WIDTHS.desktop));
      });
    }
    const follow = byId('follow');
    follow.addEventListener('click', () => {
      const on = follow.getAttribute('aria-pressed') !== 'true';
      follow.setAttribute('aria-pressed', String(on));
      this.#preview.setFollow(on);
    });
    const grid = byId('grid');
    grid.addEventListener('click', () => {
      const on = grid.getAttribute('aria-pressed') !== 'true';
      grid.setAttribute('aria-pressed', String(on));
      this.#preview.setGrid(on);
      // The readout shows where the pointer is over a page while the grid is on (UX §08, D3).
      const readout = byId('pointer-readout');
      readout.hidden = !on;
      readout.textContent = on ? POINTER_PROMPT : '';
    });
    byId('open-tab').addEventListener('click', () => this.#preview.openInNewTab());

    window.addEventListener('keydown', (event) => {
      if (event.defaultPrevented) {
        return;
      }
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && !event.altKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void this.#save();
      } else if (modifier && !event.altKey && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        void this.#build();
      } else if (event.key === 'Escape' && !byId('files').hidden) {
        event.preventDefault();
        this.#toggleFiles(false);
        byId('files-toggle').focus();
      }
    });
    window.addEventListener('beforeunload', (event) => {
      if (this.#tabs.anyDirty()) {
        event.preventDefault();
        event.returnValue = '';
      }
    });
    this.#divider();
    this.#chrome();
  }

  /** The split: dragged with a pointer, or moved with the arrow keys; 30 % to 70 % (UX §08). */
  #divider(): void {
    const divider = byId('divider');
    const main = byId('editor-main');
    const stacked = (): boolean => window.matchMedia('(max-width: 900px)').matches;
    const set = (percent: number): void => {
      const value = Math.min(70, Math.max(30, Math.round(percent)));
      main.style.setProperty('--split', `${value}%`);
      divider.setAttribute('aria-valuenow', String(value));
    };
    divider.addEventListener('pointerdown', (event) => {
      divider.setPointerCapture(event.pointerId);
      const move = (moved: PointerEvent): void => {
        const box = main.getBoundingClientRect();
        set(stacked() ? ((moved.clientY - box.top) / box.height) * 100 : ((moved.clientX - box.left) / box.width) * 100);
      };
      const up = (): void => {
        divider.removeEventListener('pointermove', move);
        divider.removeEventListener('pointerup', up);
      };
      divider.addEventListener('pointermove', move);
      divider.addEventListener('pointerup', up);
    });
    divider.addEventListener('keydown', (event) => {
      const now = Number(divider.getAttribute('aria-valuenow') ?? 50);
      const steps: Record<string, number> = {ArrowLeft: -2, ArrowUp: -2, ArrowRight: 2, ArrowDown: 2};
      if (event.key in steps) {
        event.preventDefault();
        set(now + steps[event.key]!);
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        set(event.key === 'Home' ? 30 : 70);
      }
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void main(), {once: true});
} else {
  void main();
}

