/**
 * D191 (security audit F6): the installation key that signs the image cache's
 * records. It is kept in the user's state folder, outside every piece, made on
 * first use with owner-only permissions, made once when several builds start
 * together, replaced when damaged without following a link, and replaced by a
 * key for the process alone where no folder can hold one. Every folder here is
 * a temporary one: the user's own is never touched.
 */
import assert from 'node:assert/strict';
import {existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, test} from 'node:test';

import {INSTALLATION_KEY_FILE, homeFolder, installationKey, stateFolder} from '../../src/core/installation-key.js';

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    rmSync(root, {recursive: true, force: true});
  }
});

function workspace(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `papeleria-key-${label}-`));
  roots.push(root);
  return root;
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

test('the state folder: the override, then each platform\'s place, and none without an absolute home', () => {
  const home = '/home/author';
  assert.equal(stateFolder({PAPELERIA_STATE_HOME: '/srv/state'}, 'linux', home), '/srv/state');
  assert.equal(stateFolder({PAPELERIA_STATE_HOME: 'relative/state'}, 'linux', home), join(home, '.local', 'state', 'papeleria'), 'a relative override is not used');
  assert.equal(stateFolder({}, 'linux', home), join(home, '.local', 'state', 'papeleria'));
  assert.equal(stateFolder({XDG_STATE_HOME: '/xdg/state'}, 'linux', home), join('/xdg/state', 'papeleria'));
  assert.equal(stateFolder({XDG_STATE_HOME: 'xdg'}, 'freebsd', home), join(home, '.local', 'state', 'papeleria'));
  assert.equal(stateFolder({}, 'darwin', home), join(home, 'Library', 'Application Support', 'Papeleria'));
  assert.equal(stateFolder({LOCALAPPDATA: '/local/app/data'}, 'win32', home), join('/local/app/data', 'Papeleria'));
  assert.equal(stateFolder({}, 'win32', home), join(home, 'AppData', 'Local', 'Papeleria'));
  assert.equal(stateFolder({}, 'linux', ''), null, 'a home that is not an absolute path names no folder: the key is never kept in the working folder');
  assert.equal(stateFolder({}, 'darwin', 'home'), null);
});

test('PRR-01: a system that names no home folder leaves the key to the process, and the override still applies', async () => {
  // What os.homedir() throws when HOME is unset and the user id has no account entry.
  const unnamed = (): string => {
    throw Object.assign(new Error('A system error occurred: uv_os_homedir returned ENOENT (no such file or directory)'), {code: 'ERR_SYSTEM_ERROR', syscall: 'uv_os_homedir'});
  };
  assert.equal(homeFolder(unnamed), '');
  assert.equal(homeFolder(() => '/home/author'), '/home/author');
  assert.equal(stateFolder({}, 'linux', homeFolder(unnamed)), null, 'no folder: installationKey(null) makes the process its own key');
  assert.equal(stateFolder({PAPELERIA_STATE_HOME: '/srv/state'}, 'linux', homeFolder(unnamed)), '/srv/state');
  assert.equal(stateFolder({XDG_STATE_HOME: '/xdg/state'}, 'linux', homeFolder(unnamed)), join('/xdg/state', 'papeleria'));
  const alone = await installationKey(stateFolder({}, 'linux', homeFolder(unnamed)));
  assert.deepEqual([alone.persistent, alone.bytes.length], [false, 32]);
});

test('made on first use, 32 bytes, owner-only on POSIX; later reads give the same key', async () => {
  const folder = join(workspace('first'), 'nested', 'papeleria');
  const first = await installationKey(folder);
  assert.equal(first.persistent, true);
  assert.equal(first.bytes.length, 32);
  const file = join(folder, INSTALLATION_KEY_FILE);
  assert.equal(readFileSync(file, 'utf8'), `${hex(first.bytes)}\n`);
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o600, 'the key file is the owner\'s alone');
    assert.equal(statSync(folder).mode & 0o777, 0o700, 'so is the folder made for it');
  }
  assert.equal(await installationKey(folder), await installationKey(folder), 'read once per process and folder');
  // The same file named another way is read again from the disk.
  assert.equal(hex((await installationKey(`${folder}/`)).bytes), hex(first.bytes));
});

