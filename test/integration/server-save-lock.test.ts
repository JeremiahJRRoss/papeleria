/**
 * IC05 "editor-owned operations serialize", D171 (W5R-G14): two Papeleria
 * editors of one piece are cooperating writers. Every session of a piece, in
 * this process or another, takes the piece's save lock from the first read to
 * the rename, so two saves of the same revision never both pass the check and
 * the later rename never discards the other's save: one is saved, the other
 * gets 409 with the revision now on disk.
 */
import assert from 'node:assert/strict';
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {mkdirSync, readFileSync, rmSync, symlinkSync} from 'node:fs';
import {open, type FileHandle} from 'node:fs/promises';
import {join} from 'node:path';
import {after, mock, test} from 'node:test';

import {revisionOf} from '../../src/server/index.js';
import {removeTemporaryFolders} from '../helpers/pieces.js';
import {body, json, pause, session, starterDeck, type Reply, type TestSession} from './server-helpers.js';

after(removeTemporaryFolders);

const NOTES = 'assets/text/01-cover-notes.md';

async function revision(editor: TestSession, path: string): Promise<string> {
  const reply = await editor.api(`/api/file?path=${encodeURIComponent(path)}`);
  assert.equal(reply.status, 200, reply.body);
  return json(reply)['revision'] as string;
}

function save(editor: TestSession, path: string, content: string, expectedRevision: string): Promise<Reply> {
  return editor.api('/api/file', {method: 'PUT', ...body({path, content, expectedRevision})});
}

test('D171: two editor sessions save the same revision of one file: one is saved, the other gets 409, and nothing is lost', async () => {
  const root = starterDeck('save-lock-sessions');
  let reached!: () => void;
  const atRecheck = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let resume!: () => void;
  const held = new Promise<void>((resolve) => {
    resume = resolve;
  });
  // The first session's save stops after its last check, just before it keeps the backup and renames.
  const first = await session(root, {
    hooks: {
      save: {
        at: async (step) => {
          if (step === 'rechecked') {
            reached();
            await held;
          }
        },
      },
    },
  });
  const second = await session(root);
  try {
    const current = await revision(first, NOTES);
    assert.equal(await revision(second, NOTES), current);
    const one = save(first, NOTES, 'from the first editor\n', current);
    await atRecheck;
    const two = save(second, NOTES, 'from the second editor\n', current);
    // Without the lock the second save would pass its checks and rename here, and the first would then write over it.
    await pause(300);
    resume();
    const [a, b] = await Promise.all([one, two]);
    assert.equal(a.status, 200, a.body);
    assert.equal(b.status, 409, b.body);
    assert.equal(json(b)['currentRevision'], revisionOf('from the first editor\n'));
    assert.equal(readFileSync(join(root, NOTES), 'utf8'), 'from the first editor\n');
  } finally {
    await first.close();
    await second.close();
  }
});

test('PRR-04: a save lock in the way that no process holds, a folder or a link, refuses the save and says which file to remove', async () => {
  const root = starterDeck('save-lock-in-the-way');
  const editor = await session(root);
  const lock = join(root, '.papeleria', 'save.lock');
  try {
    const before = readFileSync(join(root, NOTES), 'utf8');
    const current = await revision(editor, NOTES);
    mkdirSync(lock, {recursive: true});
    const folder = await save(editor, NOTES, 'not saved\n', current);
    assert.equal(folder.status, 500, folder.body);
    assert.equal(json(folder)['errorCode'], 'E_SAVE_IO');
    assert.equal(
      json(folder)['message'],
      `${NOTES} could not be saved; the file on disk is unchanged. .papeleria/save.lock is not a regular file. Remove it; a lock holds only a process id.`,
    );
    assert.equal(readFileSync(join(root, NOTES), 'utf8'), before);
    rmSync(lock, {recursive: true});
    symlinkSync('elsewhere', lock);
    const link = await save(editor, NOTES, 'not saved\n', current);
    assert.equal(link.status, 500, link.body);
    assert.match(json(link)['message'] as string, /could not be saved; the file on disk is unchanged\. \.papeleria\/save\.lock is a symbolic link, .* Remove it\.$/);
    assert.equal(readFileSync(join(root, NOTES), 'utf8'), before);
    rmSync(lock);
    const saved = await save(editor, NOTES, 'saved once the lock is gone\n', current);
    assert.equal(saved.status, 200, saved.body);
  } finally {
    await editor.close();
  }
});

