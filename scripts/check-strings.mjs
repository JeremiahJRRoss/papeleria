#!/usr/bin/env node
/**
 * C20 / A12: EN and ES output control strings agree.
 *
 * Asserts that both files carry exactly the keys enumerated in
 * docs/papeleria-ux-draft-0-2.md section 12 and in the ERD's UI_STRING row, that
 * each key uses the same placeholder set in both languages, that no value is
 * empty or whitespace only, and that no unknown placeholder appears.
 *
 * Checking the key set against the specification, not only EN against ES,
 * catches a key dropped from both files, which parity alone cannot see.
 * Whether the Spanish reads naturally is a native review: M5.4 keeps its
 * record, docs/user/spanish-review-record.md, and a person fills it (A12).
 *
 * Usage: node scripts/check-strings.mjs [--dir <dir>]
 * Exit:  0 pass · 1 a parity or content failure · 2 usage or IO
 */
import {existsSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

class UsageError extends Error {}

/** UX section 12, in table order. This list is the specification, not a copy of the data. */
export const REQUIRED_KEYS = [
  'skip', 'previous', 'next', 'slide_of', 'all_shown', 'all_shown_one', 'show_all', 'show_one',
  'show_notes', 'hide_notes', 'notes_label', 'notes_heading', 'fullscreen', 'fullscreen_denied', 'print',
  'page_of', 'pages_of', 'panel_of', 'guided_view', 'page_view', 'detail',
  'close', 'transcript', 'panels_hint', 'panels_hint_one', 'no_js', 'no_js_slides', 'format_comics',
  'status_draft', 'status_review', 'status_published', 'status_withheld',
  'note_label', 'warning_label', 'doc_type_default', 'empty_cell', 'external_link',
];

/** The placeholders UX section 12 uses. Anything else is a typo, not a feature. */
export const KNOWN_PLACEHOLDERS = new Set(['n', 'total', 'title', 'a', 'b', 'page']);

export const LANGUAGES = ['en', 'es'];

const PLACEHOLDER = /\{([^{}]*)\}/g;

export function placeholdersOf(value) {
  return new Set(Array.from(value.matchAll(PLACEHOLDER), (match) => match[1]));
}

function loadLanguage(directory, language) {
  const file = join(directory, `strings.${language}.json`);
  if (!existsSync(file)) {
    throw new UsageError(`${file} is missing`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (cause) {
    throw new UsageError(`cannot parse ${file}: ${cause.message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UsageError(`${file} must be a JSON object of key to string`);
  }
  return {file, strings: parsed};
}

export function checkStrings(directory) {
  const loaded = Object.fromEntries(
    LANGUAGES.map((language) => [language, loadLanguage(directory, language)]),
  );
  const problems = [];
  const required = new Set(REQUIRED_KEYS);

  for (const language of LANGUAGES) {
    const {file, strings} = loaded[language];
    for (const key of REQUIRED_KEYS) {
      if (!Object.hasOwn(strings, key)) {
        problems.push(`${file}: the required key ${JSON.stringify(key)} is missing (UX section 12)`);
      }
    }
    for (const key of Object.keys(strings)) {
      if (!required.has(key)) {
        problems.push(`${file}: ${JSON.stringify(key)} is not one of the ${REQUIRED_KEYS.length} keys in UX section 12`);
      }
      const value = strings[key];
      if (typeof value !== 'string') {
        problems.push(`${file}: ${JSON.stringify(key)} must be a string`);
        continue;
      }
      if (value.trim() === '') {
        problems.push(`${file}: ${JSON.stringify(key)} is empty or whitespace only`);
      }
      for (const placeholder of placeholdersOf(value)) {
        if (!KNOWN_PLACEHOLDERS.has(placeholder)) {
          problems.push(
            `${file}: ${JSON.stringify(key)} uses the unknown placeholder {${placeholder}}; ` +
              `UX section 12 defines ${[...KNOWN_PLACEHOLDERS].map((name) => `{${name}}`).join(', ')}`,
          );
        }
      }
    }
  }

  const [first, ...rest] = LANGUAGES;
  for (const language of rest) {
    for (const key of REQUIRED_KEYS) {
      const a = loaded[first].strings[key];
      const b = loaded[language].strings[key];
      if (typeof a !== 'string' || typeof b !== 'string') {
        continue; // already reported above
      }
      const left = placeholdersOf(a);
      const right = placeholdersOf(b);
      const onlyLeft = [...left].filter((name) => !right.has(name));
      const onlyRight = [...right].filter((name) => !left.has(name));
      if (onlyLeft.length > 0 || onlyRight.length > 0) {
        problems.push(
          `${key}: placeholder sets differ — ${first} has ` +
            `{${[...left].join('} {')}} and ${language} has {${[...right].join('} {')}}`,
        );
      }
    }
  }

  return {directory, loaded, problems};
}

function report(result) {
  const lines = [`string parity: ${result.directory}`];
  for (const language of LANGUAGES) {
    lines.push(`  strings.${language}.json: ${Object.keys(result.loaded[language].strings).length} key(s)`);
  }
  if (result.problems.length === 0) {
    lines.push(`result: pass — ${REQUIRED_KEYS.length} keys, identical placeholder sets, no empty value`);
    lines.push('note: native Spanish review of every shipped string is still pending (A12, M5.4): docs/user/spanish-review-record.md in the development record, Dev_Papeleria\'s Dev_Docs/');
  } else {
    lines.push(`result: FAIL — ${result.problems.length} problem(s) (C20)`);
    for (const problem of result.problems) {
      lines.push(`  ${problem}`);
    }
  }
  return lines.join('\n');
}

function parseArguments(argv) {
  let directory = join(process.cwd(), 'templates', 'shared');
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--dir') {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new UsageError('--dir needs a path');
      }
      directory = value;
      index += 1;
    } else {
      throw new UsageError(`unknown argument ${JSON.stringify(argv[index])}`);
    }
  }
  return resolve(directory);
}

function main(argv) {
  let directory;
  try {
    directory = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`check-strings: ${error.message}\n`);
    process.stderr.write('usage: node scripts/check-strings.mjs [--dir <dir>]\n');
    return 2;
  }
  let result;
  try {
    result = checkStrings(directory);
  } catch (error) {
    process.stderr.write(`check-strings: ${error.message}\n`);
    return 2;
  }
  process.stdout.write(`${report(result)}\n`);
  return result.problems.length === 0 ? 0 : 1;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  process.exitCode = main(process.argv.slice(2));
}
