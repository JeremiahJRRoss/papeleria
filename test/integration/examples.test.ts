/**
 * M1.10 and the deck subset of A7: the two deck examples, built by the
 * compiled CLI the way an author builds them. Every build runs on a temporary
 * copy, so nothing is written into examples/ (D71, D72).
 *
 * - The starter deck names only files it has and has every file it names;
 *   `test/unit/sample.test.ts` keeps it identical to `templates/deck/sample/`
 *   (D60).
 * - Both decks check and build with zero errors, every warning listed, their
 *   notices beside the page, and a first view within 1,048,576 bytes that is
 *   exactly the bytes `dist/` holds for it (IC04, D62).
 * - A1: an edit to the text file a slide names changes the rebuilt deck there
 *   and nowhere else.
 * - A3: an image swapped in without alt stops the build at its block, once
 *   (R03), and the last complete build stays as it was.
 * - `npm run examples` checks, then builds, every example, the comic's
 *   included since M4 (W4), and would list any pending one; from M5.5 (W5D,
 *   D139) it prints every warning with its rule, and one nobody has accepted
 *   fails the run.
 */
import assert from 'node:assert/strict';
import {cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {basename, join} from 'node:path';
import {after, before, describe, test} from 'node:test';

import sharp from 'sharp';
import {parse} from 'yaml';

import {applicationRoot, runNode, scriptPath, type RunResult} from '../helpers/paths.js';
import {copyPiece, readTree, removeTemporaryFolders, temporaryFolder} from '../helpers/pieces.js';

after(removeTemporaryFolders);

const CLI = join(applicationRoot, 'lib', 'src', 'cli', 'index.js');
const EXAMPLES = join(applicationRoot, 'examples');
const BUDGET = 1_048_576;

/** The deck examples, their slide counts, and the warnings a reader has looked at: none so far. */
const DECKS = [
  {name: 'starter-deck', slides: 5, warnings: [] as string[]},
  {name: 'brand-overview', slides: 16, warnings: [] as string[]},
] as const;

/** D62: the notices every generation carries at its root. */
const NOTICES = ['LICENSE', 'NOTICE.md', 'Poppins-OFL.txt', 'Inter-OFL.txt', 'THIRD_PARTY.md'];

type Finding = {
  file: string;
  line: number | null;
  column: number | null;
  rule: string;
  severity: 'error' | 'warning';
  message: string;
  fix: string;
  detail: string | null;
};
type Report = {
  status: 'ok' | 'failed';
  errors: number;
  warnings: number;
  findings: Finding[];
  weight: {firstViewBytes: number; budgetBytes: number | null; withinBudget: boolean} | null;
  outputWritten: boolean;
  outputReason: string;
};

function build(piece: string): Promise<RunResult> {
  return runNode(CLI, ['build', piece]);
}

async function check(piece: string): Promise<{code: number; report: Report; stderr: string}> {
  const result = await runNode(CLI, ['check', piece, '--json']);
  return {code: result.code, report: JSON.parse(result.stdout) as Report, stderr: result.stderr};
}

/** Every string in a parsed manifest that names a file under assets/. */
function assetReferences(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.startsWith('assets/') ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(assetReferences);
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value).flatMap(assetReferences);
  }
  return [];
}

/** Every regular file under a folder, by its path relative to `root`; anything else fails. */
function filesUnder(root: string, directory = root): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      return filesUnder(root, path);
    }
    assert.ok(stat.isFile(), `${path} is neither a folder nor a regular file`);
    return [path.slice(root.length + 1).split('\\').join('/')];
  });
}

test('M1.10: the starter deck names only files it has, and has every file it names', () => {
  const root = join(EXAMPLES, 'starter-deck');
  const manifest = parse(readFileSync(join(root, 'papeleria.yaml'), 'utf8')) as unknown;
  const named = [...new Set(assetReferences(manifest))].sort();
  assert.deepEqual(named, ['assets/data/hours-by-phase.csv', 'assets/text/01-cover-notes.md']);
  const present = filesUnder(join(root, 'assets')).map((path) => `assets/${path}`).sort();
  assert.deepEqual(present, named, 'every file under assets/ is one the manifest names, and every file it names is there');
});

