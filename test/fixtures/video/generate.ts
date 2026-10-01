/**
 * M3.4 video fixtures (DEP04), written byte by byte at test time: no binary
 * is committed and no encoder runs (README.md beside this file, D93).
 *
 * `mp4Source` writes an ISO base media file — `ftyp`, `moov` with `mvhd` and
 * one `trak` per track, and `mdat`, or for a fragmented movie `mvex` in
 * `moov` and the samples in a `moof` and `mdat` after it — and `webmSource`
 * an EBML file — the EBML
 * header, then a Segment with `Info`, `Tracks` and one `Cluster`. The
 * containers are exact, since they are what the video reader measures; the
 * frames inside are placeholders, not pictures a decoder could show: an
 * `avc1` sample of four zero bytes behind an `avcC` record with no parameter
 * sets, and a VP8 key-frame tag and start code with no partition data.
 * Every builder is deterministic: the same options give the same bytes.
 */
import {Buffer} from 'node:buffer';

// ---------------------------------------------------------------------------
// ISO base media file format (ISO/IEC 14496-12)

function u8(value: number): Buffer {
  return Buffer.from([value & 0xff]);
}

function u16(value: number): Buffer {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value);
  return bytes;
}

function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value >>> 0);
  return bytes;
}

function u64(value: bigint): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(value);
  return bytes;
}

function ascii(text: string): Buffer {
  return Buffer.from(text, 'latin1');
}

/** A box: a 32-bit size, a four-character type, the payload. */
function box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  return Buffer.concat([u32(8 + body.length), ascii(type), body]);
}

/** A full box: a box whose payload starts with a version byte and 24 bits of flags. */
function fullBox(type: string, version: number, flags: number, ...payload: Buffer[]): Buffer {
  return box(type, u8(version), u8(flags >> 16), u8(flags >> 8), u8(flags), ...payload);
}

/** The identity transformation matrix of `mvhd` and `tkhd`. */
const MATRIX = Buffer.concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);

export type Mp4Track = {
  readonly kind: 'video' | 'audio';
  /** The track's own length in seconds; the movie's by default. */
  readonly seconds?: number;
};

export type Mp4Options = {
  /** `mvhd` time units per second. */
  readonly timescale?: number;
  /** The movie's length in seconds, written as `round(seconds × timescale)` units. */
  readonly seconds?: number;
  /** `mvhd`'s duration field as written, in time units, instead of `seconds`. */
  readonly durationUnits?: number | bigint;
  /** Writes the all-ones duration ISO/IEC 14496-12 uses for "unknown". */
  readonly unknownDuration?: boolean;
  /** `mvhd` version: 0 writes 32-bit times and duration, 1 writes 64-bit ones. */
  readonly mvhdVersion?: 0 | 1;
  /** Leaves `mvhd` out of `moov`. */
  readonly withoutMovieHeader?: boolean;
  /** The major brand, then the compatible brands, four characters each. */
  readonly brands?: readonly string[];
  readonly tracks?: readonly Mp4Track[];
  /** Writes `mdat` before `moov`, as a file not prepared for streaming has it. */
  readonly movieAfterData?: boolean;
  /** Writes `mdat` with a 64-bit size (`size` 1 and a `largesize`). */
  readonly largeDataBox?: boolean;
  /** Writes `mdat` last with size 0: "to the end of the file". */
  readonly dataBoxToEnd?: boolean;
  /**
   * Adds a title in `moov/udta/meta/ilst`, as tools write one: `meta` a full
   * box with version and flags (ISO), or a plain box whose first child is
   * `hdlr` (QuickTime).
   */
  readonly metadata?: 'iso' | 'quicktime';
  /** Adds `mvex`, with a `mehd` and a `trex` per track, to `moov`, which makes the movie a fragmented one; the samples stay in `mdat`. */
  readonly fragmented?: boolean;
  /**
   * Writes a fragmented movie (ISO/IEC 14496-12 §8.8), as a recorder that
   * streams does: `moov` holds `mvex`, with a `trex` per track, and sample
   * tables with no samples, and each track's one sample follows in a `moof`
   * and its `mdat`, lasting this many seconds. `mvhd` still says what
   * `seconds` or `durationUnits` says: 0 for the usual empty `moov`.
   */
  readonly fragmentSeconds?: number;
};

/** Four bytes of frame data: a placeholder sample, not a decodable picture. */
const PLACEHOLDER_SAMPLE = Buffer.from([0, 0, 0, 0]);

function units(seconds: number, timescale: number): number {
  return Math.round(seconds * timescale);
}

