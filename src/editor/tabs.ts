/**
 * M2.2: the editor's tabs — buffers, revisions, saving and conflicts
 * (IC05, IC06, D09, D81, UX §08).
 *
 * The manifest is the first tab and cannot be closed; Markdown files open in
 * tabs of their own from the file list, and CSV files open as a read-only
 * table. Each tab keeps the revision of the file it was loaded from or last
 * saved as (its base), and the text that revision holds, so it knows whether
 * the buffer is dirty. A dot on the tab marks unsaved work.
 *
 * - Save writes the current tab against its base revision; Save all saves
 *   the changed tabs one after another and stops at the first conflict. Not a
 *   transaction across files, and never presented as one.
 * - A file that changed on disk under a dirty tab is a conflict: the tab is
 *   marked and a banner offers Reload (the disk's text replaces the buffer)
 *   or Keep mine (the buffer stays, the disk revision is acknowledged, and
 *   the next save checks against it). Nothing is written until the author
 *   chooses. Under a clean tab the disk's text is simply taken, since nothing
 *   of the author's would be lost (D81).
 * - A save refused with 409 becomes the same conflict. A conflict ends by
 *   itself when the disk holds the tab's base again, as when the write made
 *   elsewhere is undone (`tab-state.ts`).
 */
import {defaultKeymap, history, historyKeymap, indentWithTab} from '@codemirror/commands';
import {json} from '@codemirror/lang-json';
import {yaml} from '@codemirror/lang-yaml';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language';
import {lintGutter, setDiagnostics, type Diagnostic} from '@codemirror/lint';
import {EditorSelection, EditorState, type Extension} from '@codemirror/state';
import {
  Decoration,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import {tags} from '@lezer/highlight';

import {ApiError, type Api} from './api.js';
import {completionExtensions, setCompletionSchema, type ManifestMode} from './completion.js';
import {csvTable} from './csv-table.js';
import {baseName, element} from './dom.js';
import {schemaHover} from './hover.js';
import {diskOutcome} from './tab-state.js';

export type TabKind = 'manifest' | 'text' | 'data';

/** A file the editor may open, as `GET /api/piece` lists it. */
export type FileEntry = {readonly path: string; readonly kind: 'text' | 'data'; readonly revision: string | null; readonly bytes: number};

export type Tab = {
  readonly path: string;
  readonly kind: TabKind;
  /** The revision the buffer was loaded from or last saved as; the one a save expects on disk. */
  baseRevision: string | null;
  /** The text of the base revision, as the buffer holds it. */
  savedText: string;
  readonly view: EditorView | null;
  readonly panel: HTMLElement;
  readonly button: HTMLButtonElement;
  readonly closeButton: HTMLButtonElement | null;
  /** The disk's revision when it differs from the base and the buffer is dirty; null revision: the file is gone. */
  conflict: {readonly currentRevision: string | null} | null;
  dirty: boolean;
  /** When the buffer was last changed, on the page's clock; the A9 measure starts here. */
  lastInputAt: number;
};

type OpenedFile = {path: string; kind: TabKind; content: string; revision: string; readOnly: boolean; lineEnding: 'lf' | 'crlf'};

export type TabSetOptions = {
  readonly api: Api;
  readonly tablist: HTMLElement;
  readonly panels: HTMLElement;
  readonly nonce: string;
  readonly manifestMode: ManifestMode;
  /** The bundled schema the manifest is completed and explained with. */
  readonly schema: () => unknown;
  /** A buffer changed: the preview should follow. */
  readonly onEdit: (tab: Tab) => void;
  /** The cursor moved to `line` in `tab`. */
  readonly onCursor: (tab: Tab, line: number, column: number) => void;
  /** Something the chrome shows changed: dirty, conflict, the active tab. */
  readonly onChange: () => void;
  /** A tab became active. */
  readonly onActivate: (tab: Tab) => void;
  /** A short message for the status line. */
  readonly note: (text: string) => void;
};

/** Keys in ink at 600, comments muted, everything else plain ink: no syntax rainbow (UX §08). */
const kitHighlight = HighlightStyle.define([
  {tag: [tags.propertyName, tags.definition(tags.propertyName)], fontWeight: '600'},
  {tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--color-text-muted)'},
]);

/**
 * The kit's look for the editor pane (UX §08): the mono stack at .9rem, ink on
 * white, the light brand tint for the selection, and findings underlined in
 * the semantic error and warning colours.
 */
const kitTheme = EditorView.theme({
  '&': {height: '100%', fontSize: '.9rem', color: 'var(--color-text)', backgroundColor: 'var(--color-surface)'},
  '.cm-scroller': {fontFamily: 'var(--font-mono)', lineHeight: '1.6'},
  '.cm-content': {caretColor: 'var(--color-text)'},
  '&.cm-focused': {outline: 'none'},
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {backgroundColor: 'var(--brand-light)'},
  '.cm-gutters': {backgroundColor: 'var(--color-surface)', color: 'var(--color-text-muted)', borderRight: '1px solid var(--color-rule)'},
  '.cm-activeLineGutter': {backgroundColor: 'var(--neutral-50)', color: 'var(--color-text)'},
  '.cm-lintRange-error': {backgroundImage: 'none', textDecoration: 'underline wavy var(--semantic-error)', textDecorationSkipInk: 'none', textUnderlineOffset: '3px'},
  '.cm-lintRange-warning': {backgroundImage: 'none', textDecoration: 'underline wavy var(--semantic-warning)', textDecorationSkipInk: 'none', textUnderlineOffset: '3px'},
  '.cm-lint-marker': {width: '.7em', height: '.7em', content: 'none'},
  '.cm-lint-marker-error': {content: 'none', borderRadius: '50%', backgroundColor: 'var(--semantic-error)'},
  '.cm-lint-marker-warning': {content: 'none', backgroundColor: 'var(--semantic-warning)'},
  '.cm-diagnostic-error': {borderLeftColor: 'var(--semantic-error)'},
  '.cm-diagnostic-warning': {borderLeftColor: 'var(--semantic-warning)'},
  '.cm-tooltip': {border: '1px solid var(--color-rule)', backgroundColor: 'var(--color-surface)'},
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {backgroundColor: 'var(--brand-light)', color: 'var(--color-text)'},
});

const INDENT_GUIDES_MAX = 16;

/** Indentation guides: each line is marked with its depth in two-space steps, and the stylesheet draws a rule per step. */
const indentGuides = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.build(update.view);
      }
    }
    build(view: EditorView): DecorationSet {
      const marks = [];
      for (const {from, to} of view.visibleRanges) {
        for (let position = from; position <= to; ) {
          const line = view.state.doc.lineAt(position);
          const depth = Math.min(INDENT_GUIDES_MAX, Math.floor((/^ */.exec(line.text)?.[0].length ?? 0) / 2));
          if (depth > 0) {
            marks.push(Decoration.line({class: `cm-indent-${depth}`}).range(line.from));
          }
          position = line.to + 1;
        }
      }
      return Decoration.set(marks);
    }
  },
  {decorations: (plugin) => plugin.decorations},
);

