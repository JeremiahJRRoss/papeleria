/**
 * M1.7: the build pipeline (architecture §§4–6, dev plan §04, IC04, IC05).
 *
 * One function of a source snapshot and a target. The stages run in order and
 * each later one only on what the earlier ones accepted:
 *
 *  1. for `dist`, the per-piece build lock, then recovery of any interrupted
 *     promotion (IC05);
 *  2. the snapshot: `createNodeLoaders` with optional text overlays, every
 *     read remembered with its SHA-256;
 *  3. `loadManifest` → `validateManifest` → `resolvePiece`, stopping where
 *     `readPiece` stops, because the report needs the traced findings;
 *  4. every chart drawn once for R13, then the source rules, wherever the core
 *     stopped: the pass-through rules pass its findings on even when the piece
 *     did not resolve, and the rest read the piece when there is one;
 *  5. with no error so far, a generation under `.papeleria/staging/`: media,
 *     videos and a comic's zoom originals, the page, the tool's files; the
 *     first view measured, and a comic's phone images (IC04); the output
 *     rules (R07, R08, R12);
 *  6. every finding settled with one `settleFindings` (D145);
 *  7. a `dist` build with no error and a status other than `withheld` rechecks
 *     every source it read and promotes the generation; anything else
 *     discards it, and `dist/` is never touched.
 *
 * Content problems are findings. Everything else — a piece folder that is not
 * one, a source that changed, the tool's own files, image tooling, output
 * IO — is a `PipelineError` with a code, which
 * the CLI turns into exit 2 (IC05, IC06).
 *
 * The `preview` target (M2.1, W3A, D79) runs exactly as `check` — the same
 * findings and the same weight, measured and scanned on the page as it would
 * be published — and then, only when the report has no error, puts the
 * preview bridge in: the template's preview script under its published name,
 * or, for a template that publishes no script, the bridge alone as
 * `preview.js`, named by the page. The generation then moves to
 * `.papeleria/preview/<id>/` for the editor's preview origin; `dist/` is
 * never touched, and a withheld piece previews like any other (IC05). A run
 * given an `AbortSignal` stops between stages once it is aborted, with
 * E_CANCELLED, discarding its generation (IC06: superseded work).
 */
import {lstat, readFile, realpath} from 'node:fs/promises';
import {join} from 'node:path';

import {
  createNodeLoaders,
  hasErrors,
  ImageToolError,
  loadManifest,
  locateToolRoot,
  renderChart,
  resolvePiece,
  settleFindings,
  ToolResourceError,
  validateManifest,
  type ChartResult,
  type Piece,
  type SharpLoader,
  type TracedFinding,
  type ValidatedManifest,
} from '../core/index.js';
import {chartInput} from '../../templates/shared/blocks.js';
import {loadRules} from '../checks/load-rules.js';
import {InventoryError} from '../checks/owner-inventory.js';
import type {GeneratedOutput, OutputRule, OutputRuleContext, Rule} from '../checks/rule.js';
import {isResolvedChart, visitContent} from '../checks/walk.js';
import {measureFirstView, measurePhoneImages} from './budget.js';
import {publishMedia} from './media.js';
import {publishOriginals} from './originals.js';
import {createReport, weightOf, type OutputReason, type Report, type Weight} from './report.js';
import {recheckRevisions, recordRevisions, withOverlays, type SourceSnapshot} from './snapshot.js';
import {stageToolFiles, ToolFileError} from './stage.js';
import type {SourceTarget} from './targets.js';
import {templateBuild, type TemplateBuild} from './templates.js';
import {readToolVersion} from './version.js';
import {publishVideos} from './videos.js';
import {
  acquireBuildLock,
  discardGeneration,
  keepPreviewGeneration,
  openGeneration,
  OutputError,
  outputReadError,
  promoteGeneration,
  recoverPromotion,
  writeGenerationFile,
  type Generation,
  type Leftover,
  type PromotionFaults,
  type RecoveryOutcome,
} from './write.js';

/**
 * `dist` builds and may promote; `check` builds into a disposable generation
 * and never changes `dist/` (IC05); `preview` is a check whose passing
 * generation is kept for the editor's preview origin (D79).
 */
export type BuildTarget = {readonly kind: 'dist'} | {readonly kind: 'check'} | {readonly kind: 'preview'};

