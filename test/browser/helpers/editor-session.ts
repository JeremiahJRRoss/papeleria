/**
 * M2.7: an editing session for the browser suites — a piece copied into a
 * temporary folder, `startEditor` on it, and a page opened at the launch
 * address — and the page reads the suites share.
 *
 * Every edit a test makes goes through the real keyboard. To put the cursor
 * on a line, read a buffer or find where a word is drawn, the helpers reach
 * the active tab's CodeMirror view through the back-reference CodeMirror
 * keeps on its content element (`cmTile` in @codemirror/view 6.43, `cmView`
 * before it). That is CodeMirror's internal, used by the tests only; the
 * product exposes nothing for them. If a CodeMirror update renames it, the
 * helpers fail at once and say so.
 */
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

import type {Browser, BrowserContext, Frame, Page} from 'playwright';

import type {EditorSession, SessionHooks, startEditor} from '../../../src/server/index.js';
import {applicationRoot} from '../../helpers/paths.js';
import {copyPiece} from '../../helpers/pieces.js';

/**
 * The server as `npm run build` compiled it into `lib/src/`. The browser-test
 * program compiles only what its files import, and the checks load their
 * rules from their own folder, so the server must run from the full build.
 */
async function startSession(...args: Parameters<typeof startEditor>): Promise<EditorSession> {
  const server = (await import(pathToFileURL(join(applicationRoot, 'lib', 'src', 'server', 'index.js')).href)) as {startEditor: typeof startEditor};
  return server.startEditor(...args);
}

/** The parts of CodeMirror's `EditorView` the helpers use. */
type ViewLike = {
  readonly state: {
    readonly doc: {
      readonly lines: number;
      readonly length: number;
      toString(): string;
      line(number: number): {readonly from: number; readonly to: number; readonly text: string};
      lineAt(position: number): {readonly number: number};
    };
    readonly selection: {readonly main: {readonly head: number}};
  };
  readonly constructor: {scrollIntoView(position: number, options?: {y?: string}): unknown};
  dispatch(spec: unknown): void;
  update(transactions: readonly TransactionLike[]): void;
  focus(): void;
  coordsAtPos(position: number): {left: number; right: number; top: number; bottom: number} | null;
  posAtDOM(node: Node, offset?: number): number;
};

/** The parts of a CodeMirror `Transaction` `recordInput` reads. */
type TransactionLike = {
  readonly constructor: {readonly userEvent: unknown};
  annotation(type: unknown): unknown;
  readonly docChanged: boolean;
  readonly changes: {toJSON(): unknown};
  readonly selection: {readonly main: {readonly head: number}} | undefined;
  readonly effects: readonly unknown[];
  readonly state: {readonly selection: {readonly main: {readonly head: number}}};
};

declare global {
  interface Window {
    /** Installed by `openEditor` for the tests: the active tab's view. */
    papeleriaTestView?: () => ViewLike;
    /** Installed by `recordInput`: what happened to the active tab, one line each. */
    papeleriaInputRecord?: string[];
  }
}

export type EditorFixture = {
  readonly session: EditorSession;
  readonly root: string;
  readonly context: BrowserContext;
  readonly page: Page;
  /** Page errors and console errors, so a test can assert there were none. */
  readonly problems: string[];
  /** The server's routine diagnostics (its log lines), for a failure to show. */
  readonly logs: string[];
  /** Each launch address the session showed after the first, as the terminal would (D192). */
  readonly announced: string[];
  close(): Promise<void>;
};

export type OpenOptions = {
  /** Names the temporary folder. */
  readonly label?: string;
  /** Changes the copied piece before the session starts. */
  readonly prepare?: (root: string) => void;
  readonly hooks?: SessionHooks;
  readonly viewport?: {readonly width: number; readonly height: number};
  /** Wait for the first preview to be shown (the default), only for the editor to mount, or only for the page to load. */
  readonly waitFor?: 'preview' | 'editor' | 'load';
  /** Runs before the page opens the launch address: a route that changes a reply, say. */
  readonly beforeOpen?: (page: Page, session: EditorSession) => Promise<void>;
};

