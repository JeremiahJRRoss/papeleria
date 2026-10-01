/**
 * M2.2: schema completion — the one module that uses `codemirror-json-schema`
 * (D25, D33, D75).
 *
 * The adapter is composed by hand, for completion only: its state field that
 * holds the schema, and its completion source for the manifest's language.
 * Its bundled `jsonSchema()` and `yamlSchema()` helpers are not used, because
 * they also install the adapter's schema linters, which validate with
 * json-schema-library's Draft04 engine: that engine has no 2020-12 reading
 * and rejects valid manifests (a `focal_point` of `[50, 50]`, D33). Its hover
 * is not used either: `hover.ts` builds help from the bundled schema. The
 * editor's diagnostics come only from the pipeline's report (D75).
 *
 * The schema given is `bundledSchema(template)` as `GET /api/piece` sends it:
 * one self-contained 2020-12 document with local references, which the
 * adapter's Draft07 completion engine reads through `$ref`, `if`/`then` and
 * `\p{…}` patterns (D164(c)). Completion opens on Ctrl Space, never while
 * typing (D85).
 */
import {autocompletion, completionKeymap} from '@codemirror/autocomplete';
import {jsonLanguage} from '@codemirror/lang-json';
import {yamlLanguage} from '@codemirror/lang-yaml';
import type {Extension} from '@codemirror/state';
import {keymap, type EditorView} from '@codemirror/view';
import {jsonCompletion, jsonPointerForPosition, parseJSONDocumentState, stateExtensions, updateSchema} from 'codemirror-json-schema';
import {parseYAMLDocumentState, yamlCompletion} from 'codemirror-json-schema/yaml';
import type {EditorState} from '@codemirror/state';

export type ManifestMode = 'yaml' | 'json';

type JsonSchema = Parameters<typeof stateExtensions>[0];

/** The completion extensions for a manifest in `mode`, driven by `schema`. */
export function completionExtensions(mode: ManifestMode, schema: unknown): Extension[] {
  return [
    stateExtensions(schema as JsonSchema),
    mode === 'yaml' ? yamlLanguage.data.of({autocomplete: yamlCompletion()}) : jsonLanguage.data.of({autocomplete: jsonCompletion()}),
    autocompletion({activateOnTyping: false, icons: false}),
    keymap.of(completionKeymap),
  ];
}

/** Swaps the schema completion reads, when the manifest's template changes. */
export function setCompletionSchema(view: EditorView, schema: unknown): void {
  updateSchema(view, schema as JsonSchema);
}

/** The JSON pointer of the key or value at a position, through the adapter's own tree walk. */
export function pointerAt(state: EditorState, position: number, side: -1 | 1, mode: ManifestMode): string {
  return jsonPointerForPosition(state, position, side, mode === 'yaml' ? 'yaml' : 'json4');
}

/** The manifest as parsed so far, or undefined when it cannot be read at all. */
export function documentValue(state: EditorState, mode: ManifestMode): unknown {
  try {
    return (mode === 'yaml' ? parseYAMLDocumentState(state) : parseJSONDocumentState(state)).data as unknown;
  } catch {
    return undefined;
  }
}
