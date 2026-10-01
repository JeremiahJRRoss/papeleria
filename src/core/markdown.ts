/**
 * M1.3: Markdown for text fields (IC01, IC02).
 *
 * markdown-it renders with raw HTML off, so `<b>` shows as the text `<b>` and
 * never runs; footnotes are on; bare URLs are not turned into links. Markdown
 * image syntax is refused (R09): pictures belong in an image block, where
 * alternative text, credit and rights are explicit. Links are classified by
 * the IC02 navigation policy; a refused link is reported (R09) and rendered as
 * its text, as is a link whose text holds a footnote or an autolink, whose own
 * anchor could not nest inside it (D164(e)). Brackets written as a link whose
 * own text holds a footnote reference or another link, which markdown-it keeps
 * as text, are reported too. An external link keeps a normal anchor and
 * carries a visible mark and the localized "External link" hint; no `target`
 * is set, so no `rel` is needed (D151).
 *
 * Headings are rebased to the hierarchy of the field that holds the text: a
 * `#` becomes `h{baseLevel}`, deeper levels follow and stop at h6. Titles and
 * leads accept inline formatting only and render without block structure, with
 * a renderer that has no footnotes at all (D150). Footnote ids carry a
 * per-field prefix so several fields on one page never share an id.
 *
 * Every image and link is located where it is written. The rules that create
 * them are wrapped to record the offset at which each construct starts, in
 * the inline content markdown-it parsed, including the nested parses of image
 * text and inline footnotes; the block's line map then turns that offset into
 * a line and column of the source. Where the content cannot be matched to its
 * source line exactly, the line is kept and the column is null. Work is linear
 * in the size of the text.
 */
import markdownIt, {type MarkdownIt, type StateCore, type StateInline, type Token} from 'markdown-it';
import footnote from 'markdown-it-footnote';

import {quoteValue} from './finding.js';
import {LineIndex} from './positions.js';
import type {LinkKind} from './types.js';

export type MarkdownIssue = {
  readonly kind: 'image' | 'link';
  readonly message: string;
  readonly fix: string;
  /** 1-based line within the Markdown source, or null when only the field is known. */
  readonly line: number | null;
  readonly column: number | null;
};

export type MarkdownResult = {
  readonly html: string;
  readonly issues: readonly MarkdownIssue[];
  /**
   * Whether the HTML carries ids made from `docId`. Only footnotes do (D150), so
   * a text without them renders the same whichever field holds it.
   */
  readonly fieldIds: boolean;
};

export type MarkdownOptions = {
  /** The heading level a Markdown `#` becomes: one below the heading of the containing slide, column or section. */
  readonly baseLevel: number;
  /** A per-field prefix for footnote ids, such as the field's JSON pointer. */
  readonly docId: string;
  /** The localized `external_link` string. */
  readonly externalLinkLabel: string;
};

export type InlineMarkdownOptions = {readonly externalLinkLabel: string};

/** A title or lead, with its plain text beside the HTML (see `InlineText`). */
export type InlineMarkdownResult = MarkdownResult & {readonly text: string};

export type LinkClass = {readonly ok: true; readonly kind: LinkKind} | {readonly ok: false; readonly reason: string};

type RenderEnv = {docId?: string; externalLinkLabel: string};

const LINK_FIX = 'Use an https, http, mailto or tel address, a relative link or a #fragment.';
const IMAGE_FIX = 'Use an image block, which carries the alternative text, credit and rights, instead of Markdown image syntax.';

/** Removes leading and trailing C0 controls and spaces, as a browser does to an href. Linear. */
function trimControlsAndSpaces(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) {
    start += 1;
  }
  while (end > start && value.charCodeAt(end - 1) <= 0x20) {
    end -= 1;
  }
  return value.slice(start, end);
}

