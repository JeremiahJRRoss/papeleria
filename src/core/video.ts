/**
 * M3.4: the video reader (IC04, D12, D92, D190). `probeVideo` is
 * `Loaders.probeVideo` as it is: it takes the bytes resolve read through
 * `FileAccess` (D155, D158) and never a path, so a file is opened one way
 * only, and the file name and anything an author wrote about the video play
 * no part.
 *
 * music-metadata's `parseBuffer` reads every video, with the duration on and
 * covers skipped: it lists the tracks and gives a WebM file's duration (the
 * Segment's `Duration` times its `TimecodeScale`). A video must be WebM or MP4
 * and hold a video track; its duration must be finite, above zero and at most
 * 15 seconds, the limit included. Anything else is one R16 problem with
 * `line: null`, which resolve keeps in `VideoAsset.probe` for the R16 rule
 * (D152, D158).
 *
 * music-metadata sizes each read by what a file declares and trusts every
 * count it finds, so a file of a few bytes could make it reserve gigabytes,
 * loop without end or backtrack for hours (security audit F8, F20). It reads
 * only a file `admitVideo` admitted (D190): the container is named from the
 * bytes, and every part music-metadata will read was walked and found inside
 * the part that holds it, in a shape it reads in linear time, and few enough.
 * The media type found is given to `parseBuffer`, so it never guesses a format
 * and never runs a parser for another one.
 *
 * music-metadata 11.15 measures an MP4 only from its first audio track, so a
 * silent MP4 would have no duration at all (DEP04, blueprint W3B). An MP4's
 * duration is therefore its movie header's: `moov/mvhd`, the presentation's
 * length in the file's own time units (ISO/IEC 14496-12 §8.2.2), read by
 * `readMovieHeader` below, a bounded walk over two levels of boxes (D92). A
 * fragmented movie goes on past what that header counts, so its duration is
 * unknown (W5R-23).
 */
import {parseBuffer, type IAudioMetadata} from 'music-metadata';

import {quoteValue, type AssetProblem} from './finding.js';
import type {VideoProbeResult} from './types.js';

/** IC04: a video loop is at most this many seconds, inclusive. */
export const VIDEO_MAX_SECONDS = 15;

export type VideoProblemCode =
  | 'unreadable'
  | 'unsupported_container'
  | 'no_video_track'
  | 'unknown_duration'
  | 'non_finite_duration'
  | 'zero_duration'
  | 'too_long';

function problem(code: VideoProblemCode, message: string, fix: string): VideoProbeResult {
  const value: AssetProblem = {code, rule: 'R16', message, fix, line: null};
  return {ok: false, problem: value};
}

const EXPORT_AGAIN = 'Export the loop again as MP4 or WebM, 15 seconds long or less, and replace the file.';
const EXPORT_AS_VIDEO = 'Export the loop as MP4 or WebM, 15 seconds long or less.';

/**
 * A duration for a message: exact when it is short, never rounded into the
 * limit (15.0004 seconds is not "15").
 */
export function formatSeconds(seconds: number): string {
  const rounded = Number(seconds.toFixed(3));
  const text = rounded > VIDEO_MAX_SECONDS || seconds <= VIDEO_MAX_SECONDS ? String(rounded) : String(seconds);
  return text === '1' ? '1 second' : `${text} seconds`;
}

// ---------------------------------------------------------------------------
// The movie header (ISO/IEC 14496-12 §4.2, §8.2.2)

export type MovieHeader = {
  readonly version: 0 | 1;
  /** Time units per second. */
  readonly timescale: number;
  /** In time units; null when the file writes all ones, which the format uses for "unknown". */
  readonly duration: number | null;
};

type Box = {readonly type: string; readonly payloadStart: number; readonly end: number};

/** The boxes between `start` and `end`, in order; null when one runs past `end` or cannot be a box. */
function boxesIn(bytes: Uint8Array, view: DataView, start: number, end: number): Box[] | null {
  const boxes: Box[] = [];
  let at = start;
  while (at < end) {
    if (end - at < 8) {
      return null;
    }
    const declared = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!);
    let header = 8;
    let size: number;
    if (declared === 1) {
      if (end - at < 16) {
        return null;
      }
      const large = view.getBigUint64(at + 8);
      if (large > BigInt(end - at)) {
        return null;
      }
      header = 16;
      size = Number(large);
    } else if (declared === 0) {
      // "The box extends to the end of the file" — the end of what holds it.
      size = end - at;
    } else {
      size = declared;
    }
    if (size < header || at + size > end) {
      return null;
    }
    boxes.push({type, payloadStart: at + header, end: at + size});
    at += size;
  }
  return boxes;
}

