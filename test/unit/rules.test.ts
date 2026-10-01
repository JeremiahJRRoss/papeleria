/**
 * M1.7: the rule modules (D66). The source rules run through the real
 * pipeline as `check` on a temporary copy of each fixture under
 * `test/fixtures/rules/`, so discovery, the core and the settling are the
 * build's own. The output rules are given a generation built by hand.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {after, test} from 'node:test';

import {createNodeLoaders, loadManifest, resolvePiece, validateManifest, type Finding, type Piece, type TracedFinding, type ValidatedManifest} from '../../src/core/index.js';
import {measureFirstView} from '../../src/build/budget.js';
import {runPipeline} from '../../src/build/pipeline.js';
import {OutputError} from '../../src/build/write.js';
import {loadRules} from '../../src/checks/load-rules.js';
import {InventoryError} from '../../src/checks/owner-inventory.js';
import {placeholdersInMarkdown} from '../../src/checks/placeholders.js';
import type {GeneratedOutput, OutputRuleContext} from '../../src/checks/rule.js';
import {rule as R02} from '../../src/checks/rules/R02.js';
import {rule as R07} from '../../src/checks/rules/R07.js';
import {rule as R08} from '../../src/checks/rules/R08.js';
import {rule as R12} from '../../src/checks/rules/R12.js';
import {applicationRoot, fixturePath} from '../helpers/paths.js';
import {copyPiece, removeTemporaryFolders, temporaryFolder} from '../helpers/pieces.js';

after(removeTemporaryFolders);

async function check(fixture: string, edit?: (manifest: string) => string): Promise<Finding[]> {
  const root = copyPiece(fixturePath('rules', fixture), `rules-${fixture}`);
  if (edit !== undefined) {
    const file = join(root, 'papeleria.yaml');
    writeFileSync(file, edit(readFileSync(file, 'utf8')));
  }
  const {report} = await runPipeline({root, label: fixture}, {kind: 'check'});
  return [...report.findings];
}

/** The 1-based line and column of the `nth` copy of `needle` in a fixture file: the oracle for "where it is written". */
function where(fixture: string, file: string, needle: string, nth = 0): {line: number; column: number} {
  const lines = readFileSync(fixturePath('rules', fixture, file), 'utf8').split('\n');
  let seen = 0;
  for (const [index, line] of lines.entries()) {
    for (let at = line.indexOf(needle); at !== -1; at = line.indexOf(needle, at + 1)) {
      if (seen === nth) {
        return {line: index + 1, column: at + 1};
      }
      seen += 1;
    }
  }
  throw new Error(`${needle} is not in ${file}`);
}

const located = (finding: Finding) => `${finding.file}:${finding.line ?? '-'}:${finding.column ?? '-'} ${finding.message}`;

test('the rule modules are found by file name, in id order, and each is the rule it is named for', async () => {
  const rules = await loadRules();
  assert.deepEqual(
    rules.map((rule) => `${rule.id}:${rule.phase}`),
    ['R01:source', 'R02:source', 'R03:source', 'R05:source', 'R06:source', 'R07:output', 'R08:output', 'R09:source', 'R12:output', 'R13:source', 'R14:source', 'R15:source', 'R16:source', 'R17:source'],
  );
  assert.equal(await loadRules(), rules, 'loaded once');
});

test('a pass-through rule hands on the core’s findings for its rule and nothing else, piece or not', () => {
  const core: TracedFinding[] = ['R02', 'R03', 'R09', 'R02'].map((id, index) => ({
    finding: {file: 'papeleria.yaml', line: index + 1, column: 1, rule: id, severity: 'error', message: id, fix: 'x', detail: null},
    sourcePath: `papeleria.yaml#/${index}`,
  }));
  const found = R02.check({piece: null, manifest: null, coreFindings: core, charts: new Map()});
  assert.deepEqual(found, [core[0], core[3]]);
});

