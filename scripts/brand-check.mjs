#!/usr/bin/env node
/**
 * R12 brand check (D05).
 *
 * Owner-exclusive assets live only under `brand/`. When they are supplied, their
 * SHA-256 hashes are listed in `brand/owner-assets.sha256`. This script hashes
 * every regular file under a root and fails if any of them matches that
 * inventory, which is how a copied owner mark in examples, theme or generated
 * output is caught.
 *
 * An absent inventory means "no owner assets are supplied". That is reported as
 * an explicit note and passes; it is never a silent skip, and it is not
 * permission to introduce unidentified owner marks.
 *
 * The public `theme/brand.default.json`, `theme/marks/papeleria-favicon.svg` and
 * client logos under a piece's `assets/images/logos/` are allowed because they
 * are not in the inventory. A file name or keyword is never the test, and a hash
 * cannot establish rights in a transformed derivative; that needs review.
 *
 * Usage: node scripts/brand-check.mjs [--root <dir>] [--inventory <file>]
 * Exit:  0 pass · 1 an inventoried hash was found outside brand/ · 2 usage or IO
 */
import {existsSync} from 'node:fs';
import {basename, join, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const applicationRoot = fileURLToPath(new URL('..', import.meta.url));

const INVENTORY_RELATIVE_PATH = join('brand', 'owner-assets.sha256');

/** Directory names skipped at any depth. */
const SKIPPED_ANYWHERE = new Set(['.git', 'node_modules', '.papeleria']);

/**
 * Directory names skipped only directly under the root: the owner's brand/,
 * and lib/ and dist/, the tool's own output there. Deeper down a folder of
 * either name is an author's or a piece's and is scanned, so an owner mark
 * under a sample's assets/lib/ is found (W5R-25).
 */
const SKIPPED_AT_ROOT = new Set(['brand', 'lib', 'dist']);

function parseArguments(argv) {
  const options = {root: process.cwd(), inventory: null};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--root' || flag === '--inventory') {
      if (value === undefined) {
        throw new UsageError(`${flag} needs a path`);
      }
      options[flag === '--root' ? 'root' : 'inventory'] = value;
      index += 1;
    } else {
      throw new UsageError(`unknown argument ${JSON.stringify(flag)}`);
    }
  }
  options.root = resolve(options.root);
  options.inventory = options.inventory === null
    ? join(options.root, INVENTORY_RELATIVE_PATH)
    : resolve(options.inventory);
  return options;
}

class UsageError extends Error {}

/**
 * The inventory logic the build's R12 rule uses too (src/checks/owner-inventory.ts),
 * compiled into lib/ by npm run build, which CI and npm test run first (D162, D66).
 */
export async function loadInventoryModule() {
  const entry = join(applicationRoot, 'lib', 'src', 'checks', 'owner-inventory.js');
  if (!existsSync(entry)) {
    throw new UsageError(`${relative(applicationRoot, entry)} is missing; run npm run build first, because this check shares its inventory logic with the build's R12 rule`);
  }
  return import(pathToFileURL(entry).href);
}

/** Runs the check and returns a result object; does not exit. */
export async function checkBrand({root, inventory}) {
  const shared = await loadInventoryModule();
  const owners = shared.readInventory(inventory);
  const result = shared.checkTree(root, owners, {skipAnywhere: SKIPPED_ANYWHERE, skipAtRoot: SKIPPED_AT_ROOT});
  return {root, inventory, ...result};
}

function report(result) {
  const lines = [];
  lines.push(`brand check: root ${result.root}`);
  if (!result.inventoryPresent) {
    lines.push(
      `note: ${relative(result.root, result.inventory) || basename(result.inventory)} is absent, ` +
        'so no owner-exclusive assets are supplied. Nothing was compared. This is not ' +
        'permission to introduce unidentified owner marks (D05).',
    );
  } else if (result.ownerCount === 0) {
    lines.push(
      `note: the inventory ${result.inventory} lists no hashes, so nothing was compared.`,
    );
  } else {
    lines.push(`inventory: ${result.ownerCount} owner hash(es) from ${result.inventory}`);
  }
  lines.push(`scanned: ${result.scanned} regular file(s), excluding .git, node_modules and .papeleria at any depth, and brand/, lib/ and dist/ at the root`);
  if (result.matches.length === 0) {
    lines.push('result: pass — no inventoried owner asset was found outside brand/');
  } else {
    lines.push(`result: FAIL — ${result.matches.length} copied owner asset(s) (R12)`);
    for (const match of result.matches) {
      lines.push(`  ${match.path} has the hash of ${match.owner} (${match.hash})`);
    }
    lines.push('fix: remove the copy, or move the asset back under brand/ and reference it from there.');
  }
  return lines.join('\n');
}

async function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`brand-check: ${error.message}\n`);
    process.stderr.write('usage: node scripts/brand-check.mjs [--root <dir>] [--inventory <file>]\n');
    return 2;
  }

  let result;
  try {
    result = await checkBrand(options);
  } catch (error) {
    process.stderr.write(`brand-check: ${error.message}\n`);
    return 2;
  }

  process.stdout.write(`${report(result)}\n`);
  return result.matches.length === 0 ? 0 : 1;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  process.exitCode = await main(process.argv.slice(2));
}
