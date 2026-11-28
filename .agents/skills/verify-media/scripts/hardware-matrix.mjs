// The hardware matrix: which video stage works on which path (the CPU, Intel Quick Sync, VA-API),
// measured through the media service's own playback negotiation. This file is the table and the
// pure logic that judges a cell; hardware-matrix-run.mjs drives a side and collects what it saw.
//
// A cell is one row of ROWS on one of its paths. A row names the fixture it plays, the client
// capability profile and request that force its stage through negotiation, the checks that decide
// the verdict, and where each operation of the stage must run. A new stage, path, or hybrid row
// (such as a CPU decode feeding a GPU encode) is a new entry in these tables, never new control
// flow.

import { blockFont } from "./block-font.mjs";
import { HDR_PATCHES, hdrPattern, judgePatches, REFERENCES, SDR_PATCHES, sdrPattern } from "./colour-patches.mjs";
import { pgsStream } from "./pgs.mjs";

/** The stages of the video pipeline, in the grid's order. */
export const STAGES = [
  "decode",
  "deinterlace",
  "scale",
  "hdr-to-sdr",
  "subtitle-burn-in",
  "encode-h264",
  "encode-hevc",
  "encode-av1",
];

/**
 * Where a stage runs. `setting` is the side's HARDWARE_ACCELERATION; a path with `device` needs a
 * render node on the host, passed through by deploy/compose's override of the same name.
 */
export const PATHS = {
  cpu: { setting: "none", device: false, encoder: "software" },
  qsv: { setting: "qsv", device: true, encoder: "qsv" },
  vaapi: { setting: "vaapi", device: true, encoder: "vaapi" },
};

/**
 * PASS: the output is right and the stage ran on the cell's path. FAIL: the stream broke, the
 * output is wrong (a stage the service ran that did not take effect included), or the stage ran
 * somewhere else (such as in software on a GPU path). NOT-BUILT: the service answered correctly but
 * did not do the stage: it refused, or no ffmpeg run attempted the stage and the output lacks it.
 * SKIPPED: the fixture or the device is absent. Only PASS counts as working.
 */
export const VERDICTS = ["PASS", "FAIL", "NOT-BUILT", "SKIPPED"];

const FEATURE_TEST = "/media/library/Movies/[movies] Feature Test (2010)/[movies] Feature Test (2010)";

/**
 * Where the rows that play the Feature Test start: past its black opening and fade-in (0 to 4 s),
 * where no frame is pictured, so no check can place one in time. From 36 s to 42 s every frame of
 * each of its versions is pictured, the dimmest at a gray-level spread of 42.9 (the HDR10 version
 * through the reference tone map; 59.9 in the others), over four times the margin of 10. It is on
 * the 4 s segment grid, and no row's seek. Position 0 stays covered by the rows whose generated
 * fixtures are pictured from their first frame: decode, hybrid-cpu-decode, scale-variable-rate, and
 * the colour patch rows.
 */
export const FEATURE_TEST_START = 36;

/** Where the generated fixtures live in a side's container (`up` mounts the side's state there). */
export const FIXTURE_ROOT = "/media/verify-fixtures";

/** The library the generated fixtures are scanned into. */
export const FIXTURE_LIBRARY = "Verify fixtures";

/**
 * The styled subtitle the text row burns in, on a 1920x1080 script: "LAR SUBTITLE" in the attached
 * block font (`block-font.mjs`), orange, 80 lines tall, its top left at (120, 860), so it draws two
 * solid rectangles across x 120 to 696 and y 860 to 940; a caption in DejaVu Sans with a border and
 * a shadow at the top, and a rotated word, for the eye. Every cue runs from 0.5 s to 29.5 s.
 */
export const STYLED_SCRIPT = [
  "[Script Info]",
  "ScriptType: v4.00+",
  "PlayResX: 1920",
  "PlayResY: 1080",
  "ScaledBorderAndShadow: yes",
  "",
  "[V4+ Styles]",
  "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
  "Style: Blocks,Lar Blocks,80,&H000080FF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1",
  "Style: Caption,DejaVu Sans,64,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,2,8,0,0,40,1",
  "",
  "[Events]",
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  "Dialogue: 0,0:00:00.50,0:00:29.50,Blocks,,0,0,0,,{\\pos(120,860)}LAR SUBTITLE",
  "Dialogue: 0,0:00:00.50,0:00:29.50,Caption,,0,0,0,,Styled text, burned in by libass",
  "Dialogue: 0,0:00:00.50,0:00:29.50,Caption,,0,0,0,,{\\an5\\pos(1440,560)\\frz15\\1c&H00FFFF&}Positioned",
  "",
].join("\n");

/** HDR10 static metadata for the generated HDR10 fixtures: BT.2020 mastering, 0.005 to 1000 cd/m², MaxCLL 1000, MaxFALL 400. */
const HDR10_X265 =
  "hdr10=1:repeat-headers=1:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50):max-cll=1000,400";

/** The patches over a moving testsrc2 band: the HDR pattern in linear BT.2020 light, to `transfer` at zscale's `npl`. */
const hdrPatchGraph = (transfer, npl) =>
  [
    "[0:v]setparams=color_primaries=bt2020:color_trc=linear:colorspace=gbr[p]",
    `[1:v]zscale=tin=bt709:pin=bt709:min=bt709:rin=full:t=linear:p=bt2020,format=gbrpf32le[s]`,
    `[p][s]vstack,zscale=tin=linear:pin=bt2020:min=gbr:t=${transfer}:p=bt2020:m=bt2020nc:r=tv:npl=${npl},format=yuv420p10le[v]`,
  ].join(";");

/** The SDR patches over a moving testsrc2 band, converted by `zscale` options to the fixture's colour. */
const sdrPatchGraph = (convert, layout) =>
  `[0:v]format=gbrp[a];[1:v]format=gbrp[b];[a][b]vstack,setparams=color_primaries=bt709:color_trc=bt709:colorspace=gbr:range=pc,zscale=${convert},format=${layout}[v]`;

/** The pattern's inputs (`/out/<raw>`), a testsrc2 band, and a tone: 30 s at 24 fps. */
const patchInputs = (raw, layout) => [
  ["-f", "rawvideo", "-pix_fmt", layout, "-s", "1920x640", "-framerate", "24", "-stream_loop", "-1", "-i", `/out/${raw}`],
  ["-f", "lavfi", "-i", "testsrc2=size=1920x440:rate=24:duration=30"],
  ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=30"],
].flat();

/** A patch fixture's video encode and its tone, with the GOP the other generated fixtures use. */
const patchEncode = (encoder, params, tags) => [
  ["-map", "[v]", "-map", "2:a", "-t", "30", ...encoder],
  params,
  [...tags, "-c:a", "aac", "-b:a", "128k"],
].flat();

const X265_GOP = "keyint=48:min-keyint=48:scenecut=0:log-level=error";

const sdrPatches = (title, about, convert, layout, encoder, tags) => ({
  about,
  colour: "source",
  generate: {
    title,
    year: 2026,
    file: `${title} (2026).mkv`,
    files: { "sdr.raw": () => sdrPattern() },
    args: [...patchInputs("sdr.raw", "rgb24"), "-filter_complex", sdrPatchGraph(convert, layout), ...patchEncode(encoder, [], tags)],
  },
});

/**
 * Samples a fixture is made from that cannot be generated, fetched by the runner into a cache
 * outside the repository, checked against their SHA-256, and never committed: Dolby Vision
 * streams. FFmpeg's test suite (fate-suite.ffmpeg.org) states no licence for its samples; Apple's
 * HLS examples (devstreaming-cdn.apple.com) are published for testing HLS players, with no licence
 * to redistribute. `parts` are fetched and joined in order, as an HLS rendition's init segment and
 * fragments make one MP4.
 */
const FATE = "https://fate-suite.ffmpeg.org";

const APPLE_DV =
  "https://devstreaming-cdn.apple.com/videos/streaming/examples/adv_dv_atmos/Job2dae5735-d6ca-48ca-91be-0ec0bead535c-107702578-hls_bundle_hdrhls765_dolbyvision";

const APPLE_HDR10PLUS =
  "https://devstreaming-cdn.apple.com/videos/streaming/examples/adv_dv_atmos/Job8208634a-0add-4223-9782-600c14a70339-139240443-hls_bundle_hdrhls765_hdr10plus";

export const SAMPLES = {
  "dv84.mov": { parts: [`${FATE}/hevc/dv84.mov`], sha256: "aaa9289a9755eaebd9962204f24a6acf8a19ff104657a3a79b6b1fa672993721" },
  "dovi-p81.mp4": { parts: [`${FATE}/mov/dovi-p81.mp4`], sha256: "3313278f3dc49b0b3680ec7c3d72622ec0a770faff9721c5842aaf899d5471c5" },
  "dovi-p7.mp4": { parts: [`${FATE}/mov/dovi-p7-hvce.mp4`], sha256: "67baddaf158bc96c0c7955ca8894e92632df5ccca85bc68733f92f5f9fa7caaa" },
  "hdr10plus.mp4": {
    parts: [`${APPLE_HDR10PLUS}/fileSequence0.mp4`, ...[1, 2, 3, 4, 5, 6].map((n) => `${APPLE_HDR10PLUS}/fileSequence${n}.m4s`)],
    sha256: "c7d7c6db0aaa707a0598722b3d1d3e0150dcbbb70974766512784176599e5fe6",
  },
  "dv5.mp4": {
    parts: [`${APPLE_DV}/fileSequence0.mp4`, ...[1, 2, 3, 4, 5, 6].map((n) => `${APPLE_DV}/fileSequence${n}.m4s`)],
    sha256: "ddc0b5ea902becebf2179a8f25770bc0f0a84d666f5e0ee0da9d7c77f87758d7",
  },
};

