// The hardware matrix: which video stage works on which path (the CPU, Intel Quick Sync, VA-API),
// measured through the media service's own playback negotiation. This file is the table and the
// pure logic that judges a cell; hardware-matrix-run.mjs drives a side and collects what it saw.
//
// A cell is one row of ROWS on one of its paths. A row names the fixture it plays, the client
// capability profile and request that force its stage through negotiation, the checks that decide
// the verdict, and where each operation of the stage must run. A new stage, path, or hybrid row
// (such as a CPU decode feeding a GPU encode) is a new entry in these tables, never new control
// flow.

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

/** Where the generated fixtures live in a side's container (`up` mounts the side's state there). */
export const FIXTURE_ROOT = "/media/verify-fixtures";

/** The library the generated fixtures are scanned into. */
export const FIXTURE_LIBRARY = "Verify fixtures";

/**
 * What the cells play. A `library` fixture is a version of a demo library title; a `generate`
 * fixture is made at run time with the side's own ffmpeg into the side's state, mounted at
 * FIXTURE_ROOT, from `args` (the inputs and encode, without the output file), in Matroska unless
 * `format` names another container.
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
  "hlg-hevc": {
    about: "HEVC Main 10 HLG (BT.2020), 1920x1080 at 24 fps, 30 s of testsrc2 with a tone, generated: HLG carries no mastering display metadata, which VA-API's tone map needs",
    generate: {
      title: "Verify Fixture HEVC HLG",
      year: 2026,
      file: "Verify Fixture HEVC HLG (2026).mkv",
      args: [
        ["-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=24:duration=30"],
        ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=30"],
        ["-map", "0:v", "-map", "1:a"],
        ["-vf", "format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc"],
        ["-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p10le"],
        ["-x265-params", "keyint=48:min-keyint=48:scenecut=0:log-level=error"],
        ["-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc", "-c:a", "aac", "-b:a", "128k"],
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
const GPU_TONE_MAP = /tonemap_vaapi|vpp_qsv=[^,;\s]*tonemap=1/;
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
  "tone-map": {
    cpu: { uses: [/(^|[\s,;\]])tonemap=/], avoids: [GPU_TONE_MAP], engine: "none" },
    qsv: { uses: [/vpp_qsv=[^,;\s]*tonemap=1/], avoids: [], engine: "any" },
    vaapi: { uses: [/tonemap_vaapi/], avoids: [], engine: "any" },
  },
  overlay: {
    cpu: { uses: [/(^|[\s,;\]])overlay=/], avoids: [GPU_OVERLAY], engine: "none" },
    qsv: { uses: [/overlay_qsv/], avoids: [], engine: "any" },
    vaapi: { uses: [/overlay_vaapi/], avoids: [], engine: "any" },
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

/**
 * The software tone map the hdr-to-sdr cell compares its picture with: linear light, Hable onto
 * 100 nits, BT.709. Run on the source in the side's container, it is a known-good SDR rendering of
 * the same frames; the cell's bounds catch a black, washed-out, or tinted picture, not a
 * different tone curve.
 */
