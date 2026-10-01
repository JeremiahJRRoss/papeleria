/**
 * Findings: the IC01 report shape, and how findings are ordered and deduplicated.
 *
 * `Location` and `Finding` are the IC01 wire types verbatim. A finding carries
 * its rule, severity, message and fix, and an honest source location: a 1-based
 * text line and column where the problem has one, and `line: null` with a
 * `relatedLocation` for binary and global sources. A line is never invented.
 *
 * Deduplication needs the *semantic* source a finding is about, which the wire
 * type deliberately does not carry: two missing fields of one object share the
 * object's location but are different problems. Every stage therefore produces
 * a `TracedFinding`, the wire finding plus its semantic source path, and the
 * report keeps only the finding (D145).
 */

export type Severity = 'error' | 'warning';

/** IC01. Text lines and columns are 1-based; binary and global sources use null. */
export type Location = {file: string; line: number | null; column: number | null};

/** IC01. JSON reports keep these keys flat. */
export type Finding = Location & {
  rule: string;
  severity: Severity;
  message: string;
  fix: string;
  detail: string | null;
  relatedLocation?: Location;
};

/**
 * A finding plus the semantic source it is about, used for deduplication only.
 *
 * `sourcePath` names the file and the thing inside it: a JSON pointer into the
 * manifest (`papeleria.yaml#/slides/2/title`), a pointer plus a facet for a
 * problem that concerns a combination of fields (`…/image#alternative`), or a
 * text position (`assets/text/a.md@12:3`). It is not part of the report.
 */
export type TracedFinding = {readonly finding: Finding; readonly sourcePath: string};

/**
 * A problem in an asset's content, found by the module that reads that format
 * (`csv.ts`, `images.ts`, and `video.ts` from M3). It becomes a finding at the
 * asset — its text line when the format has lines, `line: null` for a binary
 * or whole-file problem — with the manifest token that names the asset as the
 * related location (D156, D158). `rule` says which rule reports it.
 */
export type AssetProblem = {
  readonly code: string;
  readonly rule: string;
  readonly message: string;
  readonly fix: string;
  readonly line: number | null;
  readonly column?: number;
};

/** The severity each rule reports when it has only one (ERD RULE catalogue). */
export const RULE_SEVERITY: Readonly<Record<string, Severity>> = Object.freeze({
  R02: 'error',
  R03: 'error',
  R04: 'error',
  R05: 'error',
  R06: 'warning',
  R07: 'error',
  R08: 'error',
  R09: 'error',
  R10: 'error',
  R11: 'error',
  R12: 'error',
  R14: 'error',
  R15: 'error',
  R16: 'error',
  R17: 'error',
});

/**
 * Characters that must never reach a report as themselves: C0 controls, DEL
 * and C1 controls (a terminal acts on ESC and CSI), the line and paragraph
 * separators, the bidirectional embeddings, overrides and isolates, which
 * reorder the text around them, and the zero-width space and byte-order mark,
 * which mean nothing in a message and cannot be seen: a key that holds one
 * looks exactly like one that does not. The bidirectional marks and the
 * zero-width joiners are kept, because right-to-left, Persian, Indic and emoji
 * text needs them to read correctly. A value quoted from a piece shows more
 * (`escapeInvisible`).
 */
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200b\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** Writes each unsafe character as a visible `\uXXXX` escape; everything else is kept. */
export function escapeControls(text: string): string {
  return text.replace(UNSAFE_TEXT, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * What an author's quoted value shows as escapes (D175): everything
 * UNSAFE_TEXT holds, and every other default-ignorable character, which draws
 * nothing. A key holding a word joiner, a soft hyphen, a combining grapheme
 * joiner, a variation selector or a tag character prints exactly like the key
 * without it, and inside quotes the author is comparing what was written
 * character by character. The joiners and the bidirectional marks stay, as
 * they do everywhere. Outside quotes a message keeps `escapeControls` alone:
 * variation selectors and tag characters are also parts of emoji, flags and
 * CJK names, which escaping them everywhere would garble.
 */
const INVISIBLE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Default_Ignorable_Code_Point}]/gu;
const KEPT_INVISIBLE = new Set(['\u061c', '\u200c', '\u200d', '\u200e', '\u200f']);

