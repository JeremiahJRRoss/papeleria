/**
 * M5.4 part 1, A12, C20 (W5C, D133): the EN/ES rendering matrix.
 *
 * Each template (deck, comic, document) is built in each language at each of
 * the four statuses from `test/fixtures/localization/`, and every control
 * string the page carries is asserted in the element UX places it in, from
 * the strings file of the piece's language: the controls, the statuses in
 * each template's register or footers, the no-JavaScript line, the skip link,
 * the notes aside, the comic's format label, page headings, panel hints and
 * transcript headings, the document's type, note and warning labels, and the
 * empty-cell and external-link text a screen reader hears. `draft`, `review`
 * and `published` are read from `dist/`. A `withheld` build writes no `dist/`
 * (IC05, C21), so its page is read from the private preview generation the
 * pipeline keeps for it, which is shown here to be the published page.
 *
 * A Spanish page holds no English control string and an English page no
 * Spanish one: each value's fixed words, split at its placeholders, are
 * searched for as whole words (so "Document" is not found inside "Documento")
 * in the page's text and in the attributes a person reads or hears, once the
 * fixtures are shown to hold no control-string value of either language
 * themselves. The strings the clients write in the browser are formatted here
 * by the clients' own functions from the same files, and
 * test/browser/localization.test.ts shows them on the page in three engines.
 */
import assert from 'node:assert/strict';
import {existsSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {join, relative} from 'node:path';
import {after, describe, test} from 'node:test';

import {Parser, StaticConfigLoader, type HtmlElement} from 'html-validate';
import {parse as parseYaml} from 'yaml';

import {runPipeline} from '../../src/build/pipeline.js';
import {formatString} from '../../src/core/index.js';
import {allShownLine, formatString as deckFormat, readDeckStrings} from '../../templates/deck/client/deck-logic.js';
import {hintLine, readReaderStrings, statusLine, formatString as readerFormat} from '../../templates/comic/client/reader-logic.js';
import {controlStringsIn, LANGUAGES, OTHER, STRINGS, wholeWord, type Language, type Strings} from '../fixtures/localization/control-strings.js';
import {applicationRoot, fixturePath} from '../helpers/paths.js';
import {copyPiece, removeTemporaryFolders} from '../helpers/pieces.js';

after(removeTemporaryFolders);

type Template = 'deck' | 'comic' | 'document';
type Status = 'draft' | 'review' | 'published' | 'withheld';

const TEMPLATES: readonly Template[] = ['deck', 'comic', 'document'];
const STATUSES: readonly Status[] = ['draft', 'review', 'published', 'withheld'];

/** The fixture folders, each holding `en/` and `es/`. */
const FIXTURES = ['deck', 'deck-one', 'comic', 'document'] as const;

/** Author text the override cases write: no control string in either language. */
const OVERRIDES: Readonly<Record<Language, {readonly format: string; readonly docType: string}>> = {
  en: {format: 'Graphic serial', docType: 'Quarterly memo'},
  es: {format: 'Serie gráfica', docType: 'Memoria trimestral'},
};

// ---------------------------------------------------------------------------
// Reading a page

/** Decodes the character references the renderers write (`escapeHtml`, the chart's isolates). */
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_entity, name: string) => {
    switch (name) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        return String.fromCodePoint(name.startsWith('#x') ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10));
    }
  });
}

let parser: Promise<Parser> | undefined;

/** The page as html-validate's parser reads it, which the output rules (R08) read too. */
async function parsePage(html: string): Promise<HtmlElement> {
  parser ??= Promise.resolve(new StaticConfigLoader({extends: []}).getConfigFor('index.html')).then((config) => new Parser(config));
  return (await parser).parseHtml(html);
}

function textsOf(page: HtmlElement, selector: string): string[] {
  return page.querySelectorAll(selector).map((element) => decode(element.textContent).trim());
}

function attributesOf(page: HtmlElement, selector: string, name: string): (string | null)[] {
  return page.querySelectorAll(selector).map((element) => {
    const value = element.getAttributeValue(name);
    return value === null ? null : decode(value);
  });
}

