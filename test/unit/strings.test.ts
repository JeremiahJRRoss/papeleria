/**
 * M0.5 / C20 / A12: the EN and ES control strings match UX section 12 and each
 * other. The negative cases are produced by mutating the real files by exactly
 * one thing, so each fixture fails for one stated reason and nothing else.
 */
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, test} from 'node:test';

import {applicationRoot, runCheckScript} from '../helpers/paths.js';

const sharedDirectory = join(applicationRoot, 'templates', 'shared');
const temporaryRoots: string[] = [];
after(() => {
  for (const directory of temporaryRoots) {
    rmSync(directory, {recursive: true, force: true});
  }
});

type Strings = Record<string, string>;

function load(language: 'en' | 'es'): Strings {
  return JSON.parse(readFileSync(join(sharedDirectory, `strings.${language}.json`), 'utf8')) as Strings;
}

/** Writes both files into a temporary directory after applying one mutation. */
function mutatedDirectory(label: string, mutate: (en: Strings, es: Strings) => void): string {
  const directory = mkdtempSync(join(tmpdir(), `papeleria-strings-${label}-`));
  temporaryRoots.push(directory);
  mkdirSync(directory, {recursive: true});
  const en = load('en');
  const es = load('es');
  mutate(en, es);
  writeFileSync(join(directory, 'strings.en.json'), JSON.stringify(en, null, 2));
  writeFileSync(join(directory, 'strings.es.json'), JSON.stringify(es, null, 2));
  return directory;
}

const REQUIRED_KEYS = [
  'skip', 'previous', 'next', 'slide_of', 'all_shown', 'all_shown_one', 'show_all', 'show_one',
  'show_notes', 'hide_notes', 'notes_label', 'notes_heading', 'fullscreen', 'fullscreen_denied', 'print',
  'page_of', 'pages_of', 'panel_of', 'guided_view', 'page_view', 'detail',
  'close', 'transcript', 'panels_hint', 'panels_hint_one', 'no_js', 'no_js_slides', 'format_comics',
  'status_draft', 'status_review', 'status_published', 'status_withheld',
  'note_label', 'warning_label', 'doc_type_default', 'empty_cell', 'external_link',
];

test('both files carry exactly the 37 UX section 12 keys, in table order', () => {
  assert.equal(REQUIRED_KEYS.length, 37);
  assert.deepEqual(Object.keys(load('en')), REQUIRED_KEYS);
  assert.deepEqual(Object.keys(load('es')), REQUIRED_KEYS);
});

test('the English copy is verbatim from UX section 12', () => {
  const en = load('en');
  assert.equal(en['slide_of'], 'Slide {n} of {total}: {title}');
  assert.equal(en['pages_of'], 'Pages {a}–{b} of {total}');
  assert.equal(en['panel_of'], 'Panel {n} of {total} on page {page}');
  assert.equal(en['panels_hint'], '{n} panels · explore transcripts and available details');
  assert.equal(en['status_draft'], 'Draft · not issued');
  assert.equal(en['status_review'], 'Review edition / approval pending');
  assert.equal(en['print'], 'Print / Save PDF');
  assert.equal(en['fullscreen_denied'], 'Full-screen mode was not permitted.');
  assert.equal(en['doc_type_default'], 'Document');
  assert.equal(en['empty_cell'], 'No value');
  assert.equal(en['external_link'], 'External link');
  assert.equal(en['format_comics'], 'Web Comics');
  assert.equal(en['notes_label'], 'Speaker notes');
  assert.equal(en['notes_heading'], 'Speaker notes & source detail');
  // D130: the singular forms, for a count of exactly one; D131: the deck's own no-JS status (UX §05).
  assert.equal(en['all_shown'], 'All {total} slides shown.');
  assert.equal(en['all_shown_one'], '{total} slide shown.');
  assert.equal(en['panels_hint_one'], '{n} panel · explore its transcript and any available detail');
  assert.equal(en['no_js'], 'All pages are available without JavaScript.');
  assert.equal(en['no_js_slides'], 'All slides are available without JavaScript.');
});

