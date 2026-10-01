#!/usr/bin/env node
/**
 * Readable copies of the theme's minified stylesheets (code provenance review
 * P05, issue 002 F4, D180).
 *
 * `theme/css/site.css`, `slides.css` and `print.css` came with the design kit
 * mostly minified: a minified file with nothing readable beside it is what a
 * pasted third-party build looks like, and it hides the naming, structure and
 * comments a reviewer reads for authorship. This script writes a readable copy
 * of each to `theme/css/readable/<name>.css`: one selector, declaration and
 * brace per line, two-space indents, every comment kept where it stands, and a
 * header that says what the file is.
 *
 * The shipped files are not touched. They stay the source: the bytes every
 * piece carries, the first-view budgets count and the golden tests compare.
 * A readable copy differs from its shipped file only in whitespace, in its
 * header comment and in each block's optional last semicolon. `strippedForm`
 * and `comments` make that checkable, and the script refuses to write a copy
 * that fails it; `test/unit/theme-css.test.ts` holds each copy to its shipped
 * file through esbuild's CSS parser as well, and
 * `test/browser/theme-css.test.ts` compares the rules each browser engine
 * reads from the two.
 *
 * Usage: node scripts/theme-css.mjs [--check]
 * Exit:  0 written, or current with --check · 1 stale with --check ·
 *        2 usage, IO, or a stylesheet the formatter cannot read
 */
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const APPLICATION_ROOT = join(import.meta.dirname, '..');

/** The theme's minified stylesheets, by name under `theme/css/`. */
export const SHEETS = ['site', 'slides', 'print'];

/** The shipped stylesheet and its readable copy, relative to the application root. */
export function sheetPaths(name) {
  return {shipped: `theme/css/${name}.css`, readable: `theme/css/readable/${name}.css`};
}

class UsageError extends Error {}

/** A stylesheet the formatter will not rewrite, because it cannot read it safely. */
export class FormatError extends Error {}

/** At-rules whose block holds rules rather than declarations. */
const RULE_BLOCKS = new Set(['media', 'supports', 'layer', 'container', 'document', '-moz-document', 'scope', 'starting-style']);

/** At-rules whose prelude may open with a parenthesis that reads better after a space. */
const CONDITION_RULES = new Set(['media', 'supports', 'container']);

const WHITESPACE = /^[ \t\n\r\f]$/;
const HEX = /^[0-9a-fA-F]$/;
const NAME_CHARACTER = /^[-\w]$/;

/** Where the string opening at `start` ends (one past its closing quote). A string cut by a newline is refused. */
function stringEnd(text, start) {
  const quote = text[start];
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      index += 2;
    } else if (char === quote) {
      return index + 1;
    } else if (char === '\n') {
      throw new FormatError(`a string is cut by a line break (offset ${start})`);
    } else {
      index += 1;
    }
  }
  throw new FormatError(`a string is not closed (offset ${start})`);
}

/** Where the escape at `start` ends: a backslash and one character, or up to six hex digits and the one whitespace character that closes them. */
function escapeEnd(text, start) {
  let index = start + 1;
  if (index >= text.length) {
    return index;
  }
  if (!HEX.test(text[index])) {
    return index + 1;
  }
  while (index < text.length && index < start + 7 && HEX.test(text[index])) {
    index += 1;
  }
  if (text[index] === '\r' && text[index + 1] === '\n') {
    return index + 2;
  }
  return index < text.length && WHITESPACE.test(text[index]) ? index + 1 : index;
}

/** Whether the `(` at `index` opens an unquoted `url(`, which CSS reads as one token up to its `)`. */
function opensUnquotedUrl(text, index) {
  if (text.slice(index - 3, index).toLowerCase() !== 'url' || NAME_CHARACTER.test(text[index - 4] ?? '')) {
    return false;
  }
  let next = index + 1;
  while (next < text.length && WHITESPACE.test(text[next])) {
    next += 1;
  }
  return text[next] !== '"' && text[next] !== "'";
}

/**
 * Splits CSS text into the pieces the formatter never looks inside or changes
 * (comments, strings, escapes, unquoted `url()` arguments) and every other
 * character on its own. Each piece has the depth of parentheses and square
 * brackets it stands at; an opening bracket stands at the outer depth.
 */
export function pieces(text) {
  const found = [];
  let depth = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    let end = index + 1;
    let kind = 'char';
    let at = depth;
    if (char === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2);
      if (close === -1) {
        throw new FormatError(`a comment is not closed (offset ${index})`);
      }
      end = close + 2;
      kind = 'comment';
    } else if (char === '"' || char === "'") {
      end = stringEnd(text, index);
      kind = 'string';
    } else if (char === '\\') {
      end = escapeEnd(text, index);
      kind = 'escape';
    } else if (char === '(' && opensUnquotedUrl(text, index)) {
      end = index + 1;
      while (end < text.length && text[end] !== ')') {
        end = text[end] === '\\' ? escapeEnd(text, end) : end + 1;
      }
      if (end >= text.length) {
        throw new FormatError(`a url( is not closed (offset ${index})`);
      }
      end += 1;
      kind = 'url';
    } else if (char === '(' || char === '[') {
      depth += 1;
    } else if (char === ')' || char === ']') {
      depth = Math.max(0, depth - 1);
      at = depth;
    }
    found.push({kind, text: text.slice(index, end), depth: at});
    index = end;
  }
  return found;
}