/** An href as a browser reads it before resolving it: surrounding spaces and controls trimmed, tabs and line breaks removed. */
export function hrefAsRead(href: string): string {
  return trimControlsAndSpaces(href).replace(/[\t\n\r]/g, '');
}

/**
 * The IC02 navigation policy for one link. The value is normalized the way a
 * browser reads an href — surrounding spaces and controls trimmed, tabs and
 * line breaks removed, a backslash counted as a slash — so what is checked is
 * what would be followed. Percent escapes are not decoded: a browser does not
 * decode them in a scheme either.
 */
export function classifyLink(href: string): LinkClass {
  const value = hrefAsRead(href);
  if (/^[\\/]{2}/.test(value)) {
    return {ok: false, reason: 'a protocol-relative address, which could load from any host'};
  }
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value);
  if (scheme !== null) {
    const name = scheme[1]!.toLowerCase();
    if (name === 'https' || name === 'http') {
      return {ok: true, kind: 'external'};
    }
    if (name === 'mailto') {
      return {ok: true, kind: 'mail'};
    }
    if (name === 'tel') {
      return {ok: true, kind: 'phone'};
    }
    return {ok: false, reason: `the ${name}: scheme, which is not allowed`};
  }
  if (value.startsWith('#')) {
    return {ok: true, kind: 'fragment'};
  }
  if (value.startsWith('/') || value.startsWith('\\')) {
    return {ok: false, reason: 'an address from the root of the site, which breaks when the piece opens from disk'};
  }
  return {ok: true, kind: 'relative'};
}

// ---------------------------------------------------------------------------
// Where each construct is written.

/**
 * The block-level inline token a construct belongs to, named by its children
 * array (the array a top-level inline parse fills), and the offset of the
 * construct in that token's content.
 */
type Written = {readonly origin: Token[]; readonly offset: number};

/** A nested parse's place in its block: the same origin, and where its text starts in the block's content. */
type Context = {readonly origin: Token[]; readonly base: number};

/** Where a `[` that the author wrote as a link, and its own text kept from being one, starts; and what that text holds. */
type BrokenLink = {readonly offset: number; readonly footnote: boolean; readonly link: boolean};

type Tracker = {readonly written: WeakMap<Token, Written>; readonly broken: WeakMap<Token[], BrokenLink[]>};

/**
 * One inline parse under way: where its text is; how many links around the
 * current position have their text being read; how many footnote references
 * and links written with a `[` were made outside any link so far; and each `[`
 * kept as text and not yet closed, with those counts as they were before it.
 */
type Frame = {
  readonly context: Context;
  inLink: number;
  footnotes: number;
  links: number;
  readonly open: {readonly offset: number; readonly footnotes: number; readonly links: number}[];
};

/** The inline rules that create links, images and footnote references, with how far past the rule's start a nested parse begins. */
const TRACKED_RULES: readonly {name: string; nestedAt: number | null; creates: 'link_open' | 'image' | 'footnote_ref'}[] = [
  {name: 'link', nestedAt: null, creates: 'link_open'},
  {name: 'image', nestedAt: 2, creates: 'image'},
  {name: 'autolink', nestedAt: null, creates: 'link_open'},
  {name: 'footnote_inline', nestedAt: 2, creates: 'footnote_ref'},
  {name: 'footnote_ref', nestedAt: null, creates: 'footnote_ref'},
];

/**
 * Wraps the rules in TRACKED_RULES so each link and image token records where
 * it is written. Rules run synchronously and nested parses are well nested, so
 * a single pending context hands a nested parse its base offset.
 *
 * It also finds the links an author wrote whose own text kept them from being
 * links: markdown-it makes no link of `[words [^1]](address)` or
 * `[more [inner][ref]](address)`, because the text holds a construct that
 * starts with `[`, and keeps the brackets and the address as text (W5R-03).
 * Every `[` and `]` that no rule takes reaches a last rule, which pairs them
 * outside any link; a pair around a footnote reference or a link written with
 * a `[`, closed right before a `(` or a `[`, is recorded by its origin. An
 * escaped or entity-written bracket is taken by its own rule and never
 * reaches it. Each step is constant, so the work stays linear.
 */
