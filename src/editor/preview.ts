/**
 * M2.3: the live preview (IC06, D09, D83, D84, UX §08).
 *
 * 500 ms after the last change the editor sends a `PreviewRequest`: the
 * manifest buffer with its base revision, every dirty Markdown buffer with
 * its own, and the cursor. Request ids increase for the whole session, and a
 * reply to anything but the latest request sent is ignored, so an older
 * response never replaces a newer preview or its diagnostics. A reply is
 * shown once both it and the matching `preview-built` event have arrived.
 *
 * Frames are double-buffered: the new generation loads in a hidden frame and
 * is shown when its bridge says `ready`, so the author never sees a blank
 * page between builds. The place is kept: with Follow on, the cursor's target
 * (its fragment is in the new frame's address, so the page opens there);
 * otherwise wherever the page last was, from the bridge's `ready` and
 * `scroll` messages. The frame is sandboxed (`allow-scripts
 * allow-same-origin allow-modals allow-popups`, IC06) on the preview origin,
 * and every message from it passes `acceptToEditor`: the preview origin, that
 * frame's window, that frame's generation, one of IC06's shapes.
 *
 * The time from the last change to a shown generation is recorded as a
 * `performance.measure` named `papeleria:preview`, which A9 reads; it stays
 * in the page.
 *
 * A comic (M4.4, D117): Grid stays on across generations, sent to each frame
 * as it is shown, and the frame's `pointer` messages reach `onPointer`, its
 * `pointerLeft` messages `onPointerLeft` (D174). A deck's frame reports the
 * slides that do not fit their printed page as `overflow`, kept with that
 * frame and passed to `onOverflow` while it is shown (D167, D174). With
 * Follow on, a panel opens the frame at its page, not in guided view, and a
 * `goto` then marks the panel there.
 */
import {
  acceptToEditor,
  sameTarget,
  targetAt,
  targetFragment,
  type SourceTarget,
  type Target,
  type ToEditorMessage,
  type ToFrameMessage,
} from '../../templates/shared/preview-protocol.js';
import {ApiError, ConnectionError, type Api} from './api.js';
import type {Finding} from './diagnostics.js';
import {element} from './dom.js';
import type {Weight} from './status.js';

/** UX §08: the debounce, included in A9's two seconds. */
export const DEBOUNCE_MS = 500;

/** UX §08: Phone, Tablet and Desktop. */
export const DEVICE_WIDTHS = Object.freeze({phone: 390, tablet: 834, desktop: 1280});

export type Report = {
  readonly status: 'ok' | 'failed';
  readonly errors: number;
  readonly warnings: number;
  readonly findings: readonly Finding[];
  readonly weight: Weight | null;
  readonly targets: readonly SourceTarget[];
};

type Overlay = {path: string; content: string; baseRevision: string};

/** What the editor's buffers are now: what a preview or check request carries. */
export type Snapshot = {
  readonly manifestPath: string;
  readonly manifestText: string;
  readonly manifestBaseRevision: string;
  readonly overlays: readonly Overlay[];
  readonly cursor: {readonly path: string; readonly line: number; readonly column: number};
  /** When the newest change was made. */
  readonly lastInputAt: number;
};

type Reply =
  | {requestId: number; superseded: true}
  | {requestId: number; errorCode: string; message: string}
  | {requestId: number; report: Report; cursorTarget: Target | null; generationId: string | null; generationURL: string | null};

type Frame = {
  readonly iframe: HTMLIFrameElement;
  readonly generationId: string;
  readonly generationURL: string;
  readonly requestId: number;
  readonly lastInputAt: number;
  ready: boolean;
  /** A deck's slides that do not fit their printed page, once the frame has measured them (D174). */
  overflow: readonly number[];
};