/** The boxes of the first top-level `moov`; null when there is none, or when a box on the way is damaged. */
function movieBoxes(bytes: Uint8Array, view: DataView): Box[] | null {
  const movie = boxesIn(bytes, view, 0, bytes.byteLength)?.find((box) => box.type === 'moov');
  return movie === undefined ? null : boxesIn(bytes, view, movie.payloadStart, movie.end);
}

/**
 * The movie header of an ISO base media file: the first top-level `moov`,
 * then its `mvhd`. Null when there is none, or when a box on the way is
 * damaged. Linear in the number of boxes, with no recursion and no copy.
 */
export function readMovieHeader(bytes: Uint8Array): MovieHeader | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = movieBoxes(bytes, view)?.find((box) => box.type === 'mvhd');
  if (header === undefined) {
    return null;
  }
  const at = header.payloadStart;
  const length = header.end - at;
  const version = length >= 1 ? bytes[at]! : -1;
  // A full box: version and flags, then the creation and modification times,
  // the timescale and the duration, 32 bits wide in version 0 and 64 in version 1.
  if (version === 0 && length >= 20) {
    const duration = view.getUint32(at + 16);
    return {version: 0, timescale: view.getUint32(at + 12), duration: duration === 0xffff_ffff ? null : duration};
  }
  if (version === 1 && length >= 32) {
    const duration = view.getBigUint64(at + 24);
    return {version: 1, timescale: view.getUint32(at + 20), duration: duration === 0xffff_ffff_ffff_ffffn ? null : Number(duration)};
  }
  return null;
}

/**
 * True when the first `moov` holds `mvex` (ISO/IEC 14496-12 §8.8.1): the
 * movie goes on in fragments after the movie box. `mvhd` counts only what
 * the movie box holds, often nothing (a duration of 0), so it is no bound on
 * the whole; only an optional `mehd` or every fragment summed would be.
 */
export function isFragmentedMovie(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return movieBoxes(bytes, view)?.some((box) => box.type === 'mvex') ?? false;
}

// ---------------------------------------------------------------------------
// Admission (D190; security audit F8, F20)
//
// What music-metadata 11.15 does with the parts it reads, and so why each rule
// below exists. Its EBML reader allocates an element's declared size before
// reading it, and trims every string with /\x00.*$/g, which backtracks from
// each zero byte to a line break that follows it. Its MP4 reader sizes each
// box's read the same way, loops over a sample description's entry count even
// where an entry's size is zero, walks a fragment's sample runs by a count no
// length bounds, and removes repeated `ftyp` brands by comparing every pair.
// A part it reads in more or fewer bytes than the part holds (a ten-byte
// float, a `chap` list of odd length, a 64-bit `data` box, a `meta` box too
// short for its version and flags, a size of zero below the top level) leaves
// it reading the rest of the file out of step with the walk, so those shapes
// are refused as well. The walks follow its traversal: they descend into
// every part it reads as a container, and hold the parts it skips whole (a
// Cluster, Cues, `mdat`) only to the part that holds them.

/**
 * The most boxes or elements music-metadata may visit in one file. Each costs
 * it a turn of an asynchronous loop, and a WebM element about a kilobyte of
 * objects (990,000 of them took 16 seconds and 1.4 GiB); an MP4 or WebM file
 * has a few hundred, a long one a few thousand.
 */
export const VIDEO_MAX_PARTS = 20_000;
/**
 * The most sample-table entries, sample descriptions and chapter references in
 * an MP4, which it reads into an object or a number each (990,000 took half a
 * second): a loop of 15 seconds has a few thousand.
 */
export const VIDEO_MAX_ENTRIES = 1_000_000;
/** Parts nest at most this deep; MP4 and WebM files nest fewer than ten levels. */
const VIDEO_MAX_DEPTH = 32;
/** An `ftyp` box names a handful of brands, and music-metadata compares every pair of them. */
const VIDEO_MAX_BRANDS = 64;