export const REFERENCE_TONE_MAP =
  "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p";

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
    start: 0,
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
    start: 0,
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
  {
    id: "hdr-to-sdr",
    stage: "hdr-to-sdr",
    paths: ALL_PATHS,
    fixture: "hdr10-hevc",
    profile: "h264-sdr",
    request: {},
    start: 0,
    seek: 240,
    span: 4,
    work: { "tone-map": "path" },
    notBuilt: ["hdr-tone-mapping-requires-hardware"],
    checks: [
      { check: "hdr-removed" },
      { check: "sdr-tags" },
      { check: "picture", at: 240, seconds: 2 },
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
    start: 0,
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
    id: "encode-h264",
    stage: "encode-h264",
    paths: ALL_PATHS,
    fixture: "sdr-h264",
    profile: "h264-sdr",
    request: { quality: { maxBitrate: 4_000_000 } },
    start: 0,
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
    start: 0,
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
    start: 0,
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
  {
    id: "hybrid-cpu-tone-map",
    stage: "hdr-to-sdr",
    paths: ["vaapi"],
    fixture: "hlg-hevc",
    profile: "h264-sdr",
    request: {},
    start: 0,
    seek: 20,
    span: 4,
    work: { decode: "path", "tone-map": "cpu", "encode-h264": "path" },
    notBuilt: ["hdr-tone-mapping-requires-hardware"],
    checks: [
      { check: "hdr-removed" },
      { check: "sdr-tags" },
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
  { check: "picture-time", frames: 1, minMatch: 0.7 },
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
    fieldOrder: known(video.field_order),
    fps: rate(video.avg_frame_rate) ?? rate(video.r_frame_rate),
    baseFps: rate(video.r_frame_rate),
    duration: number(parsed.format?.duration) ?? number(video.duration),
  };
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
 * them, in order: `{ pts, pixels }`, the pixels less their mean and scaled to unit length, so that
 * two thumbnails' dot product is their correlation. A flat thumbnail has no pixels.
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
    if (norm < size) return { pts: times[index], pixels: undefined };
    const scale = 1 / Math.sqrt(norm);
    for (let at = 0; at < size; at += 1) pixels[at] *= scale;
    return { pts: times[index], pixels };
  });
};

const correlation = (a, b) => {
  let sum = 0;
  for (let at = 0; at < a.length; at += 1) sum += a[at] * b[at];
  return sum;
};

/** The most output thumbnails one offset search compares. */
const SAMPLED_THUMBNAILS = 240;

/**
 * How far in time the output's picture sits from the source's: the shift that best matches each
 * output thumbnail with the source thumbnail shown at its time plus that shift, searched in steps
 * of `step` within `window` seconds, the smallest shift winning a tie, so a still picture reads as
 * in place. A negative shift is a picture that comes late. `score` is the mean correlation at the
 * shift and `inPlace` at none; both are undefined when no output thumbnail has a picture to
 * compare. `flat` counts the output thumbnails without one, and `pictured` those of them the
 * source shows a picture at.
 */
export const pictureOffset = (output, source, { window, step }) => {
  const shown = (time) => {
    let low = 0;
    let high = source.length - 1;
    let found;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (source[middle].pts <= time + 0.001) {
        found = source[middle];
        low = middle + 1;
      } else high = middle - 1;
    }
    return found;
  };
  const withPicture = output.filter((frame) => frame.pixels !== undefined);
  const every = Math.max(1, Math.ceil(withPicture.length / SAMPLED_THUMBNAILS));
  const sample = withPicture.filter((_, index) => index % every === 0);
  const scoreAt = (shift) => {
    let sum = 0;
    let count = 0;
    for (const frame of sample) {
      const match = shown(frame.pts + shift);
      if (match?.pixels === undefined) continue;
      sum += correlation(frame.pixels, match.pixels);
      count += 1;
    }
    return count === 0 ? undefined : sum / count;
  };
  let best;
  for (let index = 0; index * step <= window + 1e-9; index += 1) {
    for (const shift of index === 0 ? [0] : [-index * step, index * step]) {
      const score = scoreAt(shift);
      if (score !== undefined && (best === undefined || score > best.score + 1e-4)) best = { shift, score };
    }
  }
  const flat = output.filter((frame) => frame.pixels === undefined);
  const pictured = flat.filter((frame) => shown(frame.pts)?.pixels !== undefined).length;
  return { offset: best?.shift, score: best?.score, inPlace: scoreAt(0), frames: sample.length, step, flat: flat.length, pictured };
};

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

/** The runs that wrote this stream's segments: their output sits under `/transcode/<streamId>/`. */
export const streamRuns = (runs, streamId) =>
  runs.filter((run) => run.args.some((arg) => arg.includes(`/${streamId}/`)));

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