test('R02: each file the manifest names and the folder lacks is one error at the token that names it, with its fix', async () => {
  const findings = await check('missing');
  const at = (needle: string) => {
    const {line, column} = where('missing', 'papeleria.yaml', needle);
    return `papeleria.yaml:${line}:${column}`;
  };
  const checkPath = 'Check the path and the file name, including upper and lower case; paths start with assets/.';
  assert.deepEqual(
    findings.map((finding) => [finding.rule, finding.severity, `${finding.file}:${finding.line}:${finding.column}`, finding.message, finding.fix, finding.detail]),
    [
      ['R02', 'error', at('assets/text/missing.md'), 'The Markdown file "assets/text/missing.md" is missing.', checkPath, null],
      ['R02', 'error', at('assets/images/absent.png'), 'The image "assets/images/absent.png" is missing.', checkPath, 'Nothing exists at assets/images.'],
      ['R02', 'error', at('assets/data/absent.csv'), 'The CSV file "assets/data/absent.csv" is missing.', checkPath, 'Nothing exists at assets/data.'],
      ['R02', 'error', at('assets/text/folder.md'), 'The Markdown file "assets/text/folder.md" is a folder, not a file.', 'Point the manifest at the file inside the folder.', null],
    ],
  );
});

test('R01 draft: every placeholder is a warning where it is written; code, links, footnotes, escapes, entities, numbers and data are not', async () => {
  const findings = await check('placeholders');
  assert.ok(findings.every((finding) => finding.rule === 'R01' && finding.severity === 'warning'), findings.map(located).join('\n'));
  const at = (file: string, needle: string, nth = 0) => {
    const {line, column} = where('placeholders', file, needle, nth);
    return `${file}:${line}:${column} The placeholder ${needle} has not been filled in.`;
  };
  const manifest = 'papeleria.yaml';
  const notes = 'assets/text/notes.md';
  const eighty = `[${'b'.repeat(80)}]`;
  // IC01's 80 characters are code points (the label pattern is a Unicode one): U+20000 is two UTF-16 units and one character.
  const astralEighty = `[${'\u{20000}'.repeat(80)}]`;
  assert.deepEqual(findings.map(located), [
    at(notes, '[Speaker name]'),
    `${notes}:${where('placeholders', notes, 'A [label with').line}:- The placeholder [label with emphasis inside] has not been filled in.`,
    at(notes, '[名前]'),
    at(notes, '[Имя]'),
    at(notes, eighty),
    at(notes, astralEighty),
    at(notes, '[Footnote placeholder]'),
    at(manifest, '[Deck title]'),
    at(manifest, '[Client]'),
    at(manifest, '[Author name]'),
    at(manifest, '[Nombre del cliente]'),
    at(manifest, '[Heading]'),
    at(manifest, '[Ärger]'),
    at(manifest, '[Twice]', 0),
    at(manifest, '[Twice]', 1),
    at(manifest, '[Phase label]'),
    at(manifest, '[Describe the image]'),
    at(manifest, '[Caption]'),
    at(manifest, '[Photographer]'),
    at(manifest, '[Licence]'),
    at(manifest, '[Colour name]'),
    at(manifest, '[purpose]'),
    // Footnote syntax is left out only where footnotes are rendered: block text (D150).
    at(manifest, '[^draft]'),
    at(manifest, '[^lead note]'),
    at(manifest, '[^footer note]'),
  ]);
  // Eighty-one characters make no placeholder, in a text file, a lead and a plain string alike: the fixture holds
  // each such label, and the list above holds every finding, none of them longer than eighty.
  const sources = new Map([notes, manifest].map((file) => [file, readFileSync(fixturePath('rules', 'placeholders', file), 'utf8')]));
  for (const [file, letter] of [[notes, 'a'], [notes, '\u{20000}'], [manifest, 'c'], [manifest, 'd']] as const) {
    assert.ok(sources.get(file)!.includes(`[${letter.repeat(81)}]`), `${file} holds eighty-one of ${letter}`);
  }
  assert.ok(findings.every((finding) => [.../\[(.*)\]/u.exec(finding.message)![1]!].length <= 80));
  const unplaced = findings.find((finding) => finding.column === null);
  assert.equal(unplaced?.detail, 'This becomes an error when the status is published.');
  assert.equal(unplaced?.relatedLocation, undefined, 'its line is known, so it needs no other location');
});