/** The attributes a browser shows or speaks. */
const READ_ATTRIBUTES = new Set(['alt', 'aria-label', 'aria-description', 'aria-roledescription', 'aria-valuetext', 'placeholder', 'title']);

/**
 * What a person reads or hears on the page: its text, the SVG text of its
 * charts included, and the attributes above. The strings block is left out,
 * since it is compared whole with its file; so are styles, which hold no text.
 */
function readable(html: string): string {
  const body = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, ' ');
  const attributes = Array.from(body.matchAll(/\s([a-z-]+)="([^"]*)"/g))
    .filter((match) => READ_ATTRIBUTES.has(match[1]!))
    .map((match) => match[2]!);
  return decode([body.replace(/<[^>]*>/g, ' '), ...attributes].join('\n'));
}

// ---------------------------------------------------------------------------
// Building the fixtures

function manifestOf(root: string): string {
  return join(root, 'papeleria.yaml');
}

/** Writes `status` over the fixture's `status: draft`, and whatever else the case needs. */
function prepare(root: string, status: Status, edit?: (manifest: string) => string): void {
  const text = readFileSync(manifestOf(root), 'utf8');
  assert.equal(text.match(/^status: draft$/gm)?.length, 1, 'the fixture says status: draft once');
  const changed = text.replace(/^status: draft$/m, `status: ${status}`);
  writeFileSync(manifestOf(root), edit === undefined ? changed : edit(changed));
}

type Built = {readonly html: string; readonly from: 'dist' | 'preview'; readonly root: string};

/**
 * Builds a copy of a fixture at a status. A withheld piece writes no `dist/`,
 * so its page is read from the preview generation it still gets (IC05).
 */
async function build(template: Template, language: Language, status: Status, edit?: (manifest: string) => string): Promise<Built> {
  const root = copyPiece(fixturePath('localization', template, language), `l10n-${template}-${language}-${status}`);
  prepare(root, status, edit);
  if (status === 'withheld') {
    const {report, preview} = await runPipeline({root, label: 'piece'}, {kind: 'preview'});
    assert.deepEqual([report.status, report.errors, report.warnings, report.outputReason], ['ok', 0, 0, 'preview_only'], JSON.stringify(report.findings));
    assert.ok(preview !== null, 'a withheld piece still gets its private preview');
    assert.equal(existsSync(join(root, 'dist')), false, 'and no dist/');
    return {html: readFileSync(join(preview.directory, 'index.html'), 'utf8'), from: 'preview', root};
  }
  const {report} = await runPipeline({root, label: 'piece'}, {kind: 'dist'});
  assert.deepEqual([report.status, report.errors, report.warnings, report.outputWritten, report.outputReason], ['ok', 0, 0, true, 'written'], JSON.stringify(report.findings));
  return {html: readFileSync(join(root, 'dist', 'index.html'), 'utf8'), from: 'dist', root};
}

// ---------------------------------------------------------------------------
// What each template must say, and where

type Seen = Set<string>;

function expectTexts(page: HtmlElement, selector: string, expected: readonly string[], what: string): void {
  assert.deepEqual(textsOf(page, selector), expected, what);
}

function repeat(value: string, count: number): string[] {
  return Array.from({length: count}, () => value);
}

/** What every page carries: its language, its generator and the skip link (IC07, UX §11). */
function checkCommon(page: HtmlElement, strings: Strings, language: Language, seen: Seen): void {
  assert.deepEqual(attributesOf(page, 'html', 'lang'), [language], 'lang is the manifest language');
  assert.match(page.querySelector('meta[name="generator"]')?.getAttributeValue('content') ?? '', /^Papeleria \d+\.\d+\.\d+/, 'the generator (IC07)');
  expectTexts(page, 'a.skip-link', [strings['skip']!], 'skip');
  seen.add('skip');
}

/** The strings block is the whole strings file of the piece's language (CONTRACT §4 of either client). */
function checkStringsBlock(page: HtmlElement, language: Language, seen: Seen): void {
  const blocks = page.querySelectorAll('script#papeleria-strings');
  assert.equal(blocks.length, 1, 'one strings block');
  assert.equal(blocks[0]!.getAttributeValue('type'), 'application/json');
  assert.deepEqual(JSON.parse(blocks[0]!.textContent), STRINGS[language], 'the strings block is the language’s strings file');
  seen.add('(strings block)');
}