export class TabSet {
  readonly #options: TabSetOptions;
  readonly #tabs = new Map<string, Tab>();
  #active: Tab | null = null;
  #manifest: Tab | null = null;

  constructor(options: TabSetOptions) {
    this.#options = options;
  }

  get tabs(): readonly Tab[] {
    return [...this.#tabs.values()];
  }

  get active(): Tab | null {
    return this.#active;
  }

  get manifest(): Tab | null {
    return this.#manifest;
  }

  tab(path: string): Tab | undefined {
    return this.#tabs.get(path);
  }

  anyDirty(): boolean {
    return this.tabs.some((tab) => tab.dirty);
  }

  anyConflict(): boolean {
    return this.tabs.some((tab) => tab.conflict !== null);
  }

  /** The buffer's text, line breaks as the file writes them. */
  text(tab: Tab): string {
    return tab.view === null ? tab.savedText : tab.view.state.doc.toString();
  }

  #extensions(path: string, kind: TabKind, lineEnding: 'lf' | 'crlf', readOnly: boolean): Extension[] {
    const extensions: Extension[] = [
      EditorView.cspNonce.of(this.#options.nonce),
      kitTheme,
      lineNumbers(),
      highlightActiveLineGutter(),
      foldGutter(),
      history(),
      drawSelection(),
      dropCursor(),
      highlightSpecialChars(),
      indentOnInput(),
      bracketMatching(),
      syntaxHighlighting(kitHighlight),
      indentUnit.of('  '),
      EditorState.tabSize.of(2),
      indentGuides,
      lintGutter(),
      keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
      EditorView.contentAttributes.of({'aria-label': `${baseName(path)} source`, spellcheck: kind === 'text' ? 'true' : 'false'}),
    ];
    if (lineEnding === 'crlf') {
      extensions.push(EditorState.lineSeparator.of('\r\n'));
    }
    if (readOnly) {
      extensions.push(EditorState.readOnly.of(true), EditorView.editable.of(false));
    }
    if (kind === 'manifest') {
      const mode = this.#options.manifestMode;
      extensions.push(mode === 'yaml' ? yaml() : json(), completionExtensions(mode, this.#options.schema()), schemaHover(mode, this.#options.schema));
    } else {
      extensions.push(EditorView.lineWrapping);
    }
    extensions.push(
      EditorView.updateListener.of((update) => {
        const tab = this.#tabs.get(path);
        if (tab === undefined) {
          return;
        }
        if (update.docChanged) {
          tab.lastInputAt = performance.now();
          const dirty = this.text(tab) !== tab.savedText;
          if (dirty !== tab.dirty) {
            tab.dirty = dirty;
            this.#label(tab);
            this.#options.onChange();
          }
          this.#options.onEdit(tab);
        }
        if (update.selectionSet || update.docChanged) {
          const head = update.state.selection.main.head;
          const line = update.state.doc.lineAt(head);
          this.#options.onCursor(tab, line.number, head - line.from + 1);
        }
      }),
    );
    return extensions;
  }

  #label(tab: Tab): void {
    const name = baseName(tab.path);
    const marks = `${tab.dirty ? ' ●' : ''}${tab.conflict !== null ? ' ⚠' : ''}`;
    tab.button.textContent = `${name}${marks}`;
    const states = [tab.dirty ? 'unsaved changes' : '', tab.conflict !== null ? 'changed on disk' : '', tab.kind === 'data' ? 'read-only' : ''].filter((state) => state !== '');
    tab.button.setAttribute('aria-label', states.length === 0 ? name : `${name}, ${states.join(', ')}`);
    tab.button.title = tab.path;
  }

  #create(file: OpenedFile): Tab {
    const id = `tab-${this.#tabs.size}-${Math.random().toString(36).slice(2, 8)}`;
    const button = element('button', {type: 'button', role: 'tab', id: `${id}-button`, 'aria-controls': `${id}-panel`, 'aria-selected': 'false', tabindex: '-1'});
    const panel = element('div', {role: 'tabpanel', id: `${id}-panel`, 'aria-labelledby': `${id}-button`, class: 'editor-panel', hidden: ''});
    let closeButton: HTMLButtonElement | null = null;
    const holder = element('div', {class: 'editor-tab'});
    holder.append(button);
    if (file.kind !== 'manifest') {
      closeButton = element('button', {type: 'button', class: 'editor-tab-close', 'aria-label': `Close ${baseName(file.path)}`}, '×');
      holder.append(closeButton);
    }
    this.#options.tablist.append(holder);
    this.#options.panels.append(panel);
    let view: EditorView | null = null;
    if (file.kind === 'data') {
      panel.append(csvTable(file.path, file.content));
    } else {
      view = new EditorView({
        parent: panel,
        state: EditorState.create({doc: file.content, extensions: this.#extensions(file.path, file.kind, file.lineEnding, file.readOnly)}),
      });
    }
    const tab: Tab = {
      path: file.path,
      kind: file.kind,
      baseRevision: file.revision,
      savedText: view === null ? file.content : view.state.doc.toString(),
      view,
      panel,
      button,
      closeButton,
      conflict: null,
      dirty: false,
      lastInputAt: performance.now(),
    };
    this.#tabs.set(file.path, tab);
    this.#label(tab);
    button.addEventListener('click', () => this.activate(file.path));
    button.addEventListener('keydown', (event) => this.#tabKeys(event, tab));
    closeButton?.addEventListener('click', () => this.close(file.path));
    return tab;
  }

  /** Arrow keys move between tabs (the ARIA tabs pattern). */
  #tabKeys(event: KeyboardEvent, tab: Tab): void {
    const order = this.tabs;
    const index = order.indexOf(tab);
    const target =
      event.key === 'ArrowRight' ? order[(index + 1) % order.length] : event.key === 'ArrowLeft' ? order[(index - 1 + order.length) % order.length] : event.key === 'Home' ? order[0] : event.key === 'End' ? order.at(-1) : undefined;
    if (target !== undefined) {
      event.preventDefault();
      this.activate(target.path);
      target.button.focus();
    }
  }

  /** Opens the manifest's tab from the piece snapshot. */
  openManifest(path: string, content: string, revision: string, lineEnding: 'lf' | 'crlf'): Tab {
    const tab = this.#create({path, kind: 'manifest', content, revision, readOnly: false, lineEnding});
    this.#manifest = tab;
    this.activate(path);
    return tab;
  }

  /** Opens a file in a tab of its own, or shows the tab it already has. */
  async open(path: string): Promise<Tab> {
    const existing = this.#tabs.get(path);
    if (existing !== undefined) {
      this.activate(path);
      return existing;
    }
    const file = await this.#options.api.get<OpenedFile>(`/api/file?path=${encodeURIComponent(path)}`);
    const tab = this.#tabs.get(path) ?? this.#create(file);
    this.activate(path);
    return tab;
  }

  activate(path: string): void {
    const tab = this.#tabs.get(path);
    if (tab === undefined) {
      return;
    }
    for (const other of this.#tabs.values()) {
      const selected = other === tab;
      other.button.setAttribute('aria-selected', String(selected));
      other.button.tabIndex = selected ? 0 : -1;
      other.panel.hidden = !selected;
    }
    this.#active = tab;
    this.#options.onActivate(tab);
    this.#options.onChange();
  }

  /** Closes a tab; a dirty one only after the author agrees to lose its changes. */
  close(path: string): void {
    const tab = this.#tabs.get(path);
    if (tab === undefined || tab.kind === 'manifest') {
      return;
    }
    if (tab.dirty && !window.confirm(`${baseName(path)} has unsaved changes. Close it and lose them?`)) {
      return;
    }
    tab.view?.destroy();
    tab.panel.remove();
    tab.button.parentElement?.remove();
    this.#tabs.delete(path);
    if (this.#active === tab && this.#manifest !== null) {
      this.activate(this.#manifest.path);
    }
    this.#options.onChange();
  }

  /** Puts the cursor at a place and gives the tab's editor focus. */
  reveal(tab: Tab, line: number | null, column: number | null): void {
    this.activate(tab.path);
    const view = tab.view;
    if (view === null) {
      tab.panel.querySelector<HTMLElement>('[tabindex]')?.focus();
      return;
    }
    const doc = view.state.doc;
    const target = doc.line(Math.min(Math.max(1, line ?? 1), doc.lines));
    const position = Math.min(target.to, target.from + Math.max(0, (column ?? 1) - 1));
    view.dispatch({selection: EditorSelection.cursor(position), effects: EditorView.scrollIntoView(position, {y: 'center'})});
    view.focus();
  }

  /** Gives the active tab's editor focus, its selection as it was (IC06 `returnFocus`). */
  focusActive(): void {
    this.#active?.view?.focus();
  }

  /** Replaces a tab's diagnostics. */
  setDiagnostics(tab: Tab, diagnostics: readonly Diagnostic[]): void {
    if (tab.view !== null) {
      tab.view.dispatch(setDiagnostics(tab.view.state, diagnostics));
    }
  }

  /** Swaps the schema the manifest is completed and explained with. */
  setSchema(schema: unknown): void {
    if (this.#manifest?.view !== null && this.#manifest?.view !== undefined) {
      setCompletionSchema(this.#manifest.view, schema);
    }
  }

  #replace(tab: Tab, content: string, revision: string): void {
    if (tab.view !== null) {
      const view = tab.view;
      const head = Math.min(view.state.selection.main.head, content.length);
      view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: content}, selection: EditorSelection.cursor(head)});
      tab.savedText = view.state.doc.toString();
    } else {
      tab.panel.replaceChildren(csvTable(tab.path, content));
      tab.savedText = content;
    }
    tab.baseRevision = revision;
    tab.conflict = null;
    tab.dirty = false;
    this.#label(tab);
  }

  /**
   * Saves one tab against its base revision (IC05). A refusal because the
   * disk moved becomes a conflict; the file is never overwritten.
   */
  async save(tab: Tab): Promise<'saved' | 'unchanged' | 'conflict'> {
    if (tab.kind === 'data') {
      return 'unchanged';
    }
    if (tab.conflict !== null) {
      return 'conflict';
    }
    if (!tab.dirty) {
      return 'unchanged';
    }
    const content = this.text(tab);
    try {
      const reply = await this.#options.api.send<{revision: string}>('PUT', '/api/file', {path: tab.path, content, expectedRevision: tab.baseRevision});
      tab.baseRevision = reply.revision;
      tab.savedText = content;
      tab.dirty = this.text(tab) !== content;
      this.#label(tab);
      this.#options.onChange();
      return 'saved';
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        tab.conflict = {currentRevision: typeof error.body['currentRevision'] === 'string' ? error.body['currentRevision'] : null};
        this.#label(tab);
        this.#options.onChange();
        return 'conflict';
      }
      throw error;
    }
  }

