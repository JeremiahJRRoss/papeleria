/**
 * M1.6: the deck client's pure logic, the strings it depends on, and the
 * published bundle.
 *
 * The bundle checks here are deliberately a second implementation, separate
 * from the scan inside scripts/bundle-clients.mjs: a checker is not trusted to
 * vouch for itself. The bundler's own scanner and this file's list are then
 * both run against planted files, one forbidden construct each, to prove
 * neither is vacuous; the contract-name check gets planted names the same way.
 * Browser behaviour is covered by test/browser/deck.test.ts.
 */
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, describe, test} from 'node:test';
import vm from 'node:vm';

import {
  DECK_STRING_KEYS,
  SWIPE_MAX_ANGLE_DEGREES,
  SWIPE_MIN_DISTANCE,
  allShownLine,
  clampSlide,
  classifySwipe,
  formatString,
  keyAction,
  normalizeText,
  parseFragment,
  readDeckStrings,
  slideFragment,
  type Fragment,
} from '../../templates/deck/client/deck-logic.js';
import {applicationRoot, runCheckScript} from '../helpers/paths.js';

const bundlePath = join(applicationRoot, 'lib', 'clients', 'deck.js');
const contractPath = join(applicationRoot, 'templates', 'deck', 'client', 'CONTRACT.md');

