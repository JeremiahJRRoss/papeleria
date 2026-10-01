/**
 * M3.4 and DEP04: the video reader (`src/core/video.ts`, D92) on silent MP4
 * and WebM files written at test time (test/fixtures/video/, D93).
 *
 * A silent video of 15 seconds or less passes in both containers, the limit
 * included; 16 seconds, 15.001 seconds, zero, an unknown or non-finite
 * duration, a truncated or foreign file, a container that is neither MP4 nor
 * WebM and a file without a video track are each one R16 problem with a null
 * line. An MP4's duration is its movie header's, which music-metadata 11.15
 * does not read for a file without an audio track; the table the first test
 * prints is the DEP04 record: what music-metadata says, and what the reader
 * decides.
 *
 * music-metadata reads only a file the reader admitted (D190): the tests at
 * the end hold the files that made it reserve gigabytes, loop without end or
 * backtrack for minutes (security audit F8, F20) to a refusal before it runs.
 */
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';

import {parseBuffer} from 'music-metadata';

import {
  admitVideo,
  createMemoryLoaders,
  createNodeLoaders,
  EBML_ELEMENTS,
  formatSeconds,
  isFragmentedMovie,
  probeVideo,
  probeVideoUnavailable,
  readMovieHeader,
  VIDEO_MAX_ENTRIES,
  VIDEO_MAX_PARTS,
  VIDEO_MAX_SECONDS,
  type VideoProblemCode,
} from '../../src/core/index.js';
import {pngSource} from '../fixtures/images/generate.js';
import {ebmlSize, garbage, mp4Source, truncated, webmSource} from '../fixtures/video/generate.js';
import {applicationRoot} from '../helpers/paths.js';

type Expected = {readonly duration: number} | {readonly code: VideoProblemCode};

