import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import {
  Context,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Result,
  Schedule,
} from "effect";
import { TestClock } from "effect/testing";

import { MediaFileId } from "@media/contracts/ids";

import * as MediaTools from "../media/media-tools.ts";
import { type FakeFfmpegBehavior, invocationsOf, writeFakeFfmpeg } from "../testing/fake-ffmpeg.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import { testConfigLayer } from "../testing/test-config.ts";
import * as Inventory from "./capability-inventory.ts";
import * as TranscodeCapabilities from "./transcode-capabilities.ts";
import { Diagnosis } from "./transcode-recovery.ts";
import { planVideo, samePipeline, type VideoIntent, type VideoPipeline } from "./video-pipeline.ts";
import { capabilityKey, ImplId, type SourceVideo } from "./video-ops.ts";
import { renderVideo } from "./video-render.ts";

const hasFfmpeg = await ffmpegAvailable();

const realFfmpeg = process.env["FFMPEG_PATH"] ?? "ffmpeg";

const HDR: SourceVideo = {
  codec: "hevc",
  pixelFormat: "yuv420p10le",
  depth: 10,
  colour: "hdr10",
  scan: "progressive",
  width: 320,
  height: 240,
};

const JPEG_RANGE: SourceVideo = {
  ...HDR,
  codec: "h264",
  pixelFormat: "yuvj420p",
  depth: 8,
  colour: "sdr",
};

const TONE_MAP_QSV = capabilityKey(ImplId("tonemap.qsv"), "pq");

const DECODE_JPEG_RANGE = capabilityKey(ImplId("decode.qsv"), "h264/yuvj420p");

const VPP_FAILED = "[Parsed_vpp_qsv_0 @ 0x1] Invalid color_matrix.";

const intentOf = (source: SourceVideo): VideoIntent => ({
  codec: "h264",
  toneMap: source.colour !== "sdr",
  bounds: { width: 1920, height: 1080 },
  cpuEncodeBounds: { width: 1920, height: 1080 },
  maxBitrate: undefined,
  burnImage: undefined,
});

const request = (
  source: SourceVideo,
  name = "film",
  file = "/nonexistent/film.mkv",
): TranscodeCapabilities.Request => ({
  scope: Inventory.sourceScope(MediaFileId.make(name), 1, 1, 0),
  path: file,
  stream: 0,
  source,
  intent: intentOf(source),
  excluded: new Set(),
});

/** Where a test's data lives. */
class Stage extends Context.Service<Stage, { readonly folder: string }>()(
  "@media/server/test/CapabilityStage",
) {}

const stageLayer = Layer.effect(
  Stage,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    return Stage.of({
      folder: yield* fs.makeTempDirectoryScoped({ prefix: "media-capabilities-" }),
    });
  }),
);

/**
 * The capability service over `ffmpeg`, forcing Quick Sync on a render node unless `env` says
 * otherwise; negotiations wait up to `budget` for their probes.
 */
const servicesOf = (
  ffmpeg: string,
  env: Readonly<Record<string, string>> = {},
  probeTimeout = Duration.seconds(5),
  budget = Duration.seconds(30),
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { folder } = yield* Stage;

      return TranscodeCapabilities.layer.pipe(
        Layer.provide(Layer.succeed(TranscodeCapabilities.ProbeTimeout, probeTimeout)),
        Layer.provide(Layer.succeed(TranscodeCapabilities.NegotiationBudget, budget)),
        Layer.provideMerge(MediaTools.layer),
        Layer.provide(
          testConfigLayer({
            FFMPEG_PATH: ffmpeg,
            DATA_DIR: path.join(folder, "data"),
            HARDWARE_ACCELERATION: "qsv",
            QSV_DEVICE: "/dev/dri/renderD128",
            ...env,
          }),
        ),
      );
    }),
  ).pipe(Layer.provideMerge(stageLayer), Layer.provideMerge(NodeServices.layer));

/** The capability service over a stand-in with `behavior` that logs its runs. */
const standIn = async (behavior: FakeFfmpegBehavior) => {
  const ffmpeg = await writeFakeFfmpeg({ ...behavior, logInvocations: true });

  return { ffmpeg, services: servicesOf(ffmpeg) };
};

const statusOf = (key: ReturnType<typeof capabilityKey>, scope?: Inventory.SourceScope) =>
  Effect.gen(function* () {
    const capabilities = yield* TranscodeCapabilities.Service;

    return Inventory.capabilityOf(yield* capabilities.inventory, key, scope).status;
  });

const plannedImpls = (source: SourceVideo, snapshot: Parameters<typeof planVideo>[2]) =>
  Result.map(planVideo(source, intentOf(source), snapshot), ({ pipeline }) =>
    pipeline.steps.map((step): string => step.impl),
  );

/** How many runs of the stand-in at `ffmpeg` had `token` in their arguments. */
const runsWith = (ffmpeg: string, token: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const log = yield* fs
      .readFileString(invocationsOf(ffmpeg))
      .pipe(Effect.orElseSucceed(() => ""));

    return log.split("\n").filter((line) => line.includes(token)).length;
  });

const pipelineOf = (
  source: SourceVideo,
  snapshot: Parameters<typeof planVideo>[2],
): VideoPipeline => {
  const planned = planVideo(source, intentOf(source), snapshot);

  if (Result.isFailure(planned)) throw new Error(JSON.stringify(planned.failure));

  return planned.success.pipeline;
};

