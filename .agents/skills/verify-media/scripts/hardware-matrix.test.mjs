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
  parseWatch,
  PATHS,
  pictureSane,
  PRINT_STATS,
  PROFILES,
  ranOn,
  redact,
  renderGrid,
  ROWS,
  segmentsCovering,
  sessionRecords,
  STAGES,
  streamRuns,
  WORK,
} from "./hardware-matrix.mjs";

const here = (file) => fileURLToPath(new URL(file, import.meta.url));
const repo = here("../../../../");
const helper = here("verify-media.sh");
const scratch = mkdtempSync(join(tmpdir(), "hardware-matrix-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const ffmpeg = (...args) => spawnSync("ffmpeg", ["-hide_banner", "-nostdin", ...args], { encoding: "utf8", maxBuffer: 1 << 26 });
const ffprobe = (...args) => spawnSync("ffprobe", ["-v", "error", ...args], { encoding: "utf8", maxBuffer: 1 << 26 });

describe("the table", () => {
  test("has a row for every stage on every path, once, in the stages' order", () => {
    const keys = cells().map((cell) => cell.key);
    assert.equal(new Set(keys).size, keys.length);
    assert.deepEqual(
      keys,
      STAGES.flatMap((stage) => Object.keys(PATHS).map((path) => `${stage}/${path}`)),
    );
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
    decodeErrors: "",
    fingerprint: path === "cpu" ? "x264" : undefined,
  });
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
    negotiation: { status: 200, ok: true, body: { mode: `transcode-${PATHS[path].encoder}`, video: { width: 1920, height: 818 } } },
    fetches: { start: fetch("start", row.start), seek: fetch("seek", row.seek) },
    runs: [{ pid: 1, args, gpu: path !== "cpu", engines: path === "cpu" ? {} : { video: 5e8 } }],
    log: [],
    source: { codec: "hevc", width: 1920, height: 818, fps: 24, duration: 300.2 },
    analysis: {},
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
    assert.match(result.evidence, /^work: decode not on qsv: the arguments lack -hwaccel qsv/);

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
    const gpu = await onSide("compgen() { return 1; }; hardware_usable qsv");
    assert.equal(gpu.status, 1);
    assert.match(gpu.stderr, /HARDWARE_ACCELERATION=qsv needs a render node/);
  });

  test("measures only a side that is ready", async () => {
    const result = await onSide("cmd_hardware_matrix --side after");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /the after side is not ready; run `up --side after` first/);
  });
});