/** DEP04's cases (DEPENDENCIES): each fixture and what the reader must decide. */
const CASES: readonly (readonly [label: string, bytes: () => Promise<Uint8Array> | Uint8Array, expected: Expected])[] = [
  ['MP4, silent, 1 s', () => mp4Source(), {duration: 1}],
  ['MP4, silent, 15.000 s (the limit)', () => mp4Source({seconds: 15}), {duration: 15}],
  ['MP4, silent, 14.999 s', () => mp4Source({seconds: 14.999}), {duration: 14.999}],
  ['MP4, silent, 15.001 s', () => mp4Source({seconds: 15.001}), {code: 'too_long'}],
  ['MP4, silent, 16 s', () => mp4Source({seconds: 16}), {code: 'too_long'}],
  ['MP4, silent, zero', () => mp4Source({seconds: 0}), {code: 'zero_duration'}],
  ['MP4, silent, unknown (all ones)', () => mp4Source({unknownDuration: true}), {code: 'unknown_duration'}],
  ['MP4, silent, mvhd version 1, 12 s', () => mp4Source({seconds: 12, mvhdVersion: 1}), {duration: 12}],
  ['MP4, silent, mvhd version 1, unknown', () => mp4Source({unknownDuration: true, mvhdVersion: 1}), {code: 'unknown_duration'}],
  ['MP4, silent, 90,000 Hz timescale, 15 s', () => mp4Source({seconds: 15, timescale: 90_000}), {duration: 15}],
  ['MP4, silent, timescale 0', () => mp4Source({timescale: 0, durationUnits: 1000}), {code: 'unknown_duration'}],
  ['MP4, silent, timescale 0 and duration 0', () => mp4Source({timescale: 0, durationUnits: 0}), {code: 'unknown_duration'}],
  ['MP4, silent, no movie header', () => mp4Source({withoutMovieHeader: true}), {code: 'unknown_duration'}],
  // Fragmented (W5R-23): the movie header counts only what moov holds, never the fragments after it.
  ['MP4, fragmented, empty moov (mvhd 0), 3 s in fragments', () => mp4Source({seconds: 0, fragmentSeconds: 3}), {code: 'unknown_duration'}],
  ['MP4, fragmented, mvhd 3 s, 60 s in fragments', () => mp4Source({seconds: 3, fragmentSeconds: 60}), {code: 'unknown_duration'}],
  ['MP4, fragmented, timescale 0', () => mp4Source({seconds: 0, timescale: 0, fragmentSeconds: 3}), {code: 'unknown_duration'}],
  [
    'MP4, fragmented, with an audio track music-metadata measures from its fragments',
    () => mp4Source({seconds: 0, fragmentSeconds: 5, tracks: [{kind: 'video'}, {kind: 'audio'}]}),
    {code: 'unknown_duration'},
  ],
  ['MP4, silent, moov after mdat, 3 s', () => mp4Source({seconds: 3, movieAfterData: true}), {duration: 3}],
  ['MP4, silent, 64-bit mdat size, 3 s', () => mp4Source({seconds: 3, movieAfterData: true, largeDataBox: true}), {duration: 3}],
  ['MP4, silent, mdat to the end of the file, 3 s', () => mp4Source({seconds: 3, dataBoxToEnd: true}), {duration: 3}],
  ['MP4, with an audio track, 5 s', () => mp4Source({seconds: 5, tracks: [{kind: 'video'}, {kind: 'audio'}]}), {duration: 5}],
  ['MP4, audio track longer than the movie header says', () => mp4Source({seconds: 5, tracks: [{kind: 'video'}, {kind: 'audio', seconds: 20}]}), {code: 'too_long'}],
  ['MP4 audio only (M4A)', () => mp4Source({brands: ['M4A ', 'isom', 'mp42'], tracks: [{kind: 'audio'}]}), {code: 'no_video_track'}],
  ['MP4, silent, 2 s, a title in udta/meta/ilst written the ISO way', () => mp4Source({seconds: 2, metadata: 'iso'}), {duration: 2}],
  ['MP4, silent, 2 s, a title in udta/meta/ilst written the QuickTime way', () => mp4Source({seconds: 2, metadata: 'quicktime'}), {duration: 2}],
  ['MP4, fragmented (mvex)', () => mp4Source({fragmented: true}), {code: 'unknown_duration'}],
  ['QuickTime movie', () => mp4Source({brands: ['qt  ']}), {code: 'unsupported_container'}],
  ['3GPP file', () => mp4Source({brands: ['3gp4']}), {code: 'unsupported_container'}],
  ['MP4, truncated in its movie box', () => truncated(mp4Source(), 200), {code: 'unreadable'}],
  ['WebM, silent, 1 s', () => webmSource(), {duration: 1}],
  ['WebM, silent, 15.000 s (the limit)', () => webmSource({duration: 15_000}), {duration: 15}],
  ['WebM, silent, 15.001 s', () => webmSource({duration: 15_001}), {code: 'too_long'}],
  ['WebM, silent, 16 s', () => webmSource({duration: 16_000}), {code: 'too_long'}],
  ['WebM, silent, zero', () => webmSource({duration: 0}), {code: 'zero_duration'}],
  ['WebM, silent, negative', () => webmSource({duration: -5}), {code: 'zero_duration'}],
  ['WebM, silent, no Duration element (unknown)', () => webmSource({duration: null}), {code: 'unknown_duration'}],
  ['WebM, silent, Duration NaN', () => webmSource({duration: Number.NaN}), {code: 'non_finite_duration'}],
  ['WebM, silent, Duration +∞', () => webmSource({duration: Number.POSITIVE_INFINITY}), {code: 'non_finite_duration'}],
  ['WebM, silent, 1 µs TimecodeScale, 15 s', () => webmSource({duration: 15_000_000, timecodeScale: 1000}), {duration: 15}],
  ['WebM audio only', () => webmSource({tracks: ['audio']}), {code: 'no_video_track'}],
  ['WebM with video and audio, 1 s', () => webmSource({tracks: ['video', 'audio']}), {duration: 1}],
  ['WebM, Segment and Cluster of unknown size as a recorder writes them, 1 s', () => webmSource({unknownSizes: true}), {duration: 1}],
  ['Matroska, not WebM', () => webmSource({docType: 'matroska'}), {code: 'unsupported_container'}],
  ['WebM, truncated in its header', () => truncated(webmSource(), 30), {code: 'unsupported_container'}],
  ['Bytes of no media format', () => garbage(4096), {code: 'unsupported_container'}],
  ['An empty file', () => new Uint8Array(0), {code: 'unsupported_container'}],
  ['A PNG image', async () => new Uint8Array(await pngSource(8, 8)), {code: 'unsupported_container'}],
];