type Admission = {readonly ok: true; readonly mediaType: 'video/mp4' | 'video/webm'} | {readonly ok: false; readonly failure: VideoProbeResult};

const numbers = new Intl.NumberFormat('en-US');

const RUNS_PAST_FILE = 'the file ends before its container does';
const RUNS_PAST_PART = 'a part of its container is larger than the part that holds it';
const MALFORMED = 'its container is damaged';
const LINE_BREAK_AFTER_ZERO = 'a text field in its container has a line break after a zero byte';
const TOO_MANY_PARTS = `its container has more than ${numbers.format(VIDEO_MAX_PARTS)} parts, far more than a loop of 15 seconds needs`;
const TOO_MANY_ENTRIES = `its tables hold more than ${numbers.format(VIDEO_MAX_ENTRIES)} entries, far more than a loop of 15 seconds needs`;

function refuse(failure: VideoProbeResult): Admission {
  return {ok: false, failure};
}

function notAVideo(name?: string): VideoProbeResult {
  return problem(
    'unsupported_container',
    name === undefined ? 'The file is not an MP4 or WebM video.' : `The file is ${name}, not an MP4 or WebM video.`,
    EXPORT_AS_VIDEO,
  );
}

function unreadable(reason: string): VideoProbeResult {
  return problem('unreadable', `The video could not be read: ${reason}.`, `${EXPORT_AGAIN} The file may be truncated or damaged.`);
}

/** A fragmented MP4 (D179), refused by the admission walk before music-metadata reads it (D190), and by the reader after. */
function fragmented(): VideoProbeResult {
  return problem(
    'unknown_duration',
    'The MP4 file is fragmented: its movie header does not count the fragments after it, so its duration is unknown.',
    'Export the loop again as a regular MP4, not a fragmented or streaming one, 15 seconds long or less, and replace the file.',
  );
}

/** Where a part that does not fit runs: past the end of the file, or past the part that holds it. */
function overrun(bytes: Uint8Array, end: number): string {
  return end === bytes.length ? RUNS_PAST_FILE : RUNS_PAST_PART;
}

/** The first four bytes at `at` read as a box type or brand, or '' when the file ends first. */
function fourCharacters(bytes: Uint8Array, at: number): string {
  return at + 4 <= bytes.length ? String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!) : '';
}

type Region = {readonly start: number; readonly end: number; readonly depth: number};

// EBML and WebM (RFC 8794, RFC 9559)

/**
 * The element ids music-metadata's Matroska DTD reads as containers, which the
 * walk descends into wherever they appear, and the two containers its parser
 * skips whole (`IgnoreElement`): Cluster, which holds the frames, and Cues.
 * Its strings and floats, whose shapes it reads in its own way. Ids are unique
 * across the schema, so a set by id is exact. `test/unit/video.test.ts` holds
 * these sets to the DTD installed.
 */
export const EBML_ELEMENTS: {
  readonly containers: ReadonlySet<number>;
  readonly skipped: ReadonlySet<number>;
  readonly strings: ReadonlySet<number>;
  readonly floats: ReadonlySet<number>;
} = Object.freeze({
  containers: new Set([
    0x1a45dfa3, // EBML
    0x18538067, // Segment
    0x114d9b74, // SeekHead
    0x4dbb, // Seek
    0x1549a966, // Info
    0x1654ae6b, // Tracks
    0xae, // TrackEntry
    0xe0, // Video
    0xe1, // Audio
    0x6d80, // ContentEncodings
    0x6240, // ContentEncoding
    0x5034, // ContentCompression
    0x5035, // ContentEncryption
    0x1043a770, // Chapters
    0x45b9, // EditionEntry
    0xb6, // ChapterAtom
    0x8f, // ChapterTrack
    0x80, // ChapterDisplay
    0x1254c367, // Tags
    0x7373, // Tag
    0x63c0, // Targets
    0x67c8, // SimpleTag
    0x1941a469, // Attachments
    0x61a7, // AttachedFile
    0xbb, // CuePoint
    0xb7, // CueTrackPositions
    0xdb, // CueReference
  ]),
  skipped: new Set([
    0x1f43b675, // Cluster
    0x1c53bb6b, // Cues
  ]),
  strings: new Set([
    0x4282, // DocType
    0x4d80, // MuxingApp
    0x5741, // WritingApp
    0x7384, // SegmentFilename
    0x7ba9, // Title
    0x3c83ab, // PrevFilename
    0x3e83bb, // NextFilename
    0x86, // CodecID
    0x536e, // Name
    0x22b59c, // Language
    0x258688, // CodecName
    0x26b240, // CodecDownloadURL
    0x3a9697, // CodecSettings
    0x3b4040, // CodecInfoURL
    0x85, // ChapString
    0x437c, // ChapLanguage
    0x437e, // ChapCountry
    0x63ca, // TargetType
    0x447a, // TagLanguage
    0x447b, // TagLanguageBCP47
    0x4487, // TagString
    0x45a3, // TagName
    0x4660, // FileMediaType
    0x466e, // FileName
    0x467e, // FileDescription
  ]),
  floats: new Set([
    0x4489, // Duration
    0x2fb523, // GammaValue
    0xb5, // SamplingFrequency
    0x78b5, // OutputSamplingFrequency
    0x23314f, // TrackTimestampScale
  ]),
});

