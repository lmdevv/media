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
            // x264's CBR filler holds the flat gray picture at 40 Mbit/s, so ffmpeg's probe reads
            // about a second and the bar, from 6 s to 8 s, is past it. Nothing in the picture
            // comes near the 200 `brightBox` counts from but the bar's white.
            const late = yield* film(
              root,
              `${sup}.mkv`,
              "color=c=gray:s=3840x2160:r=24:d=9",
              ["-itsoffset", "6", "-i", join(FIXTURES, sup)],
              [
                "-b:v",
                "40M",
                "-minrate",
                "40M",
                "-maxrate",
                "40M",
                "-bufsize",
                "40M",
                "-x264-params",
                "nal-hrd=cbr",
                "-g",
                "24",
                "-c:s",
                "copy",
              ],
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
      "draws a 3840x2160 PGS canvas over a 4K picture where the CPU chain does, held at 1920x1080",
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
            // A GPU row scales no subtitle up on the CPU, so the canvas is held at its stated
            // 1920x1080 and scaled back up on the device: its edge ramps where the CPU's steps
            // from the frame to the white in one sample.
            assert.isAtMost(edgeWidth(cpu, UHD.width, 984, 1920), 1, "the CPU's edge");
            assert.isAtMost(edgeWidth(gray, UHD.width, 984, 1920), 6, `${domain}: the bar's edge`);
          }
        }).pipe(Effect.scoped),
      300_000,
    );

    it.effect(
      "draws a PGS canvas over 2.39:1 pictures, whose drawn widths are odd, where the CPU chain does",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "media-pgs-scope-" });

          // At the pictures' heights the 16:9 canvas is 1429 and 2859 samples wide.
          for (const size of [
            { width: 1920, height: 804 },
            { width: 3840, height: 1608 },
          ]) {
            const name = `${String(size.width)}x${String(size.height)}`;

            const scope = yield* film(
              root,
              `${name}.mkv`,
              `color=c=gray:s=${name}:r=24:d=4`,
              ["-itsoffset", "1", "-i", join(FIXTURES, "pgs-1080.sup")],
              ["-c:s", "copy"],
            );

            const cpu = yield* burnedFrame(
              scope,
              burnPlan(size, "hdmv_pgs_subtitle", 1, "cpu"),
              join(root, `${name}-cpu`),
              2,
            );

            for (const domain of domains) {
              const gray = yield* burnedFrame(
                scope,
                burnPlan(size, "hdmv_pgs_subtitle", 1, domain),
                join(root, `${name}-${domain}`),
                2,
              );

              near(brightBox(gray, size.width), brightBox(cpu, size.width), `${name} on ${domain}`);
            }
          }
        }).pipe(Effect.scoped),
      300_000,
    );

    it.effect(
      "draws PGS, DVB, XSUB, and DVD tracks intact over 480-line and 2.39:1 pictures, as the CPU does",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "media-image-small-" });

          // VA-API's upload tears some sizes into slanted bands, such as the 853x480 a PGS canvas
          // is drawn at over 1126x480, so the GPU rows upload none taken from the picture.
          for (const size of [
            { width: 1126, height: 480 },
            { width: 854, height: 480 },
            { width: 1920, height: 804 },
          ]) {
            const name = `${String(size.width)}x${String(size.height)}`;

            const picture = `color=c=gray:s=${name}:r=25:d=5`;

            const tracks = [
              {
                codec: "hdmv_pgs_subtitle",
                file: yield* film(
                  root,
                  `${name}-pgs.mkv`,
                  picture,
                  ["-itsoffset", "1", "-i", join(FIXTURES, "pgs-1080.sup")],
                  ["-c:s", "copy"],
                ),
                at: 2,
              },
              {
                codec: "dvb_subtitle",
                file: yield* film(
                  root,
                  `${name}-dvb.ts`,
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
                  `${name}-xsub.avi`,
                  picture,
                  ["-canvas_size", "720x576", "-i", VOBSUB],
                  ["-c:s", "xsub"],
                ),
                at: 1,
              },
              {
                codec: "dvd_subtitle",
                file: yield* film(
                  root,
                  `${name}-dvd.mkv`,
                  picture,
                  ["-i", VOBSUB],
                  ["-c:s", "copy"],
                ),
                at: 1,
              },
            ];

            for (const track of tracks) {
              const cpu = brightBox(
                yield* burnedFrame(
                  track.file,
                  burnPlan(size, track.codec, 1, "cpu"),
                  join(root, `${name}-${track.codec}-cpu`),
                  track.at,
                ),
                size.width,
              );

              for (const domain of domains) {
                const gray = yield* burnedFrame(
                  track.file,
                  burnPlan(size, track.codec, 1, domain),
                  join(root, `${name}-${track.codec}-${domain}`),
                  track.at,
                );

                near(brightBox(gray, size.width), cpu, `${track.codec} over ${name} on ${domain}`);
              }
            }
          }
        }).pipe(Effect.scoped),
      600_000,
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
