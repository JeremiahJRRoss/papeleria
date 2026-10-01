/**
 * R06: an image or video has no credit or no rights note (IC01, C28).
 *
 * Two separate warnings, so an author who has one of them is told only of the
 * other: each image block, video block and comic page is read, found by its
 * shape wherever a template puts it (a deck logo has neither field and is not).
 * An absent field is reported at its container, as IC01 places a missing
 * field. A blank one never gets here: the schema requires a visible character.
 */
import {traced, type TracedFinding} from '../../core/index.js';
import {containerLocation} from '../locate.js';
import type {SourceRule} from '../rule.js';
import {visitContent} from '../walk.js';

type Credited = {readonly pointer: string; readonly credit: string | null; readonly rights: string | null};

/** What the credited thing is called in a message, and the file it shows. */
function describe(value: Readonly<Record<string, unknown>>): {readonly noun: string; readonly path: string | null} {
  const pathOf = (asset: unknown): string | null => {
    const path = (asset as {path?: unknown} | null)?.path;
    return typeof path === 'string' ? path : null;
  };
  if ('panels' in value) {
    return {noun: 'page image', path: pathOf(value['image'])};
  }
  if ('poster' in value) {
    return {noun: 'video', path: pathOf(value['asset'])};
  }
  return {noun: 'image', path: pathOf(value['asset'])};
}

function isCredited(value: Readonly<Record<string, unknown>>): value is Credited {
  const nullableString = (field: unknown): boolean => field === null || typeof field === 'string';
  return typeof value['pointer'] === 'string' && 'credit' in value && 'rights' in value && nullableString(value['credit']) && nullableString(value['rights']);
}

const FIELDS = {
  credit: {
    words: 'credit',
    fix: (noun: string) => `Add credit: naming who made the ${noun}. It is a warning, but close it before publishing.`,
  },
  rights: {
    words: 'rights note',
    fix: (noun: string) => `Add rights: saying how the ${noun} may be used, such as its licence or permission. It is a warning, but close it before publishing.`,
  },
} as const;

export const rule: SourceRule = {
  id: 'R06',
  phase: 'source',
  check({piece}) {
    if (piece === null) {
      return [];
    }
    const findings: TracedFinding[] = [];
    visitContent(piece, (value) => {
      if (!isCredited(value)) {
        return;
      }
      const {noun, path} = describe(value);
      const subject = path === null ? `The ${noun}` : `The ${noun} ${path}`;
      for (const field of ['credit', 'rights'] as const) {
        if (value[field] !== null) {
          continue;
        }
        findings.push(
          traced({
            rule: 'R06',
            message: `${subject} has no ${FIELDS[field].words}.`,
            fix: FIELDS[field].fix(noun),
            detail: `Container location: this ${noun} starts here and has no ${field}.`,
            location: containerLocation(piece, value.pointer),
            sourcePath: `${piece.manifestFile}#${value.pointer}#${field}`,
          }),
        );
      }
    });
    return findings;
  },
};
