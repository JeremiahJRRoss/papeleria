/**
 * M2.1: saves (IC05, C21, D81; acceptance matrix, "Save fixtures").
 *
 * Two clients with the same content revision, writes made outside the
 * editor, the editor's own writes, a stale hash with an unchanged timestamp,
 * a racing writer after the new content is written, and the recoverable
 * previous version. A revision is the SHA-256 of the bytes on disk: a changed
 * timestamp alone is no conflict, and changed bytes with the old timestamp are.
 *
 * The watcher (D82): what the session announces, and what the watcher never
 * reports — generated folders, `node_modules/`, `lib/` and write-temporary
 * files — with `fs.watch` and with the periodic look it falls back to when
 * the system cannot watch. And a build refused because a source moved since
 * the editor read it.
 */
import assert from 'node:assert/strict';
import {chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, watch, writeFileSync, type FSWatcher} from 'node:fs';
import {join} from 'node:path';
import {after, before, describe, test} from 'node:test';

import {revisionOf} from '../../src/server/index.js';
import {watchPiece} from '../../src/server/watcher.js';
import {removeTemporaryFolders, temporaryFolder} from '../helpers/pieces.js';
import {body, json, openEvents, pause, session, starterDeck, type ServerEventRecord, type TestSession} from './server-helpers.js';

after(removeTemporaryFolders);

const NOTES = 'assets/text/01-cover-notes.md';

async function open(editor: TestSession, path: string): Promise<{content: string; revision: string; lineEnding: string}> {
  const reply = await editor.api(`/api/file?path=${encodeURIComponent(path)}`);
  assert.equal(reply.status, 200, reply.body);
  return json(reply) as {content: string; revision: string; lineEnding: string};
}

function save(editor: TestSession, path: string, content: string, expectedRevision: string) {
  return editor.api('/api/file', {method: 'PUT', ...body({path, content, expectedRevision})});
}

function backups(root: string, path: string): string[] {
  try {
    return readdirSync(join(root, '.papeleria', 'backups', ...path.split('/'))).sort();
  } catch {
    return [];
  }
}