function externalLinkHint(strings: Strings): string {
  return `(${strings['external_link']!})`;
}

function checkDeck(page: HtmlElement, strings: Strings, language: Language, status: Status, seen: Seen): void {
  checkCommon(page, strings, language, seen);
  for (const [id, key] of [
    ['prev-slide', 'previous'],
    ['next-slide', 'next'],
    ['all-slides', 'show_all'],
    ['toggle-notes', 'show_notes'],
    ['full-deck', 'fullscreen'],
    ['print-deck', 'print'],
  ] as const) {
    expectTexts(page, `button#${id}`, [strings[key]!], key);
    seen.add(key);
  }
  expectTexts(page, 'p#deck-status', [strings['no_js_slides']!], 'the no-JavaScript status is no_js_slides (D131)');
  seen.add('no_js_slides');
  expectTexts(page, 'footer.slide-footer span.slide-status', repeat(strings[`status_${status}`]!, 4), 'the status in every slide footer (D61)');
  seen.add(`status_${status}`);
  assert.deepEqual(attributesOf(page, 'aside.slide-notes', 'aria-label'), repeat(strings['notes_label']!, 2), 'notes_label names each notes aside (D161)');
  expectTexts(page, 'aside.slide-notes > strong', repeat(strings['notes_heading']!, 2), 'notes_heading begins each notes aside (D161)');
  seen.add('notes_label').add('notes_heading');
  expectTexts(page, 'a.link-external span.sr-only', [externalLinkHint(strings)], 'the external link’s spoken hint');
  seen.add('external_link');
  expectTexts(page, 'td span.sr-only', [strings['empty_cell']!], 'a blank cell is announced');
  seen.add('empty_cell');
  checkStringsBlock(page, language, seen);
}

function checkComic(page: HtmlElement, strings: Strings, language: Language, status: Status, seen: Seen, format: string | null): void {
  checkCommon(page, strings, language, seen);
  expectTexts(page, 'header.comic-register span.comic-format', [format ?? strings['format_comics']!], 'the format label');
  if (format === null) {
    seen.add('format_comics');
  }
  expectTexts(page, 'header.comic-register span.comic-status-label', [strings[`status_${status}`]!], 'the status in the register');
  seen.add(`status_${status}`);
  for (const [id, key] of [
    ['comic-previous', 'previous'],
    ['comic-next', 'next'],
    ['comic-guided', 'guided_view'],
    ['comic-detail', 'detail'],
    ['comic-transcript-toggle', 'transcript'],
    ['comic-fullscreen', 'fullscreen'],
  ] as const) {
    expectTexts(page, `button#${id}`, [strings[key]!], key);
    seen.add(key);
  }
  assert.equal(page.querySelector('button#comic-detail')?.hasAttribute('hidden'), true, 'Detail waits, hidden, for guided view');
  expectTexts(page, 'p#comic-status', [strings['no_js']!], 'the no-JavaScript status');
  seen.add('no_js');
  expectTexts(
    page,
    'article.comic-sheet > h2.comic-sheet-title',
    [1, 2, 3, 4].map((n) => formatString(strings['page_of']!, {n, total: 4})),
    'page_of heads each sheet',
  );
  seen.add('page_of');
  expectTexts(page, 'button.comic-panel span.comic-panel-hint', repeat(strings['detail']!, 4), 'detail hints each panel that opens one');
  expectTexts(page, 'h3.comic-transcript-title', repeat(strings['transcript']!, 3), 'transcript heads each page’s list');
  expectTexts(page, 'a.comic-panel span.sr-only', [externalLinkHint(strings)], 'the external link panel’s spoken hint');
  expectTexts(page, 'p.comic-detail-link span.sr-only', [externalLinkHint(strings)], 'the link detail’s spoken hint');
  expectTexts(page, 'div.comic-detail-text span.sr-only', [externalLinkHint(strings)], 'an external link inside a text detail');
  seen.add('external_link');
  checkStringsBlock(page, language, seen);
}

