/**
 * M2.2: hover help on the manifest (UX §08: "Hover on a key — the schema
 * description for that field"; D75).
 *
 * The position's JSON pointer comes from the adapter's tree walk
 * (`completion.ts`), and the text from `schema-help.ts`, built from the
 * bundled schema this module is given. The tooltip holds plain text only.
 */
import type {Extension} from '@codemirror/state';
import {hoverTooltip, type EditorView, type Tooltip} from '@codemirror/view';

import {documentValue, pointerAt, type ManifestMode} from './completion.js';
import {helpAt, pointerSegments} from './schema-help.js';

/** The hover extension; `schema()` is read at each hover, so a changed template takes effect at once. */
export function schemaHover(mode: ManifestMode, schema: () => unknown): Extension {
  return hoverTooltip((view: EditorView, position: number, side: -1 | 1): Tooltip | null => {
    const line = view.state.doc.lineAt(position);
    const text = line.text;
    const offset = position - line.from;
    // Help is for a word — a key or a value — never for blank space or punctuation alone.
    const word = /[\p{L}\p{N}_]/u;
    if (!word.test(text[offset] ?? '') && !word.test(text[offset - 1] ?? '')) {
      return null;
    }
    const pointer = pointerAt(view.state, position, side, mode);
    const help = helpAt(schema(), pointerSegments(pointer), documentValue(view.state, mode));
    if (help === null) {
      return null;
    }
    let from = position;
    let to = position;
    while (from > line.from && /[A-Za-z0-9_.\-/]/.test(text[from - line.from - 1] ?? '')) {
      from -= 1;
    }
    while (to < line.to && /[A-Za-z0-9_.\-/]/.test(text[to - line.from] ?? '')) {
      to += 1;
    }
    return {
      pos: from,
      end: to,
      above: true,
      create: () => {
        const dom = document.createElement('div');
        dom.className = 'papeleria-help';
        for (const description of help.descriptions) {
          const paragraph = document.createElement('p');
          paragraph.textContent = description;
          dom.append(paragraph);
        }
        if (help.summary !== null) {
          const summary = document.createElement('p');
          summary.className = 'papeleria-help-summary';
          summary.textContent = help.summary;
          dom.append(summary);
        }
        return {dom};
      },
    };
  });
}
