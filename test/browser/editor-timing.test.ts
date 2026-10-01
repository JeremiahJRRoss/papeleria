/**
 * A9: from the final keystroke to the matching preview shown, 500 ms debounce
 * included, on the 16-slide brand-overview deck: 20 consecutive warm text
 * edits, each within 2.000 s, and the cold first preview reported apart.
 *
 * The time is taken by the test, not the editor: a keydown listener in the
 * capture phase stamps each key, and a MutationObserver stamps the moment the
 * stage switches to a new generation, on the page's own clock. An edit counts
 * only when the generation shown holds the text just typed. The editor's own
 * `papeleria:preview` measure is recorded beside it for comparison.
 *
 * Each run reports the machine (CPU model and count, memory, OS), the browser
 * and Node, as A9 asks, in the test's diagnostics and in
 * `test-results/a9-timing-<engine>.json`. A9's reference machine is at least
 * four logical CPUs, 8 GiB and an SSD; the record says whether this one has
 * the first two (a disk's kind cannot be read portably).
 */
import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import {request as httpRequest, type ClientRequest} from 'node:http';
import {cpus, platform, release, totalmem} from 'node:os';
import {join} from 'node:path';
import {after, before, describe, test} from 'node:test';

import type {Browser, Page} from 'playwright';

import {applicationRoot} from '../helpers/paths.js';
import {removeTemporaryFolders} from '../helpers/pieces.js';
import {bufferText, frameOf, inputRecord, inputRecordLength, openEditor, placeCursor, recordInput, TYPING} from './helpers/editor-session.js';
import {launchEngine, selectedEngines} from './helpers/engines.js';

const TIMEOUT = {timeout: 300_000};
const BRAND_OVERVIEW = join(applicationRoot, 'examples', 'brand-overview');
const EDITS = 20;
const LIMIT_MS = 2000;
const GIB = 1024 ** 3;

after(removeTemporaryFolders);

type Stamps = {key: number; swaps: {id: string; at: number}[]};

declare global {
  interface Window {
    a9Stamps?: Stamps;
  }
}

/** Starts stamping keys and generation switches in the page. */
async function stamp(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stamps: Stamps = {key: 0, swaps: []};
    window.a9Stamps = stamps;
    window.addEventListener('keydown', () => {
      stamps.key = performance.now();
    }, true);
    const stage = document.getElementById('stage')!;
    new MutationObserver(() => {
      const id = stage.dataset['generationId'];
      if (id !== undefined && stamps.swaps.at(-1)?.id !== id) {
        stamps.swaps.push({id, at: performance.now()});
      }
    }).observe(stage, {attributes: true, attributeFilter: ['data-generation-id']});
  });
}

/** The lines holding a single-line plain `lead:`, which an edit can extend at the end. */
async function leadLines(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const {doc} = window.papeleriaTestView!().state;
    const lines: number[] = [];
    for (let number = 1; number <= doc.lines; number += 1) {
      if (/^ {4}lead: [^"'|>]/.test(doc.line(number).text)) {
        lines.push(number);
      }
    }
    return lines;
  });
}

/**
 * What happened around the edits, for a failure to report: every preview
 * request and reply the page saw, and every event the server sent, read from
 * a second event stream of the session's own (the server sends each event to
 * every stream). Times are milliseconds since the trace began.
 */
type Trace = {readonly lines: string[]; stop(): void};

