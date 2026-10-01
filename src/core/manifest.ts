/**
 * M1.1: loading the manifest with source positions.
 *
 * A piece has exactly one UTF-8 manifest, `papeleria.yaml` or `papeleria.json`
 * (IC01, C01). Both formats produce the same thing: a plain JSON-compatible
 * value, deep-frozen, and a source map from every JSON pointer to the spans of
 * its key and value, so every later stage can report a real line.
 *
 * YAML is held to YAML 1.2 core scalars, one document, unique string keys, and
 * no anchors, aliases, merge keys or custom tags (D146). The CST is walked
 * before composing because the `yaml` composer recurses: nesting beyond the
 * limit is refused at the collection that crosses it, deterministically,
 * instead of surfacing as a stack-dependent resource error.
 *
 * JSON is strict RFC 8259. An owned scanner validates the syntax, rejects
 * comments, trailing commas and duplicate keys (compared after unescaping),
 * enforces the nesting limit and records positions; only then does
 * `JSON.parse` produce the value (D147).
 *
 * `parseManifest` is pure and serves the editor's unsaved buffer as well as
 * the disk; `loadManifest` is the IO boundary that finds and reads the file.
 */
import {Buffer} from 'node:buffer';

import {Composer, Parser, isMap, isScalar, isSeq, type CST, type ParsedNode, type ScalarTag, type Tags} from 'yaml';

import {globalLocation, quoteValue, shortenForMessage, traced, type Location, type TracedFinding} from './finding.js';
import {deepFreeze} from './freeze.js';
import {INPUT_LIMITS, mebibytes} from './limits.js';
import {quoteForMessage} from './paths.js';
import {LineIndex, joinPointer, type SourceEntry, type SourceMap, type Span} from './positions.js';
import {FileChangedError, FileTooLargeError, InvalidTextEncodingError, type FileAccess, type ManifestFile, type ManifestFormat} from './types.js';

export const MANIFEST_FILES: readonly ManifestFile[] = Object.freeze(['papeleria.yaml', 'papeleria.json']);

/** The lists whose length IC01 limits, with the words used to report them. */
const COUNTED_LISTS: readonly {key: string; noun: string; template: string}[] = [
  {key: 'slides', noun: 'slides', template: 'deck'},
  {key: 'pages', noun: 'pages', template: 'comic'},
  {key: 'sections', noun: 'sections', template: 'document'},
];

export type LoadedManifest = {
  readonly file: ManifestFile;
  readonly format: ManifestFormat;
  /** The text as parsed: the file's text with a leading byte-order mark removed. */
  readonly text: string;
  /** The parsed manifest, deep-frozen. Always a mapping at the root. */
  readonly value: Readonly<Record<string, unknown>>;
  readonly sourceMap: SourceMap;
  readonly lines: LineIndex;
};

/**
 * `manifest` is null when the text cannot be used: a syntax or profile error,
 * a limit, or a schema newer than this tool. Findings may accompany a usable
 * manifest, such as a missing or invalid `schema`, so later stages still run.
 */
export type ManifestResult = {readonly manifest: LoadedManifest | null; readonly findings: readonly TracedFinding[]};

function formatBytes(bytes: number): string {
  return bytes.toLocaleString('en-US');
}

/**
 * The source map, read-only all the way down. It wraps a private Map rather
 * than extending one, so `Map.prototype.set.call` cannot reach its entries,
 * and each entry is frozen, as are the spans and positions `LineIndex` makes.
 */
class FrozenSourceMap implements ReadonlyMap<string, SourceEntry> {
  readonly #entries: Map<string, SourceEntry>;

  constructor(entries: Iterable<readonly [string, SourceEntry]>) {
    this.#entries = new Map();
    for (const [pointer, entry] of entries) {
      this.#entries.set(pointer, Object.freeze(entry));
    }
    Object.freeze(this);
  }

  get size(): number {
    return this.#entries.size;
  }

  get(pointer: string): SourceEntry | undefined {
    return this.#entries.get(pointer);
  }

  has(pointer: string): boolean {
    return this.#entries.has(pointer);
  }

  forEach(callback: (entry: SourceEntry, pointer: string, map: ReadonlyMap<string, SourceEntry>) => void, thisArg?: unknown): void {
    this.#entries.forEach((entry, pointer) => callback.call(thisArg, entry, pointer, this));
  }

  entries(): MapIterator<[string, SourceEntry]> {
    return this.#entries.entries();
  }

  keys(): MapIterator<string> {
    return this.#entries.keys();
  }

  values(): MapIterator<SourceEntry> {
    return this.#entries.values();
  }

  [Symbol.iterator](): MapIterator<[string, SourceEntry]> {
    return this.#entries[Symbol.iterator]();
  }
}

/** Sets an own property, including one named `__proto__`, without touching the prototype. */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(target, key, {value, enumerable: true, writable: true, configurable: true});
  } else {
    target[key] = value;
  }
}

/** Collects findings against one manifest file and turns offsets into locations. */
class Reporter {
  readonly findings: TracedFinding[] = [];
  readonly file: ManifestFile;
  readonly lines: LineIndex;

  constructor(file: ManifestFile, lines: LineIndex) {
    this.file = file;
    this.lines = lines;
  }

  at(offset: number): Location {
    const position = this.lines.position(offset);
    return {file: this.file, line: position.line, column: position.column};
  }