  /**
   * Saves every changed tab, the manifest first, one after another, and stops
   * at the first conflict. Returns what was saved and where it stopped.
   */
  async saveAll(): Promise<{saved: string[]; stoppedAt: string | null}> {
    const saved: string[] = [];
    const order = this.tabs.filter((tab) => tab.dirty || tab.conflict !== null);
    for (const tab of order) {
      const outcome = await this.save(tab);
      if (outcome === 'conflict') {
        return {saved, stoppedAt: tab.path};
      }
      if (outcome === 'saved') {
        saved.push(tab.path);
      }
    }
    return {saved, stoppedAt: null};
  }

  /** Reload: the disk's text replaces the buffer. */
  async reload(tab: Tab): Promise<void> {
    const file = await this.#options.api.get<OpenedFile>(`/api/file?path=${encodeURIComponent(tab.path)}`);
    this.#replace(tab, file.content, file.revision);
    this.#options.onChange();
    this.#options.onEdit(tab);
  }

  /**
   * Keep mine: the buffer stays and the disk's revision is acknowledged; the
   * next save checks against it. A file that is gone cannot be kept this way:
   * the editor never creates files.
   */
  keepMine(tab: Tab): boolean {
    if (tab.conflict === null || tab.conflict.currentRevision === null) {
      return false;
    }
    tab.baseRevision = tab.conflict.currentRevision;
    tab.conflict = null;
    // The disk's text was never loaded, so the buffer counts as changed until it is saved.
    tab.dirty = true;
    tab.savedText = '';
    this.#label(tab);
    this.#options.onChange();
    this.#options.onEdit(tab);
    return true;
  }

  /** A file changed on disk (an SSE `file-changed`, or a recheck after reconnecting). */
  async diskChanged(path: string, revision: string | null): Promise<void> {
    const tab = this.#tabs.get(path);
    if (tab === undefined) {
      return;
    }
    switch (diskOutcome(tab, revision)) {
      case 'unchanged':
        return;
      case 'reload':
        // A clean buffer holds nothing of the author's: take the disk's text (D81).
        await this.reload(tab);
        this.#options.note(`${baseName(path)} changed on disk and was reloaded.`);
        return;
      case 'resolved':
        tab.conflict = null;
        break;
      case 'conflict':
        tab.conflict = {currentRevision: revision};
        break;
    }
    this.#label(tab);
    this.#options.onChange();
  }
}
