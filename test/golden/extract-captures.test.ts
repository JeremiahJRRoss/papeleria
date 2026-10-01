/**
 * A4 (D70): captures printed by the visual golden test come back out of a CI
 * log byte for byte, and a damaged or cut-short log is refused.
 */
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {after, test} from 'node:test';

import sharp from 'sharp';

import {applicationRoot, runNode} from '../helpers/paths.js';
import {removeTemporaryFolders, temporaryFolder} from '../helpers/pieces.js';
import {captureLines, platformLine, type Platform} from './captures.js';

after(removeTemporaryFolders);

const SCRIPT = join(applicationRoot, 'test', 'golden', 'extract-captures.mjs');
const PLATFORM: Platform = {engine: 'chromium', version: '153.0.8010.12', os: 'linux', osRelease: 'ubuntu 24.04'};

async function capture(width: number, height: number, colour: string): Promise<Uint8Array> {
  return new Uint8Array(await sharp({create: {width, height, channels: 3, background: colour}}).png().toBuffer());
}

/** Lines as a GitHub job log shows node --test diagnostics: a timestamp, indentation and '#'. */
function asJobLog(lines: readonly string[]): string {
  return lines.map((line, index) => `2026-09-24T21:18:${String(index % 60).padStart(2, '0')}.0000000Z     # ${line}`).join('\n');
}

test('captures printed into a job log come back byte for byte, with the platform', async () => {
  const cover = await capture(1232, 650, '#11110f');
  const type = await capture(358, 900, '#fcfcfa');
  const folder = temporaryFolder('captures');
  const lines = ['ok 1 - something else', platformLine(PLATFORM), ...captureLines('1280x800/01-cover.png', cover), ...captureLines('390x844/07-type.png', type)];
  const log = join(folder, 'job.log');
  writeFileSync(log, asJobLog(lines));
  const out = join(folder, 'baselines');
  const result = await runNode(SCRIPT, [log, out]);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(Buffer.from(cover).equals(readFileSync(join(out, '1280x800', '01-cover.png'))));
  assert.ok(Buffer.from(type).equals(readFileSync(join(out, '390x844', '07-type.png'))));
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'platform.json'), 'utf8')), PLATFORM);

  // The GitHub API's JSON wrapper, as a saved tool result holds it.
  const wrapped = join(folder, 'job.json');
  writeFileSync(wrapped, JSON.stringify({job_id: 1, logs_content: asJobLog(lines)}));
  const again = await runNode(SCRIPT, [wrapped, join(folder, 'again')]);
  assert.equal(again.code, 0, again.stderr);
  assert.ok(Buffer.from(cover).equals(readFileSync(join(folder, 'again', '1280x800', '01-cover.png'))));
});

test('a damaged capture, a log cut short, or a log without captures is refused', async () => {
  const cover = await capture(64, 32, '#11110f');
  const folder = temporaryFolder('captures-bad');
  const lines = captureLines('1280x800/01-cover.png', cover);
  // One base64 character of the payload changed, the marker left as it is.
  const damaged = lines.map((line, index) =>
    index === 1 ? line.replace(/^(PAPELERIA-CAPTURE )(.)/, (_, marker: string, first: string) => `${marker}${first === 'A' ? 'B' : 'A'}`) : line,
  );
  assert.notEqual(damaged[1], lines[1]);
  writeFileSync(join(folder, 'damaged.log'), asJobLog(damaged));
  const bad = await runNode(SCRIPT, [join(folder, 'damaged.log'), join(folder, 'out')]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /1280x800\/01-cover\.png: \d+ bytes with SHA-256 [0-9a-f]{64}, where the log says/);

  writeFileSync(join(folder, 'short.log'), asJobLog(lines.slice(0, -1)));
  const short = await runNode(SCRIPT, [join(folder, 'short.log'), join(folder, 'out-short')]);
  assert.equal(short.code, 1);
  assert.match(short.stderr, /has no end marker; the log may be cut short/);

  writeFileSync(join(folder, 'none.log'), 'ok 1 - nothing here\n');
  const none = await runNode(SCRIPT, [join(folder, 'none.log'), join(folder, 'out-none')]);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /no capture was found/);
});