function readStrings(language: 'en' | 'es'): Record<string, string> {
  const path = join(applicationRoot, 'templates', 'shared', `strings.${language}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
}

/**
 * What a published bundle must never contain, written apart from the scan in
 * scripts/bundle-clients.mjs. Identifiers rather than call shapes, so that an
 * alias, a bracket, an optional call or a passed reference cannot slip by.
 */
const NEVER_IN_BUNDLE: [string, RegExp][] = [
  ['module syntax', /^\s*(?:import|export)\b/m],
  ['import(', /import\s*\(/],
  ['require(', /require\s*\(/],
  ['fetch', /fetch/i],
  ['XMLHttpRequest', /XMLHttpRequest/],
  ['navigator.sendBeacon', /sendBeacon/],
  ['WebSocket', /WebSocket/],
  ['EventSource', /EventSource/],
  ['importScripts', /importScripts/],
  ['a worker of any kind', /Worker\b/],
  ['a worklet', /Worklet|addModule/],
  ['eval', /\beval\b/],
  ['Function', /\bFunction\b/],
  ['a .constructor lookup', /\.\s*constructor\b|['"`]constructor['"`]/],
  ['a script element', /createElement(?:NS)?\s*\([^)]*script/i],
  ['Image', /\bImage\b/],
  ['a timer given a string', /set(?:Timeout|Interval)\s*\(\s*['"`]/],
  ['markup from a string', /innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment|HTMLUnsafe|document\s*\.\s*write/],
  ['an http(s) or file URL', /(?:https?|file|wss?|ftp):/i],
  ['a protocol-relative URL', /['"`]\/\//],
  ['a root-relative path in a string', /['"`]\/[A-Za-z0-9._-]/],
  ['a source map', /sourceMappingURL/],
];

/** Names the client is known to rely on, each of which CONTRACT.md documents. */
const CONTRACT_FLOOR = [
  'deck-slide',
  'slide-title',
  'slide-canvas',
  'prev-slide',
  'next-slide',
  'all-slides',
  'toggle-notes',
  'full-deck',
  'print-deck',
  'deck-status',
  'papeleria-strings',
  'application/json',
  'deck-enhanced',
  'show-slide-notes',
  'aria-pressed',
  'tabindex',
  'papeleriaDeck',
  'slidechange',
] as const;

/** Names planted in a copy of the bundle, one for each way the extraction reads one. */
const PLANTED_NAMES = `
  const PLANTED_SELECTOR = "[data-planted-constant]";
  const plantedPanel = document.getElementById("deck-secret-panel");
  document.body.classList.add("deck-undocumented-state");
  plantedPanel?.querySelector("planted-element .slide-undocumented-part")?.setAttribute("data-planted", "yes");
  document.querySelector(PLANTED_SELECTOR);
  findButton("planted-button");
  document.dispatchEvent(new CustomEvent("plantedchange"));
  window.plantedDeck = {};
`;

type NameKind = 'attribute' | 'class' | 'element' | 'event' | 'global' | 'id';

/** A string literal as esbuild prints one; a template literal with a substitution is not a name. */
const LITERAL = String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|` + '`(?:[^`\\\\$]|\\\\.)*`';
const IDENTIFIER = String.raw`[A-Za-z_$][\w$]*`;
const LOOKUPS = ['getElementById', 'querySelector', 'querySelectorAll', 'closest', 'matches'];

function literalValue(literal: string): string {
  return literal.slice(1, -1).replace(/\\(.)/g, '$1');
}

/**
 * The leading arguments of a call whose argument list starts at `start`, each
 * a string literal's value, a string constant's value, or null for anything
 * else. Reading stops at the first argument that is neither.
 */
function literalArguments(text: string, start: number, constants: ReadonlyMap<string, string>): (string | null)[] {
  const argument = new RegExp(String.raw`^\s*(?:(${LITERAL})|(${IDENTIFIER}))\s*([,)])`);
  const values: (string | null)[] = [];
  let position = start;
  for (;;) {
    const match = argument.exec(text.slice(position));
    if (match === null) {
      values.push(null);
      return values;
    }
    const [whole, literal, identifier, end] = match;
    values.push(literal !== undefined ? literalValue(literal) : (constants.get(identifier ?? '') ?? null));
    if (end === ')') {
      return values;
    }
    position += whole.length;
  }
}

/** Splits a CSS selector into the ids, classes, attributes and elements it names. */
function selectorNames(selector: string, add: (kind: NameKind, name: string) => void): void {
  const bare = selector.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '');
  for (const [, name = ''] of bare.matchAll(/#([\w-]+)/g)) add('id', name);
  for (const [, name = ''] of bare.matchAll(/\.([\w-]+)/g)) add('class', name);
  for (const [, name = ''] of bare.matchAll(/\[\s*([\w-]+)/g)) add('attribute', name);
  const rest = bare.replace(/\[[^\]]*\]/g, ' ').replace(/[#.][\w-]+/g, ' ').replace(/::?[\w-]+/g, ' ');
  for (const [name] of rest.matchAll(/[A-Za-z][\w-]*/g)) add('element', name.toLowerCase());
}

/**
 * Every DOM name a bundle relies on, as "kind name": the string literals it
 * passes to a lookup (getElementById, querySelector, querySelectorAll,
 * closest, matches), to a classList method, to an attribute method or to an
 * Event or CustomEvent constructor, whether written in place, held in a string
 * constant (as EDITABLE is), or handed to a function that passes its one
 * parameter straight to a lookup (as findButton is), and the properties it
 * assigns on window. Names built at run time, such as slide-N, are not read.
 */
function domNames(text: string): Set<string> {
  const names = new Set<string>();
  const add = (kind: NameKind, name: string): void => {
    names.add(`${kind} ${name}`);
  };
  const constants = new Map<string, string>();
  for (const match of text.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+(${IDENTIFIER})\s*=\s*(${LITERAL})\s*;`, 'g'))) {
    constants.set(match[1] ?? '', literalValue(match[2] ?? '""'));
  }
  const lookup = (method: string, value: string): void => {
    if (method === 'getElementById') {
      add('id', value);
    } else {
      selectorNames(value, add);
    }
  };
  for (const match of text.matchAll(new RegExp(String.raw`\.(${LOOKUPS.join('|')})\(`, 'g'))) {
    const [value] = literalArguments(text, (match.index ?? 0) + match[0].length, constants);
    if (typeof value === 'string') {
      lookup(match[1] ?? '', value);
    }
  }
  const wrapper = new RegExp(
    String.raw`\bfunction\s+(${IDENTIFIER})\s*\(\s*(${IDENTIFIER})\s*\)\s*\{[^{}]*?\.(${LOOKUPS.join('|')})\(\s*\2\s*\)`,
    'g',
  );
  for (const [, name = '', , method = ''] of text.matchAll(wrapper)) {
    for (const call of text.matchAll(new RegExp(String.raw`(?<![\w$.]|function\s)${name.replace(/\$/g, '\\$')}\(`, 'g'))) {
      const [value] = literalArguments(text, (call.index ?? 0) + call[0].length, constants);
      if (typeof value === 'string') {
        lookup(method, value);
      }
    }
  }
  for (const match of text.matchAll(/\.classList\.(add|remove|toggle|contains|replace)\(/g)) {
    const values = literalArguments(text, (match.index ?? 0) + match[0].length, constants);
    const count = match[1] === 'toggle' || match[1] === 'contains' ? 1 : match[1] === 'replace' ? 2 : values.length;
    for (const value of values.slice(0, count)) {
      if (typeof value === 'string') {
        add('class', value);
      }
    }
  }
  for (const match of text.matchAll(/\.(?:get|set|has|remove|toggle)Attribute\(/g)) {
    const [value] = literalArguments(text, (match.index ?? 0) + match[0].length, constants);
    if (typeof value === 'string') {
      add('attribute', value);
    }
  }
  for (const match of text.matchAll(/\bnew\s+(?:Custom)?Event\(/g)) {
    const [value] = literalArguments(text, (match.index ?? 0) + match[0].length, constants);
    if (typeof value === 'string') {
      add('event', value);
    }
  }
  for (const [, name = ''] of text.matchAll(new RegExp(String.raw`\bwindow\.(${IDENTIFIER})\s*=(?!=)`, 'g'))) {
    add('global', name);
  }
  return names;
}

/** Whether CONTRACT.md mentions a name as a whole word, not inside a longer one. */
function mentions(contract: string, name: string): boolean {
  return new RegExp(String.raw`(?<![\w-])${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?![\w-])`).test(contract);
}

/** The DOM names a bundle relies on that CONTRACT.md does not mention, as "kind name", sorted. */
function undocumentedNames(text: string, contract: string): string[] {
  return [...domNames(text)].filter((entry) => !mentions(contract, entry.slice(entry.indexOf(' ') + 1))).sort();
}

describe('fragments (IC07, UX C5)', () => {
  const cases: [string, Fragment][] = [
    ['', {kind: 'none'}],
    ['#', {kind: 'none'}],
    ['#slide-1', {kind: 'slide', number: 1}],
    ['#slide-16', {kind: 'slide', number: 16}],
    ['#slide-99', {kind: 'slide', number: 99}],
    ['#slide-0', {kind: 'slide', number: 0}],
    ['#slide-007', {kind: 'slide', number: 7}],
    ['#slide-%31%36', {kind: 'slide', number: 16}],
    ['#slide-', {kind: 'malformed'}],
    ['#slide-abc', {kind: 'malformed'}],
    ['#slide--1', {kind: 'malformed'}],
    ['#slide-1.5', {kind: 'malformed'}],
    ['#slide-1e3', {kind: 'malformed'}],
    ['#slide- 2', {kind: 'malformed'}],
    ['#slide-\uFF12', {kind: 'malformed'}],
    ['#slide-2/', {kind: 'malformed'}],
    ['#slide-%E0%A4%A', {kind: 'malformed'}],
    ['#%E0%A4%A', {kind: 'malformed'}],
    ['#deck-main', {kind: 'other', id: 'deck-main'}],
    ['#title-5', {kind: 'other', id: 'title-5'}],
    ['#Slide-2', {kind: 'other', id: 'Slide-2'}],
    ['#caf%C3%A9', {kind: 'other', id: 'café'}],
  ];
  for (const [hash, expected] of cases) {
    test(`${JSON.stringify(hash)} is ${expected.kind}`, () => {
      assert.deepEqual(parseFragment(hash), expected);
    });
  }

  test('a slide number clamps into 1..total; out-of-range positive numbers go to the last slide', () => {
    const table: [number, number][] = [
      [1, 1],
      [16, 16],
      [17, 16],
      [99, 16],
      [0, 1],
      [-3, 1],
      [Number.NaN, 1],
      [Number.POSITIVE_INFINITY, 16],
      [Number.NEGATIVE_INFINITY, 1],
      [2.9, 2],
    ];
    for (const [input, expected] of table) {
      assert.equal(clampSlide(input, 16), expected, `clampSlide(${input}, 16)`);
    }
    assert.equal(clampSlide(5, 0), 1, 'a degenerate total never yields slide 0');
    const huge = parseFragment('#slide-99999999999999999999999999999999');
    assert.equal(huge.kind, 'slide');
    assert.equal(clampSlide(huge.kind === 'slide' ? huge.number : 0, 16), 16);
  });

  test('the canonical address is #slide-N', () => {
    assert.equal(slideFragment(7), '#slide-7');
  });
});

describe('swipe geometry (UX §05, D53)', () => {
  test('the published limits are 40 px and 30°', () => {
    assert.equal(SWIPE_MIN_DISTANCE, 40);
    assert.equal(SWIPE_MAX_ANGLE_DEGREES, 30);
  });

  const cases: [string, number, number, 'next' | 'previous' | null][] = [
    ['exactly 40 px to the left', -40, 0, 'next'],
    ['39.9 px to the left', -39.9, 0, null],
    ['exactly 40 px to the right', 40, 0, 'previous'],
    ['exactly 30° from horizontal', -100, 100 * Math.tan(Math.PI / 6), 'next'],
    ['30.2° from horizontal', -100, 58.2, null],
    ['26.6° upward and to the left', -100, -50, 'next'],
    ['40.3 px long although only 35 px across', -35, 20, 'next'],
    ['42 px long at 45°', -30, -30, null],
    ['straight down', 0, 100, null],
    ['no movement', 0, 0, null],
    ['a non-finite reading', Number.NaN, 0, null],
    ['an infinite reading', Number.POSITIVE_INFINITY, 0, null],
  ];
  for (const [name, dx, dy, expected] of cases) {
    test(`${name} → ${String(expected)}`, () => {
      assert.equal(classifySwipe(dx, dy), expected);
    });
  }
});

describe('navigation keys (UX §05, C4, D53)', () => {
  test('in the single-slide view every listed key has its action', () => {
    const expected: Record<string, string> = {
      ArrowLeft: 'previous',
      ArrowUp: 'previous',
      PageUp: 'previous',
      ArrowRight: 'next',
      ArrowDown: 'next',
      PageDown: 'next',
      Home: 'first',
      End: 'last',
    };
    for (const [key, action] of Object.entries(expected)) {
      assert.equal(keyAction(key, false), action, key);
    }
  });

  test('in the stacked view the vertical arrows keep scrolling the page', () => {
    assert.equal(keyAction('ArrowUp', true), null);
    assert.equal(keyAction('ArrowDown', true), null);
    for (const key of ['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End']) {
      assert.equal(keyAction(key, true), keyAction(key, false), key);
    }
  });

  test('no other key belongs to the deck, Escape included (IC06)', () => {
    for (const key of [' ', 'Enter', 'Escape', 'Tab', 'a', 'Left', 'Right', 'F11', '']) {
      assert.equal(keyAction(key, false), null, JSON.stringify(key));
      assert.equal(keyAction(key, true), null, JSON.stringify(key));
    }
  });
});

describe('strings (UX §12, IC02)', () => {
  test('placeholders are replaced in one pass and values are inserted literally', () => {
    const english = readStrings('en');
    assert.equal(
      formatString(english['slide_of']!, {n: 2, total: 16, title: 'Two sources. Two different needs.'}),
      'Slide 2 of 16: Two sources. Two different needs.',
    );
    assert.equal(formatString('{title}', {title: 'a $& b $1 c $$'}), 'a $& b $1 c $$');
    assert.equal(formatString('{title} / {total}', {title: '{total}', total: 16}), '{total} / 16');
    assert.equal(formatString('{n}-{n}', {n: 3}), '3-3');
    assert.equal(formatString('x {unknown} y', {n: 1}), 'x {unknown} y');
    assert.equal(formatString('{constructor}{toString}', {}), '{constructor}{toString}');
  });

  test('both strings files carry every key the client reads, with the placeholders it fills', () => {
    for (const language of ['en', 'es'] as const) {
      const strings = readStrings(language);
      for (const key of DECK_STRING_KEYS) {
        assert.equal(typeof strings[key], 'string', `${language} ${key}`);
        assert.notEqual(strings[key]!.trim(), '', `${language} ${key} is blank`);
      }
      for (const placeholder of ['{n}', '{total}', '{title}']) {
        assert.ok(strings['slide_of']!.includes(placeholder), `${language} slide_of lacks ${placeholder}`);
      }
      assert.ok(strings['all_shown']!.includes('{total}'), `${language} all_shown lacks {total}`);
      // The renderer's side of the contract: the skip link and the no-JS status.
      for (const key of ['skip', 'no_js_slides']) {
        assert.notEqual((strings[key] ?? '').trim(), '', `${language} ${key}`);
      }
    }
  });

  test('the stacked view says all_shown_one for a deck of one slide and all_shown for any other count (D130)', () => {
    const english = readDeckStrings(JSON.stringify(readStrings('en')))!;
    assert.equal(allShownLine(english, 1), '1 slide shown.');
    assert.equal(allShownLine(english, 2), 'All 2 slides shown.');
    assert.equal(allShownLine(english, 16), 'All 16 slides shown.');
    for (const language of ['en', 'es'] as const) {
      const strings = readDeckStrings(JSON.stringify(readStrings(language)))!;
      assert.notEqual(strings.all_shown_one, strings.all_shown, `${language}: the singular is its own sentence`);
      assert.equal(allShownLine(strings, 1), formatString(strings.all_shown_one, {total: 1}), language);
      for (const total of [2, 3, 16, 1000]) {
        assert.equal(allShownLine(strings, total), formatString(strings.all_shown, {total}), `${language} ${total}`);
      }
    }
  });

  test('a strings block is usable only when every deck key is a non-blank string', () => {
    for (const language of ['en', 'es'] as const) {
      const strings = readStrings(language);
      const read = readDeckStrings(JSON.stringify(strings));
      assert.ok(read !== null, `${language} strings are rejected`);
      assert.deepEqual(Object.keys(read).sort(), [...DECK_STRING_KEYS].sort(), 'extra keys are dropped');
      for (const key of DECK_STRING_KEYS) {
        assert.equal(read[key], strings[key]);
      }
      for (const key of DECK_STRING_KEYS) {
        const missing = {...strings};
        delete missing[key];
        assert.equal(readDeckStrings(JSON.stringify(missing)), null, `missing ${key}`);
        assert.equal(readDeckStrings(JSON.stringify({...strings, [key]: '  \n'})), null, `blank ${key}`);
        assert.equal(readDeckStrings(JSON.stringify({...strings, [key]: 42})), null, `non-string ${key}`);
      }
    }
    for (const text of ['', 'not json', '[]', 'null', '"text"', '{}', '{"previous": "Previous",}']) {
      assert.equal(readDeckStrings(text), null, JSON.stringify(text));
    }
  });

  test('text is collapsed to single spaces and trimmed', () => {
    assert.equal(normalizeText('  a\n\t b  '), 'a b');
    assert.equal(normalizeText('\u00a0x\u2028y\u2029'), 'x y');
  });
});

describe('the published bundle (D50, C22, C24)', () => {
  const present = existsSync(bundlePath);
  const bundle = present ? readFileSync(bundlePath, 'utf8') : '';

  test('npm run build produced lib/clients/deck.js', () => {
    assert.ok(present, `${bundlePath} is missing; npm run build writes it`);
    assert.ok(bundle.length > 1000, 'the bundle is implausibly small');
  });

  test('it is one classic script: it compiles outside a module and has no module syntax', () => {
    assert.doesNotThrow(() => new vm.Script(bundle, {filename: 'deck.js'}));
    assert.match(bundle, /^\/\* Papeleria deck client\. Own code under Apache-2\.0/);
    assert.match(bundle, /^\(\(\) => \{$/m, 'the bundle is not wrapped in an IIFE');
    assert.match(bundle, /^\}\)\(\);\s*$/m);
    assert.doesNotMatch(bundle, /^\s*(?:import|export)\b/m);
  });

  test('it cannot reach the network, load code or evaluate text', () => {
    for (const [name, pattern] of NEVER_IN_BUNDLE) {
      assert.doesNotMatch(bundle, pattern, `the bundle contains ${name}`);
    }
  });

  test('it carries no English interface text: every word comes from the strings block', () => {
    const english = readStrings('en');
    // esbuild prints plain string and template literals; identifiers such as
    // clampSlide are code, not text, so only literals are compared.
    const literals = [...bundle.matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g)].map(
      (match) => match[0].slice(1, -1),
    );
    assert.ok(literals.includes('papeleria-strings'), 'the literal extraction found nothing');
    for (const key of [...DECK_STRING_KEYS, 'skip', 'no_js_slides']) {
      // Compare the fixed words around placeholders, e.g. "Slide" and "of".
      for (const fragment of english[key]!.split(/\{[a-z_]+\}/)) {
        const words = fragment.trim();
        if (words.length >= 3 && /[A-Za-z]/.test(words)) {
          const found = literals.find((literal) => literal.includes(words));
          assert.equal(found, undefined, `the bundle contains the English ${key} text ${JSON.stringify(words)}`);
        }
      }
    }
    // The kit's own hard-coded sentences must not survive the port either.
    for (const literal of ['Full-screen mode', 'slides shown', 'without JavaScript', 'Show one slide']) {
      assert.ok(!bundle.includes(literal), `the bundle contains the kit literal ${JSON.stringify(literal)}`);
    }
  });

  test('every id, class and name it relies on is written down in CONTRACT.md', (context) => {
    const contract = readFileSync(contractPath, 'utf8');
    const extracted = domNames(bundle);
    context.diagnostic(`names read from the bundle: ${[...extracted].sort().join(', ')}`);
    const found = new Set([...extracted].map((entry) => entry.slice(entry.indexOf(' ') + 1)));
    for (const name of CONTRACT_FLOOR) {
      assert.ok(bundle.includes(name), `the bundle no longer uses ${name}; update the contract and this list`);
      assert.ok(mentions(contract, name), `CONTRACT.md does not mention ${name}`);
      // The floor keeps the extraction honest: it must still find every name
      // listed, bar the strings block's type, which is compared, not looked up.
      if (name !== 'application/json') {
        assert.ok(found.has(name), `the name extraction no longer finds ${name}`);
      }
    }
    assert.deepEqual(undocumentedNames(bundle, contract), []);
  });

  test('the overflow check is the preview bundle\'s alone: deck.js is the deck client and nothing more (D167, D174)', () => {
    const modules = (text: string): (string | undefined)[] => [...text.matchAll(/^ {2}\/\/ (\S+\.ts)$/gm)].map((match) => match[1]);
    assert.deepEqual(modules(bundle), ['templates/deck/client/deck-logic.ts', 'templates/deck/client/deck.ts']);
    assert.ok(!bundle.includes('papeleria-preview'), 'deck.js holds a preview event');
    const preview = readFileSync(join(applicationRoot, 'lib', 'clients', 'deck-preview.js'), 'utf8');
    assert.deepEqual(modules(preview), [
      'templates/deck/client/deck-logic.ts',
      'templates/deck/client/deck.ts',
      'templates/shared/preview-protocol.ts',
      'templates/shared/preview-bridge.ts',
      'templates/deck/client/preview-deck.ts',
    ]);
    assert.ok(preview.includes('papeleria-preview-overflow'), 'deck-preview.js reports overflow');
  });

  test('a name the bundle relies on and CONTRACT.md leaves out fails that check (non-vacuity)', () => {
    const contract = readFileSync(contractPath, 'utf8');
    const planted = bundle.replace(/\}\)\(\);\s*$/, `${PLANTED_NAMES}})();\n`);
    assert.notEqual(planted, bundle, 'the planted names were not inserted');
    assert.deepEqual(undocumentedNames(planted, contract), [
      'attribute data-planted',
      'attribute data-planted-constant',
      'class deck-undocumented-state',
      'class slide-undocumented-part',
      'element planted-element',
      'event plantedchange',
      'global plantedDeck',
      'id deck-secret-panel',
      'id planted-button',
    ]);
  });
});

describe("the bundler's own scanner (non-vacuity)", () => {
  const directory = mkdtempSync(join(tmpdir(), 'papeleria-scan-'));
  after(() => rmSync(directory, {recursive: true, force: true}));

  // Each form is written as esbuild prints it; the fetch, eval, Function,
  // .constructor, worker, worklet, script, Image, timer and markup forms all
  // passed the call-shape scan this replaced.
  const planted: [string, string, RegExp][] = [
    ['dynamic-import', 'const loaded = import("./more.js");\n', /dynamic import/],
    ['static-import', 'import x from "y";\n', /import or export statement/],
    ['require', 'const fs = require("fs");\n', /require\(\)/],
    ['fetch', 'fetch("data.json");\n', /contains fetch/],
    ['fetch-bracket', 'globalThis["fetch"]("data.json");\n', /contains fetch/],
    ['fetch-optional-call', 'window.fetch?.("data.json");\n', /contains fetch/],
    ['fetch-alias', 'const get = window.fetch;\nget("data.json");\n', /contains fetch/],
    ['fetch-reference', 'Promise.resolve("data.json").then(fetch);\n', /contains fetch/],
    ['fetch-later', 'fetchLater("data.json");\n', /contains fetch/],
    ['xhr', 'new XMLHttpRequest();\n', /XMLHttpRequest/],
    ['beacon', 'navigator.sendBeacon("x", "y");\n', /sendBeacon/],
    ['websocket', 'new WebSocket("x");\n', /WebSocket/],
    ['event-source', 'new EventSource("x");\n', /EventSource/],
    ['import-scripts', 'importScripts("more.js");\n', /importScripts/],
    ['worker', 'new Worker("more.js");\n', /a worker/],
    ['shared-worker-alias', 'const Shared = SharedWorker;\nnew Shared("more.js");\n', /a worker/],
    ['service-worker', 'navigator.serviceWorker.register("sw.js");\n', /a service worker/],
    ['worklet', 'CSS.paintWorklet.addModule("paint.js");\n', /a worklet/],
    ['eval', 'eval("1");\n', /contains eval/],
    ['eval-indirect', '(0, eval)("1");\n', /contains eval/],
    ['eval-optional-call', 'globalThis.eval?.("1");\n', /contains eval/],
    ['function-constructor', 'new Function("return 1");\n', /Function constructor/],
    ['function-tagged', 'Function`return 1`;\n', /Function constructor/],
    ['function-reflect', 'Reflect.construct(Function, ["return 1"]);\n', /Function constructor/],
    ['constructor-property', '(() => {\n}).constructor("return 1");\n', /\.constructor lookup/],
    ['constructor-bracket', '(() => {\n})["constructor"]("return 1");\n', /\.constructor lookup/],
    ['script-element', 'const s = document.createElement("script");\ns.src = "more.js";\ndocument.head.append(s);\n', /script element/],
    ['image', 'new Image().src = "pixel.gif?x=1";\n', /an Image/],
    ['string-timeout', 'setTimeout("document.title = 1", 0);\n', /timer given a string/],
    ['string-interval', "setInterval('document.title = 1', 10);\n", /timer given a string/],
    ['inner-html', 'document.body.innerHTML = "<b>x</b>";\n', /markup parsed from a string/],
    ['outer-html', 'document.body.outerHTML = "<b>x</b>";\n', /markup parsed from a string/],
    ['insert-adjacent-html', 'document.body.insertAdjacentHTML("beforeend", "<b>x</b>");\n', /markup parsed from a string/],
    ['document-write', 'document.write("<b>x</b>");\n', /markup parsed from a string/],
    ['contextual-fragment', 'document.createRange().createContextualFragment("<b>x</b>");\n', /markup parsed from a string/],
    ['absolute-url', 'const u = "https://example.invalid/a.png";\n', /absolute URL/],
    ['protocol-relative', 'const u = "//example.invalid/a.png";\n', /protocol-relative URL/],
    ['root-relative', 'const u = "/assets/a.png";\n', /root-relative path/],
    ['source-map', 'const a = 1;\n//# sourceMappingURL=deck.js.map\n', /source map reference/],
  ];
  for (const [name, source, message] of planted) {
    test(`a planted ${name} fails the scan`, async () => {
      const file = join(directory, `${name}.js`);
      writeFileSync(file, source);
      const result = await runCheckScript('bundle-clients.mjs', ['--scan', file]);
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, message);
      // The independent list above must catch it too.
      assert.ok(
        NEVER_IN_BUNDLE.some(([, pattern]) => pattern.test(source)),
        `this test's own list of what the bundle must never contain misses ${name}`,
      );
    });
  }

  test('the real bundle passes the same scan', async () => {
    const result = await runCheckScript('bundle-clients.mjs', ['--scan', bundlePath]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /scan clean/);
  });

  test('usage mistakes exit 2', async () => {
    assert.equal((await runCheckScript('bundle-clients.mjs', ['--scan'])).code, 2);
    assert.equal((await runCheckScript('bundle-clients.mjs', ['--unknown'])).code, 2);
  });
});