/** D41: the charts' number and date forms, which the native review confirms or replaces. */
const CHART_FORMS: Readonly<Record<Language, readonly string[]>> = {
  en: ['2,400', '1,850', 'Jul 6, 2026', 'Jul 13', 'Jul 27'],
  es: ['2.400', '1.850', '6 jul 2026', '13 jul', '27 jul'],
};

function checkDocument(page: HtmlElement, html: string, strings: Strings, language: Language, status: Status, from: Built['from'], seen: Seen, docType: string | null): void {
  checkCommon(page, strings, language, seen);
  expectTexts(page, 'header.doc-top span.doc-type', repeat(docType ?? strings['doc_type_default']!, 2), 'the document type on each sheet');
  if (docType === null) {
    seen.add('doc_type_default');
  }
  const label = strings[`status_${status}`]!;
  expectTexts(page, 'span.draft-label', [label], 'the status opens the first sheet');
  expectTexts(page, 'footer.template-footer span.doc-status', repeat(label, 2), 'and closes each sheet');
  seen.add(`status_${status}`);
  expectTexts(page, 'div.note strong.note-label', [strings['note_label']!, strings['warning_label']!], 'note, then warning');
  assert.deepEqual(
    page.querySelectorAll('div.note').map((note) => note.classList.contains('warning')),
    [false, true],
  );
  seen.add('note_label').add('warning_label');
  expectTexts(page, 'td span.sr-only', [strings['empty_cell']!], 'a blank cell is announced');
  seen.add('empty_cell');
  expectTexts(page, 'a.link-external span.sr-only', [externalLinkHint(strings)], 'the external link’s spoken hint');
  seen.add('external_link');
  // A document runs no script (C22); its private preview adds only the bridge (D79).
  assert.deepEqual(
    page.querySelectorAll('script').map((script) => script.getAttributeValue('src')),
    from === 'preview' ? ['preview.js'] : [],
  );
  for (const form of CHART_FORMS[language]) {
    assert.ok(html.includes(`>${form}</text>`), `the chart reads ${JSON.stringify(form)} (D41)`);
  }
  for (const form of CHART_FORMS[OTHER[language]].filter((text) => /\p{L}|[.,]/u.test(text))) {
    assert.ok(!html.includes(`>${form}</text>`), `the chart does not read ${JSON.stringify(form)}`);
  }
  seen.add('(chart forms)');
}

// ---------------------------------------------------------------------------
// The fixtures themselves