/** Starts a session on a copy of `source` and opens the editor at its launch address. */
export async function openEditor(browser: Browser, source: string, options: OpenOptions = {}): Promise<EditorFixture> {
  const root = copyPiece(source, options.label ?? 'editor');
  options.prepare?.(root);
  const logs: string[] = [];
  const announced: string[] = [];
  const session = await startSession({
    root,
    label: 'piece',
    log: (line) => logs.push(line),
    announce: (address) => announced.push(address),
    ...(options.hooks === undefined ? {} : {hooks: options.hooks}),
  });
  const context = await browser.newContext({viewport: options.viewport ?? {width: 1440, height: 900}});
  await context.addInitScript(() => {
    window.papeleriaTestView = () => {
      const content = document.querySelector('.editor-panel:not([hidden]) .cm-content') as (Element & {cmTile?: {view?: unknown}; cmView?: {view?: unknown}}) | null;
      const view = (content?.cmTile ?? content?.cmView)?.view as ViewLike | undefined;
      if (view === undefined) {
        throw new Error("CodeMirror's back-reference to its view was not found: update test/browser/helpers/editor-session.ts for this CodeMirror version");
      }
      return view;
    };
  });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      problems.push(`console error: ${message.text()}`);
    }
  });
  try {
    await options.beforeOpen?.(page, session);
    await page.goto(session.launchUrl);
    const waitFor = options.waitFor ?? 'preview';
    if (waitFor === 'preview') {
      await nextShown(page, undefined);
    } else if (waitFor === 'editor') {
      await page.waitForSelector('.editor-panel:not([hidden]) .cm-content');
    }
  } catch (error) {
    await context.close();
    await session.close();
    throw error;
  }
  return {
    session,
    root,
    context,
    page,
    problems,
    logs,
    announced,
    async close() {
      await context.close();
      await session.close();
    },
  };
}

/**
 * How the suites type: a key every 20 ms, a fast typist's pace, rather than
 * Playwright's default of a key every few milliseconds, which no person
 * reaches. An A9 edit of 15 characters takes 300 ms at this pace, inside the
 * 500 ms debounce, and A9 is timed from the final key.
 *
 * The pace is not what made CI's Chromium 153 now and then leave CodeMirror's
 * cursor one character behind, so that the character followed the rest of the
 * edit ("Edit 03 f A9.o", PR #16): it did that at this pace too. See
 * `recordInput`.
 */
export const TYPING = Object.freeze({delay: 20});

/**
 * Starts recording, in the page, what happens to the active tab while a test
 * types, for a failure to show what moved the cursor: every transaction
 * CodeMirror applies (its user event, the end of its change, the selection it
 * sets, where the cursor ends, and the calls that dispatched it), and every
 * key, input, selection, focus and message event, each with the cursor as the
 * DOM selection places it (`dom`) and as CodeMirror's state holds it (`head`).
 * Times are the page's clock. `inputRecord` reads it.
 *
 * Installing it changes the page's timing: it runs at every key and input
 * event and reads the selection as each happens. In CI's Chromium 153, A9 left
 * a typed character after the cursor on one edit in every run from `ee476db`
 * to `e4d1879`, and in neither run once this record was in place (`44c35c7`).
 * The cause is not established (blueprint/W3A.md, "CI on the pull request");
 * without this record, expect that fault back until it is.
 */
