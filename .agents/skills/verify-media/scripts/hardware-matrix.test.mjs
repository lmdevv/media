import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CHECKS,
  cells,
  describeRun,
  FIXTURES,
  fingerprint,
  interlacedShare,
  judge,
  parseFrames,
  parseIdet,
  parsePlaylist,
  parseProbe,
  parseSignalstats,
  parseThumbnails,
  parseWatch,
  PATHS,
  pictureSane,
  PRINT_STATS,
  PROFILES,
  ranOn,
  redact,
  audioFrameSeconds,
  frameTiming,
  judgeFrames,
  soundFrom,
  renderGrid,
  ROWS,
  segmentsCovering,
  sessionRecords,
  STAGES,
  streamRuns,
  THUMBNAIL,
  TIMING_WINDOW,
  WORK,
} from "./hardware-matrix.mjs";

const here = (file) => fileURLToPath(new URL(file, import.meta.url));
const repo = here("../../../../");
const helper = here("verify-media.sh");
const scratch = mkdtempSync(join(tmpdir(), "hardware-matrix-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** The picture-time check's frame rule, as the runner applies it. */
const TIMING = { window: TIMING_WINDOW, minMatch: 0.7, tolerance: 0.01, quiet: 4 };

const ffmpeg = (...args) => spawnSync("ffmpeg", ["-hide_banner", "-nostdin", ...args], { encoding: "utf8", maxBuffer: 1 << 26 });
const ffprobe = (...args) => spawnSync("ffprobe", ["-v", "error", ...args], { encoding: "utf8", maxBuffer: 1 << 26 });

describe("the table", () => {
  test("has a row for every stage on every path, once, in the stages' order, then source and hybrid rows", () => {
    const keys = cells().map((cell) => cell.key);
    assert.equal(new Set(keys).size, keys.length);
    assert.deepEqual(
      cells(ROWS.filter((row) => STAGES.includes(row.id))).map((cell) => cell.key),
      STAGES.flatMap((stage) => Object.keys(PATHS).map((path) => `${stage}/${path}`)),
    );

    for (const row of ROWS.filter((row) => !STAGES.includes(row.id))) {
      if (row.id.startsWith(`${row.stage}-`)) continue;
      assert.ok(row.id.startsWith("hybrid-"), row.id);
      assert.ok(
        Object.values(row.work).some((location) => location !== "path"),
        `${row.id} fixes an operation to another path`,
      );
    }
  });

  test("names only fixtures, profiles, checks, and operations it defines", () => {
    for (const row of ROWS) {
      assert.ok(STAGES.includes(row.stage), row.id);
      assert.ok(row.fixture in FIXTURES, `${row.id}: fixture ${row.fixture}`);
      assert.ok(row.profile in PROFILES, `${row.id}: profile ${row.profile}`);
      for (const spec of row.checks) assert.ok(spec.check in CHECKS, `${row.id}: check ${spec.check}`);
      assert.ok(Object.keys(row.work).length > 0, `${row.id} says where its stage runs`);
      for (const [operation, location] of Object.entries(row.work)) {
        for (const path of row.paths) {
          const at = location === "path" ? path : location;
          assert.ok(WORK[operation]?.[at], `${row.id}: no rule for ${operation} on ${at}`);
        }
      }
      assert.ok(row.seek > row.start + row.span, `${row.id}: the seek lands away from the start`);
    }
  });

  test("refuses for not-built only with reasons the playback contract defines", () => {
    const contract = readFileSync(join(repo, "packages/contracts/src/media-playback.ts"), "utf8");
    const listed = /export const UnsupportedReason = Schema\.Literals\(\[([^\]]+)\]\)/.exec(contract)?.[1] ?? "";
    const reasons = [...listed.matchAll(/"([a-z-]+)"/g)].map((match) => match[1]);
    assert.ok(reasons.length > 0, "the contract lists its reasons");
    for (const row of ROWS) for (const reason of row.notBuilt) assert.ok(reasons.includes(reason), `${row.id}: ${reason}`);
  });

  test("plays demo library files under /media/library and generates the rest", () => {
    for (const [name, fixture] of Object.entries(FIXTURES)) {
      if (fixture.library) assert.match(fixture.path, /^\/media\/library\//, name);
      else assert.ok(fixture.generate.args.includes("-i") && fixture.generate.title && fixture.generate.file, name);
    }
  });

  test("gives every profile the fields a negotiation needs", () => {
    for (const [name, { capabilities }] of Object.entries(PROFILES)) {
      for (const field of ["containers", "videoCodecs", "audioCodecs", "maxWidth", "maxHeight", "hls", "mse"]) {
        assert.ok(field in capabilities, `${name} has ${field}`);
      }
    }
  });
});

describe("reading real ffmpeg output", () => {
  const clip = join(scratch, "clip.mp4");
  before(() => {
    const made = ffmpeg(
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x240:rate=25:duration=2",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-g",
      "25",
      "-vf",
      "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709,format=yuv420p",
      clip,
    );
    assert.equal(made.status, 0, made.stderr);
  });

  test("ffprobe's streams give the codec, size, depth, colour tags, rate, and duration", () => {
    const media = parseProbe(ffprobe("-show_streams", "-show_format", "-of", "json", clip).stdout);
    assert.equal(media.codec, "h264");
    assert.equal(media.width, 320);
    assert.equal(media.height, 240);
    assert.equal(media.bitDepth, 8);
    assert.deepEqual([media.transfer, media.primaries, media.space], ["bt709", "bt709", "bt709"]);
    assert.equal(media.fps, 25);
    assert.ok(Math.abs(media.duration - 2) < 0.1, `duration ${media.duration}`);
  });

  test("ffprobe's frames come back in time order with their keyframes", () => {
    const frames = parseFrames(
      ffprobe("-select_streams", "v:0", "-show_entries", "frame=pts_time,best_effort_timestamp_time,key_frame,interlaced_frame", "-of", "json", clip).stdout,
    );
    assert.equal(frames.length, 50);
    assert.equal(frames[0].pts, 0);
    assert.deepEqual(frames.filter((frame) => frame.key).map((frame) => frame.pts), [0, 1]);
  });

  test("idet tells combed frames from deinterlaced ones", () => {
    const share = (filters) =>
      interlacedShare(parseIdet(ffmpeg("-nostats", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=50:duration=2", "-vf", `${filters},idet`, "-f", "null", "-").stderr));
    assert.ok(share("tinterlace=mode=interleave_top") > 0.9);
    assert.ok(share("tinterlace=mode=interleave_top,setfield=tff,yadif") < 0.15);
  });

  test("signalstats averages each value over the frames", () => {
    const stats = parseSignalstats(
      ffmpeg("-v", "error", "-f", "lavfi", "-i", "color=c=gray:size=64x64:rate=10:duration=0.5", "-vf", PRINT_STATS, "-f", "null", "-").stdout,
    );
    assert.equal(stats.frames, 5);
    assert.ok(Math.abs(stats.YAVG - 126) <= 2, `YAVG ${stats.YAVG}`);
    assert.equal(stats.SATAVG, 0);
  });

  test("thumbnails find a picture held at the start, and a picture in place, in frames", () => {
    const thumbs = (filters) => {
      const run = spawnSync(
        "ffmpeg",
        ["-hide_banner", "-nostdin", "-copyts", "-i", clip, "-vf", `${filters}${THUMBNAIL.filter}`, "-fps_mode", "passthrough", "-f", "rawvideo", "-"],
        { maxBuffer: 1 << 26 },
      );
      assert.equal(run.status, 0, run.stderr.toString());
      return parseThumbnails(run.stdout, run.stderr.toString());
    };
    const source = thumbs("");
    assert.equal(source.length, 50);
    assert.deepEqual(source.slice(0, 3).map((frame) => frame.pts), [0, 0.04, 0.08]);
    assert.ok(source.every((frame) => frame.pixels !== undefined));

    const judgeAt = (output) => frameTiming(judgeFrames(output, source, { ...TIMING, allowance: 0.04 }));
    assert.deepEqual(judgeAt(source), { frames: 50, unjudged: 0, failed: 0, flat: 0, another: 0, first: undefined, by: undefined });

    // The first picture held for ten frames and everything after it late, as ffmpeg 7.1's Quick
    // Sync filters make a constant-rate output, every timestamp in place: after the first two
    // frames (within a frame of their time), nearly every frame shows the picture 0.4 s earlier.
    const held = judgeAt(thumbs("tpad=start=10:start_mode=clone,trim=end_frame=50,"));
    assert.deepEqual([held.frames, held.first], [50, 0.08]);
    assert.ok(held.failed > 40 && held.another === held.failed, `${held.failed} failed`);
    assert.ok(Math.abs(held.by + 0.4) < 1e-9, `typically ${held.by} s`);
  });

  test("x264's bytes name it, and other bytes name no encoder", () => {
    assert.equal(fingerprint(readFileSync(clip)), "x264");
    assert.equal(fingerprint(Buffer.from("nothing here")), undefined);
  });
});

describe("parsing", () => {
  test("a playlist resolves its segments and their starts, and a span picks the segments that cover it", () => {
    const text = [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      "#EXT-X-TARGETDURATION:4",
      '#EXT-X-MAP:URI="init.mp4?ticket=abc"',
      "#EXTINF:1.000000,",
      "0.m4s?ticket=abc",
      "#EXTINF:1.000000,",
      "1.m4s?ticket=abc",
      "#EXTINF:2.000000,",
      "2.m4s?ticket=abc",
      "#EXTINF:4.000000,",
      "3.m4s?ticket=abc",
      "#EXTINF:4.000000,",
      "4.m4s?ticket=abc",
      "#EXT-X-ENDLIST",
    ].join("\n");
    const playlist = parsePlaylist(text, "http://localhost:1/media/hls/s/1/index.m3u8?ticket=abc");
    assert.equal(playlist.init, "http://localhost:1/media/hls/s/1/init.mp4?ticket=abc");
    assert.equal(playlist.total, 12);
    assert.deepEqual(playlist.segments.map((segment) => segment.start), [0, 1, 2, 4, 8]);
    assert.deepEqual(segmentsCovering(playlist.segments, 0, 4).map((segment) => segment.index), [0, 1, 2]);
    assert.deepEqual(segmentsCovering(playlist.segments, 5, 4).map((segment) => segment.index), [3, 4]);
    assert.deepEqual(segmentsCovering(playlist.segments, 20, 4), []);
  });

  test("the watcher's lines become runs with their arguments and their busiest engine time per client", () => {
    const text = [
      "seen 41",
      "seen 52",
      "seen 52",
      "seen 52",
      "args 41 ffmpeg\x1f-hwaccel\x1fqsv\x1f-i\x1f/media/a.mkv\x1f-c:v\x1fh264_qsv\x1f/transcode/stream-one/1/ffmpeg.m3u8",
      "gpu 41 12 drm-client-id:\t7",
      "gpu 41 12 drm-engine-video:\t100 ns",
      "gpu 41 12 drm-engine-capacity-video:\t2",
      "gpu 41 13 drm-client-id:\t7",
      "gpu 41 13 drm-engine-video:\t100 ns",
      "gpu 41 12 drm-engine-video:\t250 ns",
      "gpu 41 12 drm-engine-video-enhance:\t40 ns",
      "args 52 ffmpeg\x1f-i\x1f/media/b.mkv\x1f-vf\x1fscale=320:240\x1f-c:v\x1flibx264\x1f/transcode/stream-two/1/ffmpeg.m3u8",
      "gpu 60 3 drm-cycles-vcs:\t900",
      "gpu 60 3 drm-client-id:\t9",
    ].join("\n");
    const runs = parseWatch(text);
    const one = runs.find((run) => run.pid === 41);
    assert.deepEqual(one.engines, { video: 250, "video-enhance": 40 });
    assert.equal(one.gpu, true);
    assert.equal(runs.find((run) => run.pid === 52).gpu, false);
    assert.deepEqual(runs.map((run) => run.polls), [1, 3, 0]);
    assert.deepEqual(runs.find((run) => run.pid === 60).engines, { video: 900 });
    assert.deepEqual(streamRuns(runs, "stream-one").map((run) => run.pid), [41]);
    assert.equal(describeRun(one), "decode qsv; filters none; encode h264_qsv; GPU video 0.0 s, video-enhance 0.0 s");
  });

  test("the service log keeps one session's records and the hardware records", () => {
    const text = [
      'media-1  | {"message":"Stream.started","annotations":{"sessionId":"s1","mode":"transcode-qsv"}}',
      '{"message":"Stream.started","annotations":{"sessionId":"s2","mode":"direct"}}',
      '{"message":"HardwareAcceleration.disabled","annotations":{"encoder":"qsv"}}',
      "not json",
    ].join("\n");
    assert.deepEqual(sessionRecords(text, "s1").map((record) => record.message), ["Stream.started", "HardwareAcceleration.disabled"]);
  });

  test("tickets never reach the evidence", () => {
    const text = redact('{"token":"secret","url":"http://x/index.m3u8?ticket=secret&a=1"} secret', "secret");
    assert.doesNotMatch(text, /secret/);
    assert.match(text, /ticket=REDACTED&a=1/);
  });
});

/** AAC packets at 48 kHz sounding from `from` to `to`, as ffprobe lists a track, with or without durations. */
const sounding = (from, to, durations = true) =>
  Array.from({ length: Math.round(((to - from) * 48_000) / 1024) }, (_, index) => ({
    pts: from + (index * 1024) / 48_000,
    duration: durations ? 1024 / 48_000 : undefined,
  }));

// What the runner would see for a cell whose stage ran as asked: the pieces each check reads.
const healthy = (cell) => {
  const { row, path } = cell;
  const qsv = path === "qsv";
  const encoder = { cpu: "libx264", qsv: "h264_qsv", vaapi: "h264_vaapi" }[path];
  const frames = (from, count) => Array.from({ length: count }, (_, index) => ({ pts: from + index / 24, key: index % 24 === 0, interlaced: false }));
  const fetch = (name, from) => ({
    name,
    ok: true,
    total: 300,
    segments: [
      { index: 0, start: from, duration: 1, bytes: 400_000 },
      { index: 1, start: from + 1, duration: 1, bytes: 400_000 },
      { index: 2, start: from + 2, duration: 2, bytes: 800_000 },
    ],
    media: { codec: "h264", profile: "High", width: 1920, height: 818, bitDepth: 8, transfer: "bt709", primaries: "bt709", space: "bt709" },
    frames: frames(from, 96),
    audio: { start: from, codec: "aac", sampleRate: "48000" },
    sourceAudio: { codec: "aac", sampleRate: "48000", packets: sounding(from - 3, from + 3) },
    firstDecoded: from - 2 / 24,
    decodeErrors: "",
    fingerprint: path === "cpu" ? "x264" : undefined,
  });
  const inPlace = { frames: 96, unjudged: 0, failed: 0, flat: 0, another: 0 };
  const args = [
    "ffmpeg",
    ...(path === "cpu" ? [] : ["-hwaccel", path, "-hwaccel_output_format", path]),
    "-i",
    "/media/library/x.mkv",
    "-vf",
    qsv ? "vpp_qsv=w=1920:h=818:format=nv12" : path === "vaapi" ? "scale_vaapi=w=1920:h=818:format=nv12" : "scale=1920:818:flags=bicubic,format=yuv420p",
    "-c:v",
    encoder,
    "/transcode/s/1/ffmpeg.m3u8",
  ];
  return {
    negotiation: {
      status: 200,
      ok: true,
      body: { mode: `transcode-${PATHS[path].encoder}`, video: { width: 1920, height: 818 }, audio: { streamIndex: 1, codec: "aac", channels: 2 } },
    },
    fetches: { start: fetch("start", row.start), seek: fetch("seek", row.seek) },
    runs: [{ pid: 1, args, gpu: path !== "cpu", engines: path === "cpu" ? {} : { video: 5e8 } }],
    log: [],
    source: { codec: "hevc", width: 1920, height: 818, fps: 24, baseFps: 24, duration: 300.2 },
    analysis: { timing: { start: inPlace, seek: inPlace } },
  };
};

const cellOf = (id, path) => cells().find((cell) => cell.row.id === id && cell.path === path);

describe("verdicts", () => {
  test("a stage that ran on its path with the right output passes", () => {
    for (const path of Object.keys(PATHS)) {
      const cell = cellOf("decode", path);
      const result = judge(cell, healthy(cell));
      assert.equal(result.verdict, "PASS", `${path}: ${result.evidence}`);
    }
  });

  test("a CPU decode beside a GPU encode passes a hybrid row, and a GPU decode fails it", () => {
    for (const path of ["qsv", "vaapi"]) {
      const cell = cellOf("hybrid-cpu-decode", path);
      const onGpu = healthy(cell);
      const beside = healthy(cell);

      beside.runs[0].args = beside.runs[0].args.filter(
        (arg, index, args) => !["-hwaccel", "-hwaccel_output_format"].includes(arg) && !["-hwaccel", "-hwaccel_output_format"].includes(args[index - 1]),
      );
      assert.equal(judge(cell, beside).verdict, "PASS", `${path}: ${judge(cell, beside).evidence}`);
      assert.equal(judge(cell, onGpu).verdict, "FAIL", path);
      assert.match(judge(cell, onGpu).evidence, /decode not on cpu: the arguments use -hwaccel/);
    }
  });

  test("every frame of a fetch must show the source's picture for its time, within a frame", () => {
    // The verifier's scene: 24 fps frames that each correlate with themselves alone.
    const step = 1 / 24;
    const scene = Array.from({ length: 180 }, (_, index) => ({
      pts: (index - 36) * step,
      pixels: Float32Array.from({ length: 180 }, (_, at) => (index === at ? 1 : 0)),
    }));
    const source = scene.slice(36, 132);
    const flat = source.map(({ pts }) => ({ pts, pixels: undefined }));
    const timingOf = (output, reference) => frameTiming(judgeFrames(output, reference, { ...TIMING, allowance: step }));
    const cell = cellOf("decode", "qsv");
    const verdictOf = (start, seek) => {
      const obs = healthy(cell);
      obs.analysis.timing = { start, seek };
      return judge(cell, obs);
    };
    const aligned = timingOf(source, scene);

    assert.equal(verdictOf(aligned, aligned).verdict, "PASS", "all aligned");

    // Thumbnails that could not be made are no picture to compare: the cell can't be judged.
    const noSource = verdictOf(timingOf(source, []), aligned);
    assert.equal(noSource.verdict, "FAIL");
    assert.match(noSource.evidence, /^picture-time: could not measure: the source's thumbnails reach 0 of the start output's 96 frames$/);
    const noOutput = verdictOf(aligned, timingOf([], scene));
    assert.match(noOutput.evidence, /^picture-time: could not measure: thumbnails of 0 of the seek output's 96 frames$/);
    const errored = verdictOf({ ...aligned, error: "ffmpeg exited 1: Invalid data" }, aligned);
    assert.match(errored.evidence, /^picture-time: could not measure the start picture: ffmpeg exited 1/);

    // A hold at the head of a fetch, however short, is the defect: each frame counts.
    const headHeld = verdictOf(aligned, timingOf([...flat.slice(0, 12), ...source.slice(12)], scene));
    assert.match(headHeld.evidence, /^picture-time: 12 of the seek output's 96 frames do not show the source's picture for their time, from 0 s: 12 flat where the source shows a picture$/);
    const allHeld = verdictOf(timingOf(flat, scene), aligned);
    assert.match(allHeld.evidence, /^picture-time: 96 of the start output's 96 frames/);

    // A program two frames late fails; one frame late is within the allowance.
    const late = (frames) => source.map((frame) => ({ ...frame, pts: frame.pts + frames * step }));
    const twoLate = verdictOf(aligned, timingOf(late(2), scene));
    assert.match(twoLate.evidence, /^picture-time: 96 of the seek output's 96 frames .*: 96 showing another time's picture \(typically 0\.083 s earlier\)$/);
    assert.equal(verdictOf(aligned, timingOf(late(1), scene)).verdict, "PASS");

    // One stray frame is tolerated, wherever it falls; a second is not.
    const stray = (count) => source.map((frame, index) => (index % 40 === 39 && index < 40 * count ? { pts: frame.pts, pixels: undefined } : frame));
    assert.equal(verdictOf(aligned, timingOf(stray(1), scene)).verdict, "PASS");
    assert.match(verdictOf(aligned, timingOf(stray(2), scene)).evidence, /^picture-time: 2 of the seek output's 96 frames/);

    // Black on both sides is in place; a picture where the source is black is not.
    const dark = flat.map((frame) => ({ ...frame }));
    assert.equal(verdictOf(timingOf(dark, dark), aligned).verdict, "PASS");
    assert.match(verdictOf(timingOf(source, dark), aligned).evidence, /^picture-time: 96 of the start output's 96 frames/);
  });

  test("sound must start where the source's does at that position, within an audio frame of its codec", () => {
    const cell = cellOf("encode-h264", "cpu");
    const step = 1 / 24;
    const fetchAt = (obs, name, { pts, decoded, audio, sourceFrom = pts - 3, durations = true }) => {
      const fetch = obs.fetches[name];
      fetch.frames = fetch.frames.map((frame, index) => ({ ...frame, pts: pts + index * step }));
      fetch.firstDecoded = decoded;
      fetch.audio = { start: audio, codec: "aac", sampleRate: "48000" };
      fetch.sourceAudio = { codec: "aac", sampleRate: "48000", packets: sounding(sourceFrom, pts + 3, durations) };
    };

    // A B-frame fragment aligned at its keyframe after a fractional seek: sound from the decode time.
    const reordered = healthy(cell);
    fetchAt(reordered, "start", { pts: 0, decoded: -2 * step, audio: 0 });
    fetchAt(reordered, "seek", { pts: 120, decoded: 120 - 2 * step, audio: 120 - 2 * step });
    assert.equal(judge(cell, reordered).verdict, "PASS", judge(cell, reordered).evidence);

    // A source whose sound starts 500 ms after its first picture, served as it is (AAC at +479 ms).
    const delayed = healthy(cell);
    fetchAt(delayed, "start", { pts: 0, decoded: -2 * step, audio: 0.479, sourceFrom: 0.5 });
    fetchAt(delayed, "seek", { pts: 120, decoded: 120 - 2 * step, audio: 120 });
    assert.equal(judge(cell, delayed).verdict, "PASS", judge(cell, delayed).evidence);
    // The same source served with its sound moved to the picture fails.
    fetchAt(delayed, "start", { pts: 0, decoded: -2 * step, audio: 0, sourceFrom: 0.5 });
    assert.match(judge(cell, delayed).evidence, /^audio-start: the start audio starts 0 ms after its first picture, before the source sounds there \(500 ms\)$/);

    // 500 ms late at the seek, from packets that carry no duration: the frame comes from the codec.
    const undated = healthy(cell);
    fetchAt(undated, "seek", { pts: 120, decoded: 120, audio: 120.5, durations: false });
    assert.match(judge(cell, undated).evidence, /^audio-start: the seek audio starts 500 ms after its first picture, where the source sounds 0 ms after it$/);

    // Sound it can't time is no pass.
    const unknown = healthy(cell);
    unknown.fetches.seek.audio = { ...unknown.fetches.seek.audio, codec: "pcm_s16le", sampleRate: undefined };
    assert.match(judge(cell, unknown).evidence, /^audio-start: could not measure: the seek audio's frame length/);
    const unread = healthy(cell);
    unread.fetches.start.sourceAudio = { error: "ffprobe exited 1: No such file" };
    assert.match(judge(cell, unread).evidence, /^audio-start: could not measure the source's audio at the start: ffprobe exited 1/);
    const silent = healthy(cell);
    delete silent.fetches.start.audio;
    assert.match(judge(cell, silent).evidence, /^audio-start: the start output has no audio$/);
    const none = healthy(cell);
    none.negotiation.body.audio = null;
    for (const fetch of Object.values(none.fetches)) delete fetch.audio;
    assert.equal(judge(cell, none).verdict, "PASS");
  });

  test("an audio frame lasts its codec's samples, and a track sounds from its packets", () => {
    assert.equal(audioFrameSeconds("aac", "48000"), 1024 / 48_000);
    assert.equal(audioFrameSeconds("ac3", 48_000), 0.032);
    assert.equal(audioFrameSeconds("pcm_s16le", "48000"), undefined);
    assert.equal(audioFrameSeconds("aac", undefined), undefined);
    const packets = sounding(0.5, 2, false);
    assert.equal(soundFrom(packets, 0, 1024 / 48_000), 0.5);
    assert.equal(soundFrom(packets, 1, 1024 / 48_000), 1);
    assert.equal(soundFrom(packets, 3, 1024 / 48_000), undefined);
  });

  test("a variable-rate source runs at its base rate", () => {
    const cell = cellOf("scale-variable-rate", "qsv");
    const obs = healthy(cell);
    obs.source = { ...obs.source, width: 640, height: 360, fps: 26.25, baseFps: 24 };
    obs.negotiation.body.video = { width: 426, height: 240 };
    for (const fetch of Object.values(obs.fetches)) fetch.media = { ...fetch.media, width: 426, height: 240 };
    obs.runs[0].args = obs.runs[0].args.map((arg) => arg.replace("w=1920:h=818", "w=426:h=240"));
    assert.equal(judge(cell, obs).verdict, "PASS", judge(cell, obs).evidence);
    obs.source.baseFps = 60;
    assert.match(judge(cell, obs).evidence, /^frame-rate: the start output runs at 24 fps/);
  });

  test("an absent fixture or device is skipped", () => {
    assert.deepEqual(judge(cellOf("decode", "qsv"), { skipped: "no render node" }), { verdict: "SKIPPED", evidence: "no render node", checks: [] });
  });

  test("a refusal the row lists is not built, and any other refusal fails", () => {
    const refused = (reason) => ({ negotiation: { status: 422, ok: false, body: { _tag: "UnsupportedPlayback", reason } } });
    const hevc = judge(cellOf("encode-hevc", "qsv"), refused("no-transcode-target"));
    assert.equal(hevc.verdict, "NOT-BUILT");
    assert.equal(hevc.evidence, "negotiation answered 422 UnsupportedPlayback no-transcode-target");
    assert.equal(judge(cellOf("decode", "qsv"), refused("no-transcode-target")).verdict, "FAIL");
  });

  test("H.264 where only HEVC plays is not built", () => {
    const cell = cellOf("encode-hevc", "cpu");
    const result = judge(cell, healthy(cell));
    assert.equal(result.verdict, "NOT-BUILT");
    assert.match(result.evidence, /^codec: the output is h264, not hevc/);
  });

  test("a broken fetch fails before anything else is judged", () => {
    const cell = cellOf("encode-hevc", "cpu");
    const obs = healthy(cell);
    obs.fetches.seek = { name: "seek", ok: false, error: "a segment answered 500" };
    assert.deepEqual([judge(cell, obs).verdict, judge(cell, obs).evidence], ["FAIL", "served: the seek fetch failed: a segment answered 500"]);
  });

  test("a stage done in software on a GPU path fails, however right the picture", () => {
    const cell = cellOf("decode", "qsv");
    const software = healthy(cellOf("decode", "cpu"));
    software.negotiation.body.mode = "transcode-qsv";
    const result = judge(cell, software);
    assert.equal(result.verdict, "FAIL");
    assert.match(result.evidence, /^work: decode not on qsv: the arguments lack -hwaccel qsv -hwaccel_output_format qsv/);

    const moved = healthy(cell);
    moved.log = [{ message: "Stream.mode_changed", annotations: { to: "transcode-software", reason: "hardware-unavailable" } }];
    assert.match(judge(cell, moved).evidence, /moved the stream to transcode-software \(hardware-unavailable\)/);

    const told = healthy(cell);
    told.negotiation.body.mode = "transcode-software";
    assert.match(judge(cell, told).evidence, /negotiated transcode-software, not transcode-qsv/);
  });

  test("combing left in the output is not built, and a source without combing can't be judged", () => {
    const cell = cellOf("deinterlace", "cpu");
    const obs = healthy(cell);
    obs.source = { ...obs.source, width: 1920, height: 818, fps: 24 };
    obs.analysis.idet = { output: { tff: 139, bff: 0, progressive: 111, undetermined: 0 }, source: { tff: 139, bff: 0, progressive: 111, undetermined: 0 } };
    const combed = judge(cell, obs);
    assert.equal(combed.verdict, "NOT-BUILT");
    assert.match(combed.evidence, /idet still finds 56% of frames interlaced \(source 56%\)/);
    obs.analysis.idet.source = { tff: 2, bff: 0, progressive: 248, undetermined: 0 };
    assert.equal(judge(cell, obs).verdict, "FAIL");
  });

  test("a stage the service ran that left the output unchanged fails rather than reading as not built", () => {
    const cell = cellOf("hdr-to-sdr", "qsv");
    const obs = healthy(cell);
    obs.runs[0].args = [
      "ffmpeg",
      "-hwaccel",
      "qsv",
      "-hwaccel_output_format",
      "qsv",
      "-vf",
      "vpp_qsv=w=1920:h=818:format=nv12:tonemap=1:out_color_matrix=bt709:out_color_primaries=bt709:out_color_transfer=bt709",
      "-c:v",
      "h264_qsv",
      "/transcode/s/1/ffmpeg.m3u8",
    ];
    obs.fetches.seek.media = { ...obs.fetches.seek.media, transfer: "smpte2084", primaries: "bt2020", space: "bt2020nc" };
    const result = judge(cell, obs);
    assert.equal(result.verdict, "FAIL");
    assert.match(result.evidence, /^hdr-removed: the service ran tone-map, but the output is still smpte2084\/bt2020/);
  });

  test("HDR tags on the opening stream alone fail the tone map", () => {
    const cell = cellOf("hdr-to-sdr", "cpu");
    const obs = healthy(cell);
    obs.runs[0].args = ["ffmpeg", "-i", "/media/library/x.mkv", "-vf", "scale=1920:818,zscale=t=linear,format=gbrpf32le,tonemap=hable", "-c:v", "libx264", "/transcode/s/1/ffmpeg.m3u8"];
    obs.analysis.picture = { output: { YAVG: 70, YMIN: 16, YMAX: 235, SATAVG: 20, UAVG: 120, VAVG: 130 }, reference: { YAVG: 72, YMIN: 16, YMAX: 235, SATAVG: 20, UAVG: 120, VAVG: 130 } };
    assert.equal(judge(cell, obs).verdict, "PASS", judge(cell, obs).evidence);
    obs.fetches.start.media = { ...obs.fetches.start.media, transfer: "smpte2084", primaries: "bt2020", space: "bt2020nc" };
    const result = judge(cell, obs);
    assert.equal(result.verdict, "FAIL");
    assert.match(result.evidence, /still smpte2084\/bt2020 \(start\)/);
  });

  test("a fetch with no stream description fails", () => {
    const cell = cellOf("decode", "cpu");
    const obs = healthy(cell);
    obs.fetches.start.media = undefined;
    const result = judge(cell, obs);
    assert.equal(result.verdict, "FAIL");
    assert.match(result.evidence, /the start output has no stream description/);
  });

  test("a subtitle comparison with no statistics fails", () => {
    const cell = cellOf("subtitle-burn-in", "cpu");
    const obs = healthy(cell);
    obs.runs[0].args = ["ffmpeg", "-i", "/media/library/x.mkv", "-filter_complex", "[0:v]scale=1920:818[v];[v][0:s:0]overlay=eof_action=pass,format=yuv420p", "-c:v", "libx264", "/transcode/s/1/ffmpeg.m3u8"];
    obs.analysis.burn = { shown: { band: 0.04, elsewhere: 0 }, hidden: { band: 0, elsewhere: 0 } };
    assert.equal(judge(cell, obs).verdict, "PASS", judge(cell, obs).evidence);
    obs.analysis.burn = { shown: { band: undefined, elsewhere: undefined }, hidden: { band: undefined, elsewhere: undefined } };
    const result = judge(cell, obs);
    assert.equal(result.verdict, "FAIL");
    assert.match(result.evidence, /the frame comparison produced no statistics/);
  });

  test("a subtitle drawn on the CPU between GPU stages fails the GPU path", () => {
    const cell = cellOf("subtitle-burn-in", "qsv");
    const obs = healthy(cell);
    obs.analysis.burn = { shown: { band: 0.04, elsewhere: 0 }, hidden: { band: 0, elsewhere: 0 } };
    obs.runs[0].args = [
      "ffmpeg",
      "-hwaccel",
      "qsv",
      "-hwaccel_output_format",
      "qsv",
      "-filter_complex",
      "[0:0]vpp_qsv=w=1920:h=818:format=nv12,hwdownload,format=nv12[picture];[0:13]scale=1920:818[subtitle];[picture][subtitle]overlay=eof_action=pass:repeatlast=0,format=nv12,hwupload=extra_hw_frames=64,format=qsv[video]",
      "-c:v",
      "h264_qsv",
      "/transcode/s/1/ffmpeg.m3u8",
    ];
    const result = judge(cell, obs);
    assert.equal(result.verdict, "FAIL");
    assert.match(result.evidence, /overlay not on qsv: the arguments lack overlay_qsv/);
    const none = healthy(cell);
    none.analysis.burn = { shown: { band: 0, elsewhere: 0 }, hidden: { band: 0, elsewhere: 0 } };
    assert.equal(judge(cell, none).verdict, "NOT-BUILT");
  });

  test("a run too short to sample counts on its arguments, while the cell still needs GPU time from one run", () => {
    const cell = cellOf("decode", "vaapi");
    const obs = healthy(cell);
    const brief = { ...obs.runs[0], pid: 2, gpu: false, polls: 1, engines: {} };
    obs.runs = [brief, { ...obs.runs[0], polls: 9 }];
    assert.equal(judge(cell, obs).verdict, "PASS", judge(cell, obs).evidence);
    assert.match(describeRun(brief), /ended before a GPU sample \(1 poll\)/);
    obs.runs = [brief];
    assert.match(judge(cell, obs).evidence, /^work: decode on vaapi: no run showed GPU engine time/);
    obs.runs = [{ ...brief, polls: 5 }];
    assert.match(judge(cell, obs).evidence, /^work: decode on vaapi: no GPU video engine time/);
  });

  test("a GPU rule needs engine time, a CPU rule no GPU client, and an encoder its fingerprint", () => {
    const run = { args: ["-hwaccel", "qsv", "-hwaccel_output_format", "qsv", "-c:v", "h264_qsv"], gpu: true, polls: 9, engines: { video: 0 } };
    assert.match(ranOn("decode", "qsv", run).why, /no GPU video engine time/);
    assert.equal(ranOn("decode", "qsv", { ...run, engines: { video: 1 } }).ok, true);
    const mapped = {
      ...run,
      args: ["-hwaccel", "vaapi", "-hwaccel_output_format", "vaapi", "-hwaccel_device", "va", "-i", "in.mkv", "-vf", "hwmap,format=qsv,vpp_qsv=w=640:h=360", "-c:v", "h264_qsv"],
      engines: { video: 1 },
    };
    assert.equal(ranOn("decode", "qsv", mapped).ok, true, "VA-API's decoder mapped into Quick Sync");
    assert.equal(ranOn("decode", "qsv", { ...mapped, args: mapped.args.filter((arg) => !arg.startsWith("hwmap")) }).ok, false);
    assert.match(ranOn("encode-h264", "cpu", { args: ["-c:v", "libx264"], gpu: true, engines: {} }, "x264").why, /holds a GPU client/);
    assert.match(ranOn("encode-h264", "cpu", { args: ["-c:v", "libx264"], gpu: false, engines: {} }, undefined).why, /lacks x264's fingerprint/);
    assert.match(ranOn("encode-h264", "qsv", { ...run, engines: { video: 1 } }, "x264").why, /carries x264's fingerprint/);
  });

  test("a tone-mapped picture fails when black, washed out, or tinted against the reference", () => {
    // signalstats of the HDR10 fixture's frames at 240 s: Hable through zscale, and the same PQ
    // picture with no tone map at all, which reads as washed out.
    const reference = { YAVG: 83, YLOW: 28, YHIGH: 134, UAVG: 113, VAVG: 142, SATAVG: 20.4 };
    assert.equal(pictureSane({ ...reference, YAVG: 90, SATAVG: 18 }, reference).ok, true);
    assert.match(pictureSane({ YAVG: 85, YLOW: 37, YHIGH: 123, UAVG: 119, VAVG: 133, SATAVG: 10.6 }, reference).evidence, /^washed out/);
    assert.match(pictureSane({ ...reference, YAVG: 10, YLOW: 3, YHIGH: 16 }, reference).evidence, /^dark or black/);
    assert.match(pictureSane({ ...reference, UAVG: 143, VAVG: 114 }, reference).evidence, /^colour cast/);
  });
});

describe("the grid", () => {
  const result = (side, row, path, verdict) => ({ side, stage: row, row, path, verdict, evidence: `${verdict} because`, measured: "t", cell: `${side}/${path}/${row}` });

  test("puts each side's verdicts in a stage-by-path table, counts passes, and lists what changed", () => {
    const grid = renderGrid(
      [
        result("before", "decode", "qsv", "FAIL"),
        result("after", "decode", "qsv", "PASS"),
        result("after", "decode", "cpu", "PASS"),
        result("after", "gone-row", "cpu", "PASS"),
        result("after", "encode-hevc", "cpu", "NOT-BUILT"),
      ],
      { run: "r" },
    );
    assert.match(grid.md, /^# Hardware matrix: r$/m);
    assert.match(grid.md, /^\| decode \| PASS \| PASS \| · \|$/m);
    assert.match(grid.md, /^\| encode-hevc \| NOT-BUILT \| · \| · \|$/m);
    assert.match(grid.md, /^cpu 1\/2 PASS, qsv 1\/1 PASS$/m);
    assert.match(grid.md, /^\| decode \| qsv \| FAIL \| PASS \|$/m);
    assert.doesNotMatch(grid.md, /gone-row/);
    const lines = grid.tsv.trim().split("\n");
    assert.equal(lines[0], "side\tstage\trow\tpath\tverdict\tevidence\tmeasured\tcell");
    assert.equal(lines.length, 5);
    assert.equal(JSON.parse(grid.json).cells.length, 4);
  });
});

describe("verify-media.sh hardware", () => {
  const env = { ...process.env, TMPDIR: join(scratch, "helper-tmp"), MEDIA_VERIFY_RUN: `hw-${process.pid}` };
  const bin = join(scratch, "hw-bin");
  const calls = join(bin, "calls");
  let server;
  let port;

  before(async () => {
    mkdirSync(env.TMPDIR, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "docker"), '#!/usr/bin/env bash\necho "$*" >> "$FAKE_DOCKER_CALLS"\n', { mode: 0o755 });
    server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", backend: "connected", hardwareAcceleration: "none" }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  });
  after(() => server.close());

  // Sources the helper on an after side whose state holds this checkout's deploy/compose and the
  // port of a server that answers health, with a Docker that only records its calls.
  const onSide = (body) =>
    new Promise((resolve) => {
      rmSync(calls, { force: true });
      const child = spawn(
        "bash",
        [
          "-c",
          `source "$1"; take_side --side after; rm -rf "$state"; mkdir -p "$state/deploy"; cp -R "$2/deploy/compose" "$state/deploy/"; printf 'MEDIA_PORT=1\\n' > "$state/compose.env"; write_state port ${port}; ${body}`,
          "hw-test",
          helper,
          repo,
        ],
        { env: { ...env, PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_CALLS: calls } },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (status) => resolve({ status, stdout, stderr, calls: existsSync(calls) ? readFileSync(calls, "utf8") : "" }));
    });

  test("adds the GPU override for qsv and vaapi and keeps one setting in compose.env", async () => {
    const result = await onSide('set_hardware qsv; set_hardware vaapi; compose ps; grep -c HARDWARE_ACCELERATION "$state/compose.env"; grep HARDWARE_ACCELERATION "$state/compose.env"');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "1\nHARDWARE_ACCELERATION=vaapi\n");
    assert.match(result.calls, /-f \S+\/deploy\/compose\/compose\.vaapi\.yaml -f \S+\/compose\.verify\.yaml ps$/m);
    assert.doesNotMatch(result.calls, /compose\.qsv\.yaml/);
    const none = await onSide("set_hardware none; compose ps");
    assert.doesNotMatch(none.calls, /compose\.(qsv|vaapi)\.yaml/);
  });

  test("switches a running side, waits for it, and says what the service reports", async () => {
    const result = await onSide('cmd_hardware --side after none; echo "state $(read_state hardware)"');
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.calls, /compose .* up -d --no-build --quiet-pull$/m, result.stderr);
    assert.match(result.stdout, /^after: HARDWARE_ACCELERATION=none; the media service reports none$/m);
    assert.match(result.stdout, /^state none$/m);
  });

  test("refuses a setting it doesn't know, and a GPU without a render node", async () => {
    const sideways = await onSide("hardware_usable sideways");
    assert.equal(sideways.status, 1);
    assert.match(sideways.stderr, /HARDWARE_ACCELERATION is none, qsv, or vaapi, not sideways/);
    const gpu = await onSide("has_render_node() { return 1; }; hardware_usable qsv");
    assert.equal(gpu.status, 1);
    assert.match(gpu.stderr, /HARDWARE_ACCELERATION=qsv needs a render node/);
  });

  test("measures only a side that is ready", async () => {
    const result = await onSide("cmd_hardware_matrix --side after");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /the after side is not ready; run `up --side after` first/);
  });
});