test('DEP04: silent MP4 and WebM at 15 seconds or less pass; longer, zero, unknown, damaged and foreign files are R16', async (context) => {
  for (const [label, make, expected] of CASES) {
    const bytes = await make();
    let library: string;
    try {
      const {format} = await parseBuffer(bytes, undefined, {duration: true, skipCovers: true});
      const tracks = (format.trackInfo ?? []).map((track) => track.codecName).join(', ');
      library = `container ${format.container ?? '—'}, codec ${format.codec ?? '—'}, tracks ${tracks || '—'}, duration ${format.duration ?? 'none'}`;
    } catch (error) {
      library = `throws ${(error as Error).name}`;
    }
    const result = await probeVideo(bytes);
    context.diagnostic(`${label} | music-metadata: ${library} | reader: ${result.ok ? `passes, ${result.probe.duration} s` : `${result.problem.code}: ${result.problem.message}`}`);
    if ('duration' in expected) {
      assert.ok(result.ok, `${label}: ${result.ok ? '' : result.problem.message}`);
      assert.equal(result.probe.duration, expected.duration, label);
    } else {
      assert.ok(!result.ok, `${label} passed`);
      assert.deepEqual([result.problem.code, result.problem.rule, result.problem.line], [expected.code, 'R16', null], label);
      assert.ok(result.problem.message.length > 0 && result.problem.fix.length > 0, label);
      assert.doesNotMatch(result.problem.message, /assets\//, 'the finding names the file; the message does not');
    }
  }
});

test('D92: music-metadata 11.15 gives a silent MP4 no duration, which is why the movie header is read', async () => {
  const {format} = await parseBuffer(mp4Source({seconds: 7}), undefined, {duration: true, skipCovers: true});
  assert.equal(format.duration, undefined, 'if this fails, music-metadata has learned to measure video tracks: revisit D92');
  assert.equal(format.hasVideo, true);
  assert.deepEqual(readMovieHeader(mp4Source({seconds: 7})), {version: 0, timescale: 1000, duration: 7000});
});

test('the limit is inclusive and exact: 15 seconds pass, anything above fails', async () => {
  assert.equal(VIDEO_MAX_SECONDS, 15);
  for (const [timescale, units, passes] of [
    [1000, 15_000, true],
    [1000, 15_001, false],
    [30_000, 450_000, true],
    [30_000, 450_001, false],
    [1, 15, true],
    [1, 16, false],
  ] as const) {
    const result = await probeVideo(mp4Source({timescale, durationUnits: units}));
    assert.equal(result.ok, passes, `${units} / ${timescale}`);
  }
});

test('the movie header: versions 0 and 1, unknown, and every box that cannot be one', () => {
  assert.deepEqual(readMovieHeader(mp4Source({seconds: 2.5})), {version: 0, timescale: 1000, duration: 2500});
  assert.deepEqual(readMovieHeader(mp4Source({seconds: 2.5, mvhdVersion: 1, timescale: 90_000})), {version: 1, timescale: 90_000, duration: 225_000});
  assert.deepEqual(readMovieHeader(mp4Source({unknownDuration: true})), {version: 0, timescale: 1000, duration: null});
  assert.deepEqual(readMovieHeader(mp4Source({unknownDuration: true, mvhdVersion: 1})), {version: 1, timescale: 1000, duration: null});
  assert.equal(readMovieHeader(mp4Source({withoutMovieHeader: true})), null);
  assert.equal(readMovieHeader(new Uint8Array(0)), null);
  assert.equal(readMovieHeader(garbage(1024)), null);
  assert.equal(readMovieHeader(webmSource()), null, 'an EBML file has no boxes');
  // A box that claims more bytes than the file has, or fewer than its own header.
  const bytes = mp4Source();
  const shortened = Uint8Array.from(bytes);
  new DataView(shortened.buffer).setUint32(0, 4);
  assert.equal(readMovieHeader(shortened), null);
  assert.equal(readMovieHeader(truncated(bytes, bytes.length - 1)), null);
  // A header of a version the format does not define.
  const moov = Buffer.from(bytes).indexOf('mvhd');
  const version2 = Uint8Array.from(bytes);
  version2[moov + 4] = 2;
  assert.equal(readMovieHeader(version2), null);
});

test('a fragmented MP4 is refused as fragmented, whatever its movie header says (W5R-23)', async () => {
  const empty = mp4Source({seconds: 0, fragmentSeconds: 3});
  assert.equal(isFragmentedMovie(empty), true);
  assert.equal(isFragmentedMovie(mp4Source({seconds: 3})), false);
  assert.equal(isFragmentedMovie(garbage(1024)), false);
  // The movie header is read as ever: 0 in the usual empty moov, which once read as "a duration of zero".
  assert.deepEqual(readMovieHeader(empty), {version: 0, timescale: 1000, duration: 0});
  for (const bytes of [empty, mp4Source({seconds: 3, fragmentSeconds: 60})]) {
    const result = await probeVideo(bytes);
    assert.deepEqual(result.ok ? null : [result.problem.code, result.problem.message, result.problem.fix], [
      'unknown_duration',
      'The MP4 file is fragmented: its movie header does not count the fragments after it, so its duration is unknown.',
      'Export the loop again as a regular MP4, not a fragmented or streaming one, 15 seconds long or less, and replace the file.',
    ]);
  }
  // Every prefix of a fragmented file is decided too.
  const source = mp4Source({seconds: 0, fragmentSeconds: 3, tracks: [{kind: 'video'}, {kind: 'audio'}]});
  for (let length = 0; length <= source.length; length += 1) {
    const result = await probeVideo(truncated(source, length));
    assert.ok(!result.ok && result.problem.rule === 'R16', `${length} bytes`);
  }
});

test('the movie header is found in linear time among many boxes', () => {
  // 200,000 empty `free` boxes before the movie: each is stepped over once.
  const free = Buffer.from([0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65]);
  const movie = Buffer.from(mp4Source({seconds: 4}));
  const bytes = new Uint8Array(Buffer.concat([...Array.from({length: 200_000}, () => free), movie]));
  const started = performance.now();
  assert.deepEqual(readMovieHeader(bytes), {version: 0, timescale: 1000, duration: 4000});
  assert.ok(performance.now() - started < 2000, 'far below what a quadratic walk would take');
});

test('every prefix of a video is decided without an exception escaping', async () => {
  for (const source of [
    mp4Source({seconds: 3, tracks: [{kind: 'video'}, {kind: 'audio'}]}),
    mp4Source({seconds: 3, metadata: 'iso'}),
    webmSource({tracks: ['video', 'audio']}),
    webmSource({unknownSizes: true}),
  ]) {
    for (let length = 0; length <= source.length; length += 1) {
      const result = await probeVideo(truncated(source, length));
      if (!result.ok) {
        assert.equal(result.problem.rule, 'R16');
      }
    }
    assert.ok((await probeVideo(source)).ok, 'the whole file passes');
  }
});

test('the real reader is the one both loader factories use; the stand-in stays for tests', async () => {
  assert.equal(createNodeLoaders('.').probeVideo, probeVideo);
  assert.equal(createMemoryLoaders({}).probeVideo, probeVideo);
  const standIn = await probeVideoUnavailable(mp4Source());
  assert.deepEqual(standIn.ok ? null : [standIn.problem.code, standIn.problem.rule], ['unavailable', 'R16']);
});

test('a container named by the file\'s own brands is cut in the message, however many there are (D175)', async () => {
  // 65 distinct brands in ftyp, the major brand and the 64 compatible ones the admission lets through (D190), none of
  // them an MP4 brand: a container name of 324 characters.
  const brands = Array.from({length: 65}, (_, index) => `b${index.toString(36).padStart(3, '0')}`);
  const iso = await probeVideo(mp4Source({brands}));
  assert.ok(!iso.ok);
  assert.equal(iso.problem.code, 'unsupported_container');
  assert.match(iso.problem.message, /^The file is a b000\/b001\/[^…]+…[^…]+ \(324 characters\) file, not an MP4 or WebM video\.$/);
  assert.ok(iso.problem.message.length < 300, `${iso.problem.message.length} characters`);
  // More than that is refused before the file is read, and nothing of it is quoted.
  const more = await probeVideo(mp4Source({brands: [...brands, 'b0zz']}));
  assert.deepEqual(more.ok ? null : [more.problem.code, more.problem.message], ['unsupported_container', 'The file is not an MP4 or WebM video.']);
});

test('a duration in a message is never rounded into the limit', () => {
  assert.equal(formatSeconds(1), '1 second');
  assert.equal(formatSeconds(16), '16 seconds');
  assert.equal(formatSeconds(15.001), '15.001 seconds');
  assert.equal(formatSeconds(15.0004), '15.0004 seconds');
  assert.equal(formatSeconds(20.123456), '20.123 seconds');
});

// ---------------------------------------------------------------------------
// Admission (D190; security audit F8, F20)

function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value >>> 0);
  return bytes;
}

