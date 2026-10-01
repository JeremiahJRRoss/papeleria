/**
 * M5.3 (D126): scripts/fetch-license-texts.mjs. A check compares upstream with
 * what is retained and writes nothing: no text, no index, and not the folder it
 * would have written into (the Codex review of PR #25). It compares each text
 * with its index entry and with the file on disk (W5R-05). Upstream is stubbed,
 * so the tests run offline.
 */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, test} from 'node:test';
import {pathToFileURL} from 'node:url';

import {scriptPath} from '../helpers/paths.js';

type FetchModule = {
  SPDX_COMMIT: string;
  REQUIRED: readonly {id: string}[];
  fetchAll(outDirectory: string, options?: {refresh?: boolean; write?: boolean}): Promise<{entries: {spdxId: string}[]; fetched: string[]}>;
};

const parent = mkdtempSync(join(tmpdir(), 'papeleria-fetch-texts-'));
after(() => rmSync(parent, {recursive: true, force: true}));

test('a check fetches every required text and creates nothing, not even the folder', async () => {
  const {REQUIRED, fetchAll} = (await import(pathToFileURL(scriptPath('fetch-license-texts.mjs')).href)) as FetchModule;
  const original = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    asked.push(String(url));
    return new Response(`The text at ${String(url)}\n${'Permission is granted. '.repeat(20)}\n`, {status: 200});
  }) as typeof fetch;
  try {
    const missing = join(parent, 'licenses');
    const result = await fetchAll(missing, {refresh: true, write: false});
    assert.deepEqual(result.fetched, REQUIRED.map((entry) => entry.id));
    assert.deepEqual(result.entries.map((entry) => entry.spdxId), REQUIRED.map((entry) => entry.id));
    assert.equal(asked.length, REQUIRED.length);
    assert.equal(existsSync(missing), false, 'a check does not create the folder it compares');
  } finally {
    globalThis.fetch = original;
  }
});

test('every text is read at one pinned commit of the SPDX data, never at a branch (security audit F13)', async () => {
  const {SPDX_COMMIT, REQUIRED, fetchAll} = (await import(pathToFileURL(scriptPath('fetch-license-texts.mjs')).href)) as FetchModule;
  assert.match(SPDX_COMMIT, /^[0-9a-f]{40}$/, 'a full commit hash, which no push can move');
  const original = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    asked.push(String(url));
    return new Response(`${'Permission is granted. '.repeat(20)}\n`, {status: 200});
  }) as typeof fetch;
  try {
    await fetchAll(join(parent, 'pinned'), {refresh: true, write: false});
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(
    asked,
    REQUIRED.map((entry) => `https://raw.githubusercontent.com/spdx/license-list-data/${SPDX_COMMIT}/text/${entry.id}.txt`),
  );
});

/** A text as the stubbed upstream serves it: long enough for the script's own floor. */
function upstreamText(id: string, edition = ''): string {
  return `The ${id} text${edition}\n${'Permission is granted. '.repeat(20)}\n`;
}

const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

/**
 * Runs the command itself with `--check`, its upstream a module loaded first
 * (`--import`) that answers each fetch from `served` by SPDX id.
 */
function runCheck(folder: string, served: Readonly<Record<string, string>>): Promise<{code: number; stdout: string}> {
  const stub = join(folder, '..', `upstream-${Object.keys(served).length}-${sha256(JSON.stringify(served)).slice(0, 8)}.mjs`);
  writeFileSync(
    stub,
    `const served = ${JSON.stringify(served)};\n` +
      "globalThis.fetch = async (url) => new Response(served[String(url).split('/').pop().replace(/\\.txt$/, '')] ?? '', {status: 200});\n",
  );
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', pathToFileURL(stub).href, scriptPath('fetch-license-texts.mjs'), '--check', '--out', folder], (error, stdout) => {
      resolve({code: error === null ? 0 : Number(error.code), stdout});
    });
  });
}

/** Every file in the folder with its bytes, to show a run changed none of them. */
function snapshot(folder: string): Record<string, string> {
  return Object.fromEntries(readdirSync(folder).sort().map((name) => [name, sha256(readFileSync(join(folder, name)))]));
}

test('a check compares upstream with the index and with each file on disk, and changes neither (W5R-05)', async () => {
  const {REQUIRED} = (await import(pathToFileURL(scriptPath('fetch-license-texts.mjs')).href)) as FetchModule;
  const folder = join(parent, 'retained');
  mkdirSync(folder);
  const served: Record<string, string> = Object.fromEntries(REQUIRED.map(({id}) => [id, upstreamText(id)]));
  for (const [id, text] of Object.entries(served)) {
    writeFileSync(join(folder, `${id}.txt`), text);
  }
  writeFileSync(
    join(folder, 'index.json'),
    `${JSON.stringify({licenses: REQUIRED.map(({id}) => ({spdxId: id, file: `${id}.txt`, sha256: sha256(served[id]!), bytes: Buffer.byteLength(served[id]!), retrievedFrom: 'fixture', retrievedOn: '2026-09-22', why: 'fixture'}))}, null, 2)}\n`,
  );

  const current = await runCheck(folder, served);
  assert.equal(current.code, 0, current.stdout);
  assert.match(current.stdout, /check: the retained texts match upstream/);

  // A text edited on disk while its index entry and upstream still agree: the run once reported a match.
  writeFileSync(join(folder, 'MIT.txt'), `${served['MIT']!}An added line.\n`);
  const before = snapshot(folder);
  const edited = await runCheck(folder, served);
  assert.equal(edited.code, 1, edited.stdout);
  assert.match(edited.stdout, /check: the retained texts differ from upstream: MIT \(MIT\.txt on disk\)$/m);
  assert.deepEqual(snapshot(folder), before, 'the check left the edited text, and everything else, as it found them');

  // Upstream moved on for another text: the committed text stays as retained, and the run says where it differs.
  const moved = await runCheck(folder, {...served, ISC: upstreamText('ISC', ', a later edition')});
  assert.equal(moved.code, 1, moved.stdout);
  assert.match(moved.stdout, /differ from upstream: .*ISC \(index\.json, ISC\.txt on disk\)/);
  assert.deepEqual(snapshot(folder), before, 'nothing was written over the committed texts or the index');
});