test('R01 published: the same placeholders are errors', async () => {
  const draft = await check('placeholders');
  const published = await check('placeholders', (text) => text.replace('status: draft', 'status: published'));
  assert.equal(published.length, draft.length);
  assert.ok(published.every((finding) => finding.rule === 'R01' && finding.severity === 'error'));
  assert.equal(published[0]?.detail, 'A published piece cannot keep a placeholder.');
  assert.deepEqual(published.map(located), draft.map(located));
});

test('R01 escapes: a backslash keeps brackets literal in Markdown and in plain strings alike', async () => {
  const findings = await check('placeholders', (text) =>
    text
      .replace("'[Client] / Draft'", "'\\[Client] / Draft'")
      .replace("'Inline text with [Ärger], [1] and [^note]'", "'Inline text with \\[Ärger\\], [1] and [^note]'"),
  );
  const messages = findings.map((finding) => finding.message);
  assert.ok(!messages.some((message) => message.includes('[Client]')), 'plain string');
  assert.ok(!messages.some((message) => message.includes('[Ärger]')), 'Markdown');
  assert.equal(findings.length, 23);
});

test('R01: a literal backslash before a bracket hides nothing in Markdown, however it is written', async () => {
  const findings = await check('placeholders', (text) =>
    text
      .replace("title: '[Deck title] for the client'", "title: 'Proposal for \\\\[Client name]'")
      .replace('title: Welcome, [Nombre del cliente]', 'title: Welcome, &#92;[Your name]'),
  );
  const at = (needle: string) => findings.find((finding) => finding.message.includes(needle));
  const titleLine = readFileSync(fixturePath('rules', 'placeholders', 'papeleria.yaml'), 'utf8').split('\n').findIndex((line) => line.startsWith('title: ')) + 1;
  assert.deepEqual([at('[Client name]')?.line, at('[Client name]')?.column], [titleLine, 'title: \'Proposal for \\\\['.length]);
  assert.ok(at('[Your name]'), 'a backslash written as an entity');
  assert.match(at('[Client name]')?.fix ?? '', /write them as \\\[ and \\\]\.$/);
});

test('R01: a plain-text field’s fix does not promise that a backslash hides the brackets', async () => {
  const findings = await check('placeholders');
  const register = findings.find((finding) => finding.message.includes('[Client]'));
  assert.match(register?.fix ?? '', /This field is plain text, not Markdown: a backslash before a bracket keeps it but is printed too/);
  const markdown = findings.find((finding) => finding.message.includes('[Deck title]'));
  assert.match(markdown?.fix ?? '', /To keep the brackets, write them as/);
});

test('R01: each placeholder is placed at its own copy, counting copies in link text and code, or at its line alone', () => {
  const place = (source: string) => placeholdersInMarkdown(source, false).map((found) => [found.text, found.line, found.column]);
  assert.deepEqual(place('[[Name]](https://example.com) and [Name]'), [['[Name]', 1, 35]]);
  assert.deepEqual(place('`[Name]` then [Name]'), [['[Name]', 1, 15]]);
  assert.deepEqual(place('| [A] | [A] |\n|---|---|\n| [B] | x |'), [
    ['[A]', 1, 3],
    ['[A]', 1, 9],
    ['[B]', 3, 3],
  ]);
  assert.deepEqual(place('[x](https://example.com/[Name]) and [Name]'), [['[Name]', 1, null]], 'a copy in a link destination: the line, and no column that could be wrong');
  assert.deepEqual(place('One\n\n[*Name*] here'), [['[Name]', 3, null]], 'a formatted label is not written as found');
  assert.deepEqual(placeholdersInMarkdown('Signed by [Your name\\\\]', true).map((found) => found.text), ['[Your name\\]']);
});