export type PreviewOptions = {
  readonly api: Api;
  readonly stage: HTMLElement;
  readonly stale: HTMLElement;
  readonly empty: HTMLElement;
  readonly previewOrigin: string;
  readonly editorOrigin: string;
  /** The buffers now, or a reason no preview can be asked for (an unresolved conflict). */
  readonly snapshot: () => Snapshot | {blocked: string};
  /** A report arrived for the latest request. */
  readonly onReport: (report: Report, requestId: number) => void;
  /** A generation is shown, with the report it came with. */
  readonly onShown: (report: Report) => void;
  /** The latest request failed: errors in the report, or a tool failure. */
  readonly onFailed: (reason: {errors: number} | {message: string}, shownBefore: boolean) => void;
  readonly onWaiting: () => void;
  readonly onBlocked: (reason: string) => void;
  readonly onConflict: (conflicts: readonly {path: string; currentRevision: string | null}[]) => void;
  readonly onConnectionLost: () => void;
  /** Escape reached the preview with nothing left to close (IC06 `returnFocus`). */
  readonly onReturnFocus: () => void;
  /** The pointer over a comic page in the shown frame, in percent, while Grid is on (IC06 `pointer`, M4.4). */
  readonly onPointer?: (page: number, x: number, y: number) => void;
  /** The pointer left the shown frame's page images, while Grid is on (IC06 `pointerLeft`, D174). */
  readonly onPointerLeft?: () => void;
  /** A deck's slides that do not fit their printed page in the frame shown; none until it has measured them (IC06 `overflow`, D174). */
  readonly onOverflow?: (slides: readonly number[]) => void;
};

/** Where a frame opens for a target: a panel's page, so the page shows whole and `goto` marks the panel (D117). */
function frameFragment(target: Target): string {
  return targetFragment(target.kind === 'panel' ? {kind: 'page', page: target.page} : target);
}

export class Preview {
  readonly #options: PreviewOptions;
  #lastRequestId: number;
  #latestSent = 0;
  #timer: number | null = null;
  #replies = new Map<number, Reply>();
  #built = new Map<number, {generationId: string; generationURL: string}>();
  #front: Frame | null = null;
  #back: Frame | null = null;
  #place: {hash: string; scrollY: number} = {hash: '', scrollY: 0};
  #targets: readonly SourceTarget[] = [];
  #followed: Target | null = null;
  #follow = true;
  #grid = false;
  #width: number = DEVICE_WIDTHS.desktop;
  #failed = false;
  #lastInputAt = 0;
  /** The report of the generation loading in the back frame, shown with it. */
  #pendingReport: Report | null = null;

  constructor(options: PreviewOptions, lastRequestId: number) {
    this.#options = options;
    this.#lastRequestId = lastRequestId;
    window.addEventListener('message', (event) => this.#message(event));
    new ResizeObserver(() => this.#layout()).observe(options.stage);
  }

  /** The generation shown, or null before the first. */
  get shown(): {generationId: string; generationURL: string} | null {
    return this.#front === null ? null : {generationId: this.#front.generationId, generationURL: this.#front.generationURL};
  }

  get follow(): boolean {
    return this.#follow;
  }

  get width(): number {
    return this.#width;
  }

  /** The next request id: after the last one this page or an earlier one used. */
  nextRequestId(): number {
    this.#lastRequestId += 1;
    return this.#lastRequestId;
  }

  /** A buffer changed: preview again once the author has paused for 500 ms. */
  schedule(delay = DEBOUNCE_MS): void {
    if (this.#timer !== null) {
      window.clearTimeout(this.#timer);
    }
    this.#timer = window.setTimeout(() => {
      this.#timer = null;
      void this.request();
    }, delay);
  }

  /** Sends a preview request for the buffers as they are now. */
  async request(): Promise<void> {
    const snapshot = this.#options.snapshot();
    if ('blocked' in snapshot) {
      this.#options.onBlocked(snapshot.blocked);
      return;
    }
    const requestId = this.nextRequestId();
    this.#latestSent = requestId;
    this.#lastInputAt = snapshot.lastInputAt;
    if (this.#front === null) {
      this.#options.onWaiting();
    }
    const body = {
      requestId,
      manifestPath: snapshot.manifestPath,
      manifestText: snapshot.manifestText,
      manifestBaseRevision: snapshot.manifestBaseRevision,
      overlays: snapshot.overlays,
      cursor: snapshot.cursor,
    };
    let reply: Reply;
    try {
      reply = await this.#options.api.send<Reply>('POST', '/api/preview', body);
    } catch (error) {
      this.#refused(error, requestId);
      return;
    }
    this.#replies.set(requestId, reply);
    this.#settle(requestId);
  }

  #refused(error: unknown, requestId: number): void {
    if (error instanceof ConnectionError) {
      this.#options.onConnectionLost();
      return;
    }
    if (!(error instanceof ApiError) || requestId !== this.#latestSent) {
      return;
    }
    if (error.code === 'E_STALE_REQUEST' && typeof error.body['lastRequestId'] === 'number') {
      // Another page of this session asked meanwhile: carry on after its ids.
      this.#lastRequestId = Math.max(this.#lastRequestId, error.body['lastRequestId']);
      this.schedule(0);
      return;
    }
    if (error.code === 'E_CONFLICT' && Array.isArray(error.body['conflicts'])) {
      this.#options.onConflict(error.body['conflicts'] as {path: string; currentRevision: string | null}[]);
      return;
    }
    this.#options.onFailed({message: error.message}, this.#front !== null);
  }

