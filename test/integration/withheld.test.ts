/**
 * M5.4 part 2, A12, C21, IC05 (W5C, D133): a withheld piece writes nothing.
 *
 * For each template, from the Spanish fixture of test/fixtures/localization/:
 *
 *  (a) a fresh piece built withheld: `build` exits 0 and says why nothing was
 *      written, the report says `outputWritten: false` and `outputReason:
 *      'withheld'`, and no `dist/` is made;
 *  (b) a piece with the complete `dist/` of an earlier build, switched to
 *      withheld: `build` leaves every entry in `dist/` as it was — the same
 *      paths, bytes, inode and modification time, directories included — and
 *      warns on stderr that the older `dist/` is not this withheld preview;
 *  (c) `check --json` on a withheld piece reports `check_only` and changes
 *      nothing;
 *  (d) the editor's preview API (W3A) and `papeleria serve` still build a
 *      private generation of it, showing its withheld status, while `dist/`
 *      stays absent or exactly as it was.
 *
 * The compiled CLI runs as a child process, where exit codes and streams are
 * the point; the pipeline runs in process, where the report is.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, lstatSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {after, describe, test} from 'node:test';

import {runPipeline} from '../../src/build/pipeline.js';
import {revisionOf, startServe} from '../../src/server/index.js';
import {applicationRoot, fixturePath, runNode} from '../helpers/paths.js';
import {copyPiece, removeTemporaryFolders} from '../helpers/pieces.js';
import {body, call, json, openEvents, session} from './server-helpers.js';

after(removeTemporaryFolders);

const CLI = join(applicationRoot, 'lib', 'src', 'cli', 'index.js');
const TEMPLATES = ['deck', 'comic', 'document'] as const;
type Template = (typeof TEMPLATES)[number];

const ES = JSON.parse(readFileSync(join(applicationRoot, 'templates', 'shared', 'strings.es.json'), 'utf8')) as Record<string, string>;

/** The element each template shows its status in (D61, D94, D105), and how many of them the fixture has. */
const STATUS_ELEMENT: Readonly<Record<Template, {readonly pattern: RegExp; readonly count: number}>> = {
  deck: {pattern: /<span class="slide-status">([^<]*)<\/span>/g, count: 4},
  comic: {pattern: /<span class="comic-status-label">([^<]*)<\/span>/g, count: 1},
  document: {pattern: /<span class="doc-status">([^<]*)<\/span>/g, count: 2},
};

function piece(template: Template, label: string): string {
  return copyPiece(fixturePath('localization', template, 'es'), `withheld-${template}-${label}`);
}

function setStatus(root: string, status: 'draft' | 'withheld'): void {
  const manifest = join(root, 'papeleria.yaml');
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replace(/^status: \w+$/m, `status: ${status}`));
}

type Entry = {
  readonly path: string;
  readonly kind: 'file' | 'directory';
  readonly sha256: string | null;
  readonly size: number;
  readonly ino: number;
  readonly mtimeMs: number;
};

/**
 * Every entry under `directory`, the folder itself included, in path order:
 * a file's SHA-256 and size, and every entry's inode and modification time,
 * so a file rewritten with the same bytes, or an entry added or removed in a
 * folder, still shows.
 */
function tree(directory: string, prefix = '.'): Entry[] {
  const stat = lstatSync(directory);
  const entries: Entry[] = [{path: prefix, kind: 'directory', sha256: null, size: 0, ino: stat.ino, mtimeMs: stat.mtimeMs}];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const entry = lstatSync(path);
    if (entry.isDirectory()) {
      entries.push(...tree(path, `${prefix}/${name}`));
    } else {
      assert.ok(entry.isFile(), `${path} is a regular file`);
      const bytes = readFileSync(path);
      entries.push({path: `${prefix}/${name}`, kind: 'file', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, ino: entry.ino, mtimeMs: entry.mtimeMs});
    }
  }
  return entries;
}

/** One SHA-256 over every file's path and bytes, for the record. */
function treeDigest(entries: readonly Entry[]): string {
  const hash = createHash('sha256');
  for (const entry of entries.filter((item) => item.kind === 'file')) {
    hash.update(`${entry.path}\0${entry.sha256}\n`);
  }
  return hash.digest('hex');
}