test('R01: footnote syntax is left out in block text, where footnotes render, and is a placeholder in a title or lead, where it is text', () => {
  const texts = (source: string, inlineOnly: boolean) => placeholdersInMarkdown(source, inlineOnly).map((found) => found.text);
  assert.deepEqual(texts('Results [^draft]', true), ['[^draft]']);
  assert.deepEqual(texts('Results [^draft]', false), [], 'an undefined reference in block text is still footnote syntax');
  assert.deepEqual(texts('Results [^draft]\n\n[^draft]: A note.', false), []);
  assert.deepEqual(texts('Results [^1]', true), [], 'a label with no letter is never one');
});

test('R06: missing credit and missing rights are separate warnings at the image, and a logo is never reported', async () => {
  const findings = await check('credits');
  const image = (title: string) => {
    const line = where('credits', 'papeleria.yaml', `title: ${title}`).line + 1;
    return {line, column: 5};
  };
  assert.deepEqual(
    findings.map((finding) => [finding.rule, finding.severity, finding.line, finding.column, finding.message]),
    [
      ['R06', 'warning', image('Neither').line, 5, 'The image assets/images/mark.svg has no credit.'],
      ['R06', 'warning', image('Neither').line, 5, 'The image assets/images/mark.svg has no rights note.'],
      ['R06', 'warning', image('Credit only').line, 5, 'The image assets/images/mark.svg has no rights note.'],
      ['R06', 'warning', image('Rights only, decorative').line, 5, 'The image assets/images/mark.svg has no credit.'],
    ],
  );
  assert.equal(findings[0]?.detail, 'Container location: this image starts here and has no credit.');
  assert.match(findings[0]?.fix ?? '', /^Add credit: /);
  assert.match(findings[1]?.fix ?? '', /^Add rights: /);
});

test('R13: CSV records at their lines, manifest fields at their values, a header-only table a warning and chart an error, a file once', async () => {
  const findings = await check('data');
  const manifest = (needle: string) => where('data', 'papeleria.yaml', needle);
  const dataField = (title: string) => {
    const line = where('data', 'papeleria.yaml', `title: ${title}`).line + 1;
    const text = readFileSync(fixturePath('rules', 'data', 'papeleria.yaml'), 'utf8').split('\n')[line - 1]!;
    return {file: 'papeleria.yaml', line, column: text.indexOf('assets/data/') + 1};
  };
  const simplified = findings.map((finding) => ({
    at: `${finding.file}:${finding.line ?? '-'}:${finding.column ?? '-'}`,
    severity: finding.severity,
    related: finding.relatedLocation === undefined ? null : `${finding.relatedLocation.file}:${finding.relatedLocation.line ?? '-'}:${finding.relatedLocation.column ?? '-'}`,
    fix: finding.fix,
  }));
  const loc = (location: {file: string; line: number; column: number}) => `${location.file}:${location.line}:${location.column}`;
  const hoursField = manifest('Hours, label');
  const xField = manifest('x: Phase');
  const columnName = 'Use a column name exactly as the header writes it; names are case-sensitive.';
  assert.deepEqual(simplified, [
    {at: 'assets/data/dates.csv:3:-', severity: 'error', related: loc(dataField('A date not in the calendar')), fix: 'Write every x value of a line chart as a number, or every one as a date in the form YYYY-MM-DD.'},
    {at: 'assets/data/gaps.csv:3:-', severity: 'error', related: loc(dataField('A blank y cell')), fix: 'Fill in the cell, or remove the row. Charts never treat a blank as zero.'},
    {at: 'assets/data/header-only.csv:1:-', severity: 'warning', related: loc(dataField('A header-only table')), fix: 'Add rows below the header, or remove the table.'},
    {at: 'assets/data/header-only.csv:1:-', severity: 'error', related: loc(dataField('A header-only chart')), fix: 'Add at least one row of data below the header.'},
    {at: 'assets/data/uneven.csv:2:-', severity: 'error', related: loc(dataField('Uneven rows')), fix: 'Give every row exactly as many cells as the header. Quote a cell that contains a comma.'},
    {at: `papeleria.yaml:${hoursField.line}:${hoursField.column}`, severity: 'error', related: 'assets/data/hours.csv:1:-', fix: columnName},
    {at: `papeleria.yaml:${xField.line}:${xField.column + 3}`, severity: 'error', related: null, fix: columnName},
  ]);
  assert.ok(findings.every((finding) => finding.rule === 'R13'));
  // IC03: a date column holds valid calendar dates; one that is not is reported on its own record.
  assert.equal(findings[0]?.message, 'The x value "2026-02-29" in column day is not a YYYY-MM-DD date like the other x values.');
  assert.match(findings[5]?.message ?? '', /names the column "Hours", which assets\/data\/hours.csv does not have\. Its headers are "phase", "hours"\./);
});

