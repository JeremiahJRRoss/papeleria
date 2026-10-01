/**
 * The DOM names a bundled client relies on, read from its text (M4.3, W4),
 * for a test that holds a client's CONTRACT.md to what the bundle does. It
 * follows the reading test/unit/deck-client.test.ts made for the deck client
 * (M1.6), which keeps its own copy, and reads two more ways a name is passed:
 * `dataset` properties, and a helper that makes an element from a tag, its
 * classes and an object of attributes, as the reader's `element()` does.
 */

export type NameKind = 'attribute' | 'class' | 'element' | 'event' | 'global' | 'id';

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

/** `zoomSrc` → `data-zoom-src`. */
function dataAttribute(property: string): string {
  return `data-${property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

/**
 * Every DOM name a bundle relies on, as "kind name": the string literals it
 * passes to a lookup, to a classList method, to an attribute method or to an
 * Event or CustomEvent constructor, written in place, held in a string
 * constant, or handed to a function that passes its one parameter straight to
 * a lookup; the `dataset` properties it reads or writes; the tag, classes and
 * attributes given to `elementHelper`; and the properties it assigns on
 * window. Names built at run time are not read.
 */
export function domNames(text: string, elementHelper = 'element'): Set<string> {
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
  for (const match of text.matchAll(new RegExp(String.raw`\.(${LOOKUPS.join('|')})(?:<[^>]*>)?\(`, 'g'))) {
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
  for (const [, quoted, bare] of text.matchAll(new RegExp(String.raw`\.dataset(?:\[\s*(${LITERAL})\s*\]|\.(${IDENTIFIER}))`, 'g'))) {
    const property = quoted !== undefined ? literalValue(quoted) : bare;
    if (property !== undefined) {
      add('attribute', dataAttribute(property));
    }
  }
  for (const match of text.matchAll(new RegExp(String.raw`(?<![\w$.])${elementHelper}\(`, 'g'))) {
    const start = (match.index ?? 0) + match[0].length;
    const [tag, classes] = literalArguments(text, start, constants);
    if (typeof tag === 'string') {
      add('element', tag.toLowerCase());
    }
    if (typeof classes === 'string') {
      for (const name of classes.split(/\s+/).filter((each) => each !== '')) {
        add('class', name);
      }
    }
    // The attributes object, when it is written in place: `{ id: "x", "aria-modal": "true" }`.
    const object = new RegExp(String.raw`^\s*(?:${LITERAL})\s*,\s*(?:${LITERAL})\s*,\s*\{([^{}]*)\}`).exec(text.slice(start));
    for (const [, quotedKey, bareKey, value] of (object?.[1] ?? '').matchAll(new RegExp(String.raw`(?:(${LITERAL})|(${IDENTIFIER}))\s*:\s*(${LITERAL})?`, 'g'))) {
      const key = quotedKey !== undefined ? literalValue(quotedKey) : bareKey;
      if (key === 'id' && value !== undefined) {
        add('id', literalValue(value));
      } else if (key !== undefined) {
        add('attribute', key);
      }
    }
  }
  for (const match of text.matchAll(/\bnew\s+(?:Custom)?Event(?:<[^>]*>)?\(/g)) {
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

/** Whether a contract mentions a name as a whole word, not inside a longer one. */
export function mentions(contract: string, name: string): boolean {
  return new RegExp(String.raw`(?<![\w-])${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?![\w-])`).test(contract);
}

/** The DOM names a bundle relies on that a contract does not mention, as "kind name", sorted. */
export function undocumentedNames(text: string, contract: string, elementHelper?: string): string[] {
  return [...domNames(text, elementHelper)].filter((entry) => !mentions(contract, entry.slice(entry.indexOf(' ') + 1))).sort();
}
