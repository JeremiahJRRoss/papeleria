/**
 * M3.4 through the whole pipeline: R16 and R10 as an author meets them, on
 * documents built from temporary folders (ACCEPTANCE_MATRIX R10, R16, C07).
 *
 * - R16: a video the reader refuses is one error at the video, with no line,
 *   and the manifest token that names it as the related location (IC01); a
 *   file used twice is reported once; nothing is written.
 * - R10 has no module: the schema reports it (D149). A missing or blank
 *   alternative, and `decorative` on a video, are each one R10 and never also
 *   an R09.
 * - A native video builds: the page names the copied file and its poster
 *   with IC04's attributes, and the budget counts the poster, never the video.
 * - C07: a video is refused outside a document's sections.
 */
import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {after, test} from 'node:test';

import {runPipeline} from '../../src/build/pipeline.js';
import {pngSource} from '../fixtures/images/generate.js';
import {mp4Source, webmSource} from '../fixtures/video/generate.js';
import {readTree, removeTemporaryFolders, temporaryFolder} from '../helpers/pieces.js';

after(removeTemporaryFolders);

type Files = Readonly<Record<string, string | Uint8Array>>;

function piece(label: string, files: Files): string {
  const root = temporaryFolder(label);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, ...path.split('/'));
    mkdirSync(dirname(full), {recursive: true});
    writeFileSync(full, content);
  }
  return root;
}

/** A document whose one section holds the given block lines, indented under `blocks:`. */
function manifest(blocks: readonly string[]): string {
  return ['schema: 1', 'template: document', 'title: Video test.', 'sections:', '  - heading: Loops', '    blocks:', ...blocks.map((line) => `      ${line}`), ''].join('\n');
}

async function withPoster(files: Files): Promise<Files> {
  return {'assets/images/poster.png': await pngSource(1280, 720), ...files};
}

function build(root: string) {
  return runPipeline({root, label: 'piece'}, {kind: 'dist'});
}

/** The 1-based column where `needle` starts on its line. */
function columnOf(text: string, needle: string): number {
  return text.split('\n')[lineOf(text, needle) - 1]!.indexOf(needle) + 1;
}

function lineOf(text: string, needle: string): number {
  const index = text.split('\n').findIndex((line) => line.includes(needle));
  assert.ok(index >= 0, `${needle} is in the manifest`);
  return index + 1;
}

test('R16: a video over 15 seconds is one error at the file, with the manifest token as its related location', async () => {
  const text = manifest(['- video: {src: assets/video/long.mp4, poster: assets/images/poster.png, alt: A long loop., credit: Test, rights: Test}']);
  const root = piece('r16-long', await withPoster({'papeleria.yaml': text, 'assets/video/long.mp4': mp4Source({seconds: 16})}));
  const {report} = await build(root);
  assert.equal(report.status, 'failed');
  assert.deepEqual(report.findings, [
    {
      file: 'assets/video/long.mp4',
      line: null,
      column: null,
      rule: 'R16',
      severity: 'error',
      message: 'The video is 16 seconds long; a video loop is at most 15 seconds.',
      fix: 'Trim the loop to 15 seconds or less, or link to the full video instead of embedding it.',
      detail: 'Papeleria measures a video from its bytes; its name and anything written about it are not read (IC04).',
      relatedLocation: {file: 'papeleria.yaml', line: lineOf(text, 'long.mp4'), column: columnOf(text, 'assets/video/long.mp4')},
    },
  ]);
  assert.deepEqual([report.outputWritten, report.outputReason], [false, 'failed']);
  assert.deepEqual(Object.keys(readTree(root)).filter((path) => path.startsWith('dist/')), []);
});

test('R16: zero, unknown, non-finite, foreign and silent-less files each fail once, named by the first block that uses them', async () => {
  const cases: readonly (readonly [string, Uint8Array | string, RegExp])[] = [
    ['zero.webm', webmSource({duration: 0}), /duration of zero/],
    ['unknown.webm', webmSource({duration: null}), /does not state its duration/],
    ['nan.webm', webmSource({duration: Number.NaN}), /not a finite number/],
    ['unknown.mp4', mp4Source({unknownDuration: true}), /does not state its duration/],
    ['cut.mp4', mp4Source().slice(0, 120), /could not be read/],
    ['sound.mp4', mp4Source({brands: ['M4A ', 'isom'], tracks: [{kind: 'audio'}]}), /no video track/],
    ['text.webm', 'not a video', /not an MP4 or WebM video/],
  ];
  for (const [name, content, message] of cases) {
    const text = manifest([
      `- video: {src: assets/video/${name}, poster: assets/images/poster.png, alt: First use., credit: Test, rights: Test}`,
      `- video: {src: assets/video/${name}, poster: assets/images/poster.png, alt: Second use., credit: Test, rights: Test}`,
    ]);
    const root = piece(`r16-${name}`, await withPoster({'papeleria.yaml': text, [`assets/video/${name}`]: content}));
    const {report} = await build(root);
    assert.deepEqual(
      report.findings.map((finding) => [finding.rule, finding.file, finding.line, finding.relatedLocation?.line]),
      [['R16', `assets/video/${name}`, null, lineOf(text, 'First use.')]],
      name,
    );
    assert.match(report.findings[0]!.message, message, name);
  }
});

