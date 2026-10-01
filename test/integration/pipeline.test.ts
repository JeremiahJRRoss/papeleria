/**
 * M1.7: real builds of temporary pieces through the whole pipeline — the
 * output a reader receives, the notices it carries, the rules over it, and
 * IC05's promise that `dist/` is only ever an old or a new complete build.
 */
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {after, test} from 'node:test';

import sharp from 'sharp';

import {PipelineError, runPipeline, type PipelineOptions} from '../../src/build/pipeline.js';
import {FIRST_VIEW_BUDGET_BYTES} from '../../src/build/budget.js';
import type {OutputRule} from '../../src/checks/rule.js';
import {rule as R08} from '../../src/checks/rules/R08.js';
import type {SharpModule} from '../../src/core/index.js';
import {pngSource} from '../fixtures/images/generate.js';
import {applicationRoot} from '../helpers/paths.js';
import {copyPiece, pinFolder, readTree, removeTemporaryFolders, temporaryFolder} from '../helpers/pieces.js';

after(removeTemporaryFolders);

const STARTER = join(applicationRoot, 'examples', 'starter-deck');

function build(root: string, options: PipelineOptions = {}) {
  return runPipeline({root, label: 'piece'}, {kind: 'dist'}, options);
}

function check(root: string, options: PipelineOptions = {}) {
  return runPipeline({root, label: 'piece'}, {kind: 'check'}, options);
}

function distTree(root: string): Record<string, string> {
  return Object.fromEntries(Object.entries(readTree(join(root, 'dist'))).map(([path, bytes]) => [path, Buffer.from(bytes).toString('base64')]));
}

function stateLeftovers(root: string): string[] {
  const state = join(root, '.papeleria');
  if (!existsSync(state)) {
    return [];
  }
  const left: string[] = [];
  for (const name of readdirSync(state)) {
    if (name === 'cache') {
      continue;
    }
    if (name === 'staging' || name === 'previous') {
      left.push(...readdirSync(join(state, name)).map((entry) => `${name}/${entry}`));
    } else {
      left.push(name);
    }
  }
  return left;
}

function edit(root: string, file: string, change: (text: string) => string): void {
  const path = join(root, file);
  writeFileSync(path, change(readFileSync(path, 'utf8')));
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<PipelineError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof PipelineError, `expected a PipelineError, got ${String(caught)}`);
  assert.equal(caught.code, code, caught.message);
  return caught;
}