/** A tone for a fetched sample, which has none or one the rows would not negotiate. */
const tone = (seconds) => ["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${seconds}`];

/**
 * What the cells play. A `library` fixture is a version of a demo library title; a `generate`
 * fixture is made at run time with the side's own ffmpeg into the side's state, mounted at
 * FIXTURE_ROOT, from `args` (the inputs and encode, without the output file), in Matroska unless
 * `format` names another container. `files` are written beside it first, by name, from text or
 * bytes, and the args read them at `/out/<name>`.
 */
export const FIXTURES = {
  "sdr-h264": {
    about: "H.264 High 8-bit SDR, 1920x818 at 24 fps, AAC in MP4: the Feature Test's Direct Play version",
    library: { title: "[movies] Feature Test", version: "Direct Play" },
    path: `${FEATURE_TEST} {edition-Direct Play}.mp4`,
  },
  "hdr10-hevc": {
    about: "HEVC Main 10 HDR10 (PQ, BT.2020), 1920x818 at 24 fps: the Feature Test's HDR10 HEVC version",
    library: { title: "[movies] Feature Test", version: "HDR10 HEVC" },
    path: `${FEATURE_TEST} {edition-HDR10 HEVC}.mkv`,
  },
  "image-subtitles": {
    about: "H.264 1920x818 with a DVD (image) subtitle track, e13, shown from 107.25 s: the Feature Test's Multi-Audio and Subtitles version",
    library: { title: "[movies] Feature Test", version: "Multi-Audio and Subtitles" },
    path: `${FEATURE_TEST} {edition-Multi-Audio and Subtitles}.mkv`,
  },
  "interlaced-mpeg2": {
    about: "MPEG-2 720x576 at 25 fps, top field first, with combing: the Feature Test's SD Interlaced MPEG-2 version",
    library: { title: "[movies] Feature Test", version: "SD Interlaced MPEG-2" },
    path: `${FEATURE_TEST} {edition-SD Interlaced MPEG-2}.mkv`,
  },
  "hevc-sdr": {
    about: "HEVC Main 8-bit SDR, 1920x1080 at 24 fps, 30 s of testsrc2 with a tone, generated: the demo library's only HEVC is HDR10",
    generate: {
      title: "Verify Fixture HEVC SDR",
      year: 2026,
      file: "Verify Fixture HEVC SDR (2026).mkv",
      args: [
        ["-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=24:duration=30"],
        ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=30"],
        ["-map", "0:v", "-map", "1:a", "-c:v", "libx265", "-preset", "ultrafast"],
        ["-x265-params", "keyint=48:min-keyint=48:scenecut=0:log-level=error", "-pix_fmt", "yuv420p"],
        ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-c:a", "aac", "-b:a", "128k"],
      ].flat(),
    },
  },
  "h264-10bit": {
    about: "H.264 High 10 (10-bit) SDR, 1920x1080 at 24 fps, 30 s of testsrc2 with a tone, generated: Intel media engines decode no 10-bit H.264",
    generate: {
      title: "Verify Fixture H264 10-bit",
      year: 2026,
      file: "Verify Fixture H264 10-bit (2026).mkv",
      args: [
        ["-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=24:duration=30"],
        ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=30"],
        ["-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast"],
        ["-pix_fmt", "yuv420p10le", "-g", "48", "-keyint_min", "48", "-sc_threshold", "0"],
        ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-c:a", "aac", "-b:a", "128k"],
      ].flat(),
    },
  },
  "styled-subtitles": {
    about: "H.264 High 8-bit SDR, 1920x1080 at 24 fps, 30 s of testsrc2 with a tone and a styled ASS track (e2) whose block font is attached, generated",
    generate: {
      title: "Verify Fixture Styled Subtitles",
      year: 2026,
      file: "Verify Fixture Styled Subtitles (2026).mkv",
      files: { "styled.ass": () => STYLED_SCRIPT, "lar-blocks.ttf": () => blockFont() },
      args: [
        ["-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=24:duration=30"],
        ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=30"],
        ["-i", "/out/styled.ass"],
        ["-map", "0:v", "-map", "1:a", "-map", "2:s", "-c:v", "libx264", "-preset", "ultrafast"],
        ["-g", "48", "-keyint_min", "48", "-sc_threshold", "0", "-pix_fmt", "yuv420p"],
        ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-c:a", "aac", "-b:a", "128k", "-c:s", "copy"],
        ["-attach", "/out/lar-blocks.ttf", "-metadata:s:t:0", "mimetype=application/x-truetype-font"],
        ["-metadata:s:t:0", "filename=Lar Blocks.ttf"],
      ].flat(),
    },
  },
  "pgs-subtitles": {
    about: "H.264 1920x800 (2.39:1) at 24 fps, 30 s of testsrc2 with a tone and a PGS track (e2) on a 1920x1080 canvas, a bar from 2 s to 22 s, generated",
    generate: {
      title: "Verify Fixture PGS Subtitles",
      year: 2026,
      file: "Verify Fixture PGS Subtitles (2026).mkv",
      files: { "pgs.sup": () => pgsStream() },
      args: [
        ["-f", "lavfi", "-i", "testsrc2=size=1920x800:rate=24:duration=30"],
        ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=30"],
        // ffmpeg starts each input at its own first packet; the offset keeps the bar at 2 s.
        ["-itsoffset", "2", "-i", "/out/pgs.sup"],
        ["-map", "0:v", "-map", "1:a", "-map", "2:s", "-c:v", "libx264", "-preset", "ultrafast"],
        ["-g", "48", "-keyint_min", "48", "-sc_threshold", "0", "-pix_fmt", "yuv420p"],
        ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-c:a", "aac", "-b:a", "128k", "-c:s", "copy"],
      ].flat(),
    },
  },
  "vfr-h264": {
    about: "H.264 640x360 in MP4 at a variable frame rate, as a phone records: 4 s at 60 fps then 12 s at 15 fps, with a tone, generated; ffprobe reads a base rate of 60 and an average of 26.25",
    generate: {
      title: "Verify Fixture Variable Rate",
      year: 2026,
      file: "Verify Fixture Variable Rate (2026).mp4",
      format: "mp4",
      args: [
        ["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=60:duration=4"],
        ["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=15:duration=12"],
        ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=16"],
        ["-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-map", "2:a"],
        ["-fps_mode", "vfr", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-b:a", "128k"],
      ].flat(),
    },
  },
  "hdr10-patches": {
    about: "HEVC Main 10 HDR10 (PQ, BT.2020, mastering 1000 cd/m²), 1920x1080 at 24 fps, 30 s: colour patches (a gray ramp from black to 1000 cd/m², saturated, dark, and bright colours) over a moving testsrc2 band, generated",
    colour: "hdr10",
    generate: {
      title: "Verify Fixture HDR10 Patches",
      year: 2026,
      file: "Verify Fixture HDR10 Patches (2026).mkv",
      files: { "hdr.raw": () => hdrPattern(100) },
      args: [
        ...patchInputs("hdr.raw", "gbrpf32le"),
        "-filter_complex",
        hdrPatchGraph("smpte2084", 100),
        ...patchEncode(["-c:v", "libx265", "-preset", "ultrafast"], ["-x265-params", `${X265_GOP}:${HDR10_X265}`], ["-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc", "-color_range", "tv"]),
      ],
    },
  },
  "hlg-patches": {
    about: "HEVC Main 10 HLG (BT.2020), 1920x1080 at 24 fps, 30 s: the HDR10 fixture's patches for a 1000 cd/m² HLG display, over a moving testsrc2 band, generated",
    colour: "hlg",
    generate: {
      title: "Verify Fixture HLG Patches",
      year: 2026,
      file: "Verify Fixture HLG Patches (2026).mkv",
      files: { "hdr.raw": () => hdrPattern(1000) },
      args: [
        ...patchInputs("hdr.raw", "gbrpf32le"),
        "-filter_complex",
        hdrPatchGraph("arib-std-b67", 1000),
        ...patchEncode(["-c:v", "libx265", "-preset", "ultrafast"], ["-x265-params", X265_GOP], ["-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc", "-color_range", "tv"]),
      ],
    },
  },
  "sdr-bt601-patches": sdrPatches(
    "Verify Fixture BT601 Patches",
    "H.264 High 8-bit SDR BT.601 (smpte170m), 1920x1080 at 24 fps, 30 s: SDR colour patches over a moving testsrc2 band, generated",
    "t=smpte170m:p=smpte170m:m=smpte170m:r=tv",
    "yuv420p",
    ["-c:v", "libx264", "-preset", "ultrafast", "-qp", "4", "-g", "48", "-keyint_min", "48", "-sc_threshold", "0"],
    ["-color_primaries", "smpte170m", "-color_trc", "smpte170m", "-colorspace", "smpte170m", "-color_range", "tv"],
  ),
  "sdr-bt2020-patches": sdrPatches(
    "Verify Fixture BT2020 SDR Patches",
    "HEVC Main 10 SDR BT.2020 (bt2020-10 transfer), 1920x1080 at 24 fps, 30 s: SDR colour patches over a moving testsrc2 band, generated",
    "t=bt2020-10:p=bt2020:m=bt2020nc:r=tv",
    "yuv420p10le",
    ["-c:v", "libx265", "-preset", "ultrafast", "-x265-params", `${X265_GOP}:qp=4`],
    ["-color_primaries", "bt2020", "-color_trc", "bt2020-10", "-colorspace", "bt2020nc", "-color_range", "tv"],
  ),
  "sdr-full-range-patches": sdrPatches(
    "Verify Fixture Full Range Patches",
    "H.264 High 8-bit SDR BT.709 in full range (pc), 1920x1080 at 24 fps, 30 s: SDR colour patches over a moving testsrc2 band, generated",
    "m=bt709:r=full",
    "yuv420p",
    ["-c:v", "libx264", "-preset", "ultrafast", "-qp", "4", "-g", "48", "-keyint_min", "48", "-sc_threshold", "0"],
    ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "pc"],
  ),
  "dv81-patches": {
    about: "HEVC Main 10 Dolby Vision 8.1 (HDR10 base layer, RPU on every picture), 1920x1080 at 24 fps, 30 s: the HDR10 fixture's patches, re-encoded by libx265 with the RPUs of FFmpeg's 8.1 sample (fetched), whose own pictures are black",
    colour: "hdr10",
    generate: {
      title: "Verify Fixture Dolby Vision 81",
      year: 2026,
      file: "Verify Fixture Dolby Vision 81 (2026).mkv",
      files: { "hdr.raw": () => hdrPattern(100) },
      fetch: ["dovi-p81.mp4"],
      args: [
        ...patchInputs("hdr.raw", "gbrpf32le"),
        ["-stream_loop", "-1", "-i", "/out/dovi-p81.mp4"],
        "-filter_complex",
        `${hdrPatchGraph("smpte2084", 100).replace("[v]", "[pic]")};[3:v]fps=24,format=yuv420p10le[dv];[dv][pic]overlay=format=yuv420p10[v]`,
        ...patchEncode(
          ["-c:v", "libx265", "-preset", "ultrafast", "-dolbyvision", "1", "-crf", "16", "-maxrate", "30M", "-bufsize", "30M"],
          ["-x265-params", `${X265_GOP}:${HDR10_X265}`],
          ["-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc", "-color_range", "tv"],
        ),
      ].flat(),
    },
  },
  "dv84-iphone": {
    about: "HEVC Main 10 Dolby Vision 8.4 (HLG base layer) as an iPhone records it, 1920x1080 at about 30 fps: FFmpeg's sample (fetched), 3.3 s looped to 30 s, its rotation dropped, with a tone",
    generate: {
      title: "Verify Fixture Dolby Vision 84",
      year: 2026,
      file: "Verify Fixture Dolby Vision 84 (2026).mkv",
      fetch: ["dv84.mov"],
      args: [
        ["-display_rotation:v", "0", "-stream_loop", "8", "-i", "/out/dv84.mov"],
        tone(30),
        ["-map", "0:v", "-map", "1:a", "-t", "30", "-c:v", "copy", "-tag:v", "hvc1", "-c:a", "aac", "-b:a", "128k"],
      ].flat(),
    },
  },
  "dv7": {
    about: "HEVC Main 10 Dolby Vision 7 (HDR10 base layer with a full enhancement layer), 3840x2160: FFmpeg's one-picture sample (fetched), repeated for 30 s at 24 fps, with a tone",
    generate: {
      title: "Verify Fixture Dolby Vision 7",
      year: 2026,
      file: "Verify Fixture Dolby Vision 7 (2026).mkv",
      fetch: ["dovi-p7.mp4"],
      args: [
        ["-stream_loop", "719", "-i", "/out/dovi-p7.mp4"],
        tone(30),
        ["-map", "0:v", "-map", "1:a", "-c:v", "copy", "-tag:v", "hvc1", "-c:a", "aac", "-b:a", "128k"],
      ].flat(),
    },
  },
  "dv5-apple": {
    about: "HEVC Main 10 Dolby Vision 5 (IPT-PQ-c2, no compatible base layer), 1920x1080 at 23.976 fps, 33 s: Apple's HLS example rendition (fetched), with a tone",
    reference: "dv5-apple-hdr10plus",
    generate: {
      title: "Verify Fixture Dolby Vision 5",
      year: 2026,
      file: "Verify Fixture Dolby Vision 5 (2026).mkv",
      fetch: ["dv5.mp4"],
      args: [["-i", "/out/dv5.mp4"], tone(34), ["-map", "0:v", "-map", "1:a", "-c:v", "copy", "-tag:v", "hvc1", "-c:a", "aac", "-b:a", "128k", "-shortest"]].flat(),
    },
  },
  "dv5-apple-hdr10plus": {
    about: "HEVC Main 10 HDR10+ (PQ, BT.2020), 1920x1080 at 23.976 fps, 33 s: Apple's HLS example rendition of the same pictures as dv5-apple (fetched), the source of that row's reference picture",
    generate: {
      title: "Verify Fixture Dolby Vision 5 Reference",
      year: 2026,
      file: "Verify Fixture Dolby Vision 5 Reference (2026).mkv",
      fetch: ["hdr10plus.mp4"],
      args: [["-i", "/out/hdr10plus.mp4"], tone(34), ["-map", "0:v", "-map", "1:a", "-c:v", "copy", "-tag:v", "hvc1", "-c:a", "aac", "-b:a", "128k", "-shortest"]].flat(),
    },
  },
};


/** The fixture's file inside a side's container. */
export const fixturePath = (fixture) =>
  fixture.path ?? `${FIXTURE_ROOT}/${fixture.generate.title} (${fixture.generate.year})/${fixture.generate.file}`;

const aac = { codec: "aac", maxChannels: 2 };

/**
 * Client capability profiles, in the shape `POST /api/playback/negotiate` takes. Each names a real
 * kind of client, and none plays the fixtures it meets as they are, so negotiation must do the
 * row's stage.
 */
export const PROFILES = {
  "h264-sdr": {
    about: "A browser that plays H.264 SDR up to 8 bits and 1080p through MSE, with AAC, and no HEVC or AV1",
    capabilities: {
      containers: ["mp4"],
      videoCodecs: [{ codec: "h264", maxBitDepth: 8 }],
      audioCodecs: [aac],
      maxWidth: 1920,
      maxHeight: 1080,
      hls: false,
      mse: true,
    },
  },
  "hevc-sdr": {
    about: "A device that decodes HEVC Main 8-bit SDR up to 1080p and no H.264, with AAC",
    capabilities: {
      containers: ["mp4"],
      videoCodecs: [{ codec: "hevc", profiles: ["Main"], maxBitDepth: 8 }],
      audioCodecs: [aac],
      maxWidth: 1920,
      maxHeight: 1080,
      hls: true,
      mse: true,
    },
  },
  "av1-sdr": {
    about: "A device that decodes AV1 Main 8-bit SDR up to 1080p and no H.264, with AAC",
    capabilities: {
      containers: ["mp4"],
      videoCodecs: [{ codec: "av1", profiles: ["Main"], maxBitDepth: 8 }],
      audioCodecs: [aac],
      maxWidth: 1920,
      maxHeight: 1080,
      hls: true,
      mse: true,
    },
  },
};

const GPU_DEINTERLACE = /deinterlace_(qsv|vaapi)|vpp_qsv=[^,;\s]*deinterlace=/;
const GPU_SCALE = /scale_(qsv|vaapi)|vpp_qsv=[^,;\s]*\bw=/;
const GPU_TONE_MAP = /tonemap_vaapi|vpp_qsv=[^,;\s]*tonemap=1|libplacebo=/;
const GPU_OVERLAY = /overlay_(qsv|vaapi)/;

/**
 * Where an operation ran, read from one ffmpeg run's arguments and its GPU engine time. `uses`
 * must all match the arguments and `avoids` none; `engine` is the GPU engine class that must show
 * busy time (`any` for any class), or `none` when the run must hold no GPU client at all.
 * `bytes` is an encoder's fingerprint that must, or (`false`) must not, be in the output.
 */
export const WORK = {
  decode: {
    cpu: { uses: [], avoids: [/-hwaccel\s/], engine: "none" },
    // Quick Sync decodes through oneVPL's decoder, as older images render it, or through VA-API's
    // on the device Quick Sync is derived from, its surfaces mapped into Quick Sync's. The map
    // refuses software frames, so a VA-API decoder that falls back to software fails the run.
    qsv: { uses: [/-hwaccel qsv -hwaccel_output_format qsv\b|-hwaccel vaapi -hwaccel_output_format vaapi\b.*\bhwmap,format=qsv\b/], avoids: [], engine: "video" },
    vaapi: { uses: [/-hwaccel vaapi\b/, /-hwaccel_output_format vaapi\b/], avoids: [], engine: "video" },
  },
  deinterlace: {
    cpu: { uses: [/\b(yadif|bwdif|w3fdif|estdif|kerndeint)\b/], avoids: [GPU_DEINTERLACE], engine: "none" },
    qsv: { uses: [/deinterlace_qsv|vpp_qsv=[^,;\s]*deinterlace=/], avoids: [], engine: "any" },
    vaapi: { uses: [/deinterlace_vaapi/], avoids: [], engine: "any" },
  },
  scale: {
    cpu: { uses: [/(^|[\s,;\]])scale=/], avoids: [GPU_SCALE], engine: "none" },
    qsv: { uses: [/vpp_qsv=[^,;\s]*\bw=\d+|scale_qsv/], avoids: [], engine: "any" },
    vaapi: { uses: [/scale_vaapi=[^,;\s]*\bw=\d+/], avoids: [], engine: "any" },
  },
  // Quick Sync's and VA-API's paths map with libplacebo, on a Vulkan device of the same GPU,
  // where it is proven, and with their own tone map otherwise.
  "tone-map": {
    cpu: { uses: [/(^|[\s,;\]])tonemap=/], avoids: [GPU_TONE_MAP], engine: "none" },
    qsv: { uses: [/vpp_qsv=[^,;\s]*tonemap=1|libplacebo=/], avoids: [], engine: "any" },
    vaapi: { uses: [/tonemap_vaapi|libplacebo=/], avoids: [], engine: "any" },
  },
  overlay: {
    cpu: { uses: [/(^|[\s,;\]])overlay=/], avoids: [GPU_OVERLAY], engine: "none" },
    qsv: { uses: [/overlay_qsv/], avoids: [], engine: "any" },
    vaapi: { uses: [/overlay_vaapi/], avoids: [], engine: "any" },
  },
  // libass draws text on the CPU on every path: beside a GPU path's stages it is judged by the
  // run's arguments alone.
  text: {
    cpu: { uses: [/(^|[\s,;\]])subtitles=/], avoids: [], engine: "none" },
  },
  "encode-h264": {
    cpu: { uses: [/-c:v libx264\b/], avoids: [], engine: "none", bytes: "x264" },
    qsv: { uses: [/-c:v h264_qsv\b/], avoids: [], engine: "video", bytes: false },
    vaapi: { uses: [/-c:v h264_vaapi\b/], avoids: [], engine: "video", bytes: false },
  },
  "encode-hevc": {
    cpu: { uses: [/-c:v libx265\b/], avoids: [], engine: "none", bytes: "x265" },
    qsv: { uses: [/-c:v hevc_qsv\b/], avoids: [], engine: "video", bytes: false },
    vaapi: { uses: [/-c:v hevc_vaapi\b/], avoids: [], engine: "video", bytes: false },
  },
  "encode-av1": {
    cpu: { uses: [/-c:v (libsvtav1|libaom-av1|librav1e)\b/], avoids: [], engine: "none" },
    qsv: { uses: [/-c:v av1_qsv\b/], avoids: [], engine: "video", bytes: false },
    vaapi: { uses: [/-c:v av1_vaapi\b/], avoids: [], engine: "video", bytes: false },
  },
};

