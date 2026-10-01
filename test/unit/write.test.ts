/**
 * M1.7 / IC05: generations, promotion, recovery and the build lock.
 *
 * A fault hook that throws stops promotion or recovery at that step exactly as
 * a crash would: nothing after it runs. After every fault the piece has a
 * complete old or new `dist/`, or none at all only when it had none before,
 * and the next recovery finishes or undoes what was interrupted.
 */
import assert from 'node:assert/strict';
import {execFileSync, spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync} from 'node:fs';
import {open, type FileHandle} from 'node:fs/promises';
import {join} from 'node:path';
import {after, mock, test} from 'node:test';

import {
  acquireBuildLock,
  acquireSaveLock,
  discardGeneration,
  openGeneration,
  OutputError,
  processStartOf,
  promoteGeneration,
  recordGenerationFile,
  recoverPromotion,
  STATE_FOLDER,
  writeGenerationFile,
  type Generation,
  type PromotionStep,
} from '../../src/build/write.js';
import {pinFolder, readTree, removeTemporaryFolders, temporaryFolder} from '../helpers/pieces.js';

after(removeTemporaryFolders);

class Crash extends Error {}

/** A fault hook that crashes at one step. */
function crashAt(step: PromotionStep): (reached: PromotionStep) => void {
  return (reached) => {
    if (reached === step) {
      throw new Crash(`crash at ${step}`);
    }
  };
}

function piece(label: string, oldOutput: string | null): string {
  const root = temporaryFolder(label);
  if (oldOutput !== null) {
    mkdirSync(join(root, 'dist', 'theme'), {recursive: true});
    writeFileSync(join(root, 'dist', 'index.html'), oldOutput);
    writeFileSync(join(root, 'dist', 'theme', 'old.css'), 'old');
  }
  return root;
}

async function generation(root: string, page: string): Promise<Generation> {
  const opened = await openGeneration(root);
  await writeGenerationFile(opened, 'index.html', page);
  await writeGenerationFile(opened, 'theme/css/site.css', 'new');
  return opened;
}

function dist(root: string): Record<string, string> | null {
  if (!existsSync(join(root, 'dist'))) {
    return null;
  }
  return Object.fromEntries(Object.entries(readTree(join(root, 'dist'))).map(([path, bytes]) => [path, Buffer.from(bytes).toString('utf8')]));
}

const OLD = {'index.html': 'old page', 'theme/old.css': 'old'};
const NEW = {'index.html': 'new page', 'theme/css/site.css': 'new'};

function state(root: string, folder: string): string[] {
  const path = join(root, STATE_FOLDER, folder);
  return existsSync(path) ? readdirSync(path) : [];
}

test('a generation is written under .papeleria/staging/ and records every file with its size', async () => {
  const root = piece('generation', null);
  const opened = await openGeneration(root);
  assert.match(opened.id, /^[0-9a-z]+-[0-9a-f]{12}$/);
  assert.equal(opened.directory, join(root, STATE_FOLDER, 'staging', opened.id));
  assert.equal(await writeGenerationFile(opened, 'index.html', 'Añejo'), 6, 'UTF-8 bytes, not characters');
  await writeGenerationFile(opened, 'assets/images/a.svg', new Uint8Array([1, 2, 3]));
  recordGenerationFile(opened, 'assets/images/a.800.webp', 1234);
  assert.deepEqual([...opened.files], [
    ['index.html', 6],
    ['assets/images/a.svg', 3],
    ['assets/images/a.800.webp', 1234],
  ]);
  assert.equal(readFileSync(join(opened.directory, 'index.html'), 'utf8'), 'Añejo');
  for (const bad of ['', '/abs', '../up', 'a/../b', 'a//b', 'a\\b', './a']) {
    await assert.rejects(writeGenerationFile(opened, bad, 'x'), /E_INTERNAL/, bad);
  }
  await discardGeneration(opened);
  assert.equal(existsSync(opened.directory), false);
  await discardGeneration(opened);
});

test('a generation never writes through a link inside the staging folder', async () => {
  const root = piece('generation-link', null);
  const opened = await openGeneration(root);
  const elsewhere = temporaryFolder('elsewhere');
  symlinkSync(elsewhere, join(opened.directory, 'theme'));
  await assert.rejects(writeGenerationFile(opened, 'theme/x.css', 'x'), (error: unknown) => error instanceof OutputError && error.code === 'E_OUTPUT_IO');
  assert.deepEqual(readdirSync(elsewhere), []);
});

test('promotion with no previous dist/ puts the generation in place and leaves no journal or backup', async () => {
  const root = piece('promote-fresh', null);
  await promoteGeneration(await generation(root, 'new page'));
  assert.deepEqual(dist(root), NEW);
  assert.equal(existsSync(join(root, STATE_FOLDER, 'promotion.json')), false);
  assert.deepEqual(state(root, 'staging'), []);
  assert.deepEqual(state(root, 'previous'), []);
});