test('C06/C21–C24: the starter deck builds a self-contained dist/ with its notices, one script and relative URLs only', async () => {
  const root = copyPiece(STARTER, 'starter');
  const {report, olderDist, recovery} = await build(root);
  assert.equal(report.status, 'ok', JSON.stringify(report.findings));
  assert.deepEqual([report.outputWritten, report.outputReason, olderDist, recovery], [true, 'written', false, null]);
  assert.deepEqual(report.tool, {name: 'papeleria', version: '0.1.0'});
  assert.equal(report.targets.filter((target) => target.file === 'papeleria.yaml').length, 5);

  const files = Object.keys(readTree(join(root, 'dist'))).sort();
  assert.deepEqual(files, [
    'Inter-OFL.txt',
    'LICENSE',
    'NOTICE.md',
    'Poppins-OFL.txt',
    'THIRD_PARTY.md',
    'deck.js',
    'index.html',
    'theme/css/base.css',
    'theme/css/fonts.css',
    'theme/css/site.css',
    'theme/css/slides.css',
    'theme/css/tokens.css',
    'theme/fonts/inter-400-700-latin-ext.woff2',
    'theme/fonts/inter-400-700-latin.woff2',
    'theme/fonts/poppins-400-latin-ext.woff2',
    'theme/fonts/poppins-400-latin.woff2',
    'theme/fonts/poppins-500-latin-ext.woff2',
    'theme/fonts/poppins-500-latin.woff2',
    'theme/fonts/poppins-600-latin-ext.woff2',
    'theme/fonts/poppins-600-latin.woff2',
    'theme/marks/papeleria-favicon.svg',
  ]);
  const same = (output: string, source: string) => assert.ok(readFileSync(join(root, 'dist', output)).equals(readFileSync(join(applicationRoot, source))), output);
  same('LICENSE', 'LICENSE');
  same('NOTICE.md', 'NOTICE.md');
  same('Poppins-OFL.txt', 'theme/fonts/Poppins-OFL.txt');
  same('Inter-OFL.txt', 'theme/fonts/Inter-OFL.txt');
  same('deck.js', 'lib/clients/deck.js');
  same('theme/css/base.css', 'templates/shared/base.css');
  same('theme/css/site.css', 'theme/css/site.css');
  const thirdParty = readFileSync(join(root, 'dist', 'THIRD_PARTY.md'), 'utf8');
  // M5.3 (D127): generated from what the generation holds; a deck carries the two font families and nothing else.
  assert.match(thirdParty, /^# Third-party components in this piece\n\nWritten by Papeleria 0\.1\.0 from the files in this folder\./);
  assert.match(thirdParty, /including the page, `deck\.js` and the stylesheets, is under the Apache License 2\.0/);
  assert.match(thirdParty, /\| Poppins \| .* \| SIL Open Font License 1\.1 \(OFL-1\.1\) \| Copyright 2020 The Poppins Project Authors/);
  assert.doesNotMatch(thirdParty, /StPageFlip|Placeholder/);
  assert.ok(!files.some((file) => file.startsWith('theme/js/')), 'the kit’s theme/js/ is never staged (C22)');

  const html = readFileSync(join(root, 'dist', 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((match) => match[1]!);
  assert.deepEqual(scripts.filter((attributes) => !attributes.includes('type="application/json"')), [' src="deck.js" defer']);
  const json = /<script type="application\/json"[^>]*>([^<]*)<\/script>/.exec(html)?.[1] ?? '';
  assert.doesNotMatch(json, /[<>&\u2028\u2029]/);
  assert.match(json, /\\u0026/, 'the & in the notes heading is escaped (IC02)');
  assert.deepEqual(JSON.parse(json), JSON.parse(readFileSync(join(applicationRoot, 'templates', 'shared', 'strings.en.json'), 'utf8')));
  for (const match of html.matchAll(/\s(src|href|srcset|poster)="([^"]*)"/g)) {
    const [, attribute, value] = match;
    if (attribute === 'href' && (value!.startsWith('#') || /^(https?|mailto|tel):/.test(value!))) {
      continue;
    }
    assert.doesNotMatch(value!, /^(?:[a-z][a-z0-9+.-]*:|\/)/i, `${attribute}="${value}" is relative`);
    assert.ok(existsSync(join(root, 'dist', value!)), `${attribute}="${value}" is in dist/`);
  }
  assert.match(html, /<meta name="generator" content="Papeleria 0\.1\.0">/);
  assert.deepEqual(stateLeftovers(root), [], 'no generation, journal or lock is left behind');
});

test('IC05: a rebuild replaces dist/ whole and writes the same bytes; a check never touches dist/', async () => {
  const root = copyPiece(STARTER, 'rebuild');
  await build(root);
  const first = distTree(root);
  writeFileSync(join(root, 'dist', 'stray.txt'), 'left by hand');
  await build(root);
  assert.deepEqual(distTree(root), first, 'byte-identical, and nothing of the old dist/ survives');
  writeFileSync(join(root, 'dist', 'stray.txt'), 'left by hand');
  const before = distTree(root);
  const {report} = await check(root);
  assert.deepEqual([report.status, report.outputWritten, report.outputReason], ['ok', false, 'check_only']);
  assert.ok(report.weight !== null && report.weight.withinBudget);
  assert.deepEqual(distTree(root), before);
  const fresh = copyPiece(STARTER, 'check-fresh');
  await check(fresh);
  assert.equal(existsSync(join(fresh, 'dist')), false, 'a check never creates dist/');
  assert.deepEqual(stateLeftovers(fresh), []);
});

test('IC05 withheld: nothing is written, a fresh piece gets no dist/ and an older dist/ stays as it was, flagged', async () => {
  const fresh = copyPiece(STARTER, 'withheld-fresh');
  edit(fresh, 'papeleria.yaml', (text) => text.replace('status: draft', 'status: withheld'));
  const first = await build(fresh);
  assert.deepEqual([first.report.status, first.report.outputWritten, first.report.outputReason, first.olderDist], ['ok', false, 'withheld', false]);
  assert.ok(first.report.weight !== null, 'the private preview is checked all the way');
  assert.equal(existsSync(join(fresh, 'dist')), false);

  const existing = copyPiece(STARTER, 'withheld-existing');
  await build(existing);
  const before = distTree(existing);
  edit(existing, 'papeleria.yaml', (text) => text.replace('status: draft', 'status: withheld'));
  const second = await build(existing);
  assert.deepEqual([second.report.outputWritten, second.report.outputReason, second.olderDist], [false, 'withheld', true]);
  assert.deepEqual(distTree(existing), before);
  assert.deepEqual(stateLeftovers(existing), []);
});

test('IC05: a build with errors keeps the old dist/ and says nothing was written', async () => {
  const root = copyPiece(STARTER, 'failed');
  await build(root);
  const before = distTree(root);
  edit(root, 'papeleria.yaml', (text) => text.replace('summary: Review took', 'sumary: Review took'));
  const {report, olderDist} = await build(root);
  assert.deepEqual([report.status, report.outputWritten, report.outputReason, olderDist], ['failed', false, 'failed', true]);
  assert.deepEqual(
    report.findings.map((finding) => finding.rule),
    ['R05', 'R09'],
    'the summary missing at its chart, then the misspelled field, each once and in IC01 order',
  );
  assert.equal(report.weight, null);
  assert.deepEqual(distTree(root), before);
});

test('IC05: a source that changes during the build is E_SOURCE_CHANGED, and the old dist/ is kept', async () => {
  const root = copyPiece(STARTER, 'changed');
  await build(root);
  const before = distTree(root);
  const error = await rejectsWith(
    build(root, {beforeRecheck: async () => edit(root, 'assets/text/01-cover-notes.md', (text) => `${text}\nAdded meanwhile.\n`)}),
    'E_SOURCE_CHANGED',
  );
  assert.match(error.message, /assets\/text\/01-cover-notes\.md/);
  assert.deepEqual(distTree(root), before);
  assert.deepEqual(stateLeftovers(root), []);
});

test('IC05: a crash between moving the old dist/ aside and promoting leaves no dist/, and the next build restores then replaces it', async () => {
  const root = copyPiece(STARTER, 'crash');
  await build(root);
  const before = distTree(root);
  edit(root, 'papeleria.yaml', (text) => text.replace('Papeleria templates', 'Papeleria templates, rebuilt'));
  await rejectsWith(
    build(root, {
      faults: (step) => {
        if (step === 'backup-moved') {
          throw new Error('simulated crash');
        }
      },
    }),
    'E_INTERNAL',
  );
  assert.equal(existsSync(join(root, 'dist')), false, 'the brief window: no dist/, never a partial one');
  const {report, recovery} = await build(root);
  assert.equal(recovery, 'restored');
  assert.equal(report.outputReason, 'written');
  assert.notDeepEqual(distTree(root), before);
  assert.match(readFileSync(join(root, 'dist', 'index.html'), 'utf8'), /Papeleria templates, rebuilt/);
  assert.deepEqual(stateLeftovers(root), []);
});

test('D65: valid author Markdown builds without R08: an aligned table and a footnote cited twice', async () => {
  const root = copyPiece(STARTER, 'markdown');
  writeFileSync(
    join(root, 'assets', 'text', '01-cover-notes.md'),
    '| Phase | Hours |\n|:--|--:|\n| Plan | 12 |\n\nA claim[^1] and the same source again[^1].\n\n[^1]: The source.\n',
  );
  const {report} = await build(root);
  assert.deepEqual(report.findings, []);
  const html = readFileSync(join(root, 'dist', 'index.html'), 'utf8');
  assert.match(html, /style="text-align:right"/);
  assert.match(html, /id="fnref-slides-0-notes-1:1"/);
});

const PADDING_MARK = 'PADDING';

function svgWithPadding(padding: number): string {
  return `\ufeff<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900"><title>Wide mark</title><desc>${'x'.repeat(padding)}</desc><rect width="1600" height="900" fill="#0f766e"/></svg>`;
}

function imageFirst(root: string, image: string): void {
  edit(root, 'papeleria.yaml', (text) =>
    text.replace(
      'slides:\n',
      `slides:\n  - layout: image\n    title: ${PADDING_MARK}\n    image: {src: ${image}, alt: A wide mark, credit: Studio, rights: Own work}\n\n`,
    ),
  );
}

test('IC04/D164(f): a first view exactly at 1,048,576 bytes with an SVG saved with a byte-order mark passes; one byte more fails R07', async () => {
  const root = copyPiece(STARTER, 'threshold');
  mkdirSync(join(root, 'assets', 'images'), {recursive: true});
  imageFirst(root, 'assets/images/wide.svg');
  const svg = join(root, 'assets', 'images', 'wide.svg');
  writeFileSync(svg, svgWithPadding(0));
  const probe = await check(root);
  assert.equal(probe.report.status, 'ok', JSON.stringify(probe.report.findings));
  const padding = FIRST_VIEW_BUDGET_BYTES - probe.report.weight!.firstViewBytes;
  assert.ok(padding > 0);

  writeFileSync(svg, svgWithPadding(padding));
  const at = await build(root);
  assert.equal(at.report.weight?.firstViewBytes, FIRST_VIEW_BUDGET_BYTES);
  assert.deepEqual([at.report.status, at.report.outputWritten], ['ok', true], JSON.stringify(at.report.findings));
  const published = readFileSync(join(root, 'dist', 'assets', 'images', 'wide.svg'));
  assert.equal(published.length, readFileSync(svg).length - 3, 'published without its byte-order mark, and counted so');
  assert.notEqual(published[0], 0xef);

  writeFileSync(svg, svgWithPadding(padding + 1));
  const over = await build(root);
  assert.equal(over.report.weight?.firstViewBytes, FIRST_VIEW_BUDGET_BYTES + 1);
  assert.deepEqual([over.report.status, over.report.outputWritten, over.olderDist], ['failed', false, true]);
  const finding = over.report.findings.find((item) => item.rule === 'R07');
  assert.deepEqual([finding?.file, finding?.line, finding?.severity], ['dist/index.html', null, 'error']);
  assert.match(finding?.message ?? '', /^The first view loads 1,048,577 bytes, 1 over the budget of 1,048,576\. Largest files: assets\/images\/wide\.svg /);
  assert.equal(finding?.relatedLocation?.file, 'papeleria.yaml');
  assert.equal(readFileSync(join(root, 'dist', 'assets', 'images', 'wide.svg')).length, published.length, 'the passing build stays');
});

/** Real sharp with the AVIF encoder taken away, as on a platform whose build lacks it. */
function sharpWithoutAvif(): SharpModule {
  const real = sharp as unknown as (...args: unknown[]) => Record<string, unknown>;
  const wrapped = (...args: unknown[]) => {
    const instance = real(...args);
    instance['avif'] = () => {
      throw new Error('simulated: this sharp build has no AVIF encoder');
    };
    return instance;
  };
  Object.assign(wrapped, {versions: sharp.versions, concurrency: sharp.concurrency, simd: sharp.simd, format: sharp.format});
  return wrapped as unknown as SharpModule;
}

test('DEP03/D42: without an AVIF encoder the build writes WebP only and warns once (R07), whatever the number of images', async () => {
  const root = copyPiece(STARTER, 'no-avif');
  mkdirSync(join(root, 'assets', 'images'), {recursive: true});
  writeFileSync(join(root, 'assets', 'images', 'one.png'), await pngSource(1700, 900));
  writeFileSync(join(root, 'assets', 'images', 'two.png'), await pngSource(900, 600));
  imageFirst(root, 'assets/images/one.png');
  edit(root, 'papeleria.yaml', (text) => `${text}\n  - layout: image\n    title: Second picture\n    image: {src: assets/images/two.png, alt: A second picture, credit: Studio, rights: Own work}\n`);
  const {report} = await build(root, {loadSharp: async () => sharpWithoutAvif()});
  assert.equal(report.status, 'ok', JSON.stringify(report.findings));
  const warnings = report.findings.filter((finding) => finding.rule === 'R07');
  assert.equal(warnings.length, 1);
  assert.deepEqual([warnings[0]!.file, warnings[0]!.line, warnings[0]!.severity], ['piece', null, 'warning']);
  assert.equal(warnings[0]!.detail, 'The first-view budget was measured with WebP alone.');
  const images = readdirSync(join(root, 'dist', 'assets', 'images')).sort();
  assert.ok(images.length === 3 && images.every((name) => name.endsWith('.webp')), images.join(', '));
  assert.doesNotMatch(readFileSync(join(root, 'dist', 'index.html'), 'utf8'), /image\/avif/);
});

test('D157: an image resolve accepted but derivation refuses is R09 at the image, with the manifest token that names it', async () => {
  const root = copyPiece(STARTER, 'too-tall');
  mkdirSync(join(root, 'assets', 'images'), {recursive: true});
  // 20 px wide and 20,000 px tall: fine to probe, but no WebP can be that tall.
  writeFileSync(join(root, 'assets', 'images', 'tall.png'), await pngSource(20, 20_000));
  imageFirst(root, 'assets/images/tall.png');
  const {report} = await build(root);
  assert.equal(report.status, 'failed');
  const finding = report.findings.find((item) => item.rule === 'R09');
  assert.deepEqual([finding?.file, finding?.line, finding?.column], ['assets/images/tall.png', null, null]);
  const line = readFileSync(join(root, 'papeleria.yaml'), 'utf8').split('\n').findIndex((text) => text.includes('src: assets/images/tall.png')) + 1;
  assert.equal(finding?.relatedLocation?.line, line);
  assert.equal(existsSync(join(root, 'dist')), false);
  assert.deepEqual(stateLeftovers(root), []);
});

test('W5R-11: an output rule that cannot read the generation back fails E_OUTPUT_IO, never the piece’s E_SOURCE_IO', async () => {
  const root = copyPiece(STARTER, 'output-unreadable');
  // Something takes the generated stylesheets away before R08 reads them back.
  const vanish: OutputRule = {
    id: 'vanish',
    phase: 'output',
    async check({output}) {
      rmSync(join(output.directory, 'theme'), {recursive: true, force: true});
      return [];
    },
  };
  for (const kind of ['dist', 'check'] as const) {
    const error = await rejectsWith(runPipeline({root, label: 'piece'}, {kind}, {rules: [vanish, R08]}), 'E_OUTPUT_IO');
    assert.match(error.message, /^The generated output could not be read back for R08: ENOENT/);
  }
  assert.equal(existsSync(join(root, 'dist')), false);
  assert.deepEqual(stateLeftovers(root), []);
});

test('W5R-01: a build that cannot remove an old orphan still builds, and reports the folder it left', {skip: process.platform === 'win32' ? 'the pinning relies on POSIX permissions or chattr' : false}, async () => {
  const root = copyPiece(STARTER, 'orphan-build');
  const orphan = `${(Date.now() - 2 * 60 * 60 * 1000).toString(36)}-0123456789ab`;
  mkdirSync(join(root, '.papeleria', 'staging', orphan), {recursive: true});
  const unpin = pinFolder(join(root, '.papeleria', 'staging', orphan));
  try {
    for (let run = 0; run < 2; run += 1) {
      const {report, leftovers} = await build(root);
      assert.equal(report.outputReason, 'written');
      assert.deepEqual(
        leftovers.map((leftover) => leftover.path),
        [`.papeleria/staging/${orphan}`],
      );
    }
  } finally {
    unpin();
  }
  const {leftovers} = await build(root);
  assert.deepEqual(leftovers, []);
  assert.deepEqual(stateLeftovers(root), []);
});

test('the tool, not the piece: a missing folder, a file, and a missing tool are exit-2 failures with codes', async () => {
  const missing = join(temporaryFolder('missing'), 'nothing-here');
  await rejectsWith(build(missing), 'E_PIECE_FOLDER');
  const file = join(temporaryFolder('file'), 'papeleria.yaml');
  writeFileSync(file, 'schema: 1\n');
  await rejectsWith(check(file), 'E_PIECE_FOLDER');
  // Every template renders from M4 (W4, D119): the comic's build is test/integration/comic-build.test.ts.
  const tool = temporaryFolder('broken-tool');
  const root = copyPiece(STARTER, 'broken-tool-piece');
  rmSync(tool, {recursive: true});
  await rejectsWith(build(root, {toolRoot: tool}), 'E_TOOL_RESOURCE');
});