  /** A finding at a text offset; `sourcePath` defaults to that offset. */
  syntax(offset: number, message: string, fix: string, detail: string | null = null, relatedOffset?: number): void {
    this.findings.push(
      traced({
        rule: 'R09',
        message,
        fix,
        detail,
        location: this.at(offset),
        ...(relatedOffset === undefined ? {} : {relatedLocation: this.at(relatedOffset)}),
        sourcePath: `${this.file}@${offset}`,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// YAML

function isYamlSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/** The only tags a manifest may carry: the YAML 1.2 core schema's own (D146). */
const CORE_TAGS = new Set(['str', 'int', 'float', 'bool', 'null', 'map', 'seq']);

function isCoreTag(source: string): boolean {
  if (source.startsWith('!!')) {
    return CORE_TAGS.has(source.slice(2));
  }
  const verbatim = /^!<tag:yaml\.org,2002:([a-z]+)>$/.exec(source);
  return verbatim !== null && CORE_TAGS.has(verbatim[1]!);
}

type CstCollection = CST.BlockMap | CST.BlockSequence | CST.FlowCollection;

function isCstCollection(token: CST.Token | null | undefined): token is CstCollection {
  return (
    token !== null &&
    token !== undefined &&
    (token.type === 'block-map' || token.type === 'block-seq' || token.type === 'flow-collection')
  );
}

/** The offset where a collection token's content starts, for reporting. */
function collectionOffset(token: CstCollection): number {
  return token.type === 'flow-collection' ? token.start.offset : token.offset;
}

/** Where a `key: value` pair inside a flow list starts: its `?`, else its key, else its `:`. A comma before it is not part of it. */
function pairOffset(item: CST.CollectionItem): number {
  const first =
    item.start.find((token) => token.type === 'explicit-key-ind') ??
    item.key ??
    item.sep?.find((token) => token.type === 'map-value-ind') ??
    item.value;
  return first !== undefined && first !== null && 'offset' in first ? first.offset : 0;
}

/**
 * True when a quoted scalar's source ends with its own, unescaped closing quote.
 * The parser cuts a quoted value at a line end the next line does not continue,
 * and its composer checks only the last character, so `"abc\"` and `'Rosa''`
 * compose silently to `abc"` and `Rosa'` unless this check reports them.
 */
function isClosedQuote(token: {type: string; source: string}): boolean {
  const body = token.source.slice(1);
  if (token.type === 'double-quoted-scalar') {
    if (!body.endsWith('"')) {
      return false;
    }
    let backslashes = 0;
    for (let index = body.length - 2; index >= 0 && body[index] === '\\'; index -= 1) {
      backslashes += 1;
    }
    return backslashes % 2 === 0;
  }
  let quotes = 0;
  for (let index = body.length - 1; index >= 0 && body[index] === "'"; index -= 1) {
    quotes += 1;
  }
  return quotes % 2 === 1;
}

/**
 * The empty document the parser makes for a `...` that ends no document: one
 * before the manifest, or a second in a row after it. YAML 1.2 allows any
 * number of `...` lines around the one document (l-yaml-stream), so it is not
 * a document of the manifest. A real one has content, a `---` or a property.
 */
function isStrayDocument(token: CST.Token): boolean {
  return token.type === 'document' && token.value === undefined && token.start.length === 0;
}

/** Reports a quoted value that is never closed at its opening quote (D146), and returns where the parser stopped inside it. */
function reportUnclosedQuote(token: {type: string; offset: number; source: string}, report: Reporter): number {
  const end = token.offset + token.source.length;
  const line = report.lines.position(end).line;
  const quote = token.type === 'double-quoted-scalar' ? '"' : "'";
  // A value that ends in its own quotation mark looks closed; say why it is not.
  const detail =
    token.source.length > 1 && token.source.endsWith(quote)
      ? `The ${quote === '"' ? '\\"' : "''"} at the end of line ${line} is an escaped quotation mark, part of the text, so it does not close the value.`
      : `The parser reached line ${line} still inside the quotes.`;
  report.syntax(token.offset, 'This quoted value is never closed.', 'Close the value with the same quotation mark it opens with.', detail);
  return end;
}

/**
 * Walks the CST without recursion: the nesting limit, the document count,
 * directives, and every anchor, alias, tag, merge key and quoted value never
 * closed, each reported at its own token. Records where the reported quoted
 * values end and where refused tags sit, so the composer's own errors for them
 * are not reported twice. Returns false when composing would be unsafe.
 */
function checkYamlProfile(tokens: readonly CST.Token[], report: Reporter, unclosedQuoteEnds: Set<number>, refusedTags: Set<number>): boolean {
  let documents = 0;
  let firstEnd: number | undefined;
  for (const token of tokens) {
    if (token.type === 'directive') {
      const source = token.source.trim();
      if (/^%YAML\s+1\.2$/.test(source)) {
        continue;
      }
      if (/^%YAML\b/.test(source)) {
        report.syntax(
          token.offset,
          `The manifest declares ${quoteValue(source, 'none')}; only YAML 1.2 is accepted.`,
          'Remove the %YAML line, or change it to %YAML 1.2.',
        );
      } else if (/^%TAG\b/.test(source)) {
        report.syntax(token.offset, 'Custom tag handles are not supported in a manifest.', 'Remove the %TAG line and any tags that use it.');
      } else {
        report.syntax(token.offset, `The directive ${quoteValue(source.split(/\s/)[0] ?? '', 'none')} is not supported.`, 'Remove the line that starts with %.');
      }
    } else if (token.type === 'doc-end' && documents === 1) {
      firstEnd ??= token.offset;
    } else if (token.type === 'document' && !isStrayDocument(token)) {
      documents += 1;
      if (documents === 2) {
        // A second document starts at its --- line, or else right after the ... that ended the first.
        const marker = token.start.find((part) => part.type === 'doc-start');
        report.syntax(
          marker?.offset ?? firstEnd ?? token.offset,
          'The manifest contains more than one YAML document.',
          `Keep one document: remove this ${marker === undefined ? '...' : '---'} line and anything after it that is not part of the manifest.`,
        );
      }
    }
  }

  // Depth first: nothing below is safe to compose if it fails. The walk visits
  // collections in document order, as the JSON scanner does, so the first
  // crossing in the text is the one reported. A `key: value` pair written
  // inside a flow list is a one-entry mapping of its own and counts as a level.
  type Frame = {token: CST.Token; depth: number} | {pair: CST.CollectionItem; depth: number};
  const stack: Frame[] = [];
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index]!;
    if (token.type === 'document' && token.value !== undefined) {
      stack.push({token: token.value, depth: 1});
    }
  }
  let tooDeep: number | null = null;
  const pushChildren = (item: CST.CollectionItem, depth: number): void => {
    // Pushed in reverse so the key is visited before the value.
    if (item.value !== undefined && item.value !== null) {
      stack.push({token: item.value, depth});
    }
    if (item.key !== undefined && item.key !== null) {
      stack.push({token: item.key, depth});
    }
  };
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if ('pair' in frame) {
      if (frame.depth > INPUT_LIMITS.depth) {
        tooDeep = pairOffset(frame.pair);
        break;
      }
      pushChildren(frame.pair, frame.depth + 1);
      continue;
    }
    const {token, depth} = frame;
    if (!isCstCollection(token)) {
      continue;
    }
    if (depth > INPUT_LIMITS.depth) {
      tooDeep = collectionOffset(token);
      break;
    }
    const flowList = token.type === 'flow-collection' && token.start.type === 'flow-seq-start';
    for (let index = token.items.length - 1; index >= 0; index -= 1) {
      const item = token.items[index]!;
      if (flowList && (item.key !== undefined || item.sep !== undefined)) {
        stack.push({pair: item, depth: depth + 1});
      } else {
        pushChildren(item, depth + 1);
      }
    }
  }
  if (tooDeep !== null) {
    report.syntax(
      tooDeep,
      `The manifest nests more than ${INPUT_LIMITS.depth} levels deep.`,
      `Flatten the structure; the limit is ${INPUT_LIMITS.depth} nested lists and mappings, counting the top level.`,
      `Input limit: nesting depth ${INPUT_LIMITS.depth} (IC01).`,
    );
    return false;
  }

  // Anchors, aliases, tags and merge keys, wherever they sit in the token tree.
  // Arrays are pushed item by item: a list of a few hundred thousand entries
  // must not become that many arguments of one call.
  const pending: unknown[] = [...tokens];
  while (pending.length > 0) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      for (const item of node) {
        pending.push(item);
      }
      continue;
    }
    if (typeof node !== 'object' || node === null) {
      continue;
    }
    const token = node as {type?: string; offset?: number; source?: string};
    if (
      (token.type === 'double-quoted-scalar' || token.type === 'single-quoted-scalar') &&
      !isClosedQuote(token as {type: string; source: string})
    ) {
      unclosedQuoteEnds.add(reportUnclosedQuote(token as {type: string; offset: number; source: string}, report));
    }
    if (token.type === 'anchor') {
      report.syntax(
        token.offset!,
        `The anchor ${quoteValue(token.source!, 'none')} is not supported in a manifest.`,
        'Remove the anchor and write the value out in full where it is used.',
      );
    } else if (token.type === 'alias') {
      report.syntax(
        token.offset!,
        `The alias ${quoteValue(token.source!, 'none')} is not supported in a manifest.`,
        'Replace the alias with the value it stands for.',
      );
    } else if (token.type === 'tag' && !isCoreTag(token.source!)) {
      refusedTags.add(token.offset!);
      report.syntax(
        token.offset!,
        `The tag ${quoteValue(token.source!, 'none')} is not supported in a manifest.`,
        'Remove the tag. Quote the value if it must stay text.',
      );
    }
    if (token.type === 'block-map' || token.type === 'flow-collection') {
      for (const item of (node as CST.BlockMap | CST.FlowCollection).items) {
        const key = item.key;
        if (key !== undefined && key !== null && key.type === 'scalar' && key.source === '<<') {
          report.syntax(
            key.offset,
            'Merge keys (<<) are not supported in a manifest.',
            'Write the merged fields out in full in this mapping.',
          );
        }
      }
    }
    for (const value of Object.values(node)) {
      if (typeof value === 'object' && value !== null) {
        pending.push(value);
      }
    }
  }
  return true;
}