describe('saves', () => {
  let editor: TestSession;
  before(async () => {
    editor = await session(starterDeck('server-saves'));
  });
  after(() => editor.close());

  test('a save against the current revision writes the file, returns its new revision and keeps the old bytes', async () => {
    const opened = await open(editor, NOTES);
    const before_ = readFileSync(join(editor.root, NOTES));
    assert.equal(opened.revision, revisionOf(before_));
    const reply = await save(editor, NOTES, 'New notes.\n', opened.revision);
    assert.equal(reply.status, 200, reply.body);
    assert.equal(json(reply)['revision'], revisionOf('New notes.\n'));
    assert.equal(readFileSync(join(editor.root, NOTES), 'utf8'), 'New notes.\n');
    const kept = backups(editor.root, NOTES);
    assert.equal(kept.length, 1);
    assert.ok(readFileSync(join(editor.root, '.papeleria', 'backups', ...NOTES.split('/'), kept[0]!)).equals(before_), 'the previous version is recoverable');
    assert.deepEqual(readdirSync(join(editor.root, 'assets', 'text')), ['01-cover-notes.md'], 'no temporary file is left');
  });

  test('two clients with the same revision: the first save wins, the second is a 409 with the revision on disk', async () => {
    const {revision} = await open(editor, NOTES);
    const [first, second] = await Promise.all([save(editor, NOTES, 'first\n', revision), save(editor, NOTES, 'second\n', revision)]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const loser = first.status === 409 ? first : second;
    const winner = first.status === 200 ? 'first\n' : 'second\n';
    assert.equal(readFileSync(join(editor.root, NOTES), 'utf8'), winner);
    const refusal = json(loser);
    assert.equal(refusal['errorCode'], 'E_CONFLICT');
    assert.equal(refusal['currentRevision'], revisionOf(winner));
    assert.equal(refusal['reload'], `/api/file?path=${encodeURIComponent(NOTES)}`);
  });

  test('a write from outside the editor is a conflict, never overwritten; keeping mine acknowledges the disk revision and the next save rechecks it', async () => {
    const {revision} = await open(editor, NOTES);
    writeFileSync(join(editor.root, NOTES), 'written by another editor\n');
    const refused = await save(editor, NOTES, 'mine\n', revision);
    assert.equal(refused.status, 409);
    const onDisk = json(refused)['currentRevision'] as string;
    assert.equal(onDisk, revisionOf('written by another editor\n'));
    assert.equal(readFileSync(join(editor.root, NOTES), 'utf8'), 'written by another editor\n');
    // Keep mine: the editor keeps its buffer and now expects the disk revision it was shown.
    const kept = await save(editor, NOTES, 'mine\n', onDisk);
    assert.equal(kept.status, 200, kept.body);
    assert.equal(readFileSync(join(editor.root, NOTES), 'utf8'), 'mine\n');
  });

  test('a revision is the content, not the time: a touched file saves, changed bytes with the old timestamp conflict', async () => {
    const {revision} = await open(editor, NOTES);
    const path = join(editor.root, NOTES);
    const later = new Date(Date.now() + 60_000);
    utimesSync(path, later, later);
    const touched = await save(editor, NOTES, 'after a touch\n', revision);
    assert.equal(touched.status, 200, 'a newer timestamp alone is no conflict');
    const current = json(touched)['revision'] as string;
    const stamp = new Date(1_790_000_000_000);
    utimesSync(path, stamp, stamp);
    const size = statSync(path).size;
    writeFileSync(path, 'AFTER A TOUCH\n');
    utimesSync(path, stamp, stamp);
    assert.equal(statSync(path).mtimeMs, stamp.getTime());
    assert.equal(statSync(path).size, size);
    const stale = await save(editor, NOTES, 'mine again\n', current);
    assert.equal(stale.status, 409, 'same size and timestamp, different bytes');
    assert.equal(readFileSync(path, 'utf8'), 'AFTER A TOUCH\n');
  });

  test('a missing file is a conflict with no current revision; a manifest over 1 MiB is a 413', async () => {
    const missing = await save(editor, 'assets/text/gone.md', 'x', revisionOf('x'));
    assert.equal(missing.status, 409);
    assert.equal(json(missing)['currentRevision'], null);
    const manifest = await open(editor, 'papeleria.yaml');
    const tooLarge = await save(editor, 'papeleria.yaml', `${manifest.content}#${'x'.repeat(1_048_576)}\n`, manifest.revision);
    assert.equal(tooLarge.status, 413);
    assert.equal(readFileSync(join(editor.root, 'papeleria.yaml'), 'utf8'), manifest.content);
  });

  test('the byte-order mark, the line endings and the file mode are kept', async () => {
    const path = join(editor.root, NOTES);
    writeFileSync(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('one\r\ntwo\r\n')]));
    chmodSync(path, 0o640);
    const opened = await open(editor, NOTES);
    assert.equal(opened.content, 'one\r\ntwo\r\n', 'the editor is given the text without the mark');
    assert.equal(opened.lineEnding, 'crlf');
    const reply = await save(editor, NOTES, 'one\r\ntwo\r\nthree\r\n', opened.revision);
    assert.equal(reply.status, 200, reply.body);
    const written = readFileSync(path);
    assert.deepEqual([...written.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'the mark is kept');
    assert.equal(written.subarray(3).toString('utf8'), 'one\r\ntwo\r\nthree\r\n');
    if (process.platform !== 'win32') {
      assert.equal(statSync(path).mode & 0o777, 0o640);
    }
  });

  test('at most ten previous versions are kept per file', async () => {
    let {revision} = await open(editor, NOTES);
    for (let index = 0; index < 12; index += 1) {
      const reply = await save(editor, NOTES, `version ${index}\n`, revision);
      assert.equal(reply.status, 200);
      revision = json(reply)['revision'] as string;
    }
    assert.equal(backups(editor.root, NOTES).length, 10);
  });
});

