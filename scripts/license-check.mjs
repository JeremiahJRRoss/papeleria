#!/usr/bin/env node
/**
 * R11 licence check (D18, D21, D24, D27).
 *
 * Reads package-lock.json and, where the package is installed on this platform,
 * that package's own package.json. Classifies every entry by scope, evaluates
 * its SPDX expression with an owned mini-evaluator that understands AND, OR,
 * parentheses, `+` and `WITH`, and applies the scope allowlists from
 * docs/papeleria-erd-draft-0-3.md section 08 and docs/DEPENDENCIES.md.
 *
 *   published piece   MIT, ISC, BSD-2-Clause, BSD-3-Clause, OFL-1.1
 *   author runtime    the above plus Apache-2.0, plus LGPL-3.0-or-later for the
 *                     explicitly listed libvips-carrying sharp packages (D24)
 *   dev               the author-runtime set
 *
 * No npm package is in published-piece scope. What is emitted into a reader's
 * dist/ from outside Papeleria's own code is vendored instead: each
 * `vendor/<component>/VERSION` (written by scripts/vendor-page-flip.mjs, D100)
 * names the component, its SPDX expression and its licence file with that
 * file's SHA-256, and is checked here in published-piece scope. So are the
 * fonts (M5.3, D125): every WOFF2 file under `theme/fonts/` belongs to a family
 * in FONT_FAMILIES, whose OFL-1.1 text must be there beside it.
 *
 * Anything else fails unless scripts/license-exceptions.json names that exact
 * package, version, scope and licence with a rationale. An exception can never
 * admit copyleft (GPL, AGPL, LGPL outside the libvips list, SSPL, EUPL), and
 * none applies in published-piece scope (D21).
 *
 * The licence texts the package retains are held too (D36, D126): every text
 * licenses/index.json names must be the size and SHA-256 it records, and a
 * licenses/*.txt it does not name fails (W5R-05).
 *
 * Two modes. The ordinary development check fails only on a licence that is not
 * allowed and on evidence that has gone stale. `--release` additionally fails on
 * anything a publication must not carry: a provisional exception still in use,
 * required evidence that could not be resolved on this platform, and an
 * incomplete native distribution review. A release check that fails because an
 * obligation is genuinely outstanding is the correct result, not a bug.
 *
 * Usage: node scripts/license-check.mjs [--release] [--root <dir>] [--exceptions <file>]
 *                                       [--evidence <file>] [--scope <file>]
 *                                       [--observations <file>] [--reviews <file>]
 *                                       [--spdx-cases <file>]
 * Exit:  0 pass · 1 a licence is not allowed, evidence failed, or (in release
 *        mode) a release blocker remains · 2 usage or IO
 */
import {createHash} from 'node:crypto';
import {existsSync, lstatSync, readdirSync, readFileSync, realpathSync} from 'node:fs';
import {join, resolve, sep} from 'node:path';
import {pathToFileURL} from 'node:url';

import {NativeConfigError, reconcileNative} from './native-reconcile.mjs';
import {parseVersion} from './vendor-page-flip.mjs';

class UsageError extends Error {}

// ---------------------------------------------------------------- policy ----

/**
 * The allowed licences, written out per scope.
 *
 * Each set is a full literal on purpose. An earlier version derived dev from the
 * author-runtime array, which meant that approving a licence for one scope
 * silently approved it for another. Approval is a per-scope decision, so the
 * sets do not share arrays and a reader can see exactly what each scope permits.
 *
 * published-piece  ERD section 08, unchanged. This is the set that governs code
 *                  emitted into a reader's dist/.
 * author-runtime   the permissive base, plus Apache-2.0 (D18), plus PSF-2.0,
 *                  Python-2.0 and 0BSD approved by the owner on 2026-09-22
 *                  (D29). All three are permissive and none is copyleft.
 * dev              the permissive base plus Apache-2.0. Deliberately NOT
 *                  widened by D29: no dev package needs those identifiers
 *                  today, and widening a scope nobody asked about is how an
 *                  allowlist stops meaning anything.
 */
export const ALLOWLISTS = {
  'published-piece': new Set([
    'MIT',
    'ISC',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'OFL-1.1',
  ]),
  'author-runtime': new Set([
    'MIT',
    'ISC',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'OFL-1.1',
    'Apache-2.0',
    'PSF-2.0',
    'Python-2.0',
    '0BSD',
  ]),
  dev: new Set([
    'MIT',
    'ISC',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'OFL-1.1',
    'Apache-2.0',
  ]),
};

/** Identifiers D29 added, and the scope it added them to. Reported, not guessed. */
export const OWNER_APPROVED_IDENTIFIERS = {
  'author-runtime': ['PSF-2.0', 'Python-2.0', '0BSD'],
};

/**
 * The only packages that may carry LGPL-3.0-or-later: the sharp binaries that
 * bundle libvips. Named one by one so a new platform package cannot inherit the
 * exception silently (D24). The win32 and wasm32 builds declare
 * `Apache-2.0 AND LGPL-3.0-or-later` because they link libvips statically; the
 * ERD text mentions only `@img/sharp-libvips-*`, which the 0.35 tree disproves.
 */
export const LIBVIPS_PACKAGES = new Set([
  '@img/sharp-libvips-darwin-arm64',
  '@img/sharp-libvips-darwin-x64',
  '@img/sharp-libvips-linux-arm',
  '@img/sharp-libvips-linux-arm64',
  '@img/sharp-libvips-linux-ppc64',
  '@img/sharp-libvips-linux-riscv64',
  '@img/sharp-libvips-linux-s390x',
  '@img/sharp-libvips-linux-x64',
  '@img/sharp-libvips-linuxmusl-arm64',
  '@img/sharp-libvips-linuxmusl-x64',
  '@img/sharp-win32-arm64',
  '@img/sharp-win32-ia32',
  '@img/sharp-win32-x64',
  '@img/sharp-wasm32',
]);

/**
 * The SPDX licence exceptions this checker understands, as `<licence> WITH <id>`.
 *
 * An exception may add permissions or take them away: `Apache-2.0 WITH
 * LLVM-exception` is still permissive, while a rider such as `Commons-Clause`
 * forbids selling the software. There is no way to decide an unseen one, and a
 * misspelling looks exactly like a real exception, so anything not named here
 * is treated as the unknown expression it is and refused pending review.
 * Adding an entry means someone read that exception's text.
 */
const RECOGNIZED_LICENSE_EXCEPTIONS = new Set(['LLVM-exception']);