function trackPositions(md: MarkdownIt): Tracker {
  const written = new WeakMap<Token, Written>();
  const broken = new WeakMap<Token[], BrokenLink[]>();
  const contexts = new WeakMap<Token[], Context>();
  const frames: Frame[] = [];
  let pending: Context | null = null;

  const inline = md.inline;
  const parse = inline.parse.bind(inline);
  inline.parse = (source, parser, env, outTokens) => {
    if (pending !== null) {
      contexts.set(outTokens, pending);
      pending = null;
    }
    frames.push({context: contexts.get(outTokens) ?? {origin: outTokens, base: 0}, inLink: 0, footnotes: 0, links: 0, open: []});
    try {
      parse(source, parser, env, outTokens);
    } finally {
      frames.pop();
    }
  };
  const contextOf = (state: StateInline): Context => contexts.get(state.tokens) ?? {origin: state.tokens, base: 0};

  for (const tracked of TRACKED_RULES) {
    const index = inline.ruler.__find__(tracked.name);
    if (index === -1) {
      continue;
    }
    const rule = inline.ruler.__rules__[index]!.fn;
    inline.ruler.at(tracked.name, (state, silent) => {
      if (silent) {
        return rule(state, silent);
      }
      const start = state.pos;
      const before = state.tokens.length;
      const context = contextOf(state);
      if (tracked.nestedAt !== null) {
        pending = {origin: context.origin, base: context.base + start + tracked.nestedAt};
      }
      const frame = frames.at(-1);
      const outside = frame !== undefined && frame.inLink === 0;
      // The link rule reads its text with this parse's own tokenizer: brackets there belong to the link.
      const readsText = frame !== undefined && tracked.name === 'link';
      if (readsText) {
        frame.inLink += 1;
      }
      try {
        const ok = rule(state, silent);
        if (ok) {
          for (let at = before; at < state.tokens.length; at += 1) {
            const token = state.tokens[at]!;
            if (token.type === tracked.creates) {
              written.set(token, {origin: context.origin, offset: context.base + start});
              break;
            }
          }
          if (outside && state.src.charCodeAt(start) === 0x5b /* [ */) {
            if (tracked.creates === 'footnote_ref') {
              frame.footnotes += 1;
            } else if (tracked.creates === 'link_open') {
              frame.links += 1;
            }
          }
        }
        return ok;
      } finally {
        pending = null;
        if (readsText) {
          frame.inLink -= 1;
        }
      }
    });
  }

  inline.ruler.push('papeleria_brackets', (state, silent) => {
    const frame = frames.at(-1);
    if (silent || frame === undefined || frame.inLink > 0) {
      return false;
    }
    const code = state.src.charCodeAt(state.pos);
    if (code === 0x5b /* [ */) {
      frame.open.push({offset: state.pos, footnotes: frame.footnotes, links: frame.links});
    } else if (code === 0x5d /* ] */) {
      const opened = frame.open.pop();
      const next = state.src.charCodeAt(state.pos + 1);
      if (opened !== undefined && (next === 0x28 /* ( */ || next === 0x5b /* [ */)) {
        const footnote = frame.footnotes > opened.footnotes;
        const link = frame.links > opened.links;
        if (footnote || link) {
          const found = broken.get(frame.context.origin) ?? [];
          found.push({offset: frame.context.base + opened.offset, footnote, link});
          broken.set(frame.context.origin, found);
        }
      }
    }
    // The character stays text, as it would without this rule.
    return false;
  });
  return {written, broken};
}

/** What markdown-it-footnote keeps in the render environment: one entry per footnote, inline or referenced. */
type FootnoteEnv = {
  footnotes?: {list?: {readonly label?: string; readonly count?: number; readonly content?: string; readonly tokens?: Token[]}[]};
};