/** Every run of whitespace outside comments, strings, escapes and url() becomes one space; CSS reads any run as one whitespace token. */
function collapse(text) {
  let out = '';
  let pendingSpace = false;
  for (const piece of pieces(text)) {
    if (piece.kind === 'char' && WHITESPACE.test(piece.text)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && out !== '') {
      out += ' ';
    }
    pendingSpace = false;
    out += piece.text;
  }
  return out;
}

/** Splits text at a character that stands outside every bracket, string and comment. */
function splitTopLevel(text, separator) {
  const parts = [''];
  for (const piece of pieces(text)) {
    if (piece.kind === 'char' && piece.depth === 0 && piece.text === separator) {
      parts.push('');
    } else {
      parts[parts.length - 1] += piece.text;
    }
  }
  return parts;
}

/**
 * Reads a stylesheet into statements: comments, blank lines between
 * statements, blocks (a prelude and the statements inside its braces) and
 * statements that end at a semicolon or at the end of their block.
 */
export function parseStylesheet(text) {
  const list = pieces(text);
  let at = 0;
  const isChar = (piece, chars) => piece !== undefined && piece.kind === 'char' && piece.depth === 0 && chars.includes(piece.text);

  function statements(topLevel) {
    const items = [];
    for (;;) {
      let newlines = 0;
      while (at < list.length && list[at].kind === 'char' && WHITESPACE.test(list[at].text)) {
        if (list[at].text === '\n') {
          newlines += 1;
        }
        at += 1;
      }
      if (newlines >= 2 && items.length > 0) {
        items.push({kind: 'blank'});
      }
      if (at >= list.length) {
        if (!topLevel) {
          throw new FormatError('a block is not closed');
        }
        return items;
      }
      if (isChar(list[at], '}')) {
        if (topLevel) {
          throw new FormatError('a } closes no block');
        }
        at += 1;
        return items;
      }
      if (list[at].kind === 'comment') {
        items.push({kind: 'comment', text: list[at].text});
        at += 1;
        continue;
      }
      let run = '';
      while (at < list.length && !isChar(list[at], '{;}')) {
        run += list[at].text;
        at += 1;
      }
      if (run.trim() === '') {
        throw new FormatError('an empty statement; the formatter keeps every token and has nowhere to put it');
      }
      if (isChar(list[at], '{')) {
        at += 1;
        items.push({kind: 'block', prelude: run, children: statements(false)});
      } else if (isChar(list[at], ';')) {
        at += 1;
        items.push({kind: 'statement', text: run, semicolon: true});
      } else if (!topLevel) {
        items.push({kind: 'statement', text: run, semicolon: false});
      } else {
        throw new FormatError('a statement at the top level ends without a semicolon or a block');
      }
    }
  }

  return statements(true);
}

/** The at-rule a prelude opens, lower-cased and without its `@`, or null for a selector. */
function atRuleName(prelude) {
  const match = /^@([-\w]+)/.exec(prelude.trim());
  return match === null ? null : match[1].toLowerCase();
}

/** Whether a block with this prelude, inside a block of `context`, holds rules or declarations. */
function contextInside(prelude) {
  const name = atRuleName(prelude);
  if (name === null) {
    return 'declarations';
  }
  return RULE_BLOCKS.has(name) || name.endsWith('keyframes') ? 'rules' : 'declarations';
}

