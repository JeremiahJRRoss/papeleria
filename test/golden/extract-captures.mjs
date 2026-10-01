#!/usr/bin/env node
/**
 * Turns the captures the visual golden test prints back into files (A4, D70).
 *
 * When a baseline is missing, test/browser/golden/brand-overview.visual.test.ts
 * fails and prints every capture it has no baseline for into the test log:
 * base64 between PAPELERIA-CAPTURE markers, with the platform it ran on. This
 * reads such a log — a saved CI job log, the JSON the GitHub API returns for
 * one, or node --test output — checks each capture's length and SHA-256, and
 * writes it as a PNG, with the platform as platform.json, into the folder
 * given. It is the way baselines made in CI reach the repository when the
 * job's artifacts cannot be fetched.
 *
 * It approves nothing. What it writes becomes a baseline only when someone
 * commits it, and a baseline stays pending until the design maintainer has
 * reviewed it (test/golden/baselines/brand-overview/REVIEW_PENDING.md).
 *
 * Usage: node test/golden/extract-captures.mjs <log> <folder>
 * Exit:  0 written · 1 no capture found, or one failed its check · 2 usage or IO
 */
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const MARKER = 'PAPELERIA-CAPTURE';
const NAME = /^\d+x\d+\/\d{2}-[a-z]+\.png$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** The log's lines, from plain text or from the API's JSON wrapper. */
function logLines(text) {
  let content = text;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.logs_content === 'string') {
      content = parsed.logs_content;
    }
  } catch {
    // plain text
  }
  return content.split(/\r?\n/);
}

/** Every capture and the platform found in a log, each capture checked. */
export function readCaptures(text) {
  const captures = new Map();
  const problems = [];
  let platform = null;
  let open = null;
  for (const line of logLines(text)) {
    const at = line.indexOf(MARKER);
    if (at < 0) {
      continue;
    }
    const [word, ...rest] = line.slice(at).trim().split(' ');
    if (word === `${MARKER}-PLATFORM`) {
      platform = JSON.parse(rest.join(' '));
    } else if (word === `${MARKER}-BEGIN`) {
      const [name, bytes, sha256] = rest;
      if (!NAME.test(name ?? '') || !/^\d+$/.test(bytes ?? '') || !/^[0-9a-f]{64}$/.test(sha256 ?? '')) {
        problems.push(`a malformed begin marker: ${line.slice(at, at + 120)}`);
        open = null;
        continue;
      }
      open = {name, bytes: Number(bytes), sha256, chunks: []};
    } else if (word === MARKER) {
      const chunk = rest.join('');
      if (open === null || !BASE64.test(chunk)) {
        problems.push(`a capture line outside a capture, or not base64: ${line.slice(at, at + 80)}`);
        continue;
      }
      open.chunks.push(chunk);
    } else if (word === `${MARKER}-END`) {
      if (open === null || rest[0] !== open.name) {
        problems.push(`an end marker without its begin: ${line.slice(at, at + 120)}`);
        open = null;
        continue;
      }
      const data = Buffer.from(open.chunks.join(''), 'base64');
      const sha256 = createHash('sha256').update(data).digest('hex');
      if (data.length !== open.bytes || sha256 !== open.sha256) {
        problems.push(`${open.name}: ${data.length} bytes with SHA-256 ${sha256}, where the log says ${open.bytes} and ${open.sha256}`);
      } else if (captures.has(open.name) && !captures.get(open.name).equals(data)) {
        problems.push(`${open.name} appears twice with different contents`);
      } else {
        captures.set(open.name, data);
      }
      open = null;
    }
  }
  if (open !== null) {
    problems.push(`${open.name} has no end marker; the log may be cut short`);
  }
  return {captures, platform, problems};
}

function main(argv) {
  if (argv.length !== 2) {
    process.stderr.write('usage: node test/golden/extract-captures.mjs <log> <folder>\n');
    return 2;
  }
  const [log, folder] = argv.map((path) => resolve(path));
  let text;
  try {
    text = readFileSync(log, 'utf8');
  } catch (error) {
    process.stderr.write(`extract-captures: cannot read ${log}: ${error.message}\n`);
    return 2;
  }
  const {captures, platform, problems} = readCaptures(text);
  for (const problem of problems) {
    process.stderr.write(`extract-captures: ${problem}\n`);
  }
  if (captures.size === 0) {
    process.stderr.write('extract-captures: no capture was found in the log\n');
    return 1;
  }
  try {
    for (const [name, data] of captures) {
      const file = join(folder, ...name.split('/'));
      mkdirSync(dirname(file), {recursive: true});
      writeFileSync(file, data);
      process.stdout.write(`${name}: ${data.length} bytes\n`);
    }
    if (platform !== null) {
      writeFileSync(join(folder, 'platform.json'), `${JSON.stringify(platform, null, 2)}\n`);
      process.stdout.write(`platform.json: ${platform.engine} ${platform.version}, ${platform.os} ${platform.osRelease}\n`);
    }
  } catch (error) {
    process.stderr.write(`extract-captures: cannot write into ${folder}: ${error.message}\n`);
    return 2;
  }
  return problems.length === 0 ? 0 : 1;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  process.exitCode = main(process.argv.slice(2));
}