test('each finding the core makes is listed once, although the pass-through rules hand it on again', async () => {
  const findings = await check('core-findings');
  assert.deepEqual(
    findings.map((finding) => finding.rule),
    ['R09', 'R15', 'R05', 'R03'],
  );
  const again = await check('core-findings');
  assert.deepEqual(again, findings, 'the same report every time');
});

// ---------------------------------------------------------------------------
// Output rules, over a generation made by hand

async function resolved(fixture: string): Promise<{piece: Piece; manifest: ValidatedManifest}> {
  const loaders = createNodeLoaders(fixturePath('rules', fixture));
  const loaded = await loadManifest(loaders);
  const validated = validateManifest(loaded.manifest!);
  const result = await resolvePiece(validated.manifest!, {loaders});
  return {piece: result.piece!, manifest: validated.manifest!};
}

function outputContext(base: {piece: Piece; manifest: ValidatedManifest}, output: Partial<GeneratedOutput>): OutputRuleContext {
  const weight = measureFirstView({files: [{path: 'index.html', bytes: 100}], images: [], budgetBytes: 1_048_576});
  return {
    ...base,
    coreFindings: [],
    charts: new Map(),
    output: {
      directory: temporaryFolder('output'),
      label: 'dist',
      files: [],
      html: '',
      script: 'deck.js',
      weight,
      firstViewSource: null,
      toolRoot: applicationRoot,
      sourceImages: new Map(),
      ...output,
    },
  };
}

test('R07: over the budget is one error at the page, naming the largest files, with the first view’s source', async () => {
  const base = await resolved('credits');
  const within = measureFirstView({files: [{path: 'index.html', bytes: 1_048_576}], images: [], budgetBytes: 1_048_576});
  assert.deepEqual(await R07.check(outputContext(base, {weight: within})), []);
  const over = measureFirstView({
    files: [
      {path: 'index.html', bytes: 48_577},
      {path: 'assets/images/big.1600.webp', bytes: 1_000_000},
    ],
    images: [],
    budgetBytes: 1_048_576,
  });
  const findings = await R07.check(outputContext(base, {weight: over, firstViewSource: {file: 'papeleria.yaml', line: 9, column: null}}));
  assert.equal(findings.length, 1);
  const finding = findings[0]!.finding;
  assert.deepEqual([finding.file, finding.line, finding.column, finding.severity], ['dist/index.html', null, null, 'error']);
  assert.equal(finding.message, 'The first view loads 1,048,577 bytes, 1 over the budget of 1,048,576. Largest files: assets/images/big.1600.webp 1,000,000; index.html 48,577.');
  assert.equal(
    finding.fix,
    'Use smaller or fewer images in the first view (a deck’s first slide and its logo), or move large images later. Stylesheets, the script and all eight font files always count.',
  );
  assert.deepEqual(finding.relatedLocation, {file: 'papeleria.yaml', line: 9, column: null});
  assert.match(finding.detail ?? '', /at 390×844 with AVIF where written/);
});

