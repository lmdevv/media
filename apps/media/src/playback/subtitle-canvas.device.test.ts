import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";

import * as MediaTools from "../media/media-tools.ts";
import { brightBox, burnedFrame, burnPlan } from "../testing/burn-in-runs.ts";
import { qsvUsable, vaapiUsable } from "../testing/fixture-library.ts";
import { testConfigLayer } from "../testing/test-config.ts";

const hasQsv = await qsvUsable();

const hasVaapi = await vaapiUsable();

const FIXTURES = join(import.meta.dirname, "..", "testing", "fixtures");

const VOBSUB = join(FIXTURES, "vobsub.mkv");

const UHD = { width: 3840, height: 2160 } as const;

const HD = { width: 1280, height: 720 } as const;

/** The GPU paths this machine has. */
const domains = [...(hasQsv ? ["qsv" as const] : []), ...(hasVaapi ? ["vaapi" as const] : [])];

/** Writes a film in `folder` from a lavfi `picture` and the subtitle `input` brings, as `name`. */
const film = Effect.fn(function* (
  folder: string,
  name: string,
  picture: string,
  input: ReadonlyArray<string>,
  codecs: ReadonlyArray<string>,
) {
  const tools = yield* MediaTools.Service;
  const output = join(folder, name);

  yield* tools.ffmpeg([
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    picture,
    ...input,
    "-map",
    "0:v",
    "-map",
    "1:s",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    ...codecs,
    output,
  ]);

  return output;
});

/** Asserts `box` is within `slack` samples of `expected` on every side. */
const near = (
  box: readonly [number, number, number, number] | undefined,
  expected: readonly [number, number, number, number] | undefined,
  name: string,
  slack = 2,
) => {
  assert.isDefined(box, `${name}: nothing drawn`);
  assert.isDefined(expected, `${name}: nothing to compare with`);

  for (const [index, side] of ["left", "top", "right", "bottom"].entries()) {
    assert.closeTo(box[index] ?? 0, expected[index] ?? 0, slack, `${name}: ${side}`);
  }
};

/** How many samples of row `y` the bar's left edge, near `x`, spends between its gray and white. */
const edgeWidth = (gray: Uint8Array, width: number, x: number, y: number): number => {
  let soft = 0;

  for (let column = x - 8; column <= x + 8; column += 1) {
    const sample = gray[y * width + column] ?? 0;

    if (sample > 80 && sample < 240) soft += 1;
  }

  return soft;
};

describe.runIf(domains.length > 0)("image subtitles burned in on this machine's GPU", () => {
  layer(
    MediaTools.layer.pipe(
      Layer.provide(testConfigLayer({ FFMPEG_PATH: process.env["FFMPEG_PATH"] ?? "ffmpeg" })),
      Layer.provideMerge(NodeServices.layer),
    ),
    { excludeTestServices: true, timeout: "600 seconds" },
  )((it) => {
    it.effect(
      "draws a 4K PGS canvas ffmpeg learns only from its first packet where it belongs",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "media-pgs-4k-" });

          for (const sup of ["pgs-1080.sup", "pgs-720.sup"]) {
            // Noise keeps the picture at 40 Mbit/s, so ffmpeg's probe reads about a second and
            // the bar, from 6 s to 8 s, is past it. The noise never reaches the bar's white.
            const late = yield* film(
              root,
              `${sup}.mkv`,
              "color=c=gray:s=3840x2160:r=24:d=9,noise=alls=30:allf=t",
              ["-itsoffset", "6", "-i", join(FIXTURES, sup)],
              ["-b:v", "40M", "-g", "24", "-c:s", "copy"],
            );

            for (const domain of domains) {
              const gray = yield* burnedFrame(
                late,
                burnPlan(UHD, "hdmv_pgs_subtitle", 1, domain),
                join(root, `${domain}-${sup}`),
                7,
              );

              // The canvas at the picture's height (2x), its bar's white at 984-2855, 1824-2015.
              near(brightBox(gray, UHD.width), [984, 1824, 2855, 2015], `${domain}, ${sup}`, 6);
            }
          }
        }).pipe(Effect.scoped),
      600_000,
    );

    it.effect(
      "draws a 3840x2160 PGS canvas over a 4K picture at its full detail",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "media-pgs-uhd-" });

          const uhd = yield* film(
            root,
            "uhd.mkv",
            "color=c=gray:s=3840x2160:r=24:d=4",
            ["-itsoffset", "1", "-i", join(FIXTURES, "pgs-2160.sup")],
            ["-c:s", "copy"],
          );

          const cpu = yield* burnedFrame(
            uhd,
            burnPlan(UHD, "hdmv_pgs_subtitle", 1, "cpu"),
            join(root, "cpu"),
            2,
          );

          for (const domain of domains) {
            const gray = yield* burnedFrame(
              uhd,
              burnPlan(UHD, "hdmv_pgs_subtitle", 1, domain),
              join(root, domain),
              2,
            );

            near(brightBox(gray, UHD.width), brightBox(cpu, UHD.width), domain);
            // Uploaded at its own size, not halved and scaled back up: its edge as sharp as the
            // CPU's, which steps from the frame to the white in one sample where a canvas held at
            // 1920x1080 and scaled up on the device ramps over four.
            assert.isAtMost(
              edgeWidth(gray, UHD.width, 984, 1920),
              edgeWidth(cpu, UHD.width, 984, 1920) + 1,
              `${domain}: the bar's edge`,
            );
          }
        }).pipe(Effect.scoped),
      300_000,
    );

    it.effect(
      "draws DVB, XSUB, and DVD tracks where the CPU chain does, a DVB canvas changing mid-stream",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "media-image-codecs-" });
          const picture = "color=c=gray:s=1280x720:r=25:d=5";

          // ffmpeg starts the DVB canvas at the picture's 1280x720 until the display definition
          // says 1920x1080; XSUB's is stored, and DVD's stated.
          const tracks = [
            {
              codec: "dvb_subtitle",
              file: yield* film(
                root,
                "dvb.ts",
                picture,
                ["-itsoffset", "1", "-i", join(FIXTURES, "pgs-1080.sup")],
                ["-c:s", "dvbsub"],
              ),
              at: 3.5,
            },
            {
              codec: "xsub",
              file: yield* film(
                root,
                "xsub.avi",
                picture,
                ["-canvas_size", "720x576", "-i", VOBSUB],
                ["-c:s", "xsub"],
              ),
              at: 1,
            },
            {
              codec: "dvd_subtitle",
              file: yield* film(root, "dvd.mkv", picture, ["-i", VOBSUB], ["-c:s", "copy"]),
              at: 1,
            },
          ];

          for (const track of tracks) {
            const cpu = brightBox(
              yield* burnedFrame(
                track.file,
                burnPlan(HD, track.codec, 1, "cpu"),
                join(root, `${track.codec}-cpu`),
                track.at,
              ),
              HD.width,
            );

            for (const domain of domains) {
              const gray = yield* burnedFrame(
                track.file,
                burnPlan(HD, track.codec, 1, domain),
                join(root, `${track.codec}-${domain}`),
                track.at,
              );

              near(brightBox(gray, HD.width), cpu, `${track.codec} on ${domain}`);
            }
          }
        }).pipe(Effect.scoped),
      300_000,
    );
  });
});