export async function recordInput(page: Page): Promise<void> {
  await page.evaluate(() => {
    const record: string[] = [];
    window.papeleriaInputRecord = record;
    const view = window.papeleriaTestView!();
    const domCursor = (): string => {
      const selection = document.getSelection();
      if (selection === null || selection.focusNode === null) {
        return 'none';
      }
      try {
        return String(view.posAtDOM(selection.focusNode, selection.focusOffset));
      } catch {
        return `outside:${selection.focusNode.nodeName}`;
      }
    };
    const note = (kind: string, detail: string): void => {
      record.push(`${performance.now().toFixed(1)} ${kind} dom=${domCursor()} head=${view.state.selection.main.head} active=${document.activeElement?.tagName ?? 'none'} ${detail}`);
    };
    const update = view.update;
    view.update = function (this: ViewLike, transactions: readonly TransactionLike[]): void {
      const described = transactions.map((transaction) => {
        const user = transaction.annotation(transaction.constructor.userEvent);
        const change = transaction.docChanged ? JSON.stringify(transaction.changes.toJSON()).slice(-48) : '';
        const set = transaction.selection === undefined ? '' : ` sel=${transaction.selection.main.head}`;
        return `${typeof user === 'string' ? user : '-'} ${change}${set} effects=${transaction.effects.length} -> ${transaction.state.selection.main.head}`;
      });
      const callers = (new Error().stack ?? '')
        .split('\n')
        .slice(2, 9)
        .map((frame) => frame.trim().replace(/^at /, '').replace(/\(?https?:\/\/[^/]+\//, '(').replace(/\)$/, ''))
        .join(' < ');
      note('update', `[${described.join('; ')}] from ${callers}`);
      update.call(this, transactions);
    };
    for (const type of ['keydown', 'keyup', 'beforeinput', 'input', 'compositionstart', 'compositionend']) {
      window.addEventListener(
        type,
        (event) => {
          const detail = event instanceof KeyboardEvent ? `key=${JSON.stringify(event.key)}` : event instanceof InputEvent ? `${event.inputType} ${JSON.stringify(event.data)}` : '';
          note(type, detail);
        },
        true,
      );
    }
    document.addEventListener('selectionchange', () => note('selectionchange', ''));
    document.addEventListener('focusin', (event) => note('focusin', (event.target as Element | null)?.tagName ?? ''), true);
    document.addEventListener('focusout', (event) => note('focusout', (event.target as Element | null)?.tagName ?? ''), true);
    window.addEventListener('focus', () => note('window-focus', ''));
    window.addEventListener('blur', () => note('window-blur', ''));
    window.addEventListener('message', (event: MessageEvent) => note('message', String((event.data as {type?: unknown} | null)?.type)));
    const stage = document.getElementById('stage')!;
    new MutationObserver(() => note('shown', stage.dataset['generationId'] ?? '')).observe(stage, {attributes: true, attributeFilter: ['data-generation-id']});
  });
}

/** How many lines `recordInput` has recorded so far. */
export function inputRecordLength(page: Page): Promise<number> {
  return page.evaluate(() => window.papeleriaInputRecord?.length ?? 0);
}

/** The lines `recordInput` recorded from line `from` on. */
export function inputRecord(page: Page, from = 0): Promise<string[]> {
  return page.evaluate((start) => window.papeleriaInputRecord?.slice(start) ?? [], from);
}

/** The generation the preview shows, or undefined before the first. */
export function shown(page: Page): Promise<string | undefined> {
  return page.evaluate(() => document.getElementById('stage')?.dataset['generationId']);
}

/** Waits until the preview shows a generation other than `previous`, and returns it. */
export async function nextShown(page: Page, previous: string | undefined, timeout = 20_000): Promise<string> {
  await page.waitForFunction((before) => {
    const now = document.getElementById('stage')?.dataset['generationId'];
    return now !== undefined && now !== before;
  }, previous, {timeout});
  return (await shown(page))!;
}

/** The frame showing a generation. */
export function frameOf(page: Page, generationId: string): Frame {
  const frame = page.frames().find((candidate) => candidate.url().includes(`/${generationId}/`));
  if (frame === undefined) {
    throw new Error(`no frame shows ${generationId}; frames: ${page.frames().map((candidate) => candidate.url()).join(', ')}`);
  }
  return frame;
}

/** The shown page's text, notes and hidden parts included. */
export async function shownText(page: Page): Promise<string> {
  const id = await shown(page);
  if (id === undefined) {
    throw new Error('no preview is shown');
  }
  return frameOf(page, id).evaluate(() => document.body.textContent ?? '');
}

/** The active tab's text. */
export function bufferText(page: Page): Promise<string> {
  return page.evaluate(() => window.papeleriaTestView!().state.doc.toString());
}

/** The first line of the active tab holding `text`, from 1. */
export async function lineOf(page: Page, text: string): Promise<number> {
  const line = await page.evaluate((wanted) => {
    const {doc} = window.papeleriaTestView!().state;
    for (let number = 1; number <= doc.lines; number += 1) {
      if (doc.line(number).text.includes(wanted)) {
        return number;
      }
    }
    return 0;
  }, text);
  if (line === 0) {
    throw new Error(`no line of the active tab holds ${JSON.stringify(text)}`);
  }
  return line;
}

/**
 * Puts the cursor on a line of the active tab, at a column from 1 (the line's
 * end by default), focuses the editor, and returns once CodeMirror has
 * scrolled the line into view and drawn it: two animation frames, since the
 * scroll is measured in the next one and the lines it brings in are drawn
 * after, as a person types only once the line is on screen.
 */
export async function placeCursor(page: Page, line: number, column?: number): Promise<void> {
  await page.evaluate(
    ({line: number, column: at}) => {
      const view = window.papeleriaTestView!();
      const target = view.state.doc.line(number);
      const position = at === null ? target.to : Math.min(target.to, target.from + at - 1);
      view.dispatch({selection: {anchor: position}, effects: view.constructor.scrollIntoView(position, {y: 'center'})});
      view.focus();
    },
    {line, column: column ?? null},
  );
  await page.evaluate(() => new Promise((resolveFrames) => requestAnimationFrame(() => requestAnimationFrame(resolveFrames))));
}

/** The line the active tab's cursor is on, from 1. */
export function cursorLine(page: Page): Promise<number> {
  return page.evaluate(() => {
    const {state} = window.papeleriaTestView!();
    return state.doc.lineAt(state.selection.main.head).number;
  });
}

/** Where the active tab draws the character `offset` characters into the first occurrence of `text`, scrolled into view. */
export async function pointAt(page: Page, text: string, offset = 0): Promise<{x: number; y: number}> {
  const position = await page.evaluate(
    ({wanted, offset: into}) => {
      const view = window.papeleriaTestView!();
      const index = view.state.doc.toString().indexOf(wanted);
      if (index < 0) {
        return null;
      }
      view.dispatch({effects: view.constructor.scrollIntoView(index + into, {y: 'center'})});
      return index + into;
    },
    {wanted: text, offset},
  );
  if (position === null) {
    throw new Error(`the active tab does not hold ${JSON.stringify(text)}`);
  }
  // Let CodeMirror measure after the scroll before reading coordinates.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const box = await page.evaluate((at) => window.papeleriaTestView!().coordsAtPos(at), position);
  if (box === null) {
    throw new Error(`position ${position} is not drawn`);
  }
  return {x: (box.left + box.right) / 2 + 1, y: (box.top + box.bottom) / 2};
}

/** The status line's parts: the preview's line with its tone, and the note after it. */
export async function statusLine(page: Page): Promise<{preview: string; tone: string; note: string}> {
  return page.evaluate(() => ({
    preview: document.getElementById('status-preview')?.textContent ?? '',
    tone: document.getElementById('status-preview')?.className ?? '',
    note: document.getElementById('status-note')?.textContent ?? '',
  }));
}

/** The tab buttons' labels, in order. */
export function tabLabels(page: Page): Promise<string[]> {
  return page.locator('[role=tab]').allTextContents();
}
