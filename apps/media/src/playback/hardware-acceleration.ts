import { Context, Effect, Layer, Ref } from "effect";

import * as MediaConfig from "../media-config.ts";
import * as MediaTools from "../media/media-tools.ts";
import { qsvDeviceInit } from "./transcode-command.ts";

/** A GPU encoder family. */
export type HardwareEncoder = "qsv" | "vaapi";

/** Hardware transcoding availability. */
export interface Interface {
  /** The encoder new transcodes use, or undefined for software. */
  readonly encoder: Effect.Effect<HardwareEncoder | undefined>;
  /** Stops offering `encoder` after it failed at runtime. */
  readonly markUnavailable: (encoder: HardwareEncoder, reason: string) => Effect.Effect<void>;
  readonly qsvDevice: string;
  readonly vaapiDevice: string;
  /** Whether ffmpeg has the filters software tone mapping needs; checked once. */
  readonly softwareToneMapping: Effect.Effect<boolean>;
}

/** Hardware transcoding availability. */
export class Service extends Context.Service<Service, Interface>()(
  "@media/server/HardwareAcceleration",
) {}

const testSource = ["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10:duration=1"];

const testOutput = ["-f", "null", "-"];

/** Arguments of the QSV test encode: one second of generated video through `h264_qsv`. */
export const qsvProbeArgs = (device: string): ReadonlyArray<string> => [
  "-hide_banner",
  "-nostdin",
  "-v",
  "error",
  "-init_hw_device",
  qsvDeviceInit(device),
  "-filter_hw_device",
  "hw",
  ...testSource,
  "-vf",
  "hwupload=extra_hw_frames=16,format=qsv",
  "-c:v",
  "h264_qsv",
  ...testOutput,
];

/** Arguments of the VA-API test encode: one second of generated video through `h264_vaapi`. */
export const vaapiProbeArgs = (device: string): ReadonlyArray<string> => [
  "-hide_banner",
  "-nostdin",
  "-v",
  "error",
  "-init_hw_device",
  `vaapi=va:${device}`,
  "-filter_hw_device",
  "va",
  ...testSource,
  "-vf",
  "format=nv12,hwupload",
  "-c:v",
  "h264_vaapi",
  ...testOutput,
];

const CANDIDATES: Readonly<
  Record<MediaConfig.Interface["hardwareAcceleration"], ReadonlyArray<HardwareEncoder>>
> = {
  auto: ["qsv", "vaapi"],
  qsv: ["qsv"],
  vaapi: ["vaapi"],
  none: [],
};

const make = Effect.gen(function* () {
  const config = yield* MediaConfig.Service;
  const tools = yield* MediaTools.Service;
  const disabled = yield* Ref.make<ReadonlySet<HardwareEncoder>>(new Set());

  const probeOf = (encoder: HardwareEncoder, args: ReadonlyArray<string>) =>
    Effect.cached(
      config.hardwareAcceleration === encoder
        ? Effect.succeed(true)
        : tools.ffmpeg(args).pipe(
            Effect.timeout("15 seconds"),
            Effect.as(true),
            Effect.tapError((error) =>
              Effect.logInfo("HardwareAcceleration.unavailable", error).pipe(
                Effect.annotateLogs({ encoder }),
              ),
            ),
            Effect.orElseSucceed(() => false),
            Effect.tap((available) =>
              Effect.logInfo("HardwareAcceleration.probed").pipe(
                Effect.annotateLogs({ encoder, available }),
              ),
            ),
          ),
    );

  const qsv = yield* probeOf("qsv", qsvProbeArgs(config.qsvDevice));
  const vaapi = yield* probeOf("vaapi", vaapiProbeArgs(config.vaapiDevice));

  const probes: Readonly<Record<HardwareEncoder, Effect.Effect<boolean>>> = { qsv, vaapi };
  const candidates = CANDIDATES[config.hardwareAcceleration];

  const encoder = Effect.gen(function* () {
    const off = yield* Ref.get(disabled);

    for (const name of candidates) {
      if (!off.has(name) && (yield* probes[name])) return name;
    }

    return undefined;
  });

  const markUnavailable = Effect.fn("HardwareAcceleration.markUnavailable")(function* (
    failed: HardwareEncoder,
    reason: string,
  ) {
    yield* Ref.update(disabled, (current) => new Set(current).add(failed));
    yield* Effect.logWarning("HardwareAcceleration.disabled").pipe(
      Effect.annotateLogs({ encoder: failed, reason }),
    );
  });

  const softwareToneMapping = yield* Effect.cached(
    tools.ffmpeg(["-hide_banner", "-filters"]).pipe(
      Effect.map((list) => /\szscale\s/u.test(list) && /\stonemap\s/u.test(list)),
      Effect.orElseSucceed(() => false),
    ),
  );

  return Service.of({
    encoder,
    markUnavailable,
    softwareToneMapping,
    qsvDevice: config.qsvDevice,
    vaapiDevice: config.vaapiDevice,
  });
});

/** Availability from `HARDWARE_ACCELERATION`, `QSV_DEVICE`, and `VAAPI_DEVICE`. */
export const layer: Layer.Layer<Service, never, MediaConfig.Service | MediaTools.Service> =
  Layer.effect(Service, make);