/** Every string value of a parsed manifest that a page shows: not the four fixed fields, a file path or a link target. */
function authorValues(value: unknown, key = ''): string[] {
  if (typeof value === 'string') {
    if (['schema', 'template', 'language', 'status'].includes(key) || /^assets\//.test(value) || key === 'href') {
      return [];
    }
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => authorValues(item, key));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([name, item]) => authorValues(item, name));
  }
  return [];
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe('the fixtures (D133)', () => {
  test('both strings files hold the same 37 keys, and no value is the same in both languages', () => {
    assert.deepEqual(Object.keys(STRINGS.en), Object.keys(STRINGS.es));
    assert.equal(Object.keys(STRINGS.en).length, 37);
    for (const key of Object.keys(STRINGS.en)) {
      assert.notEqual(STRINGS.en[key], STRINGS.es[key], `${key} reads the same in both languages, so a leak of it could not be seen`);
    }
  });

  for (const fixture of FIXTURES) {
    for (const language of LANGUAGES) {
      test(`${fixture}/${language}: its author text holds no control string of either language, and it leaves the defaults to render`, () => {
        const root = fixturePath('localization', fixture, language);
        const manifest = parseYaml(readFileSync(manifestOf(root), 'utf8')) as Record<string, unknown>;
        assert.equal(manifest['language'], language);
        assert.equal(manifest['status'], 'draft');
        assert.equal('format' in manifest, false, 'no format: format_comics renders');
        assert.equal('doc_type' in manifest, false, 'no doc_type: doc_type_default renders');
        const texts = authorValues(manifest);
        const assets = join(root, 'assets');
        for (const file of existsSync(assets) ? filesUnder(assets).filter((path) => /\.(md|csv)$/.test(path)) : []) {
          texts.push(readFileSync(file, 'utf8'));
        }
        assert.ok(texts.length >= 3, 'the author text was found');
        for (const checked of LANGUAGES) {
          assert.deepEqual(
            texts.flatMap((text) => controlStringsIn(text, checked).map((found) => `${found} in ${JSON.stringify(text)}`)),
            [],
            `${relative(applicationRoot, root)} holds ${checked} control strings`,
          );
        }
      });
    }
  }

  test('the overrides are no control string either', () => {
    for (const language of LANGUAGES) {
      for (const text of Object.values(OVERRIDES[language])) {
        assert.deepEqual([...controlStringsIn(text, 'en'), ...controlStringsIn(text, 'es')], [], text);
      }
    }
  });

  test('the search finds a whole word and not the same letters inside another word', () => {
    assert.deepEqual(controlStringsIn('Documento Siguiente', 'en'), [], '"Document" is inside "Documento"; nothing else is English');
    assert.deepEqual(controlStringsIn('Un Document suelto', 'en'), ['doc_type_default: "Document"']);
    assert.deepEqual(controlStringsIn('Page 3 of 4', 'en'), ['page_of: "Page"'], '"Pages" is not in "Page"');
    assert.deepEqual(controlStringsIn('Viñeta 2 de 5 en la página 1', 'es'), ['panel_of: "Viñeta"', 'panel_of: "en la página"']);
    assert.ok(readable('<p title="Siguiente">x</p><svg><text>Nota</text></svg><script type="application/json">{"next":"Next"}</script>').includes('Siguiente'));
    assert.deepEqual(controlStringsIn(readable('<script type="application/json">{"n":"Next"}</script><p>Hola</p>'), 'en'), [], 'the strings block is compared whole, not searched');
  });
});

// ---------------------------------------------------------------------------
// The matrix

type Row = {readonly template: Template; readonly language: Language; readonly status: Status; readonly from: Built['from']; readonly keys: number};
const rows: Row[] = [];

async function checkPage(template: Template, built: Built, language: Language, status: Status, overrides: {format?: string; docType?: string} = {}): Promise<Seen> {
  const strings = STRINGS[language];
  const page = await parsePage(built.html);
  const seen: Seen = new Set();
  switch (template) {
    case 'deck':
      checkDeck(page, strings, language, status, seen);
      break;
    case 'comic':
      checkComic(page, strings, language, status, seen, overrides.format ?? null);
      break;
    case 'document':
      checkDocument(page, built.html, strings, language, status, built.from, seen, overrides.docType ?? null);
      break;
  }
  assert.deepEqual(controlStringsIn(readable(built.html), OTHER[language]), [], `the ${language} page holds ${OTHER[language]} control strings`);
  return seen;
}

describe('the rendering matrix: 3 templates × 2 languages × 4 statuses (A12)', () => {
  for (const template of TEMPLATES) {
    for (const language of LANGUAGES) {
      for (const status of STATUSES) {
        test(`${template}, ${language}, ${status}`, async () => {
          const built = await build(template, language, status);
          const seen = await checkPage(template, built, language, status);
          rows.push({template, language, status, from: built.from, keys: seen.size});
        });
      }
    }
  }

  for (const template of TEMPLATES) {
    for (const language of LANGUAGES) {
      test(`${template}, ${language}: the preview a withheld piece gets is the page a build publishes${template === 'document' ? ', with the bridge alone added' : ''}`, async () => {
        const built = await build(template, language, 'review');
        const {report, preview} = await runPipeline({root: built.root, label: 'piece'}, {kind: 'preview'});
        assert.equal(report.status, 'ok');
        assert.ok(preview !== null);
        const previewed = readFileSync(join(preview.directory, 'index.html'), 'utf8');
        const bridge = '<script src="preview.js" defer></script></head>';
        assert.equal(template === 'document' ? previewed.replace(bridge, '</head>') : previewed, built.html);
      });
    }
  }
});