/** Never allowed in any scope, and never grantable by an exception. */
const COPYLEFT_PREFIXES = ['GPL-', 'AGPL-', 'LGPL-', 'SSPL-', 'EUPL-'];

/**
 * The font families a published piece carries (D18, D62), each with the file
 * name prefix of its WOFF2 subsets and the licence text that must travel with
 * them. Named one by one, as LIBVIPS_PACKAGES is: a font file that no family
 * claims is an unrecorded component and fails, rather than inheriting a
 * licence from its folder.
 */
export const FONT_FAMILIES = Object.freeze([
  Object.freeze({family: 'Poppins', prefix: 'poppins-', text: 'theme/fonts/Poppins-OFL.txt', spdx: 'OFL-1.1'}),
  Object.freeze({family: 'Inter', prefix: 'inter-', text: 'theme/fonts/Inter-OFL.txt', spdx: 'OFL-1.1'}),
]);

/** Font files, by extension. Anything else under theme/fonts/ is a text or a stray, and not a font. */
const FONT_FILE = /\.(?:woff2?|ttf|otf)$/i;

export function isCopyleft(identifier) {
  return COPYLEFT_PREFIXES.some((prefix) => identifier.startsWith(prefix));
}

// ------------------------------------------------------------ SPDX parser ---

/**
 * Tokenises an SPDX licence expression. Parentheses are separate tokens; every
 * other run of non-space, non-parenthesis characters is one token.
 */
export function tokenizeSpdx(expression) {
  const tokens = [];
  let current = '';
  for (const character of expression) {
    if (character === '(' || character === ')') {
      if (current !== '') {
        tokens.push(current);
        current = '';
      }
      tokens.push(character);
    } else if (/\s/.test(character)) {
      if (current !== '') {
        tokens.push(current);
        current = '';
      }
    } else {
      current += character;
    }
  }
  if (current !== '') {
    tokens.push(current);
  }
  return tokens;
}

const IDENTIFIER = /^[A-Za-z0-9.+-]+$/;

/**
 * Parses an SPDX expression into {kind:'licence'|'and'|'or'} nodes.
 * Precedence, tightest first: `+`, `WITH`, `AND`, `OR`.
 */
export function parseSpdx(expression) {
  const tokens = tokenizeSpdx(expression);
  let position = 0;

  const peek = () => tokens[position];
  const upper = () => (tokens[position] ?? '').toUpperCase();

  function parseLicence() {
    const token = peek();
    if (token === undefined) {
      throw new UsageError(`unexpected end of SPDX expression in ${JSON.stringify(expression)}`);
    }
    if (token === '(' || token === ')' || ['AND', 'OR', 'WITH'].includes(token.toUpperCase())) {
      throw new UsageError(`expected a licence identifier, found ${JSON.stringify(token)}`);
    }
    if (!IDENTIFIER.test(token)) {
      throw new UsageError(`${JSON.stringify(token)} is not an SPDX licence identifier`);
    }
    position += 1;
    let identifier = token;
    let orLater = false;
    if (identifier.endsWith('+')) {
      orLater = true;
      identifier = identifier.slice(0, -1);
    }
    let withException = null;
    if (upper() === 'WITH') {
      position += 1;
      const exceptionToken = peek();
      if (exceptionToken === undefined || !IDENTIFIER.test(exceptionToken)) {
        throw new UsageError(`WITH needs an exception identifier in ${JSON.stringify(expression)}`);
      }
      position += 1;
      withException = exceptionToken;
    }
    return {kind: 'licence', identifier, orLater, withException};
  }

  function parseTerm() {
    if (peek() === '(') {
      position += 1;
      const inner = parseOr();
      if (peek() !== ')') {
        throw new UsageError(`unbalanced parentheses in ${JSON.stringify(expression)}`);
      }
      position += 1;
      return inner;
    }
    return parseLicence();
  }

  function parseAnd() {
    let node = parseTerm();
    while (upper() === 'AND') {
      position += 1;
      node = {kind: 'and', left: node, right: parseTerm()};
    }
    return node;
  }

  function parseOr() {
    let node = parseAnd();
    while (upper() === 'OR') {
      position += 1;
      node = {kind: 'or', left: node, right: parseAnd()};
    }
    return node;
  }

  const tree = parseOr();
  if (position !== tokens.length) {
    throw new UsageError(
      `trailing ${JSON.stringify(tokens.slice(position).join(' '))} in ${JSON.stringify(expression)}`,
    );
  }
  return tree;
}

/** Every licence identifier in an expression, in source order. */
export function licenceIdentifiers(node, collected = []) {
  if (node.kind === 'licence') {
    collected.push(node.identifier);
  } else {
    licenceIdentifiers(node.left, collected);
    licenceIdentifiers(node.right, collected);
  }
  return collected;
}

/**
 * Evaluates an expression tree. `isAllowedLeaf` receives the whole licence node,
 * not just its identifier, so that a `WITH` clause cannot be dropped on the way.
 * AND needs every operand; OR needs one, which is how a dual licence such as
 * `(AFL-2.1 OR BSD-3-Clause)` passes on its allowed half.
 */
export function evaluateSpdx(node, isAllowedLeaf) {
  switch (node.kind) {
    case 'licence':
      return isAllowedLeaf(node);
    case 'and':
      return evaluateSpdx(node.left, isAllowedLeaf) && evaluateSpdx(node.right, isAllowedLeaf);
    case 'or':
      return evaluateSpdx(node.left, isAllowedLeaf) || evaluateSpdx(node.right, isAllowedLeaf);
    default:
      throw new UsageError(`unknown expression node ${JSON.stringify(node.kind)}`);
  }
}

/**
 * Decides one declared expression for one package in one scope.
 * Returns {allowed, reason, usedExceptions, identifiers}.
 */