function traceSession(page: Page, editorOrigin: string, token: string): Trace {
  const start = Date.now();
  const lines: string[] = [];
  const note = (text: string): void => {
    lines.push(`${Date.now() - start} ${text}`);
  };
  page.on('request', (request) => {
    if (request.url().endsWith('/api/preview')) {
      note(`page asks for preview ${(JSON.parse(request.postData() ?? '{}') as {requestId?: number}).requestId}`);
    }
  });
  page.on('requestfailed', (request) => {
    if (request.url().includes('/api/')) {
      note(`page request failed: ${request.url()} ${request.failure()?.errorText ?? ''}`);
    }
  });
  page.on('response', (response) => {
    if (response.url().endsWith('/api/preview')) {
      void response
        .json()
        .then((body: Record<string, unknown>) => note(`reply ${response.status()} ${JSON.stringify({requestId: body['requestId'], superseded: body['superseded'], generationId: body['generationId'], errorCode: body['errorCode'], errors: (body['report'] as {errors?: number} | undefined)?.errors})}`))
        .catch(() => note(`reply ${response.status()} (unread)`));
    }
  });
  let events: ClientRequest | null = null;
  const url = new URL('/api/events', editorOrigin);
  events = httpRequest({host: url.hostname, port: url.port, path: url.pathname, headers: {'x-papeleria-token': token}}, (response) => {
    let buffer = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const name = /^event: (.*)$/m.exec(frame)?.[1];
        if (name !== undefined && name !== 'hello') {
          note(`server event ${name} ${/^data: (.*)$/m.exec(frame)?.[1]?.slice(0, 160) ?? ''}`);
        }
      }
    });
  });
  events.on('error', () => undefined);
  events.end();
  return {lines, stop: () => events?.destroy()};
}