const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];
const DOC_TYPE = 0x4282;

type EbmlElement = {readonly id: number; readonly size: number | null; readonly sizeWidth: number; readonly dataStart: number};

/**
 * The id and size of the element at `at`, read as music-metadata reads them:
 * an id of one to four bytes and a size of one to eight. `short` when they do
 * not end before `end`, `invalid` when they are no such integers. A size whose
 * value bits are all ones is null: unknown (RFC 8794 §6.2).
 */
function ebmlElement(bytes: Uint8Array, at: number, end: number): EbmlElement | 'short' | 'invalid' {
  const idWidth = Math.clz32(bytes[at]!) - 23;
  if (idWidth > 4) {
    return 'invalid';
  }
  const sizeAt = at + idWidth;
  if (sizeAt >= end) {
    return 'short';
  }
  const sizeWidth = Math.clz32(bytes[sizeAt]!) - 23;
  if (sizeWidth > 8) {
    return 'invalid';
  }
  const dataStart = sizeAt + sizeWidth;
  if (dataStart > end) {
    return 'short';
  }
  let id = 0;
  for (let index = at; index < sizeAt; index += 1) {
    id = id * 256 + bytes[index]!;
  }
  const mask = 0xff >> sizeWidth;
  let size = bytes[sizeAt]! & mask;
  let unknown = size === mask;
  for (let index = sizeAt + 1; index < dataStart; index += 1) {
    // Past 2^53 the sum loses precision, never size: it is still far more than a file holds.
    size = size * 256 + bytes[index]!;
    unknown &&= bytes[index] === 0xff;
  }
  return {id, size: unknown ? null : size, sizeWidth, dataStart};
}

/**
 * Whether music-metadata trims a string in linear time. Its /\x00.*$/g
 * backtracks from every zero byte to the next line break when one follows, so
 * zero bytes before a line break take quadratic time (F20); when no line break
 * follows the first zero byte, it removes the rest in one match.
 */
function trimsInLinearTime(text: Uint8Array): boolean {
  const zero = text.indexOf(0);
  if (zero < 0) {
    return true;
  }
  for (let index = zero + 1; index < text.length; index += 1) {
    const byte = text[index]!;
    // A line break in UTF-8: LF, CR, and U+2028 and U+2029, E2 80 A8 and E2 80 A9.
    if (byte === 0x0a || byte === 0x0d || (byte === 0xe2 && text[index + 1] === 0x80 && (text[index + 2] === 0xa8 || text[index + 2] === 0xa9))) {
      return false;
    }
  }
  return true;
}

/**
 * Walks the elements between `start` and `end` and every container among
 * them, and returns why music-metadata must not read them, or null. `count`
 * carries the parts counted across calls.
 */