export function evaluateForPackage({expression, packageName, version, scope, exceptions}) {
  const allowlist = ALLOWLISTS[scope];
  if (allowlist === undefined) {
    throw new UsageError(`unknown scope ${JSON.stringify(scope)}`);
  }
  const tree = parseSpdx(expression);
  const usedExceptions = [];
  const unrecognizedExceptions = [];

  const isAllowedLeaf = ({identifier, withException}) => {
    // A WITH clause changes what the base licence permits, so an unrecognised
    // one makes the whole expression unknown rather than merely decorated.
    if (withException !== null && !RECOGNIZED_LICENSE_EXCEPTIONS.has(withException)) {
      if (!unrecognizedExceptions.includes(withException)) {
        unrecognizedExceptions.push(withException);
      }
      return false;
    }
    if (allowlist.has(identifier)) {
      return true;
    }
    // The libvips exception is author-only (D18): nothing from sharp is ever
    // emitted into a published piece, so published-piece scope never takes it.
    if (
      identifier === 'LGPL-3.0-or-later' &&
      scope !== 'published-piece' &&
      LIBVIPS_PACKAGES.has(packageName)
    ) {
      usedExceptions.push({kind: 'libvips', identifier, packageName});
      return true;
    }
    if (isCopyleft(identifier)) {
      return false;
    }
    const exception = findException(exceptions, {packageName, version, scope, identifier});
    if (exception !== undefined) {
      usedExceptions.push({kind: 'listed', identifier, packageName, exception});
      return true;
    }
    return false;
  };

  const allowed = evaluateSpdx(tree, isAllowedLeaf);
  return {allowed, usedExceptions, unrecognizedExceptions, identifiers: licenceIdentifiers(tree)};
}

export function findException(exceptions, {packageName, version, scope, identifier}) {
  return exceptions.find(
    (entry) =>
      entry.package === packageName &&
      entry.scope === scope &&
      entry.license === identifier &&
      (entry.version === undefined || entry.version === null || entry.version === version),
  );
}

// ------------------------------------------------------------- inventory ----

/** npm's legacy `licenses` array means a choice, so it becomes an OR. */
function expressionFromManifest(manifest) {
  if (typeof manifest.license === 'string' && manifest.license.trim() !== '') {
    return manifest.license.trim();
  }
  if (typeof manifest.license === 'object' && manifest.license !== null && typeof manifest.license.type === 'string') {
    return manifest.license.type.trim();
  }
  if (Array.isArray(manifest.licenses)) {
    const types = manifest.licenses
      .map((entry) => (typeof entry === 'string' ? entry : entry?.type))
      .filter((type) => typeof type === 'string' && type.trim() !== '');
    if (types.length > 0) {
      return types.length === 1 ? types[0] : `(${types.join(' OR ')})`;
    }
  }
  return null;
}

function scopeOf(entry) {
  // devOptional means "needed by dev, and optionally by production", so it is
  // classified conservatively as author runtime.
  return entry.dev === true ? 'dev' : 'author-runtime';
}

/** Reads every lockfile entry with its declared licence and scope. */
export function readInventory(root) {
  const lockPath = join(root, 'package-lock.json');
  if (!existsSync(lockPath)) {
    throw new UsageError(`no package-lock.json under ${root}`);
  }
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch (cause) {
    throw new UsageError(`cannot parse ${lockPath}: ${cause.message}`);
  }
  if (typeof lock.packages !== 'object' || lock.packages === null) {
    throw new UsageError(`${lockPath} has no "packages" map; lockfileVersion 2 or 3 is required`);
  }

  const inventory = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === '') {
      continue; // the project itself; its own licence is Apache-2.0 (D18)
    }
    const packageName = entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const manifestPath = join(root, path, 'package.json');
    const installed = existsSync(manifestPath);
    let declared = null;
    let source = 'package-lock.json';
    if (installed) {
      try {
        declared = expressionFromManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
        source = `${path}/package.json`;
      } catch (cause) {
        throw new UsageError(`cannot parse ${manifestPath}: ${cause.message}`);
      }
    }
    if (declared === null && typeof entry.license === 'string' && entry.license.trim() !== '') {
      declared = entry.license.trim();
      source = 'package-lock.json';
    }
    inventory.push({
      path,
      packageName,
      version: entry.version ?? null,
      scope: scopeOf(entry),
      optional: entry.optional === true || entry.devOptional === true,
      platform: Array.isArray(entry.os) || Array.isArray(entry.cpu),
      os: Array.isArray(entry.os) ? entry.os : null,
      cpu: Array.isArray(entry.cpu) ? entry.cpu : null,
      installed,
      declared,
      source,
    });
  }
  inventory.sort((a, b) => (a.packageName < b.packageName ? -1 : a.packageName > b.packageName ? 1 : 0));
  return inventory;
}

/** The keys a vendored component's VERSION record must carry for this check. */
const VENDORED_KEYS = ['npm_package', 'npm_version', 'license', 'license_spdx', 'license_sha256'];

/**
 * The licence file a VERSION record names: a relative path inside its own component, in which every folder
 * and file name starts with a letter, a digit, `_` or `-`. So no `..` segment, no leading slash, no drive
 * letter and no backslash can point the check at another component's text, or at a file outside vendor/.
 */
const LICENSE_PATH = /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/**
 * Reads the vendored components: one folder under `<root>/vendor/` each, with
 * its VERSION record (M4.1, D100). Everything vendored is emitted into
 * published pieces, so its scope is published-piece. A folder without a
 * readable record, or a stray file beside the folders, is an unrecorded
 * component and fails; an absent vendor/ means there is none.
 */
export function readVendored(root) {
  const base = join(root, 'vendor');
  if (!existsSync(base)) {
    return {components: [], failures: []};
  }
  const components = [];
  const failures = [];
  for (const name of readdirSync(base).sort()) {
    const path = `vendor/${name}`;
    const item = {path, packageName: path, version: null, scope: 'published-piece', declared: null, source: `${path}/VERSION`};
    if (!lstatSync(join(base, name)).isDirectory()) {
      failures.push({item, reason: 'is a file directly under vendor/; a vendored component is a folder with a VERSION record'});
      continue;
    }
    const recordPath = join(base, name, 'VERSION');
    if (!existsSync(recordPath)) {
      failures.push({item, reason: 'has no VERSION record naming its licence'});
      continue;
    }
    let record;
    try {
      record = parseVersion(readFileSync(recordPath, 'utf8'));
    } catch (error) {
      failures.push({item, reason: `has an unreadable VERSION record: ${error.message}`});
      continue;
    }
    const missing = VENDORED_KEYS.filter((key) => typeof record[key] !== 'string');
    if (missing.length > 0) {
      failures.push({item, reason: `has a VERSION record without ${missing.join(', ')}`});
      continue;
    }
    if (!LICENSE_PATH.test(record.license)) {
      failures.push({
        item,
        reason: `names its licence ${JSON.stringify(record.license)}; it must be a file inside ${path}/, named by a relative path with no .. segment, leading slash or backslash`,
      });
      continue;
    }
    components.push({
      ...item,
      packageName: record.npm_package,
      version: record.npm_version,
      declared: record.license_spdx,
      licenseFile: `${path}/${record.license}`,
      licenseSha256: record.license_sha256,
    });
  }
  return {components, failures};
}