describe('a writer racing the save', () => {
  test('a change after the new content is written, before the rename, aborts the save and leaves the other writer’s file', async () => {
    let racer: string | null = null;
    const editor = await session(starterDeck('server-race'), {
      hooks: {
        save: {
          at: (step) => {
            if (step === 'temporary-written' && racer !== null) {
              writeFileSync(racer, 'the racer wins\n');
            }
          },
        },
      },
    });
    try {
      racer = join(editor.root, NOTES);
      const {revision} = await open(editor, NOTES);
      const reply = await save(editor, NOTES, 'mine\n', revision);
      assert.equal(reply.status, 409);
      assert.equal(json(reply)['currentRevision'], revisionOf('the racer wins\n'));
      assert.equal(readFileSync(racer, 'utf8'), 'the racer wins\n');
      assert.deepEqual(readdirSync(join(editor.root, 'assets', 'text')), ['01-cover-notes.md'], 'the temporary file is removed');
    } finally {
      await editor.close();
    }
  });
});

describe('the watcher', () => {
  let editor: TestSession;
  before(async () => {
    editor = await session(starterDeck('server-watch'));
  });
  after(() => editor.close());

  test('a change on disk is announced with its revision; the editor’s own save is not', async () => {
    const stream = await openEvents(`${editor.editorOrigin}/api/events`, editor.headers());
    try {
      await stream.next((event) => event.event === 'hello');
      const {revision} = await open(editor, NOTES);
      const saved = await save(editor, NOTES, 'saved by the editor\n', revision);
      assert.equal(saved.status, 200);
      await pause(600);
      assert.deepEqual(stream.events.filter((event) => event.event === 'file-changed'), [], 'no event for the session’s own write');

      writeFileSync(join(editor.root, NOTES), 'changed outside\n');
      const changed = await stream.next((event) => event.event === 'file-changed' && event.data['path'] === NOTES);
      assert.equal(changed.data['revision'], revisionOf('changed outside\n'));
      assert.equal(changed.data['kind'], 'text');

      writeFileSync(join(editor.root, 'assets', 'text', 'new.md'), 'a new file\n');
      const added = await stream.next((event) => event.event === 'file-changed' && event.data['path'] === 'assets/text/new.md');
      assert.equal(added.data['revision'], revisionOf('a new file\n'));

      writeFileSync(join(editor.root, 'assets', 'images-note.txt'), 'not a piece file\n');
      const asset = await stream.next((event) => event.event === 'file-changed' && event.data['path'] === 'assets/images-note.txt');
      assert.deepEqual([asset.data['kind'], asset.data['revision']], ['asset', null]);

      const ids = stream.events.map((event) => event.id);
      assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'event ids increase');
    } finally {
      stream.close();
    }
  });

  test('generated folders are not watched: a build writes dist/ and .papeleria/ without a single event', async () => {
    const stream = await openEvents(`${editor.editorOrigin}/api/events`, editor.headers());
    try {
      await stream.next((event) => event.event === 'hello');
      const piece = json(await editor.api('/api/piece')) as {manifestPath: string; manifestRevision: string; files: {path: string; revision: string}[]};
      const expectedRevisions = Object.fromEntries([[piece.manifestPath, piece.manifestRevision], ...piece.files.map((file) => [file.path, file.revision])]);
      const built = await editor.api('/api/build', {method: 'POST', ...body({expectedRevisions})});
      assert.equal(built.status, 200, built.body);
      assert.equal((json(built)['report'] as {outputWritten: boolean}).outputWritten, true);
      await pause(600);
      assert.deepEqual(
        stream.events.filter((event) => event.event === 'file-changed'),
        [],
      );
    } finally {
      stream.close();
    }
  });

  test('a folder is announced by the files it holds, never as itself, and a removed Markdown file once, as text (W5R-17)', async () => {
    const stream = await openEvents(`${editor.editorOrigin}/api/events`, editor.headers());
    const changed = (path: string) => (event: ServerEventRecord) => event.event === 'file-changed' && event.data['path'] === path;
    const said = (path: string): ServerEventRecord[] => stream.events.filter(changed(path));
    try {
      await stream.next((event) => event.event === 'hello');
      // An empty folder changes nothing a preview shows. The marker written after it is announced after anything the folder causes.
      mkdirSync(join(editor.root, 'assets', 'text', 'drafts'));
      writeFileSync(join(editor.root, 'assets', 'marker-1.txt'), 'after the folder\n');
      await stream.next(changed('assets/marker-1.txt'));
      assert.deepEqual(said('assets/text/drafts'), []);

      writeFileSync(join(editor.root, 'assets', 'text', 'doomed.md'), 'soon gone\n');
      await stream.next(changed('assets/text/doomed.md'));
      rmSync(join(editor.root, 'assets', 'text', 'doomed.md'));
      writeFileSync(join(editor.root, 'assets', 'marker-2.txt'), 'after the removal\n');
      await stream.next(changed('assets/marker-2.txt'));
      assert.deepEqual(
        said('assets/text/doomed.md').map((event) => [event.data['kind'], event.data['revision']]),
        [
          ['text', revisionOf('soon gone\n')],
          ['text', null],
        ],
      );

      // A folder moved in whole: its files were there before it could be watched, so they are announced through it.
      const outside = temporaryFolder('moved-in');
      mkdirSync(join(outside, 'pictures'));
      writeFileSync(join(outside, 'pictures', 'photo.png'), 'not really a picture');
      renameSync(join(outside, 'pictures'), join(editor.root, 'assets', 'pictures'));
      const moved = await stream.next(changed('assets/pictures/photo.png'));
      assert.deepEqual([moved.data['kind'], moved.data['revision']], ['asset', null]);
      assert.deepEqual(said('assets/pictures'), []);
    } finally {
      stream.close();
    }
  });
});