  /** An event from the server's stream. */
  event(name: string, data: Readonly<Record<string, unknown>>): void {
    if (name === 'preview-built' && typeof data['requestId'] === 'number' && typeof data['generationId'] === 'string' && typeof data['generationURL'] === 'string') {
      this.#built.set(data['requestId'], {generationId: data['generationId'], generationURL: data['generationURL']});
      this.#settle(data['requestId']);
    }
  }

  /** Applies a reply once it is the latest request's and, when it has a generation, its build event has come. */
  #settle(requestId: number): void {
    const reply = this.#replies.get(requestId);
    if (reply === undefined) {
      return;
    }
    if (requestId !== this.#latestSent || 'superseded' in reply) {
      // An older response never replaces a newer preview or its diagnostics.
      this.#replies.delete(requestId);
      this.#built.delete(requestId);
      return;
    }
    if ('errorCode' in reply) {
      this.#replies.delete(requestId);
      this.#failed = true;
      this.#showStale();
      this.#options.onFailed({message: reply.message}, this.#front !== null);
      return;
    }
    if (reply.generationId !== null && !this.#built.has(requestId)) {
      return;
    }
    this.#replies.delete(requestId);
    this.#built.delete(requestId);
    this.#targets = reply.report.targets;
    this.#options.onReport(reply.report, requestId);
    if (reply.generationId === null || reply.generationURL === null) {
      this.#failed = true;
      this.#showStale();
      this.#options.onFailed({errors: reply.report.errors}, this.#front !== null);
      return;
    }
    if (this.#follow && reply.cursorTarget !== null) {
      this.#place = {hash: frameFragment(reply.cursorTarget), scrollY: 0};
      this.#followed = reply.cursorTarget;
    }
    this.#load(reply.generationId, reply.generationURL, requestId, reply.report);
  }

  #frameAddress(generationURL: string, hash: string): string {
    return `${generationURL}?parent=${encodeURIComponent(this.#options.editorOrigin)}${hash}`;
  }

  #load(generationId: string, generationURL: string, requestId: number, report: Report): void {
    if (this.#back !== null) {
      this.#back.iframe.remove();
    }
    const iframe = element('iframe', {
      class: 'preview-frame is-loading',
      title: 'Preview of the piece',
      sandbox: 'allow-scripts allow-same-origin allow-modals allow-popups',
      allow: 'fullscreen',
      referrerpolicy: 'no-referrer',
      'data-generation-id': generationId,
      'data-request-id': String(requestId),
    });
    const frame: Frame = {iframe, generationId, generationURL, requestId, lastInputAt: this.#lastInputAt, ready: false, overflow: []};
    this.#back = frame;
    this.#pendingReport = report;
    this.#size(iframe);
    // A page whose bridge never answers (it failed to start) is shown all the same, a moment after it loads.
    iframe.addEventListener(
      'load',
      () => {
        window.setTimeout(() => {
          if (this.#back === frame && !frame.ready) {
            frame.ready = true;
            this.#swap(frame);
          }
        }, 3000);
      },
      {once: true},
    );
    iframe.src = this.#frameAddress(generationURL, this.#place.hash);
    this.#options.stage.append(iframe);
  }

  /** The back frame said `ready`: show it and let the old one go. */
  #swap(frame: Frame): void {
    const old = this.#front;
    this.#front = frame;
    this.#back = null;
    frame.iframe.classList.remove('is-loading');
    old?.iframe.remove();
    this.#failed = false;
    this.#options.stage.classList.remove('is-stale');
    this.#options.stale.hidden = true;
    this.#options.empty.hidden = true;
    performance.measure('papeleria:preview', {start: frame.lastInputAt, end: performance.now(), detail: {requestId: frame.requestId, generationId: frame.generationId}});
    this.#options.stage.dataset['generationId'] = frame.generationId;
    this.#options.stage.dataset['requestId'] = String(frame.requestId);
    // The overflow the shown generation has, which is none until it has measured its slides.
    this.#options.onOverflow?.(frame.overflow);
    if (this.#pendingReport !== null) {
      this.#options.onShown(this.#pendingReport);
      this.#pendingReport = null;
    }
    if (!this.#follow && this.#place.scrollY > 0) {
      this.#post(frame, {type: 'restoreScroll', generationId: frame.generationId, y: this.#place.scrollY});
    }
    // Grid stays on from one generation to the next; a followed panel is marked on its page.
    if (this.#grid) {
      this.#post(frame, {type: 'grid', generationId: frame.generationId, on: true});
    }
    if (this.#follow && this.#followed?.kind === 'panel') {
      this.#post(frame, {type: 'goto', generationId: frame.generationId, target: this.#followed});
    }
  }

  #showStale(): void {
    if (this.#front !== null) {
      this.#options.stage.classList.add('is-stale');
      this.#options.stale.hidden = false;
    }
  }

  #post(frame: Frame, message: ToFrameMessage): void {
    frame.iframe.contentWindow?.postMessage(message, this.#options.previewOrigin);
  }

  #message(event: MessageEvent): void {
    for (const frame of [this.#front, this.#back]) {
      if (frame === null) {
        continue;
      }
      const message = acceptToEditor(
        {origin: event.origin, source: event.source, data: event.data},
        {origin: this.#options.previewOrigin, source: frame.iframe.contentWindow, generationId: frame.generationId},
      );
      if (message !== null) {
        this.#receive(frame, message);
        return;
      }
    }
  }

  #receive(frame: Frame, message: ToEditorMessage): void {
    switch (message.type) {
      case 'ready':
        // Where the page is: as it opened (the page may have corrected the address), or where the reader moved it.
        this.#place = {hash: message.hash, scrollY: this.#place.scrollY};
        if (frame === this.#back && !frame.ready) {
          frame.ready = true;
          this.#swap(frame);
        }
        frame.ready = true;
        break;
      case 'scroll':
        if (frame === this.#front) {
          this.#place = {hash: this.#place.hash, scrollY: message.y};
        }
        break;
      case 'returnFocus':
        if (frame === this.#front) {
          this.#options.onReturnFocus();
        }
        break;
      case 'pointer':
        if (frame === this.#front && this.#grid) {
          this.#options.onPointer?.(message.page, message.x, message.y);
        }
        break;
      case 'pointerLeft':
        if (frame === this.#front && this.#grid) {
          this.#options.onPointerLeft?.();
        }
        break;
      case 'overflow':
        frame.overflow = message.slides;
        if (frame === this.#front) {
          this.#options.onOverflow?.(message.slides);
        }
        break;
    }
  }

  /** The cursor moved: with Follow on, show its slide, page, panel or section. */
  cursorAt(path: string, line: number): void {
    const target = targetAt(this.#targets, path, line);
    if (target === null) {
      return;
    }
    if (this.#follow) {
      this.#place = {hash: frameFragment(target), scrollY: 0};
      if (!sameTarget(target, this.#followed) && this.#front !== null && this.#front.ready) {
        this.#post(this.#front, {type: 'goto', generationId: this.#front.generationId, target});
      }
      this.#followed = target;
    }
  }

  setFollow(on: boolean): void {
    this.#follow = on;
    this.#followed = null;
  }

  /** Grid on or off, for a comic: sent to the frame shown, and to each one shown after it (M4.4). */
  setGrid(on: boolean): void {
    this.#grid = on;
    if (this.#front !== null) {
      this.#post(this.#front, {type: 'grid', generationId: this.#front.generationId, on});
    }
  }

  get grid(): boolean {
    return this.#grid;
  }

  /** A device width; the frame keeps its place, since only its size changes. */
  setWidth(width: number): void {
    this.#width = width;
    this.#layout();
  }

  #size(iframe: HTMLIFrameElement): void {
    const stage = this.#options.stage.getBoundingClientRect();
    const scale = Math.min(1, stage.width / this.#width);
    iframe.style.width = `${this.#width}px`;
    iframe.style.height = `${Math.max(0, stage.height) / (scale || 1)}px`;
    iframe.style.transform = `scale(${scale})`;
    iframe.dataset['scale'] = String(scale);
  }

  #layout(): void {
    for (const frame of [this.#front, this.#back]) {
      if (frame !== null) {
        this.#size(frame.iframe);
      }
    }
  }

  /** Opens the generation shown, at its place, in a new tab: the page as a reader gets it, with no bridge talking. */
  openInNewTab(): void {
    if (this.#front !== null) {
      window.open(`${this.#front.generationURL}${this.#place.hash}`, '_blank', 'noopener');
    }
  }

  /** Whether the last request failed and the frame shows an older build. */
  get stale(): boolean {
    return this.#failed && this.#front !== null;
  }
}