test('promotion replaces a previous dist/ whole: no file of the old output survives', async () => {
  const root = piece('promote-replace', 'old page');
  const steps: PromotionStep[] = [];
  await promoteGeneration(await generation(root, 'new page'), (step) => steps.push(step));
  assert.deepEqual(steps, ['journal-written', 'backup-moved', 'promoted', 'backup-removed']);
  assert.deepEqual(dist(root), NEW);
  assert.deepEqual(state(root, 'previous'), []);
  assert.equal(existsSync(join(root, STATE_FOLDER, 'promotion.json')), false);
});

test('IC05 fault before promotion: the old dist/ is untouched, and recovery discards the generation', async () => {
  const root = piece('fault-journal', 'old page');
  const opened = await generation(root, 'new page');
  await assert.rejects(promoteGeneration(opened, crashAt('journal-written')), Crash);
  assert.deepEqual(dist(root), OLD);
  assert.equal(existsSync(join(root, STATE_FOLDER, 'promotion.json')), true);
  assert.equal((await recoverPromotion(root)).outcome, 'discarded');
  assert.deepEqual(dist(root), OLD);
  assert.equal(existsSync(opened.directory), false);
  assert.equal(existsSync(join(root, STATE_FOLDER, 'promotion.json')), false);
});

test('IC05 fault between backup and promotion: there is no dist/ at all, and recovery restores the old one', async () => {
  const root = piece('fault-between', 'old page');
  const opened = await generation(root, 'new page');
  await assert.rejects(promoteGeneration(opened, crashAt('backup-moved')), Crash);
  assert.equal(dist(root), null, 'the brief window: no dist/, never a partial one');
  assert.deepEqual(state(root, 'previous'), [opened.id]);
  assert.equal((await recoverPromotion(root)).outcome, 'restored');
  assert.deepEqual(dist(root), OLD);
  assert.deepEqual(state(root, 'previous'), []);
  assert.equal(existsSync(opened.directory), false);
});

test('IC05 fault between backup and promotion after the build discarded its generation: recovery still restores', async () => {
  // The pipeline discards a generation it did not promote, so recovery may find only the backup.
  const root = piece('fault-between-discarded', 'old page');
  const opened = await generation(root, 'new page');
  await assert.rejects(promoteGeneration(opened, crashAt('backup-moved')), Crash);
  await discardGeneration(opened);
  assert.equal((await recoverPromotion(root)).outcome, 'restored');
  assert.deepEqual(dist(root), OLD);
});

test('IC05 fault after promotion, before cleanup: the new dist/ is complete, and recovery removes the backup', async () => {
  const root = piece('fault-promoted', 'old page');
  const opened = await generation(root, 'new page');
  await assert.rejects(promoteGeneration(opened, crashAt('promoted')), Crash);
  assert.deepEqual(dist(root), NEW);
  assert.deepEqual(state(root, 'previous'), [opened.id]);
  assert.equal((await recoverPromotion(root)).outcome, 'completed');
  assert.deepEqual(dist(root), NEW);
  assert.deepEqual(state(root, 'previous'), []);
  assert.equal(existsSync(join(root, STATE_FOLDER, 'promotion.json')), false);
});

test('IC05 fault during recovery, after the old dist/ is back: a second recovery finishes the job', async () => {
  const root = piece('fault-recovery', 'old page');
  const opened = await generation(root, 'new page');
  await assert.rejects(promoteGeneration(opened, crashAt('backup-moved')), Crash);
  await assert.rejects(recoverPromotion(root, crashAt('recovery-restored')), Crash);
  assert.deepEqual(dist(root), OLD, 'the old output is complete at the crash');
  assert.equal(existsSync(join(root, STATE_FOLDER, 'promotion.json')), true);
  assert.equal((await recoverPromotion(root)).outcome, 'discarded');
  assert.deepEqual(dist(root), OLD);
  assert.equal(existsSync(opened.directory), false);
  assert.equal(existsSync(join(root, STATE_FOLDER, 'promotion.json')), false);
});

test('IC05 fault during recovery, as it removes the stale generation: the journal is already gone, and nothing is left to do', async () => {
  const root = piece('fault-recovery-staging', 'old page');
  const opened = await generation(root, 'new page');
  await assert.rejects(promoteGeneration(opened, crashAt('journal-written')), Crash);
  await assert.rejects(recoverPromotion(root, crashAt('recovery-staging-removed')), Crash);
  assert.deepEqual(dist(root), OLD);
  assert.equal(existsSync(join(root, STATE_FOLDER, 'promotion.json')), false, 'the old output is never taken for a new one');
  assert.equal((await recoverPromotion(root)).outcome, 'nothing');
  assert.deepEqual(dist(root), OLD);
  assert.equal(existsSync(opened.directory), false);
});

