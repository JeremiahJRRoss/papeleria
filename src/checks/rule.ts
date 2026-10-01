/**
 * M1.7: what a rule module is (architecture §9, D66).
 *
 * One file per rule in `src/checks/rules/`, named for its id (`R01.ts`),
 * exporting `rule`. The pipeline runs every one it finds there: `source`
 * rules once the core stops — with the Piece when it resolved — over the
 * Piece and the core's findings, and `output` rules once a generation is
 * written, over what it holds. A rule reports; it never repairs, and it never
 * checks again what the core already reports (D149, D152): a rule the core
 * reports passes the core's findings on. Findings are traced (D145) and
 * settled with the core's in one call, so a finding passed on is listed once.
 */
import type {ChartResult, Location, Piece, TracedFinding} from '../core/index.js';
import type {ValidatedManifest} from '../core/index.js';
import type {PublishedFile} from '../../templates/shared/blocks.js';
import type {FirstViewMeasure} from '../build/budget.js';

/**
 * What a source rule reads. The core may have stopped before the piece
 * resolved — an error stops it — and a rule that reads the piece then has
 * nothing to say; the pass-through rules still pass the core's findings on.
 */
export type SourceRuleContext = {
  /** Null when load, validation or resolve stopped with an error. */
  readonly piece: Piece | null;
  /** Null when the manifest did not load or validate. */
  readonly manifest: ValidatedManifest | null;
  /** Everything the load, validate and resolve stages reported (D145). */
  readonly coreFindings: readonly TracedFinding[];
  /** Each chart the build drew for R13, by the chart's pointer; a chart whose CSV did not parse has none. */
  readonly charts: ReadonlyMap<string, ChartResult>;
};

/** What a build wrote, for the rules that read its output. */
export type GeneratedOutput = {
  /** The generation on disk. */
  readonly directory: string;
  /** How findings name the output folder: `dist`, whatever the target (D66). */
  readonly label: string;
  /** Every file written, output-relative, with its size. */
  readonly files: readonly PublishedFile[];
  /** The page as written. */
  readonly html: string;
  /** The page's one script, or null. */
  readonly script: string | null;
  readonly weight: FirstViewMeasure;
  /** Where the first view's source begins (a deck's slide 1), for R07's related location; null when unknown. */
  readonly firstViewSource: Location | null;
  /** The tool root, where the owner's inventory may be (`brand/owner-assets.sha256`). */
  readonly toolRoot: string;
  /** The SHA-256 hashes each source image's file may have, by path (R12); see `PublishedMedia.sourceHashes`. */
  readonly sourceImages: ReadonlyMap<string, readonly string[]>;
};

/** What an output rule reads: a generation exists only for a piece that resolved. */
export type OutputRuleContext = {
  readonly piece: Piece;
  readonly manifest: ValidatedManifest;
  readonly coreFindings: readonly TracedFinding[];
  readonly charts: ReadonlyMap<string, ChartResult>;
  readonly output: GeneratedOutput;
};

export type SourceRule = {
  readonly id: string;
  readonly phase: 'source';
  check(context: SourceRuleContext): readonly TracedFinding[];
};

export type OutputRule = {
  readonly id: string;
  readonly phase: 'output';
  check(context: OutputRuleContext): Promise<readonly TracedFinding[]>;
};

export type Rule = SourceRule | OutputRule;

/** The findings a core stage already made for one rule, passed through unchanged (D66). */
export function coreFindingsFor(context: SourceRuleContext, id: string): readonly TracedFinding[] {
  return context.coreFindings.filter((item) => item.finding.rule === id);
}
