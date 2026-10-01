/**
 * The IC01 placeholder grammar, for R01.
 *
 * A placeholder is a bracketed label: an unescaped `[`, one to eighty
 * characters with no bracket and no line break, at least one of them a Unicode
 * letter, and an unescaped `]`. Numeric arrays (`[1, 2]`) are not; neither is,
 * in block text, a label that starts with `^`, which is footnote syntax there
 * (D66). A title, a lead or a plain string has no footnotes and prints
 * `[^note]` as it is written, so there it is a placeholder like any other
 * (D150, W5R-G10).
 *
 * Markdown is scanned in the author's source, never in rendered HTML, where an
 * escaped bracket looks like any other (W1A). The source is tokenized with
 * markdown-it configured as the core renders (raw HTML, linkify and typographer
 * off; footnotes in block text, not in titles) but with `text_join` off, so an
 * escaped or entity-written character stays a token of its own: `\[` and
 * `&#91;` are literal brackets and open nothing, while `\\[` is a literal
 * backslash before a bracket that does. markdown-it has settled every escape,
 * so Markdown text is searched without backslash rules of its own. Code spans
 * and blocks, link text and destinations, images and footnote references are
 * left out, as IC01 says; reference definitions never reach the tokens.
 *
 * A placeholder is placed where it is written: the source is searched for its
 * text, and the copy that is this placeholder is found by counting every copy
 * in the parsed text, those in link text and code included. When the source
 * and the parsed text do not hold the same number of copies (a copy in a link
 * destination, a label written with an entity or with formatting), the
 * placeholder keeps its block's first line and no column, rather than a
 * column that could be another copy's.
 */
import markdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';

type Token = ReturnType<ReturnType<typeof markdownIt>['parse']>[number];

/** The label may hold no bracket, not even an escaped one (LITERAL_BRACKET), and no line break. */
const LABEL = /\[([^[\]\r\n\u0000]{1,80})\]/gu;
const LETTER = /\p{L}/u;
/** Stands in for a bracket written escaped or as an entity: it is neither bracket nor letter. */
const LITERAL_BRACKET = '\u0000';

export type PlaceholderMatch = {
  /** The placeholder as written, brackets included. */
  readonly text: string;
  /** Where its `[` is in the text scanned. */
  readonly index: number;
};

function backslashesBefore(text: string, index: number): number {
  let count = 0;
  for (let at = index - 1; at >= 0 && text[at] === '\\'; at -= 1) {
    count += 1;
  }
  return count;
}

/**
 * Placeholders in text. In a plain string, which has no escapes of its own, a
 * bracket after an odd run of backslashes is literal (D66); in Markdown text,
 * already unescaped by markdown-it, `backslashEscapes` is false. `footnotes`
 * is true for block text alone, where a label starting with `^` is footnote
 * syntax.
 */
export function placeholdersInText(text: string, options: {readonly backslashEscapes?: boolean; readonly footnotes?: boolean} = {}): PlaceholderMatch[] {
  const escapes = options.backslashEscapes ?? true;
  const footnotes = options.footnotes ?? false;
  const found: PlaceholderMatch[] = [];
  for (const match of text.matchAll(LABEL)) {
    const label = match[1]!;
    const close = match.index + 1 + label.length;
    if (escapes && (backslashesBefore(text, match.index) % 2 === 1 || backslashesBefore(text, close) % 2 === 1)) {
      continue;
    }
    if (LETTER.test(label) && !(footnotes && label.startsWith('^'))) {
      found.push({text: match[0], index: match.index});
    }
  }
  return found;
}

/** Every occurrence of `text` in `source` whose `[` follows an even run of backslashes, as offsets. */
export function unescapedOccurrences(text: string, source: string): number[] {
  const found: number[] = [];
  for (let at = source.indexOf(text); at !== -1; at = source.indexOf(text, at + 1)) {
    if (backslashesBefore(source, at) % 2 === 0) {
      found.push(at);
    }
  }
  return found;
}

const block = markdownIt({html: false, linkify: false, typographer: false}).use(footnote).disable('text_join');
const inline = markdownIt({html: false, linkify: false, typographer: false}).disable('text_join');

/**
 * An inline token's text as parsed, in source order: `all` holds every
 * character a reader sees or that code shows, with a line break for each soft
 * or hard break, and `included` marks the characters a placeholder may be
 * found in, which leaves out link text, code, images and footnote references.
 */