/** A box whose 32-bit size says `size`, whatever it holds. */
function boxOf(type: string, payload: Buffer = Buffer.alloc(0), size = 8 + payload.length): Buffer {
  return Buffer.concat([u32(size), Buffer.from(type, 'latin1'), payload]);
}

/** A box with a 64-bit size. */
function largeBox(type: string, payload: Buffer): Buffer {
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(16 + payload.length));
  return Buffer.concat([u32(1), Buffer.from(type, 'latin1'), size, payload]);
}

/** An ISO file: an MP4 `ftyp`, then the boxes given. */
function iso(...boxes: Buffer[]): Uint8Array {
  return new Uint8Array(Buffer.concat([boxOf('ftyp', Buffer.from('isom\0\0\x02\0isommp41', 'latin1')), ...boxes]));
}

/** An element whose eight-byte size says `size` (null: unknown), whatever it holds. */
function element(idHex: string, payload: Buffer = Buffer.alloc(0), size: number | null = payload.length): Buffer {
  return Buffer.concat([Buffer.from(idHex, 'hex'), ebmlSize(size), payload]);
}

/** A WebM file: an EBML header naming `webm`, then the elements given. */
function webm(...elements: Buffer[]): Uint8Array {
  return new Uint8Array(Buffer.concat([element('1a45dfa3', element('4282', Buffer.from('webm'))), ...elements]));
}