function movieHeader(options: Required<Pick<Mp4Options, 'timescale' | 'mvhdVersion'>>, duration: bigint, tracks: number): Buffer {
  const tail = Buffer.concat([u32(0x00010000), u16(0x0100), Buffer.alloc(10), MATRIX, Buffer.alloc(24), u32(tracks + 1)]);
  if (options.mvhdVersion === 1) {
    return fullBox('mvhd', 1, 0, u64(0n), u64(0n), u32(options.timescale), u64(duration), tail);
  }
  return fullBox('mvhd', 0, 0, u32(0), u32(0), u32(options.timescale), u32(Number(duration)), tail);
}

function videoSampleEntry(): Buffer {
  // AVCDecoderConfigurationRecord: version 1, Baseline profile, level 3.0,
  // 4-byte lengths, and no parameter sets: the frames are placeholders.
  const avcC = box('avcC', Buffer.from([1, 0x42, 0xc0, 0x1e, 0xff, 0xe0, 0x00]));
  return box(
    'avc1',
    Buffer.alloc(6),
    u16(1),
    Buffer.alloc(16),
    u16(64),
    u16(36),
    u32(0x00480000),
    u32(0x00480000),
    u32(0),
    u16(1),
    Buffer.alloc(32),
    u16(0x0018),
    u16(0xffff),
    avcC,
  );
}

function audioSampleEntry(): Buffer {
  // AudioSampleEntry: two channels, 16-bit, 48 kHz, no decoder configuration.
  return box('mp4a', Buffer.alloc(6), u16(1), Buffer.alloc(8), u16(2), u16(16), u16(0), u16(0), u32(48_000 << 16));
}

/** A track; `chunkOffset` null writes sample tables with no samples, which a fragmented movie's fragments hold. */
function track(kind: Mp4Track['kind'], id: number, timescale: number, seconds: number, chunkOffset: number | null): Buffer {
  const mediaTimescale = kind === 'audio' ? 48_000 : timescale;
  const mediaDuration = units(seconds, mediaTimescale);
  const trackHeader = fullBox(
    'tkhd',
    0,
    3,
    u32(0),
    u32(0),
    u32(id),
    u32(0),
    u32(units(seconds, timescale)),
    Buffer.alloc(8),
    u16(0),
    u16(0),
    u16(kind === 'audio' ? 0x0100 : 0),
    u16(0),
    MATRIX,
    u32(kind === 'video' ? 64 << 16 : 0),
    u32(kind === 'video' ? 36 << 16 : 0),
  );
  const mediaHeader = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(mediaTimescale), u32(mediaDuration), u16(0x55c4), u16(0));
  const handler = fullBox('hdlr', 0, 0, u32(0), ascii(kind === 'video' ? 'vide' : 'soun'), Buffer.alloc(12), ascii(kind === 'video' ? 'VideoHandler\0' : 'SoundHandler\0'));
  const mediaInformationHeader = kind === 'video' ? fullBox('vmhd', 0, 1, Buffer.alloc(8)) : fullBox('smhd', 0, 0, Buffer.alloc(4));
  const dataInformation = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
  const sampleDescription = fullBox('stsd', 0, 0, u32(1), kind === 'video' ? videoSampleEntry() : audioSampleEntry());
  const sampleTable =
    chunkOffset === null
      ? box('stbl', sampleDescription, fullBox('stts', 0, 0, u32(0)), fullBox('stsc', 0, 0, u32(0)), fullBox('stsz', 0, 0, u32(0), u32(0)), fullBox('stco', 0, 0, u32(0)))
      : box(
          'stbl',
          sampleDescription,
          fullBox('stts', 0, 0, u32(1), u32(1), u32(mediaDuration)),
          fullBox('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1)),
          fullBox('stsz', 0, 0, u32(0), u32(1), u32(PLACEHOLDER_SAMPLE.length)),
          fullBox('stco', 0, 0, u32(1), u32(chunkOffset)),
        );
  return box('trak', trackHeader, box('mdia', mediaHeader, handler, box('minf', mediaInformationHeader, dataInformation, sampleTable)));
}

/** `udta/meta/ilst` holding one title, `©nam`, as a UTF-8 `data` value. */
function userData(kind: 'iso' | 'quicktime'): Buffer {
  const handler = fullBox('hdlr', 0, 0, u32(0), ascii('mdir'), ascii('appl'), Buffer.alloc(9));
  const title = box('©nam', box('data', u32(1), u32(0), ascii('papeleria test fixture')));
  const children = [handler, box('ilst', title)];
  return box('udta', kind === 'iso' ? fullBox('meta', 0, 0, ...children) : box('meta', ...children));
}