export type PipelineOptions = {
  /** The tool root: templates, theme, `lib/clients/` and the owner inventory. The installed package by default. */
  readonly toolRoot?: string;
  /** The package version by default. */
  readonly toolVersion?: string;
  /** How sharp is loaded; tests stand in one without AVIF. */
  readonly loadSharp?: SharpLoader;
  /** Stops promotion at a step, as a crash would, for the IC05 fault tests. */
  readonly faults?: PromotionFaults;
  /** Runs once a `dist` generation is complete and passing, just before the sources are rechecked. */
  readonly beforeRecheck?: () => Promise<void>;
  /** The rules to run; every module in `src/checks/rules/` by default. */
  readonly rules?: readonly Rule[];
  /** Stops the run between stages once aborted, with E_CANCELLED (IC06: superseded preview work). */
  readonly signal?: AbortSignal;
};

export type PipelineResult = {
  readonly report: Report;
  /** A `dist` build wrote nothing, and a `dist/` from an earlier build is still there (IC05). */
  readonly olderDist: boolean;
  /** What recovery did before a `dist` build, when it did anything. */
  readonly recovery: RecoveryOutcome | null;
  /** Folders a `dist` build no longer needs and could not remove; left for a later build, and noted (W5R-01). */
  readonly leftovers: readonly Leftover[];
  /** A `preview` run's kept generation: its id and folder under `.papeleria/preview/`; null for every other run and for a report with errors. */
  readonly preview: {readonly generationId: string; readonly directory: string} | null;
};

export type PipelineErrorCode =
  | 'E_PIECE_FOLDER'
  | 'E_SOURCE_IO'
  | 'E_SOURCE_CHANGED'
  | 'E_TEMPLATE_UNAVAILABLE'
  | 'E_TOOL_RESOURCE'
  | 'E_SHARP_UNAVAILABLE'
  | 'E_IMAGE_IO'
  | 'E_OUTPUT_IO'
  | 'E_BUSY'
  | 'E_RECOVERY'
  | 'E_CANCELLED'
  | 'E_INTERNAL';

/** A failure that is not the piece's content: exit 2, with its code and no rule (IC06). */
export class PipelineError extends Error {
  readonly code: PipelineErrorCode;

  constructor(code: PipelineErrorCode, message: string, options?: {cause?: unknown}) {
    super(message, options);
    this.name = 'PipelineError';
    this.code = code;
  }
}

function asPipelineError(error: unknown): PipelineError {
  if (error instanceof PipelineError) {
    return error;
  }
  if (error instanceof OutputError || error instanceof ImageToolError) {
    return new PipelineError(error.code, error.message, {cause: error});
  }
  if (error instanceof ToolResourceError || error instanceof ToolFileError || error instanceof InventoryError) {
    return new PipelineError('E_TOOL_RESOURCE', error.message, {cause: error});
  }
  const message = error instanceof Error ? error.message : String(error);
  if (typeof error === 'object' && error !== null && typeof (error as {syscall?: unknown}).syscall === 'string') {
    return new PipelineError('E_SOURCE_IO', `The piece could not be read: ${message}`, {cause: error});
  }
  return new PipelineError('E_INTERNAL', message.startsWith('E_INTERNAL') ? message : `E_INTERNAL: ${message}`, {cause: error});
}

/** The piece folder's canonical path, which must be a folder. */
async function pieceFolder(root: string, label: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(root);
  } catch {
    throw new PipelineError('E_PIECE_FOLDER', `The piece folder ${label} does not exist.`);
  }
  if (!(await lstat(canonical)).isDirectory()) {
    throw new PipelineError('E_PIECE_FOLDER', `${label} is not a folder. Give the folder that holds papeleria.yaml or papeleria.json.`);
  }
  return canonical;
}

async function hasDist(root: string): Promise<boolean> {
  try {
    return (await lstat(join(root, 'dist'))).isDirectory();
  } catch {
    return false;
  }
}

/** The bridge alone, for the preview of a template that publishes no script (IC06). */
export const PREVIEW_BRIDGE = Object.freeze({name: 'preview.js', source: 'lib/clients/document-preview.js'});

/** The page with the bridge's script element before `</head>`: a preview-only page, never published. */
export function withPreviewScript(html: string, name: string): string {
  const at = html.indexOf('</head>');
  if (at < 0) {
    throw new PipelineError('E_INTERNAL', 'E_INTERNAL: the page has no </head> for the preview bridge.');
  }
  return `${html.slice(0, at)}<script src="${name}" defer></script>${html.slice(at)}`;
}

async function readPreviewScript(toolRoot: string, source: string): Promise<Buffer> {
  try {
    return await readFile(join(toolRoot, ...source.split('/')));
  } catch (error) {
    throw new ToolFileError(source, `The tool file ${source} could not be read: ${(error as Error).message}. Run npm run build, which writes it.`, {cause: error});
  }
}

/**
 * Puts the preview bridge into a generation whose checks passed: the
 * template's preview script over its published one, or the bridge alone and
 * the page that names it. The report is already settled on the published form.
 */