const PAGE = [
  '<!DOCTYPE html>',
  '<html lang="en">',
  '<head>',
  '<meta charset="utf-8">',
  '<title>Test</title>',
  '<link rel="stylesheet" href="theme/css/site.css">',
  '<script src="deck.js" defer></script>',
  '</head>',
  '<body>',
  '<main>',
  '<article id="slide-1" data-source-line-start="12" data-source-line-end="15"><h1>One</h1></article>',
  '<article id="slide-2" data-source-line-start="17" data-source-line-end="20"><h2>Two</h2><p><img src="https://example.com/a.png" alt=""></p></article>',
  '</main>',
  '</body>',
  '</html>',
  '',
].join('\n');

test('R08: each message is an error at the generated line and column, related to the source line of its slide', async () => {
  const base = await resolved('credits');
  const directory = temporaryFolder('r08');
  mkdirSync(join(directory, 'theme', 'css'), {recursive: true});
  writeFileSync(join(directory, 'theme', 'css', 'site.css'), '@import url(other.css);\nbody { background: url(https://example.com/x.png); }\n');
  const files = [
    {path: 'deck.js', bytes: 1},
    {path: 'index.html', bytes: 1},
    {path: 'theme/css/site.css', bytes: 1},
  ];
  const findings = (await R08.check(outputContext(base, {directory, files, html: PAGE}))).map((item) => item.finding);
  const page = findings.filter((finding) => finding.file === 'dist/index.html');
  assert.equal(page.length, 1, page.map(located).join('\n'));
  assert.deepEqual([page[0]!.line, page[0]!.severity, page[0]!.relatedLocation], [12, 'error', {file: 'papeleria.yaml', line: 17, column: null}]);
  assert.match(page[0]!.message, /^The generated index\.html breaks papeleria\/resources: The img src "https:\/\/example\.com\/a\.png" names a scheme/);
  const sheet = findings.filter((finding) => finding.file === 'dist/theme/css/site.css');
  assert.deepEqual(sheet.map((finding) => [finding.line, finding.column]), [
    [1, 1],
    [1, 9],
    [2, 20],
  ]);
  assert.equal(sheet[0]!.relatedLocation, undefined);
  // Author text is always escaped, so what the page and its stylesheets break is the template's to fix.
  for (const finding of findings) {
    assert.equal(
      finding.fix,
      'Author text is always escaped, so this is most likely a Papeleria template defect: report it with this piece. The related location is the source of the part of the page it is in.',
    );
  }
});

test('R08 / D172: a relative link inside the output leads to a file there or a part of the page, and is named where it is written; one leaving it is not checked', async () => {
  const findings = await check('links');
  const lead = '[the notes](assets/text/notes.md), [a gone part](#nowhere) and [the next piece](../other-piece/)';
  const field = {file: 'papeleria.yaml', ...where('links', 'papeleria.yaml', `'${lead}'`)};
  const notes = 'assets/text/notes.md';
  const fileFix =
    'Link to a part of this page with #, to a full https address, or to a file the output holds. Text and data files are rendered into the page, not published as files, and raster images are published resized, under new names.';
  assert.deepEqual(
    findings.map((finding) => [finding.rule, finding.severity, finding.file, finding.message, finding.fix, finding.detail, finding.relatedLocation]),
    [
      ['R08', 'error', 'dist/index.html', 'The link "assets/text/notes.md" names a file the output does not have.', fileFix, 'In the Markdown of the related field, line 1, column 1.', field],
      [
        'R08',
        'error',
        'dist/index.html',
        'The link "#nowhere" names nothing on the page.',
        'Use the id of a part of this page, such as a slide’s #slide-2, a comic page’s #page-2 or the anchor a document section’s heading links to, or remove the #.',
        `In the Markdown of the related field, line 1, column ${lead.indexOf('[a gone part]') + 1}.`,
        field,
      ],
      ['R08', 'error', 'dist/index.html', 'The link "assets/data/hours.csv" names a file the output does not have.', fileFix, null, {file: notes, ...where('links', notes, '[the table]')}],
      [
        'R08',
        'error',
        'dist/index.html',
        'The link "./" names a folder, not a file.',
        'Name a file, such as index.html, not a folder: opened from disk, a folder shows a list of its files. For the top of this page, use #.',
        null,
        {file: notes, ...where('links', notes, '[the folder]')},
      ],
    ],
  );
  assert.ok(findings.every((finding) => Number.isInteger(finding.line) && Number.isInteger(finding.column)), 'each at its generated line and column');
});