test('the Spanish copy is the working text from UX section 12', () => {
  const es = load('es');
  assert.equal(es['slide_of'], 'Diapositiva {n} de {total}: {title}');
  assert.equal(es['pages_of'], 'Páginas {a}–{b} de {total}');
  assert.equal(es['panel_of'], 'Viñeta {n} de {total} en la página {page}');
  assert.equal(es['format_comics'], 'Web Cómics');
  assert.equal(es['doc_type_default'], 'Documento');
  assert.equal(es['empty_cell'], 'Sin valor');
  assert.equal(es['external_link'], 'Enlace externo');
  assert.equal(es['notes_label'], 'Notas del orador');
  assert.equal(es['notes_heading'], 'Notas del orador y detalle de fuentes');
  assert.equal(es['all_shown'], 'Se muestran las {total} diapositivas.');
  assert.equal(es['all_shown_one'], 'Se muestra {total} diapositiva.');
  assert.equal(es['panels_hint'], '{n} viñetas · explora las transcripciones y los detalles disponibles');
  assert.equal(es['panels_hint_one'], '{n} viñeta · explora su transcripción y cualquier detalle disponible');
  assert.equal(es['no_js'], 'Todas las páginas están disponibles sin JavaScript.');
  assert.equal(es['no_js_slides'], 'Todas las diapositivas están disponibles sin JavaScript.');
});

test('the shipped files pass and the check says native review is still pending', async () => {
  const result = await runCheckScript('check-strings.mjs', ['--dir', sharedDirectory]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /result: pass — 37 keys/);
  assert.match(result.stdout, /native Spanish review .* is still pending \(A12, M5\.4\): docs\/user\/spanish-review-record\.md/);
});

test('a key missing from one language fails', async () => {
  const directory = mutatedDirectory('missing-key', (_en, es) => {
    delete es['close'];
  });
  const result = await runCheckScript('check-strings.mjs', ['--dir', directory]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /strings\.es\.json: the required key "close" is missing/);
});

test('a key missing from both languages still fails', async () => {
  const directory = mutatedDirectory('missing-both', (en, es) => {
    delete en['empty_cell'];
    delete es['empty_cell'];
  });
  const result = await runCheckScript('check-strings.mjs', ['--dir', directory]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /strings\.en\.json: the required key "empty_cell" is missing/);
  assert.match(result.stdout, /strings\.es\.json: the required key "empty_cell" is missing/);
});

test('a differing placeholder set fails', async () => {
  const directory = mutatedDirectory('extra-placeholder', (_en, es) => {
    es['page_of'] = 'Página {n} de {total} ({page})';
  });
  const result = await runCheckScript('check-strings.mjs', ['--dir', directory]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /page_of: placeholder sets differ/);
});

test('a dropped placeholder fails even when no new one appears', async () => {
  const directory = mutatedDirectory('dropped-placeholder', (_en, es) => {
    es['slide_of'] = 'Diapositiva {n} de {total}';
  });
  const result = await runCheckScript('check-strings.mjs', ['--dir', directory]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /slide_of: placeholder sets differ/);
});

test('an empty or whitespace-only value fails', async () => {
  const directory = mutatedDirectory('empty-value', (_en, es) => {
    es['detail'] = '   ';
  });
  const result = await runCheckScript('check-strings.mjs', ['--dir', directory]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /strings\.es\.json: "detail" is empty or whitespace only/);
});

test('an unknown key and an unknown placeholder both fail', async () => {
  const directory = mutatedDirectory('unknown', (en, es) => {
    en['made_up'] = 'Not in UX section 12';
    es['made_up'] = 'No está en la sección 12';
    en['page_of'] = 'Page {n} of {grand_total}';
    es['page_of'] = 'Página {n} de {grand_total}';
  });
  const result = await runCheckScript('check-strings.mjs', ['--dir', directory]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /"made_up" is not one of the 37 keys/);
  assert.match(result.stdout, /unknown placeholder \{grand_total\}/);
});

test('a missing language file is a usage failure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'papeleria-strings-absent-'));
  temporaryRoots.push(directory);
  const result = await runCheckScript('check-strings.mjs', ['--dir', directory]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /strings\.en\.json is missing/);
});