const SEGMENT = '18538067';
const INFO = '1549a966';
const TITLE = '7ba9';

/** `count` distinct four-character brands. */
function manyBrands(count: number): Buffer {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const brands = Buffer.alloc(count * 4);
  for (let index = 0; index < count; index += 1) {
    for (let place = 0, rest = index; place < 4; place += 1, rest = Math.floor(rest / alphabet.length)) {
      brands[index * 4 + place] = alphabet.charCodeAt(rest % alphabet.length);
    }
  }
  return brands;
}

/** Tags inside Tags, `depth` deep. */
function nestedTags(depth: number): Buffer {
  let inner: Buffer = Buffer.alloc(0);
  for (let level = 0; level < depth; level += 1) {
    inner = element('1254c367', inner);
  }
  return inner;
}

/** What each file cost before D190, where it was measured, is in the label. */
const REFUSED: ReadonlyArray<readonly [label: string, bytes: () => Uint8Array, code: VideoProblemCode, message: RegExp]> = [
  // Sizes music-metadata allocates before it reads (F8).
  ['a WebM title declaring 4 GiB (61 bytes; 4 GiB reserved)', () => webm(element(SEGMENT, element(INFO, element(TITLE, Buffer.from('x'), 2 ** 32)))), 'unreadable', /the file ends before its container does/],
  ['a WebM element larger than the one that holds it', () => webm(element(SEGMENT, element(INFO, element(TITLE, Buffer.from('x'), 100))), element('ec', Buffer.alloc(200))), 'unreadable', /a part of its container is larger than the part that holds it/],
  ['an MP4 metadata value declaring 4 GiB', () => iso(boxOf('moov', boxOf('udta', boxOf('data', Buffer.from('x'), 2 ** 32 - 1)))), 'unreadable', /the file ends before its container does/],
  // Counts it loops over, and text it trims, in more than linear time (F20).
  ['an MP4 sample description of 2^32 − 1 entries of size zero (never ended)', () => iso(boxOf('stsd', Buffer.concat([u32(0), u32(0xffff_ffff), u32(0), Buffer.from('avc1'), Buffer.alloc(8)]))), 'unreadable', /its container is damaged/],
  ['an MP4 sample description counting more entries than it holds', () => iso(boxOf('stsd', Buffer.concat([u32(0), u32(2), boxOf('avc1', Buffer.alloc(8))]))), 'unreadable', /its container is damaged/],
  ['a fragmented MP4 with a run of 2^32 − 1 samples and no fields (76 bytes; 90 s, then a RangeError)', () => iso(boxOf('moof', boxOf('traf', Buffer.concat([boxOf('tfhd', Buffer.concat([u32(0), u32(1)])), boxOf('trun', Buffer.concat([u32(0), u32(0xffff_ffff), u32(0)]))])))), 'unknown_duration', /is fragmented/],
  ['an ftyp of 100,000 brands (400 KB; 16 s)', () => new Uint8Array(boxOf('ftyp', Buffer.concat([Buffer.from('isom'), u32(0), manyBrands(100_000)]))), 'unsupported_container', /^The file is not an MP4 or WebM video\.$/],
  ['a second ftyp of 70 brands', () => iso(boxOf('ftyp', Buffer.concat([Buffer.from('isom'), u32(0), manyBrands(70)]))), 'unreadable', /its container is damaged/],
  ['a WebM title of 80,000 zero bytes before a line break (80 KB; 6 s)', () => webm(element(SEGMENT, element(INFO, element(TITLE, Buffer.concat([Buffer.alloc(80_000), Buffer.from('\nx')]))))), 'unreadable', /a line break after a zero byte/],
  ['a WebM title of zero bytes before U+2028', () => webm(element(SEGMENT, element(INFO, element(TITLE, Buffer.concat([Buffer.alloc(1_000), Buffer.from(' x')]))))), 'unreadable', /a line break after a zero byte/],
  // Shapes it reads in more or fewer bytes than they hold, which would leave it out of step with the walk.
  ['a ten-byte WebM float', () => webm(element(SEGMENT, element(INFO, element('4489', Buffer.alloc(10))))), 'unreadable', /its container is damaged/],
  ['a WebM title of unknown size', () => webm(element(SEGMENT, element(INFO, element(TITLE, Buffer.from('x'), null)))), 'unreadable', /its container is damaged/],
  ['a WebM Cluster of unknown size written in one byte', () => webm(element(SEGMENT, Buffer.concat([Buffer.from('1f43b675ff', 'hex'), Buffer.alloc(300)]))), 'unreadable', /its container is damaged/],
  ['an MP4 chap list of odd length', () => iso(boxOf('chap', Buffer.alloc(5))), 'unreadable', /its container is damaged/],
  ['an MP4 data box with a 64-bit size', () => iso(boxOf('moov', largeBox('data', Buffer.alloc(8)))), 'unreadable', /its container is damaged/],
  ['an MP4 meta box too short for its version and flags', () => iso(boxOf('moov', boxOf('meta', Buffer.alloc(2)))), 'unreadable', /its container is damaged/],
  ['an MP4 box of size zero below the top level', () => iso(boxOf('moov', boxOf('udta', Buffer.alloc(0), 0))), 'unreadable', /its container is damaged/],
  // Bounds.
  [`a WebM file of more than ${VIDEO_MAX_PARTS} elements`, () => webm(element(SEGMENT, Buffer.from('ec80'.repeat(VIDEO_MAX_PARTS), 'hex'))), 'unreadable', /more than 20,000 parts/],
  [`an MP4 file of more than ${VIDEO_MAX_ENTRIES} sample-table entries`, () => iso(boxOf('stts', Buffer.concat([u32(0), u32(VIDEO_MAX_ENTRIES + 1), Buffer.alloc(8 * (VIDEO_MAX_ENTRIES + 1))]))), 'unreadable', /more than 1,000,000 entries/],
  // A chap list is read as one number for each four bytes: 40 MB of it took 1.7 s and 416 MiB (Codex review of #43).
  [`an MP4 chap list of more than ${VIDEO_MAX_ENTRIES} track references`, () => iso(boxOf('moov', boxOf('trak', boxOf('tref', boxOf('chap', Buffer.alloc(4 * (VIDEO_MAX_ENTRIES + 1))))))), 'unreadable', /more than 1,000,000 entries/],
  ['WebM elements nested 40 deep', () => webm(element(SEGMENT, nestedTags(40))), 'unreadable', /its container is damaged/],
  // Formats music-metadata would sniff and parse with a reader of its own.
  ...(
    [
      ['MP3 with an ID3v2 tag', 'ID3\x04\0\0\0\0\0\0'],
      ['MPEG audio frames', '\xff\xfb\x90\0'],
      ['WAV', 'RIFF\x24\0\0\0WAVEfmt '],
      ['FLAC', 'fLaC\0\0\0\x22'],
      ['Ogg', 'OggS\0\x02'],
      ['ASF', '\x30\x26\xb2\x75\x8e\x66\xcf\x11'],
    ] as const
  ).map(
    ([name, head]) =>
      [`a file that starts as ${name}`, () => new Uint8Array(Buffer.concat([Buffer.from(head, 'latin1'), Buffer.alloc(4096)])), 'unsupported_container', /^The file is not an MP4 or WebM video\.$/] as const,
  ),
];

