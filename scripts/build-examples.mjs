#!/usr/bin/env node
/**
 * `npm run examples` (M1 CI activation, D72): checks, then builds, every
 * example whose template this build of Papeleria renders, with the compiled
 * CLI, in place.
 *
 * The CLI writes each piece's `dist/` and `.papeleria/`, which git ignores and
 * the example checks leave out. Each build's report is passed through exactly
 * as the CLI prints it, so every warning is listed and none is summarised
 * away (A7). An example whose template does not render yet is listed with the
 * milestone that brings it and is not built: building it would only report
 * the missing renderer. A folder under `examples/` that is neither built nor
 * listed stops the run, so a new example cannot be skipped silently.
 *
 * From M5.5 (W5D, D139) each example is first checked with `check --json`,
 * and every warning is printed with its rule and place, and with the reason
 * it is accepted when ACCEPTED_WARNINGS lists it. A warning not on that list
 * fails the run once every example has built, so a new warning is read and
 * its reason written down before it is accepted; nothing is suppressed.
 * `--cli` runs the same examples with another build of the CLI, such as the
 * one installed from the release tarball (`test/package/tarball.ts`).
 *
 * Later sessions move their example from PENDING to BUILT when its template
 * renders: the report moved at M3 (W3B) and the comic at M4 (W4).
 *
 * Usage: node scripts/build-examples.mjs [--examples <dir>] [--cli <file>]
 * Exit:  0 every implemented example checked and built, with only accepted
 *        warnings · 1 an example has errors (or failed for another reason the
 *        CLI gave exit 1), or a warning nobody has accepted · 2 usage, IO or
 *        tool failure, a missing lib/, a missing implemented example or an
 *        unknown example folder
 */
import {spawnSync} from 'node:child_process';
import {existsSync, readdirSync, statSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const APPLICATION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The examples this build renders, in the order they are built. The report
 * joined at M3 (W3B, D99) and the comic at M4 (W4, D119), so every example is
 * built.
 */
export const BUILT = [
  {name: 'starter-deck', template: 'deck'},
  {name: 'brand-overview', template: 'deck'},
  {name: 'hours-report', template: 'document'},
  {name: 'sample-comic', template: 'comic'},
];

/** The examples whose template does not render yet, and what brings it: none since M4. */
export const PENDING = [];

/**
 * The warnings a reader has looked at and accepted, per example, each with
 * why it is acceptable, such as a known placeholder or a rights note (A7).
 * An entry matches a warning by its rule, file and message exactly. At 0.1.0
 * no example has a warning, so every list is empty (D139).
 */
export const ACCEPTED_WARNINGS = {
  'starter-deck': [],
  'brand-overview': [],
  'hours-report': [],
  'sample-comic': [],
};

class UsageError extends Error {}

function parseArguments(argv) {
  const options = {
    examples: join(APPLICATION_ROOT, 'examples'),
    cli: join(APPLICATION_ROOT, 'lib', 'src', 'cli', 'index.js'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--examples' || flag === '--cli') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`${flag} needs a path`);
      }
      options[flag.slice(2)] = resolve(value);
      index += 1;
    } else {
      throw new UsageError(`unknown argument ${JSON.stringify(flag)}`);
    }
  }
  return options;
}

