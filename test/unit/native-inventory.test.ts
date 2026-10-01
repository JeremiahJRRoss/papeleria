/**
 * Security audit F12: `scripts/native-inventory.mjs --fetch` downloads a
 * published tarball with `npm pack` and reads it with the system tar and
 * binutils. The bytes must be the ones the lockfile's integrity names before
 * anything is unpacked, and tar must not write the owners or mode bits an
 * archive asks for. The download itself needs the registry, so the fetch path
 * is pinned here by the function that decides and by the tar command it runs.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';

import {scriptPath} from '../helpers/paths.js';

type IntegrityMatches = (bytes: Uint8Array, expected: unknown) => boolean;

async function integrityMatches(): Promise<IntegrityMatches> {
  return ((await import(pathToFileURL(scriptPath('native-inventory.mjs')).href)) as {integrityMatches: IntegrityMatches}).integrityMatches;
}

test('F12: a fetched tarball is read only when its bytes are what the lockfile integrity names', async () => {
  const matches = await integrityMatches();
  const bytes = Buffer.from('the bytes of a published tarball');
  const sha512 = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  assert.equal(matches(bytes, sha512), true);
  assert.equal(matches(bytes, `sha1-${createHash('sha1').update(bytes).digest('base64')} ${sha512}`), true, 'one of several digests');
  assert.equal(matches(bytes, `${sha512}?option`), true, 'an option after the digest is not part of it');
  assert.equal(matches(Buffer.from('other bytes'), sha512), false, 'other bytes');
  assert.equal(matches(bytes, `sha1-${createHash('sha1').update(bytes).digest('base64')}`), false, 'a digest weaker than sha512 is not enough');
  for (const missing of [null, undefined, '', 'sha512-']) {
    assert.equal(matches(bytes, missing), false, `no integrity to compare with: ${String(missing)}`);
  }
});

test('F12: the fetch path compares before it unpacks, and unpacks without owners or mode bits', () => {
  const source = readFileSync(scriptPath('native-inventory.mjs'), 'utf8');
  const fetch = source.slice(source.indexOf('function fetchAndInspect('), source.indexOf('export function generateObservations('));
  assert.ok(fetch.indexOf('integrityMatches(bytes, integrity)') > 0, 'the integrity is compared');
  assert.ok(fetch.indexOf('integrityMatches(bytes, integrity)') < fetch.indexOf("execFileSync('tar'"), 'before tar runs');
  assert.match(fetch, /execFileSync\('tar', \['--no-same-owner', '--no-same-permissions', '-xzf', /);
  assert.match(source, /fetchAndInspect\(requirement\.package, requirement\.version, requirement\.integrity\)/, 'with the lockfile integrity');
});
