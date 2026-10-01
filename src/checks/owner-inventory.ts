/**
 * R12: the owner-asset hash inventory (D05), shared by the build's R12 rule
 * and `scripts/brand-check.mjs`, which imports it from `lib/` after a build as
 * D162 has the content check import the core.
 *
 * Owner-exclusive files live only under `brand/`; when they are supplied,
 * `brand/owner-assets.sha256` lists their SHA-256 hashes. A file anywhere else
 * with one of those hashes is a copy of an owner asset. An absent inventory
 * means no owner assets are supplied, which is said, never skipped silently.
 * Public theme defaults, the favicon and client logos pass because they are
 * not in the inventory; a hash cannot see rights in a transformed derivative.
 */
import {createHash} from 'node:crypto';
import {existsSync, lstatSync, readdirSync, readFileSync} from 'node:fs';
import {join, relative} from 'node:path';

/** Where the inventory is, relative to the tool root or a scanned root. */
export const INVENTORY_PATH = join('brand', 'owner-assets.sha256');

/** The inventory cannot be read as one: a configuration failure, never a finding (exit 2). */
export class InventoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InventoryError';
  }
}

/**
 * Reads a sha256sum-style inventory: `<hash>  <path>`, `<hash> *<path>` or a
 * bare `<hash>`; blank lines and `#` comments are ignored. Returns each hash,
 * lower case, with the names given for it.
 */
export function parseInventory(text: string, inventoryPath: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const match = /^([0-9a-fA-F]{64})(?:\s+\*?(.*))?$/.exec(line);
    if (match === null) {
      throw new InventoryError(`${inventoryPath}:${index + 1} is not a SHA-256 inventory line: ${JSON.stringify(rawLine)}`);
    }
    const hash = match[1]!.toLowerCase();
    const label = (match[2] ?? '').trim();
    const existing = entries.get(hash);
    if (existing === undefined) {
      entries.set(hash, label === '' ? '(unnamed owner asset)' : label);
    } else if (label !== '' && existing !== label) {
      entries.set(hash, `${existing}, ${label}`);
    }
  }
  return entries;
}

/** The inventory at a path, or null when it is absent. */
export function readInventory(inventoryPath: string): Map<string, string> | null {
  if (!existsSync(inventoryPath)) {
    return null;
  }
  let text: string;
  try {
    text = readFileSync(inventoryPath, 'utf8');
  } catch (error) {
    throw new InventoryError(`cannot read ${inventoryPath}: ${(error as Error).message}`);
  }
  return parseInventory(text, inventoryPath);
}

export type WalkOptions = {
  /** Folder names skipped at any depth. */
  readonly skipAnywhere?: ReadonlySet<string>;
  /** Folder names skipped only directly under the root. */
  readonly skipAtRoot?: ReadonlySet<string>;
};

/** Every regular file under `root`, in name order; a symbolic link carries no bytes of its own and is not followed. */
export function* walkRegularFiles(root: string, options: WalkOptions = {}, directory: string = root): Generator<string> {
  let items;
  try {
    items = readdirSync(directory, {withFileTypes: true});
  } catch (error) {
    throw new InventoryError(`cannot read ${directory}: ${(error as Error).message}`);
  }
  for (const item of items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const full = join(directory, item.name);
    if (item.isDirectory()) {
      if (options.skipAnywhere?.has(item.name) || (directory === root && options.skipAtRoot?.has(item.name))) {
        continue;
      }
      yield* walkRegularFiles(root, options, full);
    } else if (lstatSync(full).isFile()) {
      yield full;
    }
  }
}

export function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export type OwnerMatch = {readonly path: string; readonly hash: string; readonly owner: string};

export type TreeCheck = {
  readonly inventoryPresent: boolean;
  readonly ownerCount: number;
  readonly scanned: number;
  readonly matches: readonly OwnerMatch[];
};

/** Hashes every regular file under `root` against an inventory; paths in the result are relative to `root`. */
export function checkTree(root: string, owners: ReadonlyMap<string, string> | null, options: WalkOptions = {}): TreeCheck {
  const matches: OwnerMatch[] = [];
  let scanned = 0;
  for (const file of walkRegularFiles(root, options)) {
    scanned += 1;
    if (owners !== null && owners.size > 0) {
      const hash = sha256OfFile(file);
      const owner = owners.get(hash);
      if (owner !== undefined) {
        matches.push({path: relative(root, file).split('\\').join('/'), hash, owner});
      }
    }
  }
  return {inventoryPresent: owners !== null, ownerCount: owners?.size ?? 0, scanned, matches};
}