function dataBox(options: Mp4Options, samples: number): Buffer {
  const payload = Buffer.concat(Array.from({length: samples}, () => PLACEHOLDER_SAMPLE));
  if (options.largeDataBox === true) {
    return Buffer.concat([u32(1), ascii('mdat'), u64(BigInt(16 + payload.length)), payload]);
  }
  if (options.dataBoxToEnd === true) {
    return Buffer.concat([u32(0), ascii('mdat'), payload]);
  }
  return box('mdat', payload);
}

/**
 * `mvex`: the movie continues in fragments. One `trex` per track, with no
 * sample defaults, after a `mehd` giving the fragments' duration when one is.
 */
function movieExtends(tracks: number, duration?: bigint): Buffer {
  const header = duration === undefined ? [] : [fullBox('mehd', 0, 0, u32(Number(duration)))];
  return box('mvex', ...header, ...Array.from({length: tracks}, (_, index) => fullBox('trex', 0, 0, u32(index + 1), u32(1), u32(0), u32(0), u32(0))));
}

/**
 * One movie fragment (ISO/IEC 14496-12 §8.8.4): a `moof` whose `traf` per
 * track runs one sample of `seconds`, then the `mdat` holding the samples.
 * Each run's data offset counts from the start of the `moof`.
 */
function movieFragment(tracks: readonly Mp4Track[], timescale: number, seconds: number): Buffer {
  const fragment = (dataStart: number): Buffer =>
    box(
      'moof',
      fullBox('mfhd', 0, 0, u32(1)),
      ...tracks.map((each, index) =>
        box(
          'traf',
          // default-base-is-moof.
          fullBox('tfhd', 0, 0x02_0000, u32(index + 1)),
          fullBox('tfdt', 1, 0, u64(0n)),
          // data-offset, sample-duration and sample-size present.
          fullBox(
            'trun',
            0,
            0x00_0301,
            u32(1),
            u32(dataStart + index * PLACEHOLDER_SAMPLE.length),
            u32(units(seconds, each.kind === 'audio' ? 48_000 : timescale)),
            u32(PLACEHOLDER_SAMPLE.length),
          ),
        ),
      ),
    );
  const samples = box('mdat', ...tracks.map(() => PLACEHOLDER_SAMPLE));
  return Buffer.concat([fragment(fragment(0).length + 8), samples]);
}

/**
 * A silent MP4 by default: one `avc1` video track and no audio, one second
 * long at a timescale of 1,000, `moov` before `mdat`.
 */
export function mp4Source(options: Mp4Options = {}): Uint8Array {
  const timescale = options.timescale ?? 1000;
  const mvhdVersion = options.mvhdVersion ?? 0;
  const seconds = options.seconds ?? 1;
  const tracks = options.tracks ?? [{kind: 'video'}];
  const allOnes = mvhdVersion === 1 ? 0xffff_ffff_ffff_ffffn : 0xffff_ffffn;
  const duration = options.unknownDuration === true ? allOnes : BigInt(options.durationUnits ?? units(seconds, timescale));
  const brands = options.brands ?? ['isom', 'iso2', 'avc1', 'mp41'];
  const fileType = box('ftyp', ascii(brands[0]!), u32(512), ...brands.slice(1).map(ascii));

  // Each track has one sample, and the samples follow one another in mdat;
  // `stco` points each track at its own. Offsets are fixed-width, so the
  // movie box is as long whatever they are.
  const fragmented = options.fragmentSeconds !== undefined;
  const movie = (firstSample: number): Buffer =>
    box(
      'moov',
      ...(options.withoutMovieHeader === true ? [] : [movieHeader({timescale, mvhdVersion}, duration, tracks.length)]),
      ...tracks.map((each, index) =>
        track(each.kind, index + 1, timescale, each.seconds ?? seconds, fragmented ? null : firstSample + index * PLACEHOLDER_SAMPLE.length),
      ),
      ...(fragmented ? [movieExtends(tracks.length)] : options.fragmented === true ? [movieExtends(tracks.length, duration)] : []),
      ...(options.metadata === undefined ? [] : [userData(options.metadata)]),
    );
  if (options.fragmentSeconds !== undefined) {
    return new Uint8Array(Buffer.concat([fileType, movie(0), movieFragment(tracks, timescale, options.fragmentSeconds)]));
  }
  const data = dataBox(options, tracks.length);
  const dataHeader = data.length - tracks.length * PLACEHOLDER_SAMPLE.length;
  const dataFirst = options.movieAfterData === true && options.dataBoxToEnd !== true;
  const parts = dataFirst
    ? [fileType, data, movie(fileType.length + dataHeader)]
    : [fileType, movie(fileType.length + movie(0).length + dataHeader), data];
  return new Uint8Array(Buffer.concat(parts));
}

