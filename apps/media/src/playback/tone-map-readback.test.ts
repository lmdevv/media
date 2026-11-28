import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Result } from "effect";

import * as MediaTools from "../media/media-tools.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import { testConfigLayer } from "../testing/test-config.ts";
import { PROBE_CLIPS, readbackVerdict } from "./probe-clips.ts";
import { probeFor } from "./video-pipeline.ts";
import { probeCommandArgs } from "./video-render.ts";
import { capabilityKey, type ClipName, ImplId } from "./video-ops.ts";

const hasFfmpeg = await ffmpegAvailable();

type Rgb = readonly [number, number, number];

/** A 320x240 rgb24 picture of the HDR clips' eight patches, as `colours` row by row. */
const patches = (colours: readonly [ReadonlyArray<Rgb>, ReadonlyArray<Rgb>]): Uint8Array => {
  const rgb = new Uint8Array(320 * 240 * 3);

  for (let y = 0; y < 240; y += 1) {
    for (let x = 0; x < 320; x += 1) {
      const [r, g, b] = colours[y < 120 ? 0 : 1][Math.floor(x / 80)] ?? [0, 0, 0];

      rgb.set([r, g, b], (y * 320 + x) * 3);
    }
  }

  return rgb;
};

/** libplacebo's BT.2390 picture of the PQ clip on ffmpeg 9, patch by patch. */
const MAPPED: readonly [ReadonlyArray<Rgb>, ReadonlyArray<Rgb>] = [
  [
    [0, 0, 0],
    [169, 169, 168],
    [252, 252, 252],
    [47, 47, 47],
  ],
  [
    [252, 66, 23],
    [0, 248, 0],
    [0, 109, 250],
    [252, 252, 252],
  ],
];

describe("a tone map's picture read back", () => {
  it("passes neutral grays in order and each primary its own hue", () => {
    assert.isTrue(readbackVerdict("picture", patches(MAPPED)).passed);
  });

  it("fails a picture of the wrong chroma, of none, or of nothing", () => {
    // What a mapped hand-over drew on the image's ffmpeg 7.1: solid green over the luma's shadows.
    const green = patches([
      MAPPED[0].map(([r]): Rgb => [0, 160 + r / 4, 0]),
      MAPPED[1].map(([r]): Rgb => [0, 160 + r / 4, 0]),
    ]);

    // A picture whose chroma was lost: every patch its own luma in gray.
    const gray = patches([
      MAPPED[0].map(([r, g, b]): Rgb => {
        const y = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);

        return [y, y, y];
      }),
      MAPPED[1].map(([r, g, b]): Rgb => {
        const y = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);

        return [y, y, y];
      }),
    ]);

    const black = new Uint8Array(320 * 240 * 3);

    for (const [name, picture] of [
      ["green", green],
      ["gray", gray],
      ["black", black],
    ] as const) {
      assert.isFalse(readbackVerdict("picture", picture).passed, name);
    }

    assert.isFalse(readbackVerdict("picture", new Uint8Array(320 * 240)).passed, "gray layout");
  });
});

const tools = MediaTools.layer.pipe(
  Layer.provide(
    testConfigLayer({
      FFMPEG_PATH: process.env["FFMPEG_PATH"] ?? "ffmpeg",
      FFPROBE_PATH: process.env["FFPROBE_PATH"] ?? "ffprobe",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

describe.skipIf(!hasFfmpeg)("the CPU tone map's probe", () => {
  layer(tools, { excludeTestServices: true })((scoped) => {
    scoped.effect(
      "keeps the PQ and HLG clips' patches, read back in colour",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const run = yield* MediaTools.Service;
          const root = yield* fs.makeTempDirectoryScoped();

          for (const [clip, variant] of [
            ["hevc-pq", "pq"],
            ["hevc-hlg", "hlg"],
          ] as const satisfies ReadonlyArray<readonly [ClipName, string]>) {
            const file = path.join(root, `${clip}.mkv`);
            const readback = path.join(root, `${clip}.rgb`);

            yield* run.ffmpeg([
              "-hide_banner",
              "-v",
              "error",
              "-y",
              ...PROBE_CLIPS[clip].args,
              file,
            ]);

            const plan = probeFor(capabilityKey(ImplId("tonemap.cpu"), variant), {
              domains: [],
              verified: new Set([capabilityKey(ImplId("decode.cpu"), "hevc/yuv420p10le")]),
              excluded: new Set(),
            });

            if (plan === undefined || Result.isFailure(plan)) {
              assert.fail(`the CPU tone map has no ${variant} probe`);
            }

            assert.strictEqual(plan.success.readback, "picture");

            yield* run.ffmpeg(
              probeCommandArgs(plan.success.pipeline, plan.success.input, file, 0, {
                files: {},
                readback: { path: readback, pixelFormat: "rgb24" },
              }),
            );

            const verdict = readbackVerdict("picture", yield* fs.readFile(readback));

            assert.isTrue(verdict.passed, `${variant}: ${verdict.detail}`);
          }
        }).pipe(Effect.scoped),
      60_000,
    );
  });
});
