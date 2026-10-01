/**
 * M2.4: the report's findings in the editor (IC01, IC06, D86, UX §08).
 *
 * The pipeline's report is the only source of diagnostics (D75): no linter
 * runs in the page. A finding with a file the editor has open and a line is
 * underlined there, from its column to the end of the word it points at (the
 * whole line's text when it has no column), with a gutter mark, in the
 * error or warning colour and never without its message. A finding without a
 * line — an image, a generated file, the piece as a whole — is never given
 * one: it appears in the list with its file and, when it has one, its
 * related location, which is where a click takes the author. The bar shows
 * the counts, then the message for the cursor's line; a count opens the full
 * list; a finding in the list jumps to its place.
 */
import type {Diagnostic} from '@codemirror/lint';
import type {Text} from '@codemirror/state';

import {element} from './dom.js';
import type {Tab, TabSet} from './tabs.js';

export type Location = {readonly file: string; readonly line: number | null; readonly column: number | null};
export type Finding = Location & {
  readonly rule: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly fix: string;
  readonly detail: string | null;
  readonly relatedLocation?: Location;
};

/** Where a finding's underline runs in a document: from its column to the end of the word, or the line's text. */
export function findingRange(doc: Text, line: number, column: number | null): {from: number; to: number} {
  const target = doc.line(Math.min(Math.max(1, line), doc.lines));
  const text = target.text;
  if (column === null) {
    const indent = /^\s*/.exec(text)![0].length;
    return {from: target.from + indent, to: Math.max(target.from + indent, target.from + text.trimEnd().length)};
  }
  const start = Math.min(text.length, Math.max(0, column - 1));
  let end = start;
  while (end < text.length && !/[\s:,[\]{}#]/.test(text[end]!)) {
    end += 1;
  }
  if (end === start && start < text.length) {
    end = start + 1;
  }
  return {from: target.from + start, to: target.from + end};
}

export function locationText(location: Location): string {
  return location.line === null ? location.file : `${location.file}:${location.line}${location.column === null ? '' : `:${location.column}`}`;
}

export type DiagnosticsOptions = {
  readonly tabs: TabSet;
  readonly errors: HTMLButtonElement;
  readonly warnings: HTMLButtonElement;
  readonly cursor: HTMLElement;
  readonly list: HTMLElement;
  /** Opens a location in its tab, when the editor can open that file. */
  readonly openAt: (location: Location) => Promise<boolean>;
};

export class Diagnostics {
  readonly #options: DiagnosticsOptions;
  #findings: readonly Finding[] = [];
  #cursor: {path: string; line: number} | null = null;

  constructor(options: DiagnosticsOptions) {
    this.#options = options;
    const toggle = (): void => this.toggleList();
    options.errors.addEventListener('click', toggle);
    options.warnings.addEventListener('click', toggle);
    options.list.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.toggleList(false);
        options.errors.focus();
      }
    });
    this.#render();
  }

  get findings(): readonly Finding[] {
    return this.#findings;
  }

  /** Shows a report's findings in place of the last ones. */
  apply(findings: readonly Finding[]): void {
    this.#findings = findings;
    for (const tab of this.#options.tabs.tabs) {
      this.#applyTab(tab);
    }
    this.#render();
  }

  /** A tab opened after the report came: give it its findings. */
  tabOpened(tab: Tab): void {
    this.#applyTab(tab);
  }

  /** The cursor moved: the bar shows the message for its line. */
  cursorAt(path: string, line: number): void {
    this.#cursor = {path, line};
    this.#renderCursor();
  }

  toggleList(show?: boolean): void {
    const open = show ?? this.#options.list.hidden;
    this.#options.list.hidden = !open;
    this.#options.errors.setAttribute('aria-expanded', String(open));
    this.#options.warnings.setAttribute('aria-expanded', String(open));
    if (open) {
      this.#options.list.querySelector<HTMLButtonElement>('button')?.focus();
    }
  }

  #applyTab(tab: Tab): void {
    if (tab.view === null) {
      return;
    }
    const doc = tab.view.state.doc;
    const diagnostics: Diagnostic[] = [];
    for (const finding of this.#findings) {
      if (finding.file !== tab.path || finding.line === null) {
        continue;
      }
      const {from, to} = findingRange(doc, finding.line, finding.column);
      diagnostics.push({
        from,
        to,
        severity: finding.severity,
        source: finding.rule,
        message: `${finding.message} (${finding.rule})`,
        renderMessage: () => {
          const box = element('div', {class: 'papeleria-finding'});
          box.append(element('p', {}, `${finding.message} (${finding.rule})`), element('p', {class: 'papeleria-finding-fix'}, `Fix: ${finding.fix}`));
          if (finding.detail !== null) {
            box.append(element('p', {class: 'papeleria-finding-detail'}, finding.detail));
          }
          return box;
        },
      });
    }
    this.#options.tabs.setDiagnostics(tab, diagnostics);
  }

  #render(): void {
    const errors = this.#findings.filter((finding) => finding.severity === 'error').length;
    const warnings = this.#findings.length - errors;
    this.#options.errors.textContent = `✕ ${errors} ${errors === 1 ? 'error' : 'errors'}`;
    this.#options.warnings.textContent = `⚠ ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`;
    this.#options.errors.classList.toggle('has-errors', errors > 0);
    this.#options.warnings.classList.toggle('has-warnings', warnings > 0);
    const list = element('ul', {class: 'diagnostics-items'});
    for (const finding of this.#findings) {
      list.append(this.#item(finding));
    }
    if (this.#findings.length === 0) {
      list.append(element('li', {class: 'diagnostics-none'}, 'No errors or warnings.'));
    }
    this.#options.list.replaceChildren(list);
    this.#renderCursor();
  }

  #item(finding: Finding): HTMLElement {
    const item = element('li', {class: `diagnostics-item is-${finding.severity}`});
    const jump = element('button', {type: 'button', class: 'diagnostics-jump'});
    jump.append(
      element('span', {class: 'diagnostics-where'}, locationText(finding)),
      element('span', {class: 'diagnostics-rule'}, ` ${finding.severity} ${finding.rule}: `),
      element('span', {class: 'diagnostics-message'}, finding.message),
    );
    jump.addEventListener('click', () => void this.#jump(finding));
    item.append(jump, element('p', {class: 'diagnostics-fix'}, `Fix: ${finding.fix}`));
    if (finding.detail !== null) {
      item.append(element('p', {class: 'diagnostics-detail'}, finding.detail));
    }
    if (finding.relatedLocation !== undefined) {
      const related = element('button', {type: 'button', class: 'diagnostics-related'}, `See ${locationText(finding.relatedLocation)}`);
      related.addEventListener('click', () => void this.#options.openAt(finding.relatedLocation!));
      item.append(related);
    }
    return item;
  }

  async #jump(finding: Finding): Promise<void> {
    // A finding with no line of its own is taken to its related place, never to an invented line 1.
    if (finding.line === null && finding.relatedLocation !== undefined) {
      await this.#options.openAt(finding.relatedLocation);
      return;
    }
    await this.#options.openAt(finding);
  }

  #renderCursor(): void {
    const at = this.#cursor;
    const finding = at === null ? undefined : this.#findings.find((item) => item.file === at.path && item.line === at.line);
    this.#options.cursor.textContent = finding === undefined ? '' : `${finding.line}: ${finding.message} (${finding.rule})`;
  }
}