function walkEbml(bytes: Uint8Array, start: number, end: number, count: {parts: number}): string | null {
  const {containers, skipped, strings, floats} = EBML_ELEMENTS;
  const pending: Region[] = [{start, end, depth: 1}];
  for (let region = pending.pop(); region !== undefined; region = pending.pop()) {
    let at = region.start;
    while (at < region.end) {
      const element = ebmlElement(bytes, at, region.end);
      if (element === 'short') {
        return overrun(bytes, region.end);
      }
      if (element === 'invalid') {
        return MALFORMED;
      }
      const {id, size, dataStart} = element;
      let elementEnd: number;
      if (size === null) {
        // A container of unknown size runs to the end of the one that holds it.
        // music-metadata reads the size as a number: for a container it reads,
        // that ends at the same elements; for one it skips, it reaches the end
        // of the file only when the size takes eight bytes.
        if (!containers.has(id) && !(skipped.has(id) && element.sizeWidth === 8)) {
          return MALFORMED;
        }
        elementEnd = region.end;
      } else if (size > region.end - dataStart) {
        return overrun(bytes, region.end);
      } else {
        elementEnd = dataStart + size;
      }
      count.parts += 1;
      if (count.parts > VIDEO_MAX_PARTS) {
        return TOO_MANY_PARTS;
      }
      if (containers.has(id)) {
        if (region.depth >= VIDEO_MAX_DEPTH) {
          return MALFORMED;
        }
        pending.push({start: dataStart, end: elementEnd, depth: region.depth + 1});
      } else if (floats.has(id) && size !== 0 && size !== 4 && size !== 8) {
        // It reads eight bytes of a ten-byte float and goes on two bytes early.
        return MALFORMED;
      } else if (strings.has(id) && !trimsInLinearTime(bytes.subarray(dataStart, elementEnd))) {
        return LINE_BREAK_AFTER_ZERO;
      }
      at = elementEnd;
    }
  }
  return null;
}

/** The text of the first `id` element directly between `start` and `end`, up to its first zero byte; null when there is none. */
function ebmlText(bytes: Uint8Array, start: number, end: number, id: number): string | null {
  for (let at = start; at < end; ) {
    const element = ebmlElement(bytes, at, end);
    if (typeof element !== 'object') {
      return null;
    }
    const elementEnd = element.size === null ? end : element.dataStart + element.size;
    if (element.id === id) {
      const text = bytes.subarray(element.dataStart, elementEnd);
      const zero = text.indexOf(0);
      return new TextDecoder().decode(zero < 0 ? text : text.subarray(0, zero));
    }
    at = elementEnd;
  }
  return null;
}

function admitWebm(bytes: Uint8Array): Admission {
  // The EBML header names the document type; while it is not whole, nothing does.
  const header = ebmlElement(bytes, 0, bytes.length);
  if (typeof header !== 'object' || header.size === null || header.size > bytes.length - header.dataStart) {
    return refuse(notAVideo());
  }
  const headerEnd = header.dataStart + header.size;
  const count = {parts: 1};
  const docType = walkEbml(bytes, header.dataStart, headerEnd, count) === null ? ebmlText(bytes, header.dataStart, headerEnd, DOC_TYPE) : null;
  if (docType === null) {
    return refuse(notAVideo());
  }
  const container = containerOf(`EBML/${docType}`);
  if (container.kind !== 'webm') {
    return refuse(notAVideo(container.kind === 'other' ? container.name : undefined));
  }
  const fault = walkEbml(bytes, headerEnd, bytes.length, count);
  return fault === null ? {ok: true, mediaType: 'video/webm'} : refuse(unreadable(fault));
}

// The ISO base media file format (ISO/IEC 14496-12) and MP4

/** Boxes music-metadata reads as lists of boxes, by type wherever they are, and `trak`, whose children it reads for a track. */
const ISO_CONTAINERS: ReadonlySet<string> = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'meta', 'ilst', '<id>', 'tref']);
/** Metadata lists, whose every child it reads as a list of boxes too. */
const ISO_ITEM_LISTS: ReadonlySet<string> = new Set(['ilst', '<id>']);
/** A fragmented movie: its sample runs are walked by a count no length bounds, and its movie header does not hold its duration. */
const ISO_FRAGMENTS: ReadonlySet<string> = new Set(['moof', 'mvex']);
/** Sample tables it turns into an object per row: the bytes before the rows, and each row's. */
const ISO_TABLES: ReadonlyMap<string, readonly [header: number, row: number]> = new Map([
  ['stts', [8, 8]],
  ['stsc', [8, 12]],
  ['stsz', [12, 4]],
  ['stco', [8, 4]],
]);

