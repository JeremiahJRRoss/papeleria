/**
 * M1.7: the check report (IC06), and the text the CLI prints for a person.
 *
 * `status` is `ok` or `failed` and counts only real findings: withheld is a
 * source status and an output reason, never an error (dev plan §04). The JSON
 * a command prints with `--json` is exactly this object; the human text goes
 * to stderr, every author-controlled part of it escaped so a piece cannot
 * drive a terminal (D145).
 */
import {escapeControls, type Finding, type Location} from '../core/index.js';
import {PHONE_IMAGE_BUDGET_BYTES, type FirstViewMeasure} from './budget.js';
import type {SourceTarget} from './targets.js';

export type OutputReason = 'written' | 'withheld' | 'check_only' | 'preview_only' | 'failed';

/** IC06 `Weight`; a comic adds `phoneImages` (M4.2, W4, D106). */
export type Weight = {
  readonly firstViewBytes: number;
  readonly budgetBytes: number | null;
  readonly withinBudget: boolean;
  readonly largest: readonly (readonly [string, number])[];
  /** A comic's phone images: each published phone-format file, its bytes, and whether it keeps the 307,200-byte limit (IC04). */
  readonly phoneImages?: readonly (readonly [string, number, boolean])[];
};

export type Report = {
  readonly piece: string;
  readonly tool: {readonly name: 'papeleria'; readonly version: string};
  readonly status: 'ok' | 'failed';
  readonly errors: number;
  readonly warnings: number;
  readonly findings: readonly Finding[];
  /** Null when the build stopped before it could measure anything. */
  readonly weight: Weight | null;
  readonly targets: readonly SourceTarget[];
  readonly outputWritten: boolean;
  readonly outputReason: OutputReason;
};

export function weightOf(measure: FirstViewMeasure): Weight {
  return {
    firstViewBytes: measure.firstViewBytes,
    budgetBytes: measure.budgetBytes,
    withinBudget: measure.withinBudget,
    largest: measure.largest.map(([path, bytes]) => [path, bytes] as const),
    ...(measure.phoneImages === undefined ? {} : {phoneImages: measure.phoneImages.map((image) => [image.path, image.bytes, image.withinBudget] as const)}),
  };
}

export type ReportInput = {
  readonly piece: string;
  readonly toolVersion: string;
  readonly findings: readonly Finding[];
  readonly weight: Weight | null;
  readonly targets: readonly SourceTarget[];
  readonly outputWritten: boolean;
  readonly outputReason: OutputReason;
};

/** A report over settled findings: counts are of the findings listed, deduplicated already (IC06). */
export function createReport(input: ReportInput): Report {
  const errors = input.findings.filter((finding) => finding.severity === 'error').length;
  return {
    piece: input.piece,
    tool: {name: 'papeleria', version: input.toolVersion},
    status: errors === 0 ? 'ok' : 'failed',
    errors,
    warnings: input.findings.length - errors,
    findings: input.findings,
    weight: input.weight,
    targets: input.targets,
    outputWritten: input.outputWritten,
    outputReason: input.outputReason,
  };
}

const numbers = new Intl.NumberFormat('en-US');

function count(value: number, noun: string): string {
  return `${numbers.format(value)} ${noun}${value === 1 ? '' : 's'}`;
}

/** `file:line:column`, or the file alone for a binary or global location; escaped for a terminal. */
export function formatLocation(location: Location): string {
  const file = escapeControls(location.file);
  if (location.line === null) {
    return file;
  }
  return `${file}:${location.line}${location.column === null ? '' : `:${location.column}`}`;
}

/** A finding as a person reads it. Message, fix and detail were escaped when the finding was made (D145). */
export function formatFinding(finding: Finding): string[] {
  const lines = [`${formatLocation(finding)} ${finding.severity} ${finding.rule}: ${finding.message}`, `  fix: ${finding.fix}`];
  if (finding.detail !== null) {
    lines.push(`  ${finding.detail}`);
  }
  if (finding.relatedLocation !== undefined) {
    lines.push(`  see ${formatLocation(finding.relatedLocation)}`);
  }
  return lines;
}

function weightLine(weight: Weight | null): string {
  if (weight === null) {
    return '';
  }
  const budget = weight.budgetBytes === null ? '' : ` of ${numbers.format(weight.budgetBytes)}`;
  // A comic's limit is per phone image (IC04, D106): the heaviest is named against it.
  const phone =
    weight.phoneImages === undefined || weight.phoneImages.length === 0
      ? ''
      : ` · largest phone image ${numbers.format(Math.max(...weight.phoneImages.map(([, bytes]) => bytes)))} of ${numbers.format(PHONE_IMAGE_BUDGET_BYTES)} bytes`;
  return ` · first view ${numbers.format(weight.firstViewBytes)}${budget} bytes${phone}`;
}

/** The whole report as text for stderr: every finding, then one summary line. */
export function formatReport(report: Report): string {
  const lines = report.findings.flatMap(formatFinding);
  const piece = escapeControls(report.piece).replace(/[\\/]+$/, '');
  const tally = `${count(report.errors, 'error')} · ${count(report.warnings, 'warning')}${weightLine(report.weight)}`;
  switch (report.outputReason) {
    case 'written':
      lines.push(`Built ${piece}/dist · ${tally}`);
      break;
    case 'withheld':
      lines.push(`${piece} is withheld: nothing was written to dist/ · ${tally}`);
      break;
    case 'check_only':
      lines.push(`Checked ${piece} · ${tally}`);
      break;
    case 'preview_only':
      lines.push(`Previewed ${piece} · ${tally}`);
      break;
    case 'failed':
      lines.push(`${piece} was not built: nothing was written to dist/ · ${tally}`);
      break;
  }
  return lines.join('\n');
}