test('D190 (F8, F20): a file whose sizes, counts or text music-metadata would mishandle is refused before it reads a byte', async () => {
  const started = performance.now();
  for (const [label, make, code, message] of REFUSED) {
    const bytes = make();
    const admitted = admitVideo(bytes);
    assert.ok(!admitted.ok, `${label}: admitted`);
    const result = await probeVideo(bytes);
    assert.ok(!result.ok, label);
    assert.deepEqual([result.problem.code, result.problem.rule, result.problem.line], [code, 'R16', null], label);
    assert.match(result.problem.message, message, label);
    assert.deepEqual(result, admitted.failure, `${label}: the problem is admission's`);
  }
  assert.ok(performance.now() - started < 5_000, 'each file is refused in milliseconds, where music-metadata took seconds to minutes or never ended');
});

test('D190: text padded with zero bytes, as RFC 8794 allows, is admitted and read', async () => {
  const padded = Buffer.from(webmSource());
  const at = padded.indexOf('papeleria test fixture');
  padded.fill(0, at + 'papeleria'.length, at + 'papeleria test fixture'.length);
  assert.ok(admitVideo(new Uint8Array(padded)).ok);
  assert.deepEqual(await probeVideo(new Uint8Array(padded)), {ok: true, probe: {duration: 1}});
  // A line break before the zero bytes costs the trim nothing.
  const broken = Buffer.from(webmSource());
  broken.write('\n', at + 'papeleria'.length, 'latin1');
  broken.fill(0, at + 'papeleria'.length + 1, at + 'papeleria test fixture'.length);
  assert.deepEqual(await probeVideo(new Uint8Array(broken)), {ok: true, probe: {duration: 1}});
});