/** Waits for a line on a child's stdout that matches, failing with what it printed if it ends first. */
function lineFrom(child: ChildProcessWithoutNullStreams, pattern: RegExp): Promise<string> {
  return new Promise((resolveLine, rejectLine) => {
    let output = '';
    const onData = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      const found = output.split('\n').find((line) => pattern.test(line));
      if (found !== undefined) {
        child.stdout.off('data', onData);
        child.off('close', onClose);
        resolveLine(found);
      }
    };
    const onClose = (): void => rejectLine(new Error(`the child ended without ${pattern}: ${output}`));
    child.stdout.on('data', onData);
    child.once('close', onClose);
  });
}

test('D171: a save waits while another process holds the piece’s save lock, then finds that process’s write and answers 409', async () => {
  const editor = await session(starterDeck('save-lock-process'));
  // Another Papeleria process: it takes the save lock, waits for a word, writes the file as its save would, and lets go.
  const script = [
    `const {acquireSaveLock} = await import(${JSON.stringify(new URL('../../src/build/write.js', import.meta.url).href)});`,
    `const {writeFileSync} = await import('node:fs');`,
    `const release = await acquireSaveLock(${JSON.stringify(editor.root)});`,
    "process.stdout.write('locked\\n');",
    "await new Promise((resolve) => process.stdin.once('data', resolve));",
    `writeFileSync(${JSON.stringify(join(editor.root, NOTES))}, 'from the other process\\n');`,
    'await release();',
    "process.stdout.write('released\\n');",
    'process.stdin.destroy();',
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {stdio: ['pipe', 'pipe', 'pipe']});
  try {
    const current = await revision(editor, NOTES);
    await lineFrom(child, /^locked$/);
    let settled = false;
    const pending = save(editor, NOTES, 'from this editor\n', current).finally(() => {
      settled = true;
    });
    await pause(300);
    assert.equal(settled, false, 'the save waits for the lock the other process holds');
    child.stdin.write('go\n');
    await lineFrom(child, /^released$/);
    const reply = await pending;
    assert.equal(reply.status, 409, reply.body);
    assert.equal(json(reply)['currentRevision'], revisionOf('from the other process\n'));
    assert.equal(readFileSync(join(editor.root, NOTES), 'utf8'), 'from the other process\n');
  } finally {
    child.kill();
    await editor.close();
  }
});

test('IC05 (W5R-G07): a save flushes its new content to disk before it checks the file again and renames it into place', async () => {
  let flushed = 0;
  let flushedBeforeRename: number | null = null;
  const editor = await session(starterDeck('save-flush'), {
    hooks: {
      save: {
        at: (step) => {
          // The temporary file is written and flushed before this step; the rename comes after it.
          if (step === 'temporary-written') {
            flushedBeforeRename = flushed;
          }
        },
      },
    },
  });
  // Every FileHandle shares one prototype; any open file shows it.
  const handle = await open(process.execPath, 'r');
  const prototype = Object.getPrototypeOf(handle) as {sync: (this: FileHandle) => Promise<void>};
  await handle.close();
  const original = prototype.sync;
  const spy = mock.method(prototype, 'sync', async function (this: FileHandle): Promise<void> {
    flushed += 1;
    return original.call(this);
  });
  try {
    const reply = await save(editor, NOTES, 'flushed first\n', await revision(editor, NOTES));
    assert.equal(reply.status, 200, reply.body);
    assert.ok((flushedBeforeRename ?? 0) >= 1, 'the temporary file was flushed before the save went on');
    assert.equal(readFileSync(join(editor.root, NOTES), 'utf8'), 'flushed first\n');
  } finally {
    spy.mock.restore();
    await editor.close();
  }
});
