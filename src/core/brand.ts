/**
 * M1.3: the wordmark a piece shows.
 *
 * The public default is `theme/brand.default.json` (D04, D05: `papeleria`).
 * An owner may override it in `brand/brand.json`, which stays under `brand/`;
 * a manifest's own `wordmark` overrides both. The owner's marks never enter a
 * piece: only the wordmark text is read here.
 */
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

import {locateToolRoot} from './paths.js';
import {ToolResourceError, type BrandSettings} from './types.js';

export type BrandFile = {readonly wordmark?: string};

/** The theme default, and the owner's override when `brand/brand.json` exists. */
export type BrandFiles = {readonly theme: {readonly wordmark: string}; readonly owner: BrandFile | null};

/** Checks a parsed brand file: an object whose only key is an optional non-blank `wordmark`. */
export function parseBrandFile(value: unknown, file: string): BrandFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ToolResourceError(file, 'must be a JSON object such as {"wordmark": "papeleria"}');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'wordmark') {
      throw new ToolResourceError(file, `has the unknown key ${key}; only wordmark is read`);
    }
  }
  const wordmark = record['wordmark'];
  if (wordmark === undefined) {
    return Object.freeze({});
  }
  if (typeof wordmark !== 'string' || wordmark.trim() === '') {
    throw new ToolResourceError(file, 'wordmark must be non-blank text');
  }
  return Object.freeze({wordmark});
}

function readBrandFile(file: string): BrandFile {
  let parsed: unknown;
  try {
    // TextDecoder removes one leading byte-order mark, which Windows editors may
    // save and JSON.parse refuses; piece files lose theirs the same way (D152).
    parsed = JSON.parse(new TextDecoder().decode(readFileSync(file)));
  } catch (error) {
    throw new ToolResourceError(file, `cannot be read: ${(error as Error).message}`);
  }
  return parseBrandFile(parsed, file);
}

/** Reads the theme default and, when present, the owner's `brand/brand.json`. */
export function loadBrandFiles(toolRoot: string = locateToolRoot()): BrandFiles {
  const themeFile = join(toolRoot, 'theme', 'brand.default.json');
  const theme = readBrandFile(themeFile);
  if (theme.wordmark === undefined) {
    throw new ToolResourceError(themeFile, 'must name the default wordmark');
  }
  const ownerFile = join(toolRoot, 'brand', 'brand.json');
  const owner = existsSync(ownerFile) ? readBrandFile(ownerFile) : null;
  return Object.freeze({theme: Object.freeze({wordmark: theme.wordmark}), owner});
}

/** The manifest's wordmark, else the owner's, else the theme default. */
export function resolveBrand(files: BrandFiles, manifestWordmark?: string): BrandSettings {
  if (manifestWordmark !== undefined) {
    return Object.freeze({wordmark: manifestWordmark, source: 'manifest'});
  }
  if (files.owner?.wordmark !== undefined) {
    return Object.freeze({wordmark: files.owner.wordmark, source: 'owner'});
  }
  return Object.freeze({wordmark: files.theme.wordmark, source: 'theme'});
}
