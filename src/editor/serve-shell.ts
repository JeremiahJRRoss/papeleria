/**
 * M2.6: `papeleria serve`'s read-only shell (IC09, D87).
 *
 * A page that shows the newest good preview of the piece's saved files and
 * reloads it when a file changes. It reads the serve origin's own event
 * stream with `EventSource` — same origin, no token, nothing it could change
 * — and shows each generation in a sandboxed frame from the preview origin,
 * double-buffered like the editor's, keeping the reader's place: the frame's
 * bridge reports where the page is (`ready`, `scroll`), and the shell writes
 * that fragment into its own address, so the address can be shared and a
 * reload opens the same slide. A build that fails keeps the last good one
 * showing, with a note. There is no editor here and no write of any kind.
 */
import {acceptToEditor, type ToEditorMessage} from '../../templates/shared/preview-protocol.js';
import {byId, element} from './dom.js';

type Shown = {readonly generationId: string; readonly generationURL: string};

type Frame = {readonly iframe: HTMLIFrameElement; readonly generationId: string; ready: boolean};

const STOPPED = 'Papeleria stopped. Start it again from the terminal.';

function start(): void {
  const stage = byId('stage');
  const note = byId('note');
  const empty = byId('empty');
  let front: Frame | null = null;
  let back: Frame | null = null;
  let hash = location.hash;
  let scrollY = 0;
  let previewOrigin = '';

  const say = (text: string): void => {
    note.textContent = text;
    note.hidden = text === '';
  };

  const swap = (frame: Frame): void => {
    const old = front;
    front = frame;
    back = null;
    frame.iframe.classList.remove('is-loading');
    old?.iframe.remove();
    empty.hidden = true;
    say('');
    if (scrollY > 0) {
      frame.iframe.contentWindow?.postMessage({type: 'restoreScroll', generationId: frame.generationId, y: scrollY}, previewOrigin);
    }
  };

  const load = (shown: Shown): void => {
    previewOrigin = new URL(shown.generationURL).origin;
    back?.iframe.remove();
    const iframe = element('iframe', {
      class: 'serve-frame is-loading',
      title: 'Preview of the piece',
      sandbox: 'allow-scripts allow-same-origin allow-modals allow-popups',
      allow: 'fullscreen',
      referrerpolicy: 'no-referrer',
    });
    const frame: Frame = {iframe, generationId: shown.generationId, ready: false};
    back = frame;
    iframe.addEventListener(
      'load',
      () => {
        window.setTimeout(() => {
          if (back === frame && !frame.ready) {
            frame.ready = true;
            swap(frame);
          }
        }, 3000);
      },
      {once: true},
    );
    iframe.src = `${shown.generationURL}?parent=${encodeURIComponent(location.origin)}${hash}`;
    stage.append(iframe);
  };

  window.addEventListener('message', (event: MessageEvent) => {
    for (const frame of [front, back]) {
      if (frame === null) {
        continue;
      }
      const message: ToEditorMessage | null = acceptToEditor(
        {origin: event.origin, source: event.source, data: event.data},
        {origin: previewOrigin, source: frame.iframe.contentWindow, generationId: frame.generationId},
      );
      if (message === null) {
        continue;
      }
      if (message.type === 'ready') {
        hash = message.hash;
        history.replaceState(null, '', `${location.pathname}${hash}`);
        if (frame === back && !frame.ready) {
          frame.ready = true;
          swap(frame);
        }
        frame.ready = true;
      } else if (message.type === 'scroll' && frame === front) {
        scrollY = message.y;
      }
      return;
    }
  });

  const events = new EventSource('events');
  events.addEventListener('hello', (event) => {
    say('');
    const data = JSON.parse((event as MessageEvent<string>).data) as {shown?: Shown | null; folder?: string};
    if (typeof data.folder === 'string') {
      document.title = `${data.folder} · Papeleria preview`;
    }
    if (data.shown !== null && data.shown !== undefined && data.shown.generationId !== front?.generationId) {
      load(data.shown);
    }
  });
  events.addEventListener('reload', (event) => {
    load(JSON.parse((event as MessageEvent<string>).data) as Shown);
  });
  events.addEventListener('build-failed', (event) => {
    const data = JSON.parse((event as MessageEvent<string>).data) as {errors?: number; message?: string};
    const what = typeof data.errors === 'number' ? `${data.errors} ${data.errors === 1 ? 'error' : 'errors'}` : (data.message ?? 'The build failed');
    say(front === null ? `${what}. The preview appears once they are fixed; the terminal lists them.` : `${what}. Showing the last good build; the terminal lists them.`);
  });
  events.addEventListener('error', () => {
    say(STOPPED);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, {once: true});
} else {
  start();
}