/** Which step owns each name in a log of `pipeline`'s runs, as the renderer lays a run out. */
const ownersOf = (pipeline: VideoPipeline) =>
  renderVideo(pipeline, { input: 0, stream: 0, trimPicture: undefined, trimSubtitle: undefined })
    .owners;

/** A run of the full Quick Sync chain whose fused `vpp_qsv` failed, as ffmpeg reports it. */
const vppFailed = (pipeline: VideoPipeline): TranscodeCapabilities.FailedRun => ({
  request: request(HDR),
  pipeline,
  owners: {
    decoder: { step: 0, names: ["hevc", "hevc_qsv"] },
    encoder: { step: pipeline.steps.length - 1, names: ["h264_qsv"] },
    filters: new Map([["Parsed_vpp_qsv_0", [1, 2]]]),
  },
  failure: { exitCode: 234, signal: null, stderrTail: VPP_FAILED },
});

/** Writes a one-second VP9 file into the stage, not the way the generated clip is made. */
const vp9File = Effect.gen(function* () {
  const tools = yield* MediaTools.Service;
  const path = yield* Path.Path;
  const file = path.join((yield* Stage).folder, "vp9.mkv");

  yield* tools.ffmpeg([
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x240:rate=10:duration=1",
    "-c:v",
    "libvpx-vp9",
    "-b:v",
    "0",
    "-crf",
    "50",
    "-pix_fmt",
    "yuv420p",
    file,
  ]);

  return file;
});

/** Writes a one-second H.264 file in full (JPEG) range into the stage. */
const jpegRangeFile = (name: string) =>
  Effect.gen(function* () {
    const tools = yield* MediaTools.Service;
    const path = yield* Path.Path;
    const file = path.join((yield* Stage).folder, `${name}.mkv`);

    yield* tools.ffmpeg([
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x240:rate=10:duration=1",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuvj420p",
      file,
    ]);

    return file;
  });

const refusing = await standIn({
  rules: [{ token: "tonemap=1", runs: "probe", stderr: VPP_FAILED }],
});

const hanging = await writeFakeFfmpeg({
  rules: [{ token: "tonemap=1", runs: "probe", hang: true }],
});

const IO_SURFACE = "[h264_qsv @ 0x1] Error querying IO surface: unsupported (-3)";

/** The first file's decoder probe fails once armed; the second file's never does. */
const sourceOnly = await standIn({
  rules: [
    { token: "arm-first", runs: "any", arm: "first", stderr: "armed" },
    { token: "first.mkv", runs: "probe", armedBy: "first", stderr: IO_SURFACE },
  ],
});

/** Once armed, every Quick Sync tone map probe fails, as through one outage of the device. */
const outage = await standIn({
  rules: [
    { token: "arm-tonemap", runs: "any", arm: "tonemap", stderr: "armed" },
    { token: "tonemap=1", runs: "probe", armedBy: "tonemap", stderr: VPP_FAILED },
  ],
});

/**
 * Once armed, Quick Sync's tone map and its 8-bit HEVC decoder fail their probes, and the device
 * no longer opens, as when its driver went away.
 */
const deviceLost = await standIn({
  rules: [
    { token: "arm-outage", runs: "any", arm: "outage", stderr: "armed" },
    { token: "tonemap=1", runs: "probe", armedBy: "outage", stderr: VPP_FAILED },
    { token: "hevc-8.mkv", runs: "probe", armedBy: "outage", stderr: IO_SURFACE },
    {
      token: "nullsrc=s=64x64",
      runs: "any",
      armedBy: "outage",
      stderr: "Device creation failed: -5.",
    },
  ],
});

/** Tone map probes that end in a way that proves nothing about the tone map. */
const PROVES_NOTHING: ReadonlyArray<readonly [string, FakeFfmpegBehavior]> = [
  ["stopped by SIGINT", { rules: [{ token: "tonemap=1", runs: "probe", signal: "SIGINT" }] }],
  ["hung up (SIGHUP)", { rules: [{ token: "tonemap=1", runs: "probe", signal: "SIGHUP" }] }],
  [
    "a wrapper that could not run ffmpeg (127)",
    {
      rules: [
        {
          token: "tonemap=1",
          runs: "probe",
          exitCode: 127,
          stderr: "sh: line 1: /usr/bin/ffmpeg: No such file or directory",
        },
      ],
    },
  ],
  ["a clean exit with no frames", { rules: [{ token: "tonemap=1", runs: "probe", exitCode: 0 }] }],
];

const provingNothing = await Promise.all(
  PROVES_NOTHING.map(async ([name, behavior]) => [name, await standIn(behavior)] as const),
);

/** What the Quick Sync HDR10 tone map probe reads, past the clip's path. */
const TONE_MAP_PROBE = "hevc-pq.mkv -map";

/** Every Quick Sync HDR10 tone map probe crashes ffmpeg, as a driver that always faults would. */
const crashing = await standIn({
  rules: [{ token: TONE_MAP_PROBE, runs: "probe", signal: "SIGBUS" }],
});

/** The first Quick Sync HDR10 tone map probe crashes ffmpeg, as an intermittent driver fault would. */
const crashingOnce = await standIn({
  rules: [{ token: TONE_MAP_PROBE, runs: "probe", signal: "SIGBUS", limit: 1 }],
});