function parsedText(children: readonly Token[]): {all: string; included: boolean[]} {
  let all = '';
  const included: boolean[] = [];
  const add = (text: string, counted: boolean): void => {
    all += text;
    for (let index = 0; index < text.length; index += 1) {
      included.push(counted);
    }
  };
  let linkDepth = 0;
  for (const token of children) {
    switch (token.type) {
      case 'link_open':
        linkDepth += 1;
        break;
      case 'link_close':
        linkDepth = Math.max(0, linkDepth - 1);
        break;
      case 'text':
        add(token.content, linkDepth === 0);
        break;
      case 'text_special':
        add(token.content === '[' || token.content === ']' ? LITERAL_BRACKET : token.content, linkDepth === 0);
        break;
      case 'softbreak':
      case 'hardbreak':
        add('\n', false);
        break;
      case 'code_inline':
        // Code keeps its brackets as code, and its copies of a label still count.
        add('\n', false);
        add(token.content, false);
        add('\n', false);
        break;
      case 'image':
      case 'footnote_ref':
        add('\n', false);
        break;
      default:
        // Emphasis and the like open and close around text without breaking it.
        break;
    }
  }
  return {all, included};
}

export type MarkdownPlaceholder = {
  readonly text: string;
  /** 1-based line and column in the Markdown source; the column is null when the copy cannot be told apart. */
  readonly line: number | null;
  readonly column: number | null;
  /** Which unescaped copy of `text` in the whole source this is, and how many there are; null when not known. */
  readonly occurrence: {readonly index: number; readonly count: number} | null;
};

type Group = {readonly map: readonly [number, number] | null; all: string; included: boolean[]};

/** The maximal stretches of true in a mask, as [start, end) pairs. */
function includedRuns(mask: readonly boolean[]): [number, number][] {
  const runs: [number, number][] = [];
  let start = -1;
  for (let index = 0; index <= mask.length; index += 1) {
    if (index < mask.length && mask[index]) {
      if (start === -1) {
        start = index;
      }
    } else if (start !== -1) {
      runs.push([start, index]);
      start = -1;
    }
  }
  return runs;
}

/** Every offset where `text` begins in `all`. */
function occurrencesIn(all: string, text: string): number[] {
  const found: number[] = [];
  for (let at = all.indexOf(text); at !== -1; at = all.indexOf(text, at + 1)) {
    found.push(at);
  }
  return found;
}

/**
 * Placeholders in Markdown source, in reading order; `inlineOnly` for a title
 * or lead, which has no block structure or footnotes. An inline parse maps to
 * its first line only, so an inline source is searched in all its lines.
 */
export function placeholdersInMarkdown(source: string, inlineOnly: boolean): MarkdownPlaceholder[] {
  const tokens: readonly Token[] = inlineOnly ? inline.parseInline(source, {}) : block.parse(source, {});
  const lineStarts = [0];
  for (const match of source.matchAll(/\r\n|\n|\r/g)) {
    lineStarts.push(match.index + match[0].length);
  }
  const lineOf = (offset: number): number => {
    let line = 0;
    while (line + 1 < lineStarts.length && lineStarts[line + 1]! <= offset) {
      line += 1;
    }
    return line;
  };

  // The cells of one table row are inline tokens that share a line span: one group.
  // markdown-it maps a row, not its cells, so a token without a map takes the span of the block around it.
  const groups: Group[] = [];
  let enclosing: [number, number] | null = null;
  for (const token of tokens) {
    if (token.type !== 'inline') {
      enclosing = (token.map as [number, number] | null | undefined) ?? enclosing;
      continue;
    }
    if (token.children === null) {
      continue;
    }
    const map = inlineOnly ? null : ((token.map as [number, number] | null | undefined) ?? enclosing);
    const parsed = parsedText(token.children);
    const last = groups.at(-1);
    if (last !== undefined && last.map !== null && map !== null && last.map[0] === map[0] && last.map[1] === map[1]) {
      last.all += `\n${parsed.all}`;
      last.included.push(false, ...parsed.included);
    } else {
      groups.push({map, all: parsed.all, included: parsed.included});
    }
  }

  const everywhere = new Map<string, number[]>();
  const found: MarkdownPlaceholder[] = [];
  for (const group of groups) {
    const [from, to] = group.map ?? [0, lineStarts.length];
    const start = lineStarts[from] ?? source.length;
    const end = to < lineStarts.length ? lineStarts[to]! : source.length;
    for (const [runStart, runEnd] of includedRuns(group.included)) {
      for (const match of placeholdersInText(group.all.slice(runStart, runEnd), {backslashEscapes: false, footnotes: !inlineOnly})) {
        const text = match.text;
        const inSource = everywhere.get(text) ?? unescapedOccurrences(text, source);
        everywhere.set(text, inSource);
        const inGroup = inSource.filter((offset) => offset >= start && offset < end);
        const parsed = occurrencesIn(group.all, text);
        const nth = parsed.indexOf(runStart + match.index);
        const offset = parsed.length === inGroup.length && nth !== -1 ? inGroup[nth] : undefined;
        if (offset === undefined) {
          found.push({text, line: group.map === null ? null : from + 1, column: null, occurrence: null});
          continue;
        }
        const line = lineOf(offset);
        found.push({text, line: line + 1, column: offset - lineStarts[line]! + 1, occurrence: {index: inSource.indexOf(offset), count: inSource.length}});
      }
    }
  }
  return found;
}