describe('the author’s own labels win over the defaults', () => {
  for (const language of LANGUAGES) {
    test(`comic, ${language}: an explicit format replaces format_comics`, async () => {
      const {format} = OVERRIDES[language];
      const built = await build('comic', language, 'draft', (manifest) => manifest.replace(/^pages:$/m, `format: ${format}\npages:`));
      const seen = await checkPage('comic', built, language, 'draft', {format});
      assert.equal(seen.has('format_comics'), false);
      assert.equal(wholeWord(STRINGS[language]['format_comics']!).test(readable(built.html)), false, 'the default is nowhere on the page');
    });

    test(`document, ${language}: an explicit doc_type replaces doc_type_default`, async () => {
      const {docType} = OVERRIDES[language];
      const built = await build('document', language, 'draft', (manifest) => manifest.replace(/^metadata:$/m, `doc_type: ${docType}\nmetadata:`));
      const seen = await checkPage('document', built, language, 'draft', {docType});
      assert.equal(seen.has('doc_type_default'), false);
      assert.equal(wholeWord(STRINGS[language]['doc_type_default']!).test(readable(built.html)), false, 'the default is nowhere on the page');
    });
  }
});

describe('what the clients write in the browser, formatted by their own functions from each language’s file', () => {
  for (const language of LANGUAGES) {
    const strings = STRINGS[language];

    test(`deck, ${language}: slide_of, and all_shown or all_shown_one by count (D130)`, () => {
      const deck = readDeckStrings(JSON.stringify(strings));
      assert.ok(deck !== null, 'the deck client starts with this language’s strings block');
      const lines = [
        deckFormat(deck.slide_of, {n: 2, total: 4, title: 'x'}),
        allShownLine(deck, 1),
        allShownLine(deck, 4),
        deck.fullscreen_denied,
      ];
      assert.deepEqual(lines.slice(1, 3), [formatString(strings['all_shown_one']!, {total: 1}), formatString(strings['all_shown']!, {total: 4})]);
      for (const line of lines) {
        assert.doesNotMatch(line, /[{}]/, line);
        assert.deepEqual(controlStringsIn(line, OTHER[language]), [], line);
      }
    });

    test(`comic, ${language}: page_of, pages_of, panel_of, and panels_hint or panels_hint_one by count (D130)`, () => {
      const reader = readReaderStrings(JSON.stringify(strings));
      assert.ok(reader !== null, 'the reader starts with this language’s strings block');
      const lines = [
        statusLine(reader, {kind: 'page', visible: [1], total: 4}),
        statusLine(reader, {kind: 'page', visible: [2, 3], total: 4}),
        statusLine(reader, {kind: 'guided', page: 1, panel: 2, panels: 5, total: 4}),
        statusLine(reader, {kind: 'guided', page: 3, panel: null, panels: 0, total: 4}),
        readerFormat(reader.panel_of, {n: 2, total: 5, page: 1}),
        hintLine(reader, 1),
        hintLine(reader, 5),
        reader.close,
        reader.page_view,
        reader.fullscreen_denied,
      ];
      assert.deepEqual(lines.slice(0, 4), [
        formatString(strings['page_of']!, {n: 1, total: 4}),
        formatString(strings['pages_of']!, {a: 2, b: 3, total: 4}),
        formatString(strings['panel_of']!, {n: 2, total: 5, page: 1}),
        formatString(strings['page_of']!, {n: 3, total: 4}),
      ]);
      assert.deepEqual(lines.slice(5, 7), [formatString(strings['panels_hint_one']!, {n: 1}), formatString(strings['panels_hint']!, {n: 5})]);
      assert.equal(hintLine(reader, 0), '', 'a page without panels has no hint');
      for (const line of lines) {
        assert.doesNotMatch(line, /[{}]/, line);
        assert.deepEqual(controlStringsIn(line, OTHER[language]), [], line);
      }
    });
  }
});

test('the matrix, as run', (context) => {
  assert.equal(rows.length, TEMPLATES.length * LANGUAGES.length * STATUSES.length, 'every cell of the matrix ran');
  for (const row of rows) {
    context.diagnostic(`matrix ${row.template} ${row.language} ${row.status}: page from ${row.from}, ${row.keys} string checks, no ${OTHER[row.language]} control string`);
  }
});