/**
 * markdown-it-footnote's `footnote_tail` rule, step for step, except that each
 * footnote's tokens are appended in place. The plugin joins them with
 * `concat`, which copies the whole token list once per footnote, so rendering
 * was quadratic in the number of footnotes: 40,000 took a minute (D151). The
 * tokens produced are the same, in the same order: definitions leave the text
 * and are kept by label; then, per footnote in the order first referenced, its
 * tokens, a back-reference for each time it was referenced, inside its last
 * paragraph when it ends with one.
 *
 * Adapted from markdown-it-footnote 4.0.0 (MIT licence, Copyright (c)
 * 2014-2015 Vitaly Puzrin, Alex Kocharin): the closing lines, which emit the
 * plugin's own tokens, are the same as its (the similarity scan, D144).
 */
function footnoteTail(state: StateCore): void {
  const footnotes = (state.env as FootnoteEnv).footnotes;
  if (!footnotes) {
    return;
  }
  const definitions = new Map<string, Token[]>();
  const text: Token[] = [];
  let inside = false;
  let current: Token[] = [];
  let label = '';
  for (const token of state.tokens) {
    if (token.type === 'footnote_reference_open') {
      inside = true;
      current = [];
      label = token.meta?.['label'] as string;
    } else if (token.type === 'footnote_reference_close') {
      inside = false;
      definitions.set(label, current);
    } else if (inside) {
      current.push(token);
    } else {
      text.push(token);
    }
  }
  state.tokens = text;

  const list = footnotes.list;
  if (!list) {
    return;
  }
  state.tokens.push(new state.Token('footnote_block_open', '', 1));
  // As in the plugin, a footnote with neither tokens nor a label would repeat the previous one's.
  let tokens: Token[] | undefined;
  for (const [id, footnote] of list.entries()) {
    const open = new state.Token('footnote_open', '', 1);
    open.meta = {id, label: footnote.label};
    state.tokens.push(open);
    if (footnote.tokens) {
      const paragraphOpen = new state.Token('paragraph_open', 'p', 1);
      paragraphOpen.block = true;
      const inline = new state.Token('inline', '', 0);
      inline.children = footnote.tokens;
      inline.content = footnote.content ?? '';
      const paragraphClose = new state.Token('paragraph_close', 'p', -1);
      paragraphClose.block = true;
      tokens = [paragraphOpen, inline, paragraphClose];
    } else if (footnote.label) {
      tokens = definitions.get(footnote.label);
    }
    for (const token of tokens ?? []) {
      state.tokens.push(token);
    }
    const lastParagraph = state.tokens.at(-1)!.type === 'paragraph_close' ? state.tokens.pop()! : null;
    const anchors = footnote.count !== undefined && footnote.count > 0 ? footnote.count : 1;
    for (let subId = 0; subId < anchors; subId += 1) {
      const anchor = new state.Token('footnote_anchor', '', 0);
      anchor.meta = {id, subId, label: footnote.label};
      state.tokens.push(anchor);
    }
    if (lastParagraph !== null) {
      state.tokens.push(lastParagraph);
    }
    state.tokens.push(new state.Token('footnote_close', '', -1));
  }
  state.tokens.push(new state.Token('footnote_block_close', '', -1));
}

