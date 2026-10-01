/**
 * Small DOM helpers for the editor. Every piece of text goes in through
 * `textContent`; the editor never parses markup from a string.
 */

/** The element with `id`, which the page must have. */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`the editor page has no #${id}`);
  }
  return element as T;
}

/** A new element with attributes and text. */
export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Readonly<Record<string, string>> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const created = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    created.setAttribute(name, value);
  }
  if (text !== undefined) {
    created.textContent = text;
  }
  return created;
}

/** The last segment of a path. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