describe('what the watcher reports (IC06, D82)', () => {
  const unwatchable = (): never => {
    throw Object.assign(new Error('ENOSPC: System limit for number of file watchers reached'), {code: 'ENOSPC'});
  };

  for (const [how, options] of [
    ['with fs.watch', {}],
    ['when fs.watch fails and the piece is looked at instead', {watch: unwatchable, pollMs: 50}],
  ] as const) {
    test(`node_modules/, lib/ and write-temporary files are never reported, ${how}; a piece file beside them is`, async () => {
      const root = starterDeck('watch-exclusions');
      const reported: string[] = [];
      let markerSeen!: () => void;
      const marker = new Promise<void>((resolveMarker, rejectMarker) => {
        markerSeen = resolveMarker;
        setTimeout(() => rejectMarker(new Error(`the marker was never reported; reported: ${JSON.stringify(reported)}`)), 10_000).unref();
      });
      const watch = await watchPiece(
        root,
        (paths) => {
          reported.push(...paths);
          if (paths.has('assets/text/marker.md')) {
            markerSeen();
          }
        },
        options,
      );
      try {
        for (const folder of ['node_modules', 'lib']) {
          mkdirSync(join(root, folder, 'nested'), {recursive: true});
          writeFileSync(join(root, folder, 'index.js'), 'export {};\n');
          writeFileSync(join(root, folder, 'nested', 'index.js'), 'export {};\n');
        }
        // What a save writes before its rename: a hidden temporary file beside the file it replaces (files.ts).
        writeFileSync(join(root, '.papeleria.yaml.papeleria-0123456789ab.tmp'), 'schema: 1\n');
        writeFileSync(join(root, 'assets', 'text', '.01-cover-notes.md.papeleria-0123456789ab.tmp'), 'notes\n');
        writeFileSync(join(root, 'assets', 'text', 'marker.md'), 'a piece file\n');
        await marker;
        assert.deepEqual([...new Set(reported)], ['assets/text/marker.md']);
      } finally {
        watch.close();
      }
    });
  }

  test('a watcher that cannot watch says so once in the session log, and a change made outside is still announced (W5R-15)', async () => {
    const editor = await session(starterDeck('server-watch-failed'), {hooks: {watch: unwatchable}});
    const stream = await openEvents(`${editor.editorOrigin}/api/events`, editor.headers());
    const watcherLines = (): string[] => editor.logs.filter((line) => /cannot be watched/.test(line));
    try {
      await stream.next((event) => event.event === 'hello');
      assert.deepEqual(watcherLines(), ['papeleria: the piece folder cannot be watched for changes (ENOSPC); it is looked at every 2 s instead.']);
      writeFileSync(join(editor.root, NOTES), 'changed while nothing watched\n');
      const notes = await stream.next((event) => event.event === 'file-changed' && event.data['path'] === NOTES);
      assert.equal(notes.data['revision'], revisionOf('changed while nothing watched\n'));
      const manifest = join(editor.root, 'papeleria.yaml');
      writeFileSync(manifest, `${readFileSync(manifest, 'utf8')}# changed outside\n`);
      const changed = await stream.next((event) => event.event === 'file-changed' && event.data['path'] === 'papeleria.yaml');
      assert.equal(changed.data['revision'], revisionOf(readFileSync(manifest)));
      assert.equal(watcherLines().length, 1, 'said once, however often the piece is looked at');
    } finally {
      stream.close();
      await editor.close();
    }
  });

  test('a folder the system refuses part way turns the whole watcher to looking, said once (W5R-15)', async () => {
    const root = starterDeck('watch-part-way');
    const logs: string[] = [];
    // The piece folder is watched, and then the table is full: every folder under assets/ is refused.
    const partWay = ((path: string, ...rest: unknown[]): FSWatcher => {
      if (path !== root) {
        unwatchable();
      }
      return (watch as (path: string, ...rest: unknown[]) => FSWatcher)(path, ...rest);
    }) as unknown as typeof watch;
    let noticed!: () => void;
    const reported = new Promise<void>((resolveReported, rejectReported) => {
      noticed = resolveReported;
      setTimeout(() => rejectReported(new Error(`the change was never reported; the log: ${JSON.stringify(logs)}`)), 10_000).unref();
    });
    const watcher = await watchPiece(
      root,
      (paths) => {
        if (paths.has(NOTES)) {
          noticed();
        }
      },
      {log: (line) => logs.push(line), watch: partWay, pollMs: 50},
    );
    try {
      writeFileSync(join(root, NOTES), 'changed after the refusal\n');
      await reported;
      assert.deepEqual(logs, ['papeleria: the piece folder cannot be watched for changes (ENOSPC); it is looked at every 0.05 s instead.']);
    } finally {
      watcher.close();
    }
  });
});

