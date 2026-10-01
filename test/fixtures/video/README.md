# Video fixtures (M3.4, DEP04)

No binary video is committed here, and no encoder runs: `generate.ts` writes every file byte by byte when a test runs (D93). There is no ffmpeg anywhere in Papeleria or its tests (IC04).

| Builder | Writes |
| --- | --- |
| `mp4Source(options)` | An ISO base media file (ISO/IEC 14496-12): `ftyp` (brands `isom`, `iso2`, `avc1`, `mp41` unless given), `moov` with `mvhd` (version 0 or 1, any timescale and duration, or the all-ones "unknown") and one `trak` per track, and `mdat`. Options put `moov` after `mdat`, give `mdat` a 64-bit size or size 0 ("to the end of the file"), leave `mvhd` out, add an audio track of its own length, add a title in `udta/meta/ilst` with `meta` written the ISO or the QuickTime way, add `mvex` to `moov`, which makes the movie fragmented, or write a whole fragmented movie (`fragmentSeconds`: `mvex` with a `trex` per track in `moov`, empty sample tables, and each track's sample in a `moof` and `mdat` after it, as a streaming recorder writes) |
| `webmSource(options)` | An EBML file: the EBML header (`DocType` `webm` unless given), then a Segment holding `Info` (`TimecodeScale`, and `Duration` unless it is null), `Tracks` and one `Cluster` with one `SimpleBlock` per track. An option writes the Segment's and the Cluster's sizes as unknown, as a recorder writing while it records does |
| `ebmlSize(n)` | An EBML element size of eight bytes, or eight bytes of "unknown" for null, for tests that write an element of their own |
| `truncated(bytes, n)` | The first `n` bytes, as a copy cut off in transfer would hold |
| `garbage(n)` | A fixed pseudo-random byte sequence that is no media format |

## Provenance: what the files are

- **Containers exact, frames placeholders.** The video reader (`src/core/video.ts`) reads the container — its type, its tracks, its stated duration — and never decodes a frame, so the containers follow their specifications field by field and the frames do not have to be pictures.
- **MP4:** the video track declares an `avc1` (H.264) sample entry, 64 × 36, whose `avcC` record holds no sequence or picture parameter sets; its one sample is four zero bytes. The audio track, when asked for, declares an `mp4a` (AAC) sample entry at 48 kHz with no decoder configuration and one four-byte sample. Neither would play.
- **WebM:** the video track is `V_VP8`, 64 × 36; its one block holds a VP8 key-frame tag, start code and size with no partition data. The audio track, when asked for, is `A_OPUS` with three placeholder bytes. Neither would play.
- **Silent** means no audio track, which is the default for both builders: the case DEP04 names, and the one music-metadata 11.15 cannot measure in MP4 (D92).

A playable fixture would need an encoder, which this repository does not have and IC04 does not allow the product. What a browser does with a real file is observed differently: `test/browser/document.test.ts` checks that a published video waits for Play (no request, no autoplay), which needs no decodable frame.