/** Waits for the first generation shown after `from` whose page holds `marker`; returns its stamp. */
async function matchingSwap(page: Page, from: number, marker: string, explain: () => Promise<string>): Promise<{id: string; at: number}> {
  const deadline = Date.now() + 20_000;
  let checked = from;
  for (;;) {
    const swaps = await page.evaluate(() => window.a9Stamps!.swaps);
    for (const swap of swaps.slice(checked)) {
      checked += 1;
      const text = await frameOf(page, swap.id).evaluate(() => document.body.textContent ?? '');
      if (text.includes(marker)) {
        return swap;
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`no preview showed ${JSON.stringify(marker)} within 20 s\n${await explain()}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

const {run, excluded} = selectedEngines();

for (const engine of excluded) {
  test(`${engine}: not run`, {skip: `PAPELERIA_BROWSERS=${process.env['PAPELERIA_BROWSERS'] ?? ''} leaves ${engine} out`}, () => {});
}

for (const engine of run) {
  describe(`A9 preview timing in ${engine}`, () => {
    let browser: Browser | undefined;
    before(async () => {
      browser = await launchEngine(engine);
    }, TIMEOUT);
    after(async () => {
      await browser?.close();
    });

    test(`${EDITS} consecutive warm edits of brand-overview each show their preview within ${LIMIT_MS / 1000} s of the final keystroke`, TIMEOUT, async (context) => {
      assert.ok(browser !== undefined, `${engine} did not launch`);
      const started = Date.now();
      const editor = await openEditor(browser, BRAND_OVERVIEW, {label: `a9-${engine}`});
      try {
        const {page, problems, session, logs} = editor;
        const coldWallMs = Date.now() - started;
        const trace = traceSession(page, session.editorOrigin, session.token);
        const explain = async (): Promise<string> => {
          const state = await page.evaluate(() => ({
            active: `${document.activeElement?.tagName ?? 'none'}.${String(document.activeElement?.className ?? '')}`,
            hasFocus: document.hasFocus(),
            visibility: document.visibilityState,
            status: document.getElementById('status')?.textContent ?? '',
            stale: !document.getElementById('preview-stale')!.hidden,
            banner: document.getElementById('banner')!.hidden ? '' : (document.getElementById('banner-text')?.textContent ?? ''),
            stage: {...document.getElementById('stage')!.dataset},
            frames: [...document.querySelectorAll('iframe')].map((frame) => `${frame.dataset['generationId'] ?? '?'}${frame.classList.contains('is-loading') ? ' loading' : ''}`),
            lastKey: window.a9Stamps?.key ?? null,
            swaps: window.a9Stamps?.swaps.slice(-4) ?? [],
            now: performance.now(),
          }));
          return [
            `page: ${JSON.stringify(state)}`,
            `problems: ${JSON.stringify(problems)}`,
            `server log: ${JSON.stringify(logs.slice(-10))}`,
            'trace:',
            ...trace.lines.slice(-30),
          ].join('\n');
        };
        const cold = await page.evaluate(() => {
          const first = performance.getEntriesByName('papeleria:preview')[0];
          return first === undefined ? null : {sinceNavigationMs: first.startTime + first.duration, sinceTabMs: first.duration};
        });
        await stamp(page);
        await recordInput(page);
        const leads = await leadLines(page);
        assert.ok(leads.length >= 10, `brand-overview has ${leads.length} plain leads`);

        const edits: {edit: number; line: number; ms: number; editorMeasureMs: number | null}[] = [];
        for (let edit = 1; edit <= EDITS; edit += 1) {
          const line = leads[(edit - 1) % leads.length]!;
          const marker = `Edit ${String(edit).padStart(2, '0')} of A9.`;
          const recordFrom = await inputRecordLength(page);
          await placeCursor(page, line);
          const from = (await page.evaluate(() => window.a9Stamps!.swaps.length));
          const lengthBefore = (await bufferText(page)).length;
          trace.lines.push(`-- edit ${edit}: typing on line ${line}`);
          await page.keyboard.type(` ${marker}`, TYPING);
          const key = await page.evaluate(() => window.a9Stamps!.key);
          const typed = await bufferText(page);
          if (!typed.includes(marker)) {
            const where = await page.evaluate((number) => {
              const {state} = window.papeleriaTestView!();
              return {line: state.doc.line(number).text, cursorLine: state.doc.lineAt(state.selection.main.head).number};
            }, line);
            throw new Error(
              `edit ${edit}: the typed text did not reach the editor: ${typed.length - lengthBefore} of ${marker.length + 1} characters arrived; ` +
                `line ${line} reads ${JSON.stringify(where.line)}, the cursor is on line ${where.cursorLine}\n${await explain()}\n` +
                `input record, from placing the cursor:\n${(await inputRecord(page, recordFrom)).join('\n')}`,
            );
          }
          const swap = await matchingSwap(page, from, marker, explain);
          const editorMeasureMs = await page.evaluate(
            (id) => performance.getEntriesByName('papeleria:preview').find((entry) => (entry as PerformanceMeasure).detail?.generationId === id)?.duration ?? null,
            swap.id,
          );
          edits.push({edit, line, ms: Math.round((swap.at - key) * 10) / 10, editorMeasureMs: editorMeasureMs === null ? null : Math.round(editorMeasureMs * 10) / 10});
        }

        const cpuList = cpus();
        const record = {
          acceptance: 'A9',
          engine,
          browser: browser.version(),
          node: process.version,
          os: `${platform()} ${release()}`,
          cpu: {model: cpuList[0]?.model ?? 'unknown', logical: cpuList.length},
          memoryGiB: Math.round((totalmem() / GIB) * 10) / 10,
          meetsReferenceCpuAndMemory: cpuList.length >= 4 && totalmem() >= 8 * GIB * 0.95,
          fixture: 'examples/brand-overview (16 slides)',
          debounceMs: 500,
          limitMs: LIMIT_MS,
          cold: {wallMsFromStart: coldWallMs, ...cold},
          warm: {
            maxMs: Math.max(...edits.map((entry) => entry.ms)),
            medianMs: [...edits.map((entry) => entry.ms)].sort((a, b) => a - b)[Math.floor(edits.length / 2)],
            edits,
          },
        };
        context.diagnostic(JSON.stringify(record));
        mkdirSync(join(applicationRoot, 'test-results'), {recursive: true});
        writeFileSync(join(applicationRoot, 'test-results', `a9-timing-${engine}.json`), `${JSON.stringify(record, null, 2)}\n`);

        assert.equal(edits.length, EDITS);
        for (const entry of edits) {
          assert.ok(entry.ms <= LIMIT_MS, `edit ${entry.edit} took ${entry.ms} ms, over ${LIMIT_MS} ms`);
          assert.ok(entry.ms >= 500, `edit ${entry.edit} took ${entry.ms} ms, under the 500 ms debounce: the measurement is wrong`);
        }
        assert.deepEqual(problems, []);
        trace.stop();
      } finally {
        await editor.close();
      }
    });
  });
}