const filterNames = (graph) =>
  [...new Set(graph.split(/[,;]/).map((part) => part.replace(/\[[^\]]*\]/g, "").split("=")[0].trim()))].filter(
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
  // Each fetch's picture against the source shown at the same time: left alone, Quick Sync's
  // filters on ffmpeg 7.1 hold a first picture for 41 to 512 frames, every timestamp in place.
  "picture-time": {
    class: "output",
    run: (obs, params) => {
      const said = [];
      for (const fetch of fetchesOf(obs)) {
        const timing = obs.analysis?.timing?.[fetch.name];
        if (timing === undefined) return no(`the ${fetch.name} output's picture was not compared with the source`);
        if (timing.score === undefined) {
          if (timing.pictured > 0) {
            return no(`the ${fetch.name} picture is one flat colour where the source shows a picture, in ${timing.pictured} of ${timing.flat} frames`);
          }
          said.push(`${fetch.name} flat, as the source is there`);
          continue;
        }
        const frames = timing.offset / timing.step;
        const late = `${fmt(Math.abs(frames), 1)} frames (${fmt(Math.abs(timing.offset), 3)} s) ${timing.offset < 0 ? "behind" : "ahead of"} the source`;
        if (timing.score < params.minMatch) {
          return no(`the ${fetch.name} picture matches the source nowhere within ${TIMING_WINDOW} s (r ${fmt(timing.score)} at best)`);
        }
        if (Math.abs(frames) > params.frames + 0.01) {
          return no(`the ${fetch.name} picture is ${late} (r ${fmt(timing.score)} there, ${fmt(timing.inPlace)} in place)`);
        }
        said.push(`${fetch.name} ${fmt(frames, 1)} frames (r ${fmt(timing.score)})`);
      }
      return ok(`picture on the source's timeline: ${said.join(", ")}`);
    },
  },
  // Each fetch's sound starts with its picture: no later than an audio frame after the first picture,
  // and no earlier than an audio frame before the first video packet is decoded, where the muxer
  // cuts a fragment when the encoder reorders pictures.
  "audio-start": {
    class: "output",
    run: (obs) => {
      const said = [];
      for (const fetch of fetchesOf(obs)) {
        const audio = fetch.audio;
        const first = fetch.frames?.[0]?.pts;
        if (audio === undefined) return no(`the ${fetch.name} output has no audio`);
        const lead = audio.start - first;
        if (audio.start > first + audio.frame + 0.001) {
          return no(`the ${fetch.name} audio starts ${fmt(lead * 1000, 0)} ms after its first picture, more than an audio frame`);
        }
        if (audio.start < fetch.firstDecoded - audio.frame - 0.001) {
          return no(`the ${fetch.name} audio starts ${fmt(-lead * 1000, 0)} ms before its first picture, before its first video packet is decoded`);
        }
        said.push(`${fetch.name} ${lead >= 0 ? "+" : ""}${fmt(lead * 1000, 0)} ms`);
      }
      return ok(`audio starts with the picture: ${said.join(", ")}`);
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
        const tags = `${media.transfer ?? "untagged"}/${media.primaries ?? "untagged"}/${media.space ?? "untagged"}`;
        return media.transfer === "bt709" && media.primaries === "bt709" && media.space === "bt709"
          ? ok(`tagged ${tags}`)
          : no(`tagged ${tags}, not bt709/bt709/bt709`);
      }),
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
  const work = checks.find((check) => check.name === "work");
  const fps = measuredFps(obs.fetches.seek.frames);
  const output = `${media.codec} ${media.profile ?? ""} ${media.width}x${media.height} ${media.bitDepth}-bit ${fmt(fps)} fps`;
  return { verdict: "PASS", evidence: [output.replace(/\s+/g, " "), ...shown, work.evidence].join("; "), checks };
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