test('R12: an inventoried copy is reported at the source image or the generated file, once; public files pass', async () => {
  const base = await resolved('credits');
  const toolRoot = temporaryFolder('tool');
  const directory = temporaryFolder('generation');
  const owner = readFileSync(fixturePath('rules', 'credits', 'assets', 'images', 'mark.svg'));
  const ownerHash = createHash('sha256').update(owner).digest('hex');
  const favicon = readFileSync(join(applicationRoot, 'theme', 'marks', 'papeleria-favicon.svg'));
  mkdirSync(join(directory, 'assets', 'images'), {recursive: true});
  mkdirSync(join(directory, 'theme', 'marks'), {recursive: true});
  writeFileSync(join(directory, 'assets', 'images', 'mark.svg'), owner);
  writeFileSync(join(directory, 'theme', 'marks', 'copied.svg'), owner);
  writeFileSync(join(directory, 'theme', 'marks', 'papeleria-favicon.svg'), favicon);
  const sourceImages = new Map([
    ['assets/images/mark.svg', [ownerHash, 'f'.repeat(64)]],
    ['assets/images/logos/client.svg', ['0'.repeat(64)]],
  ]);
  const context = outputContext(base, {directory, toolRoot, sourceImages});

  assert.deepEqual(await R12.check(context), [], 'an absent inventory: no owner assets are supplied');
  mkdirSync(join(toolRoot, 'brand'));
  writeFileSync(join(toolRoot, 'brand', 'owner-assets.sha256'), `# owner marks\n${ownerHash}  brand/marks/owner.svg\n`);
  const findings = (await R12.check(context)).map((item) => item.finding);
  assert.deepEqual(
    findings.map((finding) => [finding.file, finding.line, finding.message]),
    [
      ['assets/images/mark.svg', null, 'The image assets/images/mark.svg is a copy of the owner asset brand/marks/owner.svg.'],
      ['dist/theme/marks/copied.svg', null, 'The generated theme/marks/copied.svg is a copy of the owner asset brand/marks/owner.svg.'],
    ],
  );
  for (const finding of findings) {
    assert.equal(finding.fix, 'Remove the copy. Owner-exclusive assets stay under the tool’s brand/ folder; public theme files, the favicon and a client’s own logo are allowed (D05).');
  }
  const related = findings[0]!.relatedLocation;
  assert.equal(related?.file, 'papeleria.yaml');
  assert.equal(related?.line, where('credits', 'papeleria.yaml', 'image: {src: assets/images/mark.svg').line);
  assert.equal(findings[1]!.relatedLocation, undefined);

  writeFileSync(join(toolRoot, 'brand', 'owner-assets.sha256'), 'not a hash line\n');
  await assert.rejects(R12.check(context), InventoryError, 'a malformed inventory is the installation’s failure');
});

test('W5R-11: R12 unable to read the generation back is the output’s failure, E_OUTPUT_IO, never the tool’s', async () => {
  const base = await resolved('credits');
  const toolRoot = temporaryFolder('tool-read');
  mkdirSync(join(toolRoot, 'brand'));
  writeFileSync(join(toolRoot, 'brand', 'owner-assets.sha256'), `${'a'.repeat(64)}  brand/marks/owner.svg\n`);
  const directory = join(temporaryFolder('generation-gone'), 'gone');
  await assert.rejects(R12.check(outputContext(base, {directory, toolRoot})), (error: unknown) => {
    assert.ok(error instanceof OutputError && error.code === 'E_OUTPUT_IO', String(error));
    assert.match(error.message, /^The generated output could not be read back for R12: cannot read .*\. Nothing was written to dist\/;/);
    return true;
  });
});
