import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Context, Duration, Effect, Fiber, FileSystem, Layer, Path, Result } from "effect";
import { TestClock } from "effect/testing";

import { MediaFileId } from "@media/contracts/ids";

import * as MediaTools from "../media/media-tools.ts";
import { type FakeFfmpegBehavior, invocationsOf, writeFakeFfmpeg } from "../testing/fake-ffmpeg.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import { testConfigLayer } from "../testing/test-config.ts";
import * as Inventory from "./capability-inventory.ts";
import * as TranscodeCapabilities from "./transcode-capabilities.ts";
import { Diagnosis } from "./transcode-recovery.ts";
import { planVideo, type VideoIntent, type VideoPipeline } from "./video-pipeline.ts";
import { capabilityKey, ImplId, type SourceVideo } from "./video-ops.ts";

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

/** The capability service over `ffmpeg`, forcing Quick Sync on a render node unless `env` says otherwise. */
const servicesOf = (
  ffmpeg: string,
  env: Readonly<Record<string, string>> = {},
  probeTimeout = Duration.seconds(5),
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { folder } = yield* Stage;

      return TranscodeCapabilities.layer.pipe(
        Layer.provide(Layer.succeed(TranscodeCapabilities.ProbeTimeout, probeTimeout)),
        Layer.provide(Layer.succeed(TranscodeCapabilities.NegotiationBudget, Duration.seconds(30))),
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

/** A run of the full Quick Sync chain whose fused `vpp_qsv` failed, as ffmpeg reports it. */
const vppFailed = (pipeline: VideoPipeline): TranscodeCapabilities.FailedRun => ({
  request: request(HDR),
  pipeline,
  owners: {
    decoder: { step: 0, names: ["hevc", "hevc_qsv"] },
    encoder: { step: pipeline.steps.length - 1, names: ["h264_qsv"] },
    filters: new Map([["Parsed_vpp_qsv_0", [1, 2]]]),
  },
  failure: { exitCode: 234, signal: null, stderrHead: VPP_FAILED },
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

const racing = await standIn({
  rules: [
    { token: "held.mkv", runs: "probe", delayMs: 1500 },
    { token: "arm-first", runs: "any", arm: "first", stderr: "armed" },
    {
      token: "first.mkv",
      runs: "probe",
      armedBy: "first",
      stderr: "[h264_qsv @ 0x1] Error querying IO surface: unsupported (-3)",
    },
  ],
});

const relapsing = await standIn({
  rules: [
    { token: "arm-tonemap", runs: "any", arm: "tonemap", stderr: "armed" },
    { token: "tonemap=1", runs: "probe", armedBy: "tonemap", limit: 1, stderr: VPP_FAILED },
  ],
});

const plain = await standIn({});

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
    racing.services,
    live,
  )((it) => {
    it.effect(
      "keeps a real source's decoder evidence to that source, and drops a probe a quarantine overtook",
      () =>
        Effect.gen(function* () {
          const capabilities = yield* TranscodeCapabilities.Service;
          const tools = yield* MediaTools.Service;
          const first = request(JPEG_RANGE, "first", yield* jpegRangeFile("first"));
          const second = request(JPEG_RANGE, "second", yield* jpegRangeFile("second"));
          const held = request(JPEG_RANGE, "held", yield* jpegRangeFile("held"));
          const snapshot = yield* capabilities.resolve(first);

          assert.isTrue(snapshot.verified.has(DECODE_JPEG_RANGE));
          assert.strictEqual(yield* statusOf(DECODE_JPEG_RANGE), "unknown");
          assert.strictEqual(yield* statusOf(DECODE_JPEG_RANGE, second.scope), "unknown");

          // A slow probe holds the queue; the diagnosis's probe of the first source queues next,
          // the second source's probe after it, under the epoch before the diagnosis's quarantine.
          yield* tools.ffmpeg(["arm-first"]).pipe(Effect.ignore);
          const holding = yield* capabilities.resolve(held).pipe(Effect.forkChild);

          yield* Effect.sleep("300 millis");
          const pipeline = pipelineOf(JPEG_RANGE, snapshot);

          const diagnosing = yield* capabilities
            .diagnose({
              request: first,
              pipeline,
              owners: {
                decoder: { step: 0, names: ["h264", "h264_qsv"] },
                encoder: { step: pipeline.steps.length - 1, names: ["h264_qsv"] },
                filters: new Map(),
              },
              failure: {
                exitCode: 69,
                signal: null,
                stderrHead: "[h264_qsv @ 0x1] Error querying IO surface: unsupported (-3)",
              },
            })
            .pipe(Effect.forkChild);

          yield* Effect.sleep("300 millis");
          const resolving = yield* capabilities.resolve(second).pipe(Effect.forkChild);
          const diagnosis = yield* Fiber.join(diagnosing);

          yield* Fiber.join(resolving);
          yield* Fiber.join(holding);

          assert.deepStrictEqual(
            diagnosis,
            Diagnosis.Capability({ keys: [DECODE_JPEG_RANGE], impls: [ImplId("decode.qsv")] }),
          );
          assert.strictEqual(yield* runsWith(racing.ffmpeg, "second.mkv"), 2);
          assert.strictEqual(yield* statusOf(DECODE_JPEG_RANGE, second.scope), "unknown");
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

          const quarantined = yield* capabilities.resolve(request(HDR));

          assert.isFalse(quarantined.verified.has(TONE_MAP_QSV));
          assert.include(
            plannedImpls(HDR, quarantined).pipe(Result.getOrElse((): ReadonlyArray<string> => [])),
            "tonemap.cpu",
          );
          const probesBefore = yield* runsWith(relapsing.ffmpeg, "tonemap=1");

          yield* TestClock.adjust(Duration.minutes(15));
          const recovered = yield* capabilities.resolve(request(HDR));

          assert.isTrue(recovered.verified.has(TONE_MAP_QSV));
          assert.strictEqual(yield* runsWith(relapsing.ffmpeg, "tonemap=1"), probesBefore + 1);
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
              stderrHead:
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
});