/**
 * The Quick Sync HDR10 tone map probe crashes ffmpeg, passes once, then crashes again: a key that
 * crashes in a share of runs, which one lucky pass must not verify.
 */
const crashingAgain = await standIn({
  rules: [
    { token: TONE_MAP_PROBE, runs: "probe", signal: "SIGBUS", limit: 1 },
    { token: TONE_MAP_PROBE, runs: "probe", limit: 1 },
    { token: TONE_MAP_PROBE, runs: "probe", signal: "SIGBUS", limit: 1 },
  ],
});

/** Making the generated MPEG-2 clip takes four seconds, longer than a negotiation waits. */
const slowClip = await writeFakeFfmpeg({
  rules: [{ token: "mpeg2-8.mkv.part", runs: "any", delayMs: 4000 }],
  logInvocations: true,
});

/** The build's first `-version` listing fails, as a transient error would make it; later ones work. */
const listingOnceFailed = await writeFakeFfmpeg({
  rules: [
    {
      token: "-version",
      runs: "any",
      limit: 1,
      stderr: "ffmpeg: error while loading shared libraries: libva.so.2: cannot open shared object",
    },
  ],
  logInvocations: true,
});

const relapsing = await standIn({
  rules: [
    { token: "arm-tonemap", runs: "any", arm: "tonemap", stderr: "armed" },
    { token: "tonemap=1", runs: "probe", armedBy: "tonemap", limit: 1, stderr: VPP_FAILED },
  ],
});

const plain = await standIn({});

/** The device check opens the device and names its driver as `line` does, then exits 0. */
const namingDriver = (line: string) =>
  standIn({
    rules: [{ token: "nullsrc=s=64x64", runs: "any", stderr: line, exitCode: 0 }],
  });

/** Debian's iHD 25.2.3 prints an empty build note after its version. */
const emptyBuildNote = await namingDriver(
  "[AVHWDeviceContext @ 0x1] VAAPI driver: Intel iHD driver for Intel(R) Gen Graphics - 25.2.3 ().",
);

const buildNote = await namingDriver(
  "[AVHWDeviceContext @ 0x1] VAAPI driver: Intel iHD driver for Intel(R) Gen Graphics - 25.2.3 (1.2).",
);

/** This build cannot make the generated VP9 clip, as one without that encoder setting couldn't. */
const clipless = await standIn({
  rules: [
    {
      token: "libvpx-vp9 -deadline realtime",
      runs: "any",
      stderr: "Unknown encoder 'libvpx-vp9'",
    },
  ],
});

const live = { excludeTestServices: true, timeout: "60 seconds" } as const;

