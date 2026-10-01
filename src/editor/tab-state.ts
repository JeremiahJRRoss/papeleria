/**
 * M2.2: what a tab does when it learns its file's revision on disk (IC05,
 * D81) — from an event, a recheck after reconnecting, or a refused request.
 * `tabs.ts` applies the outcome. Pure, and tested in Node.
 */

/** The part of a tab the disk's revision is weighed against. */
export type TabRevisionState = {
  /** The revision the buffer was loaded from or last saved as. */
  readonly baseRevision: string | null;
  /** The disk's revision when it moved under the tab; a null revision: the file is gone. */
  readonly conflict: {readonly currentRevision: string | null} | null;
  /** Whether the buffer holds work not yet saved. */
  readonly dirty: boolean;
};

/**
 * - `unchanged`: nothing to do.
 * - `resolved`: the disk holds the tab's base again, as when a write made
 *   elsewhere is undone: the conflict is over, and the buffer stays as the
 *   author left it, to be saved against that base (W5R-14).
 * - `conflict`: the tab is marked, or its conflict names the revision now there; nothing is written until the author chooses.
 * - `reload`: a clean buffer takes the disk's text, since it holds nothing of the author's.
 */
export type DiskOutcome = 'unchanged' | 'resolved' | 'conflict' | 'reload';

/** What a tab does when its file's revision on disk is `revision` (null: the file is gone). */
export function diskOutcome(tab: TabRevisionState, revision: string | null): DiskOutcome {
  if (revision === tab.baseRevision) {
    return tab.conflict === null ? 'unchanged' : 'resolved';
  }
  return tab.conflict !== null || tab.dirty || revision === null ? 'conflict' : 'reload';
}