/**
 * Reads the fonts a published piece carries (M5.3, D125): every font file
 * directly under `<root>/theme/fonts/`, matched to its family in FONT_FAMILIES
 * by file name. A family's licence text must be a regular file that is the SIL
 * Open Font License 1.1 and names that family's authors, because the text is
 * what `build` copies into every dist/ beside the fonts (D62). A font file no
 * family claims fails; an absent theme/fonts/ means there are none.
 */
export function readFonts(root) {
  const base = join(root, 'theme', 'fonts');
  if (!existsSync(base)) {
    return {families: [], failures: []};
  }
  const failures = [];
  const byFamily = new Map(FONT_FAMILIES.map((family) => [family.family, []]));
  for (const name of readdirSync(base).sort()) {
    if (!FONT_FILE.test(name)) {
      continue;
    }
    const path = `theme/fonts/${name}`;
    const family = FONT_FAMILIES.find((candidate) => name.startsWith(candidate.prefix));
    if (family === undefined) {
      failures.push({
        item: {path, packageName: path, version: null, scope: 'published-piece', source: path},
        reason: 'is a font file that no family in FONT_FAMILIES claims, so no licence text is known to travel with it',
      });
      continue;
    }
    byFamily.get(family.family).push(path);
  }
  const families = [];
  for (const family of FONT_FAMILIES) {
    const files = byFamily.get(family.family);
    if (files.length === 0) {
      continue;
    }
    const item = {path: family.text, packageName: family.family, version: null, scope: 'published-piece', declared: family.spdx, source: family.text};
    const textPath = join(root, ...family.text.split('/'));
    let stat;
    try {
      stat = lstatSync(textPath);
    } catch {
      failures.push({item, reason: `has ${files.length} font file(s) but no licence text at ${family.text}`});
      continue;
    }
    if (!stat.isFile()) {
      failures.push({item, reason: `names ${family.text}, which is not a regular file`});
      continue;
    }
    const text = readFileSync(textPath, 'utf8').replace(/\s+/g, ' ');
    if (!/SIL OPEN FONT LICENSE Version 1\.1/i.test(text)) {
      failures.push({item, reason: `${family.text} is not the SIL Open Font License 1.1 text`});
      continue;
    }
    if (!new RegExp(`Copyright \\d{4}(?:-\\d{4})? The ${family.family} Project Authors`).test(text)) {
      failures.push({item, reason: `${family.text} does not name the ${family.family} Project Authors in its copyright line`});
      continue;
    }
    families.push({...item, files, licenseFile: family.text, licenseSha256: sha256OfFile(textPath)});
  }
  return {families, failures};
}

const EXCEPTION_STATUSES = new Set(['provisional', 'approved']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * Reads and validates scripts/license-exceptions.json.
 *
 * Every entry names one package at one exact version in one scope, and that
 * scope is never published-piece (D21). A range, a wildcard or a missing
 * version is refused: an exception is a reviewer's reading of a specific
 * published artefact, and it cannot travel to a version nobody looked at.
 * `status` is required, so a malformed entry can never be mistaken
 * for an approved one, and an approved entry must additionally say who approved
 * it, when, and under what reference.
 *
 * A malformed file is a usage failure in every mode, not a release-only one:
 * there is no safe way to run against a policy file that does not parse.
 */
export function readExceptions(file) {
  if (!existsSync(file)) {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (cause) {
    throw new UsageError(`cannot parse ${file}: ${cause.message}`);
  }
  const entries = Array.isArray(parsed.exceptions) ? parsed.exceptions : [];
  const seen = new Set();

  for (const entry of entries) {
    const label = `${entry?.package ?? '(unnamed)'}@${entry?.version ?? '(no version)'}`;

    for (const field of ['package', 'version', 'scope', 'license', 'rationale', 'reviewOwner', 'status']) {
      if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
        throw new UsageError(`${file}: ${label} needs a non-empty ${field}`);
      }
    }
    if (!EXACT_VERSION.test(entry.version)) {
      throw new UsageError(
        `${file}: ${label} must name one exact version, not ${JSON.stringify(entry.version)}; ` +
          'a range or wildcard would carry a reviewer\'s reading to a version nobody read',
      );
    }
    if (!Object.hasOwn(ALLOWLISTS, entry.scope)) {
      throw new UsageError(`${file}: ${label} uses unknown scope ${JSON.stringify(entry.scope)}`);
    }
    // D21: what a reader's dist/ carries is held to its allowlist alone; D27
    // admitted author-runtime entries, never this scope. Refused rather than
    // left unused, so no entry can wait here for a component to need it (W5R-06).
    if (entry.scope === 'published-piece') {
      throw new UsageError(
        `${file}: ${label} is listed for published-piece scope; no exception applies in published-piece ` +
          'scope (D21), so what a published piece carries passes its allowlist or fails',
      );
    }
    if (!EXCEPTION_STATUSES.has(entry.status)) {
      throw new UsageError(
        `${file}: ${label} has status ${JSON.stringify(entry.status)}; ` +
          `it must be one of ${[...EXCEPTION_STATUSES].join(', ')}`,
      );
    }
    if (isCopyleft(entry.license)) {
      throw new UsageError(
        `${file}: ${label} tries to except the copyleft licence ${entry.license}; ` +
          'copyleft is refused in every scope (D18)',
      );
    }
    if (entry.status === 'approved') {
      for (const field of ['approvalReference', 'approver', 'approvalDate']) {
        if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
          throw new UsageError(
            `${file}: ${label} is approved but has no ${field}; an approval names its ` +
              'reference, its approver and its date, or it is not an approval',
          );
        }
      }
      if (!ISO_DATE.test(entry.approvalDate)) {
        throw new UsageError(
          `${file}: ${label} has approvalDate ${JSON.stringify(entry.approvalDate)}; use YYYY-MM-DD`,
        );
      }
    }

    const key = `${entry.package}@${entry.version}|${entry.scope}|${entry.license}`;
    if (seen.has(key)) {
      throw new UsageError(`${file}: ${label} is listed twice for ${entry.scope}/${entry.license}`);
    }
    seen.add(key);
  }
  return entries;
}

// -------------------------------------------------------------- evidence ----