/** A block's prelude as lines: one selector a line, or the at-rule's prelude on one line. */
function preludeLines(prelude) {
  const name = atRuleName(prelude);
  if (name !== null) {
    const line = collapse(prelude).trim();
    return [CONDITION_RULES.has(name) ? line.replace(/^(@[-\w]+)\(/, '$1 (') : line];
  }
  const selectors = splitTopLevel(prelude, ',').map((selector) => collapse(selector).trim());
  if (selectors.some((selector) => selector === '')) {
    throw new FormatError(`an empty selector in ${JSON.stringify(collapse(prelude).trim())}`);
  }
  return selectors.map((selector, index) => (index < selectors.length - 1 ? `${selector},` : selector));
}

/**
 * A declaration as `name: value`, or an at-rule statement as written. A custom
 * property's value is kept exactly as written, since its whitespace is part of
 * the value: esbuild keeps a space after the colon, and Chromium keeps a run
 * of spaces inside the value.
 */
function statementText(text, context) {
  const trimmed = collapse(text).trim();
  if (context !== 'declarations' || trimmed.startsWith('@')) {
    return trimmed;
  }
  const [name, ...rest] = splitTopLevel(text, ':');
  if (rest.length === 0) {
    return trimmed;
  }
  const property = collapse(name).trim();
  if (property.startsWith('--')) {
    return `${property}:${rest.join(':')}`;
  }
  return `${property}: ${collapse(rest.join(':')).trim()}`;
}

function formatStatements(items, depth, context) {
  const pad = '  '.repeat(depth);
  const lines = [];
  for (const item of items) {
    if (item.kind === 'blank') {
      if (lines.length > 0 && lines.at(-1) !== '') {
        lines.push('');
      }
    } else if (item.kind === 'comment') {
      lines.push(`${pad}${item.text}`);
    } else if (item.kind === 'block') {
      const prelude = preludeLines(item.prelude);
      prelude[prelude.length - 1] += ' {';
      lines.push(...prelude.map((line) => `${pad}${line}`));
      lines.push(...formatStatements(item.children, depth + 1, contextInside(item.prelude)));
      lines.push(`${pad}}`);
    } else {
      const semicolon = item.semicolon || context === 'declarations' ? ';' : '';
      lines.push(`${pad}${statementText(item.text, context)}${semicolon}`);
    }
  }
  while (lines.at(-1) === '') {
    lines.pop();
  }
  return lines;
}

/** The comments of a stylesheet, in order. */
export function comments(text) {
  return pieces(text)
    .filter((piece) => piece.kind === 'comment')
    .map((piece) => piece.text);
}

/**
 * What a formatter that changes only whitespace, comments and each block's
 * optional last semicolon cannot change: the text without comments, without
 * whitespace outside strings, and with every `;` before a `}` dropped.
 */
export function strippedForm(text) {
  let out = '';
  for (const piece of pieces(text)) {
    if (piece.kind === 'comment' || (piece.kind === 'char' && WHITESPACE.test(piece.text))) {
      continue;
    }
    if (piece.kind === 'char' && piece.text === '}') {
      out = out.replace(/;+$/, '');
    }
    out += piece.text;
  }
  return out;
}

/** The header every readable copy opens with. */
export function header(name) {
  const {shipped} = sheetPaths(name);
  return [
    `/* Readable copy of ${shipped}, which pieces ship as it is. Written by`,
    ' * scripts/theme-css.mjs: do not edit it here. It differs from the shipped file',
    " * only in whitespace, in this comment and in each block's last semicolon, and",
    ' * test/unit/theme-css.test.ts and test/browser/theme-css.test.ts hold it to',
    ' * that (code provenance review P05, D180). To change the theme, change',
    ` * ${shipped} and run node scripts/theme-css.mjs. */`,
  ].join('\n');
}

/** The readable copy of a shipped stylesheet. Refuses a result that is not the same stylesheet. */
export function formatStylesheet(text, name) {
  const body = formatStatements(parseStylesheet(text), 0, 'rules').join('\n');
  const readable = `${header(name)}\n\n${body}\n`;
  if (strippedForm(readable) !== strippedForm(text)) {
    throw new FormatError(`${name}.css: the readable copy would change more than whitespace`);
  }
  const kept = comments(readable);
  if (kept.length !== comments(text).length + 1 || kept.slice(1).some((comment, index) => comment !== comments(text)[index])) {
    throw new FormatError(`${name}.css: the readable copy would not keep every comment in order`);
  }
  return readable;
}

/** Each sheet's readable copy as the shipped file gives it, and whether the committed copy matches. */
export function readableCopies(root = APPLICATION_ROOT) {
  return SHEETS.map((name) => {
    const {shipped, readable} = sheetPaths(name);
    const expected = formatStylesheet(readFileSync(join(root, shipped), 'utf8'), name);
    let committed = null;
    try {
      committed = readFileSync(join(root, readable), 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
    return {name, shipped, readable, expected, current: committed === expected};
  });
}

function parseArguments(argv) {
  const options = {check: false};
  for (const flag of argv) {
    if (flag === '--check') {
      options.check = true;
    } else {
      throw new UsageError(`unknown argument ${JSON.stringify(flag)}`);
    }
  }
  return options;
}

function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`theme-css: ${error.message}\nusage: node scripts/theme-css.mjs [--check]\n`);
    return 2;
  }
  let copies;
  try {
    copies = readableCopies();
  } catch (error) {
    process.stderr.write(`theme-css: ${error.message}\n`);
    return 2;
  }
  if (options.check) {
    for (const copy of copies) {
      process.stdout.write(`${copy.readable}: ${copy.current ? 'current' : `stale; run node scripts/theme-css.mjs`}\n`);
    }
    return copies.every((copy) => copy.current) ? 0 : 1;
  }
  mkdirSync(join(APPLICATION_ROOT, 'theme', 'css', 'readable'), {recursive: true});
  for (const copy of copies) {
    if (!copy.current) {
      writeFileSync(join(APPLICATION_ROOT, copy.readable), copy.expected);
    }
    process.stdout.write(`${copy.readable}: ${copy.current ? 'current' : 'written'}, ${copy.expected.split('\n').length - 1} lines\n`);
  }
  return 0;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  process.exitCode = main(process.argv.slice(2));
}
