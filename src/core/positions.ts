/**
 * Source positions: offsets to 1-based lines and columns, JSON pointers, and
 * the manifest source map from every JSON pointer to its key and value spans.
 *
 * Columns count UTF-16 code units from the start of the line, the unit both
 * JavaScript strings and CodeMirror use, so an editor can place a finding
 * without converting. `\r\n`, `\n` and a lone `\r` each end a line, matching
 * CodeMirror's default line splitting (D145).
 */

export type Position = {readonly line: number; readonly column: number; readonly offset: number};
export type Span = {readonly start: Position; readonly end: Position};

/**
 * Where one manifest value sits. `key` is present when the value is the value
 * of a mapping entry; items of a list and the root have only a value span.
 */
export type SourceEntry = {readonly value: Span; readonly key?: Span};

/** JSON pointer (RFC 6901, `''` for the root) → spans in the manifest text. */
export type SourceMap = ReadonlyMap<string, SourceEntry>;

/**
 * Converts string offsets to 1-based line and column positions. The index and
 * every position and span it returns are frozen: a consumer that keeps a
 * loaded manifest between edits cannot move a later finding by writing to one.
 */
export class LineIndex {
  readonly #starts: number[];
  readonly #length: number;

  constructor(text: string) {
    const starts = [0];
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code === 0x0a) {
        starts.push(index + 1);
      } else if (code === 0x0d) {
        if (text.charCodeAt(index + 1) === 0x0a) {
          index += 1;
        }
        starts.push(index + 1);
      }
    }
    this.#starts = starts;
    this.#length = text.length;
    Object.freeze(this);
  }

  /** The number of lines, counting a final empty line after a trailing break. */
  get lineCount(): number {
    return this.#starts.length;
  }

  position(offset: number): Position {
    const clamped = Math.max(0, Math.min(offset, this.#length));
    let low = 0;
    let high = this.#starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.#starts[middle]! <= clamped) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return Object.freeze({line: low + 1, column: clamped - this.#starts[low]! + 1, offset: clamped});
  }

  span(start: number, end: number): Span {
    return Object.freeze({start: this.position(start), end: this.position(Math.max(start, end))});
  }
}

function encodeSegment(segment: string | number): string {
  return String(segment).replaceAll('~', '~0').replaceAll('/', '~1');
}

function decodeSegment(segment: string): string {
  return segment.replaceAll('~1', '/').replaceAll('~0', '~');
}

/** Appends one reference token to a JSON pointer. */
export function joinPointer(parent: string, segment: string | number): string {
  return `${parent}/${encodeSegment(segment)}`;
}

/** The reference tokens of a JSON pointer, decoded. `''` has none. */
export function parsePointer(pointer: string): string[] {
  if (pointer === '') {
    return [];
  }
  if (!pointer.startsWith('/')) {
    throw new Error(`E_INTERNAL: ${JSON.stringify(pointer)} is not a JSON pointer`);
  }
  return pointer.slice(1).split('/').map(decodeSegment);
}

/** The pointer of the containing value, or null for the root. */
export function parentPointer(pointer: string): string | null {
  if (pointer === '') {
    return null;
  }
  return pointer.slice(0, pointer.lastIndexOf('/'));
}

/** Builds a pointer from decoded segments. */
export function pointerOf(segments: readonly (string | number)[]): string {
  return segments.map((segment) => `/${encodeSegment(segment)}`).join('');
}

/**
 * The entry for a pointer, or for its nearest ancestor that has one. The
 * ancestor fallback exists for values the parser could not place; it returns
 * the pointer it actually found so callers can say so rather than pretend.
 */
export function nearestEntry(
  map: SourceMap,
  pointer: string,
): {readonly pointer: string; readonly entry: SourceEntry} | null {
  let current: string | null = pointer;
  while (current !== null) {
    const entry = map.get(current);
    if (entry !== undefined) {
      return {pointer: current, entry};
    }
    current = parentPointer(current);
  }
  return null;
}

/** The start of the key when the value has one, else the start of the value. */
export function anchorPosition(entry: SourceEntry): Position {
  return (entry.key ?? entry.value).start;
}