/**
 * Reads and validates scripts/license-evidence.json.
 *
 * Evidence answers a different question from an exception. An exception says
 * "this licence is acceptable here"; evidence says "this is the licence, and
 * here is what establishes it". They are separate files because they are
 * separate decisions with separate owners: policy is the release owner's,
 * verification is the implementing session's.
 *
 * Keeping them apart is also what stops a policy change from quietly disabling
 * a check. When PSF-2.0 moved into the author-runtime allowlist, argparse no
 * longer matched an exception — and its licence-file hash is still verified,
 * because the evidence record never depended on the exception existing.
 *
 * `file` is relative to the package's own directory, so a package installed at
 * a nested path is resolved where it actually sits.
 */
export function readEvidence(file) {
  if (!existsSync(file)) {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (cause) {
    throw new UsageError(`cannot parse ${file}: ${cause.message}`);
  }
  const records = Array.isArray(parsed.evidence) ? parsed.evidence : [];
  for (const record of records) {
    const label = `${record?.package ?? '(unnamed)'}@${record?.version ?? '(no version)'}`;
    for (const field of ['package', 'version', 'file', 'sha256', 'verifiedBy', 'verifiedOn']) {
      if (typeof record[field] !== 'string' || record[field].trim() === '') {
        throw new UsageError(`${file}: evidence for ${label} needs a non-empty ${field}`);
      }
    }
    if (!EXACT_VERSION.test(record.version)) {
      throw new UsageError(`${file}: evidence for ${label} must name one exact version`);
    }
    if (!/^[0-9a-f]{64}$/.test(record.sha256)) {
      throw new UsageError(`${file}: evidence for ${label} has a malformed SHA-256`);
    }
    if (!ISO_DATE.test(record.verifiedOn)) {
      throw new UsageError(`${file}: evidence for ${label} has verifiedOn ${JSON.stringify(record.verifiedOn)}; use YYYY-MM-DD`);
    }
    if (record.file.startsWith('/') || record.file.includes('..')) {
      throw new UsageError(`${file}: evidence for ${label} must cite a path inside the package directory`);
    }
    if (record.identifies !== undefined && (typeof record.identifies !== 'string' || record.identifies.trim() === '')) {
      throw new UsageError(`${file}: evidence for ${label} has an empty identifies`);
    }
    if (record.required !== undefined && typeof record.required !== 'boolean') {
      throw new UsageError(`${file}: evidence for ${label} has a non-boolean required`);
    }
  }
  return records;
}

/** Evidence records for one installed tree entry, matched on exact version. */
export function evidenceFor(records, item) {
  return records.filter(
    (record) => record.package === item.packageName && record.version === item.version,
  );
}

/**
 * Checks one evidence record against the package where it actually sits.
 * Returns {status, message}: `verified`, `failed`, or `unresolved` when the
 * package is not installed on this platform and there is nothing to read.
 */
export function checkEvidenceRecord(root, item, record) {
  const where = join(item.path, record.file);
  if (!item.installed) {
    return {
      status: 'unresolved',
      message: `${item.packageName}@${item.version} is not installed on this platform, so ${where} could not be read`,
    };
  }
  const evidencePath = join(root, where);
  if (!existsSync(evidencePath)) {
    return {
      status: 'failed',
      message: `${item.packageName}@${item.version} no longer carries ${where}; the identification rested on it`,
    };
  }
  const actual = sha256OfFile(evidencePath);
  if (actual !== record.sha256) {
    return {
      status: 'failed',
      message:
        `${where} hashes to ${actual}, but the evidence record cites ${record.sha256}; ` +
        'the file changed since it was read and must be reviewed again',
    };
  }
  return {status: 'verified', message: `${where} matches the recorded SHA-256`};
}

// -------------------------------------------------------- retained texts ----

/** A file licenses/index.json names: relative, inside licenses/, no `.` or `..` segment, no backslash. */
const RETAINED_PATH = /^(?:[A-Za-z0-9@_+-][A-Za-z0-9@._+-]*\/)*[A-Za-z0-9@_+-][A-Za-z0-9@._+-]*$/;

/**
 * Holds every licence text `licenses/index.json` names, in both its sections
 * (the SPDX texts and the packages' own files), to the size and SHA-256 the
 * index records, offline (D36, D126). The native reviews cite those hashes and
 * the package ships the files, so a text edited, truncated, removed or linked
 * elsewhere fails here rather than travelling as the text that was read; so
 * does a `licenses/*.txt` the index does not name (W5R-05). No licenses/ folder
 * means nothing is retained.
 *
 * Kept out of checkLicenses, which the inventory and the notice generator
 * share, so that gen-notice can still rewrite a stale text it owns (D126).
 */
/** The files licenses/ holds beside its texts: the index, and the rule that keeps the texts' line endings as written. */
const BESIDE_THE_TEXTS = new Set(['index.json', '.gitattributes']);

export function checkRetainedTexts(root) {
  const base = join(root, 'licenses');
  if (!existsSync(base)) {
    return {present: false, texts: [], failures: []};
  }
  const indexPath = join(base, 'index.json');
  let index = {};
  if (existsSync(indexPath)) {
    try {
      index = JSON.parse(readFileSync(indexPath, 'utf8'));
    } catch (cause) {
      throw new UsageError(`cannot parse ${indexPath}: ${cause.message}`);
    }
  }
  const inside = `${realpathSync(base)}${sep}`;
  const texts = [];
  const failures = [];
  const named = new Set();
  const item = (path) => ({path, packageName: path, version: null, scope: 'licence text', source: 'licenses/index.json'});
  for (const section of ['licenses', 'packages']) {
    for (const entry of Array.isArray(index[section]) ? index[section] : []) {
      if (typeof entry?.file !== 'string' || !RETAINED_PATH.test(entry.file)) {
        failures.push({
          item: item('licenses/index.json'),
          reason: `names ${JSON.stringify(entry?.file)} in its ${section} section; a retained text is a relative path inside licenses/, with no . or .. segment and no backslash`,
        });
        continue;
      }
      named.add(entry.file);
      const label = item(`licenses/${entry.file}`);
      if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256) || !Number.isInteger(entry.bytes)) {
        failures.push({item: label, reason: 'has no SHA-256 and byte count in licenses/index.json to be held to'});
        continue;
      }
      const path = join(base, ...entry.file.split('/'));
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        failures.push({item: label, reason: 'is missing, though licenses/index.json records it as retained'});
        continue;
      }
      if (!stat.isFile() || !realpathSync(path).startsWith(inside)) {
        failures.push({item: label, reason: 'is not a regular file inside licenses/'});
        continue;
      }
      const bytes = readFileSync(path);
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (bytes.length !== entry.bytes || actual !== entry.sha256) {
        failures.push({
          item: label,
          reason:
            `is ${bytes.length} bytes with SHA-256 ${actual}, but licenses/index.json records ${entry.bytes} bytes with SHA-256 ` +
            `${entry.sha256}; a retained text changes only with its entry, through the script that owns it`,
        });
        continue;
      }
      texts.push({file: `licenses/${entry.file}`, section});
    }
  }
  // The package ships licenses/ whole, so every file in it, however deep, is a retained text the index must name, but
  // the index itself and the .gitattributes that keeps the texts' bytes as written.
  const unnamed = (directory, prefix) => {
    for (const name of readdirSync(directory).sort()) {
      const path = prefix === '' ? name : `${prefix}/${name}`;
      if (lstatSync(join(directory, name)).isDirectory()) {
        unnamed(join(directory, name), path);
      } else if (!(prefix === '' && BESIDE_THE_TEXTS.has(name)) && !named.has(path)) {
        failures.push({item: item(`licenses/${path}`), reason: 'is not named by licenses/index.json, so it would travel with no recorded hash'});
      }
    }
  };
  unnamed(base, '');
  return {present: true, texts, failures};
}