function createRenderer(withFootnotes: boolean): {md: MarkdownIt; tracker: Tracker} {
  const md = markdownIt({html: false, linkify: false, typographer: false, breaks: false});
  if (withFootnotes) {
    md.use(footnote);
    md.core.ruler.at('footnote_tail', footnoteTail);
  }
  // Every link becomes a token so this module can classify and report it; the
  // default validator would silently leave a refused link as literal text.
  md.validateLink = () => true;
  const escape = md.utils.escapeHtml;

  // A hard break is a bare <br>, as the kit writes it: markdown-it's own "<br>\n"
  // would put a space into the text a reader and the A4 comparison see (D164).
  md.renderer.rules['hardbreak'] = () => '<br>';
  md.renderer.rules['link_open'] = (tokens, index, options, _env, self) =>
    tokens[index]!.meta?.papeleria === 'drop' ? '' : self.renderToken(tokens, index, options);
  md.renderer.rules['link_close'] = (tokens, index, options, env, self) => {
    const marker = tokens[index]!.meta?.papeleria;
    if (marker === 'drop') {
      return '';
    }
    if (marker === 'external') {
      const label = (env as RenderEnv).externalLinkLabel;
      return `<span class="link-external-mark" aria-hidden="true">↗</span><span class="sr-only"> (${escape(label)})</span></a>`;
    }
    return self.renderToken(tokens, index, options);
  };
  // Image syntax is refused; if it is rendered at all (a preview), only its words appear.
  md.renderer.rules['image'] = (tokens, index, options, env, self) =>
    escape(self.renderInlineAsText(tokens[index]!.children ?? [], options, env));
  return {md, tracker: trackPositions(md)};
}

/** Block text: footnotes on. */
const blockRenderer = createRenderer(true);
/** Titles and leads: inline formatting only, so no footnotes either. */
const inlineRenderer = createRenderer(false);

/** The source as markdown-it reads it: every line break a `\n`, NUL replaced. Line and column numbers are unchanged. */
function normalizedLines(source: string): string[] {
  return source.replace(/\r\n?/g, '\n').replace(/\0/g, '\uFFFD').split('\n');
}

type Position = {line: number | null; column: number | null};

/**
 * Turns content offsets into source positions. Block content is the source
 * lines of the block's map with container markers and indentation removed, so
 * each content line is found as the end of its source line; inline content
 * (a title or lead) is the source itself. The cells of a table row share one
 * source line and are found along it in order.
 *
 * Where a content line starts in its source line is worked out once, the first
 * time an issue on it is located, and a table row's cells all at once: many
 * issues on one long line cost one search, not one search each (D151).
 */
class Locator {
  readonly #lines: readonly string[];
  readonly #inline: boolean;
  readonly #blocks = new Map<Token[], {readonly token: Token; readonly map: readonly [number, number] | null}>();
  readonly #contentLines = new Map<Token, LineIndex>();
  /** The cells of each table row in order, by the row's source line, and the row of each cell. */
  readonly #rows = new Map<number, Token[]>();
  readonly #rowOf = new Map<Token, number>();
  /** Where each located content line of a block starts in its source line, 0-based; null when it cannot be matched exactly. */
  readonly #starts = new Map<Token, Map<number, number | null>>();
  /** For a cell with escaped pipes, the offsets of the pipes in its content: each was `\|` in the source. */
  readonly #pipes = new Map<Token, number[]>();

  constructor(source: string, tokens: readonly Token[], inline: boolean) {
    this.#lines = inline ? [] : normalizedLines(source);
    this.#inline = inline;
    // A table cell's inline token has no map of its own; its row's is the nearest before it.
    let lastMap: readonly [number, number] | null = null;
    let previous: Token | undefined;
    for (const token of tokens) {
      if (token.map !== null && token.map !== undefined) {
        lastMap = token.map as [number, number];
      }
      if (token.type === 'inline' && token.children !== null) {
        const own = (token.map as [number, number] | null | undefined) ?? null;
        this.#blocks.set(token.children, {token, map: own ?? lastMap});
        if (own === null && lastMap !== null && (previous?.type === 'th_open' || previous?.type === 'td_open')) {
          const row = this.#rows.get(lastMap[0]) ?? [];
          row.push(token);
          this.#rows.set(lastMap[0], row);
          this.#rowOf.set(token, lastMap[0]);
        }
      }
      previous = token;
    }
  }