test('builds that start together make one key between them', async () => {
  const folder = workspace('together');
  const keys = await Promise.all(Array.from({length: 8}, (_, index) => installationKey(`${folder}${'/'.repeat(index + 1)}`)));
  assert.equal(new Set(keys.map((key) => hex(key.bytes))).size, 1);
  assert.ok(keys.every((key) => key.persistent));
  assert.equal(readFileSync(join(folder, INSTALLATION_KEY_FILE), 'utf8'), `${hex(keys[0]!.bytes)}\n`);
});

test('a damaged key file is replaced; a link in its place is replaced too, never followed', {skip: process.platform === 'win32' ? 'no unprivileged links' : false}, async () => {
  const damaged = workspace('damaged');
  writeFileSync(join(damaged, INSTALLATION_KEY_FILE), 'not a key\n');
  const replaced = await installationKey(damaged);
  assert.equal(replaced.persistent, true);
  assert.equal(readFileSync(join(damaged, INSTALLATION_KEY_FILE), 'utf8'), `${hex(replaced.bytes)}\n`);

  const linked = workspace('linked');
  const elsewhere = join(workspace('elsewhere'), 'key');
  writeFileSync(elsewhere, `${'a'.repeat(64)}\n`);
  symlinkSync(elsewhere, join(linked, INSTALLATION_KEY_FILE));
  const own = await installationKey(linked);
  assert.notEqual(hex(own.bytes), 'a'.repeat(64), 'the key a link points at is never used');
  assert.equal(lstatSync(join(linked, INSTALLATION_KEY_FILE)).isSymbolicLink(), false);
  assert.equal(readFileSync(elsewhere, 'utf8'), `${'a'.repeat(64)}\n`, 'nor written through');
});

test('builds that start together over a damaged key file replace it once and agree on the key (Codex review of #43)', async () => {
  // Replacing by rename alone let each build put its own key in place and use it, so all but the last signed
  // records every later build refused; one build replaces it under a lock, and the others read what it wrote.
  for (const damage of ['not a key\n', '', `${'z'.repeat(64)}\n`]) {
    const folder = workspace('damaged-together');
    writeFileSync(join(folder, INSTALLATION_KEY_FILE), damage);
    const keys = await Promise.all(Array.from({length: 8}, (_, index) => installationKey(`${folder}${'/'.repeat(index + 1)}`)));
    assert.equal(new Set(keys.map((key) => hex(key.bytes))).size, 1, JSON.stringify(damage));
    assert.ok(keys.every((key) => key.persistent));
    assert.equal(readFileSync(join(folder, INSTALLATION_KEY_FILE), 'utf8'), `${hex(keys[0]!.bytes)}\n`);
    assert.equal(existsSync(join(folder, `${INSTALLATION_KEY_FILE}.lock`)), false, 'the lock is gone');
  }
});

test('where no folder can hold the key, one made for the process alone is used, the same for every build in it', async () => {
  const file = join(workspace('blocked'), 'a-file');
  writeFileSync(file, 'in the way\n');
  const blocked = join(file, 'state');
  const alone = await installationKey(blocked);
  assert.deepEqual([alone.persistent, alone.bytes.length], [false, 32]);
  assert.equal(await installationKey(blocked), await installationKey(blocked));
  assert.equal(existsSync(blocked), false);
  const nowhere = await installationKey(null);
  assert.deepEqual([nowhere.persistent, nowhere.bytes.length], [false, 32]);
  assert.notEqual(hex(nowhere.bytes), hex(alone.bytes));
});