async function stagePreview(generation: Generation, toolRoot: string, template: TemplateBuild, piece: Piece, html: string): Promise<void> {
  if (template.script !== null) {
    if (template.previewScript === undefined) {
      throw new PipelineError('E_TEMPLATE_UNAVAILABLE', `The ${piece.template} template has no preview in this build of Papeleria.`);
    }
    await writeGenerationFile(generation, template.previewScript.name, await readPreviewScript(toolRoot, template.previewScript.source));
    return;
  }
  await writeGenerationFile(generation, PREVIEW_BRIDGE.name, await readPreviewScript(toolRoot, PREVIEW_BRIDGE.source));
  await writeGenerationFile(generation, 'index.html', withPreviewScript(html, PREVIEW_BRIDGE.name));
}

/**
 * Runs an output rule. The rules read only the generation this run wrote, so a
 * system error from one is the output's, E_OUTPUT_IO, never the piece's
 * E_SOURCE_IO; the tool's own files fail with their own codes (W5R-11).
 */
async function outputRule(rule: OutputRule, context: OutputRuleContext): Promise<readonly TracedFinding[]> {
  try {
    return await rule.check(context);
  } catch (error) {
    if (typeof error === 'object' && error !== null && typeof (error as {syscall?: unknown}).syscall === 'string') {
      throw outputReadError(rule.id, error);
    }
    throw error;
  }
}

type Run = {
  readonly root: string;
  readonly label: string;
  readonly snapshot: SourceSnapshot;
  readonly target: BuildTarget;
  readonly toolRoot: string;
  readonly toolVersion: string;
  readonly options: PipelineOptions;
};

type RunResult = {report: Report; written: boolean; preview: PipelineResult['preview']; leftovers: readonly Leftover[]};

function cancelled(): PipelineError {
  return new PipelineError('E_CANCELLED', 'The run was cancelled because a newer one replaced it.');
}

