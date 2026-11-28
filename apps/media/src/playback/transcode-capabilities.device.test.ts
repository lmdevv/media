import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Clock, Console, Duration, Effect, FileSystem, Layer, Path, Result } from "effect";

import { MediaFileId } from "@media/contracts/ids";

import * as MediaTools from "../media/media-tools.ts";
import { qsvUsable, vaapiUsable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import { testConfigLayer } from "../testing/test-config.ts";
import * as Inventory from "./capability-inventory.ts";
import { PROBE_CLIPS, PROBE_SCRIPT } from "./probe-clips.ts";
import * as TranscodeCapabilities from "./transcode-capabilities.ts";
import {
  type CapabilitySnapshot,
  planVideo,
  ProbeInput,
  type VideoIntent,
  VIDEO_OPS,
} from "./video-pipeline.ts";
import { probeCommandArgs, probedFrames } from "./video-render.ts";
import {
  capabilityKey,
  type ClipName,
  encodeRowId,
  type GpuDomain,
  ImplId,
  implOf,
  Op,
  OUTPUT_CODECS,
  type OutputCodec,
  PROBE_IMAGE_SUBTITLE,
  sdrTarget,
} from "./video-ops.ts";

const hasQsv = await qsvUsable();

const hasVaapi = await vaapiUsable();

const PROBE_TIMEOUT = Duration.seconds(5);

/**
 * The capability service on this machine's real device: `FFMPEG_PATH` and its drivers, Quick Sync
 * and VA-API on the render nodes `QSV_DEVICE` and `VAAPI_DEVICE` name.
 */
const onDevice = Layer.unwrap(
  Effect.gen(function* () {
    const workspace = yield* FixtureWorkspace.Service;
    const path = yield* Path.Path;

    return TranscodeCapabilities.layer.pipe(
      Layer.provide(Layer.succeed(TranscodeCapabilities.ProbeTimeout, PROBE_TIMEOUT)),
      Layer.provide(Layer.succeed(TranscodeCapabilities.NegotiationBudget, Duration.minutes(2))),
      Layer.provideMerge(MediaTools.layer),
      Layer.provide(
        testConfigLayer({
          FFMPEG_PATH: process.env["FFMPEG_PATH"] ?? "ffmpeg",
          DATA_DIR: path.join(workspace.root, "capabilities"),
          HARDWARE_ACCELERATION: "auto",
          QSV_DEVICE: process.env["QSV_DEVICE"] ?? "/dev/dri/renderD128",
          VAAPI_DEVICE: process.env["VAAPI_DEVICE"] ?? "/dev/dri/renderD128",
        }),
      ),
    );
  }),
).pipe(Layer.provideMerge(FixtureWorkspace.layer), Layer.provideMerge(NodeServices.layer));

/** The text subtitle a chain draws: the probes' own script, from the source's size. */
const TEXT = Op.BurnText({
  subtitle: { codec: "ass", style: "styled", storage: { width: 320, height: 240 } },
});

/** The subtitle a chain draws in, by kind. */
const BURNS = { image: Op.BurnImage({ subtitle: PROBE_IMAGE_SUBTITLE }), text: TEXT } as const;

interface Chain {
  readonly name: string;
  readonly clip: ClipName;
  readonly domain: GpuDomain | "cpu";
  /** A subtitle drawn in: the probes' image canvas, or their text script. */
  readonly burn?: "image" | "text";
  /** Rows kept out, to make the planner use another. */
  readonly without?: ReadonlyArray<string>;
  /** The stages the chain must plan, when they are part of what it proves. */
  readonly stages?: ReadonlyArray<string>;
  /** Stages the chain must plan among others, whatever decodes it. */
  readonly includes?: ReadonlyArray<string>;
  /** What it encodes to; H.264 when absent. */
  readonly output?: OutputCodec;
}

/** Chains that between them use every row the table has on each domain. */
const chainsOn = (domain: GpuDomain): ReadonlyArray<Chain> => [
  { name: `${domain}: H.264 on the GPU`, clip: "h264-8", domain },
  { name: `${domain}: HEVC Main 10 on the GPU`, clip: "hevc-10", domain },
  { name: `${domain}: HDR10 tone-mapped on the GPU`, clip: "hevc-pq", domain },
  {
    name: `${domain}: 10-bit H.264 decoded on the CPU, scaled and encoded on the GPU`,
    clip: "h264-10",
    domain,
    // Intel's media engines decode no 10-bit H.264, and Quick Sync's map takes no software frames.
    stages: ["decode.cpu", `move.cpu>${domain}`, `scale.${domain}`, `encode.${domain}.h264`],
  },
  {
    name: `${domain}: HDR10 tone-mapped on the CPU between GPU stages`,
    clip: "hevc-pq",
    domain,
    without: [`tonemap.${domain}`],
  },
  {
    name: `${domain}: an image subtitle drawn on the GPU`,
    clip: "h264-8",
    domain,
    burn: "image",
    includes: [`burn-image.${domain}`, `encode.${domain}.h264`],
  },
  {
    name: `${domain}: an image subtitle drawn on the CPU between GPU stages`,
    clip: "h264-8",
    domain,
    burn: "image",
    without: [`burn-image.${domain}`],
    includes: [`move.${domain}>cpu`, "burn-image.cpu", `move.cpu>${domain}`],
  },
  {
    name: `${domain}: a text subtitle drawn with libass between GPU stages`,
    clip: "h264-8",
    domain,
    burn: "text",
    includes: [`move.${domain}>cpu`, "burn-text.cpu", `move.cpu>${domain}`],
  },
  { name: `${domain}: MPEG-2`, clip: "mpeg2-8", domain },
  { name: `${domain}: AV1`, clip: "av1-8", domain },
  { name: `${domain}: VP9`, clip: "vp9-10", domain },
  { name: `${domain}: H.264 encoded to HEVC`, clip: "h264-8", domain, output: "hevc" },
  { name: `${domain}: HEVC Main 10 encoded to AV1`, clip: "hevc-10", domain, output: "av1" },
  {
    // VA-API's MPEG-2 decoder crashes in a share of runs on an Arc A380, so it may be set aside.
    name: `${domain}: interlaced MPEG-2 deinterlaced on the GPU`,
    clip: "mpeg2-8-interlaced",
    domain,
    includes: [`deinterlace.${domain}`, `scale.${domain}`, `encode.${domain}.h264`],
  },
  {
    name: `${domain}: interlaced 10-bit H.264 decoded on the CPU, deinterlaced on the GPU`,
    clip: "h264-10-interlaced",
    domain,
    stages: [
      "decode.cpu",
      `move.cpu>${domain}`,
      `deinterlace.${domain}`,
      `scale.${domain}`,
      `encode.${domain}.h264`,
    ],
  },
  {
    name: `${domain}: interlaced MPEG-2 deinterlaced on the CPU between GPU stages`,
    clip: "mpeg2-8-interlaced",
    domain,
    without: [`deinterlace.${domain}`],
    includes: ["deinterlace.cpu", `move.cpu>${domain}`, `scale.${domain}`, `encode.${domain}.h264`],
  },
];

const CPU_CHAINS: ReadonlyArray<Chain> = [
  { name: "cpu: HDR10 tone-mapped", clip: "hevc-pq", domain: "cpu" },
  { name: "cpu: an image subtitle burned in", clip: "h264-8", domain: "cpu", burn: "image" },
  { name: "cpu: a text subtitle drawn with libass", clip: "h264-8", domain: "cpu", burn: "text" },
  { name: "cpu: H.264 encoded to HEVC", clip: "h264-8", domain: "cpu", output: "hevc" },
  { name: "cpu: H.264 encoded to AV1", clip: "h264-8", domain: "cpu", output: "av1" },
  { name: "cpu: interlaced MPEG-2 deinterlaced", clip: "mpeg2-8-interlaced", domain: "cpu" },
  {
    name: "cpu: interlaced 10-bit H.264 deinterlaced with yadif",
    clip: "h264-10-interlaced",
    domain: "cpu",
    without: ["deinterlace.cpu"],
    stages: ["decode.cpu", "deinterlace.cpu.yadif", "scale.cpu", "encode.cpu.h264"],
  },
];

const intentOf = (chain: Chain): VideoIntent => ({
  targets: [sdrTarget(chain.output ?? "h264")],
  frameRate: undefined,
  bounds: { width: 320, height: 180 },
  cpuEncodeBounds: { width: 1920, height: 1080 },
  maxBitrate: 1_000_000,
  burn: chain.burn === undefined ? undefined : BURNS[chain.burn],
});

const requestOf = (chain: Chain): TranscodeCapabilities.Request => ({
  scope: Inventory.sourceScope(MediaFileId.make(chain.clip), 0, 0, 0),
  path: "",
  stream: 0,
  source: PROBE_CLIPS[chain.clip].source,
  intent: intentOf(chain),
  excluded: new Set(),
});

/** Waits until probing stops: no key gained evidence for three seconds. */
const settled = Effect.gen(function* () {
  const capabilities = yield* TranscodeCapabilities.Service;
  let last = -1;
  let quiet = 0;

  for (let elapsed = 0; elapsed < 240 && quiet < 3; elapsed += 1) {
    const known = [...(yield* capabilities.inventory).capabilities.values()].reduce(
      (total, capability) => total + capability.evidence.length,
      0,
    );

    quiet = known === last ? quiet + 1 : 0;
    last = known;
    yield* Effect.sleep("1 second");
  }
});

const report = (inventory: Inventory.Inventory): string =>
  [
    ...[...inventory.devices.values()].map(
      (device) =>
        `device ${device.domain} ${device.node} opened=${String(device.opened)} pci=${device.pci ?? "?"} kernel=${device.kernelDriver ?? "?"} driver=${device.userDriver ?? "?"}`,
    ),
    ...[...inventory.capabilities.values()]
      .toSorted((left, right) => left.key.localeCompare(right.key))
      .map((capability) => {
        const [last] = capability.evidence;

        const shown =
          last === undefined
            ? ""
            : Inventory.Evidence.$match(last, {
                Build: ({ feature, present }) =>
                  `listing ${feature} ${present ? "present" : "absent"}`,
                Probe: ({ outcome, millis, detail }) =>
                  `probe ${outcome} ${String(millis)} ms${detail === "" ? "" : ` ${detail}`}`,
              });

        return `${capability.status.padEnd(11)} ${capability.key.padEnd(36)} ${shown}`;
      }),
  ].join("\n");

describe.runIf(hasQsv || hasVaapi)("TranscodeCapabilities on this machine's GPU", () => {
  layer(onDevice, { excludeTestServices: true, timeout: "300 seconds" })((it) => {
    it.effect(
      "ends every probe within its timeout, and runs every verified row in a real chain",
      () =>
        Effect.gen(function* () {
          const capabilities = yield* TranscodeCapabilities.Service;
          const tools = yield* MediaTools.Service;
          const path = yield* Path.Path;
          const fs = yield* FileSystem.FileSystem;
          const workspace = yield* FixtureWorkspace.Service;

          const domains = [
            ...(hasQsv ? ["qsv" as const] : []),
            ...(hasVaapi ? ["vaapi" as const] : []),
          ];

          const chains = [...domains.flatMap(chainsOn), ...CPU_CHAINS];

          for (const chain of chains) yield* capabilities.resolve(requestOf(chain));
          yield* settled;
          const inventory = yield* capabilities.inventory;

          yield* Console.log(report(inventory));

          for (const capability of inventory.capabilities.values()) {
            for (const evidence of capability.evidence) {
              if (Inventory.Evidence.$is("Probe")(evidence)) {
                assert.isAtMost(
                  evidence.millis,
                  Duration.toMillis(PROBE_TIMEOUT) * 3 + 1000,
                  capability.key,
                );
                assert.notInclude(evidence.detail, "timed out", capability.key);
              }
            }
          }

          const ran = new Set<ImplId>();
          const outcomes: Array<string> = [];
          const now = yield* Clock.currentTimeMillis;

          for (const chain of chains) {
            const bound = (yield* capabilities.current(requestOf(chain))).domains.filter(
              (binding) => chain.domain === binding.domain,
            );

            const known: CapabilitySnapshot = {
              ...Inventory.snapshot(inventory, undefined, now, bound, new Set()),
              excluded: new Set(
                VIDEO_OPS.flatMap((entry) =>
                  chain.without?.includes(entry.id) === true ? [entry.id] : [],
                ),
              ),
            };

            const planned = planVideo(PROBE_CLIPS[chain.clip].source, intentOf(chain), known);

            if (Result.isFailure(planned)) {
              outcomes.push(`${chain.name}: no chain (${JSON.stringify(planned.failure)})`);
            } else {
              const { pipeline } = planned.success;

              const impls = pipeline.steps.map((step): string => step.impl);

              if (chain.stages !== undefined) {
                assert.deepStrictEqual(impls, chain.stages, chain.name);
              }

              for (const stage of chain.includes ?? []) {
                assert.include(impls, stage, chain.name);
              }

              const clip = path.join(
                workspace.root,
                "capabilities",
                "transcode-probes",
                `${chain.clip}.mkv`,
              );

              const script = path.join(workspace.root, "probe-script.ass");

              yield* fs.writeFileString(script, PROBE_SCRIPT);

              const args = probeCommandArgs(
                pipeline,
                ProbeInput.Clip({ clip: chain.clip }),
                clip,
                0,
                { files: { subtitle: script }, readback: undefined },
              );

              const run = tools.ffmpeg(args, { timeout: Duration.seconds(30) }).pipe(Effect.result);
              const first = yield* run;

              // On an Arc A380 with a 256 MiB BAR, iHD 26.3.5's H.264 encoder dies of SIGBUS in a
              // small share of runs, Quick Sync's and VA-API's alike: the kernel refuses its page
              // fault on a buffer outside the CPU-visible window while a GPU address space is
              // torn down. A chain that dies of a signal runs once more, and the crash is
              // reported with the outcome.
              const crashed = Result.isFailure(first) && first.failure.signal !== null;
              const result = crashed ? yield* run : first;
              const frames = Result.isSuccess(result) ? probedFrames(result.success) : 0;
              const stages = pipeline.steps.map((step) => step.impl).join(" → ");

              const how = Result.match(result, {
                onSuccess: (progress) =>
                  `exit 0, progress ${progress.trim().split("\n").slice(-3).join(" ")}`,
                onFailure: (failure) =>
                  `exit ${String(failure.exitCode)} signal ${String(failure.signal)}: ${failure.stderr.trim()}`,
              });

              outcomes.push(
                `${chain.name}: ${frames > 0 ? "ran" : "FAILED"} ${String(frames)} frames: ${stages}${
                  Result.isFailure(first) && crashed
                    ? ` (the first run died of ${first.failure.signal})`
                    : ""
                }`,
              );
              assert.isAbove(frames, 0, `${chain.name}: ${stages}: ${how}`);

              for (const step of pipeline.steps) ran.add(step.impl);
            }
          }

          yield* Console.log(outcomes.join("\n"));

          if (hasQsv) {
            const tenBitH264 = Inventory.capabilityOf(
              inventory,
              capabilityKey(ImplId("decode.qsv"), "h264/yuv420p10le"),
            );

            assert.strictEqual(tenBitH264.status, "unsupported", "VA-API mapped no 10-bit H.264");
          }

          const verifiedRows = new Set(
            [...inventory.capabilities.values()].flatMap((capability) =>
              capability.status === "verified" ? [implOf(capability.key)] : [],
            ),
          );

          for (const impl of verifiedRows) assert.isTrue(ran.has(impl), `${impl} ran in no chain`);

          // Each encoder is a row of its own, so one this build or device lacks loses only that
          // row, and every one verified ran in a real chain above.
          const encoders = (["cpu", ...domains] as const).flatMap((domain) =>
            OUTPUT_CODECS.map((codec) => {
              const key = capabilityKey(
                encodeRowId(domain, codec),
                `8/${domain === "cpu" ? "crf" : "cbr"}`,
              );

              return `${key} ${Inventory.capabilityOf(inventory, key).status}`;
            }),
          );

          yield* Console.log(`encoders: ${encoders.join(", ")}`);

          // Each deinterlacer is a row of its own per depth, and every one verified ran above.
          const deinterlacers = (["cpu", ...domains] as const).flatMap((domain) =>
            ["8", "10"].map((depth) => {
              const key = capabilityKey(ImplId(`deinterlace.${domain}`), depth);

              return `${key} ${Inventory.capabilityOf(inventory, key).status}`;
            }),
          );

          yield* Console.log(`deinterlacers: ${deinterlacers.join(", ")}`);

          // Each subtitle row is a key of its own, so a device or build without a GPU overlay, or
          // without libass or a font, loses only that key; every one verified ran above.
          const subtitles = [
            capabilityKey(ImplId("burn-image.cpu"), "bitmap"),
            ...domains.map((domain) =>
              capabilityKey(ImplId(`burn-image.${domain}`), "bitmap/nv12"),
            ),
            capabilityKey(ImplId("burn-text.cpu"), "ass"),
          ].map((key) => `${key} ${Inventory.capabilityOf(inventory, key).status}`);

          yield* Console.log(`subtitles: ${subtitles.join(", ")}`);
        }),
      300_000,
    );
  });
});
