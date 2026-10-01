/**
 * M4.2: the comic's rules (D106, D107).
 *
 * - R14's extent, x + width and y + height each at most 100, the exact edge
 *   accepted, is one error at the box, reported by the schema mapping with the
 *   manifest's other errors (W5R-33), and nothing the core already said is
 *   repeated; the module says the same for a piece validated otherwise. It runs
 *   through the real pipeline as `check` on a copy of test/fixtures/comic/rules/.
 * - R04 has no module (D107): every panel's transcript is the core's, and the
 *   fixture holds its three forms, missing, blank and not text.
 * - R07 for a comic: every phone format of every page at most 307,200 bytes,
 *   inclusive, one error per file over it at the page image, related to the
 *   manifest line that names it; the first view has no limit.
 * - R08 allows a comic panel's box inline, on the panel alone.
 */
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {after, test} from 'node:test';

import {createNodeLoaders, loadManifest, resolvePiece, validateManifest, type Finding, type Piece, type ValidatedManifest} from '../../src/core/index.js';
import {measureFirstView, measurePhoneImages, PHONE_IMAGE_BUDGET_BYTES, phoneFormats, type PhoneImageMeasure} from '../../src/build/budget.js';
import {runPipeline} from '../../src/build/pipeline.js';
import {weightOf} from '../../src/build/report.js';
import {unexpectedDeclarations, validatePage} from '../../src/checks/html-scan.js';
import type {GeneratedOutput, OutputRuleContext} from '../../src/checks/rule.js';
import {rule as R07} from '../../src/checks/rules/R07.js';
import {EXTENT_TOLERANCE, rule as R14} from '../../src/checks/rules/R14.js';
import type {PublishedImage} from '../../templates/shared/blocks.js';
import {applicationRoot, fixturePath} from '../helpers/paths.js';
import {copyPiece, removeTemporaryFolders, temporaryFolder} from '../helpers/pieces.js';

after(removeTemporaryFolders);

const FIXTURE = fixturePath('comic', 'rules');

async function check(edit?: (manifest: string) => string): Promise<Finding[]> {
  const root = copyPiece(FIXTURE, 'comic-rules');
  if (edit !== undefined) {
    const file = join(root, 'papeleria.yaml');
    writeFileSync(file, edit(readFileSync(file, 'utf8')));
  }
  const {report} = await runPipeline({root, label: 'comic-rules'}, {kind: 'check'});
  return [...report.findings];
}

/** The 1-based line of the first line of the fixture's manifest holding `needle`. */
function lineOf(needle: string, text = readFileSync(join(FIXTURE, 'papeleria.yaml'), 'utf8')): number {
  const index = text.split('\n').findIndex((line) => line.includes(needle));
  assert.ok(index >= 0, needle);
  return index + 1;
}

/**
 * The fixture resolved for the modules to read alone. Validation refuses its
 * four boxes off the page, and nothing else (W5R-33), so the piece is resolved
 * from the manifest as loaded, which is otherwise valid.
 */
