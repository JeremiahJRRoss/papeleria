/**
 * M2.2–M2.5, M2.7: the editor in Chromium, Firefox and WebKit (D51).
 *
 * Each test starts its own session on a copy of the starter deck, opens the
 * editor at the launch address and works it with the real keyboard and
 * mouse: the token leaving the address, a reload that brings the editor
 * back with the key the tab kept, a kept key refused and let go, and the
 * address pasted into the same tab (D173, D184), the preview following the
 * buffers after the pause, saving and the recoverable previous version, Build
 * and Check, findings at their file and line (A9), every dirty Markdown
 * buffer in the preview (A9), changes on disk and the conflict banner, a
 * conflict undone on disk, Save all stopping at a conflict, the read-only CSV
 * table, the leave-page warning, Follow, the device widths, Open in a new
 * tab, an older reply never replacing a newer preview (A9), Escape's order,
 * full screen included, a lost connection and its recovery, findings without
 * a line, and a first preview that fails.
 */
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {after, before, describe, test} from 'node:test';

import type {Browser, Page} from 'playwright';

import {applicationRoot} from '../helpers/paths.js';
import {removeTemporaryFolders} from '../helpers/pieces.js';
import {
  bufferText,
  cursorLine,
  frameOf,
  lineOf,
  nextShown,
  openEditor,
  placeCursor,
  shown,
  shownText,
  statusLine,
  tabLabels,
  TYPING,
  type EditorFixture,
  type OpenOptions,
} from './helpers/editor-session.js';
import {launchEngine, selectedEngines} from './helpers/engines.js';

const TIMEOUT = {timeout: 120_000};
const STARTER = join(applicationRoot, 'templates', 'deck', 'sample');
const STATEMENT = 'title: Care should be visible in the work.';
/** What a page with no address and no resume token says (D192, D195), as `src/editor/app.ts` words it. */
const NO_ADDRESS = 'Open the editor with the newest address Papeleria printed in the terminal: paste it into this tab, or open it in a new one.';

after(removeTemporaryFolders);

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolvePause) => setTimeout(resolvePause, milliseconds));
}

/** Polls a Node-side condition. */
async function until(condition: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting until ${what}`);
    }
    await pause(50);
  }
}

/** The id of the last event the session has sent, from its piece snapshot. */
async function lastEventId(session: EditorFixture['session']): Promise<number> {
  const response = await fetch(new URL('/api/piece', session.editorOrigin), {headers: {'X-Papeleria-Token': session.token}});
  return ((await response.json()) as {lastEventId: number}).lastEventId;
}

async function note(page: Page, pattern: RegExp): Promise<string> {
  await page.waitForFunction((source) => new RegExp(source).test(document.getElementById('status-note')?.textContent ?? ''), pattern.source, {timeout: 20_000});
  return (await statusLine(page)).note;
}

/** The deck's current slide in the shown frame. */
async function currentSlide(page: Page): Promise<number | undefined> {
  const id = await shown(page);
  return id === undefined ? undefined : frameOf(page, id).evaluate(() => (window as unknown as {papeleriaDeck?: {current: number}}).papeleriaDeck?.current);
}

async function waitForSlide(page: Page, slide: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while ((await currentSlide(page)) !== slide) {
    if (Date.now() > deadline) {
      throw new Error(`the preview never showed slide ${slide}; it shows ${await currentSlide(page)}`);
    }
    await pause(50);
  }
}

async function openFile(page: Page, path: string): Promise<void> {
  await page.click('#files-toggle');
  await page.click(`#files button[data-path="${path}"]`);
  await page.waitForFunction((wanted) => document.querySelector('[role=tab][aria-selected=true]')?.getAttribute('title') === wanted, path);
}

async function selectTab(page: Page, name: string): Promise<void> {
  await page.click(`[role=tab][title="${name}"]`);
}

/** A second Markdown file named by slide 2's notes. */
function withStatementNotes(root: string): void {
  writeFileSync(join(root, 'assets', 'text', '02-statement-notes.md'), 'Statement notes on disk.\n');
  const manifest = join(root, 'papeleria.yaml');
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('    footer: Proposed brand principle\n', '    footer: Proposed brand principle\n    notes: assets/text/02-statement-notes.md\n'));
}

/** An image slide whose picture cannot be decoded: a finding with no line of its own. */
function withBrokenImage(root: string): void {
  mkdirSync(join(root, 'assets', 'images'), {recursive: true});
  writeFileSync(join(root, 'assets', 'images', 'broken.png'), Buffer.from('not a picture at all'));
  const manifest = join(root, 'papeleria.yaml');
  writeFileSync(
    manifest,
    `${readFileSync(manifest, 'utf8')}\n  - layout: image\n    title: A picture that is not one.\n    image: {src: assets/images/broken.png, alt: Nothing}\n`,
  );
}

const {run, excluded} = selectedEngines();

for (const engine of excluded) {
  test(`${engine}: not run`, {skip: `PAPELERIA_BROWSERS=${process.env['PAPELERIA_BROWSERS'] ?? ''} leaves ${engine} out`}, () => {});
}