// ---------------------------------------------------------------------------
// EBML and WebM (RFC 8794, the Matroska and WebM specifications)

/**
 * An element's size as an 8-byte variable-length integer, which every EBML
 * reader accepts; null writes all ones, "unknown" (RFC 8794 §6.2).
 */
export function ebmlSize(length: number | null): Buffer {
  if (length === null) {
    return Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  }
  const bytes = Buffer.alloc(8);
  bytes[0] = 0x01;
  let rest = BigInt(length);
  for (let index = 7; index >= 1; index -= 1) {
    bytes[index] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return bytes;
}

function element(idHex: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  return Buffer.concat([Buffer.from(idHex, 'hex'), ebmlSize(body.length), body]);
}

/** An element of unknown size, which runs to the end of the one that holds it. */
function openElement(idHex: string, ...payload: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from(idHex, 'hex'), ebmlSize(null), ...payload]);
}

function uint(value: number, length: number): Buffer {
  const bytes = Buffer.alloc(length);
  bytes.writeUIntBE(value, 0, length);
  return bytes;
}

function float64(value: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeDoubleBE(value);
  return bytes;
}

export type WebmOptions = {
  /** The Segment's `Duration` in `TimecodeScale` units (milliseconds by default); null leaves it out. */
  readonly duration?: number | null;
  /** Nanoseconds per `Duration` unit. */
  readonly timecodeScale?: number;
  /** `webm`, or `matroska` for a Matroska file that is not WebM. */
  readonly docType?: string;
  readonly tracks?: readonly ('video' | 'audio')[];
  /**
   * Writes the Segment's and the Cluster's sizes as unknown, eight bytes of
   * ones, as a recorder that writes while it records does; the Duration a tool
   * adds afterwards stays.
   */
  readonly unknownSizes?: boolean;
};

/** A VP8 key-frame tag, start code and 64 × 36 size with no partition data: a placeholder, not a picture. */
const VP8_PLACEHOLDER = Buffer.from([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, 0x40, 0x00, 0x24, 0x00]);

function trackEntry(kind: 'video' | 'audio', number: number): Buffer {
  const detail =
    kind === 'video'
      ? element('e0', element('b0', uint(64, 2)), element('ba', uint(36, 2)))
      : element('e1', element('b5', float64(48_000)), element('9f', uint(2, 1)));
  return element(
    'ae',
    element('d7', uint(number, 1)),
    element('73c5', uint(number, 1)),
    element('83', uint(kind === 'video' ? 1 : 2, 1)),
    element('86', ascii(kind === 'video' ? 'V_VP8' : 'A_OPUS')),
    detail,
  );
}

/**
 * A silent WebM by default: one `V_VP8` video track and no audio, with a
 * `Duration` of 1,000 ms at the default `TimecodeScale`.
 */
export function webmSource(options: WebmOptions = {}): Uint8Array {
  const tracks = options.tracks ?? ['video'];
  const header = element(
    '1a45dfa3',
    element('4286', uint(1, 1)),
    element('42f7', uint(1, 1)),
    element('42f2', uint(4, 1)),
    element('42f3', uint(8, 1)),
    element('4282', ascii(options.docType ?? 'webm')),
    element('4287', uint(4, 1)),
    element('4285', uint(2, 1)),
  );
  const duration = options.duration === undefined ? 1000 : options.duration;
  const info = element(
    '1549a966',
    element('2ad7b1', uint(options.timecodeScale ?? 1_000_000, 4)),
    ...(duration === null ? [] : [element('4489', float64(duration))]),
    element('4d80', ascii('papeleria test fixture')),
    element('5741', ascii('papeleria test fixture')),
  );
  const blocks = tracks.map((kind, index) =>
    element('a3', u8(0x80 | (index + 1)), u16(0), u8(0x80), kind === 'video' ? VP8_PLACEHOLDER : Buffer.from([0xfc, 0xff, 0xfe])),
  );
  const open = options.unknownSizes === true ? openElement : element;
  const cluster = open('1f43b675', element('e7', uint(0, 1)), ...blocks);
  const segment = open('18538067', info, element('1654ae6b', ...tracks.map((kind, index) => trackEntry(kind, index + 1))), cluster);
  return new Uint8Array(Buffer.concat([header, segment]));
}

// ---------------------------------------------------------------------------
// Damage

/** The first `length` bytes of a file, as a copy cut off in transfer would hold. */
export function truncated(bytes: Uint8Array, length: number): Uint8Array {
  return bytes.slice(0, length);
}

/** Bytes that are no media format: a fixed pseudo-random sequence. */
export function garbage(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = 0x2545f491;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes;
}
