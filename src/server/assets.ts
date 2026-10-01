/**
 * M2.1, M2.6: the tool files each origin serves without the token (IC06:
 * "serve only tool entry assets unauthenticated", D78).
 *
 * The list is closed: the editor page, its script and stylesheet from
 * `lib/clients/editor/`, `serve`'s shell from `lib/clients/serve/`, and the
 * kit's stylesheets, eight fonts and favicon from `theme/`. Each is read from
 * the tool root, never from the piece. The editor page is a template with a
 * per-request nonce for the style elements CodeMirror mounts, which the
 * page's policy names instead of allowing inline styles wholesale.
 */
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

import {FONT_FILES} from '../build/stage.js';

export type ToolAsset = {readonly source: string; readonly type: string};

const THEME: Readonly<Record<string, ToolAsset>> = Object.freeze({
  '/theme/css/tokens.css': {source: 'theme/css/tokens.css', type: 'text/css; charset=utf-8'},
  '/theme/css/fonts.css': {source: 'theme/css/fonts.css', type: 'text/css; charset=utf-8'},
  '/theme/css/site.css': {source: 'theme/css/site.css', type: 'text/css; charset=utf-8'},
  '/theme/marks/papeleria-favicon.svg': {source: 'theme/marks/papeleria-favicon.svg', type: 'image/svg+xml'},
  ...Object.fromEntries(FONT_FILES.map((font) => [`/theme/fonts/${font}`, {source: `theme/fonts/${font}`, type: 'font/woff2'}])),
});

/** The editor origin's files; `/` is the page template. */
export const EDITOR_ASSETS: Readonly<Record<string, ToolAsset>> = Object.freeze({
  '/': {source: 'lib/clients/editor/index.html', type: 'text/html; charset=utf-8'},
  '/editor.js': {source: 'lib/clients/editor/editor.js', type: 'text/javascript; charset=utf-8'},
  '/editor.css': {source: 'lib/clients/editor/editor.css', type: 'text/css; charset=utf-8'},
  ...THEME,
});

/** `serve`'s shell. */
export const SERVE_ASSETS: Readonly<Record<string, ToolAsset>> = Object.freeze({
  '/': {source: 'lib/clients/serve/index.html', type: 'text/html; charset=utf-8'},
  '/serve.js': {source: 'lib/clients/serve/serve.js', type: 'text/javascript; charset=utf-8'},
  '/serve.css': {source: 'lib/clients/serve/serve.css', type: 'text/css; charset=utf-8'},
  '/theme/css/tokens.css': THEME['/theme/css/tokens.css']!,
  '/theme/marks/papeleria-favicon.svg': THEME['/theme/marks/papeleria-favicon.svg']!,
});

/** The placeholder the editor page carries where the style nonce goes. */
export const NONCE_PLACEHOLDER = '__PAPELERIA_STYLE_NONCE__';

/** A tool asset's bytes, or null when the installation lacks it. */
export async function readToolAsset(toolRoot: string, asset: ToolAsset): Promise<Buffer | null> {
  try {
    return await readFile(join(toolRoot, ...asset.source.split('/')));
  } catch {
    return null;
  }
}

/** The editor page's policy: its own scripts and files, styles by nonce, frames from the preview origin only. */
export function editorPolicy(nonce: string, previewOrigin: string): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    `frame-src ${previewOrigin}`,
    "worker-src 'none'",
    "manifest-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** `serve`'s shell policy: its own files, a same-origin event stream, frames from the preview origin only. */
export function servePolicy(previewOrigin: string): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    `frame-src ${previewOrigin}`,
    "worker-src 'none'",
    "manifest-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}
