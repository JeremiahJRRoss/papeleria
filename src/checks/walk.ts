/**
 * Walks the resolved content of a Piece in document order, for the rules that
 * look at every image, table, chart or text wherever a template puts it.
 * Rules recognise values by their shape, so a block a later template adds is
 * found as long as it keeps the shape its kind has in `types.ts`.
 */
import type {InlineText, Piece, ResolvedChart, ResolvedTable, ResolvedText} from '../core/index.js';

/** Parts of a Piece that are not the author's content, or hold no values a rule walks. */
const NOT_CONTENT = new Set(['manifest', 'sourceMap', 'strings', 'assets', 'brand', 'credits', 'source']);

/** Calls `visit` on every object inside the piece's content, parents before children. */
export function visitContent(piece: Piece, visit: (value: Readonly<Record<string, unknown>>) => void): void {
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }
      return;
    }
    if (typeof value !== 'object' || value === null) {
      return;
    }
    const record = value as Record<string, unknown>;
    visit(record);
    for (const [key, child] of Object.entries(record)) {
      if (!NOT_CONTENT.has(key)) {
        walk(child);
      }
    }
  };
  walk(piece);
}

export function isResolvedText(value: Readonly<Record<string, unknown>>): value is ResolvedText {
  return typeof value['pointer'] === 'string' && typeof value['markdown'] === 'string' && typeof value['html'] === 'string' && 'origin' in value;
}

export function isInlineText(value: Readonly<Record<string, unknown>>): value is InlineText {
  return typeof value['pointer'] === 'string' && typeof value['markdown'] === 'string' && typeof value['text'] === 'string' && !('origin' in value);
}

export function isResolvedChart(value: Readonly<Record<string, unknown>>): value is ResolvedChart {
  return typeof value['pointer'] === 'string' && (value['type'] === 'bar' || value['type'] === 'line') && typeof value['x'] === 'string' && typeof value['summary'] === 'string';
}

export function isResolvedTable(value: Readonly<Record<string, unknown>>): value is ResolvedTable {
  const data = value['data'] as {csv?: unknown} | undefined;
  return typeof value['pointer'] === 'string' && 'columns' in value && typeof data === 'object' && data !== null && data.csv !== undefined && !('x' in value);
}