type IsoBox = {readonly type: string; readonly payload: number; readonly end: number; readonly large: boolean};

/**
 * The box at `at`: `short` when it does not end before `end`, `invalid` when
 * its size cannot be a box's. A size of zero, "to the end of the file", is
 * the last top-level box's alone (§4.2); music-metadata reads it elsewhere as
 * a payload of minus eight bytes.
 */
function isoBox(bytes: Uint8Array, view: DataView, at: number, end: number, topLevel: boolean): IsoBox | 'short' | 'invalid' {
  if (end - at < 8) {
    return 'short';
  }
  const declared = view.getUint32(at);
  const type = fourCharacters(bytes, at + 4);
  if (declared === 1) {
    if (end - at < 16) {
      return 'short';
    }
    const size = view.getBigUint64(at + 8);
    if (size < 16n) {
      return 'invalid';
    }
    return size > BigInt(end - at) ? 'short' : {type, payload: at + 16, end: at + Number(size), large: true};
  }
  if (declared === 0) {
    return topLevel ? {type, payload: at + 8, end, large: false} : 'invalid';
  }
  if (declared < 8) {
    return 'invalid';
  }
  return declared > end - at ? 'short' : {type, payload: at + 8, end: at + declared, large: false};
}

/**
 * An `ftyp` box's brands as music-metadata reads them: every four bytes of the
 * payload, the minor version included, with non-word characters removed, the
 * empty and repeated ones dropped. Null unless the payload is a whole number
 * of brands, the major brand and minor version first and at most
 * `VIDEO_MAX_BRANDS` after them.
 */
function fileTypeBrands(bytes: Uint8Array, box: IsoBox): {readonly major: string; readonly brands: readonly string[]} | null {
  const length = box.end - box.payload;
  if (length < 8 || length % 4 !== 0 || length / 4 > VIDEO_MAX_BRANDS + 2) {
    return null;
  }
  const brands: string[] = [];
  for (let at = box.payload; at < box.end; at += 4) {
    const brand = fourCharacters(bytes, at).replace(/\W/g, '');
    if (brand.length > 0 && !brands.includes(brand)) {
      brands.push(brand);
    }
  }
  return {major: fourCharacters(bytes, box.payload), brands};
}

/**
 * A sample description box's entries, counted as music-metadata reads them: it
 * loops over the entry count and steps by each entry's leading size, so each
 * size must be at least a box header, and the entries must fill the box
 * exactly and be as many as it says (F20). Null otherwise.
 */
function sampleDescriptions(view: DataView, box: IsoBox): number | null {
  if (box.end - box.payload < 8) {
    return null;
  }
  const declared = view.getUint32(box.payload + 4);
  let entries = 0;
  for (let at = box.payload + 8; at < box.end; entries += 1) {
    const size = box.end - at < 8 ? 0 : view.getUint32(at);
    if (size < 8 || size > box.end - at) {
      return null;
    }
    at += size;
  }
  return entries === declared ? entries : null;
}

/**
 * The entries a box holds, as music-metadata reads one value or object for
 * each: sample-table rows, sample descriptions, and the track references of a
 * `chap` list, four bytes each. Null for a shape it misreads: a sample
 * description it loops over without end, an `ftyp` of too many brands, a
 * `chap` list whose length is not a multiple of four, a 64-bit `data` box whose
 * length it takes eight bytes too long.
 */
function isoEntries(bytes: Uint8Array, view: DataView, box: IsoBox): number | null {
  const length = box.end - box.payload;
  switch (box.type) {
    case 'ftyp':
      return fileTypeBrands(bytes, box) === null ? null : 0;
    case 'chap':
      return length % 4 === 0 ? length / 4 : null;
    case 'data':
      return box.large ? null : 0;
    case 'stsd':
      return sampleDescriptions(view, box);
    default: {
      const table = ISO_TABLES.get(box.type);
      return table === undefined ? 0 : Math.max(0, Math.floor((length - table[0]) / table[1]));
    }
  }
}

/**
 * Where a `meta` box's children start, as music-metadata finds them: at once
 * when the four bytes a first child's type would take spell `hdlr`
 * (QuickTime), after four bytes of version and flags otherwise (ISO). Null for
 * a payload it would read out of step: shorter than a child's header, and
 * longer than version and flags alone.
 */