// ----------------------------------------------------------------- check ----

export function checkLicenses({
  root,
  exceptionsFile,
  evidenceFile,
  scopeFile,
  observationsFile,
  reviewsFile,
  release = false,
}) {
  const inventory = readInventory(root);
  const exceptions = readExceptions(exceptionsFile);
  const evidenceRecords = readEvidence(evidenceFile);
  const native = reconcileNative({root, scopeFile, observationsFile, reviewsFile});

  const failures = [];
  const releaseBlockers = [];
  const appliedExceptions = [];
  const libvipsApplied = [];
  const uninstalled = [];
  const evidenceResults = [];

  // --- evidence first: what each package's licence actually is, and what
  // establishes it. This runs whether or not any exception applies, so moving a
  // licence into an allowlist cannot silently retire its verification.
  const identified = new Map();
  for (const item of inventory) {
    for (const record of evidenceFor(evidenceRecords, item)) {
      const outcome = checkEvidenceRecord(root, item, record);
      const required = record.required !== false;
      evidenceResults.push({item, record, ...outcome, required});

      if (outcome.status === 'failed') {
        failures.push({item, reason: outcome.message});
      } else if (outcome.status === 'unresolved' && required) {
        releaseBlockers.push({
          kind: 'evidence-unresolved',
          item,
          message: `${outcome.message} (required evidence)`,
        });
      }
      if (outcome.status === 'verified' && typeof record.identifies === 'string') {
        identified.set(`${item.path}`, record);
      }
    }
  }

  // What each lockfile entry evaluated to, by installation path, so the
  // inventory (scripts/license-inventory.mjs, D125) reports the same reading
  // this check acts on rather than computing a second one.
  const evaluations = new Map();
  for (const item of inventory) {
    if (!item.installed) {
      uninstalled.push(item);
    }

    let expression = item.declared;
    let identifiedBy = null;
    if (expression === null) {
      const record = identified.get(item.path);
      if (record === undefined) {
        const reason =
          'declares no licence, and no verified evidence record identifies one. Add an ' +
          'evidence record citing the licence file that establishes it.';
        failures.push({item, reason});
        evaluations.set(item.path, {expression: null, identifiedBy: null, outcome: null, failure: reason});
        continue;
      }
      expression = record.identifies;
      identifiedBy = record;
    }

    let outcome;
    try {
      outcome = evaluateForPackage({
        expression,
        packageName: item.packageName,
        version: item.version,
        scope: item.scope,
        exceptions,
      });
    } catch (error) {
      const reason = `unreadable SPDX expression: ${error.message}`;
      failures.push({item, reason});
      evaluations.set(item.path, {expression, identifiedBy, outcome: null, failure: reason});
      continue;
    }
    evaluations.set(item.path, {
      expression,
      identifiedBy,
      outcome,
      failure: outcome.allowed ? null : `${expression} is not allowed in ${item.scope} scope`,
    });

    for (const used of outcome.usedExceptions) {
      if (used.kind === 'libvips') {
        libvipsApplied.push({item, used});
        continue;
      }
      appliedExceptions.push({item, used, identifiedBy});
      if (used.exception.status !== 'approved') {
        releaseBlockers.push({
          kind: 'provisional-exception',
          item,
          message:
            `${item.packageName}@${item.version} (${item.scope}) relies on a ${used.exception.status} ` +
            `exception for ${used.identifier}; a release needs an approved one`,
        });
      }
    }

    if (!outcome.allowed) {
      const unknownWith =
        outcome.unrecognizedExceptions.length === 0
          ? ''
          : ` — the licence exception${outcome.unrecognizedExceptions.length === 1 ? '' : 's'} ` +
            `${outcome.unrecognizedExceptions.join(', ')} ${outcome.unrecognizedExceptions.length === 1 ? 'is' : 'are'} ` +
            'not recognised, so the expression is unknown';
      failures.push({
        item,
        reason: `${expression} is not allowed in ${item.scope} scope${unknownWith}`,
      });
    }
  }

  // --- vendored components, emitted into published pieces (M4.1, D100). The
  // licence file is checked against the hash its record gives, so the text a
  // comic's dist/ carries is the text that was reviewed.
  const vendored = readVendored(root);
  failures.push(...vendored.failures);
  const vendoredResults = [];
  for (const item of vendored.components) {
    const licensePath = join(root, item.licenseFile);
    let stat;
    try {
      stat = lstatSync(licensePath);
    } catch {
      failures.push({item, reason: `names ${item.licenseFile}, which is missing`});
      continue;
    }
    // A link, or a folder inside the component that links elsewhere, could still lead out of it.
    const inside = stat.isFile() && realpathSync(licensePath).startsWith(`${realpathSync(join(root, item.path))}${sep}`);
    if (!inside) {
      failures.push({item, reason: `names ${item.licenseFile}, which is not a regular file inside ${item.path}/`});
      continue;
    }
    const actual = sha256OfFile(licensePath);
    if (actual !== item.licenseSha256) {
      failures.push({item, reason: `${item.licenseFile} hashes to ${actual}, but its record gives ${item.licenseSha256}`});
      continue;
    }
    let outcome;
    try {
      // Published-piece scope takes no exception (D21): the allowlist alone decides.
      outcome = evaluateForPackage({expression: item.declared, packageName: item.packageName, version: item.version, scope: item.scope, exceptions: []});
    } catch (error) {
      failures.push({item, reason: `unreadable SPDX expression: ${error.message}`});
      continue;
    }
    if (!outcome.allowed) {
      failures.push({item, reason: `${item.declared} is not allowed in ${item.scope} scope`});
      continue;
    }
    vendoredResults.push(item);
  }

  // --- fonts, emitted into every published piece (M5.3, D125). The family's
  // OFL text is what build copies beside them, so it is held to be one; like
  // the engine, they take no exception (D21).
  const fonts = readFonts(root);
  failures.push(...fonts.failures);
  const fontResults = [];
  for (const family of fonts.families) {
    const outcome = evaluateForPackage({expression: family.declared, packageName: family.packageName, version: null, scope: family.scope, exceptions: []});
    if (!outcome.allowed) {
      failures.push({item: family, reason: `${family.declared} is not allowed in ${family.scope} scope`});
      continue;
    }
    fontResults.push(family);
  }

  // --- native and platform distribution review (D24, D34, DEP06)
  //
  // The requirements come from the lockfile intersected with the documented
  // distribution scope, so an empty or partial review file is a failure rather
  // than an absence of findings: nothing can be cleared by deleting it.
  for (const problem of native.problems) {
    releaseBlockers.push({kind: 'native', message: problem});
  }

  return {
    root,
    release,
    inventory,
    exceptions,
    evidenceRecords,
    evidenceResults,
    evaluations,
    vendored: vendoredResults,
    fonts: fontResults,
    native,
    failures,
    releaseBlockers,
    appliedExceptions,
    libvipsApplied,
    uninstalled,
  };
}