  locate(written: Written | undefined): Position {
    if (written === undefined) {
      return {line: null, column: null};
    }
    const found = this.#blocks.get(written.origin);
    if (found === undefined) {
      return {line: null, column: null};
    }
    const block = found.token;
    let index = this.#contentLines.get(block);
    if (index === undefined) {
      index = new LineIndex(block.content);
      this.#contentLines.set(block, index);
    }
    const inContent = index.position(Math.min(written.offset, block.content.length));
    if (this.#inline) {
      return {line: inContent.line, column: inContent.column};
    }
    const map = found.map;
    if (map === null) {
      return {line: null, column: null};
    }
    const sourceLine = map[0] + inContent.line - 1;
    if (sourceLine >= map[1] || sourceLine >= this.#lines.length) {
      return {line: map[0] + 1, column: null};
    }
    let starts = this.#starts.get(block);
    if (starts === undefined || !starts.has(inContent.line)) {
      const row = this.#rowOf.get(block);
      if (row === undefined) {
        starts ??= new Map();
        this.#starts.set(block, starts);
        starts.set(inContent.line, this.#lineStart(block.content, inContent.offset - (inContent.column - 1), sourceLine));
      } else {
        this.#locateRow(row);
        starts = this.#starts.get(block)!;
      }
    }
    const start = starts.get(inContent.line)!;
    if (start === null) {
      return {line: sourceLine + 1, column: null};
    }
    // Each escaped pipe before the construct is one backslash longer in the source.
    const pipes = this.#pipes.get(block) ?? [];
    let before = 0;
    let after = pipes.length;
    while (before < after) {
      const middle = (before + after) >> 1;
      if (pipes[middle]! < inContent.offset) {
        before = middle + 1;
      } else {
        after = middle;
      }
    }
    return {line: sourceLine + 1, column: start + inContent.column + before};
  }

  /**
   * Where the content line starting at `lineStart` begins in its source line:
   * where the source line ends with it, or its one occurrence there.
   */
  #lineStart(content: string, lineStart: number, sourceLine: number): number | null {
    const lineEnd = content.indexOf('\n', lineStart);
    const contentLine = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd).trimEnd();
    const text = this.#lines[sourceLine]!.trimEnd();
    if (text.endsWith(contentLine)) {
      return text.length - contentLine.length;
    }
    if (contentLine === '') {
      return null;
    }
    const at = text.indexOf(contentLine);
    return at !== -1 && text.indexOf(contentLine, at + 1) === -1 ? at : null;
  }

  /**
   * Finds every cell of a table row along its source line, last cell first:
   * each is the last occurrence of its source text that ends before the cell
   * after it, so a container marker before the row or a repeated text is
   * never taken for a cell. markdown-it removes the backslash of an escaped
   * pipe from a cell, so a cell's source text has `\|` for each `|`. A cell
   * that cannot be found leaves the cells before it without a column rather
   * than risk a wrong one.
   */
  #locateRow(row: number): void {
    const text = this.#lines[row]!;
    let end: number | null = text.length;
    const cells = this.#rows.get(row)!;
    for (let index = cells.length - 1; index >= 0; index -= 1) {
      const cell = cells[index]!;
      let start: number | null = null;
      if (end !== null && cell.content !== '') {
        const written = cell.content.replaceAll('|', '\\|');
        const found: number = end - written.length < 0 ? -1 : text.lastIndexOf(written, end - written.length);
        if (found === -1) {
          end = null;
        } else {
          start = found;
          // At least the pipe that ends the cell before this one lies between them.
          end = found - 1;
          if (written.length !== cell.content.length) {
            this.#pipes.set(cell, [...cell.content.matchAll(/\|/g)].map((match) => match.index));
          }
        }
      }
      this.#starts.set(cell, new Map([[1, start]]));
    }
  }
}

/**
 * Classifies every link and refuses every image, marking refused links to be
 * dropped and external ones to carry their mark. Each link's closing token is
 * the first `link_close` after it at the same level, found by a forward scan
 * that ends there, so the whole pass is linear.
 */