test('IC05: when the new output cannot be moved in and the old one cannot be moved back, both are kept for recovery', async () => {
  const root = piece('double-failure', 'old page');
  const opened = await generation(root, 'new page');
  // A file where dist/ was makes both renames fail (ENOTDIR), as a locked folder would.
  const blocked = (step: PromotionStep): void => {
    if (step === 'backup-moved') {
      writeFileSync(join(root, 'dist'), 'in the way');
    }
  };
  await assert.rejects(promoteGeneration(opened, blocked), (error: unknown) => {
    assert.ok(error instanceof OutputError && error.code === 'E_OUTPUT_IO');
    assert.match(error.message, /moving the previous output back failed too\. It is kept in \.papeleria\/previous\//);
    return true;
  });
  await discardGeneration(opened);
  assert.equal(existsSync(opened.directory), true, 'the generation a journal names is left for recovery');
  assert.equal(existsSync(join(root, STATE_FOLDER, 'promotion.json')), true);

  // Someone puts a dist/ back by hand before the next build: recovery refuses to guess and deletes nothing.
  rmSync(join(root, 'dist'));
  mkdirSync(join(root, 'dist'));
  await assert.rejects(recoverPromotion(root), (error: unknown) => error instanceof OutputError && error.code === 'E_RECOVERY');
  assert.deepEqual(state(root, 'previous'), [opened.id], 'the only copy of the last good build is kept');

  rmSync(join(root, 'dist'), {recursive: true});
  assert.equal((await recoverPromotion(root)).outcome, 'restored');
  assert.deepEqual(dist(root), OLD);
  assert.equal(existsSync(opened.directory), false);
});

test('IC05: once the new output is in dist/, a failure to tidy up fails neither this build nor the next (W5R-01)', async () => {
  const root = piece('tidy-failure', 'old page');
  const opened = await generation(root, 'new page');
  const previous = join(root, STATE_FOLDER, 'previous');
  // A file in place of the backup folder's parent: removing the backup fails (ENOTDIR), whoever runs the test.
  const blocked = (step: PromotionStep): void => {
    if (step === 'promoted') {
      renameSync(previous, `${previous}-aside`);
      writeFileSync(previous, 'in the way');
    }
  };
  const leftovers = await promoteGeneration(opened, blocked);
  assert.deepEqual(
    leftovers.map((leftover) => leftover.path),
    [`${STATE_FOLDER}/previous/${opened.id}`],
    'the build that promoted says what it could not remove',
  );
  assert.match(leftovers[0]!.reason, /ENOTDIR/);
  assert.deepEqual(dist(root), NEW);
  assert.equal(existsSync(join(root, STATE_FOLDER, 'promotion.json')), true, 'the journal stays for recovery');

  // Nothing can be under a file, so the next recovery completes; before W5R-01 it failed E_RECOVERY.
  assert.deepEqual(await recoverPromotion(root), {outcome: 'completed', leftovers: []});
  assert.deepEqual(dist(root), NEW);
  assert.equal(existsSync(join(root, STATE_FOLDER, 'promotion.json')), false);

  // The backup, back where it was and named by no journal, is an orphan: removed once it is an hour old.
  rmSync(previous);
  renameSync(`${previous}-aside`, previous);
  assert.deepEqual(await recoverPromotion(root, undefined, Date.now() + 2 * 60 * 60 * 1000), {outcome: 'cleaned', leftovers: []});
  assert.deepEqual(state(root, 'previous'), []);
  assert.deepEqual(dist(root), NEW);
});

test('W5R-01: an orphan that cannot be removed is reported and left; every recovery still succeeds, and removes it once it can', {skip: process.platform === 'win32' ? 'the pinning relies on POSIX permissions or chattr' : false}, async () => {
  const root = piece('orphan-pinned', 'old page');
  const now = Date.now();
  const stuck = `${(now - 2 * 60 * 60 * 1000).toString(36)}-cccccccccccc`;
  const other = `${(now - 2 * 60 * 60 * 1000).toString(36)}-dddddddddddd`;
  mkdirSync(join(root, STATE_FOLDER, 'staging', stuck), {recursive: true});
  mkdirSync(join(root, STATE_FOLDER, 'previous', other), {recursive: true});
  const unpin = pinFolder(join(root, STATE_FOLDER, 'staging', stuck));
  try {
    for (const expected of ['cleaned', 'nothing'] as const) {
      const recovered = await recoverPromotion(root, undefined, now);
      assert.equal(recovered.outcome, expected, 'the other orphan still goes, the first time');
      assert.deepEqual(
        recovered.leftovers.map((leftover) => leftover.path),
        [`${STATE_FOLDER}/staging/${stuck}`],
      );
      assert.ok(recovered.leftovers[0]!.reason.length > 0);
    }
    assert.deepEqual(state(root, 'previous'), []);
    assert.deepEqual(dist(root), OLD);
  } finally {
    unpin();
  }
  assert.deepEqual(await recoverPromotion(root, undefined, now), {outcome: 'cleaned', leftovers: []});
  assert.deepEqual(state(root, 'staging'), []);
});

test('W5R-01: a backup that cannot be removed after promotion is a leftover for this build and the next, never E_RECOVERY', {skip: process.platform === 'win32' ? 'the pinning relies on POSIX permissions or chattr' : false}, async () => {
  const root = piece('backup-pinned', 'old page');
  const opened = await generation(root, 'new page');
  const backup = join(root, STATE_FOLDER, 'previous', opened.id);
  let unpin = (): void => undefined;
  try {
    const leftovers = await promoteGeneration(opened, (step) => {
      if (step === 'promoted') {
        unpin = pinFolder(backup);
      }
    });
    assert.deepEqual(
      leftovers.map((leftover) => leftover.path),
      [`${STATE_FOLDER}/previous/${opened.id}`],
    );
    assert.deepEqual(dist(root), NEW);
    assert.equal(existsSync(join(root, STATE_FOLDER, 'promotion.json')), true, 'the journal stays for recovery');
    const recovered = await recoverPromotion(root);
    assert.equal(recovered.outcome, 'completed');
    assert.deepEqual(
      recovered.leftovers.map((leftover) => leftover.path),
      [`${STATE_FOLDER}/previous/${opened.id}`],
    );
    assert.equal(existsSync(join(root, STATE_FOLDER, 'promotion.json')), false, 'dist/ is settled, so the journal goes');
    assert.deepEqual(dist(root), NEW);
  } finally {
    unpin();
  }
  assert.deepEqual(await recoverPromotion(root, undefined, Date.now() + 2 * 60 * 60 * 1000), {outcome: 'cleaned', leftovers: []});
  assert.deepEqual(state(root, 'previous'), []);
});

test('a fresh piece whose first promotion crashed between the renames has no dist/, and recovery discards the generation', async () => {
  const root = piece('fault-fresh', null);
  const opened = await generation(root, 'new page');
  await assert.rejects(promoteGeneration(opened, crashAt('journal-written')), Crash);
  assert.equal((await recoverPromotion(root)).outcome, 'discarded');
  assert.equal(dist(root), null);
  assert.equal(existsSync(opened.directory), false);
});

test('recovery refuses a journal that names anything but its own folders, and changes nothing', async () => {
  const root = piece('journal-hostile', 'old page');
  mkdirSync(join(root, STATE_FOLDER), {recursive: true});
  const id = `${Date.now().toString(36)}-0123456789ab`;
  for (const journal of [
    {version: 1, generation: id, staging: '../../elsewhere', backup: null},
    {version: 1, generation: id, staging: `${STATE_FOLDER}/staging/${id}`, backup: 'dist'},
    {version: 2, generation: id, staging: `${STATE_FOLDER}/staging/${id}`, backup: null},
    {version: 1, generation: '../x', staging: `${STATE_FOLDER}/staging/../x`, backup: null},
  ]) {
    writeFileSync(join(root, STATE_FOLDER, 'promotion.json'), JSON.stringify(journal));
    await assert.rejects(recoverPromotion(root), (error: unknown) => error instanceof OutputError && error.code === 'E_RECOVERY');
    assert.deepEqual(dist(root), OLD);
  }
  writeFileSync(join(root, STATE_FOLDER, 'promotion.json'), '{not json');
  await assert.rejects(recoverPromotion(root), /cannot be read as a promotion journal/);
});

test('recovery removes generations and backups no journal names once they are an hour old, and keeps newer ones', async () => {
  const root = piece('orphans', 'old page');
  const now = Date.now();
  const old = `${(now - 2 * 60 * 60 * 1000).toString(36)}-aaaaaaaaaaaa`;
  const recent = `${(now - 60 * 1000).toString(36)}-bbbbbbbbbbbb`;
  for (const folder of ['staging', 'previous']) {
    mkdirSync(join(root, STATE_FOLDER, folder, old), {recursive: true});
    mkdirSync(join(root, STATE_FOLDER, folder, recent), {recursive: true});
  }
  mkdirSync(join(root, STATE_FOLDER, 'staging', 'not-a-generation'), {recursive: true});
  assert.equal((await recoverPromotion(root, undefined, now)).outcome, 'cleaned');
  assert.deepEqual(state(root, 'staging').sort(), [recent, 'not-a-generation'].sort());
  assert.deepEqual(state(root, 'previous'), [recent]);
  assert.equal((await recoverPromotion(root, undefined, now)).outcome, 'nothing');
  assert.deepEqual(dist(root), OLD);
});

test('promotion refuses a dist that is a link or a file, and leaves it as it is', async () => {
  const linked = piece('dist-link', null);
  const target = temporaryFolder('dist-target');
  symlinkSync(target, join(linked, 'dist'));
  await assert.rejects(promoteGeneration(await generation(linked, 'new page')), /symbolic link/);
  assert.deepEqual(readdirSync(target), []);
  const file = piece('dist-file', null);
  writeFileSync(join(file, 'dist'), 'not a folder');
  await assert.rejects(promoteGeneration(await generation(file, 'new page')), /not a folder/);
  assert.equal(readFileSync(join(file, 'dist'), 'utf8'), 'not a folder');
});

test('.papeleria as a link is refused before anything is written through it', async () => {
  const root = piece('state-link', null);
  const target = temporaryFolder('state-target');
  symlinkSync(target, join(root, STATE_FOLDER));
  await assert.rejects(openGeneration(root), (error: unknown) => error instanceof OutputError && error.code === 'E_OUTPUT_IO');
  await assert.rejects(recoverPromotion(root), /is not a folder/);
  assert.deepEqual(readdirSync(target), []);
});

test('IC05: builds of one piece are serialized in this process, and the lock file is removed after', async () => {
  const root = piece('lock-queue', null);
  const order: string[] = [];
  const first = await acquireBuildLock(root);
  const lockFile = join(root, STATE_FOLDER, 'build.lock');
  assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).pid, process.pid);
  const second = acquireBuildLock(root).then((release) => {
    order.push('second');
    return release;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  order.push('first done');
  await first();
  await (await second)();
  assert.deepEqual(order, ['first done', 'second']);
  assert.equal(existsSync(lockFile), false);
});

/** No process has this id (above Linux's largest and macOS's): a lock naming it was left by a crash. */
const DEAD_PID = 2 ** 22 + 12345;

test('IC05: a lock held by another running process is E_BUSY; one left by a finished process is taken over', async () => {
  const root = piece('lock-busy', null);
  mkdirSync(join(root, STATE_FOLDER), {recursive: true});
  const lockFile = join(root, STATE_FOLDER, 'build.lock');
  // The parent process is running and is not this one.
  writeFileSync(lockFile, JSON.stringify({pid: process.ppid}));
  await assert.rejects(acquireBuildLock(root), (error: unknown) => error instanceof OutputError && error.code === 'E_BUSY');
  assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).pid, process.ppid, 'the other build keeps its lock');
  writeFileSync(lockFile, JSON.stringify({pid: DEAD_PID}));
  const release = await acquireBuildLock(root);
  const held = JSON.parse(readFileSync(lockFile, 'utf8')) as {pid: number; token: string};
  assert.equal(held.pid, process.pid);
  assert.match(held.token, /^[0-9a-f]{24}$/);
  await release();
  assert.equal(existsSync(lockFile), false);
  assert.deepEqual(readdirSync(join(root, STATE_FOLDER)), [], 'no temporary or break file is left');
});

