/**
 * M1.4 image fixtures, built at test time with the locked sharp so no binary
 * image is committed (see README.md beside this file). Every builder is
 * deterministic: the same call returns the same bytes on the same toolchain.
 */
import {crc32, deflateSync} from 'node:zlib';
import sharp, {type Sharp} from 'sharp';

/** Raw RGB bytes of a smooth two-axis gradient with a checker term, so resizing has real detail. */
export function gradientPixels(width: number, height: number): Buffer {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      pixels[offset] = Math.floor((x * 255) / Math.max(1, width - 1));
      pixels[offset + 1] = Math.floor((y * 255) / Math.max(1, height - 1));
      pixels[offset + 2] = ((x >> 3) ^ (y >> 3)) & 1 ? 200 : 40;
    }
  }
  return pixels;
}

function gradient(width: number, height: number): Sharp {
  return sharp(gradientPixels(width, height), {raw: {width, height, channels: 3}});
}

export function pngSource(width: number, height: number): Promise<Buffer> {
  return gradient(width, height).png({compressionLevel: 9}).toBuffer();
}

export function webpSource(width: number, height: number): Promise<Buffer> {
  return gradient(width, height).webp({quality: 90}).toBuffer();
}

/**
 * A JPEG carrying EXIF (a copyright line) and XMP, optionally with an EXIF
 * orientation. The pixels are stored unrotated; only the tag says how to turn them.
 */
export function jpegSource(width: number, height: number, orientation?: number): Promise<Buffer> {
  let pipeline = gradient(width, height)
    .jpeg({quality: 90})
    .withExif({IFD0: {Copyright: 'Papeleria fixture'}})
    .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/></x:xmpmeta>');
  if (orientation !== undefined) {
    pipeline = pipeline.withMetadata({orientation});
  }
  return pipeline.toBuffer();
}

/** The sRGB colour every pixel of the P3 fixture represents. */
export const P3_FIXTURE_SRGB = [200, 100, 50] as const;

/**
 * A flat PNG whose pixels are stored in Display P3 with the P3 profile
 * attached. Read with its profile it is the sRGB colour above; read without
 * it, the stored numbers differ, which is what makes the conversion observable.
 */
export function p3Source(): Promise<Buffer> {
  const size = 32;
  const pixels = Buffer.alloc(size * size * 3);
  for (let index = 0; index < size * size; index += 1) {
    pixels.set(P3_FIXTURE_SRGB, index * 3);
  }
  return sharp(pixels, {raw: {width: size, height: size, channels: 3}}).withIccProfile('p3').png().toBuffer();
}

/** A two-frame animated WebP. */
export async function animatedWebpSource(): Promise<Buffer> {
  const red = await sharp({create: {width: 16, height: 16, channels: 3, background: '#ff0000'}}).png().toBuffer();
  const blue = await sharp({create: {width: 16, height: 16, channels: 3, background: '#0000ff'}}).png().toBuffer();
  return sharp([red, blue], {join: {animated: true}}).webp({loop: 0}).toBuffer();
}

/** A JPEG cut short: its header is intact, so it probes, but it cannot be decoded. */
export async function truncatedJpegSource(): Promise<Buffer> {
  const whole = await jpegSource(400, 300);
  return whole.subarray(0, Math.floor(whole.length * 0.6));
}

export function gifSource(): Promise<Buffer> {
  return sharp({create: {width: 16, height: 16, channels: 3, background: '#00ff00'}}).gif().toBuffer();
}

export const SVG_MARKUP = Buffer.from(
  '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>\n',
);

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typed) >>> 0);
  return Buffer.concat([length, typed, checksum]);
}

/**
 * A PNG declaring any size whose pixel data is almost all missing: the
 * signature, an IHDR, one IDAT holding a single short scanline, and IEND.
 * libvips reads the header (it needs an IDAT to be present to do so) and
 * reports the declared size; decoding fails. This tests the
 * 100-million-pixel boundary without allocating gigabytes.
 */
export function pngHeaderOnly(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  header[10] = 0; // compression
  header[11] = 0; // filter
  header[12] = 0; // interlace
  const scanline = Buffer.alloc(1 + 3 * Math.min(width, 64));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanline)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A two-frame APNG built by hand: IHDR, acTL (2 frames) before the first IDAT,
 * then fcTL + IDAT for frame one and fcTL + fdAT for frame two. libvips reads
 * it as an ordinary still PNG, which is exactly why it needs its own check.
 */
export function apngSource(): Buffer {
  const width = 4;
  const height = 4;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const control = Buffer.alloc(8);
  control.writeUInt32BE(2, 0); // frames
  control.writeUInt32BE(0, 4); // plays: forever
  const frame = (sequence: number) => {
    const data = Buffer.alloc(26);
    data.writeUInt32BE(sequence, 0);
    data.writeUInt32BE(width, 4);
    data.writeUInt32BE(height, 8);
    data.writeUInt16BE(1, 20); // delay numerator
    data.writeUInt16BE(10, 22); // delay denominator
    return data;
  };
  const rows = Buffer.alloc(height * (1 + width * 3));
  for (let row = 0; row < height; row += 1) {
    rows[row * (1 + width * 3)] = 0; // filter: none
    rows.fill(row * 60, row * (1 + width * 3) + 1, (row + 1) * (1 + width * 3));
  }
  const sequence = Buffer.alloc(4);
  sequence.writeUInt32BE(2, 0);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('acTL', control),
    pngChunk('fcTL', frame(0)),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('fcTL', frame(1)),
    pngChunk('fdAT', Buffer.concat([sequence, deflateSync(rows)])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