function inspect(tokens: readonly Token[], source: string, inline: boolean, tracker: Tracker, md: MarkdownIt): MarkdownIssue[] {
  const issues: MarkdownIssue[] = [];
  const locator = new Locator(source, tokens, inline);

  const visit = (children: Token[]): void => {
    for (let index = 0; index < children.length; index += 1) {
      const token = children[index]!;
      if (token.type === 'image') {
        // The src is normalized (percent-encoded), as a link's href is; the author wrote the decoded form.
        const src = md.normalizeLinkText(String(token.attrGet('src') ?? ''));
        issues.push({
          kind: 'image',
          message: `Markdown image syntax is not allowed${src === '' ? '' : ` (${quoteValue(src, 'none')})`}.`,
          fix: IMAGE_FIX,
          ...locator.locate(tracker.written.get(token)),
        });
        continue;
      }
      if (token.type !== 'link_open') {
        continue;
      }
      let close: Token | undefined;
      // A footnote reference and an autolink render their own anchors, which may not sit inside this one.
      const footnotes: Token[] = [];
      const links: Token[] = [];
      for (let at = index + 1; at < children.length; at += 1) {
        const candidate = children[at]!;
        if (candidate.type === 'link_close' && candidate.level === token.level) {
          close = candidate;
          break;
        }
        if (candidate.type === 'footnote_ref') {
          footnotes.push(candidate);
        } else if (candidate.type === 'link_open') {
          links.push(candidate);
        }
      }
      const href = String(token.attrGet('href') ?? '');
      const verdict = classifyLink(href);
      if (!verdict.ok || footnotes.length > 0 || links.length > 0) {
        // The href is normalized (percent-encoded); the author wrote the decoded form.
        // Hidden characters shown and a long address cut, as every quoted author value is (D175).
        const shown = quoteValue(md.normalizeLinkText(href), 'none');
        if (!verdict.ok) {
          issues.push({kind: 'link', message: `The link to ${shown} uses ${verdict.reason}.`, fix: LINK_FIX, ...locator.locate(tracker.written.get(token))});
        }
        for (const footnote of footnotes) {
          issues.push({
            kind: 'link',
            message: `The link to ${shown} has a footnote inside its text.`,
            fix: 'Move the footnote after the link.',
            ...locator.locate(tracker.written.get(footnote)),
          });
        }
        for (const link of links) {
          issues.push({
            kind: 'link',
            message: `The link to ${shown} has another link inside its text.`,
            fix: 'Move the inner link out of the link text.',
            ...locator.locate(tracker.written.get(link)),
          });
        }
        // Rendered as its text, like a refused link, so the HTML stays valid and an inner anchor stays one.
        token.meta = {...token.meta, papeleria: 'drop'};
        if (close !== undefined) {
          close.meta = {...close.meta, papeleria: 'drop'};
        }
      } else if (verdict.kind === 'external') {
        token.attrJoin('class', 'link-external');
        if (close !== undefined) {
          close.meta = {...close.meta, papeleria: 'external'};
        }
      }
    }
    // Brackets written as a link that their own text kept from being one; the text is left as markdown-it made it.
    for (const found of tracker.broken.get(children) ?? []) {
      const holds = found.footnote && found.link ? 'a footnote or another link' : found.footnote ? 'a footnote' : 'another link';
      issues.push({
        kind: 'link',
        message: `Link text cannot hold ${holds}, so this link would show as plain text, brackets and address included.`,
        fix: found.footnote && found.link ? 'Move the footnote and the inner link out of the link text.' : found.footnote ? 'Move the footnote after the link.' : 'Move the inner link out of the link text.',
        ...locator.locate({origin: children, offset: found.offset}),
      });
    }
  };

  for (const token of tokens) {
    if (token.type === 'inline' && token.children !== null) {
      visit(token.children);
    }
  }
  return issues;
}