function report(result) {
  const lines = [];
  const byScope = {};
  for (const item of result.inventory) {
    byScope[item.scope] = (byScope[item.scope] ?? 0) + 1;
  }

  lines.push(`licence check: root ${result.root}${result.release ? ' [release mode]' : ''}`);
  lines.push(
    `scanned: ${result.inventory.length} package(s) — ` +
      Object.entries(byScope)
        .sort()
        .map(([scope, count]) => `${scope} ${count}`)
        .join(', '),
  );
  const vendoredList = result.vendored.map((item) => `${item.packageName}@${item.version} (${item.declared}; ${item.licenseFile} matches its recorded SHA-256)`);
  const fontFiles = result.fonts.reduce((count, family) => count + family.files.length, 0);
  const fontList = result.fonts.map((family) => `${family.packageName} (${family.declared}; ${family.licenseFile})`);
  lines.push(
    `published-piece scope: 0 npm packages; ${vendoredList.length === 0 ? 'no vendored component' : `${vendoredList.length} vendored component(s): ${vendoredList.join(', ')}`}; ` +
      `${fontList.length === 0 ? 'no font' : `${fontFiles} font file(s) in ${fontList.length} famil${fontList.length === 1 ? 'y' : 'ies'}: ${fontList.join(', ')}`}.`,
  );

  const approvedIdentifiers = OWNER_APPROVED_IDENTIFIERS['author-runtime'] ?? [];
  if (approvedIdentifiers.length > 0) {
    lines.push(
      `author-runtime allowlist includes ${approvedIdentifiers.join(', ')} by owner approval (D29); ` +
        'published-piece and dev scope are unchanged.',
    );
  }

  const verified = result.evidenceResults.filter((entry) => entry.status === 'verified');
  const unresolved = result.evidenceResults.filter((entry) => entry.status === 'unresolved');
  if (result.evidenceResults.length > 0) {
    lines.push(
      `licence evidence: ${verified.length} verified, ${unresolved.length} unresolved, ` +
        `${result.evidenceResults.length} record(s) total`,
    );
    for (const entry of verified) {
      const identifies = entry.record.identifies === undefined ? '' : ` identifies ${entry.record.identifies};`;
      lines.push(`  ok        ${entry.item.packageName}@${entry.item.version} —${identifies} ${entry.message}`);
    }
    for (const entry of unresolved) {
      lines.push(`  unresolved ${entry.message}`);
    }
  }

  if (result.retained !== undefined) {
    const {present, texts, failures} = result.retained;
    lines.push(
      present
        ? `retained licence texts: ${texts.length} named by licenses/index.json match their recorded size and SHA-256 (D36, D126)` +
            (failures.length === 0 ? '' : `; ${failures.length} failure(s), listed below`)
        : 'retained licence texts: none, no licenses/ folder',
    );
  }

  if (result.libvipsApplied.length > 0) {
    lines.push(`libvips exception applied to ${result.libvipsApplied.length} package(s) (D24):`);
    for (const {item} of result.libvipsApplied) {
      lines.push(`  ${item.packageName}@${item.version} — ${item.declared}`);
    }
  }

  if (result.appliedExceptions.length > 0) {
    lines.push(`listed exceptions applied to ${result.appliedExceptions.length} package(s) (D21, D27, D29):`);
    for (const {item, used} of result.appliedExceptions) {
      const exception = used.exception;
      const badge =
        exception.status === 'approved'
          ? ` [approved ${exception.approvalDate} · ${exception.approvalReference}]`
          : ` [${exception.status.toUpperCase()}, release blocked until approved]`;
      lines.push(`  ${item.packageName}@${item.version} (${item.scope}) — ${used.identifier}${badge}`);
      lines.push(`    ${exception.rationale}`);
    }
  }

  const counts = result.native.counts;
  lines.push(
    `native distribution review: ${counts.verified} verified of ${counts.required} required ` +
      `package(s); ${counts.observed} observation(s); ${counts.outOfScope} out of documented scope`,
  );
  const byState = {};
  for (const row of result.native.rows) {
    if (!row.required) continue;
    byState[row.state] = (byState[row.state] ?? 0) + 1;
  }
  const states = Object.entries(byState).filter(([state]) => state !== 'ok');
  if (states.length > 0) {
    lines.push(`  outstanding: ${states.map(([state, n]) => `${n} ${state}`).join(', ')}`);
  }
  // Say how many outstanding reviews already have the facts assembled, so the
  // reviewer can see what is waiting on a signature rather than on more work.
  // It is a count of proposals, never of findings, and it never lowers a count
  // above it.
  if ((counts.awaitingSignature ?? 0) > 0) {
    lines.push(
      `  ${counts.awaitingSignature} of those carry assembled facts awaiting a reviewer's signature ` +
        '(D36); assembled facts do not clear a release',
    );
  }

  if (result.uninstalled.length > 0) {
    lines.push(
      `${result.uninstalled.length} package(s) are not installed on this platform; their licence ` +
        'came from package-lock.json. What each platform package holds is in scripts/native-observations.json, ' +
        'and the inventory of every scope is docs/evidence/license-inventory.json (D125).',
    );
  }

  if (result.failures.length > 0) {
    lines.push(`policy failures: ${result.failures.length} package(s) (R11)`);
    for (const failure of result.failures) {
      const version = failure.item.version === null ? '' : `@${failure.item.version}`;
      lines.push(
        `  ${failure.item.packageName}${version} (${failure.item.scope}) ` +
          `${failure.reason} — declared in ${failure.item.source}`,
      );
    }
    lines.push(
      'fix: remove the dependency, replace it, or add a reviewed entry to ' +
        'scripts/license-exceptions.json. Copyleft is never exceptable.',
    );
  }

  if (result.releaseBlockers.length > 0) {
    const heading = result.release
      ? `release blockers: ${result.releaseBlockers.length}`
      : `release blockers (warning only outside --release): ${result.releaseBlockers.length}`;
    lines.push(heading);
    for (const blocker of result.releaseBlockers) {
      lines.push(`  ${blocker.message}`);
    }
    if (!result.release) {
      lines.push('  these do not fail an ordinary development check; npm run check:licenses:release fails on them.');
    }
  }

  const releaseFailed = result.release && result.releaseBlockers.length > 0;
  if (result.failures.length === 0 && !releaseFailed) {
    lines.push(
      result.release
        ? 'result: pass — every licence is allowed, every required evidence record is verified, and no review is outstanding'
        : 'result: pass — every declared licence is allowed in its scope',
    );
  } else {
    lines.push(
      `result: FAIL — ${result.failures.length} policy failure(s)` +
        (result.release ? `, ${result.releaseBlockers.length} release blocker(s)` : ''),
    );
  }
  return lines.join('\n');
}