for (const deck of DECKS) {
  describe(`examples/${deck.name}, built by the compiled CLI`, () => {
    let piece = '';
    let checked: {code: number; report: Report; stderr: string};
    let built: RunResult;
    before(async () => {
      piece = copyPiece(join(EXAMPLES, deck.name), deck.name);
      checked = await check(piece);
      built = await build(piece);
    });

    test('A7: check and build report zero errors, and every warning is listed', (context) => {
      assert.equal(checked.code, 0, checked.stderr);
      const {report} = checked;
      assert.deepEqual([report.status, report.errors, report.outputWritten, report.outputReason], ['ok', 0, false, 'check_only']);
      const warnings = report.findings
        .filter((finding) => finding.severity === 'warning')
        .map((finding) => `${finding.file}:${finding.line ?? '-'} ${finding.rule} ${finding.message}`);
      for (const warning of warnings) {
        context.diagnostic(`warning: ${warning}`);
      }
      assert.deepEqual(warnings, deck.warnings, 'a new warning is added to the expected list once someone has read it');
      assert.equal(report.warnings, warnings.length);

      assert.equal(built.code, 0, built.stderr);
      assert.equal(built.stdout, '');
      assert.match(built.stderr, /^Built .*dist · 0 errors · 0 warnings · first view [\d,]+ of 1,048,576 bytes\n$/);
      const html = readFileSync(join(piece, 'dist', 'index.html'), 'utf8');
      assert.equal(html.match(/<article class="deck-slide /g)?.length, deck.slides);
    });

    test('A7: the notices ship beside the page (D62)', () => {
      for (const notice of NOTICES) {
        assert.ok(statSync(join(piece, 'dist', notice)).isFile(), `${notice} is missing from dist/`);
      }
    });

    test('IC04: the first view is within 1,048,576 bytes, and is exactly the bytes dist/ holds for it', (context) => {
      const weight = checked.report.weight;
      assert.ok(weight !== null, 'a deck reports its weight');
      assert.equal(weight.budgetBytes, BUDGET);
      assert.equal(weight.withinBudget, true);
      assert.ok(weight.firstViewBytes <= BUDGET);

      // Neither deck shows an image, so every viewport and scenario counts the
      // same files: the page, what it links and loads, and all eight fonts,
      // each once (IC04, D62).
      const dist = join(piece, 'dist');
      const html = readFileSync(join(dist, 'index.html'), 'utf8');
      const referenced = [
        ...Array.from(html.matchAll(/<link rel="(?:stylesheet|icon)" href="([^"]+)"/g), (match) => match[1]!),
        ...Array.from(html.matchAll(/<script src="([^"]+)"/g), (match) => match[1]!),
      ];
      const fonts = readdirSync(join(dist, 'theme', 'fonts')).map((name) => `theme/fonts/${name}`);
      assert.equal(fonts.length, 8, 'all eight shipped fonts');
      assert.equal(referenced.length, 7, 'five stylesheets, the favicon and deck.js');
      const counted = ['index.html', ...referenced, ...fonts];
      assert.equal(new Set(counted).size, counted.length, 'each file is counted once');
      const bytes = counted.reduce((sum, path) => sum + statSync(join(dist, path)).size, 0);
      assert.equal(weight.firstViewBytes, bytes, 'the report counts what dist/ holds');
      context.diagnostic(`${deck.name}: first view ${bytes.toLocaleString('en-US')} of ${BUDGET.toLocaleString('en-US')} bytes`);
    });
  });
}

test('A1: an edit to the text file a slide names changes the rebuilt deck there, and nowhere else', async () => {
  const piece = copyPiece(join(EXAMPLES, 'starter-deck'), 'a1');
  assert.equal((await build(piece)).code, 0);
  const before = readTree(join(piece, 'dist'));
  const page = Buffer.from(before['index.html']!).toString('utf8');

  const notes = join(piece, 'assets', 'text', '01-cover-notes.md');
  const original = 'Speaker notes for the cover.';
  const edited = 'Read this aloud before the first slide.';
  const text = readFileSync(notes, 'utf8');
  assert.equal(text.split(original).length, 2, 'the sentence is in the notes file once');
  writeFileSync(notes, text.replace(original, edited));

  const rebuilt = await build(piece);
  assert.equal(rebuilt.code, 0, rebuilt.stderr);
  const after = readTree(join(piece, 'dist'));
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), 'the same files');
  for (const [path, bytes] of Object.entries(before)) {
    if (path !== 'index.html') {
      assert.ok(Buffer.from(bytes).equals(Buffer.from(after[path]!)), `${path} changed`);
    }
  }

  // Exactly where expected: the sentence occurs once in the old page, inside
  // slide 1's notes, and the new page is the old one with it replaced.
  assert.equal(page.split(original).length, 2, 'the old page holds the sentence once');
  const slide = page.indexOf('<article class="deck-slide slide-layout-cover" id="slide-1"');
  const aside = page.indexOf('<aside class="slide-notes"', slide);
  const end = page.indexOf('</aside>', aside);
  const at = page.indexOf(original);
  assert.ok(slide >= 0 && aside > slide && at > aside && at < end, 'the sentence is in the cover slide’s notes');
  assert.equal(Buffer.from(after['index.html']!).toString('utf8'), page.replace(original, edited));
});