test('IC05 (security audit F7): a lock naming a process id no build can have holds nothing, whatever kill says of it', async () => {
  const root = piece('lock-implausible', null);
  mkdirSync(join(root, STATE_FOLDER), {recursive: true});
  const lockFile = join(root, STATE_FOLDER, 'build.lock');
  // kill(0) signals this process group and kill(-1) every process it may, so
  // both "run"; 1 is the system's first process; the last is past exactness.
  for (const pid of [0, 1, -1, -process.pid, 2 ** 53]) {
    writeFileSync(lockFile, JSON.stringify({pid, token: 'f'.repeat(24), started: new Date().toISOString()}));
    const release = await acquireBuildLock(root);
    assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).pid, process.pid, `a lock naming ${pid} was taken over`);
    await release();
  }
  assert.deepEqual(readdirSync(join(root, STATE_FOLDER)), [], 'no temporary or break file is left');
});

test('IC05 (security audit F7, W5R-10): a lock written before the system started holds nothing, even when its process id runs today', async () => {
  const root = piece('lock-before-boot', null);
  mkdirSync(join(root, STATE_FOLDER), {recursive: true});
  const lockFile = join(root, STATE_FOLDER, 'build.lock');
  const bootedAt = Date.now() - 5 * 60_000;
  const lock = (started: Date) => JSON.stringify({pid: process.ppid, token: 'f'.repeat(24), started: started.toISOString()});
  // Written after the start: the running parent holds it.
  writeFileSync(lockFile, lock(new Date()));
  await assert.rejects(acquireBuildLock(root, {bootedAt}), (error: unknown) => error instanceof OutputError && error.code === 'E_BUSY');
  // Within the minute the start time may be off by: still believed.
  writeFileSync(lockFile, lock(new Date(bootedAt - 30_000)));
  await assert.rejects(acquireBuildLock(root, {bootedAt}), (error: unknown) => error instanceof OutputError && error.code === 'E_BUSY');
  // Taken an hour before the start, by the time it states or by its file's.
  writeFileSync(lockFile, lock(new Date(bootedAt - 3_600_000)));
  await (await acquireBuildLock(root, {bootedAt}))();
  writeFileSync(lockFile, JSON.stringify({pid: process.ppid}));
  const old = new Date(bootedAt - 3_600_000);
  utimesSync(lockFile, old, old);
  await (await acquireBuildLock(root, {bootedAt}))();
  assert.equal(existsSync(lockFile), false);
  // Where the system does not say when it started, the process id decides alone.
  writeFileSync(lockFile, lock(new Date(Date.now() - 3_600_000)));
  utimesSync(lockFile, old, old);
  await assert.rejects(acquireBuildLock(root, {bootedAt: null}), (error: unknown) => error instanceof OutputError && error.code === 'E_BUSY');
});