function metaChildren(bytes: Uint8Array, box: IsoBox): number | null {
  const length = box.end - box.payload;
  if (length !== 4 && length < 8) {
    return null;
  }
  const quickTime = fourCharacters(bytes, box.payload + 4) === 'hdlr';
  if (length === 4) {
    // It reads those four bytes past the box, and skips version and flags only when they do not spell hdlr.
    return quickTime ? null : box.end;
  }
  return quickTime ? box.payload : box.payload + 4;
}

/** Walks every box of an ISO file and every list of boxes music-metadata reads, and returns the problem that keeps it from being read, or null. */
function walkIso(bytes: Uint8Array, view: DataView): VideoProbeResult | null {
  let parts = 0;
  let entries = 0;
  const pending: Array<Region & {readonly items: boolean}> = [{start: 0, end: bytes.length, depth: 1, items: false}];
  for (let region = pending.pop(); region !== undefined; region = pending.pop()) {
    let at = region.start;
    while (at < region.end) {
      const box = isoBox(bytes, view, at, region.end, region.depth === 1);
      if (box === 'short') {
        return unreadable(overrun(bytes, region.end));
      }
      if (box === 'invalid') {
        return unreadable(MALFORMED);
      }
      if (ISO_FRAGMENTS.has(box.type)) {
        return fragmented();
      }
      const held = isoEntries(bytes, view, box);
      if (held === null) {
        return unreadable(MALFORMED);
      }
      parts += 1;
      entries += held;
      if (parts > VIDEO_MAX_PARTS) {
        return unreadable(TOO_MANY_PARTS);
      }
      if (entries > VIDEO_MAX_ENTRIES) {
        return unreadable(TOO_MANY_ENTRIES);
      }
      // A metadata list's children are lists themselves, whatever their type.
      if (region.items || ISO_CONTAINERS.has(box.type)) {
        const first = box.type === 'meta' ? metaChildren(bytes, box) : box.payload;
        if (first === null || region.depth >= VIDEO_MAX_DEPTH) {
          return unreadable(MALFORMED);
        }
        pending.push({start: first, end: box.end, depth: region.depth + 1, items: ISO_ITEM_LISTS.has(box.type)});
      }
      at = box.end;
    }
  }
  return null;
}

function admitMp4(bytes: Uint8Array): Admission {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The `ftyp` box names the file's kind; while it is not whole, nothing does.
  const first = isoBox(bytes, view, 0, bytes.length, true);
  const fileType = typeof first === 'object' ? fileTypeBrands(bytes, first) : null;
  if (fileType === null) {
    return refuse(notAVideo());
  }
  // A 3GPP file is one whatever else it claims to be, as the format detector
  // music-metadata once relied on judged it (D92).
  if (fileType.major.startsWith('3g')) {
    return refuse(notAVideo('a 3GPP file'));
  }
  const container = containerOf(fileType.brands.join('/'));
  if (container.kind !== 'mp4') {
    return refuse(notAVideo(container.kind === 'other' ? container.name : undefined));
  }
  const fault = walkIso(bytes, view);
  return fault === null ? {ok: true, mediaType: 'video/mp4'} : refuse(fault);
}

/**
 * Decides whether music-metadata may read a file (D190): a WebM or MP4 file
 * whose every part it will read was walked and found in bounds. Returns the
 * media type to give it, or the R16 problem that keeps it from being read.
 */
export function admitVideo(bytes: Uint8Array): Admission {
  if (bytes.length >= 4 && EBML_MAGIC.every((value, index) => bytes[index] === value)) {
    return admitWebm(bytes);
  }
  if (fourCharacters(bytes, 4) === 'ftyp') {
    return admitMp4(bytes);
  }
  return refuse(notAVideo());
}

// ---------------------------------------------------------------------------
// The reader

/** The ISO brands that make a file MP4 (ISO/IEC 14496-14 and the base format it builds on). */
const MP4_BRANDS: ReadonlySet<string> = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9', 'mp41', 'mp42', 'avc1', 'dash', 'M4V']);

type Container = {readonly kind: 'mp4' | 'webm'} | {readonly kind: 'other'; readonly name: string};

/**
 * What a container string says the file is: `EBML/<doctype>` for Matroska and
 * WebM, the `ftyp` brands joined by `/` for an ISO file, as music-metadata
 * writes it.
 */