/** Every folder under `examples/`, by name. Files such as README.md are not pieces. */
function exampleFolders(directory) {
  return readdirSync(directory, {withFileTypes: true})
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function shown(path) {
  const inside = relative(APPLICATION_ROOT, path);
  return inside.startsWith('..') ? path : inside;
}

/** The place a finding names, as the CLI prints it: file, then line and column when it has them. */
function place(finding) {
  return finding.line === null ? finding.file : `${finding.file}:${finding.line}${finding.column === null ? '' : `:${finding.column}`}`;
}

/**
 * Checks one example with `check --json`: its exit code, its error count and
 * its warnings, each with the entry of ACCEPTED_WARNINGS that accepts it, or
 * null. A tool failure (exit 2) prints the CLI's own message.
 */
function checkExample(cli, example, piece) {
  const result = spawnSync(process.execPath, [cli, 'check', piece, '--json'], {encoding: 'utf8'});
  const code = result.error === undefined && result.status !== null ? result.status : 2;
  if (result.error !== undefined) {
    process.stderr.write(`build-examples: the CLI could not run: ${result.error.message}\n`);
  }
  let report = null;
  try {
    report = JSON.parse(result.stdout ?? '');
  } catch {
    report = null;
  }
  if (report === null || !Array.isArray(report.findings)) {
    process.stderr.write(result.stderr ?? '');
    return {code: Math.max(code, 2), errors: null, warnings: []};
  }
  const accepted = ACCEPTED_WARNINGS[example.name] ?? [];
  const warnings = report.findings
    .filter((finding) => finding.severity === 'warning')
    .map((finding) => ({
      finding,
      accepted: accepted.find((entry) => entry.rule === finding.rule && entry.file === finding.file && entry.message === finding.message) ?? null,
    }));
  return {code, errors: report.errors, warnings};
}

function main(argv) {
  const usage = 'usage: node scripts/build-examples.mjs [--examples <dir>] [--cli <file>]';
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`build-examples: ${error.message}\n${usage}\n`);
    return 2;
  }
  if (!existsSync(options.cli)) {
    process.stderr.write(`build-examples: ${shown(options.cli)} is missing. Run npm run build first; npm run examples does.\n`);
    return 2;
  }
  let folders;
  try {
    if (!statSync(options.examples).isDirectory()) {
      throw new Error('it is not a folder');
    }
    folders = exampleFolders(options.examples);
  } catch (error) {
    process.stderr.write(`build-examples: cannot read the examples folder ${shown(options.examples)}: ${error.message}\n`);
    return 2;
  }

  const known = new Set([...BUILT, ...PENDING].map((example) => example.name));
  const unknown = folders.filter((name) => !known.has(name));
  const missing = BUILT.filter((example) => !folders.includes(example.name)).map((example) => example.name);
  if (unknown.length > 0 || missing.length > 0) {
    for (const name of unknown) {
      process.stderr.write(
        `build-examples: examples/${name} is neither built nor listed as pending; add it to BUILT or PENDING in scripts/build-examples.mjs.\n`,
      );
    }
    for (const name of missing) {
      process.stderr.write(`build-examples: the example ${name} is missing from ${shown(options.examples)}.\n`);
    }
    return 2;
  }

  let worst = 0;
  const outcomes = [];
  const checks = [];
  let unreviewed = 0;
  for (const example of BUILT) {
    const piece = join(options.examples, example.name);
    process.stdout.write(`== ${example.name} (${example.template}): papeleria check ${shown(piece)} --json\n`);
    const checked = checkExample(options.cli, example, piece);
    for (const {finding, accepted} of checked.warnings) {
      const reason = accepted === null
        ? 'not reviewed: fix the example, or add the warning to ACCEPTED_WARNINGS in scripts/build-examples.mjs with the reason it is acceptable'
        : `accepted: ${accepted.reason}`;
      process.stdout.write(`warning ${finding.rule} ${place(finding)}: ${finding.message} (${reason})\n`);
      unreviewed += accepted === null ? 1 : 0;
    }
    worst = Math.max(worst, checked.code === 0 ? 0 : checked.code === 1 ? 1 : 2);
    checks.push(
      checked.errors === null
        ? `${example.name} not checked (exit ${checked.code})`
        : `${example.name} ${checked.errors} error${checked.errors === 1 ? '' : 's'}, ${checked.warnings.length} warning${checked.warnings.length === 1 ? '' : 's'}`,
    );
    process.stdout.write(`== ${example.name} (${example.template}): papeleria build ${shown(piece)}\n`);
    const result = spawnSync(process.execPath, [options.cli, 'build', piece], {encoding: 'utf8'});
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    // The CLI's own codes (IC05): 1 is the piece's content, 2 a failure of the
    // tool or its surroundings. A signal or a failure to start is a tool failure.
    const code = result.error === undefined && result.status !== null ? result.status : 2;
    if (result.error !== undefined) {
      process.stderr.write(`build-examples: the CLI could not run: ${result.error.message}\n`);
    }
    worst = Math.max(worst, code === 0 ? 0 : code === 1 ? 1 : 2);
    outcomes.push(`${example.name} ${code === 0 ? 'built' : `failed (exit ${code})`}`);
  }
  process.stdout.write(`examples: ${outcomes.join('; ')}\n`);
  process.stdout.write(`checks: ${checks.join('; ')}\n`);
  for (const example of PENDING) {
    process.stdout.write(`examples: ${example.name} (${example.template}) is pending: ${example.reason}\n`);
  }
  if (unreviewed > 0) {
    process.stderr.write(`build-examples: ${unreviewed} warning${unreviewed === 1 ? ' has' : 's have'} not been reviewed; each is listed above\n`);
    worst = Math.max(worst, 1);
  }
  return worst;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  process.exitCode = main(process.argv.slice(2));
}