test('IC05: a lock that names no process may be one being written, and is left alone until it is ten seconds old', async () => {
  const root = piece('lock-grace', null);
  mkdirSync(join(root, STATE_FOLDER), {recursive: true});
  const lockFile = join(root, STATE_FOLDER, 'build.lock');
  writeFileSync(lockFile, '');
  await assert.rejects(acquireBuildLock(root), (error: unknown) => error instanceof OutputError && error.code === 'E_BUSY');
  assert.equal(readFileSync(lockFile, 'utf8'), '', 'a lock that may still be being written is never broken');
  const old = new Date(Date.now() - 20_000);
  utimesSync(lockFile, old, old);
  await (await acquireBuildLock(root))();
  assert.equal(existsSync(lockFile), false);
});

test('IC05: a build removes only its own lock when it finishes', async () => {
  const root = piece('lock-own', null);
  const release = await acquireBuildLock(root);
  const lockFile = join(root, STATE_FOLDER, 'build.lock');
  const other = `${JSON.stringify({pid: process.ppid, token: 'f'.repeat(24)})}\n`;
  writeFileSync(lockFile, other);
  await release();
  assert.equal(readFileSync(lockFile, 'utf8'), other);
});

test('IC05: a lock that is a link or a FIFO is refused at once, never read through or waited on', {skip: process.platform === 'win32' ? 'no FIFOs or unprivileged links' : false}, async () => {
  const root = piece('lock-special', null);
  mkdirSync(join(root, STATE_FOLDER), {recursive: true});
  const lockFile = join(root, STATE_FOLDER, 'build.lock');
  const elsewhere = join(temporaryFolder('lock-target'), 'lock');
  writeFileSync(elsewhere, JSON.stringify({pid: DEAD_PID}));
  symlinkSync(elsewhere, lockFile);
  await assert.rejects(acquireBuildLock(root), (error: unknown) => error instanceof OutputError && error.code === 'E_OUTPUT_IO' && /symbolic link/.test(error.message));
  assert.equal(readFileSync(elsewhere, 'utf8'), JSON.stringify({pid: DEAD_PID}), 'the link target is untouched');
  rmSync(lockFile);
  execFileSync('mkfifo', [lockFile]);
  const started = Date.now();
  await assert.rejects(acquireBuildLock(root), (error: unknown) => error instanceof OutputError && error.code === 'E_OUTPUT_IO' && /not a regular file/.test(error.message));
  assert.ok(Date.now() - started < 5_000, 'no read waits on the FIFO');
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

test('IC05: breaking a stale lock never removes the lock another build took meanwhile (two processes)', async () => {
  const root = piece('lock-race', null);
  mkdirSync(join(root, STATE_FOLDER), {recursive: true});
  const lockFile = join(root, STATE_FOLDER, 'build.lock');
  writeFileSync(lockFile, JSON.stringify({pid: DEAD_PID}));
  // The other build inspects the stale lock, then stops just before breaking it.
  const script = [
    `const {acquireBuildLock} = await import(${JSON.stringify(new URL('../../src/build/write.js', import.meta.url).href)});`,
    'let paused = false;',
    'try {',
    `  const release = await acquireBuildLock(${JSON.stringify(root)}, {beforeBreak: async () => {`,
    '    if (paused) return;',
    '    paused = true;',
    "    process.stdout.write('paused\\n');",
    "    await new Promise((resolve) => process.stdin.once('data', resolve));",
    '  }});',
    "  process.stdout.write('acquired\\n');",
    '  await release();',
    '} catch (error) {',
    "  process.stdout.write(error.code === 'E_BUSY' ? 'busy\\n' : `failed ${error.message}\\n`);",
    '}',
    'process.stdin.destroy();',
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {stdio: ['pipe', 'pipe', 'pipe']});
  await lineFrom(child, /^paused$/);
  // Meanwhile this build breaks the stale lock and takes it.
  const release = await acquireBuildLock(root);
  const mine = readFileSync(lockFile, 'utf8');
  child.stdin.write('go\n');
  assert.equal(await lineFrom(child, /^(busy|acquired|failed)/), 'busy', 'the other build must find this one running');
  assert.equal(readFileSync(lockFile, 'utf8'), mine, 'the lock this build took is still in place');
  await release();
  assert.equal(existsSync(lockFile), false);
});

/**
 * Counts the flushes of open files and folders while `run` runs, noting
 * whether the promotion journal existed at each, and lets a test make one fail.
 */
async function countingSyncs<T>(journal: string, run: () => Promise<T>, fail?: (index: number) => Error | null): Promise<{result: T | Error; beforeJournal: number}> {
  // Every FileHandle shares one prototype; any open file shows it.
  const handle = await open(process.execPath, 'r');
  const prototype = Object.getPrototypeOf(handle) as {sync: (this: FileHandle) => Promise<void>};
  await handle.close();
  const original = prototype.sync;
  let calls = 0;
  let beforeJournal = 0;
  const spy = mock.method(prototype, 'sync', async function (this: FileHandle): Promise<void> {
    const failure = fail?.(calls) ?? null;
    calls += 1;
    if (!existsSync(journal)) {
      beforeJournal += 1;
    }
    if (failure !== null) {
      throw failure;
    }
    return original.call(this);
  });
  try {
    return {result: await run().catch((error: unknown) => error as Error), beforeJournal};
  } finally {
    spy.mock.restore();
  }
}

test('IC05, D170: every file and folder of a generation is flushed to disk before the journal names it', async () => {
  const root = piece('flushed', 'old page');
  const opened = await generation(root, 'new page');
  const journal = join(root, STATE_FOLDER, 'promotion.json');
  const {result, beforeJournal} = await countingSyncs(journal, () => promoteGeneration(opened));
  assert.deepEqual(result, []);
  // Two files, index.html and theme/css/site.css, and three folders (the generation, theme, theme/css; not on
  // Windows, which cannot open a folder to flush it); the journal's own file is flushed before it is renamed into place.
  assert.ok(beforeJournal >= (process.platform === 'win32' ? 2 : 5), `only ${beforeJournal} flushes came before the journal`);
  assert.deepEqual(dist(root), NEW);
});

test('IC05, D170: a flush that fails leaves dist/ untouched and no journal, and the generation is discarded', async () => {
  const root = piece('flush-fails', 'old page');
  const opened = await generation(root, 'new page');
  const journal = join(root, STATE_FOLDER, 'promotion.json');
  const eio = Object.assign(new Error('EIO: i/o error, fsync'), {code: 'EIO', syscall: 'fsync'});
  const {result} = await countingSyncs(journal, () => promoteGeneration(opened), (index) => (index === 1 ? eio : null));
  assert.ok(result instanceof OutputError && result.code === 'E_OUTPUT_IO', String(result));
  assert.match(result.message, /^The new output could not be flushed to disk, so dist\/ was left as it was: EIO/);
  assert.deepEqual(dist(root), OLD);
  assert.equal(existsSync(journal), false);
  await discardGeneration(opened);
  assert.equal(existsSync(opened.directory), false);
});

test('IC05, D170: a generation holding anything but files and folders is refused before the journal', {skip: process.platform === 'win32' ? 'no unprivileged links' : false}, async () => {
  const root = piece('flush-link', 'old page');
  const opened = await generation(root, 'new page');
  symlinkSync(join(root, 'dist', 'index.html'), join(opened.directory, 'stray'));
  await assert.rejects(promoteGeneration(opened), (error: unknown) => error instanceof OutputError && error.code === 'E_OUTPUT_IO' && /could not be flushed/.test(error.message));
  assert.deepEqual(dist(root), OLD);
  assert.equal(existsSync(join(root, STATE_FOLDER, 'promotion.json')), false);
});

test('IC05 (W5R-G15): a journal is read the same after the piece folder was moved', async () => {
  const root = piece('moved', 'old page');
  const opened = await generation(root, 'new page');
  await assert.rejects(promoteGeneration(opened, crashAt('backup-moved')), Crash);
  const moved = join(temporaryFolder('moved-to'), 'piece');
  renameSync(root, moved);
  assert.deepEqual(await recoverPromotion(moved), {outcome: 'restored', leftovers: []});
  assert.deepEqual(dist(moved), OLD);
  assert.deepEqual(state(moved, 'staging'), []);
  assert.deepEqual(state(moved, 'previous'), []);
});

test('W5R-09: a break file left by a build that stopped inside the break window is taken over', async () => {
  const root = piece('break-stale', null);
  mkdirSync(join(root, STATE_FOLDER), {recursive: true});
  const lockFile = join(root, STATE_FOLDER, 'build.lock');
  const breaker = `${lockFile}.break`;
  // Its process is gone.
  writeFileSync(lockFile, JSON.stringify({pid: DEAD_PID}));
  writeFileSync(breaker, JSON.stringify({pid: DEAD_PID}));
  await (await acquireBuildLock(root))();
  assert.deepEqual(readdirSync(join(root, STATE_FOLDER)), []);

  // One that names no process may be one being written: left alone while it is young, taken over once it is old.
  writeFileSync(lockFile, JSON.stringify({pid: DEAD_PID}));
  writeFileSync(breaker, '');
  await assert.rejects(acquireBuildLock(root), (error: unknown) => error instanceof OutputError && error.code === 'E_BUSY');
  assert.equal(readFileSync(breaker, 'utf8'), '');
  const old = new Date(Date.now() - 20_000);
  utimesSync(breaker, old, old);
  await (await acquireBuildLock(root))();
  assert.deepEqual(readdirSync(join(root, STATE_FOLDER)), [], 'no lock, break or temporary file is left');
});

test('W5R-09: a break file a running process holds is left alone, however old it is', async (t) => {
  const started = await processStartOf(process.ppid);
  if (started === null) {
    t.skip('this platform does not say when a process started, so an old break file is taken over');
    return;
  }
  const root = piece('break-running', null);
  mkdirSync(join(root, STATE_FOLDER), {recursive: true});
  const lockFile = join(root, STATE_FOLDER, 'build.lock');
  const breaker = `${lockFile}.break`;
  writeFileSync(lockFile, JSON.stringify({pid: DEAD_PID}));
  const held = JSON.stringify({pid: process.ppid, processStart: started});
  writeFileSync(breaker, held);
  const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
  utimesSync(breaker, old, old);
  await assert.rejects(acquireBuildLock(root), (error: unknown) => error instanceof OutputError && error.code === 'E_BUSY');
  assert.equal(readFileSync(breaker, 'utf8'), held);
});

test('W5R-10: a lock records its process and when that process started, as the platform reads it', async () => {
  const root = piece('lock-start', null);
  const release = await acquireBuildLock(root);
  const held = JSON.parse(readFileSync(join(root, STATE_FOLDER, 'build.lock'), 'utf8')) as {pid: number; processStart: string | null};
  assert.equal(held.pid, process.pid);
  assert.equal(held.processStart, await processStartOf(process.pid));
  if (process.platform === 'linux') {
    assert.match(held.processStart ?? '', /^linux:[0-9a-f-]*:[0-9]+$/);
  }
  await release();
});

test('PRR-02: on macOS a process\'s start reads the same in every time zone, so a running holder is never judged reused', async (t) => {
  // `ps -o lstart=` writes the start in the reader's time zone; procps, on the Linux runners, does too, so the darwin
  // reading is exercised here with the platform named.
  const zone = process.env['TZ'];
  const reads: (string | null)[] = [];
  try {
    for (const tz of ['UTC', 'America/New_York', 'Asia/Tokyo']) {
      process.env['TZ'] = tz;
      reads.push(await processStartOf(process.pid, 'darwin'));
    }
  } finally {
    if (zone === undefined) {
      delete process.env['TZ'];
    } else {
      process.env['TZ'] = zone;
    }
  }
  if (reads[0] === null) {
    t.skip('no ps here that reads lstart');
    return;
  }
  assert.match(reads[0], /^darwin-utc:\S/);
  assert.deepEqual(reads, [reads[0], reads[0], reads[0]], 'three readers in three time zones read one start');
});

test('PRR-02: a lock whose start was recorded another way, as a build before the UTC reading wrote it on macOS, is never judged reused', async () => {
  const root = piece('lock-legacy-start', null);
  mkdirSync(join(root, STATE_FOLDER), {recursive: true});
  const lockFile = join(root, STATE_FOLDER, 'build.lock');
  const recorded = (await processStartOf(process.ppid)) === null ? null : 'darwin:Tue Sep 29 15:34:55 2026';
  writeFileSync(lockFile, JSON.stringify({pid: process.ppid, processStart: recorded, token: 'b'.repeat(24), started: new Date().toISOString()}));
  const before = readFileSync(lockFile, 'utf8');
  await assert.rejects(acquireBuildLock(root), (error: unknown) => error instanceof OutputError && error.code === 'E_BUSY');
  assert.equal(readFileSync(lockFile, 'utf8'), before, 'the lock is left as it was');
});

test('W5R-10: a lock whose process runs is E_BUSY however old it is: age alone never breaks it', async () => {
  const root = piece('lock-old-running', null);
  mkdirSync(join(root, STATE_FOLDER), {recursive: true});
  const lockFile = join(root, STATE_FOLDER, 'build.lock');
  const content = JSON.stringify({pid: process.ppid, processStart: await processStartOf(process.ppid), token: 'a'.repeat(24), started: '2020-01-01T00:00:00.000Z'});
  writeFileSync(lockFile, content);
  const old = new Date('2020-01-01T00:00:00Z');
  utimesSync(lockFile, old, old);
  await assert.rejects(acquireBuildLock(root), (error: unknown) => error instanceof OutputError && error.code === 'E_BUSY' && error.message.includes(`${process.ppid}`));
  assert.equal(readFileSync(lockFile, 'utf8'), content, 'a running build keeps its lock');
});

test('W5R-10: a lock naming a running process that started later than the lock says is taken over (the id was given again)', async (t) => {
  const started = await processStartOf(process.ppid);
  if (started === null) {
    t.skip('this platform does not say when a process started, so such a lock stays E_BUSY');
    return;
  }
  const root = piece('lock-reused', null);
  mkdirSync(join(root, STATE_FOLDER), {recursive: true});
  const lockFile = join(root, STATE_FOLDER, 'build.lock');
  // The build that wrote the lock started earlier than the process that has its id now.
  const earlier = started.replace(/[0-9]+$/, (value) => String(Number(value) - 1));
  assert.notEqual(earlier, started);
  writeFileSync(lockFile, JSON.stringify({pid: process.ppid, processStart: earlier, token: 'b'.repeat(24), started: new Date().toISOString()}));
  const release = await acquireBuildLock(root);
  assert.equal((JSON.parse(readFileSync(lockFile, 'utf8')) as {pid: number}).pid, process.pid);
  await release();
  assert.equal(existsSync(lockFile), false);
});

test('W5R-10: a lock naming a running process, from a build that did not record when it started, stays E_BUSY and says how to check', async () => {
  const root = piece('lock-unknown', null);
  mkdirSync(join(root, STATE_FOLDER), {recursive: true});
  const lockFile = join(root, STATE_FOLDER, 'build.lock');
  writeFileSync(lockFile, JSON.stringify({pid: process.ppid}));
  await assert.rejects(acquireBuildLock(root), (error: unknown) => {
    assert.ok(error instanceof OutputError && error.code === 'E_BUSY', String(error));
    assert.match(error.message, new RegExp(`^Process ${process.ppid} holds \\.papeleria/build\\.lock and is running.*ps -p ${process.ppid}.*delete \\.papeleria/build\\.lock`));
    return true;
  });
});

test('D171: saves of one piece are serialized by a save lock of their own, which builds do not share', async () => {
  const root = piece('save-lock', null);
  const firstSave = await acquireSaveLock(root);
  assert.equal((JSON.parse(readFileSync(join(root, STATE_FOLDER, 'save.lock'), 'utf8')) as {pid: number}).pid, process.pid);
  // A build is not held up by a save.
  await (await acquireBuildLock(root))();
  const order: string[] = [];
  const second = acquireSaveLock(root).then((release) => {
    order.push('second');
    return release;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  order.push('first done');
  await firstSave();
  await (await second)();
  assert.deepEqual(order, ['first done', 'second']);
  assert.deepEqual(readdirSync(join(root, STATE_FOLDER)), []);
});
