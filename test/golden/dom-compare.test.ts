/**
 * A4 (D70): the structural comparison and the allowlist, on made-up trees.
 * The browser suite runs the same module on the real documents; here each
 * kind of difference is shown to be found, and each way an allowlist entry
 * could hide too much is shown to fail.
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  applyAllowlist,
  compareDocuments,
  describeDifference,
  summarize,
  type Allowlist,
  type AllowlistContext,
  type AllowlistEntry,
  type DomNode,
  type ElementNode,
  type ExtractedDocument,
  type NotesRecord,
} from './dom-compare.js';

type Options = {id?: string; classes?: string[]; attributes?: Record<string, string>; children?: DomNode[]; notes?: NotesRecord};

function el(tag: string, options: Options = {}): ElementNode {
  return {
    tag,
    id: options.id ?? null,
    classes: options.classes ?? [],
    attributes: options.attributes ?? {},
    children: options.children ?? [],
    ...(options.notes === undefined ? {} : {notes: options.notes}),
  };
}

const t = (text: string): DomNode => ({text});

function doc(head: DomNode[], body: DomNode[]): ExtractedDocument {
  return {doctype: 'html||', root: el('html', {attributes: {lang: 'en'}, children: [el('head', {children: head}), el('body', {children: body})]})};
}

function notes(overrides: Partial<NotesRecord> = {}): NotesRecord {
  return {label: 'Speaker notes & source detail', boundary: '\n', form: 'lines', paragraphs: ['One.', 'Two.'], stray: [], ...overrides};
}

function slide(number: number, footer: DomNode[], aside: NotesRecord = notes(), titleAttributes: Record<string, string> = {}): ElementNode {
  return el('article', {
    id: `slide-${number}`,
    classes: ['deck-slide', 'slide-layout-two'],
    attributes: {'aria-labelledby': `title-${number}`},
    children: [
      el('h2', {id: `title-${number}`, classes: ['slide-title'], attributes: titleAttributes, children: [t('Title.'), el('br'), t('Second line.')]}),
      el('footer', {classes: ['slide-footer'], children: footer}),
      el('aside', {classes: ['slide-notes'], attributes: {'aria-label': 'Speaker notes'}, notes: aside}),
    ],
  });
}

const CONTEXT: AllowlistContext = {
  strings: {status_review: 'Review edition / approval pending', skip: 'Skip to content'},
  wordmark: 'papeleria',
  generator: 'Papeleria 0.0.0',
  sourceLines: new Map([[1, {start: 16, end: 21}], [2, {start: 23, end: 40}]]),
};

const SLIDE = 'html > body > article#slide-*.deck-slide.slide-layout-*';

test('identical documents have no difference', () => {
  const a = doc([el('title', {children: [t('A deck')]})], [slide(1, [el('span', {children: [t('01 / 02')]})])]);
  assert.deepEqual(compareDocuments(a, structuredClone(a)), []);
});

test('an element added between siblings is one extra element, not a cascade', () => {
  const reference = doc([], [slide(1, [el('span', {children: [t('Footer')]}), el('span', {children: [t('01 / 02')]})])]);
  const generated = doc([], [
    slide(1, [el('span', {children: [t('Footer')]}), el('span', {classes: ['slide-status'], children: [t('Review edition / approval pending')]}), el('span', {children: [t('01 / 02')]})]),
  ]);
  const differences = compareDocuments(reference, generated);
  assert.equal(differences.length, 1, differences.map(describeDifference).join('\n'));
  const [extra] = differences;
  assert.equal(extra?.kind, 'extra');
  assert.equal(extra?.path, 'html > body > article#slide-1.deck-slide.slide-layout-two > footer.slide-footer > span.slide-status');
  assert.equal(extra?.kind === 'extra' ? extra.element.markup : '', '<span class="slide-status">Review edition / approval pending</span>');
});

test('a missing element, an attribute, a text and a changed class are each found', () => {
  const reference = doc(
    [el('meta', {attributes: {charset: 'utf-8'}}), el('meta', {attributes: {name: 'robots', content: 'noindex,nofollow'}}), el('title', {children: [t('Brand overview')]})],
    [slide(1, [el('span', {children: [t('01 / 01')]})]), el('div', {classes: ['slide-columns', 'two']})],
  );
  const generated = doc(
    [el('meta', {attributes: {charset: 'utf-8'}}), el('title', {children: [t('Craft with care.')]})],
    [slide(1, [el('span', {children: [t('01 / 01')]})], notes(), {tabindex: '-1'}), el('div', {classes: ['slide-columns', 'three']})],
  );
  assert.deepEqual(compareDocuments(reference, generated).map(describeDifference), [
    'missing html > head > meta[name="robots"]: <meta content="noindex,nofollow" name="robots"></meta>',
    'text at html > head > title > #text: reference "Brand overview", generated "Craft with care."',
    'attribute tabindex at html > body > article#slide-1.deck-slide.slide-layout-two > h2#title-1.slide-title: reference absent, generated "-1"',
    'missing html > body > div.slide-columns.two: <div class="slide-columns two"></div>',
    'extra html > body > div.slide-columns.three: <div class="slide-columns three"></div>',
  ]);
});

test('notes compare their label, boundary, form, each paragraph exactly and anything stray', () => {
  const path = 'html > body > article#slide-1.deck-slide.slide-layout-two > aside.slide-notes';
  const reference = doc([], [slide(1, [], notes())]);
  const same = doc([], [slide(1, [], notes({boundary: ' ', form: 'paragraphs'}))]);
  assert.deepEqual(compareDocuments(reference, same).map((d) => [d.kind, d.path]), [
    ['notes-boundary', path],
    ['notes-form', path],
  ]);
  // One character in one paragraph, a paragraph too many, a changed label and markup inside a paragraph.
  const changed = doc([], [
    slide(1, [], notes({label: 'Speaker notes', paragraphs: ['One!', 'Two.', 'Three.'], stray: ['markup inside paragraph 2: <a>']})),
  ]);
  assert.deepEqual(compareDocuments(reference, changed).map(describeDifference), [
    `notes-label at ${path}: reference "Speaker notes & source detail", generated "Speaker notes"`,
    `notes paragraph 1 at ${path}: reference "One.", generated "One!"`,
    `notes paragraph 3 at ${path}: reference absent, generated "Three."`,
    `notes at ${path}, generated: markup inside paragraph 2: <a>`,
  ]);
});

// ---------------------------------------------------------------------------

function differencesFor(generatedFooter: DomNode[], titleAttributes: Record<string, string> = {}): ReturnType<typeof compareDocuments> {
  const reference = doc([], [slide(1, [el('span', {children: [t('01 / 02')]})]), slide(2, [el('span', {children: [t('02 / 02')]})])]);
  const generated = doc([], [
    slide(1, generatedFooter.length > 0 ? generatedFooter : [el('span', {children: [t('01 / 02')]})], notes(), titleAttributes),
    slide(2, [el('span', {children: [t('02 / 02')]})], notes(), titleAttributes),
  ]);
  return compareDocuments(reference, generated);
}

const STATUS_ENTRY: AllowlistEntry = {
  id: 'slide-status',
  kind: 'extra',
  path: `${SLIDE} > footer.slide-footer > span.slide-status`,
  text: {string: 'status_review'},
  attributes: {},
  count: 1,
  record: 'D61',
};

test('an entry covers exactly as many differences as it says; more or fewer fails', () => {
  const differences = differencesFor([el('span', {classes: ['slide-status'], children: [t('Review edition / approval pending')]}), el('span', {children: [t('01 / 02')]})]);
  const exact = applyAllowlist(differences, {entries: [STATUS_ENTRY]}, CONTEXT);
  assert.deepEqual(exact.unexpected, []);
  assert.deepEqual(exact.entries, [{id: 'slide-status', used: 1, expected: 1}]);

  const tooMany = applyAllowlist(differences, {entries: [{...STATUS_ENTRY, count: 2}]}, CONTEXT);
  assert.deepEqual(tooMany.entries, [{id: 'slide-status', used: 1, expected: 2}], 'an entry that covers less than it says is stale');
});

test('an entry never covers another text, an extra attribute, another place or another kind', () => {
  const wrongText = differencesFor([el('span', {classes: ['slide-status'], children: [t('Draft')]}), el('span', {children: [t('01 / 02')]})]);
  assert.equal(applyAllowlist(wrongText, {entries: [STATUS_ENTRY]}, CONTEXT).unexpected.length, 1);

  const extraAttribute = differencesFor([
    el('span', {classes: ['slide-status'], attributes: {hidden: ''}, children: [t('Review edition / approval pending')]}),
    el('span', {children: [t('01 / 02')]}),
  ]);
  assert.equal(applyAllowlist(extraAttribute, {entries: [STATUS_ENTRY]}, CONTEXT).unexpected.length, 1);

  const elsewhere = applyAllowlist(differencesFor([]), {entries: [STATUS_ENTRY]}, CONTEXT);
  assert.deepEqual(elsewhere.entries, [{id: 'slide-status', used: 0, expected: 1}]);

  const tabindex = differencesFor([], {tabindex: '-1'});
  const wrongKind = applyAllowlist(tabindex, {entries: [{...STATUS_ENTRY, count: 2}]}, CONTEXT);
  assert.equal(wrongKind.unexpected.length, 2, 'an extra-element entry does not cover an attribute');

  const bare: AllowlistEntry = {id: 'any-span', kind: 'extra', path: `${SLIDE} > footer.slide-footer > span.slide-status`, count: 1, record: 'none'};
  const statusDifferences = differencesFor([el('span', {classes: ['slide-status'], children: [t('Review edition / approval pending')]}), el('span', {children: [t('01 / 02')]})]);
  assert.equal(applyAllowlist(statusDifferences, {entries: [bare]}, CONTEXT).unexpected.length, 1, 'an element entry must say what the element is');
});

test('an entry without markup never covers an element with markup inside, even with the same text; its whole markup can', () => {
  const path = 'html > body > article#slide-1.deck-slide.slide-layout-two > footer.slide-footer > span.slide-status';
  const inside = (tag: string): DomNode[] => [
    el('span', {classes: ['slide-status'], children: [el(tag, {children: [t('Review edition / approval pending')]})]}),
    el('span', {children: [t('01 / 02')]}),
  ];
  const wrapped = differencesFor(inside('em'));
  const byText = applyAllowlist(wrapped, {entries: [STATUS_ENTRY]}, CONTEXT);
  assert.deepEqual(byText.unexpected.map(describeDifference), [`extra ${path}: <span class="slide-status"><em>Review edition / approval pending</em></span>`]);
  assert.deepEqual(byText.entries, [{id: 'slide-status', used: 0, expected: 1}]);

  const byMarkup: AllowlistEntry = {
    id: 'slide-status',
    kind: 'extra',
    path: STATUS_ENTRY.path,
    markup: '<span class="slide-status"><em>Review edition / approval pending</em></span>',
    count: 1,
    record: 'D61',
  };
  assert.deepEqual(applyAllowlist(wrapped, {entries: [byMarkup]}, CONTEXT).unexpected, []);
  assert.equal(applyAllowlist(differencesFor(inside('strong')), {entries: [byMarkup]}, CONTEXT).unexpected.length, 1, 'other markup inside is not that markup');

  assert.equal(summarize(el('span', {children: [t('Review edition / approval pending')]})).leaf, true, 'text alone');
  assert.equal(summarize(el('meta', {attributes: {name: 'generator', content: 'Papeleria 0.0.0'}})).leaf, true, 'nothing');
  assert.equal(summarize(el('aside', {classes: ['slide-notes'], notes: notes()})).leaf, false, 'a notes aside holds its label and lines');
});

test('attribute entries: literals, rewrites of the reference, source lines; two entries for one difference are ambiguous', () => {
  const tabindex = differencesFor([], {tabindex: '-1'});
  const entry: AllowlistEntry = {id: 'title-tabindex', kind: 'attribute', path: `${SLIDE} > h2#title-*.slide-title`, name: 'tabindex', reference: null, generated: '-1', count: 2, record: 'CONTRACT §7'};
  assert.deepEqual(applyAllowlist(tabindex, {entries: [entry]}, CONTEXT).entries, [{id: 'title-tabindex', used: 2, expected: 2}]);
  assert.equal(applyAllowlist(tabindex, {entries: [{...entry, generated: '0'}]}, CONTEXT).unexpected.length, 2);
  const twice = applyAllowlist(tabindex, {entries: [entry, {...entry, id: 'again'}]}, CONTEXT);
  assert.equal(twice.ambiguous.length, 2);

  const link = (href: string): ElementNode => el('link', {attributes: {rel: 'stylesheet', href}});
  const reference: ExtractedDocument = {doctype: 'html||', root: el('html', {children: [el('head', {children: [link('../../theme/css/site.css')]})]})};
  const rewritten: ExtractedDocument = {doctype: 'html||', root: el('html', {children: [el('head', {children: [link('theme/css/site.css')]})]})};
  const elsewhereFile: ExtractedDocument = {doctype: 'html||', root: el('html', {children: [el('head', {children: [link('other/css/site.css')]})]})};
  const paths: AllowlistEntry = {id: 'local-paths', kind: 'attribute', path: 'html > head > link*', name: 'href', reference: '../../theme/css/site.css', generated: {from: '../../theme/', to: 'theme/'}, count: 1, record: 'CONTRACT §7'};
  const general: AllowlistEntry = {...paths, reference: undefined};
  assert.deepEqual(applyAllowlist(compareDocuments(reference, rewritten), {entries: [general]}, CONTEXT).unexpected, []);
  assert.equal(applyAllowlist(compareDocuments(reference, elsewhereFile), {entries: [general]}, CONTEXT).unexpected.length, 1);

  const lines = (start: string, end: string): ExtractedDocument => ({
    doctype: 'html||',
    root: el('html', {children: [el('body', {children: [el('article', {id: 'slide-2', classes: ['deck-slide', 'slide-layout-two'], attributes: {'data-source-line-start': start, 'data-source-line-end': end}})]})]}),
  });
  const bareSlide: ExtractedDocument = {doctype: 'html||', root: el('html', {children: [el('body', {children: [el('article', {id: 'slide-2', classes: ['deck-slide', 'slide-layout-two']})]})]})};
  const sourceLines: AllowlistEntry = {
    id: 'source-lines',
    kind: 'attribute',
    path: 'html > body > article#slide-*.deck-slide.slide-layout-*',
    name: ['data-source-line-start', 'data-source-line-end'],
    reference: null,
    generated: {sourceLine: true},
    count: 2,
    record: 'IC06',
  };
  assert.deepEqual(applyAllowlist(compareDocuments(bareSlide, lines('23', '40')), {entries: [sourceLines]}, CONTEXT).unexpected, []);
  assert.equal(applyAllowlist(compareDocuments(bareSlide, lines('23', '41')), {entries: [sourceLines]}, CONTEXT).unexpected.length, 1, 'the end must be the slide’s own');
});

test('a conditional entry covers nothing while the wordmark is the reference’s, and must be used once it differs', () => {
  const register = (wordmark: string): ExtractedDocument => ({doctype: 'html||', root: el('html', {children: [el('span', {classes: ['wordmark'], children: [t(wordmark)]})]})});
  const entry: AllowlistEntry = {id: 'configured-wordmark', kind: 'text', path: 'html > span.wordmark > #text', reference: 'papeleria', generated: {wordmark: true}, count: 1, when: 'configured-wordmark-differs', record: 'D04, D05'};
  const same = applyAllowlist(compareDocuments(register('papeleria'), register('papeleria')), {entries: [entry]}, CONTEXT);
  assert.deepEqual(same.entries, [{id: 'configured-wordmark', used: 0, expected: 0}]);
  const owner = {...CONTEXT, wordmark: 'studio'};
  const differs = applyAllowlist(compareDocuments(register('papeleria'), register('studio')), {entries: [entry]}, owner);
  assert.deepEqual([differs.unexpected, differs.entries], [[], [{id: 'configured-wordmark', used: 1, expected: 1}]]);
  const other = applyAllowlist(compareDocuments(register('papeleria'), register('elsewhere')), {entries: [entry]}, owner);
  assert.equal(other.unexpected.length, 1, 'only the configured wordmark is allowed');
});

test('nothing stray inside the notes can be allowed', () => {
  const reference = doc([], [slide(1, [], notes())]);
  const generated = doc([], [slide(1, [], notes({stray: ['text between paragraphs 1 and 2: "\\n"']}))]);
  const differences = compareDocuments(reference, generated);
  const allowlist: Allowlist = {
    entries: [{id: 'try', kind: 'notes-stray', path: `${SLIDE} > aside.slide-notes`, reference: null, generated: null, count: 1, record: 'none'}],
  };
  assert.equal(applyAllowlist(differences, allowlist, CONTEXT).unexpected.length, 1);
});
