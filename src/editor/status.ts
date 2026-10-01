/**
 * M2.5: the words of the editor's status line (UX §08 "States and copy").
 *
 * | State | Copy |
 * | --- | --- |
 * | Loading | "Building the preview…" |
 * | Ready | "Updated 0.6 s ago · 412 KB of 1 MB" — success colour under budget, warning colour within 10 % of it |
 * | Over budget | "1.2 MB of 1 MB. Largest: pages/03.png 640 KB" |
 * | A deck's slide too big for its printed page | "… · Slide 2 overflows", in the warning colour (D167, D174) |
 * | Unsaved | "Unsaved changes", after 30 seconds of unsaved work |
 * | Saved | "Saved 12:04" |
 * | Build failed | "2 errors. The preview shows the last good build." |
 *
 * A kilobyte here is 1,024 bytes and a megabyte 1,048,576, the unit the
 * budget is stated in (IC04), so the budget reads "1 MB". Pure, and tested in
 * Node.
 */

/** The report's weight, as IC06 shapes it. */
export type Weight = {
  readonly firstViewBytes: number;
  readonly budgetBytes: number | null;
  readonly withinBudget: boolean;
  readonly largest: readonly (readonly [string, number])[];
};

export type Tone = 'success' | 'warning' | 'error' | 'neutral';

const KIB = 1024;
const MIB = 1024 * 1024;

/** Bytes as the status line shows them: whole kilobytes under a megabyte, one decimal of a megabyte above. */
export function formatBytes(bytes: number): string {
  if (bytes >= MIB) {
    const megabytes = bytes / MIB;
    return `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1)} MB`;
  }
  return `${Math.max(bytes === 0 ? 0 : 1, Math.round(bytes / KIB))} KB`;
}

/** Seconds since the last preview, as "0.6 s", "12 s" or "3 min". */
export function formatAge(seconds: number): string {
  if (seconds < 10) {
    return `${(Math.max(0, Math.floor(seconds * 10)) / 10).toFixed(1)} s`;
  }
  if (seconds < 120) {
    return `${Math.floor(seconds)} s`;
  }
  return `${Math.floor(seconds / 60)} min`;
}

/** The tone of a weight against its budget: warning within 10 % of it, error over it. */
export function weightTone(weight: Weight): Tone {
  if (weight.budgetBytes === null) {
    return 'neutral';
  }
  if (weight.firstViewBytes > weight.budgetBytes) {
    return 'error';
  }
  return weight.firstViewBytes >= weight.budgetBytes * 0.9 ? 'warning' : 'success';
}

/** The largest files, "pages/03.png 640 KB, …", at most three. */
function largest(weight: Weight): string {
  return weight.largest
    .slice(0, 3)
    .map(([path, bytes]) => `${path} ${formatBytes(bytes)}`)
    .join(', ');
}

/**
 * A deck's slides that do not fit their printed page, as the preview measured them (IC08, D167, D174): "Slide 2
 * overflows", "Slides 2 and 5 overflow", "Slides 2, 5 and 9 overflow"; empty for none.
 */
export function overflowLine(slides: readonly number[]): string {
  if (slides.length === 0) {
    return '';
  }
  if (slides.length === 1) {
    return `Slide ${slides[0]} overflows`;
  }
  return `Slides ${slides.slice(0, -1).join(', ')} and ${slides[slides.length - 1]} overflow`;
}

/**
 * The status line after a preview: its age and the page's weight against the budget, then any slide that does not
 * fit its printed page, in the warning colour unless the weight is already over its budget.
 */
export function previewLine(weight: Weight | null, secondsAgo: number, overflowing: readonly number[] = []): {readonly text: string; readonly tone: Tone} {
  const line = weightLine(weight, secondsAgo);
  if (overflowing.length === 0) {
    return line;
  }
  return {text: `${line.text} · ${overflowLine(overflowing)}`, tone: line.tone === 'error' ? 'error' : 'warning'};
}

function weightLine(weight: Weight | null, secondsAgo: number): {readonly text: string; readonly tone: Tone} {
  const age = `Updated ${formatAge(secondsAgo)} ago`;
  if (weight === null) {
    return {text: age, tone: 'neutral'};
  }
  const tone = weightTone(weight);
  if (weight.budgetBytes === null) {
    return {text: `${age} · ${formatBytes(weight.firstViewBytes)} first view`, tone};
  }
  if (tone === 'error') {
    return {text: `${formatBytes(weight.firstViewBytes)} of ${formatBytes(weight.budgetBytes)}. Largest: ${largest(weight)}`, tone};
  }
  return {text: `${age} · ${formatBytes(weight.firstViewBytes)} of ${formatBytes(weight.budgetBytes)}`, tone};
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

/** The line for a preview that failed: what failed, and that the frame still shows the last good build. */
export function failedLine(errors: number, shownBefore: boolean): string {
  return shownBefore ? `${count(errors, 'error')}. The preview shows the last good build.` : `${count(errors, 'error')}. There is no preview until they are fixed.`;
}

/** "Saved 12:04", in the author's own clock. */
export function savedLine(at: Date): string {
  return `Saved ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/** The tally of a report: "0 errors · 1 warning". */
export function tally(errors: number, warnings: number): string {
  return `${count(errors, 'error')} · ${count(warnings, 'warning')}`;
}

/**
 * The comic's pointer readout while Grid is on (UX §08, D3): the page and
 * where the pointer is on its image, in percent with one decimal, the form a
 * panel's box is written in: "Page 2 · x 12.5% · y 40%".
 */
export function pointerLine(page: number, x: number, y: number): string {
  const percent = (value: number): string => `${Math.round(value * 10) / 10}%`;
  return `Page ${page} · x ${percent(x)} · y ${percent(y)}`;
}

/** The readout while Grid is on and the pointer is over no page: when Grid turns on, and when the pointer leaves the pages (D174). */
export const POINTER_PROMPT = 'Point at a page';