/** `\uXXXX`, or `\u{XXXXX}` beyond the Basic Multilingual Plane. */
function escapeCharacter(character: string): string {
  const code = character.codePointAt(0) ?? 0;
  return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, '0')}`;
}

/** Writes each character an author's quoted value must show as a visible escape; everything else is kept. */
export function escapeInvisible(text: string): string {
  return text.replace(INVISIBLE_TEXT, (character) => (KEPT_INVISIBLE.has(character) ? character : escapeCharacter(character)));
}

/**
 * D175: a message quotes an author's value whole up to this many UTF-16 code
 * units. A 300 KB value was once quoted whole, and a 1 MiB manifest could
 * yield a report several times its size.
 */
export const QUOTED_LENGTH = 120;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * An author's value cut to fit a message (D175): whole when it is at most
 * QUOTED_LENGTH code units, else its first and last half around an ellipsis,
 * so a long path still shows its file name. No cut falls inside a surrogate
 * pair, and the value is cut before it is escaped, so none falls inside an
 * escape either.
 */
export function shortenForMessage(value: string): string {
  if (value.length <= QUOTED_LENGTH) {
    return value;
  }
  const half = QUOTED_LENGTH / 2;
  const head = isHighSurrogate(value.charCodeAt(half - 1)) ? half - 1 : half;
  const tail = isLowSurrogate(value.charCodeAt(value.length - half)) ? value.length - half + 1 : value.length - half;
  return `${value.slice(0, head)}…${value.slice(tail)}`;
}

/** `double`: in double quotes as written, backslashes and all; `json`: as a JSON string; `none`: bare. */
export type QuoteStyle = 'double' | 'json' | 'none';

/**
 * An author's value for a message, fix or detail: shortened, quoted in
 * `style`, its hidden characters made visible, and its whole length after it
 * when it was cut, as in "assets/images/abc…xyz.png" (4,816 characters) (D175).
 */
export function quoteValue(value: string, style: QuoteStyle = 'double'): string {
  const shown = shortenForMessage(value);
  const quoted = escapeInvisible(style === 'json' ? JSON.stringify(shown) : style === 'double' ? `"${shown}"` : shown);
  return shown === value ? quoted : `${quoted} (${value.length.toLocaleString('en-US')} characters)`;
}

/** D175: a message lists at most this many author values, then says how many more there are. */
export const LISTED_VALUES = 20;

/** Author values for a message, each quoted by `quote`: at most LISTED_VALUES of them, and a count of the rest. */
export function listForMessage(values: readonly string[], quote: (value: string) => string): string {
  const listed = values.slice(0, LISTED_VALUES).map(quote).join(', ');
  return values.length > LISTED_VALUES ? `${listed} and ${(values.length - LISTED_VALUES).toLocaleString('en-US')} more` : listed;
}

export type FindingInput = {
  rule: string;
  /** Defaults to the rule's catalogue severity. R01 and R13 depend on context and must say. */
  severity?: Severity;
  message: string;
  fix: string;
  detail?: string | null;
  location: Location;
  relatedLocation?: Location;
  sourcePath: string;
};

/**
 * Builds a traced finding, taking the severity from the catalogue when omitted.
 * Message, fix and detail quote what authors wrote, so they pass through
 * `escapeControls`: a report printed to a terminal can never carry a control
 * sequence from a manifest, a Markdown file or an SVG (D145).
 */
export function traced(input: FindingInput): TracedFinding {
  const severity = input.severity ?? (Object.hasOwn(RULE_SEVERITY, input.rule) ? RULE_SEVERITY[input.rule] : undefined);
  if (severity === undefined) {
    throw new Error(`E_INTERNAL: ${input.rule} has no single catalogue severity; state it explicitly`);
  }
  const finding: Finding = {
    file: input.location.file,
    line: input.location.line,
    column: input.location.column,
    rule: input.rule,
    severity,
    message: escapeControls(input.message),
    fix: escapeControls(input.fix),
    detail: input.detail === undefined || input.detail === null ? null : escapeControls(input.detail),
  };
  if (input.relatedLocation !== undefined) {
    finding.relatedLocation = {...input.relatedLocation};
  }
  return {finding, sourcePath: input.sourcePath};
}

/** A location with no text position: a binary asset, a folder or a package. */
export function globalLocation(file: string): Location {
  return {file, line: null, column: null};
}

function compareNullableNumbers(a: number | null, b: number | null): number {
  if (a === b) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  return a - b;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * IC01 order: source file, real line with null last, column with null last,
 * then rule. Rule ids are zero-padded (R02, R10), so string order is numeric.
 */
export function compareFindings(a: Finding, b: Finding): number {
  return (
    compareStrings(a.file, b.file) ||
    compareNullableNumbers(a.line, b.line) ||
    compareNullableNumbers(a.column, b.column) ||
    compareStrings(a.rule, b.rule)
  );
}

/** A sorted copy. The sort is stable, so equal keys keep the order they were found in. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(compareFindings);
}

/** Keeps the first finding for each rule and semantic source path. */
export function dedupeFindings(items: readonly TracedFinding[]): TracedFinding[] {
  const seen = new Set<string>();
  const kept: TracedFinding[] = [];
  for (const item of items) {
    const key = `${item.finding.rule}\u0000${item.sourcePath}`;
    if (!seen.has(key)) {
      seen.add(key);
      kept.push(item);
    }
  }
  return kept;
}

/** Deduplicates, sorts and drops the tracing: the findings a report lists. */
export function settleFindings(items: readonly TracedFinding[]): Finding[] {
  return sortFindings(dedupeFindings(items).map((item) => item.finding));
}

/** True when any finding is an error. */
export function hasErrors(items: readonly (Finding | TracedFinding)[]): boolean {
  return items.some((item) => ('finding' in item ? item.finding : item).severity === 'error');
}
