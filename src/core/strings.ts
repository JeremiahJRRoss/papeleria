/**
 * M1.3: the published pieces' control strings, per language.
 *
 * `templates/shared/strings.en.json` and `strings.es.json` carry exactly the
 * keys of UX section 12 (C20; `npm run check:strings` checks parity). A
 * piece's `language` chooses one set; the renderers take every control label
 * from it, never from a literal.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {locateToolRoot} from './paths.js';
import {STRING_KEYS, ToolResourceError, type Language, type StringKey, type UiStrings} from './types.js';

const cache = new Map<string, UiStrings>();

/** Checks a parsed strings file: exactly the UX section 12 keys, each a non-blank string. */
export function parseStrings(value: unknown, file: string): UiStrings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ToolResourceError(file, 'must be a JSON object of key to string');
  }
  const record = value as Record<string, unknown>;
  const expected = new Set<string>(STRING_KEYS);
  for (const key of Object.keys(record)) {
    if (!expected.has(key)) {
      throw new ToolResourceError(file, `has the unknown key ${key}`);
    }
  }
  const strings = {} as Record<StringKey, string>;
  for (const key of STRING_KEYS) {
    const text = record[key];
    if (typeof text !== 'string' || text.trim() === '') {
      throw new ToolResourceError(file, `has no text for ${key}`);
    }
    strings[key] = text;
  }
  return Object.freeze(strings);
}

/** The control strings for a language, read once per tool root. */
export function loadStrings(language: Language, toolRoot: string = locateToolRoot()): UiStrings {
  const file = join(toolRoot, 'templates', 'shared', `strings.${language}.json`);
  let strings = cache.get(file);
  if (strings === undefined) {
    let parsed: unknown;
    try {
      // TextDecoder removes one leading byte-order mark, which Windows editors may
      // save and JSON.parse refuses; piece files lose theirs the same way (D152).
      parsed = JSON.parse(new TextDecoder().decode(readFileSync(file)));
    } catch (error) {
      throw new ToolResourceError(file, `cannot be read: ${(error as Error).message}`);
    }
    strings = parseStrings(parsed, file);
    cache.set(file, strings);
  }
  return strings;
}

/**
 * Fills `{name}` placeholders from the caller's own values: `{constructor}`
 * is never answered by Object.prototype. A placeholder without a value is a
 * defect in the caller, so it throws rather than printing a brace to a reader.
 */
export function formatString(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{([^{}]+)\}/g, (_match, name: string) => {
    const value = Object.hasOwn(values, name) ? values[name] : undefined;
    if (value === undefined) {
      throw new Error(`E_INTERNAL: no value for {${name}} in ${JSON.stringify(template)}`);
    }
    return String(value);
  });
}