/** A footnote-id prefix from any text: letters, digits and hyphens only. */
export function markdownDocId(text: string): string {
  const id = text.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return id === '' ? 'text' : id;
}

/** Renders a text field's Markdown with headings rebased and the IC02 link policy applied. */
export function renderMarkdown(source: string, options: MarkdownOptions): MarkdownResult {
  if (!Number.isInteger(options.baseLevel) || options.baseLevel < 1 || options.baseLevel > 6) {
    throw new Error(`E_INTERNAL: baseLevel ${options.baseLevel} is not a heading level`);
  }
  const {md, tracker} = blockRenderer;
  const env: RenderEnv = {docId: markdownDocId(options.docId), externalLinkLabel: options.externalLinkLabel};
  const tokens = md.parse(source, env);
  for (const token of tokens) {
    if (token.type === 'heading_open' || token.type === 'heading_close') {
      const level = Number(token.tag.slice(1));
      token.tag = `h${Math.min(6, options.baseLevel + level - 1)}`;
    }
  }
  const issues = inspect(tokens, source, false, tracker, md);
  // Footnote ids exist exactly when some footnote is referenced: an unused definition renders nothing.
  const fieldIds = ((env as RenderEnv & FootnoteEnv).footnotes?.list?.length ?? 0) > 0;
  return {html: md.renderer.render(tokens, md.options, env), issues, fieldIds};
}

/**
 * The words inline tokens show, as plain text: text and code content, the
 * words of an image, one space for a soft or hard line break. Link markup,
 * and with it the external-link mark and hint, adds nothing. Not escaped.
 */
function plainText(tokens: readonly Token[]): string {
  let text = '';
  for (const token of tokens) {
    if (token.type === 'text' || token.type === 'code_inline') {
      text += token.content;
    } else if (token.type === 'softbreak' || token.type === 'hardbreak') {
      text += ' ';
    } else if (token.type === 'inline' || token.type === 'image') {
      text += plainText(token.children ?? []);
    }
  }
  return text;
}

/** Renders a title or lead: inline formatting only, no headings, lists, paragraphs or footnotes. */
export function renderInlineMarkdown(source: string, options: InlineMarkdownOptions): InlineMarkdownResult {
  const {md, tracker} = inlineRenderer;
  const env: RenderEnv = {externalLinkLabel: options.externalLinkLabel};
  const text = source.trimEnd();
  const tokens = md.parseInline(text, env);
  const issues = inspect(tokens, text, true, tracker, md);
  return {html: md.renderer.render(tokens, md.options, env), issues, fieldIds: false, text: plainText(tokens)};
}

/** A link as the page carries it, and where it is written in its field's Markdown. */
export type MarkdownLink = {readonly href: string; readonly line: number | null; readonly column: number | null};

/**
 * The links a field's Markdown renders as anchors, in the order they render,
 * `inline` for a title or lead: what R08 names when a link leads nowhere in
 * the output (D172). A link rendered as its text, refused or holding another
 * anchor, is not one; nor are the anchors of footnotes, which the renderer
 * makes itself.
 */
export function markdownLinks(source: string, inline: boolean): MarkdownLink[] {
  const {md, tracker} = inline ? inlineRenderer : blockRenderer;
  const text = inline ? source.trimEnd() : source;
  const env: RenderEnv = {externalLinkLabel: ''};
  const tokens = inline ? md.parseInline(text, env) : md.parse(text, env);
  inspect(tokens, text, inline, tracker, md);
  const locator = new Locator(text, tokens, inline);
  const links: MarkdownLink[] = [];
  for (const token of tokens) {
    for (const child of token.type === 'inline' ? (token.children ?? []) : []) {
      if (child.type === 'link_open' && child.meta?.papeleria !== 'drop') {
        links.push({href: String(child.attrGet('href') ?? ''), ...locator.locate(tracker.written.get(child))});
      }
    }
  }
  return links;
}