describe('a build against sources that moved (IC06 POST /api/build)', () => {
  test('a source changed or removed since the editor read it is refused with 409 E_CHANGED, naming each, and nothing is built', async () => {
    const editor = await session(starterDeck('server-build-changed'));
    try {
      const piece = json(await editor.api('/api/piece')) as {manifestPath: string; manifestRevision: string; files: {path: string; revision: string}[]};
      const expectedRevisions = Object.fromEntries([[piece.manifestPath, piece.manifestRevision], ...piece.files.map((file) => [file.path, file.revision])]);
      writeFileSync(join(editor.root, NOTES), 'changed after the editor read it\n');
      rmSync(join(editor.root, 'assets', 'data', 'hours-by-phase.csv'));
      const refused = await editor.api('/api/build', {method: 'POST', ...body({expectedRevisions})});
      assert.equal(refused.status, 409, refused.body);
      assert.equal(json(refused)['errorCode'], 'E_CHANGED');
      assert.deepEqual(json(refused)['changed'], [
        {path: NOTES, currentRevision: revisionOf('changed after the editor read it\n')},
        {path: 'assets/data/hours-by-phase.csv', currentRevision: null},
      ]);
      assert.equal(existsSync(join(editor.root, 'dist')), false, 'nothing was built');
    } finally {
      await editor.close();
    }
  });
});