const ALL_PATHS = Object.keys(PATHS);

/** ffprobe's names for side data that says a stream is HDR: HDR10's, HDR10+'s, and Dolby Vision's. */
const HDR_SIDE_DATA = /mastering display|content light level|2094-40|hdr10\+|dolby vision|dovi/i;

/** What a row's colour check compares a fixture's patches with, and which patches it has. */
export const patchesOf = (reference) => (reference === "source" ? SDR_PATCHES : HDR_PATCHES);

/** The expected patches of `reference`: the reference tone map's, or none when the source's own are read. */
export const referencePatches = (reference) => REFERENCES[reference];

/**
 * The software tone map the hdr-to-sdr cell compares its picture with: linear light, Hable onto
 * 100 nits, BT.709. Run on the source in the side's container, it is a known-good SDR rendering of
 * the same frames; the cell's bounds catch a black, washed-out, or tinted picture, not a
 * different tone curve.
 */
export const REFERENCE_TONE_MAP =
  "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p";

/**
 * How far a tone-mapped patch may lie from the reference's (`colour-patches.mjs`): 10 in CIEDE2000,
 * where colours look the same with a different tone curve and a cast, a range fault, or a lost
 * gamut does not; and 8 codes of luma for a dark patch, where CIEDE2000 hardly tells a crushed
 * black from a right one. Stated before any path was measured, not fitted to one.
 */
const TONE_MAPPED = { deltaE: 10, dark: 8 };

/**
 * How far an SDR patch may lie from the source's own: 3 in CIEDE2000 and 3 codes of luma, the
 * encoder's loss, since nothing is converted and the right answer is the source itself.
 */
const SOURCE_EXACT = { deltaE: 3, dark: 3 };

/** A tone-mapping row on a patch fixture: tags, metadata, and every patch against `reference`. */
const toneMapped = (id, paths, fixture, reference) => ({
  id,
  stage: "hdr-to-sdr",
  paths,
  fixture,
  profile: "h264-sdr",
  request: {},
  start: 0,
  seek: 20,
  span: 4,
  work: { "tone-map": "path" },
  notBuilt: ["hdr-tone-mapping-requires-hardware"],
  checks: [
    { check: "hdr-removed" },
    { check: "sdr-tags" },
    { check: "hdr-metadata" },
    { check: "colour", reference, at: 21, tolerance: TONE_MAPPED },
    { check: "codec", codec: "h264", stage: false },
    { check: "bit-depth", max: 8 },
    { check: "dimensions", expect: "source" },
    { check: "frame-rate", expect: ["source"] },
  ],
});

/** A row that scales an SDR patch fixture to 720 lines: its colour and tags carried, the patches as the source's. */
const sdrScaled = (id, fixture) => ({
  id,
  stage: "scale",
  paths: ALL_PATHS,
  fixture,
  profile: "h264-sdr",
  request: { quality: { maxHeight: 720 } },
  start: 0,
  seek: 20,
  span: 4,
  work: { scale: "path" },
  notBuilt: [],
  checks: [
    { check: "scaled", maxHeight: 720 },
    { check: "dimensions", expect: "negotiated" },
    { check: "codec", codec: "h264", stage: false },
    { check: "frame-rate", expect: ["source"] },
    { check: "source-tags" },
    { check: "colour", reference: "source", at: 21, tolerance: SOURCE_EXACT },
  ],
});

/**
 * The rows: one per stage, a stage's row for a kind of source (`<stage>-<source>`, such as a
 * variable frame rate), then hybrid rows, whose `work` fixes an operation to another path than the
 * cell's. `start` and `seek` are where the two fetches begin, in seconds, and `span` how much
 * each covers. `request` adds negotiation options (`quality`, `burnInSubtitle`). `work` maps each
 * operation to where it must run: `path` (the cell's own) or a fixed path, for a hybrid row.
 * `notBuilt` lists the UnsupportedPlayback reasons that mean the service does not do the stage.
 * `checks` decide the verdict, besides the ones every transcode gets (COMMON_CHECKS).
 */