const YAML_FIXES: Readonly<Record<string, string>> = {
  TAB_AS_INDENT: 'Indent with spaces, not tabs.',
  MISSING_CHAR: 'Close the quotation mark, bracket or brace this value opens.',
  BLOCK_AS_IMPLICIT_KEY: 'Check the indentation, and quote a value that contains a colon followed by a space.',
  MULTILINE_IMPLICIT_KEY: 'Check the indentation, and quote a value that contains a colon followed by a space.',
  BAD_INDENT: 'Indent this entry to line up with the others at its level.',
  BAD_SCALAR_START: 'Quote a value that starts with @ or a backtick.',
  BAD_DQ_ESCAPE: 'Fix the backslash escape inside the double-quoted value.',
  KEY_OVER_1024_CHARS: 'Shorten the key; a manifest key is a field name.',
};

/**
 * Composer warnings that are not reported again. Anchors, aliases and
 * directives are each already refused at their own token by the profile walk.
 * BAD_INDENT is raised as a warning only for a multi-line flow list or mapping
 * whose closing bracket sits at its parent's indentation, a leniency the
 * parser grants and authors rely on; the value is unambiguous (D146).
 * TAG_RESOLVE_FAILED is handled apart: silent for a tag the walk refused,
 * reported for a core tag that does not fit its value.
 */
const TOLERATED_YAML_WARNINGS = new Set(['BAD_ALIAS', 'BAD_DIRECTIVE', 'BAD_INDENT']);

/** What each core tag requires of its value, for the report when it does not fit. */
const CORE_TAG_WORDS = new Map([
  ['int', 'a whole number'],
  ['float', 'a number'],
  ['bool', 'true or false'],
  ['null', 'null'],
  ['map', 'a mapping'],
  ['seq', 'a list'],
  ['str', 'text'],
]);

function coreTagName(source: string): string {
  return source.startsWith('!!') ? source.slice(2) : (/^!<tag:yaml\.org,2002:([a-z]+)>$/.exec(source)?.[1] ?? source);
}

/** YAML 1.2 counts a lone carriage return as a line break; the parser does not, so each becomes a line feed. Offsets are unchanged. */
function normalizeLoneCarriageReturns(text: string): string {
  return text.includes('\r') ? text.replace(/\r(?!\n)/g, '\n') : text;
}

/**
 * The YAML 1.2 core float reads a whole number too (10.3.2: the fraction and
 * the exponent are both optional), so `!!float 1` is the number 1; the
 * parser's own float tags need one or the other. Without the tag, `1` still
 * resolves as the core int, which comes first.
 */