describe('A3: an image without alt stops the build', () => {
  const IMAGE = 'assets/images/workshop.png';
  let piece = '';
  let manifest = '';

  /** The starter deck with a sixth slide: an image, the given alternative lines, a credit and a rights note. */
  function withImageSlide(lines: readonly string[]): {text: string; imageLine: number; line: (prefix: string) => number} {
    const slide = ['', '  - layout: image', '    title: The workshop.', '    image:', `      src: ${IMAGE}`, ...lines.map((line) => `      ${line}`), '      credit: Studio', '      rights: Own work', ''];
    const text = `${manifest.replace(/\n*$/, '\n')}${slide.join('\n')}`;
    const all = text.split('\n');
    const line = (prefix: string): number => {
      const index = all.findIndex((each, position) => position > all.indexOf('    image:') && each.startsWith(prefix));
      assert.ok(index >= 0, `${prefix} is in the manifest`);
      return index + 1;
    };
    const imageLine = all.indexOf('    image:') + 1;
    assert.equal(all[imageLine], `      src: ${IMAGE}`, 'the block the finding names is the one that names the image');
    return {text, imageLine, line};
  }

  async function findingsFor(text: string): Promise<{code: number; report: Report}> {
    writeFileSync(join(piece, 'papeleria.yaml'), text);
    const {code, report} = await check(piece);
    return {code, report};
  }

  before(async () => {
    piece = copyPiece(join(EXAMPLES, 'starter-deck'), 'a3');
    manifest = readFileSync(join(piece, 'papeleria.yaml'), 'utf8');
    mkdirSync(join(piece, 'assets', 'images', 'logos'), {recursive: true});
    await sharp({create: {width: 1200, height: 675, channels: 3, background: '#32bce9'}}).png().toFile(join(piece, IMAGE));
    await sharp({create: {width: 400, height: 100, channels: 3, background: '#1d1d1a'}}).png().toFile(join(piece, 'assets', 'images', 'logos', 'client.png'));
  });

  test('swapped in after a good build: exit 1, one R03 at the image block, and dist/ left as it was', async () => {
    const good = withImageSlide(['alt: A workbench with the week’s drafts']);
    writeFileSync(join(piece, 'papeleria.yaml'), good.text);
    const first = await build(piece);
    assert.equal(first.code, 0, first.stderr);
    const kept = readTree(join(piece, 'dist'));

    const swapped = withImageSlide([]);
    writeFileSync(join(piece, 'papeleria.yaml'), swapped.text);
    const failed = await build(piece);
    assert.equal(failed.code, 1);
    assert.match(
      failed.stderr,
      new RegExp(`^papeleria\\.yaml:${swapped.imageLine}:5 error R03: An image has neither alt text nor a decorative mark\\.$`, 'm'),
    );
    assert.match(failed.stderr, /Container location: the image on slide 6 starts here and has no alt\./);
    assert.match(failed.stderr, /was not built: nothing was written to dist\/ · 1 error · 0 warnings/);
    assert.match(failed.stderr, /dist still holds the last complete build, unchanged\./);
    assert.deepEqual(readTree(join(piece, 'dist')), kept, 'the last complete build is untouched');

    const {code, report} = await findingsFor(swapped.text);
    assert.equal(code, 1);
    assert.deepEqual(report.findings, [
      {
        file: 'papeleria.yaml',
        line: swapped.imageLine,
        column: 5,
        rule: 'R03',
        severity: 'error',
        message: 'An image has neither alt text nor a decorative mark.',
        fix: 'Add alt: describing the image, or decorative: true if it adds nothing a reader needs.',
        detail: 'Container location: the image on slide 6 starts here and has no alt.',
      },
    ]);
  });

  test('a blank alternative, spaces or invisible characters only, is one R03 at the value', async () => {
    for (const alt of [`alt: '   '`, 'alt: "\\u00A0\\u200B"']) {
      const variant = withImageSlide([alt]);
      const {code, report} = await findingsFor(variant.text);
      assert.equal(code, 1, alt);
      assert.deepEqual(
        report.findings.map((finding) => [finding.rule, finding.severity, finding.line, finding.column, finding.message]),
        [['R03', 'error', variant.line('      alt:'), 12, "The image's alt text is blank."]],
        alt,
      );
    }
  });

  test('alt beside decorative: true is one R03, never also an R09', async () => {
    const variant = withImageSlide(['alt: A workbench', 'decorative: true']);
    const {code, report} = await findingsFor(variant.text);
    assert.equal(code, 1);
    assert.deepEqual(
      report.findings.map((finding) => [finding.rule, finding.line, finding.column, finding.message, finding.fix]),
      [['R03', variant.imageLine, 5, 'An image has both alt text and a decorative mark.', 'Keep alt: if the image carries meaning, or keep decorative: true and remove alt:.']],
    );
  });

  test('decorative: true is accepted on an image and published with an empty alt; decorative: false is one R03', async () => {
    const decorative = withImageSlide(['decorative: true']);
    const accepted = await findingsFor(decorative.text);
    assert.equal(accepted.code, 0);
    assert.deepEqual(accepted.report.findings, []);
    const built = await build(piece);
    assert.equal(built.code, 0, built.stderr);
    const html = readFileSync(join(piece, 'dist', 'index.html'), 'utf8');
    const slide = html.slice(html.indexOf('id="slide-6"'));
    assert.match(slide.slice(0, slide.indexOf('</article>')), /<img [^>]*alt=""/);

    const refused = withImageSlide(['decorative: false']);
    const {code, report} = await findingsFor(refused.text);
    assert.equal(code, 1);
    assert.deepEqual(
      report.findings.map((finding) => [finding.rule, finding.line, finding.column, finding.message]),
      [['R03', refused.line('      decorative:'), 19, 'decorative accepts only true.']],
    );
  });

  test('decorative: true is refused where it is not allowed: a logo is one R03 at the logo', async () => {
    const good = withImageSlide(['alt: A workbench']);
    const text = good.text.replace(/^credits:/m, 'logo: {src: assets/images/logos/client.png, decorative: true}\ncredits:');
    const logoLine = text.split('\n').findIndex((line) => line.startsWith('logo:')) + 1;
    const {code, report} = await findingsFor(text);
    assert.equal(code, 1);
    assert.deepEqual(
      report.findings.map((finding) => [finding.rule, finding.line, finding.column, finding.message, finding.fix]),
      [['R03', logoLine, 1, 'A logo has no alt text.', 'Name whose logo it is in alt:. A logo cannot be marked decorative.']],
    );
  });
});

