/**
 * M1.7: the templates this build can render, and what each needs staged.
 *
 * The deck arrived in milestone 1, the document in milestone 3 (M3.1, W3B)
 * and the comic in milestone 4 (M4.2, W4), so every template a manifest can
 * name now has its build, and a piece is never refused for want of one (D108).
 */
import type {Piece, TemplateName} from '../core/index.js';
import {comicFirstView, comicPhoneImages, COMIC_NOTICES, COMIC_SCRIPT, COMIC_STYLESHEETS, render as renderComic} from '../../templates/comic/render.js';
import {deckFirstView, DECK_SCRIPT, DECK_STYLESHEETS, render as renderDeck, type BuildContext, type RenderOutput} from '../../templates/deck/render.js';
import {documentFirstView, DOCUMENT_STYLESHEETS, render as renderDocument} from '../../templates/document/render.js';
import type {BuildMedia, FirstViewImage} from '../../templates/shared/blocks.js';
import {FIRST_VIEW_BUDGET_BYTES, type PhoneImageSource} from './budget.js';
import {comicTargets, deckTargets, documentTargets, type SourceTarget} from './targets.js';

export type TemplateBuild = {
  readonly render: (piece: Piece, media: BuildMedia, build: BuildContext) => RenderOutput;
  /** The typed targets, available as soon as the piece resolves (IC06). */
  readonly targets: (piece: Piece) => readonly SourceTarget[];
  /** The images the first view loads (IC04). */
  readonly firstView: (piece: Piece, media: BuildMedia) => readonly FirstViewImage[];
  readonly budgetBytes: number | null;
  /** The one classic script and where the tool keeps it, relative to the tool root; null for none. */
  readonly script: {readonly name: string; readonly source: string} | null;
  /**
   * A preview build's script (IC06, D79): the template's script with the
   * preview bridge bundled in, staged under the script's own name so the page
   * is the published one. A template without a script needs none: its preview
   * gets the bridge alone. A template with a script and no preview script has
   * no preview.
   */
  readonly previewScript?: {readonly name: string; readonly source: string};
  /** The stylesheets the page links, by output path, and where each comes from, relative to the tool root (D62). */
  readonly stylesheets: readonly {readonly href: string; readonly source: string}[];
  /** Notices beyond every generation's own, by output path and tool source: a comic's engine licence (D108). */
  readonly notices?: readonly {readonly path: string; readonly source: string}[];
  /** The page images held to the phone-image limit, each against its own (IC04, D106); a comic's only. */
  readonly phoneImages?: (piece: Piece, media: BuildMedia) => readonly PhoneImageSource[];
};

function asDeck<T>(piece: Piece, use: (deck: Extract<Piece, {template: 'deck'}>) => T): T {
  if (piece.template !== 'deck') {
    throw new Error(`E_INTERNAL: the deck template was given a ${piece.template}`);
  }
  return use(piece);
}

const DECK: TemplateBuild = {
  render: (piece, media, build) => asDeck(piece, (deck) => renderDeck(deck, media, build)),
  targets: (piece) => asDeck(piece, deckTargets),
  firstView: (piece, media) => asDeck(piece, (deck) => deckFirstView(deck, media)),
  budgetBytes: FIRST_VIEW_BUDGET_BYTES,
  script: {name: DECK_SCRIPT, source: 'lib/clients/deck.js'},
  previewScript: {name: DECK_SCRIPT, source: 'lib/clients/deck-preview.js'},
  stylesheets: DECK_STYLESHEETS,
};

function asDocument<T>(piece: Piece, use: (document: Extract<Piece, {template: 'document'}>) => T): T {
  if (piece.template !== 'document') {
    throw new Error(`E_INTERNAL: the document template was given a ${piece.template}`);
  }
  return use(piece);
}

/**
 * M3.1 (W3B): a document publishes no script (C22, IC07); its preview gets
 * the bridge alone (D79, D89). Its first view is its first logical sheet's
 * images and every poster (IC04, D96).
 */
const DOCUMENT: TemplateBuild = {
  render: (piece, media, build) => asDocument(piece, (document) => renderDocument(document, media, build)),
  targets: (piece) => asDocument(piece, documentTargets),
  firstView: (piece, media) => asDocument(piece, (document) => documentFirstView(document, media)),
  budgetBytes: FIRST_VIEW_BUDGET_BYTES,
  script: null,
  stylesheets: DOCUMENT_STYLESHEETS,
};

function asComic<T>(piece: Piece, use: (comic: Extract<Piece, {template: 'comic'}>) => T): T {
  if (piece.template !== 'comic') {
    throw new Error(`E_INTERNAL: the comic template was given a ${piece.template}`);
  }
  return use(piece);
}

/**
 * M4.2 (W4): a comic publishes `reader.js`, the engine's pinned bytes then
 * the reader (D109), with the engine's MIT licence beside it (D108); its
 * preview script has the bridge and the preview grid in it (D117). Its first
 * view, the cover and the next spread, has no limit; every phone format of
 * every page has one (IC04, D106).
 */
const COMIC: TemplateBuild = {
  render: (piece, media, build) => asComic(piece, (comic) => renderComic(comic, media, build)),
  targets: (piece) => asComic(piece, comicTargets),
  firstView: (piece, media) => asComic(piece, (comic) => comicFirstView(comic, media)),
  budgetBytes: null,
  script: {name: COMIC_SCRIPT, source: 'lib/clients/reader.js'},
  previewScript: {name: COMIC_SCRIPT, source: 'lib/clients/reader-preview.js'},
  stylesheets: COMIC_STYLESHEETS,
  notices: COMIC_NOTICES,
  phoneImages: (piece, media) => asComic(piece, (comic) => comicPhoneImages(comic, media)),
};

const BUILDS: Readonly<Record<TemplateName, TemplateBuild>> = {deck: DECK, document: DOCUMENT, comic: COMIC};

/** The build of a template. */
export function templateBuild(template: TemplateName): TemplateBuild {
  return BUILDS[template];
}