const WHOLE_FLOAT: ScalarTag = {
  tag: 'tag:yaml.org,2002:float',
  default: true,
  test: /^[-+]?[0-9]+$/,
  resolve: (source) => parseFloat(source),
};

/** YAML 1.2 core scalars; keys, duplicates and merges are this module's own checks (D146). */
const COMPOSE_OPTIONS = {
  version: '1.2',
  schema: 'core',
  customTags: (tags: Tags): Tags => [...tags, WHOLE_FLOAT],
  merge: false,
  uniqueKeys: false,
  resolveKnownTags: false,
  strict: true,
  intAsBigInt: false,
} as const;

/** How a `schema` key is written as a plain or quoted scalar. */
const SCHEMA_KEYS = new Set(['schema', '"schema"', "'schema'"]);

/**
 * The version as the token tree gives it, before any other check: the first
 * `schema` field of the first document's root mapping, when its value is a
 * plain scalar with no tag or anchor, read as the core schema reads it (`2`,
 * `2.0` and `0x2` are all 2). Null otherwise; the version is then read from
 * the composed value, after the other checks.
 */
function yamlSchemaVersion(tokens: readonly CST.Token[]): SchemaVersion | null {
  const document = tokens.find((token): token is CST.Document => token.type === 'document' && !isStrayDocument(token));
  const root = document?.value;
  if (root === undefined || !(root.type === 'block-map' || (root.type === 'flow-collection' && root.start.type === 'flow-map-start'))) {
    return null;
  }
  for (const item of root.items as CST.CollectionItem[]) {
    const key = item.key;
    if (key === undefined || key === null || !('source' in key) || key.type === 'alias' || !SCHEMA_KEYS.has(key.source)) {
      continue;
    }
    const value = item.value;
    if (value === undefined || value.type !== 'scalar' || item.sep?.some((token) => token.type === 'tag' || token.type === 'anchor')) {
      return null;
    }
    const [composed] = new Composer(COMPOSE_OPTIONS).compose(new Parser().parse(value.source));
    return composed !== undefined && composed.errors.length === 0 && isScalar(composed.contents)
      ? {value: composed.contents.value, offset: value.offset}
      : null;
  }
  return null;
}

type YamlParse = {value: unknown; entries: [string, SourceEntry][]} | null;

function parseYaml(text: string, report: Reporter): YamlParse {
  const tokens = Array.from(new Parser().parse(normalizeLoneCarriageReturns(text)));
  if (reportNewerSchema(yamlSchemaVersion(tokens), report)) {
    return null;
  }
  const before = report.findings.length;
  const unclosedQuoteEnds = new Set<number>();
  const refusedTags = new Set<number>();
  if (!checkYamlProfile(tokens, report, unclosedQuoteEnds, refusedTags)) {
    return null;
  }

  // A stray `...` and the empty document made for it are left out, so the
  // first document composed is the manifest.
  const composer = new Composer(COMPOSE_OPTIONS);
  const documents = Array.from(
    composer.compose(
      tokens.filter((token, index) => !isStrayDocument(token) && !(token.type === 'doc-end' && index > 0 && isStrayDocument(tokens[index - 1]!))),
    ),
  );
  for (const document of documents) {
    for (const error of document.errors) {
      // The composer notices a missing closing quote where the value ends; the
      // walk has already reported it at the quotation mark that opens it.
      if (error.code === 'MISSING_CHAR' && /quote/i.test(error.message) && unclosedQuoteEnds.has(error.pos[0])) {
        continue;
      }
      // The parser's message can quote the text it stopped at, however long (D175).
      report.syntax(
        error.pos[0],
        `The YAML cannot be read here: ${shortenForMessage(error.message.split('\n')[0] ?? '')}`,
        YAML_FIXES[error.code] ?? 'Fix the YAML syntax at this position.',
      );
    }
    for (const warning of document.warnings) {
      if (warning.code === 'TAG_RESOLVE_FAILED') {
        if (!refusedTags.has(warning.pos[0])) {
          const tag = text.slice(warning.pos[0], warning.pos[1]);
          const words = CORE_TAG_WORDS.get(coreTagName(tag));
          report.syntax(
            warning.pos[0],
            words === undefined
              ? `The tag ${quoteValue(tag, 'none')} does not fit its value.`
              : `The tag ${quoteValue(tag, 'none')} needs ${words}, and the value it marks is not one.`,
            'Remove the tag, or write a value of the kind it names.',
          );
        }
        continue;
      }
      if (TOLERATED_YAML_WARNINGS.has(warning.code)) {
        continue;
      }
      report.syntax(
        warning.pos[0],
        `The YAML is ambiguous here: ${shortenForMessage(warning.message.split('\n')[0] ?? '')}`,
        YAML_FIXES[warning.code] ?? 'Rewrite the value so it has one meaning, quoting it if needed.',
      );
    }
  }
  if (report.findings.length > before) {
    return null;
  }
  const root = documents[0]?.contents ?? null;
  if (documents.length === 0 || root === null || (isScalar(root) && root.value === null)) {
    return {value: undefined, entries: []};
  }

  const entries: [string, SourceEntry][] = [];
  // A block value's range runs through the line break after it, so its end is
  // moved back to its last visible character: consecutive list items then
  // cover separate lines, as IC06 source targets need.
  const span = (range: readonly [number, number, number]): Span => {
    let end = range[1];
    while (end > range[0] && isYamlSpace(text.charCodeAt(end - 1))) {
      end -= 1;
    }
    return report.lines.span(range[0], end);
  };

  const build = (node: ParsedNode | null, pointer: string, fallback: number, key?: Span): unknown => {
    if (node === null) {
      entries.push([pointer, {value: report.lines.span(fallback, fallback), ...(key ? {key} : {})}]);
      return null;
    }
    entries.push([pointer, {value: span(node.range), ...(key ? {key} : {})}]);
    if (isMap(node)) {
      const result: Record<string, unknown> = {};
      const seen = new Map<string, number>();
      for (const pair of node.items) {
        const keyNode = pair.key as ParsedNode | null;
        const keyOffset = keyNode?.range[0] ?? (pair.value as ParsedNode | null)?.range[0] ?? node.range[0];
        if (keyNode === null || !isScalar(keyNode) || typeof keyNode.value !== 'string') {
          report.syntax(
            keyOffset,
            'A mapping key must be text.',
            'Write the field name as text, such as title:, and quote it if it looks like a number, true or null.',
          );
          continue;
        }
        const name = keyNode.value;
        const first = seen.get(name);
        if (first !== undefined) {
          const shown = quoteForMessage(name);
          report.syntax(
            keyOffset,
            `The field ${shown} appears twice in the same mapping.`,
            `Keep one ${shown} and delete or rename the other.`,
            `The first ${shown} is at line ${report.lines.position(first).line}.`,
            first,
          );
          continue;
        }
        seen.set(name, keyOffset);
        const valueNode = pair.value as ParsedNode | null;
        setOwn(result, name, build(valueNode, joinPointer(pointer, name), keyNode.range[1], span(keyNode.range)));
      }
      return result;
    }
    if (isSeq(node)) {
      return node.items.map((item, index) =>
        build(item as ParsedNode | null, joinPointer(pointer, index), node.range[0]),
      );
    }
    if (isScalar(node)) {
      return node.value;
    }
    // Aliases were refused on the CST; anything else is a parser change worth knowing about.
    throw new Error(`E_INTERNAL: unexpected YAML node at offset ${node.range[0]}`);
  };

  const value = build(root, '', 0);
  return {value, entries};
}