describe('npm run examples', () => {
  const SCRIPT = scriptPath('build-examples.mjs');

  function copyExamples(label: string): string {
    const target = join(temporaryFolder(label), 'examples');
    cpSync(EXAMPLES, target, {recursive: true, filter: (path) => !['dist', '.papeleria'].includes(basename(path))});
    return target;
  }

  /** The first test's copy, built once: the warning test reuses its warm image cache. */
  let builtCopy: string | undefined;

  test('checks and builds all four examples in place, the two decks, the report and the comic; none is pending', async () => {
    const examples = copyExamples('examples-script');
    builtCopy = examples;
    const result = await runNode(SCRIPT, ['--examples', examples]);
    assert.equal(result.code, 0, result.stderr);
    // The report joined at M3 (W3B, D99), the comic at M4 (W4, D119).
    assert.match(result.stdout, /^examples: starter-deck built; brand-overview built; hours-report built; sample-comic built$/m);
    // M5.5 (D139): every example is checked first, and none has a warning at 0.1.0.
    assert.match(
      result.stdout,
      /^checks: starter-deck 0 errors, 0 warnings; brand-overview 0 errors, 0 warnings; hours-report 0 errors, 0 warnings; sample-comic 0 errors, 0 warnings$/m,
    );
    assert.doesNotMatch(result.stdout, /^warning /m);
    assert.doesNotMatch(result.stdout, /is pending/);
    assert.equal(result.stderr.match(/· 0 errors · 0 warnings · first view /g)?.length, 4, 'each build’s report is passed through');
    assert.match(result.stderr, /sample-comic\/dist · 0 errors · 0 warnings · first view [\d,]+ bytes · largest phone image [\d,]+ of 307,200 bytes$/m);
    for (const name of ['starter-deck', 'brand-overview', 'hours-report', 'sample-comic']) {
      assert.ok(statSync(join(examples, name, 'dist', 'index.html')).isFile(), `${name} was built`);
    }
    assert.ok(readdirSync(join(examples, 'sample-comic', 'dist')).includes('reader.js'));
  });

  test('a broken example is exit 1 with its report; an unknown folder or a missing CLI is exit 2', async () => {
    const examples = copyExamples('examples-broken');
    const manifest = join(examples, 'brand-overview', 'papeleria.yaml');
    writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('layout: statement', 'layout: poster'));
    const broken = await runNode(SCRIPT, ['--examples', examples]);
    assert.equal(broken.code, 1);
    assert.match(broken.stderr, /papeleria\.yaml:\d+:\d+ error R09: /);
    assert.match(broken.stdout, /^examples: starter-deck built; brand-overview failed \(exit 1\); hours-report built; sample-comic built$/m);
    assert.match(broken.stdout, /^checks: starter-deck 0 errors, 0 warnings; brand-overview [1-9]\d* errors?, 0 warnings; hours-report 0 errors, 0 warnings; sample-comic 0 errors, 0 warnings$/m);

    mkdirSync(join(examples, 'stray-deck'));
    const unknown = await runNode(SCRIPT, ['--examples', examples]);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /examples\/stray-deck is neither built nor listed as pending/);

    const missing = await runNode(SCRIPT, ['--examples', examples, '--cli', join(examples, 'nowhere.js')]);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /is missing\. Run npm run build first; npm run examples does\./);
  });

  test('D139: a warning nobody has accepted is printed with its rule and place and fails the run, after every example has built', async () => {
    const examples = builtCopy ?? copyExamples('examples-warning');
    const manifest = join(examples, 'starter-deck', 'papeleria.yaml');
    // The starter deck is a draft, so an unfilled placeholder is R01's warning, not an error.
    writeFileSync(manifest, readFileSync(manifest, 'utf8').replaceAll('Craft with care. Build for the long view.', 'Craft with care for [Client name].'));
    const warned = await runNode(SCRIPT, ['--examples', examples]);
    assert.equal(warned.code, 1);
    const listed = warned.stdout.split('\n').filter((line) => line.startsWith('warning '));
    assert.deepEqual(listed, [
      'warning R01 papeleria.yaml:4:28: The placeholder [Client name] has not been filled in. (not reviewed: fix the example, or add the warning to ACCEPTED_WARNINGS in scripts/build-examples.mjs with the reason it is acceptable)',
      'warning R01 papeleria.yaml:14:32: The placeholder [Client name] has not been filled in. (not reviewed: fix the example, or add the warning to ACCEPTED_WARNINGS in scripts/build-examples.mjs with the reason it is acceptable)',
    ]);
    assert.match(warned.stdout, /^examples: starter-deck built; brand-overview built; hours-report built; sample-comic built$/m);
    assert.match(warned.stdout, /^checks: starter-deck 0 errors, 2 warnings; brand-overview 0 errors, 0 warnings;/m);
    assert.match(warned.stderr, /^build-examples: 2 warnings have not been reviewed; each is listed above$/m);
  });
});
