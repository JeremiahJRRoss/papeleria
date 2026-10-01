/**
 * Builds deck fixtures from the reference deck (M1.6).
 *
 * `reference/` is immutable and is only read. Each fixture is
 * `reference/decks/brand-overview.html` turned into what the deck renderer is
 * to emit (templates/deck/client/CONTRACT.md §7): the kit script replaced by
 * the built bundle, an IC02-escaped strings block, stylesheet and favicon
 * paths inside the fixture, the `no_js_slides` status text (D131), localized labels and
 * `tabindex="-1"` on titles. Options produce the deliberately broken variants
 * the tests need. Every rewrite asserts how many times it applied, so a
 * change to the reference fails here instead of yielding a wrong fixture.
 */
import {copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

import {applicationRoot} from '../../helpers/paths.js';

export type Language = 'en' | 'es';

export type DeckFixtureOptions = {
  /** Language of the strings, of `lang` and of the no-JS status. Default `en`. */
  readonly language?: Language;
  /**
   * The strings block: the language's strings file (default), an object to
   * serialize, raw text placed inside the element unchanged, or `omit`.
   */
  readonly strings?: 'language' | 'omit' | {readonly raw: string} | Readonly<Record<string, unknown>>;
  /** Server-side button and skip-link labels: from the strings (default) or the reference's English. */
  readonly labels?: 'strings' | 'reference';
  /** Whether titles carry `tabindex="-1"` in the markup. Default true. */
  readonly titleTabindex?: boolean;
  /** Deferred in `<head>` as the reference does (default), or a classic script at the end of `<body>`. */
  readonly script?: 'head-defer' | 'body-end';
  /** Keeps only the first this many slide articles. Default: all sixteen. */
  readonly slides?: number;
};

export type DeckFixture = {
  readonly directory: string;
  readonly indexPath: string;
  readonly fileUrl: string;
  /** The strings file of the fixture's language, for building expectations. */
  readonly strings: Readonly<Record<string, string>>;
};

export const REFERENCE_DECK = join(applicationRoot, 'reference', 'decks', 'brand-overview.html');
export const DECK_BUNDLE = join(applicationRoot, 'lib', 'clients', 'deck.js');

const LABELS: readonly (readonly [id: string, key: string])[] = [
  ['prev-slide', 'previous'],
  ['next-slide', 'next'],
  ['all-slides', 'show_all'],
  ['toggle-notes', 'show_notes'],
  ['full-deck', 'fullscreen'],
  ['print-deck', 'print'],
];

export function readStringsFile(language: Language): Record<string, string> {
  const path = join(applicationRoot, 'templates', 'shared', `strings.${language}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
}

/**
 * Serializes a value for an inert `<script type="application/json">` element
 * (IC02): `<`, `>`, `&`, U+2028 and U+2029 become Unicode escapes, so no value
 * can close the element, open a comment or break a line terminator rule.
 */
export function escapeJsonForHtml(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new TypeError('the value has no JSON form');
  }
  return json.replace(/[<>&\u2028\u2029]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Applies a rewrite and insists it matched exactly `expected` times. */
function rewrite(html: string, pattern: RegExp, replace: (match: string, ...groups: string[]) => string, expected: number, what: string): string {
  if (!pattern.global) {
    throw new Error(`fixture: the pattern for ${what} must be global`);
  }
  let count = 0;
  const result = html.replace(pattern, (match: string, ...rest: unknown[]) => {
    count += 1;
    // The capture groups come first, then the numeric offset and the input.
    const groups = rest.slice(0, rest.findIndex((part) => typeof part === 'number'));
    return replace(match, ...groups.map((group) => (typeof group === 'string' ? group : '')));
  });
  if (count !== expected) {
    throw new Error(`fixture: expected ${expected} ${what} in ${REFERENCE_DECK}, found ${count}`);
  }
  return result;
}

function stringsBlock(options: DeckFixtureOptions, strings: Record<string, string>): string {
  const choice = options.strings ?? 'language';
  if (choice === 'omit') {
    return '';
  }
  let content: string;
  if (choice === 'language') {
    content = escapeJsonForHtml(strings);
  } else if ('raw' in choice && typeof choice.raw === 'string') {
    if (/<\/script/i.test(choice.raw)) {
      throw new Error('fixture: raw strings text must not close the script element');
    }
    content = choice.raw;
  } else {
    content = escapeJsonForHtml(choice);
  }
  return `<script type="application/json" id="papeleria-strings">${content}</script>`;
}

/** Writes a fixture into `directory` (created if needed) and returns where it is. */
export function buildDeckFixture(directory: string, options: DeckFixtureOptions = {}): DeckFixture {
  if (!existsSync(DECK_BUNDLE)) {
    throw new Error(`fixture: ${DECK_BUNDLE} is missing; run npm run build first`);
  }
  const language = options.language ?? 'en';
  const strings = readStringsFile(language);
  const label = (key: string): string => {
    const text = strings[key];
    if (text === undefined) {
      throw new Error(`fixture: strings.${language}.json has no ${key}`);
    }
    return escapeHtml(text);
  };

  let html = readFileSync(REFERENCE_DECK, 'utf8');
  html = rewrite(html, /<html lang="en">/g, () => `<html lang="${language}">`, 1, 'html lang attributes');
  html = rewrite(html, /<script src="\.\.\/\.\.\/theme\/js\/slides\.js" defer><\/script>/g, () => '', 1, 'kit script tags');
  html = rewrite(html, /href="\.\.\/\.\.\/theme\//g, () => 'href="theme/', 5, 'theme stylesheet and favicon links');
  html = rewrite(
    html,
    /(<p class="deck-status" id="deck-status" role="status">)[^<]*(<\/p>)/g,
    (_match, open = '', close = '') => `${open}${label('no_js_slides')}${close}`,
    1,
    'status paragraphs',
  );
  if ((options.labels ?? 'strings') === 'strings') {
    for (const [id, key] of LABELS) {
      html = rewrite(
        html,
        new RegExp(`(<button\\b[^>]*\\bid="${id}"[^>]*>)[^<]*(</button>)`, 'g'),
        (_match, open = '', close = '') => `${open}${label(key)}${close}`,
        1,
        `#${id} buttons`,
      );
    }
    html = rewrite(
      html,
      /(<a class="skip-link" href="#deck-main">)[^<]*(<\/a>)/g,
      (_match, open = '', close = '') => `${open}${label('skip')}${close}`,
      1,
      'skip links',
    );
  }
  if (options.titleTabindex ?? true) {
    html = rewrite(
      html,
      /<h2 class="slide-title" id="(title-\d+)">/g,
      (_match, id = '') => `<h2 class="slide-title" id="${id}" tabindex="-1">`,
      16,
      'slide titles',
    );
  }
  const kept = options.slides ?? 16;
  html = rewrite(
    html,
    /<article class="deck-slide[^"]*" id="slide-(\d+)"[\s\S]*?<\/article>/g,
    (article, number = '') => (Number(number) <= kept ? article : ''),
    16,
    'slide articles',
  );
  const placement = options.script ?? 'head-defer';
  const headEnd = `${stringsBlock(options, strings)}${placement === 'head-defer' ? '<script src="deck.js" defer></script>' : ''}</head>`;
  html = rewrite(html, /<\/head>/g, () => headEnd, 1, 'head end tags');
  if (placement === 'body-end') {
    html = rewrite(html, /<\/body>/g, () => '<script src="deck.js"></script></body>', 1, 'body end tags');
  }

  mkdirSync(directory, {recursive: true});
  for (const folder of ['css', 'fonts', 'marks']) {
    cpSync(join(applicationRoot, 'theme', folder), join(directory, 'theme', folder), {recursive: true});
  }
  copyFileSync(DECK_BUNDLE, join(directory, 'deck.js'));
  const indexPath = join(directory, 'index.html');
  writeFileSync(indexPath, html);
  return {directory, indexPath, fileUrl: pathToFileURL(indexPath).href, strings};
}