async function run({root, label, snapshot, target, toolRoot, toolVersion, options}: Run): Promise<RunResult> {
  const checkpoint = (): void => {
    if (options.signal?.aborted === true) {
      throw cancelled();
    }
  };
  checkpoint();
  const overlays = snapshot.overlays ?? [];
  const recorder = recordRevisions(withOverlays(createNodeLoaders(root), overlays), overlays);
  const loaders = recorder.loaders;

  // Findings are joined with concat, never spread into push: a stage can hold more than a call takes.
  let traces: readonly TracedFinding[] = [];
  let targets: readonly SourceTarget[] = [];
  let weight: Weight | null = null;
  let preview: RunResult['preview'] = null;
  let leftovers: readonly Leftover[] = [];
  const finish = (outputReason: OutputReason, written = false): RunResult => ({
    report: createReport({piece: label, toolVersion, findings: settleFindings(traces), weight, targets, outputWritten: written, outputReason}),
    written,
    preview,
    leftovers,
  });
  const stopped = (): RunResult => finish(target.kind === 'check' ? 'check_only' : target.kind === 'preview' ? 'preview_only' : 'failed');

  // The core, stopping where readPiece stops: later stages run only on valid input.
  const readSources = async (): Promise<{manifest: ValidatedManifest | null; piece: Piece | null}> => {
    const loaded = await loadManifest(loaders, {pieceLabel: label});
    traces = traces.concat(loaded.findings);
    if (loaded.manifest === null) {
      return {manifest: null, piece: null};
    }
    const validated = validateManifest(loaded.manifest, {toolRoot});
    traces = traces.concat(validated.findings);
    if (validated.manifest === null || hasErrors(traces)) {
      return {manifest: null, piece: null};
    }
    const resolved = await resolvePiece(validated.manifest, {loaders, toolRoot});
    traces = traces.concat(resolved.findings);
    return {manifest: validated.manifest, piece: resolved.piece};
  };
  const {manifest, piece} = await readSources();
  checkpoint();

  // Every chart drawn once, so R13 reports what the page would draw (chartInput is shared with the renderer).
  const charts = new Map<string, ChartResult>();
  if (piece !== null) {
    visitContent(piece, (value) => {
      if (isResolvedChart(value) && value.data.csv.ok) {
        charts.set(value.pointer, renderChart(chartInput(value, 'chart', piece.language)));
      }
    });
  }
  // Source rules run wherever the core stopped; the core's own findings pass through them and settle once.
  const rules = options.rules ?? (await loadRules());
  const coreFindings = traces;
  for (const rule of rules) {
    if (rule.phase === 'source') {
      traces = traces.concat(rule.check({piece, manifest, coreFindings, charts}));
    }
  }
  if (piece === null || manifest === null) {
    return stopped();
  }
  checkpoint();
  // Targets exist as soon as the piece resolves, errors or not: the editor follows the cursor with them (IC06).
  const template = templateBuild(piece.template);
  targets = template.targets(piece);
  if (hasErrors(traces)) {
    return stopped();
  }

  const generation = await openGeneration(root);
  let promoted = false;
  try {
    const media = await publishMedia(piece, loaders, generation, {pieceLabel: label, ...(options.loadSharp === undefined ? {} : {loadSharp: options.loadSharp})});
    traces = traces.concat(media.findings);
    // M3.4 (W3B): a document's videos are copied as they are, beside its images (D96).
    const videos = await publishVideos(piece, loaders, generation);
    traces = traces.concat(videos.findings);
    // M4.2 (W4): the originals a comic's zoom details open, at their own paths (D108).
    const originals = await publishOriginals(piece, loaders, generation);
    traces = traces.concat(originals.findings);
    if (hasErrors(media.findings) || hasErrors(videos.findings) || hasErrors(originals.findings)) {
      return stopped();
    }
    checkpoint();
    const page = template.render(piece, media.media, {toolVersion});
    const pageBytes = await writeGenerationFile(generation, 'index.html', page.html);
    const staged = await stageToolFiles(generation, toolRoot, template, toolVersion);
    const firstView = measureFirstView({
      files: [{path: 'index.html', bytes: pageBytes}, ...staged.firstView],
      images: template.firstView(piece, media.media),
      budgetBytes: template.budgetBytes,
    });
    // A comic's limit is per phone image (IC04, D106): measured beside its first view, reported in its weight.
    const measure = template.phoneImages === undefined ? firstView : {...firstView, phoneImages: measurePhoneImages(template.phoneImages(piece, media.media))};
    weight = weightOf(measure);
    const first = targets[0];
    const output: GeneratedOutput = {
      directory: generation.directory,
      label: 'dist',
      files: [...generation.files].map(([path, bytes]) => ({path, bytes})).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      html: page.html,
      script: page.script,
      weight: measure,
      firstViewSource: first === undefined ? null : {file: first.file, line: first.lineStart, column: null},
      toolRoot,
      sourceImages: media.sourceHashes,
    };
    for (const rule of rules) {
      if (rule.phase === 'output') {
        traces = traces.concat(await outputRule(rule, {piece, manifest, coreFindings, charts, output}));
      }
    }
    if (hasErrors(traces) || target.kind === 'check') {
      return stopped();
    }
    if (target.kind === 'preview') {
      checkpoint();
      await stagePreview(generation, toolRoot, template, piece, page.html);
      const directory = await keepPreviewGeneration(generation);
      promoted = true;
      preview = {generationId: generation.id, directory};
      return stopped();
    }
    if (piece.status === 'withheld') {
      return finish('withheld');
    }
    await options.beforeRecheck?.();
    const changed = await recheckRevisions(root, recorder.record());
    if (changed.length > 0) {
      throw new PipelineError(
        'E_SOURCE_CHANGED',
        `The piece changed while it was being built (${changed.join(', ')}), so nothing was written and dist/ was left as it was. Build again.`,
      );
    }
    leftovers = await promoteGeneration(generation, options.faults);
    promoted = true;
    return finish('written', true);
  } finally {
    if (!promoted) {
      await discardGeneration(generation);
    }
  }
}

/**
 * Builds or checks a piece. Findings, however many, are the report; a thrown
 * `PipelineError` means the tool could not do what was asked (exit 2).
 */
export async function runPipeline(snapshot: SourceSnapshot, target: BuildTarget, options: PipelineOptions = {}): Promise<PipelineResult> {
  const label = snapshot.label ?? snapshot.root;
  try {
    const root = await pieceFolder(snapshot.root, label);
    const toolRoot = options.toolRoot ?? locateToolRoot();
    const toolVersion = options.toolVersion ?? readToolVersion();
    const job: Run = {root, label, snapshot, target, toolRoot, toolVersion, options};
    if (target.kind !== 'dist') {
      const {report, preview} = await run(job);
      return {report, olderDist: false, recovery: null, leftovers: [], preview};
    }
    const release = await acquireBuildLock(root);
    try {
      const recovered = await recoverPromotion(root);
      const {report, written, leftovers} = await run(job);
      return {
        report,
        olderDist: !written && (await hasDist(root)),
        recovery: recovered.outcome === 'nothing' ? null : recovered.outcome,
        leftovers: [...recovered.leftovers, ...leftovers],
        preview: null,
      };
    } finally {
      await release();
    }
  } catch (error) {
    throw asPipelineError(error);
  }
}