test('R10: a missing or blank alternative, or decorative on a video, is one R10 and never also an R09', async () => {
  const bytes = mp4Source({seconds: 4});
  const cases: readonly (readonly [string, string, number, string])[] = [
    ['missing', '- video: {src: assets/video/loop.mp4, poster: assets/images/poster.png}', 7, 'A video has no text alternative.'],
    ['blank', "- video: {src: assets/video/loop.mp4, poster: assets/images/poster.png, alt: '   '}", 7, "The video's text alternative is blank."],
    ['invisible', '- video: {src: assets/video/loop.mp4, poster: assets/images/poster.png, alt: "\\u200B"}', 7, "The video's text alternative is blank."],
    ['decorative', '- video: {src: assets/video/loop.mp4, poster: assets/images/poster.png, alt: A loop., decorative: true}', 7, ''],
  ];
  for (const [label, block, line, message] of cases) {
    const text = manifest([block]);
    const root = piece(`r10-${label}`, await withPoster({'papeleria.yaml': text, 'assets/video/loop.mp4': bytes}));
    const {report} = await build(root);
    assert.equal(report.status, 'failed', label);
    assert.deepEqual(report.findings.map((finding) => [finding.rule, finding.line]), [['R10', line]], `${label}: ${JSON.stringify(report.findings)}`);
    if (message !== '') {
      assert.equal(report.findings[0]!.message, message, label);
    }
  }
});

test('R10 positive: a native video builds; the page names the copied file and its poster, and only the poster is counted', async () => {
  const text = manifest(['- video: {src: assets/video/loop.webm, poster: assets/images/poster.png, alt: Waves against the pier at dawn., credit: Test, rights: Test}']);
  const bytes = webmSource({duration: 9000});
  const root = piece('r10-positive', await withPoster({'papeleria.yaml': text, 'assets/video/loop.webm': bytes}));
  const {report} = await build(root);
  assert.equal(report.status, 'ok', JSON.stringify(report.findings));
  assert.deepEqual(report.findings, []);
  const dist = readTree(join(root, 'dist'));
  assert.ok(Buffer.from(dist['assets/video/loop.webm']!).equals(Buffer.from(bytes)), 'the video is published as it is');
  const html = readFileSync(join(root, 'dist', 'index.html'), 'utf8');
  const player = /<video [^>]*>/.exec(html)?.[0] ?? '';
  assert.match(player, /^<video controls muted loop playsinline preload="none" poster="assets\/images\/poster\.[0-9a-f]{16}\.800\.webp" width="1280" height="720" aria-describedby="s1_b1-alt" src="assets\/video\/loop\.webm">$/);
  assert.doesNotMatch(html, /autoplay|<script/i);
  const posterPath = /poster="([^"]+)"/.exec(player)![1]!;
  assert.ok(dist[posterPath], 'the poster’s derivative is published');
  const counted = report.weight!.largest.map(([path]) => path);
  assert.ok(counted.includes(posterPath), 'the poster counts in the first view (IC04)');
  assert.ok(!counted.includes('assets/video/loop.webm'), 'the video never does: preload is none');
});

test('D92: the container is what the bytes are; an MP4 named .webm is read as MP4', async () => {
  const text = manifest(['- video: {src: assets/video/named.webm, poster: assets/images/poster.png, alt: A loop., credit: Test, rights: Test}']);
  const root = piece('r16-named', await withPoster({'papeleria.yaml': text, 'assets/video/named.webm': mp4Source({seconds: 16})}));
  const {report} = await build(root);
  assert.deepEqual(report.findings.map((finding) => [finding.rule, finding.message]), [['R16', 'The video is 16 seconds long; a video loop is at most 15 seconds.']]);
});

test('C07: a video outside a document section is refused by the schema', async () => {
  const deck = [
    'schema: 1',
    'template: deck',
    'title: T',
    'slides:',
    '  - layout: image',
    '    title: T',
    '    video: {src: assets/video/loop.mp4, poster: assets/images/poster.png, alt: A loop.}',
    '',
  ].join('\n');
  const root = piece('c07-deck', await withPoster({'papeleria.yaml': deck, 'assets/video/loop.mp4': mp4Source()}));
  const {report} = await build(root);
  assert.equal(report.status, 'failed');
  assert.ok(report.findings.every((finding) => finding.rule === 'R09'), JSON.stringify(report.findings));
  assert.ok(report.findings.some((finding) => finding.line === 7), 'the video key is reported where it stands');
});