/** Generations a run left in `.papeleria/staging/`: none, once it has finished. */
function stagingLeft(root: string): string[] {
  const staging = join(root, '.papeleria', 'staging');
  return existsSync(staging) ? readdirSync(staging) : [];
}

function previewRequest(root: string, requestId: number): Record<string, unknown> {
  const manifestText = readFileSync(join(root, 'papeleria.yaml'), 'utf8');
  return {
    requestId,
    manifestPath: 'papeleria.yaml',
    manifestText,
    manifestBaseRevision: revisionOf(manifestText),
    overlays: [],
    cursor: {path: 'papeleria.yaml', line: 1, column: 1},
  };
}

/** The status labels a page shows, where its template shows them. */
function statusLabels(template: Template, html: string): string[] {
  return Array.from(html.matchAll(STATUS_ELEMENT[template].pattern), (match) => match[1]!);
}

const WITHHELD_NOTE = /is withheld: nothing was written to dist\//;
const OLDER_DIST_WARNING = /warning: .*dist holds an older build, which was left as it was\. It is not this withheld preview/;

for (const template of TEMPLATES) {
  describe(`${template}: withheld (IC05, C21)`, () => {
    test('(a) a fresh piece: build exits 0, reports withheld, and makes no dist/', async () => {
      const root = piece(template, 'fresh');
      setStatus(root, 'withheld');

      const built = await runNode(CLI, ['build', root]);
      assert.equal(built.code, 0, built.stderr);
      assert.equal(built.stdout, '');
      assert.match(built.stderr, WITHHELD_NOTE);
      assert.doesNotMatch(built.stderr, OLDER_DIST_WARNING, 'there is no older dist/ to warn about');
      assert.equal(existsSync(join(root, 'dist')), false, 'no dist/ was made');

      const {report, olderDist, preview} = await runPipeline({root, label: 'piece'}, {kind: 'dist'});
      assert.deepEqual(
        {status: report.status, errors: report.errors, outputWritten: report.outputWritten, outputReason: report.outputReason, olderDist, preview},
        {status: 'ok', errors: 0, outputWritten: false, outputReason: 'withheld', olderDist: false, preview: null},
      );
      assert.equal(existsSync(join(root, 'dist')), false);
      assert.deepEqual(stagingLeft(root), [], 'the discarded generation is gone');

      const checked = await runNode(CLI, ['check', root, '--json']);
      assert.equal(checked.code, 0, checked.stderr);
      const json = JSON.parse(checked.stdout) as {status: string; outputWritten: boolean; outputReason: string};
      assert.deepEqual([json.status, json.outputWritten, json.outputReason], ['ok', false, 'check_only'], '(c) on a fresh piece');
      assert.equal(existsSync(join(root, 'dist')), false);
    });

    test('(b) an existing dist/: build leaves every entry as it was and warns that it is not this preview; (c) check --json changes nothing', async (context) => {
      const root = piece(template, 'existing');
      const first = await runNode(CLI, ['build', root]);
      assert.equal(first.code, 0, first.stderr);
      const dist = join(root, 'dist');
      const before = tree(dist);
      assert.ok(before.some((entry) => entry.path === './index.html'), 'the earlier build is complete');
      assert.deepEqual(statusLabels(template, readFileSync(join(dist, 'index.html'), 'utf8')), Array(STATUS_ELEMENT[template].count).fill(ES['status_draft']));

      setStatus(root, 'withheld');
      const built = await runNode(CLI, ['build', root]);
      assert.equal(built.code, 0, built.stderr);
      assert.match(built.stderr, WITHHELD_NOTE);
      assert.match(built.stderr, OLDER_DIST_WARNING);
      const afterBuild = tree(dist);
      assert.deepEqual(afterBuild, before, 'build changed nothing in dist/');

      const {report, olderDist} = await runPipeline({root, label: 'piece'}, {kind: 'dist'});
      assert.deepEqual([report.outputWritten, report.outputReason, olderDist], [false, 'withheld', true]);
      assert.deepEqual(tree(dist), before, 'nor did the pipeline run in process');

      const checked = await runNode(CLI, ['check', '--json', root]);
      assert.equal(checked.code, 0, checked.stderr);
      assert.equal(checked.stdout.split('\n').length, 2, 'one JSON value, then the end');
      const json = JSON.parse(checked.stdout) as {status: string; errors: number; outputWritten: boolean; outputReason: string};
      assert.deepEqual([json.status, json.errors, json.outputWritten, json.outputReason], ['ok', 0, false, 'check_only']);
      const afterCheck = tree(dist);
      assert.deepEqual(afterCheck, before, 'check changed nothing in dist/');
      assert.deepEqual(stagingLeft(root), []);

      const files = before.filter((entry) => entry.kind === 'file').length;
      context.diagnostic(
        `withheld ${template}: dist/ ${files} files, ${before.length - files} folders; digest before ${treeDigest(before)}, ` +
          `after build ${treeDigest(afterBuild)}, after check ${treeDigest(afterCheck)}; inodes and modification times unchanged`,
      );
    });

    test('(d) the editor’s preview API and serve still build a private generation, and dist/ stays as it was', async () => {
      // A fresh withheld piece previews, and still has no dist/.
      const fresh = piece(template, 'preview-fresh');
      setStatus(fresh, 'withheld');
      const editorOnFresh = await session(fresh);
      try {
        const reply = await editorOnFresh.api('/api/preview', {method: 'POST', ...body(previewRequest(fresh, 1))});
        assert.equal(reply.status, 200, reply.body);
        const payload = json(reply) as {report: {status: string; outputWritten: boolean; outputReason: string}; generationId: string | null; generationURL: string | null};
        assert.deepEqual([payload.report.status, payload.report.outputWritten, payload.report.outputReason], ['ok', false, 'preview_only']);
        assert.notEqual(payload.generationId, null);
        const page = await call(payload.generationURL!);
        assert.equal(page.status, 200);
        assert.deepEqual(statusLabels(template, page.body), Array(STATUS_ELEMENT[template].count).fill(ES['status_withheld']), 'the preview says it is withheld');
      } finally {
        await editorOnFresh.close();
      }
      assert.equal(existsSync(join(fresh, 'dist')), false);

      // A piece with an older dist/, switched to withheld: previews, and dist/ is untouched.
      const root = piece(template, 'preview-existing');
      assert.equal((await runNode(CLI, ['build', root])).code, 0);
      const dist = join(root, 'dist');
      const before = tree(dist);
      setStatus(root, 'withheld');

      const editor = await session(root);
      try {
        const reply = await editor.api('/api/preview', {method: 'POST', ...body(previewRequest(root, 1))});
        assert.equal(reply.status, 200, reply.body);
        const payload = json(reply) as {report: {outputReason: string}; generationId: string | null; generationURL: string | null};
        assert.equal(payload.report.outputReason, 'preview_only');
        assert.match(payload.generationId ?? '', /^[0-9a-z]+-[0-9a-f]{12}$/);
        const page = await call(payload.generationURL!);
        assert.equal(page.status, 200);
        assert.deepEqual(statusLabels(template, page.body), Array(STATUS_ELEMENT[template].count).fill(ES['status_withheld']));
        assert.ok(existsSync(join(root, '.papeleria', 'preview', payload.generationId!, 'index.html')), 'the generation is private, under .papeleria/preview/');
      } finally {
        await editor.close();
      }
      assert.deepEqual(tree(dist), before, 'the editor’s preview changed nothing in dist/');

      const logs: string[] = [];
      const served = await startServe({root, label: 'piece', log: (line) => logs.push(line)});
      try {
        await served.settled();
        const stream = await openEvents(`${served.origin}/events`, {});
        const hello = await stream.next((event) => event.event === 'hello');
        stream.close();
        const shown = hello.data['shown'] as {generationURL: string} | null;
        assert.ok(shown !== null, `serve shows the withheld piece: ${logs.join('\n')}`);
        const page = await call(shown.generationURL);
        assert.equal(page.status, 200);
        assert.deepEqual(statusLabels(template, page.body), Array(STATUS_ELEMENT[template].count).fill(ES['status_withheld']));
      } finally {
        await served.close();
      }
      assert.deepEqual(tree(dist), before, 'serve changed nothing in dist/');
    });
  });
}
