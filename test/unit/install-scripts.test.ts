/**
 * Security audit F11: installing Papeleria runs no package's install script.
 *
 * The tarball proof installs the packed package with `--ignore-scripts`
 * (`test/helpers/tarball.ts`), and it can because nothing Papeleria needs at
 * run time has an install, preinstall or postinstall script: sharp takes its
 * native binaries from prebuilt `@img/*` packages. A dependency update that
 * brings one in fails here, in `npm test`, so a person decides about it
 * before the proof or an author's installation runs it. Development tools
 * (esbuild's script fetches its binary) are not installed for an author.
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';

import {applicationRoot} from '../helpers/paths.js';

type LockEntry = {readonly version?: string; readonly dev?: boolean; readonly hasInstallScript?: boolean};

test('F11: no production dependency in the lockfile runs a script when it is installed', () => {
  const lock = JSON.parse(readFileSync(join(applicationRoot, 'package-lock.json'), 'utf8')) as {packages: Record<string, LockEntry>};
  const scripted = Object.entries(lock.packages).filter(([path, entry]) => path !== '' && entry.hasInstallScript === true);
  assert.ok(scripted.length > 0, 'the lockfile records install scripts at all (esbuild has one), so this test can fail');
  assert.deepEqual(
    scripted.filter(([, entry]) => entry.dev !== true).map(([path, entry]) => `${path}@${entry.version ?? '?'}`),
    [],
    'a production dependency with an install script: decide about it, then change test/helpers/tarball.ts and this test together',
  );
});