export const ROWS = [
  {
    id: "decode",
    stage: "decode",
    paths: ALL_PATHS,
    fixture: "hevc-sdr",
    profile: "h264-sdr",
    request: {},
    start: 0,
    seek: 20,
    span: 4,
    work: { decode: "path" },
    notBuilt: [],
    checks: [
      { check: "codec", codec: "h264", stage: false },
      { check: "dimensions", expect: "source" },
      { check: "frame-rate", expect: ["source"] },
      { check: "bit-depth", max: 8 },
    ],
  },
  {
    id: "deinterlace",
    stage: "deinterlace",
    paths: ALL_PATHS,
    fixture: "interlaced-mpeg2",
    profile: "h264-sdr",
    request: {},
    start: FEATURE_TEST_START,
    seek: 60,
    span: 4,
    work: { deinterlace: "path" },
    notBuilt: [],
    checks: [
      { check: "progressive", maxShare: 0.15, controlMin: 0.3 },
      { check: "codec", codec: "h264", stage: false },
      { check: "dimensions", expect: "source" },
      { check: "frame-rate", expect: ["source", "double"] },
    ],
  },
  {
    id: "scale",
    stage: "scale",
    paths: ALL_PATHS,
    fixture: "sdr-h264",
    profile: "h264-sdr",
    request: { quality: { maxHeight: 480 } },
    start: FEATURE_TEST_START,
    seek: 120,
    span: 4,
    work: { scale: "path" },
    notBuilt: [],
    checks: [
      { check: "scaled", maxHeight: 480 },
      { check: "dimensions", expect: "negotiated" },
      { check: "aspect", tolerance: 0.01 },
      { check: "codec", codec: "h264", stage: false },
      { check: "frame-rate", expect: ["source"] },
    ],
  },
  {
    id: "scale-variable-rate",
    stage: "scale",
    paths: ALL_PATHS,
    fixture: "vfr-h264",
    profile: "h264-sdr",
    request: { quality: { maxHeight: 240 } },
    start: 0,
    seek: 8,
    span: 6,
    work: { scale: "path" },
    notBuilt: [],
    checks: [
      { check: "scaled", maxHeight: 240 },
      { check: "dimensions", expect: "negotiated" },
      { check: "aspect", tolerance: 0.01 },
      { check: "codec", codec: "h264", stage: false },
      { check: "frame-rate", expect: ["base"] },
    ],
  },
  sdrScaled("scale-bt601", "sdr-bt601-patches"),
  sdrScaled("scale-bt2020", "sdr-bt2020-patches"),
  sdrScaled("scale-full-range", "sdr-full-range-patches"),
  {
    id: "hdr-to-sdr",
    stage: "hdr-to-sdr",
    paths: ALL_PATHS,
    fixture: "hdr10-hevc",
    profile: "h264-sdr",
    request: {},
    start: FEATURE_TEST_START,
    seek: 240,
    span: 4,
    work: { "tone-map": "path" },
    notBuilt: ["hdr-tone-mapping-requires-hardware"],
    checks: [
      { check: "hdr-removed" },
      { check: "sdr-tags" },
      { check: "hdr-metadata" },
      { check: "picture", at: 240, seconds: 2 },
      { check: "codec", codec: "h264", stage: false },
      { check: "bit-depth", max: 8 },
      { check: "dimensions", expect: "source" },
      { check: "frame-rate", expect: ["source"] },
    ],
  },
  toneMapped("hdr-to-sdr-patches", ALL_PATHS, "hdr10-patches", "hdr10"),
  toneMapped("hdr-to-sdr-hlg", ALL_PATHS, "hlg-patches", "hlg"),
  toneMapped("hdr-to-sdr-dv81", ALL_PATHS, "dv81-patches", "hdr10"),
  {
    id: "hdr-to-sdr-dv84",
    stage: "hdr-to-sdr",
    paths: ALL_PATHS,
    fixture: "dv84-iphone",
    profile: "h264-sdr",
    request: {},
    start: 0,
    seek: 20,
    span: 4,
    work: { "tone-map": "path" },
    notBuilt: ["hdr-tone-mapping-requires-hardware"],
    checks: [
      { check: "hdr-removed" },
      { check: "sdr-tags" },
      { check: "hdr-metadata" },
      { check: "picture", at: 21, seconds: 2 },
      { check: "codec", codec: "h264", stage: false },
      { check: "bit-depth", max: 8 },
      { check: "dimensions", expect: "source" },
      { check: "frame-rate", expect: ["source"] },
    ],
  },
  {
    id: "hdr-to-sdr-dv7",
    stage: "hdr-to-sdr",
    paths: ALL_PATHS,
    fixture: "dv7",
    profile: "h264-sdr",
    request: {},
    start: 0,
    seek: 20,
    span: 4,
    work: { "tone-map": "path" },
    notBuilt: ["hdr-tone-mapping-requires-hardware"],
    checks: [
      { check: "hdr-removed" },
      { check: "sdr-tags" },
      { check: "hdr-metadata" },
      { check: "picture", at: 21, seconds: 2 },
      { check: "codec", codec: "h264", stage: false },
      { check: "bit-depth", max: 8 },
      { check: "dimensions", expect: "negotiated" },
      { check: "frame-rate", expect: ["source"] },
    ],
  },
  {
    id: "hdr-to-sdr-dv5",
    stage: "hdr-to-sdr",
    paths: ALL_PATHS,
    fixture: "dv5-apple",
    profile: "h264-sdr",
    request: {},
    start: 12,
    seek: 24,
    span: 4,
    work: { "tone-map": "path" },
    notBuilt: ["hdr-tone-mapping-requires-hardware", "dolby-vision-not-convertible"],
    checks: [
      { check: "hdr-removed" },
      { check: "sdr-tags" },
      { check: "hdr-metadata" },
      { check: "picture", at: 25, seconds: 2 },
      { check: "codec", codec: "h264", stage: false },
      { check: "bit-depth", max: 8 },
      { check: "dimensions", expect: "source" },
      { check: "frame-rate", expect: ["source"] },
    ],
  },
  {
    id: "subtitle-burn-in",
    stage: "subtitle-burn-in",
    paths: ALL_PATHS,
    fixture: "image-subtitles",
    profile: "h264-sdr",
    request: { burnInSubtitle: "e13" },
    start: FEATURE_TEST_START,
    seek: 104,
    span: 6,
    work: { overlay: "path" },
    notBuilt: ["subtitle-not-burnable"],
    checks: [
      { check: "burned-in", shownAt: 108, hiddenAt: 105, band: 0.7, minBand: 0.01, maxElsewhere: 0.002 },
      { check: "codec", codec: "h264", stage: false },
      { check: "dimensions", expect: "source" },
      { check: "frame-rate", expect: ["source"] },
    ],
  },
  {
    id: "subtitle-burn-in-pgs",
    stage: "subtitle-burn-in",
    paths: ALL_PATHS,
    fixture: "pgs-subtitles",
    profile: "h264-sdr",
    request: { burnInSubtitle: "e2" },
    start: 0,
    seek: 20,
    span: 4,
    work: { overlay: "path" },
    notBuilt: ["subtitle-not-burnable"],
    checks: [
      { check: "burned-in", shownAt: 21, hiddenAt: 23, band: 0.7, minBand: 0.01, maxElsewhere: 0.002 },
      { check: "codec", codec: "h264", stage: false },
      { check: "dimensions", expect: "source" },
      { check: "frame-rate", expect: ["source"] },
    ],
  },
  {
    id: "subtitle-burn-in-text",
    stage: "subtitle-burn-in",
    paths: ALL_PATHS,
    fixture: "styled-subtitles",
    profile: "h264-sdr",
    request: { burnInSubtitle: "e2" },
    start: 0,
    seek: 20,
    span: 4,
    work: { text: "cpu", "encode-h264": "path" },
    notBuilt: ["subtitle-not-burnable"],
    checks: [
      {
        check: "burned-text",
        region: { x: 100, y: 840, width: 620, height: 120 },
        place: 2,
        colour: 12,
        edge: 16,
        minFill: 0.9,
      },
      { check: "codec", codec: "h264", stage: false },
      { check: "dimensions", expect: "source" },
      { check: "frame-rate", expect: ["source"] },
    ],
  },
  {
    id: "encode-h264",
    stage: "encode-h264",
    paths: ALL_PATHS,
    fixture: "sdr-h264",
    profile: "h264-sdr",
    request: { quality: { maxBitrate: 4_000_000 } },
    start: FEATURE_TEST_START,
    seek: 120,
    span: 4,
    work: { "encode-h264": "path" },
    notBuilt: ["no-transcode-target"],
    checks: [
      { check: "codec", codec: "h264", stage: true },
      { check: "profile", profiles: ["High", "Main", "Constrained Baseline"] },
      { check: "bit-depth", max: 8 },
      { check: "dimensions", expect: "source" },
      { check: "frame-rate", expect: ["source"] },
      { check: "bitrate", max: 8_000_000 },
    ],
  },
  {
    id: "encode-hevc",
    stage: "encode-hevc",
    paths: ALL_PATHS,
    fixture: "sdr-h264",
    profile: "hevc-sdr",
    request: {},
    start: FEATURE_TEST_START,
    seek: 120,
    span: 4,
    work: { "encode-hevc": "path" },
    notBuilt: ["no-transcode-target"],
    checks: [
      { check: "codec", codec: "hevc", stage: true },
      { check: "profile", profiles: ["Main"] },
      { check: "codec-tag", tag: "hvc1" },
      { check: "bit-depth", max: 8 },
      { check: "dimensions", expect: "source" },
      { check: "frame-rate", expect: ["source"] },
    ],
  },
  {
    id: "encode-av1",
    stage: "encode-av1",
    paths: ALL_PATHS,
    fixture: "sdr-h264",
    profile: "av1-sdr",
    request: {},
    start: FEATURE_TEST_START,
    seek: 120,
    span: 4,
    work: { "encode-av1": "path" },
    notBuilt: ["no-transcode-target"],
    checks: [
      { check: "codec", codec: "av1", stage: true },
      { check: "profile", profiles: ["Main"] },
      { check: "bit-depth", max: 8 },
      { check: "dimensions", expect: "source" },
      { check: "frame-rate", expect: ["source"] },
    ],
  },
  {
    id: "hybrid-cpu-decode",
    stage: "decode",
    paths: ["qsv", "vaapi"],
    fixture: "h264-10bit",
    profile: "h264-sdr",
    request: {},
    start: 0,
    seek: 20,
    span: 4,
    work: { decode: "cpu", "encode-h264": "path" },
    notBuilt: [],
    checks: [
      { check: "codec", codec: "h264", stage: false },
      { check: "bit-depth", max: 8 },
      { check: "dimensions", expect: "source" },
      { check: "frame-rate", expect: ["source"] },
    ],
  },
];

/** The checks every transcode cell gets, before its row's own. */
export const COMMON_CHECKS = [
  { check: "served" },
  { check: "clean" },
  { check: "duration", tolerance: 1 },
  { check: "timeline" },
  { check: "keyframes" },
  { check: "picture-time", frames: 1, minMatch: 0.7, tolerance: 0.01, flat: 1, pictured: 10, share: 0.6 },
  { check: "audio-start" },
];

/** Every cell of the table: one per row and path, in grid order. */
export const cells = (rows = ROWS) =>
  rows.flatMap((row) => row.paths.map((path) => ({ row, path, key: `${row.id}/${path}` })));

// ------------------------------------------------------------------------------------- parsers