describe.skipIf(!hasFfmpeg)("TranscodeCapabilities", () => {
  layer(
    refusing.services,
    live,
  )((it) => {
    it.effect(
      "verifies what the device runs, refuses what its probes reject, and plans around it",
      () =>
        Effect.gen(function* () {
          const capabilities = yield* TranscodeCapabilities.Service;
          const snapshot = yield* capabilities.resolve(request(HDR));

          assert.strictEqual(yield* statusOf(TONE_MAP_QSV), "unsupported");
          assert.strictEqual(
            yield* statusOf(capabilityKey(ImplId("encode.qsv"), "h264/8/cbr")),
            "verified",
          );
          assert.strictEqual(yield* capabilities.hardwareEncoder, "qsv");
          assert.deepStrictEqual(
            plannedImpls(HDR, snapshot),
            Result.succeed([
              "decode.qsv",
              "scale.qsv",
              "move.qsv>cpu",
              "tonemap.cpu",
              "move.cpu>qsv",
              "encode.qsv",
            ]),
          );
        }),
      60_000,
    );
  });

  layer(
    servicesOf(hanging, {}, Duration.seconds(1)),
    live,
  )((it) => {
    it.effect(
      "leaves a key unknown when its probe times out, and plans without it",
      () =>
        Effect.gen(function* () {
          const capabilities = yield* TranscodeCapabilities.Service;
          const snapshot = yield* capabilities.resolve(request(HDR));
          const known = Inventory.capabilityOf(yield* capabilities.inventory, TONE_MAP_QSV);

          assert.strictEqual(known.status, "unknown");
          assert.deepStrictEqual(
            known.evidence.map((evidence) =>
              Inventory.Evidence.$is("Probe")(evidence) ? evidence.outcome : "build",
            ),
            ["inconclusive"],
          );
          assert.isFalse(snapshot.verified.has(TONE_MAP_QSV));
          assert.isTrue(Result.isSuccess(planVideo(HDR, intentOf(HDR), snapshot)));
        }),
      60_000,
    );
  });

  layer(
    sourceOnly.services,
    live,
  )((it) => {
    it.effect(
      "keeps a failure reproduced only on one file to that file: a healthy file of the same variant keeps GPU decode",
      () =>
        Effect.gen(function* () {
          const capabilities = yield* TranscodeCapabilities.Service;
          const tools = yield* MediaTools.Service;
          const first = request(JPEG_RANGE, "first", yield* jpegRangeFile("first"));
          const second = request(JPEG_RANGE, "second", yield* jpegRangeFile("second"));
          const snapshot = yield* capabilities.resolve(first);

          assert.isTrue(snapshot.verified.has(DECODE_JPEG_RANGE));
          assert.strictEqual(yield* statusOf(DECODE_JPEG_RANGE), "unknown");
          assert.strictEqual(yield* statusOf(DECODE_JPEG_RANGE, second.scope), "unknown");

          // No generated clip has this layout, so the diagnosis re-probes the first file itself.
          yield* tools.ffmpeg(["arm-first"]).pipe(Effect.ignore);
          const pipeline = pipelineOf(JPEG_RANGE, snapshot);

          const diagnosis = yield* capabilities.diagnose({
            request: first,
            pipeline,
            owners: {
              decoder: { step: 0, names: ["h264", "h264_qsv"] },
              encoder: { step: pipeline.steps.length - 1, names: ["h264_qsv"] },
              filters: new Map(),
            },
            failure: { exitCode: 69, signal: null, stderrTail: IO_SURFACE },
          });

          assert.deepStrictEqual(diagnosis, Diagnosis.Source({ impls: [ImplId("decode.qsv")] }));

          const shared = Inventory.capabilityOf(yield* capabilities.inventory, DECODE_JPEG_RANGE);

          assert.strictEqual(shared.status, "unknown");
          assert.isTrue(Option.isNone(shared.quarantine), "nothing shared is set aside");

          const healthy = yield* capabilities.resolve(second);

          assert.strictEqual(
            plannedImpls(JPEG_RANGE, healthy)
              .pipe(Result.getOrElse(() => []))
              .at(0),
            "decode.qsv",
            "the healthy file still decodes on the GPU",
          );
          assert.strictEqual(yield* statusOf(DECODE_JPEG_RANGE, second.scope), "verified");

          const failing = yield* capabilities.resolve(first);

          assert.isTrue(failing.excluded.has(ImplId("decode.qsv")));
          assert.notInclude(
            plannedImpls(JPEG_RANGE, failing).pipe(
              Result.getOrElse((): ReadonlyArray<string> => []),
            ),
            "decode.qsv",
          );
        }),
      60_000,
    );
  });

  layer(
    outage.services,
    live,
  )((it) => {
    it.effect(
      "takes one strike for one outage, however many diagnoses report it",
      () =>
        Effect.gen(function* () {
          const capabilities = yield* TranscodeCapabilities.Service;
          const tools = yield* MediaTools.Service;
          const warm = yield* capabilities.resolve(request(HDR));

          assert.isTrue(warm.verified.has(TONE_MAP_QSV));
          yield* tools.ffmpeg(["arm-tonemap"]).pipe(Effect.ignore);
          const failed = vppFailed(pipelineOf(HDR, warm));

          const struck = Diagnosis.Capability({
            keys: [TONE_MAP_QSV],
            impls: [ImplId("tonemap.qsv")],
          });

          // Two viewers' runs failed at once, and a third's diagnosis begins after the quarantine.
          const both = yield* Effect.all(
            [capabilities.diagnose(failed), capabilities.diagnose(failed)],
            {
              concurrency: 2,
            },
          );

          const later = yield* capabilities.diagnose(failed);

          assert.deepStrictEqual(both, [struck, struck]);
          assert.deepStrictEqual(later, struck);
          assert.deepStrictEqual(
            Option.map(
              Inventory.capabilityOf(yield* capabilities.inventory, TONE_MAP_QSV).quarantine,
              (quarantine) => quarantine.strikes,
            ),
            Option.some(1),
          );
        }),
      60_000,
    );
  });

  layer(
    deviceLost.services,
    live,
  )((it) => {
    it.effect(
      "opens the device again after two of its keys are quarantined within a minute, and forgets it when it no longer opens",
      () =>
        Effect.gen(function* () {
          const capabilities = yield* TranscodeCapabilities.Service;
          const tools = yield* MediaTools.Service;
          const warm = yield* capabilities.resolve(request(HDR));
          const pipeline = pipelineOf(HDR, warm);
          const sdr: SourceVideo = { ...HDR, pixelFormat: "yuv420p", depth: 8, colour: "sdr" };
          const sdrPipeline = pipelineOf(sdr, yield* capabilities.resolve(request(sdr)));
          const identified = (yield* capabilities.inventory).devices.get("qsv");

          assert.strictEqual(identified?.opened, true);
          assert.strictEqual(pipeline.steps[0]?.impl, ImplId("decode.qsv"));
          assert.strictEqual(sdrPipeline.steps[0]?.impl, ImplId("decode.qsv"));
          yield* tools.ffmpeg(["arm-outage"]).pipe(Effect.ignore);

          // One quarantine on the device opens nothing.
          assert.deepStrictEqual(
            yield* capabilities.diagnose(vppFailed(pipeline)),
            Diagnosis.Capability({ keys: [TONE_MAP_QSV], impls: [ImplId("tonemap.qsv")] }),
          );
          assert.strictEqual((yield* capabilities.inventory).devices.get("qsv"), identified);

          const decoderFailed = yield* capabilities.diagnose({
            request: request(sdr),
            pipeline: sdrPipeline,
            owners: {
              decoder: { step: 0, names: ["hevc", "hevc_qsv"] },
              encoder: { step: sdrPipeline.steps.length - 1, names: ["h264_qsv"] },
              filters: new Map(),
            },
            failure: { exitCode: 69, signal: null, stderrTail: IO_SURFACE.replace("h264", "hevc") },
          });

          assert.isTrue(Diagnosis.$is("Capability")(decoderFailed));

          // The second opens the device again, which fails: its keys are forgotten.
          const reopened = yield* capabilities.inventory.pipe(
            Effect.map((known) => known.devices.get("qsv")),
            Effect.filterOrFail((device) => device !== identified),
            Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
            Effect.orDie,
          );

          assert.strictEqual(reopened?.opened, false);
          assert.strictEqual(
            yield* statusOf(capabilityKey(ImplId("encode.qsv"), "h264/8/cbr")),
            "unknown",
          );

          const after = yield* capabilities.resolve(request(HDR));

          assert.deepStrictEqual(after.domains, []);
          assert.deepStrictEqual(
            plannedImpls(HDR, after),
            Result.succeed(["decode.cpu", "scale.cpu", "tonemap.cpu", "encode.cpu"]),
          );
        }),
      60_000,
    );
  });

  for (const [name, provingNothingOf] of provingNothing) {
    layer(
      provingNothingOf.services,
      live,
    )((it) => {
      it.effect(
        `leaves a key unknown, with a backoff, after a probe ${name}`,
        () =>
          Effect.gen(function* () {
            const capabilities = yield* TranscodeCapabilities.Service;
            const snapshot = yield* capabilities.resolve(request(HDR));
            const known = Inventory.capabilityOf(yield* capabilities.inventory, TONE_MAP_QSV);

            assert.strictEqual(known.status, "unknown");
            assert.deepStrictEqual(
              known.evidence.map((evidence) =>
                Inventory.Evidence.$is("Probe")(evidence) ? evidence.outcome : "build",
              ),
              ["inconclusive"],
            );
            assert.isAbove(known.retryAt, 0);
            assert.isFalse(snapshot.verified.has(TONE_MAP_QSV));
          }),
        60_000,
      );
    });
  }

  layer(crashing.services, { timeout: "60 seconds" })((it) => {
    it.effect(
      "sets a key whose probe crashes ffmpeg aside for 15 minutes, then 2 hours, then until a restart, probing it again after each",
      () =>
        Effect.gen(function* () {
          const capabilities = yield* TranscodeCapabilities.Service;

          const strikes = Effect.map(capabilities.inventory, (known) =>
            Option.map(
              Inventory.capabilityOf(known, TONE_MAP_QSV).quarantine,
              ({ strikes: struck, until }) => [struck, until === "restart"] as const,
            ),
          );

          const first = yield* capabilities.resolve(request(HDR));
          const known = Inventory.capabilityOf(yield* capabilities.inventory, TONE_MAP_QSV);

          assert.strictEqual(known.status, "unknown", "a crash refuses nothing");
          assert.deepStrictEqual(
            known.evidence.map((evidence) =>
              Inventory.Evidence.$is("Probe")(evidence) ? evidence.outcome : "build",
            ),
            ["crashed"],
          );
          assert.deepStrictEqual(yield* strikes, Option.some([1, false] as const));
          assert.isFalse(first.verified.has(TONE_MAP_QSV));
          assert.include(
            plannedImpls(HDR, first).pipe(Result.getOrElse((): ReadonlyArray<string> => [])),
            "tonemap.cpu",
          );
          // Runs that read the clip: its making, once, and each probe of the tone map.
          const toneMapRuns = runsWith(crashing.ffmpeg, "hevc-pq.mkv");
          const probes = yield* toneMapRuns;

          // Within the quarantine nothing probes it; once it ends, the next negotiation does.
          yield* TestClock.adjust(Duration.minutes(14));
          yield* capabilities.resolve(request(HDR));
          assert.strictEqual(yield* toneMapRuns, probes);

          yield* TestClock.adjust(Duration.minutes(1));
          yield* capabilities.resolve(request(HDR));
          assert.strictEqual(yield* toneMapRuns, probes + 1);
          assert.deepStrictEqual(yield* strikes, Option.some([2, false] as const));

          yield* TestClock.adjust(Duration.hours(2));
          yield* capabilities.resolve(request(HDR));
          assert.strictEqual(yield* toneMapRuns, probes + 2);
          assert.deepStrictEqual(yield* strikes, Option.some([3, true] as const));

          // A path that always crashes stays out until the server restarts.
          yield* TestClock.adjust(Duration.days(7));
          const last = yield* capabilities.resolve(request(HDR));

          assert.strictEqual(yield* toneMapRuns, probes + 2);
          assert.isFalse(last.verified.has(TONE_MAP_QSV));
        }),
      60_000,
    );
  });

  layer(crashingOnce.services, { timeout: "60 seconds" })((it) => {
    it.effect(
      "verifies a key whose probe crashed once after three clean runs in a row 15 minutes later",
      () =>
        Effect.gen(function* () {
          const capabilities = yield* TranscodeCapabilities.Service;
          const first = yield* capabilities.resolve(request(HDR));

          assert.isFalse(first.verified.has(TONE_MAP_QSV));
          assert.strictEqual(yield* statusOf(TONE_MAP_QSV), "unknown");
          const probes = yield* runsWith(crashingOnce.ffmpeg, "hevc-pq.mkv");

          yield* TestClock.adjust(Duration.minutes(15));
          const later = yield* capabilities.resolve(request(HDR));

          // The tone map's probe runs once; with one strike, three times that.
          assert.strictEqual(yield* runsWith(crashingOnce.ffmpeg, "hevc-pq.mkv"), probes + 3);
          assert.isTrue(later.verified.has(TONE_MAP_QSV));
          assert.deepStrictEqual(
            plannedImpls(HDR, later),
            Result.succeed(["decode.qsv", "scale.qsv", "tonemap.qsv", "encode.qsv"]),
          );
        }),
      60_000,
    );
  });

  layer(crashingAgain.services, { timeout: "60 seconds" })((it) => {
    it.effect(
      "keeps a key that crashed set aside when one of its clean runs after the quarantine crashes",
      () =>
        Effect.gen(function* () {
          const capabilities = yield* TranscodeCapabilities.Service;

          yield* capabilities.resolve(request(HDR));
          yield* TestClock.adjust(Duration.minutes(15));
          const later = yield* capabilities.resolve(request(HDR));
          const known = Inventory.capabilityOf(yield* capabilities.inventory, TONE_MAP_QSV);

          assert.isFalse(later.verified.has(TONE_MAP_QSV), "one lucky pass verifies nothing");
          assert.strictEqual(known.status, "unknown");
          assert.deepStrictEqual(
            Option.map(known.quarantine, (quarantine) => quarantine.strikes),
            Option.some(2),
          );
        }),
      60_000,
    );
  });

  layer(
    // Probes may take as long as they need on a busy machine: the negotiation's budget is the
    // production one, and what is under test is what happens after it runs out.
    servicesOf(slowClip, {}, Duration.seconds(30), Duration.seconds(3)),
    live,
  )((it) => {
    it.effect(
      "keeps making a probe clip after the negotiation that asked for it stops waiting",
      () =>
        Effect.gen(function* () {
          const capabilities = yield* TranscodeCapabilities.Service;
          const mpeg2: SourceVideo = { ...JPEG_RANGE, codec: "mpeg2video", pixelFormat: "yuv420p" };
          const key = capabilityKey(ImplId("decode.qsv"), "mpeg2video/yuv420p");
          const first = yield* capabilities.resolve(request(mpeg2));

          assert.isFalse(first.verified.has(key), "the clip was not ready within the budget");
          assert.strictEqual(
            plannedImpls(mpeg2, first)
              .pipe(Result.getOrElse(() => []))
              .at(0),
            "decode.cpu",
          );

          // The clip is finished in the background and the key probed on it, however busy the
          // machine; a pending clip left behind by the first negotiation never gets that far.
          yield* statusOf(key).pipe(
            Effect.filterOrFail((status) => status === "verified"),
            Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 200 }),
            Effect.orDie,
          );
          const later = yield* capabilities.resolve(request(mpeg2));

          assert.isTrue(later.verified.has(key));
          assert.strictEqual(
            plannedImpls(mpeg2, later)
              .pipe(Result.getOrElse(() => []))
              .at(0),
            "decode.qsv",
          );
          assert.strictEqual(yield* runsWith(slowClip, "mpeg2-8.mkv.part"), 1);
        }),
      60_000,
    );
  });

  layer(
    servicesOf(listingOnceFailed, { HARDWARE_ACCELERATION: "none" }),
    live,
  )((it) => {
    it.effect(
      "reads the build's listings again after one failed, and never refuses the CPU for it",
      () =>
        Effect.gen(function* () {
          const capabilities = yield* TranscodeCapabilities.Service;
          const sdr: SourceVideo = { ...JPEG_RANGE, pixelFormat: "yuv420p" };
          const encodeCpu = capabilityKey(ImplId("encode.cpu"), "h264/8/crf");

          // The first need may meet the failed listing; the next reads it again.
          yield* capabilities.current(request(sdr));
          assert.notStrictEqual(yield* statusOf(encodeCpu), "unsupported");
          const snapshot = yield* capabilities.current(request(sdr));

          assert.isTrue(Option.isSome((yield* capabilities.inventory).build));
          assert.deepStrictEqual(
            plannedImpls(sdr, snapshot),
            Result.succeed(["decode.cpu", "scale.cpu", "encode.cpu"]),
          );
          assert.strictEqual(yield* runsWith(listingOnceFailed, "-version"), 2);
        }),
      60_000,
    );
  });

  layer(relapsing.services, { timeout: "60 seconds" })((it) => {
    it.effect(
      "quarantines a key whose failure reproduces, and probes it again once the quarantine ends",
      () =>
        Effect.gen(function* () {
          const capabilities = yield* TranscodeCapabilities.Service;
          const tools = yield* MediaTools.Service;
          const warm = yield* capabilities.resolve(request(HDR));

          assert.isTrue(warm.verified.has(TONE_MAP_QSV));
          yield* tools.ffmpeg(["arm-tonemap"]).pipe(Effect.ignore);
          const diagnosis = yield* capabilities.diagnose(vppFailed(pipelineOf(HDR, warm)));

          assert.deepStrictEqual(
            diagnosis,
            Diagnosis.Capability({ keys: [TONE_MAP_QSV], impls: [ImplId("tonemap.qsv")] }),
          );

          // The probe that failed again is the key's newest evidence, beside its quarantine.
          const [shown] = Inventory.capabilityOf(
            yield* capabilities.inventory,
            TONE_MAP_QSV,
          ).evidence;

          assert.deepInclude(shown, { _tag: "Probe", outcome: "rejected", detail: VPP_FAILED });

          const quarantined = yield* capabilities.resolve(request(HDR));

          assert.isFalse(quarantined.verified.has(TONE_MAP_QSV));
          assert.include(
            plannedImpls(HDR, quarantined).pipe(Result.getOrElse((): ReadonlyArray<string> => [])),
            "tonemap.cpu",
          );
          const probesBefore = yield* runsWith(relapsing.ffmpeg, "tonemap=1");

          yield* TestClock.adjust(Duration.minutes(15));
          const recovered = yield* capabilities.resolve(request(HDR));

          // The probe runs once; with the strike, three clean runs in a row verify it again.
          assert.isTrue(recovered.verified.has(TONE_MAP_QSV));
          assert.strictEqual(yield* runsWith(relapsing.ffmpeg, "tonemap=1"), probesBefore + 3);
        }),
      60_000,
    );
  });

  layer(
    plain.services,
    live,
  )((it) => {
    it.effect(
      "debits nothing for a failure that is not about video",
      () =>
        Effect.gen(function* () {
          const capabilities = yield* TranscodeCapabilities.Service;
          const warm = yield* capabilities.resolve(request(HDR));
          const before = yield* capabilities.inventory;

          const diagnosis = yield* capabilities.diagnose({
            ...vppFailed(pipelineOf(HDR, warm)),
            failure: {
              exitCode: 234,
              signal: null,
              stderrTail:
                "[aost#0:1/copy @ 0x1] Error initializing bitstream filter: aac_adtstoasc",
            },
          });

          const after = yield* capabilities.inventory;

          assert.deepStrictEqual(diagnosis, Diagnosis.NotVideo({ reason: "audio" }));
          assert.deepStrictEqual(after.exclusions, before.exclusions);
          assert.deepStrictEqual(
            [...after.capabilities.values()].map((capability) => [
              capability.key,
              capability.quarantine,
            ]),
            [...before.capabilities.values()].map((capability) => [
              capability.key,
              capability.quarantine,
            ]),
          );
        }),
      60_000,
    );
  });

  layer(
    plain.services,
    live,
  )((it) => {
    it.effect(
      "keeps a file off a row for a day only for a named failure its probe runs past; a crash nothing reproduces keeps the stream off alone",
      () =>
        Effect.gen(function* () {
          const capabilities = yield* TranscodeCapabilities.Service;
          const asked = request(HDR);
          const warm = yield* capabilities.resolve(asked);
          const pipeline = pipelineOf(HDR, warm);
          const gpuRows = pipeline.steps.map((step) => step.impl);

          assert.deepStrictEqual(gpuRows, [
            ImplId("decode.qsv"),
            ImplId("scale.qsv"),
            ImplId("tonemap.qsv"),
            ImplId("encode.qsv"),
          ]);

          // A SIGBUS no probe reproduces: no verdict, and nothing kept from the file.
          const crashed = yield* capabilities.diagnose({
            ...vppFailed(pipeline),
            failure: { exitCode: null, signal: "SIGBUS", stderrTail: VPP_FAILED },
          });

          assert.deepStrictEqual(crashed, Diagnosis.Undecided({ impls: gpuRows }));

          // A last line naming a filter instance this run does not have, after an audio warning.
          const unknownFilter = yield* capabilities.diagnose({
            ...vppFailed(pipeline),
            owners: ownersOf(pipeline),
            failure: {
              exitCode: 234,
              signal: null,
              stderrTail: [
                "[aist#0:1/ac3 @ 0x1] [dec:ac3 @ 0x2] Error submitting packet to decoder: Invalid data found when processing input",
                "[Parsed_vpp_qsv_9 @ 0x3] Invalid color_matrix.",
              ].join("\n"),
            },
          });

          assert.deepStrictEqual(unknownFilter, Diagnosis.Undecided({ impls: gpuRows }));
          assert.isUndefined((yield* capabilities.inventory).exclusions.get(asked.scope));
          assert.isTrue(
            samePipeline(pipelineOf(HDR, yield* capabilities.resolve(asked)), pipeline),
            "the file's next stream keeps its GPU chain",
          );

          // A failure that names vpp_qsv, which ran on the generated clip: the file is refused there.
          const named = yield* capabilities.diagnose(vppFailed(pipeline));

          assert.deepStrictEqual(
            named,
            Diagnosis.Source({ impls: [ImplId("scale.qsv"), ImplId("tonemap.qsv")] }),
          );
          const next = yield* capabilities.resolve(asked);

          assert.isTrue(next.excluded.has(ImplId("scale.qsv")));
          assert.isTrue(next.excluded.has(ImplId("tonemap.qsv")));
        }),
      60_000,
    );
  });

  layer(
    servicesOf(plain.ffmpeg, { HARDWARE_ACCELERATION: "none" }),
    live,
  )((it) => {
    it.effect(
      "keeps the failed stream alone off a CPU row its log named, never the file",
      () =>
        Effect.gen(function* () {
          const capabilities = yield* TranscodeCapabilities.Service;
          const sdr: SourceVideo = { ...JPEG_RANGE, pixelFormat: "yuv420p" };
          const asked = request(sdr);
          const pipeline = pipelineOf(sdr, yield* capabilities.resolve(asked));

          assert.deepStrictEqual(
            pipeline.steps.map((step) => step.impl),
            [ImplId("decode.cpu"), ImplId("scale.cpu"), ImplId("encode.cpu")],
          );

          const diagnosis = yield* capabilities.diagnose({
            request: asked,
            pipeline,
            owners: ownersOf(pipeline),
            failure: {
              exitCode: 1,
              signal: null,
              stderrTail: [
                "[libx264 @ 0x5d1c2a0] Error encoding a video frame",
                "[vost#0:0/libx264 @ 0x5d1c3b0] [enc:libx264 @ 0x5d1c2a0] Error submitting video frame to the encoder",
              ].join("\n"),
            },
          });

          assert.deepStrictEqual(diagnosis, Diagnosis.Source({ impls: [ImplId("encode.cpu")] }));
          const next = yield* capabilities.resolve(asked);

          assert.isFalse(next.excluded.has(ImplId("encode.cpu")));
          assert.deepStrictEqual(
            plannedImpls(sdr, next),
            Result.succeed(["decode.cpu", "scale.cpu", "encode.cpu"]),
            "the file's next stream still has a chain",
          );
        }),
      60_000,
    );
  });

  layer(
    plain.services,
    live,
  )((it) => {
    it.effect(
      "blames the disk, not the decoder, for a full disk after a decode error the run recovered from",
      () =>
        Effect.gen(function* () {
          const capabilities = yield* TranscodeCapabilities.Service;
          const sdr: SourceVideo = { ...JPEG_RANGE, codec: "hevc", pixelFormat: "yuv420p" };
          const warm = yield* capabilities.resolve(request(sdr));
          const pipeline = pipelineOf(sdr, warm);

          assert.strictEqual(pipeline.steps[0]?.impl, ImplId("decode.qsv"));

          const diagnosis = yield* capabilities.diagnose({
            request: request(sdr),
            pipeline,
            owners: {
              decoder: { step: 0, names: ["hevc", "hevc_qsv"] },
              encoder: { step: pipeline.steps.length - 1, names: ["h264_qsv"] },
              filters: new Map(),
            },
            failure: {
              exitCode: 1,
              signal: null,
              stderrTail: [
                "[hevc @ 0x1] Could not find ref with POC 12",
                "[out#0/hls @ 0x2] Error writing trailer: No space left on device",
              ].join("\n"),
            },
          });

          assert.deepStrictEqual(diagnosis, Diagnosis.NotVideo({ reason: "disk" }));

          const next = yield* capabilities.resolve(request(sdr));

          assert.isTrue(
            samePipeline(pipelineOf(sdr, next), pipeline),
            "the next play keeps its chain",
          );
        }),
      60_000,
    );
  });

  layer(
    servicesOf(realFfmpeg, { QSV_DEVICE: "/dev/dri/no-such-render-node" }),
    live,
  )((it) => {
    it.effect(
      "probes a forced HARDWARE_ACCELERATION, and leaves a device that will not open out",
      () =>
        Effect.gen(function* () {
          const capabilities = yield* TranscodeCapabilities.Service;
          const snapshot = yield* capabilities.resolve(request(HDR));
          const device = (yield* capabilities.inventory).devices.get("qsv");

          assert.strictEqual(device?.opened, false);
          assert.deepStrictEqual(snapshot.domains, []);
          assert.isUndefined(yield* capabilities.hardwareEncoder);
          assert.deepStrictEqual(
            plannedImpls(HDR, snapshot),
            Result.succeed(["decode.cpu", "scale.cpu", "tonemap.cpu", "encode.cpu"]),
          );
        }),
      60_000,
    );
  });

  for (const [named, standInOf, driver] of [
    [
      "drops an empty build note",
      emptyBuildNote,
      "Intel iHD driver for Intel(R) Gen Graphics - 25.2.3",
    ],
    ["keeps a build note", buildNote, "Intel iHD driver for Intel(R) Gen Graphics - 25.2.3 (1.2)"],
  ] as const) {
    layer(
      standInOf.services,
      live,
    )((it) => {
      it.effect(
        `records the userspace driver the device check names, and ${named}`,
        () =>
          Effect.gen(function* () {
            const capabilities = yield* TranscodeCapabilities.Service;

            yield* capabilities.resolve(request(HDR));
            const device = (yield* capabilities.inventory).devices.get("qsv");

            assert.strictEqual(device?.opened, true);
            assert.strictEqual(device?.userDriver, driver);
          }),
        60_000,
      );
    });
  }

  layer(
    clipless.services,
    live,
  )((it) => {
    it.effect(
      "proves a decoder on the real source when this build cannot make its generated clip",
      () =>
        Effect.gen(function* () {
          const capabilities = yield* TranscodeCapabilities.Service;
          const vp9: SourceVideo = { ...JPEG_RANGE, codec: "vp9", pixelFormat: "yuv420p" };
          const asked = request(vp9, "vp9", yield* vp9File);
          const snapshot = yield* capabilities.resolve(asked);
          const key = capabilityKey(ImplId("decode.qsv"), "vp9/yuv420p");

          assert.isTrue(snapshot.verified.has(key));
          assert.strictEqual(yield* statusOf(key), "unknown");
          assert.strictEqual(yield* statusOf(key, asked.scope), "verified");
        }),
      60_000,
    );
  });
});
