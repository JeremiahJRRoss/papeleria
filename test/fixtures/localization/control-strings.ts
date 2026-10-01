/**
 * M5.4 (W5C, D133): the control strings of each language, and the whole-word
 * search the localization suites use to show that a page in one language
 * carries none of the other's. Node-side only and free of DOM types, so the
 * integration suite and the browser suite share one definition.
 *
 * A value's fixed words are the text between its placeholders, trimmed, where
 * that text holds a letter and three characters or more: "Page {n} of {total}"
 * gives "Page"; "{n} panels · explore …" gives "panels · explore …". A fixed
 * word is found only as a whole: no letter or digit may touch either end, so
 * "Document" is not found inside "Documento", and case counts, so "note" in a
 * class name is not "Note".
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {applicationRoot} from '../../helpers/paths.js';

export type Language = 'en' | 'es';
export type Strings = Readonly<Record<string, string>>;

export const LANGUAGES: readonly Language[] = ['en', 'es'];
export const OTHER: Readonly<Record<Language, Language>> = {en: 'es', es: 'en'};

function loadStrings(language: Language): Strings {
  return JSON.parse(readFileSync(join(applicationRoot, 'templates', 'shared', `strings.${language}.json`), 'utf8')) as Strings;
}

/** Both strings files, as shipped. */
export const STRINGS: Readonly<Record<Language, Strings>> = {en: loadStrings('en'), es: loadStrings('es')};

/** Fills `{name}` with split and join, a different mechanism from the clients' and the core's. */
export function fill(template: string | undefined, values: Readonly<Record<string, string | number>>): string {
  let text = template ?? '';
  for (const [name, value] of Object.entries(values)) {
    text = text.split(`{${name}}`).join(String(value));
  }
  return text;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A value's fixed words: the text between its placeholders, trimmed, with a letter and three characters or more. */
export function fixedWords(value: string): string[] {
  return value
    .split(/\{[a-z_]+\}/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3 && /\p{L}/u.test(part));
}

/** The words as a whole: no letter or digit may touch either end. */
export function wholeWord(words: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(words)}(?![\\p{L}\\p{N}])`, 'u');
}

/** The control strings of `language` whose fixed words appear in `text` as whole words, as `key: "words"`. */
export function controlStringsIn(text: string, language: Language): string[] {
  const found: string[] = [];
  for (const [key, value] of Object.entries(STRINGS[language])) {
    for (const words of fixedWords(value)) {
      if (wholeWord(words).test(text)) {
        found.push(`${key}: ${JSON.stringify(words)}`);
      }
    }
  }
  return found;
}