const number = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** A frame rate such as `24/1` or `30000/1001` as a number; undefined when ffprobe has none. */
export const rate = (text) => {
  const [top, bottom = "1"] = String(text ?? "").split("/");
  const value = Number(top) / Number(bottom);
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

const depthOf = (stream) => {
  const raw = number(stream.bits_per_raw_sample);
  if (raw !== undefined) return raw;
  const format = stream.pix_fmt ?? "";
  if (/p010|p10/.test(format)) return 10;
  if (/p012|p12/.test(format)) return 12;
  return format === "" ? undefined : 8;
};

const known = (value) => (value === undefined || value === "unknown" || value === "N/A" ? undefined : value);

/**
 * The first video stream of `ffprobe -show_streams -show_format -of json`, as the checks read it:
 * codec, profile, size, bit depth, colour tags, field order, frame rate (the average, and the base
 * rate ffmpeg gives an encode), and the file's duration.
 */
export const parseProbe = (json) => {
  const parsed = typeof json === "string" ? JSON.parse(json) : json;
  const video = (parsed.streams ?? []).find((stream) => stream.codec_type === "video");
  if (video === undefined) return undefined;
  return {
    codec: video.codec_name,
    profile: known(video.profile),
    tag: known(video.codec_tag_string),
    width: number(video.width),
    height: number(video.height),
    pixFmt: video.pix_fmt,
    bitDepth: depthOf(video),
    transfer: known(video.color_transfer),
    primaries: known(video.color_primaries),
    space: known(video.color_space),
    range: known(video.color_range),
    fieldOrder: known(video.field_order),
    fps: rate(video.avg_frame_rate) ?? rate(video.r_frame_rate),
    baseFps: rate(video.r_frame_rate),
    duration: number(parsed.format?.duration) ?? number(video.duration),
  };
};

/**
 * The side data types of a video stream and its first picture, from `ffprobe -select_streams v:0
 * -read_intervals %+#1 -show_entries stream_side_data=side_data_type:frame_side_data=side_data_type`.
 */
export const parseSideData = (json) => {
  const parsed = typeof json === "string" ? JSON.parse(json) : json;
  const types = (items) => (items ?? []).map((item) => item.side_data_type).filter((type) => typeof type === "string");
  return { stream: types(parsed.streams?.[0]?.side_data_list), frame: types(parsed.frames?.[0]?.side_data_list) };
};

/** Frames of `ffprobe -show_entries frame=… -of json`, sorted by time: `{ pts, key, interlaced }`. */
export const parseFrames = (json) => {
  const parsed = typeof json === "string" ? JSON.parse(json) : json;
  return (parsed.frames ?? [])
    .map((frame) => ({
      pts: number(frame.pts_time) ?? number(frame.best_effort_timestamp_time),
      key: Number(frame.key_frame) === 1,
      interlaced: Number(frame.interlaced_frame) === 1,
    }))
    .filter((frame) => frame.pts !== undefined)
    .sort((a, b) => a.pts - b.pts);
};

/**
 * ffmpeg's `idet` as the `progressive` check runs it. By default `idet` calls a frame interlaced
 * when one of its two field-timing guesses fits 4 % better than the other; Quick Sync's
 * motion-adaptive output, free of combing, leans that far on half its frames (49-62 % read
 * interlaced on the demo's Feature Test). Woven fields lean far more: at 1.5 the source still
 * reads 52 %, and Quick Sync's and the CPU's outputs read 0 %.
 */
export const IDET = "idet=intl_thres=1.5";

/** The last `Multi frame detection` line of ffmpeg's `idet` filter: frame counts by kind. */
export const parseIdet = (text) => {
  const lines = String(text).match(/Multi frame detection:[^\n]*/g) ?? [];
  const last = lines.at(-1);
  if (last === undefined) return undefined;
  const count = (name) => Number(new RegExp(`${name}:\\s*(\\d+)`).exec(last)?.[1] ?? 0);
  return { tff: count("TFF"), bff: count("BFF"), progressive: count("Progressive"), undetermined: count("Undetermined") };
};

/** The share of frames `idet` decided were interlaced, of those it decided either way. */
export const interlacedShare = (idet) => {
  if (idet === undefined) return undefined;
  const decided = idet.tff + idet.bff + idet.progressive;
  return decided === 0 ? undefined : (idet.tff + idet.bff) / decided;
};

/**
 * Filters that print each frame's signalstats to standard output. `pipe:1`, not `/dev/stdout`,
 * which a socket (as Node's child processes get) can't open; the colon is escaped for both of
 * ffmpeg's parsing levels.
 */
export const PRINT_STATS = "signalstats,metadata=print:file=pipe\\\\:1";

/**
 * The mean of each `lavfi.signalstats.*` value over the frames `metadata=print` wrote, with the
 * number of frames.
 */
export const parseSignalstats = (text) => {
  const sums = {};
  const counts = {};
  for (const match of String(text).matchAll(/lavfi\.signalstats\.([A-Z]+)=(-?[\d.]+)/g)) {
    const [, name, value] = match;
    sums[name] = (sums[name] ?? 0) + Number(value);
    counts[name] = (counts[name] ?? 0) + 1;
  }
  const means = Object.fromEntries(Object.entries(sums).map(([name, sum]) => [name, sum / counts[name]]));
  return Object.keys(means).length === 0 ? undefined : { ...means, frames: counts.YAVG ?? 0 };
};

/** How far a picture's time may be searched from where the playlist puts it, in seconds. */
export const TIMING_WINDOW = 3;

/**
 * The thumbnails the picture-time check compares: 96x28 gray, the top 70 % of the picture, where a
 * burned-in subtitle never is. `showinfo` after them prints each one's time.
 */
export const THUMBNAIL = { width: 96, height: 28, filter: "scale=96:40,crop=96:28:0:0,format=gray,showinfo" };

/**
 * Raw gray thumbnails (`THUMBNAIL.filter`, `-f rawvideo`) with the times `showinfo` printed for
 * them, in order: `{ pts, spread, pixels }`, `spread` the standard deviation of their gray levels
 * and the pixels less their mean and scaled to unit length, so that two thumbnails' dot product is
 * their correlation. A thumbnail of one gray level has no pixels.
 */
export const parseThumbnails = (raw, log, { width, height } = THUMBNAIL) => {
  const size = width * height;
  const times = [...String(log).matchAll(/Parsed_showinfo_\d+[^\n]*\bn:\s*\d+[^\n]*\bpts_time:\s*(-?[\d.]+)/g)].map((match) => Number(match[1]));
  const count = Math.min(times.length, Math.floor(raw.length / size));
  return Array.from({ length: count }, (_, index) => {
    const bytes = raw.subarray(index * size, (index + 1) * size);
    let mean = 0;
    for (const value of bytes) mean += value;
    mean /= size;
    const pixels = new Float32Array(size);
    let norm = 0;
    for (let at = 0; at < size; at += 1) {
      pixels[at] = bytes[at] - mean;
      norm += pixels[at] * pixels[at];
    }
    if (norm === 0) return { pts: times[index], spread: 0, pixels: undefined };
    const scale = 1 / Math.sqrt(norm);
    for (let at = 0; at < size; at += 1) pixels[at] *= scale;
    return { pts: times[index], spread: Math.sqrt(norm / size), pixels };
  });
};

const correlation = (a, b) => {
  let sum = 0;
  for (let at = 0; at < a.length; at += 1) sum += a[at] * b[at];
  return sum;
};

/**
 * Judges every output thumbnail against the source's, one rule for each frame: it must show the
 * source's picture for its time, within `allowance` seconds. The source frame shown at its time is
 * one of three things by its own gray levels' spread: `flat` (under `flat`), pictured (`pictured`
 * or more: enough contrast that a right output can't be flat), or too faint to place (between,
 * such as a fade, where two near-black renderings of the same frame can fall either side of any
 * threshold). Over a pictured source frame, an output frame passes when the best of the source's
 * pictured frames shown within the allowance correlates at least `minMatch` and within `tolerance`
 * of its best match anywhere within `window` seconds, or when it is flat where a source frame
 * within the allowance is flat too (a cut); a flat one fails as `flat`, any other as `another`
 * time's picture. Over a flat source frame it passes unless it is pictured without matching a
 * pictured source frame within the allowance (`pictured`). A frame over a too-faint source frame is
 * not judged either way, and one no source frame is shown for within the allowance (the source's
 * thumbnails stop short, or none came back) cannot be. Returns the frame count, how many could not
 * be judged, how many were over a pictured, a flat, and a too-faint source frame, and each frame
 * that failed: its time, how, and how far away the source's best match lies (negative: the picture
 * comes late).
 */
export const judgeFrames = (output, source, { window, allowance, minMatch, tolerance, flat, pictured }) => {
  const spreadOf = (frame) => (frame.pixels === undefined ? 0 : (frame.spread ?? Number.POSITIVE_INFINITY));
  const isFlat = (frame) => spreadOf(frame) < flat;
  const isPictured = (frame) => spreadOf(frame) >= pictured;
  const gaps = source.slice(1).map((frame, index) => frame.pts - source[index].pts).sort((a, b) => a - b);
  const lastShown = gaps.length === 0 ? 0 : gaps[gaps.length >> 1];
  const until = (index) => source[index + 1]?.pts ?? source[index].pts + lastShown;
  const firstAfter = (time) => {
    let low = 0;
    let high = source.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (until(middle) <= time + 0.001) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const shownWithin = (from, to) => {
    const found = [];
    for (let index = firstAfter(from); index < source.length && source[index].pts < to + 0.001; index += 1) found.push(source[index]);
    return found;
  };
  const failed = [];
  let unjudged = 0;
  let faint = 0;
  let flatSource = 0;
  let picturedSource = 0;
  for (const frame of output) {
    const near = shownWithin(frame.pts - allowance, frame.pts + allowance);
    const [shown] = shownWithin(frame.pts, frame.pts);
    if (near.length === 0 || shown === undefined) {
      unjudged += 1;
      continue;
    }
    if (!isFlat(shown) && !isPictured(shown)) {
      faint += 1;
      continue;
    }
    if (isPictured(shown)) picturedSource += 1;
    else flatSource += 1;
    const score = (match) => (frame.pixels === undefined || !isPictured(match) ? -1 : correlation(frame.pixels, match.pixels));
    const nearest = Math.max(...near.map(score));
    let best = { score: nearest, at: frame.pts };
    for (const match of shownWithin(frame.pts - window, frame.pts + window)) {
      const value = score(match);
      if (value > best.score) best = { score: value, at: match.pts };
    }
    const matches = nearest >= minMatch && nearest >= best.score - tolerance;
    if (isPictured(shown)) {
      if (matches || (isFlat(frame) && near.some(isFlat))) continue;
      failed.push(
        isFlat(frame)
          ? { pts: frame.pts, how: "flat" }
          : { pts: frame.pts, how: "another", by: best.at - frame.pts, score: nearest, best: best.score },
      );
    } else if (isPictured(frame) && !matches) {
      failed.push({ pts: frame.pts, how: "pictured" });
    }
  }
  return { frames: output.length, unjudged, pictured: picturedSource, flat: flatSource, faint, failed };
};

/**
 * What the picture-time check reads of `judgeFrames`' result: how many frames, how many could not
 * be judged, how many were over a pictured, a flat, and a too-faint source frame (only pictured
 * ones carry timing), how many failed and how (`flat` where the source is pictured, `pictured`
 * where it is flat, `another` time's picture), the first that failed, and how far the source's best
 * match lies for the middle one of those showing another time's picture.
 */
export const frameTiming = (judged) => {
  const how = (kind) => judged.failed.filter((frame) => frame.how === kind);
  const offsets = how("another").map((frame) => frame.by).sort((a, b) => a - b);
  return {
    frames: judged.frames,
    unjudged: judged.unjudged,
    pictured: judged.pictured,
    flat: judged.flat,
    faint: judged.faint,
    failed: judged.failed.length,
    failures: { flat: how("flat").length, pictured: how("pictured").length, another: how("another").length },
    first: judged.failed[0]?.pts,
    by: offsets[offsets.length >> 1],
  };
};

/** Samples in one frame of each audio codec the grid's outputs and sources carry. */
const AUDIO_FRAME_SAMPLES = { aac: 1024, ac3: 1536, eac3: 1536, mp3: 1152, mp2: 1152, opus: 960, vorbis: 2048, dts: 512 };

/** How long one frame of `codec` at `sampleRate` lasts, in seconds; undefined when unknown. */
export const audioFrameSeconds = (codec, sampleRate) => {
  const samples = AUDIO_FRAME_SAMPLES[codec];
  const rate = Number(sampleRate);
  return samples === undefined || !(rate > 0) ? undefined : samples / rate;
};

/**
 * The earliest time at or after `time` that the audio `packets` (`{ pts, duration }`) sound: `time`
 * itself inside a packet, else the next packet's start; undefined after the last. A packet without
 * a duration lasts `frame`.
 */
export const soundFrom = (packets, time, frame) => {
  let next;
  for (const packet of packets) {
    if (!Number.isFinite(packet.pts)) continue;
    const lasts = packet.duration > 0 ? packet.duration : frame;
    if (packet.pts <= time + 0.001 && time < packet.pts + lasts) return time;
    if (packet.pts > time && (next === undefined || packet.pts < next)) next = packet.pts;
  }
  return next;
};

/** The most frames before its first picture that an encoder here decodes the first one, at the source's rate. */
const REORDER_FRAMES = 4;

/**
 * A media playlist: its init segment's URI and each segment's index, start, duration, and URI, all
 * resolved against `base`. Starts count from the playlist's first segment.
 */
export const parsePlaylist = (text, base) => {
  const lines = String(text).split("\n").map((line) => line.trim());
  const map = /#EXT-X-MAP:URI="([^"]+)"/.exec(text)?.[1];
  const segments = [];
  let start = 0;
  let duration;
  for (const line of lines) {
    if (line.startsWith("#EXTINF:")) duration = Number(line.slice(8).split(",")[0]);
    else if (line !== "" && !line.startsWith("#") && duration !== undefined) {
      segments.push({ index: segments.length, start, duration, uri: new URL(line, base).href });
      start += duration;
      duration = undefined;
    }
  }
  return { init: map === undefined ? undefined : new URL(map, base).href, segments, total: start };
};

/** The segments that cover `seconds` from `from`: from the one holding `from` to the one past its end. */
export const segmentsCovering = (segments, from, seconds) => {
  const first = segments.findIndex((segment) => segment.start + segment.duration > from + 1e-6);
  if (first < 0) return [];
  const taken = [];
  for (const segment of segments.slice(first)) {
    taken.push(segment);
    if (segment.start + segment.duration >= from + seconds - 1e-6) break;
  }
  return taken;
};

// The i915 driver names its engines; xe counts cycles per engine class.
const ENGINE_CLASSES = { rcs: "render", bcs: "copy", vcs: "video", vecs: "video-enhance", ccs: "compute" };

/**
 * What the watcher in the side's container printed: `seen <pid>` for each ffmpeg process on every
 * poll, `args <pid> <arguments joined by \x1f>` once, and `gpu <pid> <fd> <drm fdinfo line>`. Each
 * run comes back with its arguments, how many polls saw it, whether it held a GPU client, and its
 * busiest reading per engine (cumulative nanoseconds on i915, cycles on xe), summed over its
 * distinct clients.
 */
export const parseWatch = (text) => {
  const runs = new Map();
  const runOf = (pid) => {
    if (!runs.has(pid)) runs.set(pid, { pid, args: [], polls: 0, clients: new Map() });
    return runs.get(pid);
  };
  for (const line of String(text).split("\n")) {
    const seen = /^seen (\d+)$/.exec(line);
    if (seen) {
      runOf(seen[1]).polls += 1;
      continue;
    }
    const args = /^args (\d+) (.*)$/.exec(line);
    if (args) {
      runOf(args[1]).args = args[2].split("\x1f").filter((arg) => arg !== "");
      continue;
    }
    const gpu = /^gpu (\d+) (\d+) drm-([a-z-]+):\s*(\d+)/.exec(line);
    if (!gpu) continue;
    const [, pid, fd, key, value] = gpu;
    const run = runOf(pid);
    const client = run.clients.get(fd) ?? { id: fd, engines: {} };
    run.clients.set(fd, client);
    if (key === "client-id") client.id = value;
    const engine = /^engine-([a-z-]+)$/.exec(key)?.[1] ?? ENGINE_CLASSES[/^cycles-([a-z]+)$/.exec(key)?.[1]];
    if (engine !== undefined && !engine.startsWith("capacity")) {
      client.engines[engine] = Math.max(client.engines[engine] ?? 0, Number(value));
    }
  }
  return [...runs.values()].map(({ pid, args, polls, clients }) => {
    // Two descriptors of one client report the same counters: keep each client's busiest reading.
    const distinct = new Map();
    for (const client of clients.values()) {
      const kept = distinct.get(client.id) ?? {};
      for (const [engine, value] of Object.entries(client.engines)) kept[engine] = Math.max(kept[engine] ?? 0, value);
      distinct.set(client.id, kept);
    }
    const engines = {};
    for (const kept of distinct.values()) {
      for (const [engine, value] of Object.entries(kept)) engines[engine] = (engines[engine] ?? 0) + value;
    }
    return { pid: Number(pid), args, polls, gpu: distinct.size > 0, engines };
  });
};

/**
 * The runs that wrote this stream's segments: HLS runs whose output sits under
 * `/transcode/<streamId>/`. A burned-in text subtitle's preparation writes there too, as ASS and
 * fonts, and is no encode.
 */
export const streamRuns = (runs, streamId) =>
  runs.filter((run) => run.args.includes("hls") && run.args.some((arg) => arg.includes(`/${streamId}/`)));

/**
 * The media service's JSON log records for one playback session, and the hardware records that
 * name no session (`HardwareAcceleration.*`).
 */
export const sessionRecords = (text, sessionId) =>
  String(text)
    .split("\n")
    .flatMap((line) => {
      const start = line.indexOf('{"message":');
      if (start < 0) return [];
      try {
        return [JSON.parse(line.slice(start))];
      } catch {
        return [];
      }
    })
    .filter(
      (record) => record.annotations?.sessionId === sessionId || String(record.message).startsWith("HardwareAcceleration."),
    );

/** The encoder an output's bytes name, from the SEI text libx264 and libx265 write. */
export const fingerprint = (bytes) => {
  if (bytes.includes("x264 - core")) return "x264";
  if (bytes.includes("x265 (build")) return "x265";
  return undefined;
};

/** Hides playback tickets in text kept as evidence. */
export const redact = (text, token) => {
  let out = String(text).replace(/([?&](?:ticket|token)=)[^&"\s]+/g, "$1REDACTED");
  if (token) out = out.split(token).join("REDACTED");
  return out.replace(/("token"\s*:\s*")[^"]+"/g, '$1REDACTED"');
};

// ------------------------------------------------------------------------------- where work ran

const graphOf = (args) => {
  const graphs = [];
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === "-vf" || args[i] === "-filter_complex") graphs.push(args[i + 1]);
  }
  return graphs.join(";");
};

// A comma or semicolon escaped with a backslash is part of an option's value, not a separator.
const filterNames = (graph) =>
  [...new Set(graph.split(/(?<!\\)[,;]/).map((part) => part.replace(/\[[^\]]*\]/g, "").split("=")[0].trim()))].filter(
    (name) => name !== "",
  );

const optionAfter = (args, flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};

const seconds = (value) => `${(value / 1e9).toFixed(1)} s`;

/** One line naming what a run did where: its decode, filters, encoder, and GPU engine time. */
export const describeRun = (run) => {
  const decode = optionAfter(run.args, "-hwaccel") ?? "cpu";
  const encoder = optionAfter(run.args, "-c:v") ?? "?";
  const filters = filterNames(graphOf(run.args)).join(",");
  const busy = Object.entries(run.engines)
    .filter(([, value]) => value > 0)
    .map(([engine, value]) => `${engine} ${seconds(value)}`)
    .join(", ");
  const gpu = run.gpu ? `GPU ${busy === "" ? "idle" : busy}` : unsampled(run) ? `ended before a GPU sample (${run.polls} poll${run.polls === 1 ? "" : "s"})` : "no GPU client";
  return `decode ${decode}; filters ${filters || "none"}; encode ${encoder}; ${gpu}`;
};

/**
 * A run the watcher saw in fewer polls than this, without a GPU client, may have ended before it
 * opened one: its engine time is unknown, and only its arguments count.
 */
export const SAMPLED_POLLS = 3;

const unsampled = (run) => !run.gpu && (run.polls ?? SAMPLED_POLLS) < SAMPLED_POLLS;

/**
 * Whether one run did `operation` on `path` by WORK's rule, with the reason when not. A run too
 * short to sample passes a GPU engine rule on its arguments alone; `work` then wants engine time
 * from another run of the cell. A hybrid row's CPU operation (`beside` a GPU path's stages) is
 * judged by its arguments alone, since the run's other stages hold the GPU.
 */
export const ranOn = (operation, path, run, bytes, beside = false) => {
  const rule = WORK[operation]?.[path];
  if (rule === undefined) return { ok: false, why: `no rule for ${operation} on ${path}` };
  const joined = run.args.join(" ");
  const missing = rule.uses.find((pattern) => !pattern.test(joined));
  if (missing) return { ok: false, why: `${operation} not on ${path}: the arguments lack ${missing.source}` };
  const avoided = rule.avoids.find((pattern) => pattern.test(joined));
  if (avoided) return { ok: false, why: `${operation} not on ${path}: the arguments use ${avoided.source}` };
  if (rule.engine === "none" && run.gpu && !beside) {
    return { ok: false, why: `${operation} on ${path}, but the run holds a GPU client` };
  }
  const busy = rule.engine === "any" ? Object.values(run.engines).some((value) => value > 0) : (run.engines[rule.engine] ?? 0) > 0;
  if (rule.engine !== "none" && !busy && !unsampled(run)) {
    return { ok: false, why: `${operation} on ${path}: no GPU ${rule.engine === "any" ? "" : `${rule.engine} `}engine time` };
  }
  if (typeof rule.bytes === "string" && bytes !== rule.bytes) {
    return { ok: false, why: `${operation} on ${path}: the output lacks ${rule.bytes}'s fingerprint` };
  }
  if (rule.bytes === false && bytes !== undefined) {
    return { ok: false, why: `${operation} on ${path}: the output carries ${bytes}'s fingerprint` };
  }
  return { ok: true };
};

// ------------------------------------------------------------------------------------- checks

const near = (a, b, tolerance) => a !== undefined && b !== undefined && Math.abs(a - b) <= tolerance;

const fetchesOf = (obs) => [obs.fetches?.start, obs.fetches?.seek].filter((fetch) => fetch !== undefined);

const outputMedia = (obs) => obs.fetches?.seek?.media ?? obs.fetches?.start?.media;

/**
 * Judges the stream description of every fetch with `read`. The first fetch that fails decides, and
 * its evidence names the fetch; a fetch with no description fails. The start and the seek can be
 * served by different ffmpeg runs, so one right description says nothing about the other.
 */
const everyOutput = (obs, read) => {
  const fetches = fetchesOf(obs);
  if (fetches.length === 0) return no("no output was fetched");
  let last;
  for (const fetch of fetches) {
    if (fetch.media === undefined) return no(`the ${fetch.name} output has no stream description`);
    last = read(fetch.media);
    if (!last.ok) return { ...last, evidence: `${last.evidence} (${fetch.name})` };
  }
  return last;
};

const fmt = (value, digits = 2) => (value === undefined ? "?" : Number(value.toFixed(digits)).toString());

const ok = (evidence) => ({ ok: true, evidence });
const no = (evidence) => ({ ok: false, evidence });

/** A fetch's frames per second, from its frames' times, which survive any container rate tag. */
export const measuredFps = (frames) => {
  if (frames.length < 2) return undefined;
  return (frames.length - 1) / (frames.at(-1).pts - frames[0].pts);
};

/**
 * The checks, by name. Each has a class that decides what failing it means: `stage` (the stage
 * was left out: NOT-BUILT), `output` (the stream is broken or wrong: FAIL), or `path` (the stage
 * ran somewhere else: FAIL). A check's `stage` parameter overrides its class to stage or output.
 */
export const CHECKS = {
  served: {
    class: "output",
    run: (obs) => {
      const broken = fetchesOf(obs).find((fetch) => !fetch.ok);
      if (fetchesOf(obs).length < 2) return no("the start and the seek were not both fetched");
      if (broken) return no(`the ${broken.name} fetch failed: ${broken.error}`);
      return ok(fetchesOf(obs).map((fetch) => `${fetch.name} ${fetch.segments.length} segments`).join(", "));
    },
  },
  clean: {
    class: "output",
    run: (obs) => {
      const dirty = fetchesOf(obs).find((fetch) => (fetch.decodeErrors ?? "").trim() !== "");
      return dirty ? no(`the ${dirty.name} output does not decode cleanly: ${dirty.decodeErrors.trim().split("\n")[0]}`) : ok("decodes cleanly");
    },
  },
  duration: {
    class: "output",
    run: (obs, params) => {
      const total = obs.fetches?.start?.total;
      const source = obs.source?.duration;
      if (!near(total, source, params.tolerance)) return no(`the playlist lasts ${fmt(total)} s, the source ${fmt(source)} s`);
      return ok(`playlist ${fmt(total, 1)} s of ${fmt(source, 1)} s`);
    },
  },
  timeline: {
    class: "output",
    run: (obs) => {
      for (const fetch of fetchesOf(obs)) {
        const first = fetch.segments[0];
        const last = fetch.segments.at(-1);
        const frames = fetch.frames ?? [];
        const fps = measuredFps(frames);
        if (first === undefined || frames.length === 0 || fps === undefined) return no(`the ${fetch.name} output has no frames`);
        const step = 1 / fps;
        if (!near(frames[0].pts, first.start, step + 0.05)) {
          return no(`the ${fetch.name} output starts at ${fmt(frames[0].pts, 3)} s, its first segment at ${fmt(first.start, 3)} s`);
        }
        const end = last.start + last.duration;
        if (!near(frames.at(-1).pts + step, end, 2 * step + 0.05)) {
          return no(`the ${fetch.name} output ends at ${fmt(frames.at(-1).pts + step, 3)} s, its last segment at ${fmt(end, 3)} s`);
        }
        const expected = (end - first.start) * fps;
        if (Math.abs(frames.length - expected) > 2) {
          return no(`the ${fetch.name} output has ${frames.length} frames for ${fmt(end - first.start)} s at ${fmt(fps)} fps`);
        }
      }
      const covered = (fetch) => {
        const last = fetch.segments.at(-1);
        return `${fetch.name} ${fmt(fetch.segments[0].start, 1)}-${fmt(last.start + last.duration, 1)} s, ${fetch.frames.length} frames`;
      };
      return ok(fetchesOf(obs).map(covered).join("; "));
    },
  },
  keyframes: {
    class: "output",
    run: (obs) => {
      for (const fetch of fetchesOf(obs)) {
        const fps = measuredFps(fetch.frames ?? []) ?? 24;
        for (const segment of fetch.segments) {
          const first = (fetch.frames ?? []).find((frame) => frame.pts >= segment.start - 0.5 / fps);
          if (!first?.key) return no(`the ${fetch.name} segment at ${fmt(segment.start, 3)} s does not start on a keyframe`);
        }
      }
      return ok("every segment starts on a keyframe");
    },
  },
  // Every frame of each fetch against the source's picture for its time: left alone, Quick Sync's
  // filters on ffmpeg 7.1 hold a first picture for 41 to 666 frames, every timestamp in place.
  "picture-time": {
    class: "output",
    run: (obs, params) => {
      const said = [];
      for (const fetch of fetchesOf(obs)) {
        const timing = obs.analysis?.timing?.[fetch.name];
        const expected = (fetch.frames ?? []).length;
        if (timing === undefined) return no(`could not measure: the ${fetch.name} picture was not compared with the source`);
        if (timing.error !== undefined) return no(`could not measure the ${fetch.name} picture: ${timing.error}`);
        if (expected === 0 || timing.frames !== expected) {
          return no(`could not measure: thumbnails of ${timing.frames} of the ${fetch.name} output's ${expected} frames`);
        }
        if (timing.unjudged > 0) {
          return no(`could not measure: the source's thumbnails reach ${timing.frames - timing.unjudged} of the ${fetch.name} output's ${timing.frames} frames`);
        }
        const counts = `${timing.pictured} pictured, ${timing.flat} flat, ${timing.faint} too faint of ${timing.frames}; ${timing.failed} failed`;
        if (timing.pictured < params.share * timing.frames) {
          return no(`could not measure: the source is pictured under ${fmt(params.share * 100, 0)}% of the ${fetch.name} output's frames (${counts})`);
        }
        if (timing.failed > params.frames) {
          const how = [
            timing.failures.flat > 0 ? `${timing.failures.flat} flat where the source shows a picture` : undefined,
            timing.failures.pictured > 0 ? `${timing.failures.pictured} showing a picture where the source is flat` : undefined,
            timing.failures.another > 0
              ? `${timing.failures.another} showing another time's picture (typically ${fmt(Math.abs(timing.by), 3)} s ${timing.by < 0 ? "earlier" : "later"})`
              : undefined,
          ].filter(Boolean);
          return no(`${timing.failed} of the ${fetch.name} output's ${timing.frames} frames do not show the source's picture for their time, from ${fmt(timing.first, 3)} s: ${how.join(", ")} (${counts})`);
        }
        said.push(`${fetch.name} ${counts}`);
      }
      return ok(`frames showing the source's picture for their time: ${said.join("; ")}`);
    },
  },
  // Each fetch's sound starts where the source's does at that position, within an audio frame of its
  // codec and sample rate: by the time the source sounds at the first picture, and no earlier than the
  // source sounds at the first decoded video packet, where the muxer cuts a fragment when the encoder
  // reorders pictures (at most REORDER_FRAMES before the picture).
  "audio-start": {
    class: "output",
    run: (obs) => {
      const said = [];
      const rate = obs.source?.baseFps ?? obs.source?.fps;
      const negotiated = obs.negotiation?.body?.audio;
      for (const fetch of fetchesOf(obs)) {
        const audio = fetch.audio;
        const source = fetch.sourceAudio;
        const first = fetch.frames?.[0]?.pts;
        if (negotiated === undefined || negotiated === null) {
          if (audio !== undefined) return no(`the ${fetch.name} output has audio no negotiation asked for`);
          said.push(`${fetch.name} none, as negotiated`);
          continue;
        }
        if (audio === undefined) return no(`the ${fetch.name} output has no audio`);
        const frame = audioFrameSeconds(audio.codec, audio.sampleRate);
        if (frame === undefined) return no(`could not measure: the ${fetch.name} audio's frame length (${audio.codec} at ${audio.sampleRate} Hz)`);
        if (source?.error !== undefined) return no(`could not measure the source's audio at the ${fetch.name}: ${source.error}`);
        const sourceFrame = audioFrameSeconds(source?.codec, source?.sampleRate);
        if (first === undefined || !Number.isFinite(fetch.firstDecoded) || !(rate > 0) || sourceFrame === undefined) {
          return no(`could not measure: the ${fetch.name} output's first picture, its first decoded packet, or the source's audio`);
        }
        const cut = Math.max(fetch.firstDecoded, first - REORDER_FRAMES / rate);
        const latest = soundFrom(source.packets, first, sourceFrame);
        const earliest = soundFrom(source.packets, cut, sourceFrame);
        if (latest === undefined || earliest === undefined) return no(`could not measure: the source has no sound at or after the ${fetch.name}'s ${fmt(first, 3)} s`);
        const lead = audio.start - first;
        const offset = `${fetch.name} audio starts ${fmt(Math.abs(lead) * 1000, 0)} ms ${lead < 0 ? "before" : "after"} its first picture`;
        if (audio.start > latest + frame + 0.001) {
          return no(`the ${offset}, where the source sounds ${fmt((latest - first) * 1000, 0)} ms after it`);
        }
        if (audio.start < earliest - frame - 0.001) {
          return no(`the ${offset}, before the source sounds there (${fmt((earliest - first) * 1000, 0)} ms)`);
        }
        said.push(`${fetch.name} ${lead >= 0 ? "+" : ""}${fmt(lead * 1000, 0)} ms (source ${latest - first >= 0 ? "+" : ""}${fmt((latest - first) * 1000, 0)})`);
      }
      return ok(`audio starts where the source's does: ${said.join(", ")}`);
    },
  },
  codec: {
    class: "output",
    run: (obs, params) =>
      everyOutput(obs, (media) =>
        media.codec === params.codec ? ok(`${media.codec}`) : no(`the output is ${media.codec ?? "missing"}, not ${params.codec}`),
      ),
  },
  profile: {
    class: "output",
    run: (obs, params) =>
      everyOutput(obs, ({ profile }) =>
        params.profiles.includes(profile) ? ok(`profile ${profile}`) : no(`profile ${profile ?? "unknown"}, not ${params.profiles.join(" or ")}`),
      ),
  },
  "codec-tag": {
    class: "output",
    run: (obs, params) =>
      everyOutput(obs, ({ tag }) => (tag === params.tag ? ok(`tagged ${tag}`) : no(`tagged ${tag ?? "nothing"}, not ${params.tag}`))),
  },
  "bit-depth": {
    class: "output",
    run: (obs, params) =>
      everyOutput(obs, ({ bitDepth: depth }) =>
        depth !== undefined && depth <= params.max ? ok(`${depth}-bit`) : no(`${depth ?? "unknown"}-bit, above ${params.max}`),
      ),
  },
  dimensions: {
    class: "output",
    run: (obs, params) => {
      const told = obs.negotiation?.body?.video;
      const want = params.expect === "source" ? obs.source : told;
      const size = (item) => `${item?.width ?? "?"}x${item?.height ?? "?"}`;
      return everyOutput(obs, (media) => {
        if (media.width !== want?.width || media.height !== want?.height) {
          return no(`the output is ${size(media)}, expected ${size(want)} (${params.expect})`);
        }
        if (told !== undefined && (told.width !== media.width || told.height !== media.height)) {
          return no(`the output is ${size(media)}, but negotiation said ${size(told)}`);
        }
        return ok(size(media));
      });
    },
  },
  aspect: {
    class: "output",
    run: (obs, params) => {
      const source = obs.source?.width / obs.source?.height;
      return everyOutput(obs, (media) => {
        const out = media.width / media.height;
        return Math.abs(out - source) / source <= params.tolerance
          ? ok(`aspect ${fmt(out, 3)} of ${fmt(source, 3)}`)
          : no(`aspect ${fmt(out, 3)}, the source ${fmt(source, 3)}`);
      });
    },
  },
  scaled: {
    class: "stage",
    run: (obs, params) =>
      everyOutput(obs, ({ height }) =>
        height !== undefined && height <= params.maxHeight
          ? ok(`scaled to ${height} lines`)
          : no(`the output keeps ${height ?? "?"} lines, above ${params.maxHeight}`),
      ),
  },
  "frame-rate": {
    class: "output",
    run: (obs, params) => {
      const source = obs.source?.fps;
      const allowed = params.expect.map((kind) => ({ double: source * 2, base: obs.source?.baseFps })[kind] ?? source);
      for (const fetch of fetchesOf(obs)) {
        const fps = measuredFps(fetch.frames ?? []);
        if (!allowed.some((want) => near(fps, want, want * 0.01))) {
          return no(`the ${fetch.name} output runs at ${fmt(fps)} fps, the source at ${fmt(source)}`);
        }
      }
      return ok(`${fmt(measuredFps(obs.fetches.seek.frames))} fps (source ${fmt(source)})`);
    },
  },
  bitrate: {
    class: "output",
    run: (obs, params) => {
      const fetch = obs.fetches?.seek;
      const seconds = fetch.segments.reduce((sum, segment) => sum + segment.duration, 0);
      const bits = fetch.segments.reduce((sum, segment) => sum + segment.bytes, 0) * 8;
      const rate = bits / seconds;
      return rate <= params.max ? ok(`${fmt(rate / 1e6, 1)} Mb/s`) : no(`${fmt(rate / 1e6, 1)} Mb/s, above ${fmt(params.max / 1e6, 1)}`);
    },
  },
  progressive: {
    class: "stage",
    run: (obs, params) => {
      const share = interlacedShare(obs.analysis?.idet?.output);
      const control = interlacedShare(obs.analysis?.idet?.source);
      if (control === undefined || control < params.controlMin) {
        return { ok: false, class: "output", evidence: `idet finds no combing in the source (${fmt((control ?? 0) * 100, 0)}%), so it can't tell` };
      }
      if (share === undefined) return { ok: false, class: "output", evidence: "idet decided no output frame" };
      return share <= params.maxShare
        ? ok(`idet ${fmt(share * 100, 0)}% interlaced (source ${fmt(control * 100, 0)}%)`)
        : no(`idet still finds ${fmt(share * 100, 0)}% of frames interlaced (source ${fmt(control * 100, 0)}%)`);
    },
  },
  "hdr-removed": {
    class: "stage",
    run: (obs) =>
      everyOutput(obs, (media) => {
        const hdr = ["smpte2084", "arib-std-b67"].includes(media.transfer) || media.primaries === "bt2020";
        return hdr ? no(`the output is still ${media.transfer}/${media.primaries}`) : ok("no HDR tags");
      }),
  },
  "sdr-tags": {
    class: "output",
    run: (obs) =>
      everyOutput(obs, (media) => {
        const tags = `${media.transfer ?? "untagged"}/${media.primaries ?? "untagged"}/${media.space ?? "untagged"}/${media.range ?? "untagged"}`;
        return media.transfer === "bt709" && media.primaries === "bt709" && media.space === "bt709" && media.range !== "pc"
          ? ok(`tagged ${tags}`)
          : no(`tagged ${tags}, not bt709/bt709/bt709 in limited range`);
      }),
  },
  // HDR metadata left on an SDR stream: the encoders write what ffmpeg's frames carry into the
  // bitstream, and a player that reads it shows the SDR picture as HDR.
  "hdr-metadata": {
    class: "output",
    run: (obs) => {
      const fetches = fetchesOf(obs);
      if (fetches.length === 0) return no("no output was fetched");
      for (const fetch of fetches) {
        if (fetch.sideData === undefined) return no(`could not measure: no side data was read from the ${fetch.name} output`);
        const left = [...fetch.sideData.stream, ...fetch.sideData.frame].filter((type) => HDR_SIDE_DATA.test(type));
        if (left.length > 0) return no(`the ${fetch.name} output still carries ${[...new Set(left)].join(", ")}`);
      }
      return ok("no HDR metadata on the stream or its first picture");
    },
  },
  // The colour an SDR source states, carried to the output: its transfer, primaries, matrix, and range.
  "source-tags": {
    class: "output",
    run: (obs) =>
      everyOutput(obs, (media) => {
        const tags = (of) => `${of?.transfer ?? "untagged"}/${of?.primaries ?? "untagged"}/${of?.space ?? "untagged"}/${of?.range ?? "untagged"}`;
        return tags(media) === tags(obs.source) ? ok(`tagged ${tags(media)} as the source`) : no(`tagged ${tags(media)}, the source ${tags(obs.source)}`);
      }),
  },
  colour: {
    class: "output",
    run: (obs, params) => {
      const colour = obs.analysis?.colour;
      if (colour === undefined) return no("could not measure: no patches were read");
      if (colour.error !== undefined) return no(`could not measure: ${colour.error}`);
      const verdict = judgePatches(colour.measured, colour.expected, colour.patches, params.tolerance);
      return verdict.ok ? ok(`patches at ${params.at} s against the ${params.reference} reference, ${verdict.evidence}`) : no(`patches at ${params.at} s against the ${params.reference} reference: ${verdict.evidence}`);
    },
  },
  picture: {
    class: "output",
    run: (obs) => {
      const out = obs.analysis?.picture?.output;
      const ref = obs.analysis?.picture?.reference;
      if (out === undefined || ref === undefined) return no("no picture statistics");
      return pictureSane(out, ref);
    },
  },
  "burned-in": {
    class: "stage",
    run: (obs, params) => {
      const shown = obs.analysis?.burn?.shown;
      const hidden = obs.analysis?.burn?.hidden;
      if (shown === undefined || hidden === undefined) return { ok: false, class: "output", evidence: "no frames to compare" };
      if (![shown.band, shown.elsewhere, hidden.band].every(Number.isFinite)) {
        return { ok: false, class: "output", evidence: "the frame comparison produced no statistics" };
      }
      const pct = (value) => `${fmt(value * 100, 2)}%`;
      const summary = `${pct(shown.band)} of the subtitle band changed at ${params.shownAt} s, ${pct(shown.elsewhere)} elsewhere; ${pct(hidden.band)} at ${params.hiddenAt} s`;
      if (shown.band < params.minBand) return no(`no subtitle drawn: ${summary}`);
      if (shown.elsewhere > params.maxElsewhere || hidden.band > params.maxElsewhere) {
        return { ok: false, class: "output", evidence: `pixels changed outside the subtitle: ${summary}` };
      }
      return ok(summary);
    },
  },
  "burned-text": {
    class: "stage",
    run: (obs, params) => judgeText(obs.analysis?.text, params),
  },
  work: {
    class: "path",
    run: (obs, params, cell) => {
      const runs = obs.runs ?? [];
      if (runs.length === 0) return no("no ffmpeg run of this stream was seen");
      const encode = encodeOperation(cell.row);
      const wantMode = `transcode-${PATHS[encode === undefined ? cell.path : where(cell, encode)].encoder}`;
      const mode = obs.negotiation?.body?.mode;
      if (mode !== wantMode) return no(`negotiated ${mode}, not ${wantMode}`);
      const changed = (obs.log ?? []).find((record) => record.message === "Stream.mode_changed");
      if (changed) return no(`the service moved the stream to ${changed.annotations?.to} (${changed.annotations?.reason})`);
      const bytes = obs.fetches?.seek?.fingerprint ?? obs.fetches?.start?.fingerprint;
      for (const [operation] of Object.entries(cell.row.work)) {
        const path = where(cell, operation);
        for (const run of runs) {
          const ran = ranOn(operation, path, run, bytes, path === "cpu" && cell.path !== "cpu");
          if (!ran.ok) return no(`${ran.why} (${describeRun(run)})`);
        }
        const engine = WORK[operation][path].engine;
        if (engine !== "none" && !runs.some((run) => Object.values(run.engines).some((value) => value > 0))) {
          return no(`${operation} on ${path}: no run showed GPU engine time`);
        }
      }
      const described = [...new Set(runs.map(describeRun))];
      return ok(`${mode}; ${runs.length} ffmpeg run${runs.length === 1 ? "" : "s"}: ${described.join(" | ")}`);
    },
  },
};

/**
 * The row's operations some run of the stream attempted on any path, by WORK's argument patterns
 * (a rule with none, such as a CPU decode, can't tell).
 */
export const attempted = (row, runs) =>
  Object.keys(row.work).filter((operation) =>
    Object.values(WORK[operation] ?? {}).some(
      (rule) => rule.uses.length > 0 && runs.some((run) => rule.uses.every((pattern) => pattern.test(run.args.join(" ")))),
    ),
  );

const encodeOperation = (row) => Object.keys(row.work).find((operation) => operation.startsWith("encode-"));

/** Where `operation` must run for `cell`: the cell's path unless the row fixes it. */
export const where = (cell, operation) => {
  const location = cell.row.work[operation] ?? "path";
  return location === "path" ? cell.path : location;
};

/**
 * What `region` of a frame shows, from three RGB pictures of one size: the served frame, the
 * source frame at its time, and the reference libass render of that frame. The subtitle is where
 * the reference differs from the source by more than 40 levels in a channel (`drawn`), and what the
 * served frame drew is where it differs from the source (`served`). Returns each one's bounding
 * box, the drawn pixels' share of their box (a block font fills it), the served frame's and the
 * reference's mean colour over the drawn pixels, and the mean difference to the reference in a
 * ring three pixels wide around the box, where a doubled or haloed edge shows.
 */
export const measureText = (output, source, reference, width, region) => {
  const at = (x, y) => (y * width + x) * 3;
  const differs = (a, b, offset) =>
    Math.max(Math.abs(a[offset] - b[offset]), Math.abs(a[offset + 1] - b[offset + 1]), Math.abs(a[offset + 2] - b[offset + 2])) > 40;
  const boxOf = (picture) => {
    let box;
    let count = 0;
    for (let y = region.y; y < region.y + region.height; y += 1) {
      for (let x = region.x; x < region.x + region.width; x += 1) {
        if (!differs(picture, source, at(x, y))) continue;
        count += 1;
        box = box === undefined
          ? { left: x, top: y, right: x, bottom: y }
          : { left: Math.min(box.left, x), top: Math.min(box.top, y), right: Math.max(box.right, x), bottom: Math.max(box.bottom, y) };
      }
    }
    return box === undefined ? undefined : { ...box, count };
  };
  const drawn = boxOf(reference);
  const served = boxOf(output);
  if (drawn === undefined) return { drawn, served };
  const sums = { output: [0, 0, 0], reference: [0, 0, 0] };
  let ring = 0;
  let ringCount = 0;
  for (let y = drawn.top - 3; y <= drawn.bottom + 3; y += 1) {
    for (let x = drawn.left - 3; x <= drawn.right + 3; x += 1) {
      const offset = at(x, y);
      const inside = x >= drawn.left && x <= drawn.right && y >= drawn.top && y <= drawn.bottom;
      if (inside && differs(reference, source, offset)) {
        for (let channel = 0; channel < 3; channel += 1) {
          sums.output[channel] += output[offset + channel];
          sums.reference[channel] += reference[offset + channel];
        }
      } else if (!inside) {
        for (let channel = 0; channel < 3; channel += 1) ring += Math.abs(output[offset + channel] - reference[offset + channel]);
        ringCount += 3;
      }
    }
  }
  const mean = (values) => values.map((value) => value / drawn.count);
  const area = (box) => (box.right - box.left + 1) * (box.bottom - box.top + 1);
  return {
    drawn,
    served,
    fill: drawn.count / area(drawn),
    colour: { output: mean(sums.output), reference: mean(sums.reference) },
    ring: ringCount === 0 ? 0 : ring / ringCount,
  };
};

/**
 * Judges the text a fetch's frame shows against the reference render of the same source frame:
 * the served subtitle's box within `place` pixels of the reference's on every edge, its mean colour
 * within `colour` levels in each channel, the reference's drawn pixels filling `minFill` of its
 * box (the block font drew it, not a fallback), and the ring around it within `edge` levels. A
 * frame with nothing drawn fails as a missing stage; one that could not be measured fails, never
 * passes.
 */
export const judgeText = (text, params) => {
  if (text === undefined || Object.keys(text).length === 0) return { ok: false, class: "output", evidence: "could not measure: no frames to compare" };
  const lines = [];
  for (const [name, frame] of Object.entries(text)) {
    if (frame.error !== undefined) return { ok: false, class: "output", evidence: `could not measure the ${name} frame: ${frame.error}` };
    const { drawn, served } = frame;
    if (drawn === undefined) return { ok: false, class: "output", evidence: `could not measure the ${name} frame: the reference drew nothing in the region` };
    if (served === undefined) return no(`no subtitle drawn in the ${name} frame at ${frame.at} s`);
    const off = Math.max(
      Math.abs(served.left - drawn.left),
      Math.abs(served.top - drawn.top),
      Math.abs(served.right - drawn.right),
      Math.abs(served.bottom - drawn.bottom),
    );
    const colour = frame.colour.output.map((value, channel) => Math.abs(value - frame.colour.reference[channel]));
    const facts = `${name} at ${frame.at} s: box ${served.left},${served.top}-${served.right},${served.bottom} (reference ${drawn.left},${drawn.top}-${drawn.right},${drawn.bottom}), colour ${frame.colour.output.map((value) => fmt(value, 0)).join("/")} (${frame.colour.reference.map((value) => fmt(value, 0)).join("/")}), fill ${fmt(frame.fill * 100, 1)}%, edge ${fmt(frame.ring, 1)}`;
    if (frame.fill < params.minFill) return { ok: false, class: "output", evidence: `not drawn in its own font: ${facts}` };
    if (off > params.place) return { ok: false, class: "output", evidence: `misplaced by ${off} px: ${facts}` };
    if (Math.max(...colour) > params.colour) return { ok: false, class: "output", evidence: `off colour by ${fmt(Math.max(...colour), 0)}: ${facts}` };
    if (frame.ring > params.edge) return { ok: false, class: "output", evidence: `edges differ: ${facts}` };
    lines.push(facts);
  }
  return ok(lines.join("; "));
};

/**
 * Sanity bounds on a tone-mapped picture against the reference tone map of the same frames, both
 * as signalstats means (8-bit): not black or dark, not washed out (contrast and saturation well
 * below the reference), not blown out, and no green or purple cast (mean chroma off the
 * reference's).
 */
export const pictureSane = (out, ref) => {
  const contrast = (stats) => stats.YHIGH - stats.YLOW;
  const facts = [
    `Y ${fmt(out.YAVG, 0)} (ref ${fmt(ref.YAVG, 0)})`,
    `contrast ${fmt(contrast(out), 0)} (${fmt(contrast(ref), 0)})`,
    `saturation ${fmt(out.SATAVG, 1)} (${fmt(ref.SATAVG, 1)})`,
    `U ${fmt(out.UAVG, 0)} V ${fmt(out.VAVG, 0)} (${fmt(ref.UAVG, 0)} ${fmt(ref.VAVG, 0)})`,
  ].join(", ");
  if (out.YAVG < Math.max(20, ref.YAVG * 0.4)) return no(`dark or black: ${facts}`);
  if (out.YAVG > ref.YAVG + 60) return no(`blown out: ${facts}`);
  if (contrast(out) < contrast(ref) * 0.6 || out.SATAVG < ref.SATAVG * 0.6) return no(`washed out: ${facts}`);
  if (Math.abs(out.UAVG - ref.UAVG) > 8 || Math.abs(out.VAVG - ref.VAVG) > 8) return no(`colour cast: ${facts}`);
  return ok(facts);
};

// ------------------------------------------------------------------------------------- verdicts

/**
 * The verdict for one cell from what the runner observed: `{ verdict, evidence, checks }`, with
 * one line of evidence. In order: SKIPPED for an absent fixture or device; NOT-BUILT for a
 * refusal the row lists, FAIL for any other; FAIL when the stream broke; when a stage check finds
 * the stage left out, NOT-BUILT if no run attempted it and FAIL if one did; FAIL for a wrong
 * output; FAIL when the stage ran elsewhere; else PASS.
 */
export const judge = (cell, obs) => {
  if (obs.skipped) return { verdict: "SKIPPED", evidence: obs.skipped, checks: [] };
  const negotiation = obs.negotiation;
  if (negotiation === undefined) return { verdict: "FAIL", evidence: "no negotiation", checks: [] };
  if (!negotiation.ok) {
    const reason = negotiation.body?.reason;
    const said = `negotiation answered ${negotiation.status} ${negotiation.body?._tag ?? ""}${reason ? ` ${reason}` : ""}`.trim();
    return cell.row.notBuilt.includes(reason)
      ? { verdict: "NOT-BUILT", evidence: said, checks: [] }
      : { verdict: "FAIL", evidence: `${said}${negotiation.error ? `: ${negotiation.error}` : ""}`, checks: [] };
  }
  if (negotiation.body?.mode === "direct") {
    return { verdict: "FAIL", evidence: "negotiation chose direct play, so the row does not force its stage", checks: [] };
  }
  const specs = [...COMMON_CHECKS, ...cell.row.checks, { check: "work" }];
  const checks = specs.map((spec) => {
    const check = CHECKS[spec.check];
    if (check === undefined) return { name: spec.check, class: "output", ok: false, evidence: `no check named ${spec.check}` };
    let result;
    try {
      result = check.run(obs, spec, cell);
    } catch (error) {
      result = { ok: false, class: "output", evidence: `${spec.check} could not run: ${error.message}` };
    }
    const kind = spec.stage === true ? "stage" : spec.stage === false ? "output" : check.class;
    return { name: spec.check, class: result.class ?? kind, ok: result.ok, evidence: result.evidence };
  });
  const firstFailing = (kind, names) =>
    checks.find((check) => !check.ok && check.class === kind && (names === undefined || names.includes(check.name)));
  const broken = firstFailing("output", ["served", "clean"]);
  if (broken) return { verdict: "FAIL", evidence: `${broken.name}: ${broken.evidence}`, checks };
  const missing = firstFailing("stage");
  if (missing) {
    const tried = attempted(cell.row, obs.runs ?? []);
    return tried.length === 0
      ? { verdict: "NOT-BUILT", evidence: `${missing.name}: ${missing.evidence}`, checks }
      : { verdict: "FAIL", evidence: `${missing.name}: the service ran ${tried.join(", ")}, but ${missing.evidence}`, checks };
  }
  const wrong = firstFailing("output");
  if (wrong) return { verdict: "FAIL", evidence: `${wrong.name}: ${wrong.evidence}`, checks };
  const elsewhere = firstFailing("path");
  if (elsewhere) return { verdict: "FAIL", evidence: `${elsewhere.name}: ${elsewhere.evidence}`, checks };
  const media = outputMedia(obs);
  const shown = checks.filter((check) => check.class === "stage" && check.name !== "codec").map((check) => check.evidence);
  // What the picture check found pictured, flat, too faint, and failed, so a PASS says what it covered.
  const timed = checks.filter((check) => check.name === "picture-time").map((check) => check.evidence);
  const work = checks.find((check) => check.name === "work");
  const fps = measuredFps(obs.fetches.seek.frames);
  const output = `${media.codec} ${media.profile ?? ""} ${media.width}x${media.height} ${media.bitDepth}-bit ${fmt(fps)} fps`;
  return { verdict: "PASS", evidence: [output.replace(/\s+/g, " "), ...shown, ...timed, work.evidence].join("; "), checks };
};

// ----------------------------------------------------------------------------------------- grid

const cellLine = (result) => `${result.verdict}: ${result.evidence}`;

const tsvField = (value) => String(value ?? "").replace(/[\t\n]+/g, " ");

/** The grid files for every measured cell: `{ tsv, md, json }`. `results` hold `side`, `row`, `path`, and the verdict. */
export const renderGrid = (results, { run, rows = ROWS } = {}) => {
  const known = new Set(rows.map((row) => row.id));
  const kept = results.filter((result) => known.has(result.row) && result.path in PATHS);
  const order = (result) => [
    ["after", "before"].indexOf(result.side),
    rows.findIndex((row) => row.id === result.row),
    Object.keys(PATHS).indexOf(result.path),
  ];
  kept.sort((a, b) => {
    const [x, y] = [order(a), order(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
  const header = ["side", "stage", "row", "path", "verdict", "evidence", "measured", "cell"];
  const tsv = `${[header, ...kept.map((result) => [result.side, result.stage, result.row, result.path, result.verdict, result.evidence, result.measured, result.cell])]
    .map((fields) => fields.map(tsvField).join("\t"))
    .join("\n")}\n`;

  const sides = [...new Set(kept.map((result) => result.side))];
  const paths = Object.keys(PATHS);
  const md = [`# Hardware matrix${run ? `: ${run}` : ""}`, ""];
  md.push(
    [
      "PASS: right output, stage on that path. FAIL: broken, wrong, or run elsewhere.",
      "NOT-BUILT: the service doesn't do the stage. SKIPPED: fixture or device absent. `·`: not measured.",
    ].join(" "),
    "",
  );
  for (const side of sides) {
    const mine = kept.filter((result) => result.side === side);
    const at = (row, path) => mine.find((result) => result.row === row.id && result.path === path);
    md.push(`## ${side}`, "");
    const image = mine.find((result) => result.image)?.image;
    if (image) md.push(`Image \`${image}\`.`, "");
    md.push(`| Stage | ${paths.join(" | ")} |`, `| --- | ${paths.map(() => "---").join(" | ")} |`);
    for (const row of rows) {
      if (!mine.some((result) => result.row === row.id)) continue;
      md.push(`| ${row.id} | ${paths.map((path) => at(row, path)?.verdict ?? "·").join(" | ")} |`);
    }
    md.push("");
    const counts = paths
      .map((path) => {
        const measured = mine.filter((result) => result.path === path);
        if (measured.length === 0) return undefined;
        return `${path} ${measured.filter((result) => result.verdict === "PASS").length}/${measured.length} PASS`;
      })
      .filter(Boolean);
    md.push(counts.join(", "), "");
    for (const result of mine) md.push(`- **${result.row} / ${result.path}** ${tsvField(cellLine(result))}`);
    md.push("");
  }
  if (sides.includes("before") && sides.includes("after")) {
    const changed = kept
      .filter((result) => result.side === "after")
      .flatMap((after) => {
        const before = kept.find((result) => result.side === "before" && result.row === after.row && result.path === after.path);
        return before && before.verdict !== after.verdict ? [`| ${after.row} | ${after.path} | ${before.verdict} | ${after.verdict} |`] : [];
      });
    md.push("## What changed on the after side", "");
    md.push(...(changed.length === 0 ? ["No cell changed."] : ["| Stage | Path | Before | After |", "| --- | --- | --- | --- |", ...changed]), "");
  }
  const json = `${JSON.stringify({ run, cells: kept }, null, 2)}\n`;
  return { tsv, md: `${md.join("\n").trimEnd()}\n`, json };
};