for (const engine of run) {
  describe(`editor in ${engine}`, () => {
    let browser: Browser | undefined;
    before(async () => {
      browser = await launchEngine(engine);
    }, TIMEOUT);
    after(async () => {
      await browser?.close();
    });

    /** Runs `body` on a fresh session and closes it, whatever happens. */
    async function withEditor(options: OpenOptions, body: (editor: EditorFixture) => Promise<void>): Promise<void> {
      if (browser === undefined) {
        throw new Error(`${engine} did not launch`);
      }
      const editor = await openEditor(browser, STARTER, {label: `editor-${engine}`, ...options});
      try {
        await body(editor);
      } finally {
        await editor.close();
      }
    }

    test('launches', TIMEOUT, (context) => {
      context.diagnostic(`${engine} ${browser?.version() ?? 'did not launch'}`);
    });

    test('opens the piece, takes the token out of the address, and shows the first preview in a sandboxed frame', TIMEOUT, async () => {
      await withEditor({}, async ({page, session, problems}) => {
        const launchToken = new URL(session.launchUrl).hash.slice('#token='.length);
        assert.notEqual(launchToken, session.token, 'the address holds a launch token, never the session token (D192)');
        assert.equal(page.url(), `${session.editorOrigin}/`);
        const kept = await page.evaluate(() => JSON.stringify([{...localStorage}, {...sessionStorage}, document.cookie, location.href, document.documentElement.outerHTML]));
        assert.ok(!kept.includes(launchToken) && !kept.includes(session.token), 'the session token is in memory only, and the launch token nowhere');
        // The tab keeps one thing: its one-time resume token, for a reload (D195).
        const stored = await page.evaluate(() => ({...sessionStorage}));
        assert.deepEqual(Object.keys(stored), ['papeleria-resume']);
        assert.match(stored['papeleria-resume']!, /^[0-9a-f]{64}$/);
        assert.deepEqual(await tabLabels(page), ['papeleria.yaml']);
        assert.equal(await page.getAttribute('[role=tab]', 'aria-selected'), 'true');
        assert.equal(await page.textContent('#piece-line'), 'piece · deck · en · draft');
        const id = (await shown(page))!;
        const frame = page.locator(`iframe[data-generation-id="${id}"]`);
        assert.equal(await frame.getAttribute('sandbox'), 'allow-scripts allow-same-origin allow-modals allow-popups');
        const address = new URL((await frame.getAttribute('src'))!);
        assert.equal(address.origin, session.previewOrigin);
        assert.equal(address.pathname, `/${id}/index.html`);
        assert.equal(address.searchParams.get('parent'), session.editorOrigin);
        const status = await statusLine(page);
        assert.match(status.preview, /^Updated [0-9]+\.[0-9] s ago · [0-9]+ KB of 1 MB$/);
        assert.equal(status.tone, 'tone-success');
        assert.equal(await page.isEnabled('#build'), true);
        assert.equal(await page.isHidden('#build-hint'), true);
        assert.equal(await page.getAttribute('#check', 'title'), 'Checks the manifest and every unsaved Markdown buffer; writes nothing to dist/');
        assert.match(await shownText(page), /Craft with care\. Build for the long view\./);
        assert.deepEqual(problems, []);
      });
    });

    test('a launch address opens the editor once; a reload reopens it by itself; the newest address opens it again, pasted into a waiting tab or in a new one (security audit F10, D192, D195)', TIMEOUT, async () => {
      await withEditor({}, async ({page, session, context, announced, problems}) => {
        assert.equal(announced.length, 1, 'opening the editor spent the first address and brought the next');
        const opened = 'piece · deck · en · draft';
        const kept = (tab: typeof page): Promise<string | null> => tab.evaluate(() => sessionStorage.getItem('papeleria-resume'));
        const says = (tab: typeof page, text: string): Promise<unknown> => tab.waitForFunction((line) => document.querySelector('#piece-line')?.textContent === line, text);
        const again = await context.newPage();
        const third = await context.newPage();
        try {
          await again.goto(session.launchUrl);
          await says(again, 'This address has opened the editor already, and each address opens it once. Paste the newest address Papeleria printed in the terminal into this tab, or open it in a new one.');
          assert.equal(new URL(again.url()).hash, '', 'the spent address leaves the address bar too');
          assert.equal(await again.locator('iframe').count(), 0);
          assert.equal(await again.isDisabled('#build'), true);
          assert.equal(await kept(again), null, 'a tab that never opened the editor keeps nothing');

          // Pasted into the same tab, the address changes only the fragment: the waiting page reads it.
          await again.goto(announced[0]!);
          await nextShown(again, undefined);
          assert.equal(await again.textContent('#piece-line'), opened);
          assert.equal(await again.isEnabled('#build'), true);
          assert.equal(new URL(again.url()).hash, '');
          assert.equal(announced.length, 2, 'and brought the one after it');

          // A page that holds its session removes a fragment unread, so nothing can start it again.
          await page.goto(announced[1]!);
          await page.waitForFunction(() => location.hash === '');
          assert.equal(announced.length, 2, 'the address was not spent');
          assert.equal(await page.textContent('#piece-line'), opened, 'the first tab kept its session');

          // A reload reopens the editor by itself, with the tab's resume token, which it spends for the next (D195).
          const spent = (await kept(again))!;
          await again.reload();
          await nextShown(again, undefined);
          assert.equal(await again.textContent('#piece-line'), opened);
          assert.equal(announced.length, 2, 'a reload spends no address the terminal showed');
          const next = await kept(again);
          assert.match(next ?? '', /^[0-9a-f]{64}$/);
          assert.ok(next !== spent && next !== session.token);

          // A resume token that was spent already reopens nothing; the tab then waits for an address.
          await again.evaluate((token) => sessionStorage.setItem('papeleria-resume', token), spent);
          await again.reload();
          await says(again, 'This tab could not reopen the editor by itself. Paste the newest address Papeleria printed in the terminal into this tab, or open it in a new one.');
          assert.equal(await kept(again), null, 'and keeps nothing');
          await again.goto(announced[1]!);
          await nextShown(again, undefined);
          assert.equal(announced.length, 3);

          await third.goto(announced[2]!);
          await nextShown(third, undefined);
          assert.equal(await third.textContent('#piece-line'), opened, 'the newest address opens a new tab too');
          assert.equal(announced.length, 4);
        } finally {
          await again.close();
          await third.close();
        }
        assert.equal(await page.textContent('#piece-line'), opened);
        assert.deepEqual(problems, []);
      });
    });

    test('while the editor holds its session, a launch token set into its address is removed unread, and another tab asks nothing of the API (D173, D192)', TIMEOUT, async () => {
      await withEditor({}, async ({page, session, announced, problems}) => {
        const keys = new Set<string>();
        page.on('request', (request) => {
          const key = request.headers()['x-papeleria-token'];
          if (key !== undefined) {
            keys.add(key);
          }
        });
        const first = (await shown(page))!;
        // What a page holding a reference to this window could set; the newest printed address pasted in sets the second.
        for (const key of ['e'.repeat(64), new URL(announced.at(-1)!).hash.slice('#token='.length)]) {
          await page.evaluate((value) => {
            location.hash = `#token=${value}`;
          }, key);
          await page.waitForFunction(() => location.hash === '');
        }
        assert.deepEqual(await tabLabels(page), ['papeleria.yaml'], 'the editor did not start again');
        await placeCursor(page, await lineOf(page, STATEMENT));
        await page.keyboard.type(' Still here.', TYPING);
        await nextShown(page, first);
        assert.match(await shownText(page), /in the work\. Still here\./);
        assert.deepEqual([...keys], [session.token], 'every request carried the session token the editor opened with');
        assert.equal(announced.length, 1, 'the address set into it was not spent');
        assert.deepEqual(Object.keys(await page.evaluate(() => ({...sessionStorage}))), ['papeleria-resume'], 'the tab keeps its resume token only');

        // Another tab has nothing of this one's: with no address and no resume token, it asks nothing of the API.
        const other = await page.context().newPage();
        let asked = 0;
        other.on('request', (request) => {
          asked += new URL(request.url()).pathname.startsWith('/api/') ? 1 : 0;
        });
        try {
          await other.goto(`${session.editorOrigin}/`);
          await other.waitForFunction((text) => document.getElementById('piece-line')?.textContent === text, NO_ADDRESS);
          assert.equal(await other.textContent('#preview-empty'), NO_ADDRESS);
          assert.equal(await other.isDisabled('#build'), true);
          assert.equal(asked, 0, 'nothing is asked of the API without an address or a resume token');
        } finally {
          await other.close();
        }
        assert.deepEqual(problems, []);
      });
    });

    test('a start that fails once its address is spent lets the address go: the newest one pasted into the same tab opens the editor (D173, PRR-03)', TIMEOUT, async () => {
      let folder = '';
      await withEditor(
        {
          waitFor: 'load',
          prepare: (root) => {
            folder = root;
          },
          // A second manifest beside the first once the session runs: the address is spent, then the start fails.
          beforeOpen: async () => {
            writeFileSync(join(folder, 'papeleria.json'), '{}\n');
          },
        },
        async ({page, announced, problems}) => {
          await page.waitForFunction(() => /has no single manifest to edit\.$/.test(document.querySelector('#piece-line')?.textContent ?? ''));
          assert.equal(await page.locator('.cm-content').count(), 0, 'no tab is opened');
          assert.equal(await page.isDisabled('#build'), true);
          assert.equal(announced.length, 1, 'the address was spent, and the terminal showed the next');
          rmSync(join(folder, 'papeleria.json'));
          // Pasted into the same tab, the newest address changes only the fragment; the page no longer holds the one
          // it could not start with, so it reads this one (D173).
          await page.goto(announced[0]!);
          await nextShown(page, undefined);
          assert.equal(await page.textContent('#piece-line'), 'piece · deck · en · draft');
          assert.equal(await page.isEnabled('#build'), true);
          assert.equal(new URL(page.url()).hash, '');
          assert.equal(announced.length, 2, 'the pasted address was spent');
          assert.deepEqual(problems, []);
        },
      );
    });

    test('a preview origin that is the editor\'s own is refused before anything is framed (security audit F15)', TIMEOUT, async () => {
      const previews: string[] = [];
      await withEditor(
        {
          waitFor: 'load',
          beforeOpen: async (page, session) => {
            page.on('request', (request) => {
              if (request.url().startsWith(`${session.editorOrigin}/api/preview`)) {
                previews.push(request.url());
              }
            });
            // The server always gives the preview another port; this reply names the editor's own origin instead.
            await page.route(`${session.editorOrigin}/api/piece`, async (route) => {
              const response = await route.fetch();
              await route.fulfill({response, json: {...((await response.json()) as object), previewOrigin: session.editorOrigin}});
            });
          },
        },
        async ({page, problems}) => {
          const refused = 'The preview has no address of its own, so the editor did not open. Stop Papeleria and start it again.';
          await page.waitForFunction((text) => document.querySelector('#piece-line')?.textContent === text, refused);
          assert.equal(await page.textContent('#preview-empty'), refused);
          assert.equal(await page.locator('iframe').count(), 0, 'no frame is made');
          assert.equal(await page.locator('.cm-content').count(), 0, 'no tab is opened');
          assert.equal(await page.isDisabled('#build'), true);
          assert.deepEqual(previews, [], 'no preview is asked for');
          assert.deepEqual(problems, []);
        },
      );
    });

    test('typing previews the buffer after the pause, marks the tab and keeps Build off, and never touches the disk', TIMEOUT, async () => {
      await withEditor({}, async ({page, root, problems}) => {
        const manifest = join(root, 'papeleria.yaml');
        const before = readFileSync(manifest);
        const first = (await shown(page))!;
        await placeCursor(page, await lineOf(page, STATEMENT));
        const asked = page.waitForRequest((request) => request.url().endsWith('/api/preview'));
        await page.keyboard.type(' Always.', TYPING);
        const typed = Date.now();
        await asked;
        assert.ok(Date.now() - typed >= 400, 'the preview waits for the pause');
        await nextShown(page, first);
        assert.match(await shownText(page), /Care should be visible in the work\. Always\./);
        assert.deepEqual(await tabLabels(page), ['papeleria.yaml ●']);
        assert.equal(await page.getAttribute('[role=tab]', 'aria-label'), 'papeleria.yaml, unsaved changes');
        assert.equal(await page.isDisabled('#build'), true);
        assert.equal(await page.isVisible('#build-hint'), true);
        assert.equal(await page.textContent('#build-hint'), 'Save all changed files before building.');
        assert.equal(await page.isEnabled('#save'), true);
        assert.ok(readFileSync(manifest).equals(before), 'the file on disk is unchanged');
        assert.equal(existsSync(join(root, 'dist')), false);
        assert.deepEqual(problems, []);
      });
    });

    test('Ctrl S saves the tab: the dot goes, the disk holds the buffer, the old version is kept, and the status says when', TIMEOUT, async () => {
      await withEditor({}, async ({page, root}) => {
        await placeCursor(page, await lineOf(page, STATEMENT));
        await page.keyboard.type(' Saved.', TYPING);
        await page.keyboard.press('Control+S');
        assert.match(await note(page, /^Saved [0-9]{2}:[0-9]{2}$/), /^Saved [0-9]{2}:[0-9]{2}$/);
        assert.deepEqual(await tabLabels(page), ['papeleria.yaml']);
        assert.match(readFileSync(join(root, 'papeleria.yaml'), 'utf8'), /Care should be visible in the work\. Saved\./);
        const backups = join(root, '.papeleria', 'backups', 'papeleria.yaml');
        assert.equal(readdirSync(backups).length, 1);
        assert.doesNotMatch(readFileSync(join(backups, readdirSync(backups)[0]!), 'utf8'), /Saved\./, 'the previous version is recoverable');
        assert.equal(await page.isEnabled('#build'), true);
        assert.equal(await page.isHidden('#build-hint'), true);
      });
    });

    test('Build writes dist/ from the saved files, from the button and from Ctrl B', TIMEOUT, async () => {
      await withEditor({}, async ({page, root}) => {
        await page.click('#build');
        assert.equal(await note(page, /^Built /), 'Built piece/dist · 0 errors · 0 warnings');
        assert.ok(existsSync(join(root, 'dist', 'index.html')));
        rmSync(join(root, 'dist'), {recursive: true});
        await placeCursor(page, 1);
        await page.keyboard.press('Control+B');
        await until(() => existsSync(join(root, 'dist', 'index.html')), 'Ctrl B builds');
      });
    });

    test('Check reads the open buffers, unsaved changes included, and writes nothing', TIMEOUT, async () => {
      await withEditor({}, async ({page, root}) => {
        await placeCursor(page, await lineOf(page, 'footer: Proposed brand principle'));
        await page.keyboard.press('Enter');
        await page.keyboard.type('bogus_key: 1', TYPING);
        await page.click('#check');
        assert.equal(await note(page, /^Checked /), 'Checked the open buffers, unsaved changes included · 1 error · 0 warnings');
        assert.equal(existsSync(join(root, 'dist')), false);
        assert.doesNotMatch(readFileSync(join(root, 'papeleria.yaml'), 'utf8'), /bogus_key/);
      });
    });

    test('an unknown key is found at its file and line: underlined there once, counted, listed and named for the cursor’s line (A9)', TIMEOUT, async () => {
      await withEditor({}, async ({page, problems}) => {
        const line = (await lineOf(page, 'footer: Proposed brand principle')) + 1;
        await placeCursor(page, line - 1);
        await page.keyboard.press('Enter');
        await page.keyboard.type('bogus_key: 1', TYPING);
        assert.equal(await page.locator('.cm-lintRange-error, .cm-lintRange-warning').count(), 0, 'nothing is underlined before the report: no linter runs in the page');
        await page.waitForSelector('.cm-lintRange-error');
        assert.equal(await page.textContent('#count-errors'), '✕ 1 error');
        const underlined = await page.evaluate(() =>
          [...document.querySelectorAll('.cm-lintRange-error, .cm-lintRange-warning')].map((range) => ({text: range.textContent, line: range.closest('.cm-line')?.textContent})),
        );
        assert.deepEqual(underlined, [{text: 'bogus_key', line: '    bogus_key: 1'}], 'one underline, from the report alone');
        assert.equal(await page.locator('.cm-lint-marker-error').count(), 1);
        assert.match((await page.textContent('#cursor-message')) ?? '', new RegExp(`^${line}: .+ \\(R09\\)$`));
        // The frame keeps the last good build, dimmed, and says so.
        assert.equal(await page.isVisible('#preview-stale'), true);
        assert.equal(await page.textContent('#preview-stale'), 'Preview is from before the error');
        assert.equal(await page.evaluate(() => document.getElementById('stage')!.classList.contains('is-stale')), true);
        const status = await statusLine(page);
        assert.deepEqual([status.preview, status.tone], ['1 error. The preview shows the last good build.', 'tone-error']);

        await page.click('#count-errors');
        assert.equal(await page.getAttribute('#count-errors', 'aria-expanded'), 'true');
        const item = page.locator('.diagnostics-item');
        assert.equal(await item.count(), 1);
        assert.equal(await item.locator('.diagnostics-where').textContent(), `papeleria.yaml:${line}:5`);
        await placeCursor(page, 1);
        await item.locator('.diagnostics-jump').click();
        assert.equal(await cursorLine(page), line, 'a finding in the list jumps to its line');

        // Fixed: the frame catches up and the dimming goes.
        await page.keyboard.press('End');
        await page.keyboard.press('Shift+Home');
        await page.keyboard.press('Backspace');
        await page.keyboard.press('Backspace');
        await page.waitForFunction(() => document.getElementById('preview-stale')!.hidden);
        assert.equal(await page.textContent('#count-errors'), '✕ 0 errors');
        assert.equal(await page.locator('.cm-lintRange-error').count(), 0);
        assert.deepEqual(problems, []);
      });
    });

    test('every dirty Markdown buffer is in the preview, and none reaches the disk (A9)', TIMEOUT, async () => {
      await withEditor({prepare: withStatementNotes}, async ({page, root}) => {
        const first = (await shown(page))!;
        await openFile(page, 'assets/text/01-cover-notes.md');
        await placeCursor(page, 3);
        await page.keyboard.type(' Typed in the cover notes.', TYPING);
        await openFile(page, 'assets/text/02-statement-notes.md');
        await placeCursor(page, 1);
        await page.keyboard.type(' Typed in the statement notes.', TYPING);
        await nextShown(page, first);
        await page.waitForFunction(() => document.getElementById('stage')!.dataset['requestId'] !== undefined);
        const deadline = Date.now() + 15_000;
        let text = await shownText(page);
        while (!(text.includes('Typed in the cover notes.') && text.includes('Typed in the statement notes.')) && Date.now() < deadline) {
          await pause(100);
          text = await shownText(page);
        }
        assert.match(text, /Replace every slide\. Typed in the cover notes\./);
        assert.match(text, /Statement notes on disk\. Typed in the statement notes\./);
        assert.deepEqual(await tabLabels(page), ['papeleria.yaml', '01-cover-notes.md ●', '02-statement-notes.md ●']);
        assert.doesNotMatch(readFileSync(join(root, 'assets', 'text', '01-cover-notes.md'), 'utf8'), /Typed/);
        assert.equal(readFileSync(join(root, 'assets', 'text', '02-statement-notes.md'), 'utf8'), 'Statement notes on disk.\n');
      });
    });

    test('a file changed on disk is taken in under a clean tab; under a dirty one a banner offers Reload or Keep mine, and nothing is overwritten', TIMEOUT, async () => {
      await withEditor({}, async ({page, root}) => {
        const manifest = join(root, 'papeleria.yaml');
        const original = readFileSync(manifest, 'utf8');
        writeFileSync(manifest, original.replace('Care should be visible in the work.', 'Changed on disk.'));
        await page.waitForFunction(() => window.papeleriaTestView!().state.doc.toString().includes('Changed on disk.'));
        assert.equal(await note(page, /changed on disk and was reloaded/), 'papeleria.yaml changed on disk and was reloaded.');
        assert.deepEqual(await tabLabels(page), ['papeleria.yaml']);

        // Dirty, then changed on disk: a conflict.
        await placeCursor(page, await lineOf(page, 'title: Changed on disk.'));
        await page.keyboard.type(' Mine.', TYPING);
        const external = readFileSync(manifest, 'utf8').replace('Proposed brand principle', 'An external footer');
        writeFileSync(manifest, external);
        await page.waitForSelector('#banner:not([hidden])');
        assert.equal(await page.textContent('#banner-text'), 'papeleria.yaml changed on disk. Reload it, or keep yours.');
        assert.deepEqual(await tabLabels(page), ['papeleria.yaml ● ⚠']);
        assert.equal(await page.isVisible('#banner-reload'), true);
        assert.equal(await page.isVisible('#banner-keep'), true);
        assert.equal(await page.isDisabled('#build'), true);
        assert.equal(await page.isDisabled('#check'), true);
        await page.keyboard.press('Control+S');
        await pause(500);
        assert.equal(readFileSync(manifest, 'utf8'), external, 'a save during a conflict writes nothing');

        // Keep mine: the buffer stays; the next save is checked against the disk's revision.
        await page.click('#banner-keep');
        assert.equal(await page.isHidden('#banner'), true);
        assert.deepEqual(await tabLabels(page), ['papeleria.yaml ●']);
        await placeCursor(page, 1);
        await page.keyboard.press('Control+S');
        await note(page, /^Saved /);
        const mine = readFileSync(manifest, 'utf8');
        assert.match(mine, /title: Changed on disk\. Mine\./);
        assert.match(mine, /Proposed brand principle/);
        assert.equal(mine, await bufferText(page));

        // Dirty again, changed again: Reload takes the disk's text.
        await placeCursor(page, await lineOf(page, 'title: Changed on disk. Mine.'));
        await page.keyboard.type(' Again.', TYPING);
        writeFileSync(manifest, mine.replace('Mine.', 'Theirs.'));
        await page.waitForSelector('#banner:not([hidden])');
        await page.click('#banner-reload');
        await page.waitForFunction(() => document.getElementById('banner')!.hidden);
        assert.equal(await bufferText(page), mine.replace('Mine.', 'Theirs.'));
        assert.deepEqual(await tabLabels(page), ['papeleria.yaml']);
      });
    });

    test('a write made elsewhere and then undone under unsaved work ends the conflict, and the next save writes the buffer (W5R-14)', TIMEOUT, async () => {
      await withEditor({}, async ({page, root}) => {
        const manifest = join(root, 'papeleria.yaml');
        const original = readFileSync(manifest, 'utf8');
        await placeCursor(page, await lineOf(page, STATEMENT));
        await page.keyboard.type(' Mine.', TYPING);
        writeFileSync(manifest, original.replace('Proposed brand principle', 'An external footer'));
        await page.waitForSelector('#banner:not([hidden])');
        assert.deepEqual(await tabLabels(page), ['papeleria.yaml ● ⚠']);
        // The other program puts the file back as it was: the disk holds the tab's base again.
        writeFileSync(manifest, original);
        await page.waitForSelector('#banner', {state: 'hidden'});
        assert.deepEqual(await tabLabels(page), ['papeleria.yaml ●']);
        assert.equal(await page.isEnabled('#check'), true);
        assert.match(await bufferText(page), /in the work\. Mine\./, 'the buffer is the author’s, as it was');
        await page.keyboard.press('Control+S');
        await note(page, /^Saved /);
        assert.equal(readFileSync(manifest, 'utf8'), await bufferText(page), 'saved against the revision the disk holds: no conflict');
      });
    });

    test('Save all saves the changed tabs in order and stops at the first conflict', TIMEOUT, async () => {
      await withEditor({}, async ({page, root}) => {
        const notes = join(root, 'assets', 'text', '01-cover-notes.md');
        await openFile(page, 'assets/text/01-cover-notes.md');
        await placeCursor(page, 1);
        await page.keyboard.type(' Edited here.', TYPING);
        await selectTab(page, 'papeleria.yaml');
        await placeCursor(page, await lineOf(page, STATEMENT));
        await page.keyboard.type(' Edited here.', TYPING);
        writeFileSync(notes, 'Rewritten by another program.\n');
        await page.waitForFunction(() => [...document.querySelectorAll('[role=tab]')].some((tab) => tab.textContent!.includes('⚠')));
        await page.click('#save-all');
        assert.equal(
          await note(page, /^Saved 1 file, then stopped/),
          'Saved 1 file, then stopped: assets/text/01-cover-notes.md changed on disk. The files after it were not saved.',
        );
        assert.match(readFileSync(join(root, 'papeleria.yaml'), 'utf8'), /in the work\. Edited here\./);
        assert.equal(readFileSync(notes, 'utf8'), 'Rewritten by another program.\n');
        assert.deepEqual(await tabLabels(page), ['papeleria.yaml', '01-cover-notes.md ● ⚠']);
      });
    });

    test('a CSV file opens read-only, as a table', TIMEOUT, async () => {
      await withEditor({}, async ({page}) => {
        await page.click('#files-toggle');
        assert.deepEqual(await page.locator('#files h2').allTextContents(), ['Markdown', 'Data, read-only']);
        await page.click('#files button[data-path="assets/data/hours-by-phase.csv"]');
        await page.waitForSelector('.editor-panel:not([hidden]) table');
        assert.deepEqual(await tabLabels(page), ['papeleria.yaml', 'hours-by-phase.csv']);
        assert.equal(await page.getAttribute('[role=tab][title="assets/data/hours-by-phase.csv"]', 'aria-label'), 'hours-by-phase.csv, read-only');
        const table = page.locator('.editor-panel:not([hidden]) table');
        assert.deepEqual(await table.locator('th').allTextContents(), ['phase', 'hours']);
        assert.deepEqual(await table.locator('tbody tr').first().locator('td').allTextContents(), ['Review', '41']);
        assert.equal(await page.locator('.editor-panel:not([hidden]) .cm-content').count(), 0, 'no text editor for CSV');
        assert.equal(await page.isDisabled('#save'), true);
      });
    });

    test('closing the page with unsaved work asks first; with none it does not', TIMEOUT, async () => {
      await withEditor({}, async ({page, context}) => {
        await placeCursor(page, await lineOf(page, STATEMENT));
        await page.keyboard.type(' Unsaved.', TYPING);
        const asked = new Promise<string>((resolveDialog) => {
          page.once('dialog', (dialog) => {
            resolveDialog(dialog.type());
            void dialog.dismiss();
          });
        });
        await page.close({runBeforeUnload: true});
        assert.equal(await asked, 'beforeunload');
        await pause(300);
        assert.equal(page.isClosed(), false, 'dismissing the warning keeps the page');

        await page.keyboard.press('Control+S');
        await note(page, /^Saved /);
        let dialogs = 0;
        page.on('dialog', (dialog) => {
          dialogs += 1;
          void dialog.accept();
        });
        const closed = new Promise<void>((resolveClose) => page.once('close', () => resolveClose()));
        await page.close({runBeforeUnload: true});
        await closed;
        assert.equal(dialogs, 0);
        assert.ok(context.pages().every((open) => open !== page));
      });
    });

    test('Follow keeps the preview on the cursor’s slide; without it the page stays where it is', TIMEOUT, async () => {
      await withEditor({}, async ({page}) => {
        assert.equal(await page.getAttribute('#follow', 'aria-pressed'), 'true');
        await placeCursor(page, await lineOf(page, 'title: The record should outlast the meeting.'));
        await waitForSlide(page, 3);
        const id = (await shown(page))!;
        assert.equal(await frameOf(page, id).evaluate(() => location.hash), '#slide-3', 'goTo is the deck’s own change, never a reader’s navigation');

        await page.click('#follow');
        assert.equal(await page.getAttribute('#follow', 'aria-pressed'), 'false');
        await placeCursor(page, await lineOf(page, 'title: Build a practice people can carry forward.'));
        await pause(800);
        assert.equal(await currentSlide(page), 3);

        await page.click('#follow');
        await placeCursor(page, await lineOf(page, 'title: Where the hours went.'));
        await waitForSlide(page, 4);
        // A rebuild opens the new frame at the cursor's slide.
        await page.keyboard.type(' Still here.', TYPING);
        await nextShown(page, id);
        await waitForSlide(page, 4);
      });
    });

    test('Phone, Tablet and Desktop size the frame and scale it into the pane, keeping the slide', TIMEOUT, async () => {
      await withEditor({}, async ({page}) => {
        await placeCursor(page, await lineOf(page, STATEMENT));
        await waitForSlide(page, 2);
        const stageWidth = await page.evaluate(() => document.getElementById('stage')!.getBoundingClientRect().width);
        for (const [label, width] of [
          ['Phone', 390],
          ['Tablet', 834],
          ['Desktop', 1280],
        ] as const) {
          await page.click(`.preview-widths button:text-is("${label}")`);
          assert.equal(await page.getAttribute(`.preview-widths button:text-is("${label}")`, 'aria-pressed'), 'true');
          const frame = await page.evaluate(() => {
            const iframe = document.querySelector<HTMLIFrameElement>('.preview-frame:not(.is-loading)')!;
            return {width: iframe.style.width, scale: Number(iframe.dataset['scale']), drawn: iframe.getBoundingClientRect().width};
          });
          const scale = Math.min(1, stageWidth / width);
          assert.equal(frame.width, `${width}px`, label);
          assert.ok(Math.abs(frame.scale - scale) < 0.001, `${label}: scale ${frame.scale}, expected ${scale}`);
          assert.ok(frame.drawn <= stageWidth + 1, `${label}: the scaled frame fits the pane`);
          const inner = await frameOf(page, (await shown(page))!).evaluate(() => window.innerWidth);
          assert.equal(inner, width, `${label}: the page lays out at ${width} px`);
          assert.equal(await currentSlide(page), 2, `${label}: the slide is kept`);
        }
      });
    });

    test('Open in a new tab shows the generation at its place, as a reader gets it', TIMEOUT, async () => {
      await withEditor({}, async ({page, context, session}) => {
        await placeCursor(page, await lineOf(page, STATEMENT));
        await waitForSlide(page, 2);
        const id = (await shown(page))!;
        const opened = context.waitForEvent('page');
        await page.click('#open-tab');
        const tab = await opened;
        await tab.waitForLoadState('load');
        assert.equal(tab.url(), `${session.previewOrigin}/${id}/index.html#slide-2`);
        assert.equal(await tab.evaluate(() => window.opener), null);
        await tab.waitForFunction(() => (window as unknown as {papeleriaDeck?: {current: number}}).papeleriaDeck?.current === 2);
        await tab.close();
      });
    });

    test('an older reply never replaces a newer preview or its findings (A9)', TIMEOUT, async () => {
      await withEditor({}, async ({page, session}) => {
        let delayed = 0;
        let released = false;
        await page.route(`${session.editorOrigin}/api/preview`, async (route) => {
          if (delayed === 0) {
            delayed = (JSON.parse(route.request().postData() ?? '{}') as {requestId: number}).requestId;
            const response = await route.fetch();
            await pause(2500);
            released = true;
            await route.fulfill({response});
            return;
          }
          await route.continue();
        });
        const first = (await shown(page))!;
        // The first request carries an unknown key and is held back; the second takes it out again.
        const line = await lineOf(page, 'footer: Proposed brand principle');
        await placeCursor(page, line);
        await page.keyboard.press('Enter');
        await page.keyboard.type('bogus_key: 1', TYPING);
        await until(() => delayed > 0, 'the first request is held');
        await page.keyboard.press('End');
        await page.keyboard.press('Shift+Home');
        await page.keyboard.press('Backspace');
        await page.keyboard.press('Backspace');
        await placeCursor(page, await lineOf(page, STATEMENT));
        await page.keyboard.type(' Newer.', TYPING);
        const newer = await nextShown(page, first);
        assert.equal(released, false, 'the newer preview is shown before the older reply returns');
        await until(() => released, 'the older reply returns', 10_000);
        await pause(700);
        assert.equal(await shown(page), newer, 'the older reply did not replace the newer preview');
        assert.match(await shownText(page), /in the work\. Newer\./);
        assert.equal(await page.textContent('#count-errors'), '✕ 0 errors', 'nor its findings');
        assert.equal(await page.isHidden('#preview-stale'), true);
        assert.ok(Number(await page.evaluate(() => document.getElementById('stage')!.dataset['requestId'])) > delayed);
      });
    });

    test('Escape closes completion first; from the preview it returns to the source where it was', TIMEOUT, async () => {
      await withEditor({}, async ({page, session}) => {
        await placeCursor(page, await lineOf(page, 'status: draft'));
        await page.keyboard.press('Enter');
        await page.keyboard.type('word', TYPING);
        await page.keyboard.press('Control+Space');
        await page.waitForSelector('.cm-tooltip-autocomplete');
        await page.keyboard.press('Escape');
        await page.waitForSelector('.cm-tooltip-autocomplete', {state: 'detached'});
        assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('cm-content')), true, 'Escape closed completion and nothing else');
        const line = await cursorLine(page);

        const id = (await shown(page))!;
        await page.frameLocator(`iframe[data-generation-id="${id}"]`).locator('main').click({position: {x: 20, y: 20}});
        assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'IFRAME');
        // What the frame sends, so a failure says whether returnFocus arrived.
        await page.evaluate((origin) => {
          const seen: unknown[] = [];
          (window as unknown as {framesSaid: unknown[]}).framesSaid = seen;
          window.addEventListener('message', (event) => {
            if (event.origin === origin) {
              seen.push(event.data);
            }
          });
        }, session.previewOrigin);
        await page.keyboard.press('Escape');
        try {
          await page.waitForFunction(() => document.activeElement?.classList.contains('cm-content') === true, null, {timeout: 10_000});
        } catch (error) {
          const state = await page.evaluate(() => ({
            active: `${document.activeElement?.tagName ?? 'none'}.${document.activeElement?.className ?? ''}`,
            said: (window as unknown as {framesSaid: unknown[]}).framesSaid,
          }));
          throw new Error(`focus did not come back to the source: ${JSON.stringify(state)}`, {cause: error});
        }
        assert.equal(await cursorLine(page), line, 'the selection is where it was');
      });
    });

    test('Escape in a full-screen preview leaves full screen first, and only the next one returns to the source (IC06)', TIMEOUT, async () => {
      await withEditor({}, async ({page, session}) => {
        await placeCursor(page, await lineOf(page, 'status: draft'));
        const line = await cursorLine(page);
        const id = (await shown(page))!;
        const frame = frameOf(page, id);
        // Full screen as the page sees it. An engine may refuse a real one to a headless frame, so the page is told it is
        // full screen, and the one call that leaves it is counted.
        await frame.evaluate(() => {
          const page = window as unknown as {exits: number};
          let element: Element | null = document.documentElement;
          page.exits = 0;
          Object.defineProperty(document, 'fullscreenElement', {configurable: true, get: () => element});
          document.exitFullscreen = () => {
            element = null;
            page.exits += 1;
            return Promise.resolve();
          };
        });
        await page.evaluate((origin) => {
          const said: unknown[] = [];
          (window as unknown as {framesSaid: unknown[]}).framesSaid = said;
          window.addEventListener('message', (event) => {
            if (event.origin === origin) {
              said.push(event.data);
            }
          });
        }, session.previewOrigin);
        // What the frame said that counts here: returnFocus, and the test's own marker (a scroll or a ready may come too).
        const said = (): Promise<unknown[]> =>
          page.evaluate(() =>
            (window as unknown as {framesSaid: unknown[]}).framesSaid.filter((data) => data === 'after the first Escape' || (data as {type?: unknown} | null)?.type === 'returnFocus'),
          );
        await page.frameLocator(`iframe[data-generation-id="${id}"]`).locator('main').click({position: {x: 20, y: 20}});

        await page.keyboard.press('Escape');
        await frame.waitForFunction(() => (window as unknown as {exits: number}).exits === 1);
        // Messages from one window arrive in the order sent: once this one has come, a returnFocus sent for the first Escape would have too.
        await frame.evaluate((editor) => window.parent.postMessage('after the first Escape', editor), session.editorOrigin);
        await page.waitForFunction(() => (window as unknown as {framesSaid: unknown[]}).framesSaid.includes('after the first Escape'));
        assert.deepEqual(await said(), ['after the first Escape'], 'the first Escape only left full screen');
        assert.equal(await frame.evaluate(() => document.fullscreenElement), null);
        assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'IFRAME', 'the preview keeps focus');

        await page.keyboard.press('Escape');
        await page.waitForFunction(() => document.activeElement?.classList.contains('cm-content') === true, null, {timeout: 10_000});
        assert.deepEqual(await said(), ['after the first Escape', {type: 'returnFocus', generationId: id}]);
        assert.equal(await frame.evaluate(() => (window as unknown as {exits: number}).exits), 1);
        assert.equal(await cursorLine(page), line, 'the selection is where it was');
      });
    });

    test('a lost connection says Papeleria stopped, and the editor carries on when the server answers again', TIMEOUT, async () => {
      await withEditor({}, async ({page, session}) => {
        session.dropEventStreams();
        await page.waitForSelector('#banner.is-stopped:not([hidden])');
        assert.equal(await page.textContent('#banner-text'), 'Papeleria stopped. Start it again from the terminal.');
        assert.equal(await page.isHidden('#banner-reload'), true);
        assert.equal(await page.isDisabled('#build'), true);
        assert.equal(await page.isDisabled('#check'), true);
        await page.waitForSelector('#banner', {state: 'hidden', timeout: 15_000});
        assert.equal(await page.isEnabled('#build'), true);
        const before = (await shown(page))!;
        await placeCursor(page, await lineOf(page, STATEMENT));
        await page.keyboard.type(' Back.', TYPING);
        await nextShown(page, before);
        assert.match(await shownText(page), /in the work\. Back\./);

        await session.close();
        await page.waitForSelector('#banner.is-stopped:not([hidden])');
        await pause(2500);
        assert.equal(await page.isVisible('#banner.is-stopped'), true, 'while the server is gone, it stays said');
      });
    });

    test('an event sent before the page’s stream is open is not lost: the page takes the piece again, then previews', TIMEOUT, async () => {
      let releaseEvents = (): void => {};
      const eventsHeld = new Promise<void>((resolveHeld) => {
        releaseEvents = resolveHeld;
      });
      let streamAsked = false;
      let previewsAsked = 0;
      const hooks = {
        beforeEvents: async (): Promise<void> => {
          streamAsked = true;
          await eventsHeld;
        },
        beforePreview: async (): Promise<void> => {
          previewsAsked += 1;
        },
      };
      await withEditor({waitFor: 'editor', hooks}, async ({page, root, session}) => {
        try {
          await until(() => streamAsked, 'the page asks for its event stream');
          // While the stream waits, the manifest changes on disk: the server tells no page, since none is listening yet.
          const before = await lastEventId(session);
          const manifest = join(root, 'papeleria.yaml');
          writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('Care should be visible in the work.', 'Changed before the stream.'));
          const deadline = Date.now() + 15_000;
          while ((await lastEventId(session)) === before) {
            if (Date.now() > deadline) {
              throw new Error('the server never sent file-changed');
            }
            await pause(50);
          }
          await pause(300);
          assert.equal(previewsAsked, 0, 'no preview is asked for before the stream is open: its preview-built would be lost');
          assert.equal(await shown(page), undefined);

          releaseEvents();
          await nextShown(page, undefined);
          assert.match(await shownText(page), /Changed before the stream\./);
          assert.match(await bufferText(page), /title: Changed before the stream\./);
          assert.equal(await note(page, /changed on disk and was reloaded/), 'papeleria.yaml changed on disk and was reloaded.');
          assert.deepEqual(await tabLabels(page), ['papeleria.yaml']);
        } finally {
          releaseEvents();
        }
      });
    });

    test('a finding with no line is listed by its file alone, and its related place is where the list takes the author', TIMEOUT, async () => {
      await withEditor({prepare: withBrokenImage, waitFor: 'editor'}, async ({page}) => {
        await page.waitForFunction(() => document.getElementById('count-errors')!.textContent !== '✕ 0 errors');
        await page.click('#count-errors');
        const item = page.locator('.diagnostics-item', {hasText: 'assets/images/broken.png'});
        assert.equal(await item.count(), 1);
        assert.equal(await item.locator('.diagnostics-where').textContent(), 'assets/images/broken.png', 'no line is invented');
        const related = (await item.locator('.diagnostics-related').textContent()) ?? '';
        const match = /^See papeleria\.yaml:([0-9]+)(?::[0-9]+)?$/.exec(related);
        assert.ok(match !== null, related);
        assert.equal(await page.locator('.cm-lintRange-error').count(), 0, 'nothing in the manifest is underlined for it');
        await item.locator('.diagnostics-jump').click();
        assert.equal(await cursorLine(page), Number(match[1]));
        assert.match(await page.evaluate(() => {
          const {state} = window.papeleriaTestView!();
          return state.doc.line(state.doc.lineAt(state.selection.main.head).number).text;
        }), /broken\.png/);
      });
    });

    test('a piece that fails from its first preview shows no frame and says why, until the first good one (IC06)', TIMEOUT, async () => {
      const failing = (root: string): void => {
        const manifest = join(root, 'papeleria.yaml');
        writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('layout: statement', 'layout: poster'));
      };
      await withEditor({prepare: failing, waitFor: 'editor'}, async ({page}) => {
        const empty = /^[0-9]+ errors?\. There is no preview until they are fixed\.$/;
        await page.waitForFunction((source) => new RegExp(source).test(document.getElementById('preview-empty')?.textContent ?? ''), empty.source, {timeout: 20_000});
        assert.equal(await page.isVisible('#preview-empty'), true);
        assert.equal(await page.locator('#stage iframe').count(), 0, 'no frame, not even a blank one');
        assert.equal(await page.isHidden('#preview-stale'), true, 'no older build to show');
        const status = await statusLine(page);
        assert.deepEqual([status.preview, status.tone], [await page.textContent('#preview-empty'), 'tone-error']);
        assert.equal(await page.isDisabled('#open-tab'), true);
        await page.waitForSelector('.cm-lintRange-error');

        // Fixed: the first good preview takes the empty state's place.
        await placeCursor(page, await lineOf(page, 'layout: poster'));
        for (let typed = 0; typed < 'poster'.length; typed += 1) {
          await page.keyboard.press('Backspace');
        }
        await page.keyboard.type('statement', TYPING);
        await nextShown(page, undefined);
        assert.equal(await page.isHidden('#preview-empty'), true);
        assert.equal(await page.isEnabled('#open-tab'), true);
        assert.equal((await statusLine(page)).tone, 'tone-success');
      });
    });
  });
}