// ------------------------------------------------------------ SPDX cases ----

function runSpdxCases(file, exceptions) {
  let cases;
  try {
    cases = JSON.parse(readFileSync(file, 'utf8')).cases;
  } catch (cause) {
    throw new UsageError(`cannot read SPDX cases from ${file}: ${cause.message}`);
  }
  const lines = [`SPDX cases: ${file}`];
  let failed = 0;
  for (const testCase of cases) {
    let actual;
    let note = '';
    try {
      actual = evaluateForPackage({
        expression: testCase.expression,
        packageName: testCase.package ?? 'fixture-package',
        version: testCase.version ?? null,
        scope: testCase.scope,
        exceptions,
      }).allowed;
    } catch (error) {
      actual = 'error';
      note = ` (${error.message})`;
    }
    const expected = testCase.expected;
    const ok = actual === expected;
    if (!ok) {
      failed += 1;
    }
    lines.push(
      `  ${ok ? 'ok  ' : 'FAIL'} ${testCase.scope.padEnd(16)} ${JSON.stringify(testCase.expression)} ` +
        `→ ${String(actual)}, expected ${String(expected)}${note}`,
    );
  }
  lines.push(failed === 0 ? `result: pass — ${cases.length} case(s)` : `result: FAIL — ${failed} case(s)`);
  return {text: lines.join('\n'), failed};
}

// ------------------------------------------------------------------ main ----

const PATH_FLAGS = {
  '--root': 'root',
  '--exceptions': 'exceptionsFile',
  '--evidence': 'evidenceFile',
  '--scope': 'scopeFile',
  '--observations': 'observationsFile',
  '--reviews': 'reviewsFile',
  '--spdx-cases': 'spdxCases',
};

function parseArguments(argv) {
  const options = {
    root: process.cwd(),
    exceptionsFile: null,
    evidenceFile: null,
    scopeFile: null,
    observationsFile: null,
    reviewsFile: null,
    spdxCases: null,
    release: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--release') {
      options.release = true;
      continue;
    }
    const key = PATH_FLAGS[flag];
    if (key === undefined) {
      throw new UsageError(`unknown argument ${JSON.stringify(flag)}`);
    }
    const value = argv[index + 1];
    if (value === undefined) {
      throw new UsageError(`${flag} needs a path`);
    }
    options[key] = value;
    index += 1;
  }
  options.root = resolve(options.root);
  options.exceptionsFile = resolve(
    options.exceptionsFile ?? join(import.meta.dirname, 'license-exceptions.json'),
  );
  options.evidenceFile = resolve(
    options.evidenceFile ?? join(import.meta.dirname, 'license-evidence.json'),
  );
  options.scopeFile = resolve(options.scopeFile ?? join(import.meta.dirname, 'native-scope.json'));
  options.observationsFile = resolve(
    options.observationsFile ?? join(import.meta.dirname, 'native-observations.json'),
  );
  options.reviewsFile = resolve(options.reviewsFile ?? join(import.meta.dirname, 'native-reviews.json'));
  if (options.spdxCases !== null) {
    options.spdxCases = resolve(options.spdxCases);
  }
  return options;
}

function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`license-check: ${error.message}\n`);
    process.stderr.write(
      'usage: node scripts/license-check.mjs [--release] [--root <dir>] [--exceptions <file>]\n' +
        '                                      [--evidence <file>] [--scope <file>]\n' +
        '                                      [--observations <file>] [--reviews <file>]\n' +
        '                                      [--spdx-cases <file>]\n',
    );
    return 2;
  }

  try {
    const exceptions = readExceptions(options.exceptionsFile);
    if (options.spdxCases !== null) {
      const cases = runSpdxCases(options.spdxCases, exceptions);
      process.stdout.write(`${cases.text}\n`);
      return cases.failed === 0 ? 0 : 1;
    }
    const checked = checkLicenses(options);
    // In both modes, so CI's development check holds the texts too (W5R-05).
    const retained = checkRetainedTexts(options.root);
    const result = {...checked, retained, failures: [...checked.failures, ...retained.failures]};
    process.stdout.write(`${report(result)}\n`);
    if (result.failures.length > 0) {
      return 1;
    }
    return options.release && result.releaseBlockers.length > 0 ? 1 : 0;
  } catch (error) {
    if (error instanceof NativeConfigError) {
      process.stderr.write(`license-check: native review configuration: ${error.message}\n`);
      return 2;
    }
    process.stderr.write(`license-check: ${error.message}\n`);
    return 2;
  }
}

/** Exported so the inventory and the notice generator hash files the same way (D125, D126). */
export function sha256OfFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  process.exitCode = main(process.argv.slice(2));
}