// ---------------------------------------------------------------------------
// Strict JSON

class JsonSyntaxError extends Error {
  readonly offset: number;
  readonly fix: string;
  readonly detail: string | null;

  constructor(offset: number, message: string, fix: string, detail: string | null = null) {
    super(message);
    this.offset = offset;
    this.fix = fix;
    this.detail = detail;
  }
}

const JSON_WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);

/** The invisible characters most often pasted into a manifest, by name. */
const INVISIBLE_NAMES = new Map([
  [0xfeff, 'byte-order mark'],
  [0x00a0, 'no-break space'],
  [0x200b, 'zero-width space'],
]);

/**
 * Scans strict JSON, recording spans for every value and key. Stops at the
 * first syntax error, since positions after it mean nothing; duplicate keys are
 * not syntax errors, so every one is reported.
 */
class JsonScanner {
  #index = 0;
  readonly entries: [string, SourceEntry][] = [];
  readonly text: string;
  readonly report: Reporter;

  constructor(text: string, report: Reporter) {
    this.text = text;
    this.report = report;
  }

  scan(): void {
    this.#skipWhitespace();
    if (this.#index >= this.text.length) {
      throw new JsonSyntaxError(this.#index, 'The manifest is empty.', 'Write the manifest as one JSON object, starting with {.');
    }
    this.#value('', 1, undefined);
    this.#skipWhitespace();
    if (this.#index < this.text.length) {
      throw new JsonSyntaxError(
        this.#index,
        'Text continues after the end of the JSON value.',
        'Remove everything after the closing brace of the manifest.',
      );
    }
  }

  #skipWhitespace(): void {
    for (;;) {
      const code = this.text.charCodeAt(this.#index);
      if (JSON_WHITESPACE.has(code)) {
        this.#index += 1;
        continue;
      }
      if (code === 0x2f && (this.text[this.#index + 1] === '/' || this.text[this.#index + 1] === '*')) {
        throw new JsonSyntaxError(
          this.#index,
          'JSON does not allow comments.',
          'Remove the comment, or write the manifest as papeleria.yaml, which allows comments after #.',
        );
      }
      return;
    }
  }

  #unexpected(expected: string): JsonSyntaxError {
    if (this.#index >= this.text.length) {
      return new JsonSyntaxError(this.#index, `The JSON ends before ${expected}.`, 'Complete the manifest; a bracket, brace or value is missing at the end.');
    }
    const found = this.text[this.#index]!;
    if (found === "'") {
      return new JsonSyntaxError(this.#index, 'JSON strings and keys use double quotes.', 'Replace the single quotes with double quotes.');
    }
    const code = this.text.codePointAt(this.#index)!;
    const character = String.fromCodePoint(code);
    if (/[\p{C}\p{Z}\p{Default_Ignorable_Code_Point}]/u.test(character)) {
      // A space, control or format character that cannot be told apart on screen is named by its code point.
      const name = INVISIBLE_NAMES.get(code);
      return new JsonSyntaxError(
        this.#index,
        `Unexpected U+${code.toString(16).toUpperCase().padStart(4, '0')}${name === undefined ? '' : ` (${name})`} where JSON expects ${expected}.`,
        'Delete it, or type a plain space in its place: JSON allows only spaces, tabs and line breaks between its parts.',
      );
    }
    return new JsonSyntaxError(
      this.#index,
      `Unexpected ${character} where JSON expects ${expected}.`,
      'Check for a missing comma, colon, quotation mark or bracket just before this position.',
    );
  }

  #value(pointer: string, depth: number, key: Span | undefined): void {
    const start = this.#index;
    const code = this.text.charCodeAt(start);
    if (code === 0x7b /* { */ || code === 0x5b /* [ */) {
      if (depth > INPUT_LIMITS.depth) {
        throw new JsonSyntaxError(
          start,
          `The manifest nests more than ${INPUT_LIMITS.depth} levels deep.`,
          `Flatten the structure; the limit is ${INPUT_LIMITS.depth} nested arrays and objects, counting the top level.`,
          `Input limit: nesting depth ${INPUT_LIMITS.depth} (IC01).`,
        );
      }
      const at = this.entries.length;
      this.entries.push([pointer, {value: this.report.lines.span(start, start)}]);
      if (code === 0x7b) {
        this.#object(pointer, depth);
      } else {
        this.#array(pointer, depth);
      }
      this.entries[at] = [pointer, {value: this.report.lines.span(start, this.#index), ...(key ? {key} : {})}];
      return;
    }
    if (code === 0x22 /* " */) {
      this.#string();
    } else if (code === 0x2d /* - */ || (code >= 0x30 && code <= 0x39)) {
      this.#number();
    } else if (this.text.startsWith('true', start)) {
      this.#index += 4;
    } else if (this.text.startsWith('false', start)) {
      this.#index += 5;
    } else if (this.text.startsWith('null', start)) {
      this.#index += 4;
    } else if (/^(?:NaN|[+-]?Infinity|undefined)/.test(this.text.slice(start, start + 9))) {
      throw new JsonSyntaxError(start, 'JSON has no NaN, Infinity or undefined.', 'Write a finite number, or null.');
    } else if (code === 0x2b /* + */) {
      throw new JsonSyntaxError(start, 'A JSON number cannot start with +.', 'Remove the plus sign.');
    } else {
      throw this.#unexpected('a value');
    }
    this.entries.push([pointer, {value: this.report.lines.span(start, this.#index), ...(key ? {key} : {})}]);
  }

  #object(pointer: string, depth: number): void {
    this.#index += 1;
    this.#skipWhitespace();
    if (this.text[this.#index] === '}') {
      this.#index += 1;
      return;
    }
    const seen = new Map<string, number>();
    for (;;) {
      if (this.text[this.#index] !== '"') {
        if (this.text[this.#index] === '}') {
          throw new JsonSyntaxError(this.#index, 'JSON does not allow a comma before }.', 'Remove the trailing comma.');
        }
        throw this.#unexpected('a key in double quotes');
      }
      const keyStart = this.#index;
      this.#string();
      const keyEnd = this.#index;
      const name = JSON.parse(this.text.slice(keyStart, keyEnd)) as string;
      const keySpan = this.report.lines.span(keyStart, keyEnd);
      const first = seen.get(name);
      if (first !== undefined) {
        const shown = quoteForMessage(name);
        this.report.syntax(
          keyStart,
          `The field ${shown} appears twice in the same object.`,
          `Keep one ${shown} and delete or rename the other.`,
          `The first ${shown} is at line ${this.report.lines.position(first).line}.`,
          first,
        );
      } else {
        seen.set(name, keyStart);
      }
      this.#skipWhitespace();
      if (this.text[this.#index] !== ':') {
        throw this.#unexpected('a colon after the key');
      }
      this.#index += 1;
      this.#skipWhitespace();
      // A duplicate's value is scanned for syntax but recorded under a pointer
      // nothing will look up, so it cannot overwrite the first occurrence.
      this.#value(first === undefined ? joinPointer(pointer, name) : `${pointer}\u0000duplicate`, depth + 1, keySpan);
      this.#skipWhitespace();
      const next = this.text[this.#index];
      if (next === ',') {
        this.#index += 1;
        this.#skipWhitespace();
        continue;
      }
      if (next === '}') {
        this.#index += 1;
        return;
      }
      throw this.#unexpected('a comma or }');
    }
  }

  #array(pointer: string, depth: number): void {
    this.#index += 1;
    this.#skipWhitespace();
    if (this.text[this.#index] === ']') {
      this.#index += 1;
      return;
    }
    for (let position = 0; ; position += 1) {
      if (this.text[this.#index] === ']') {
        throw new JsonSyntaxError(this.#index, 'JSON does not allow a comma before ].', 'Remove the trailing comma.');
      }
      this.#value(joinPointer(pointer, position), depth + 1, undefined);
      this.#skipWhitespace();
      const next = this.text[this.#index];
      if (next === ',') {
        this.#index += 1;
        this.#skipWhitespace();
        continue;
      }
      if (next === ']') {
        this.#index += 1;
        return;
      }
      throw this.#unexpected('a comma or ]');
    }
  }

  #string(): void {
    const start = this.#index;
    this.#index += 1;
    for (;;) {
      if (this.#index >= this.text.length) {
        throw new JsonSyntaxError(start, 'A string is not closed.', 'Close the string with a double quotation mark.');
      }
      const code = this.text.charCodeAt(this.#index);
      if (code === 0x22) {
        this.#index += 1;
        return;
      }
      if (code === 0x0a || code === 0x0d) {
        throw new JsonSyntaxError(
          start,
          'This string is not closed before the end of its line.',
          'Close the string with a double quotation mark; write \\n for a line break inside the text.',
        );
      }
      if (code < 0x20) {
        throw new JsonSyntaxError(
          this.#index,
          'A JSON string cannot contain a raw line break, tab or other control character.',
          'Write \\n for a line break and \\t for a tab inside the quotes.',
        );
      }
      if (code === 0x5c /* \ */) {
        const escape = this.text[this.#index + 1];
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(this.text.slice(this.#index + 2, this.#index + 6))) {
            throw new JsonSyntaxError(this.#index, 'A \\u escape needs four hexadecimal digits.', 'Write the escape as \\u followed by four digits 0-9 or letters a-f.');
          }
          this.#index += 6;
          continue;
        }
        if (escape === undefined || !'"\\/bfnrt'.includes(escape)) {
          throw new JsonSyntaxError(
            this.#index,
            `The escape \\${escape ?? ''} is not valid JSON.`,
            'Use one of \\" \\\\ \\/ \\b \\f \\n \\r \\t or \\u followed by four hexadecimal digits.',
          );
        }
        this.#index += 2;
        continue;
      }
      this.#index += 1;
    }
  }

  #number(): void {
    const pattern = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    pattern.lastIndex = this.#index;
    const match = pattern.exec(this.text);
    if (match === null) {
      throw new JsonSyntaxError(this.#index, 'This is not a valid JSON number.', 'Write the number with digits only, such as 4, 12.5 or -3.');
    }
    const after = this.text[this.#index + match[0].length];
    if (after !== undefined && /[0-9.eE]/.test(after)) {
      throw new JsonSyntaxError(
        this.#index,
        'This is not a valid JSON number.',
        'Remove leading zeros, and write decimals with a digit on both sides of the point.',
      );
    }
    this.#index += match[0].length;
  }
}

/** The top-level `schema` value, when the scanner read it as a number before it stopped. */
function jsonSchemaVersion(entries: readonly [string, SourceEntry][], text: string): SchemaVersion | null {
  const entry = entries.find(([pointer]) => pointer === '/schema')?.[1];
  if (entry === undefined) {
    return null;
  }
  const source = text.slice(entry.value.start.offset, entry.value.end.offset);
  return /^-?[0-9]/.test(source) ? {value: JSON.parse(source) as unknown, offset: entry.value.start.offset} : null;
}

type JsonParse = {value: unknown; entries: [string, SourceEntry][]} | null;

function parseJson(text: string, report: Reporter): JsonParse {
  // The scan reports into a list of its own, so that a newer schema it read
  // before stopping can be reported alone.
  const scanned = new Reporter(report.file, report.lines);
  const scanner = new JsonScanner(text, scanned);
  try {
    scanner.scan();
  } catch (error) {
    if (!(error instanceof JsonSyntaxError)) {
      throw error;
    }
    scanned.syntax(error.offset, error.message, error.fix, error.detail);
  }
  if (reportNewerSchema(jsonSchemaVersion(scanner.entries, text), report)) {
    return null;
  }
  if (scanned.findings.length > 0) {
    for (const finding of scanned.findings) {
      report.findings.push(finding);
    }
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    // The scanner accepts exactly what JSON.parse accepts; a disagreement is a defect here.
    throw new Error(`E_INTERNAL: the strict JSON scanner accepted text JSON.parse rejects: ${(error as Error).message}`);
  }
  return {value, entries: scanner.entries};
}

// ---------------------------------------------------------------------------
// Shared checks

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The manifest's version as a parser read it, and where its value starts. */
type SchemaVersion = {readonly value: unknown; readonly offset: number};

function isNewerSchema(schema: unknown): schema is number {
  return typeof schema === 'number' && Number.isInteger(schema) && schema > 1;
}

function newerSchemaFinding(file: ManifestFile, schema: number, location: Location): TracedFinding {
  return traced({
    rule: 'R17',
    message: `The manifest's schema ${schema} is newer than this version of Papeleria, which reads schema 1.`,
    fix: 'Update Papeleria, or set schema: 1 if the file was written by hand.',
    location,
    sourcePath: `${file}#/schema`,
  });
}

/**
 * A newer format is R17 alone, whatever else the text holds (IC01): it may
 * lift any limit, profile rule or syntax rule of this one. So each parser reads
 * the version first where the text allows, and a newer one is reported here
 * before anything else is checked; only the size limit comes earlier. True
 * when reported.
 */
function reportNewerSchema(version: SchemaVersion | null, report: Reporter): boolean {
  if (version === null || !isNewerSchema(version.value)) {
    return false;
  }
  report.findings.push(newerSchemaFinding(report.file, version.value, report.at(version.offset)));
  return true;
}

function checkSchemaVersion(
  value: Record<string, unknown>,
  map: SourceMap,
  report: Reporter,
): 'current' | 'newer' | 'invalid' {
  const file = report.file;
  if (!Object.hasOwn(value, 'schema')) {
    const root = map.get('')!;
    report.findings.push(
      traced({
        rule: 'R09',
        message: 'The manifest has no schema field.',
        fix: 'Add schema: 1 as the first field of the manifest.',
        detail: 'Container location: the manifest that starts here has no schema.',
        location: {file, line: root.value.start.line, column: root.value.start.column},
        sourcePath: `${file}#/schema`,
      }),
    );
    return 'invalid';
  }
  const schema = value['schema'];
  const entry = map.get('/schema')!;
  const location = {file, line: entry.value.start.line, column: entry.value.start.column};
  if (isNewerSchema(schema)) {
    report.findings.push(newerSchemaFinding(file, schema, location));
    return 'newer';
  }
  if (schema !== 1) {
    const written =
      typeof schema === 'string'
        ? quoteForMessage(schema)
        : Array.isArray(schema)
          ? 'a list'
          : typeof schema === 'object' && schema !== null
            ? 'a mapping'
            : String(schema);
    report.findings.push(
      traced({
        rule: 'R09',
        message:
          typeof schema === 'number' && Number.isInteger(schema)
            ? `schema: ${schema} is not a manifest version; this release reads schema 1.`
            : `schema must be the whole number 1, not ${written}.`,
        fix: 'Set schema: 1.',
        location,
        sourcePath: `${file}#/schema`,
      }),
    );
    return 'invalid';
  }
  return 'current';
}

/**
 * Parses manifest text into a positioned, frozen value. Pure: the editor passes
 * an unsaved buffer, `loadManifest` passes the file.
 */
export function parseManifest(input: string, file: ManifestFile): ManifestResult {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const lines = new LineIndex(text);
  const report = new Reporter(file, lines);
  const format: ManifestFormat = file.endsWith('.json') ? 'json' : 'yaml';

  const bytes = Buffer.byteLength(input, 'utf8');
  if (bytes > INPUT_LIMITS.manifestBytes) {
    report.findings.push(
      traced({
        rule: 'R09',
        message: `The manifest is ${formatBytes(bytes)} bytes; the limit is ${mebibytes(INPUT_LIMITS.manifestBytes)} (${formatBytes(INPUT_LIMITS.manifestBytes)} bytes).`,
        fix: 'Move long passages into Markdown files under assets/text/ and point the manifest at them.',
        detail: `Input limit: manifest ${formatBytes(INPUT_LIMITS.manifestBytes)} bytes (IC01).`,
        location: globalLocation(file),
        sourcePath: `${file}#size`,
      }),
    );
    return {manifest: null, findings: report.findings};
  }

  const parsed = /^\s*$/.test(text)
    ? {value: undefined, entries: []}
    : format === 'json'
      ? parseJson(text, report)
      : parseYaml(text, report);
  if (parsed === null || report.findings.length > 0) {
    return {manifest: null, findings: report.findings};
  }
  if (parsed.value === undefined) {
    report.findings.push(
      traced({
        rule: 'R09',
        message: 'The manifest is empty.',
        fix: 'Start the manifest with schema: 1, template: and title:.',
        location: globalLocation(file),
        sourcePath: `${file}#/`,
      }),
    );
    return {manifest: null, findings: report.findings};
  }

  const sourceMap = new FrozenSourceMap(parsed.entries);
  const value = parsed.value;
  if (!isPlainObject(value)) {
    const root = sourceMap.get('')!;
    report.findings.push(
      traced({
        rule: 'R09',
        message:
          format === 'json'
            ? 'The manifest must be one JSON object of fields.'
            : 'The manifest must be a mapping of fields, one per line, such as schema: 1.',
        fix: format === 'json' ? 'Wrap the fields in { }.' : 'Write each field as name: value at the start of a line.',
        location: {file, line: root.value.start.line, column: root.value.start.column},
        sourcePath: `${file}#`,
      }),
    );
    return {manifest: null, findings: report.findings};
  }

  // The version first: a newer format is R17 alone, whatever else it holds.
  // The parsers have already reported one they could read from the text.
  const version = checkSchemaVersion(value, sourceMap, report);
  if (version === 'newer') {
    return {manifest: null, findings: report.findings};
  }
  let overLimit = false;
  for (const list of COUNTED_LISTS) {
    const items = value[list.key];
    if (Array.isArray(items) && items.length > INPUT_LIMITS.items) {
      overLimit = true;
      const entry = sourceMap.get(`/${list.key}`)!;
      const at = entry.key ?? entry.value;
      report.findings.push(
        traced({
          rule: 'R09',
          message: `The manifest lists ${formatBytes(items.length)} ${list.noun}; the limit is ${formatBytes(INPUT_LIMITS.items)} per piece.`,
          fix: 'Split the piece into several pieces.',
          detail: `Input limit: ${formatBytes(INPUT_LIMITS.items)} slides, pages or sections per piece (IC01).`,
          location: {file, line: at.start.line, column: at.start.column},
          sourcePath: `${file}#/${list.key}`,
        }),
      );
    }
  }
  if (overLimit) {
    return {manifest: null, findings: report.findings};
  }

  const manifest: LoadedManifest = Object.freeze({
    file,
    format,
    text,
    value: deepFreeze(value),
    sourceMap,
    lines,
  });
  return {manifest, findings: report.findings};
}

export type LoadManifestOptions = {
  /** How the piece folder is named in a global finding; the CLI passes the folder as typed. */
  pieceLabel?: string;
};

/**
 * Finds and reads the manifest through the IO boundary, then parses it.
 * Both or neither manifest, a link, a folder in its place, an oversized file
 * and invalid UTF-8 are R09 findings; other IO failures propagate as errors.
 */
export async function loadManifest(access: FileAccess, options: LoadManifestOptions = {}): Promise<ManifestResult> {
  const pieceLabel = options.pieceLabel ?? '.';
  const [yamlStat, jsonStat] = await Promise.all([access.stat('papeleria.yaml'), access.stat('papeleria.json')]);

  const global = (message: string, fix: string, detail: string | null, sourcePath: string): ManifestResult => ({
    manifest: null,
    findings: [traced({rule: 'R09', message, fix, detail, location: globalLocation(pieceLabel), sourcePath})],
  });

  if (yamlStat !== null && jsonStat !== null) {
    return global(
      'The piece has both papeleria.yaml and papeleria.json.',
      'Keep one manifest and delete the other.',
      'A piece has exactly one manifest (C01).',
      `${pieceLabel}#manifest`,
    );
  }
  if (yamlStat === null && jsonStat === null) {
    const misnamed = await access.stat('papeleria.yml');
    return global(
      'The piece has no manifest.',
      'Add papeleria.yaml, or papeleria.json, at the top of the piece folder.',
      misnamed === null
        ? 'A piece has exactly one manifest (C01).'
        : 'papeleria.yml is present; the manifest must be named papeleria.yaml.',
      `${pieceLabel}#manifest`,
    );
  }

  const file: ManifestFile = yamlStat !== null ? 'papeleria.yaml' : 'papeleria.json';
  const stat = (yamlStat ?? jsonStat)!;
  const fileFinding = (message: string, fix: string, detail: string | null = null): ManifestResult => ({
    manifest: null,
    findings: [traced({rule: 'R09', message, fix, detail, location: globalLocation(file), sourcePath: `${file}#file`})],
  });
  if (stat.kind === 'symlink') {
    return fileFinding(
      `${file} is a symbolic link, and Papeleria does not follow links inside a piece.`,
      `Replace the link with the manifest file itself.`,
    );
  }
  if (stat.kind !== 'file') {
    return fileFinding(`${file} is not a file.`, `Replace it with the manifest file.`);
  }
  const tooLarge = (bytes: number): ManifestResult => ({
    manifest: null,
    findings: [
      traced({
        rule: 'R09',
        message: `The manifest is ${formatBytes(bytes)} bytes; the limit is ${mebibytes(INPUT_LIMITS.manifestBytes)} (${formatBytes(INPUT_LIMITS.manifestBytes)} bytes).`,
        fix: 'Move long passages into Markdown files under assets/text/ and point the manifest at them.',
        detail: `Input limit: manifest ${formatBytes(INPUT_LIMITS.manifestBytes)} bytes (IC01).`,
        location: globalLocation(file),
        sourcePath: `${file}#size`,
      }),
    ],
  });
  if (stat.bytes > INPUT_LIMITS.manifestBytes) {
    return tooLarge(stat.bytes);
  }
  let text: string;
  try {
    // The limit is checked again on the file actually opened, which may not be the one just inspected.
    text = await access.readText(file, {maxBytes: INPUT_LIMITS.manifestBytes});
  } catch (error) {
    if (error instanceof InvalidTextEncodingError) {
      return fileFinding(`${file} is not valid UTF-8 text.`, 'Save the manifest as UTF-8.');
    }
    if (error instanceof FileTooLargeError) {
      return tooLarge(error.bytes);
    }
    if (error instanceof FileChangedError) {
      return fileFinding(
        `${file} changed while Papeleria was reading it, and what was opened is not the file that was checked.`,
        'Build again once nothing else is changing the piece folder; replace any link with the manifest itself.',
      );
    }
    throw error;
  }
  return parseManifest(text, file);
}