async function resolved(): Promise<{piece: Piece; manifest: ValidatedManifest}> {
  const loaders = createNodeLoaders(FIXTURE);
  const loaded = (await loadManifest(loaders)).manifest!;
  const refused = validateManifest(loaded).findings.map((item) => item.sourcePath.replace(/^papeleria\.yaml#/, ''));
  assert.deepEqual(refused, [0, 1, 2, 5].map((panel) => `/pages/0/panels/${panel}/box#extent`), 'the fixture\'s only errors are its extents');
  const manifest = {...loaded, template: 'comic', data: loaded.value as unknown as ValidatedManifest['data']} as ValidatedManifest;
  const result = await resolvePiece(manifest, {loaders});
  return {piece: result.piece!, manifest};
}

test('R14: each box that runs off the page is one error at the box; the exact edge, as written, is on the page', async () => {
  const findings = await check();
  assert.ok(findings.every((finding) => finding.rule === 'R14' && finding.severity === 'error'), findings.map((finding) => finding.message).join('\n'));
  const at = (box: string) => ({file: 'papeleria.yaml', line: lineOf(`box: [${box}]`)});
  assert.deepEqual(
    findings.map((finding) => ({file: finding.file, line: finding.line, message: finding.message})),
    [
      {...at('60, 4, 41, 28'), message: 'Panel 1 on page 1 runs off the right of the page: x + width is 101, and each must be at most 100.'},
      {...at('4, 80, 20, 21'), message: 'Panel 2 on page 1 runs off the bottom of the page: y + height is 101, and each must be at most 100.'},
      {...at('90, 90, 20, 20'), message: 'Panel 3 on page 1 runs off the right and bottom of the page: x + width is 110 and y + height is 110, and each must be at most 100.'},
      {...at('50, 50, 50.000001, 10'), message: 'Panel 6 on page 1 runs off the right of the page: x + width is 100.000001, and each must be at most 100.'},
    ],
  );
  const first = findings[0]!;
  assert.equal(first.fix, 'Make x + width at most 100, for example a width of 40 or less at x 60.');
  assert.equal(first.detail, 'The box is [x, y, width, height] in percent of the page image: [60, 4, 41, 28].');
  const boxLine = readFileSync(join(FIXTURE, 'papeleria.yaml'), 'utf8').split('\n')[first.line! - 1]!;
  assert.equal(first.column, boxLine.indexOf('[') + 1, 'at the box, where it is written');
});

test('R14\'s tolerance: a sum a rounding past 100 is at the edge; a millionth past it is not (D107)', async () => {
  assert.equal(EXTENT_TOLERANCE, 1e-9);
  const within = await check((text) => text.replace('box: [70.1, 0, 29.9, 100]', 'box: [70.1, 0, 29.900000000001, 100]'));
  assert.equal(within.length, 4, 'the four boxes off the page, and not the fourth, 1e-12 past the edge');
  assert.ok(!within.some((finding) => finding.message.startsWith('Panel 4 ')));
  const over = await check((text) => text.replace('box: [70.1, 0, 29.9, 100]', 'box: [70.1, 0, 29.90001, 100]'));
  assert.ok(over.some((finding) => finding.message === 'Panel 4 on page 1 runs off the right of the page: x + width is 100.00001, and each must be at most 100.'));
});

test('R14 repeats nothing the core reports: a box the schema refuses is the core\'s one finding about it, and the boxes off the page are reported with it', async () => {
  const extents = [
    'Panel 1 on page 1 runs off the right of the page: x + width is 101, and each must be at most 100.',
    'Panel 2 on page 1 runs off the bottom of the page: y + height is 101, and each must be at most 100.',
    'Panel 3 on page 1 runs off the right and bottom of the page: x + width is 110 and y + height is 110, and each must be at most 100.',
  ];
  const last = 'Panel 6 on page 1 runs off the right of the page: x + width is 100.000001, and each must be at most 100.';
  // The extents no longer wait for every other error to be fixed: they are judged with the schema's (W5R-33).
  const findings = await check((text) => text.replace('box: [0, 0, 100, 100]', 'box: [-1, 0, 100, 100]'));
  const r14 = findings.filter((finding) => finding.rule === 'R14');
  assert.deepEqual(r14.map((finding) => finding.message), [...extents, 'The x of the box of panel 5 on page 1 is -1, below 0.', last]);
  const shape = await check((text) => text.replace('box: [0, 0, 100, 100]', 'box: [0, 0, 100]'));
  assert.deepEqual(shape.filter((finding) => finding.rule === 'R14').map((finding) => finding.message), [
    ...extents,
    'The box of panel 5 on page 1 has 3 numbers; it needs four: x, y, width and height.',
    last,
  ]);
  // A box refused for one of its own numbers is not also said to run off the page.
  const own = await check((text) => text.replace('box: [0, 0, 100, 100]', 'box: [50, 0, 101, 100]'));
  assert.deepEqual(own.filter((finding) => finding.message.startsWith('Panel 5 ') || finding.message.includes('panel 5 ')).map((finding) => finding.message), [
    'The width of the box of panel 5 on page 1 is 101, above 100.',
  ]);

  // The module alone, on a piece whose manifest skipped validation: the same four findings, under the same
  // source paths as the core's, so the two settle into one.
  const {piece, manifest} = await resolved();
  const module = R14.check({piece, manifest, coreFindings: [], charts: new Map()});
  assert.deepEqual(module.map((item) => item.finding.message), [...extents, last]);
  const core = validateManifest((await loadManifest(createNodeLoaders(FIXTURE))).manifest!).findings;
  assert.deepEqual(module.map((item) => [item.sourcePath, item.finding]), core.map((item) => [item.sourcePath, item.finding]));
  assert.deepEqual(R14.check({piece: null, manifest: null, coreFindings: [], charts: new Map()}), []);
});

test('R04 is the core\'s: a panel\'s transcript missing, blank or not text is one error at the panel, with no module of its own (D107)', async () => {
  const valid = (text: string) => text.replace(/box: \[60, 4, 41, 28\]/, 'box: [60, 4, 40, 28]').replace('box: [4, 80, 20, 21]', 'box: [4, 79, 20, 21]').replace('box: [90, 90, 20, 20]', 'box: [80, 80, 20, 20]').replace('50.000001', '50');
  assert.deepEqual(await check(valid), [], 'the fixture with its boxes on the page checks clean');
  const cases: [string, (text: string) => string, string][] = [
    ['missing', (text) => valid(text).replace('        transcript: The whole page.\n', ''), 'A comic panel has no transcript.'],
    ['blank', (text) => valid(text).replace('transcript: The whole page.', "transcript: '   '"), "The panel's transcript is blank."],
    ['not text', (text) => valid(text).replace('transcript: The whole page.', 'transcript: [The whole page]'), "The panel's transcript must be text."],
  ];
  for (const [name, edit, message] of cases) {
    const findings = await check(edit);
    assert.deepEqual(
      findings.map((finding) => [finding.rule, finding.severity, finding.message]),
      [['R04', 'error', message]],
      name,
    );
  }
  assert.equal((await import('../../src/checks/load-rules.js').then((module) => module.loadRules())).some((rule) => rule.id === 'R04'), false, 'no R04 module');
});

function raster(stem: string, sizes: Readonly<Record<number, readonly [webp: number, avif: number]>>): PublishedImage {
  const widths = Object.keys(sizes).map(Number).sort((a, b) => a - b);
  return {
    kind: 'raster',
    width: widths.at(-1)!,
    height: widths.at(-1)!,
    derivatives: widths.flatMap((width) => [
      {path: `assets/images/${stem}.0123456789abcdef.${width}.webp`, width, height: width, format: 'webp' as const, bytes: sizes[width]![0]},
      {path: `assets/images/${stem}.0123456789abcdef.${width}.avif`, width, height: width, format: 'avif' as const, bytes: sizes[width]![1]},
    ]),
  };
}

test('R07 for a comic: the phone formats are the narrowest width in every format, or an SVG page\'s file; 307,200 bytes is within, one more is not', () => {
  assert.equal(PHONE_IMAGE_BUDGET_BYTES, 307_200);
  const page = raster('pages/01', {800: [307_200, 307_201], 1600: [900_000, 800_000]});
  assert.deepEqual(phoneFormats(page).map((file) => [file.path, file.bytes]), [
    ['assets/images/pages/01.0123456789abcdef.800.webp', 307_200],
    ['assets/images/pages/01.0123456789abcdef.800.avif', 307_201],
  ]);
  const small = raster('pages/02', {600: [1_000, 900]});
  assert.deepEqual(phoneFormats(small).map((file) => file.path), ['assets/images/pages/02.0123456789abcdef.600.webp', 'assets/images/pages/02.0123456789abcdef.600.avif'], 'a page narrower than 800 px: its one width');
  const drawn: PublishedImage = {kind: 'vector', width: 800, height: 1100, file: {path: 'assets/images/pages/03.svg', bytes: 400_000}};
  assert.deepEqual(phoneFormats(drawn), [{path: 'assets/images/pages/03.svg', bytes: 400_000}], 'approved SVG art counts its copied bytes (IC04)');

  const measured = measurePhoneImages([
    {source: 'assets/images/pages/01.png', image: page},
    {source: 'assets/images/pages/02.png', image: small},
    {source: 'assets/images/pages/03.svg', image: drawn},
    {source: 'assets/images/pages/01.png', image: page},
  ]);
  assert.deepEqual(
    measured.map((image) => [image.path, image.bytes, image.withinBudget]),
    [
      ['assets/images/pages/01.0123456789abcdef.800.webp', 307_200, true],
      ['assets/images/pages/01.0123456789abcdef.800.avif', 307_201, false],
      ['assets/images/pages/02.0123456789abcdef.600.webp', 1_000, true],
      ['assets/images/pages/02.0123456789abcdef.600.avif', 900, true],
      ['assets/images/pages/03.svg', 400_000, false],
    ],
    'each file once, inclusive at the limit',
  );
  const weight = weightOf({...measureFirstView({files: [{path: 'index.html', bytes: 10}], images: [], budgetBytes: null}), phoneImages: measured});
  assert.deepEqual(weight.phoneImages, measured.map((image) => [image.path, image.bytes, image.withinBudget]), 'the report lists every phone image');
  assert.equal(weight.budgetBytes, null, 'a comic\'s first view has no limit');
});

function outputContext(base: {piece: Piece; manifest: ValidatedManifest}, phoneImages: readonly PhoneImageMeasure[]): OutputRuleContext {
  const output: GeneratedOutput = {
    directory: temporaryFolder('comic-output'),
    label: 'dist',
    files: [],
    html: '',
    script: 'reader.js',
    weight: {...measureFirstView({files: [{path: 'index.html', bytes: 5_000_000}], images: [], budgetBytes: null}), phoneImages},
    firstViewSource: null,
    toolRoot: applicationRoot,
    sourceImages: new Map(),
  };
  return {...base, coreFindings: [], charts: new Map(), output};
}

test('R07 reports each phone image over the limit at its page image, related to the manifest line naming it; a first view of any size is not an error', async () => {
  const base = await resolved();
  const measure = (bytes: number): PhoneImageMeasure => ({source: 'assets/images/page.svg', path: 'assets/images/page.svg', bytes, withinBudget: bytes <= PHONE_IMAGE_BUDGET_BYTES});
  assert.deepEqual(await R07.check(outputContext(base, [measure(307_200)])), [], 'at the limit, and 5,000,000 bytes of first view: nothing');
  const findings = (await R07.check(outputContext(base, [measure(307_201)]))).map((item) => item.finding);
  assert.equal(findings.length, 1);
  const [finding] = findings;
  assert.deepEqual([finding!.rule, finding!.severity, finding!.file, finding!.line, finding!.column], ['R07', 'error', 'assets/images/page.svg', null, null]);
  assert.equal(finding!.message, 'The phone image assets/images/page.svg is 307,201 bytes, 1 over the comic phone-image budget of 307,200.');
  assert.deepEqual(finding!.relatedLocation, {file: 'papeleria.yaml', line: lineOf('image: assets/images/page.svg'), column: 12});
  assert.match(finding!.fix, /Simplify or reduce assets\/images\/page\.svg/);
});

test('R08: a comic panel may hold its box inline, and nothing else; no other element may hold a box', async () => {
  assert.deepEqual(unexpectedDeclarations('left:4%;top:4%;width:56%;height:28%', {panelBox: true}), []);
  assert.deepEqual(unexpectedDeclarations('left:70.1%;top:0%;width:29.9%;height:100%', {panelBox: true}), []);
  assert.deepEqual(unexpectedDeclarations('left:4%;top:4%;width:56%;height:28%'), ['left:4%', 'top:4%', 'width:56%', 'height:28%'], 'not on anything but a panel');
  for (const style of ['left:4px', 'left:-4%', 'left:calc(4%)', 'position:fixed', 'left:4%;background:url(x.png)', 'left:4%!important', 'left:\\34%']) {
    assert.ok(unexpectedDeclarations(style, {panelBox: true}).length > 0, style);
  }
  const page = (attributes: string) =>
    `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>T</title>\n</head>\n<body>\n<main><div ${attributes}><span>x</span></div></main>\n</body>\n</html>\n`;
  assert.deepEqual(await validatePage(page('class="comic-panel" style="left:4%;top:4%;width:56%;height:28%"'), {files: [], script: null}), []);
  const other = await validatePage(page('class="comic-art" style="left:4%"'), {files: [], script: null});
  assert.equal(other.length, 1);
  assert.match(other[0]!.message, /The style attribute holds "left:4%"; inline, the generator writes only .* and a comic panel's box/);
});