test('D190: the element sets are the Matroska DTD music-metadata installed', async () => {
  type DtdElement = {readonly value?: number; readonly container?: Readonly<Record<string, DtdElement>>};
  const library = join(applicationRoot, 'node_modules', 'music-metadata', 'lib');
  const {matroskaDtd} = (await import(pathToFileURL(join(library, 'matroska', 'MatroskaDtd.js')).href)) as {matroskaDtd: DtdElement};
  const {DataType} = (await import(pathToFileURL(join(library, 'ebml', 'types.js')).href)) as {DataType: {string: number; float: number}};
  const containers = new Set<number>();
  const values = new Map<number, number | undefined>();
  const walk = (parent: DtdElement): void => {
    for (const [id, child] of Object.entries(parent.container ?? {})) {
      if (child.container === undefined) {
        values.set(Number(id), child.value);
      } else {
        containers.add(Number(id));
        walk(child);
      }
    }
  };
  walk(matroskaDtd);
  const sorted = (ids: Iterable<number>): number[] => [...ids].sort((a, b) => a - b);
  const typed = (type: number): number[] => sorted([...values].filter(([, value]) => value === type).map(([id]) => id));
  // If one of these fails, music-metadata reads the file differently now: revisit the walk in src/core/video.ts (D190).
  assert.deepEqual(sorted(containers), sorted([...EBML_ELEMENTS.containers, ...EBML_ELEMENTS.skipped]), 'containers');
  assert.deepEqual(typed(DataType.string), sorted(EBML_ELEMENTS.strings), 'strings');
  assert.deepEqual(typed(DataType.float), sorted(EBML_ELEMENTS.floats), 'floats');
  assert.deepEqual(sorted([...containers].filter((id) => values.has(id))), [], 'no id is a container in one place and a value in another');
});