function containerOf(container: string | undefined): Container {
  if (container === undefined || container === '') {
    return {kind: 'other', name: 'a file whose container could not be named'};
  }
  if (container.startsWith('EBML/')) {
    const docType = container.slice('EBML/'.length);
    if (docType === 'webm') {
      return {kind: 'webm'};
    }
    // The document type is the file's own bytes, shown as D175 shows an author's value.
    return {kind: 'other', name: docType === 'matroska' ? 'a Matroska file' : `an EBML file of type ${quoteValue(docType, 'none')}`};
  }
  const brands = container.split('/');
  if (brands.some((brand) => MP4_BRANDS.has(brand))) {
    return {kind: 'mp4'};
  }
  // The brands are the file's own bytes, as many as its ftyp box lists within the admission's bound (D175, D190).
  return {kind: 'other', name: brands[0] === 'qt' ? 'a QuickTime movie' : `a ${quoteValue(container, 'none')} file`};
}

async function read(bytes: Uint8Array, mediaType: string): Promise<{readonly metadata: IAudioMetadata} | {readonly failure: VideoProbeResult}> {
  try {
    // The media type admission found picks the parser: music-metadata never guesses one (D190).
    return {metadata: await parseBuffer(bytes, mediaType, {duration: true, skipCovers: true})};
  } catch (error) {
    // What it still trips on is told in Papeleria's words, never the library's (F8).
    return {failure: unreadable(error instanceof Error && error.name === 'EndOfStreamError' ? RUNS_PAST_FILE : MALFORMED)};
  }
}

/**
 * Reads a video's container, tracks and duration from its bytes (IC04). A
 * video that passes carries its duration in seconds; every other outcome is
 * an R16 problem.
 */
export async function probeVideo(bytes: Uint8Array): Promise<VideoProbeResult> {
  const admitted = admitVideo(bytes);
  if (!admitted.ok) {
    return admitted.failure;
  }
  const result = await read(bytes, admitted.mediaType);
  if ('failure' in result) {
    return result.failure;
  }
  const {format} = result.metadata;
  const container = containerOf(format.container);
  if (container.kind === 'other') {
    return notAVideo(container.name);
  }
  if (format.hasVideo !== true) {
    return problem('no_video_track', 'The file holds no video track.', 'A video block shows a silent loop: export it as MP4 or WebM with its picture. For sound alone, link to the file instead.');
  }

  let duration: number | undefined;
  if (container.kind === 'webm') {
    duration = format.duration;
  } else {
    const header = readMovieHeader(bytes);
    if (header === null) {
      return problem('unknown_duration', 'The MP4 file has no readable movie header, so its duration is unknown.', `${EXPORT_AGAIN} The file may be truncated or damaged.`);
    }
    // Whatever its movie header says, and whatever an audio track's fragments add up to: the picture may run longer.
    if (isFragmentedMovie(bytes)) {
      return fragmented();
    }
    if (header.duration === null || header.timescale === 0) {
      return problem('unknown_duration', 'The MP4 file does not state its duration.', EXPORT_AGAIN);
    }
    duration = header.duration / header.timescale;
    // music-metadata's figure is an audio track's length; the movie is never shorter.
    if (typeof format.duration === 'number' && format.duration > duration) {
      duration = format.duration;
    }
  }

  if (duration === undefined) {
    return problem('unknown_duration', 'The WebM file does not state its duration, as a recording saved while it was made often does not.', EXPORT_AGAIN);
  }
  if (!Number.isFinite(duration)) {
    return problem('non_finite_duration', 'The video states a duration that is not a finite number.', EXPORT_AGAIN);
  }
  if (duration <= 0) {
    return problem('zero_duration', duration === 0 ? 'The video states a duration of zero.' : 'The video states a negative duration.', EXPORT_AGAIN);
  }
  if (duration > VIDEO_MAX_SECONDS) {
    return problem(
      'too_long',
      `The video is ${formatSeconds(duration)} long; a video loop is at most ${VIDEO_MAX_SECONDS} seconds.`,
      'Trim the loop to 15 seconds or less, or link to the full video instead of embedding it.',
    );
  }
  return {ok: true, probe: {duration}};
}
