import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";

import * as MediaTools from "../media/media-tools.ts";
import { brightBox, burnedFrame, burnPlan } from "../testing/burn-in-runs.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import { testConfigLayer } from "../testing/test-config.ts";

const hasFfmpeg = await ffmpegAvailable();

const FIXTURES = join(import.meta.dirname, "..", "testing", "fixtures");

const VOBSUB = join(FIXTURES, "vobsub.mkv");

/** Writes a film in `folder`: `picture` (a lavfi source) with the subtitle `args` bring, muxed as `name`. */
const film = Effect.fn(function* (
  folder: string,
  name: string,
  picture: string,
  subtitle: ReadonlyArray<string>,
  video: ReadonlyArray<string> = ["-c:v", "libx264", "-preset", "ultrafast"],
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
    ...subtitle,
    "-map",
    "0:v",
    "-map",
    "1:s",
    ...video,
    "-pix_fmt",
    "yuv420p",
    output,
  ]);

  return output;
});

/** A gray 5 s lavfi picture of `size` (`WxH`). */
const picture = (size: string) => `color=c=gray:s=${size}:r=25:d=5`;

/** Asserts `box` is within two samples of `expected` on every side. */
const near = (
  box: readonly [number, number, number, number] | undefined,
  expected: readonly [number, number, number, number],
  name: string,
) => {
  assert.isDefined(box, `${name}: nothing drawn`);
  const [left, top, right, bottom] = box;

  assert.closeTo(left, expected[0], 2, `${name}: left`);
  assert.closeTo(top, expected[1], 2, `${name}: top`);
  assert.closeTo(right, expected[2], 2, `${name}: right`);
  assert.closeTo(bottom, expected[3], 2, `${name}: bottom`);
};

describe.skipIf(!hasFfmpeg)("an image subtitle's canvas on the CPU chain", () => {
  layer(
    MediaTools.layer.pipe(
      Layer.provide(testConfigLayer({})),
      Layer.provideMerge(NodeServices.layer),
    ),
    { excludeTestServices: true, timeout: "300 seconds" },
  )((it) => {
    it.effect(
      "draws a DVB track on the canvas its display definition gives, at 720x576, 1280x720, and 1920x1080",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "media-dvb-" });

          // The DVD track a 720x576 DVB one is made from draws where that one must.
          const dvd = yield* film(
            root,
            "dvd.mkv",
            picture("640x360"),
            ["-i", VOBSUB],
            ["-c:v", "libx264", "-preset", "ultrafast", "-c:s", "copy"],
          );

          const dvdBox = brightBox(
            yield* burnedFrame(
              dvd,
              burnPlan({ width: 640, height: 360 }, "dvd_subtitle", 1, "cpu"),
              join(root, "dvd"),
              1,
            ),
            640,
          );

          assert.isDefined(dvdBox, "the DVD track draws");

          // DVB in MPEG-TS, as broadcasts carry it: the encoder gives an HD canvas a display
          // definition. The picture starts 1.4 s into the stream's clock.
          const tracks = [
            {
              name: "720x576",
              input: ["-canvas_size", "720x576", "-i", VOBSUB],
              size: { width: 640, height: 360 },
              at: 2.4,
              expected: dvdBox,
            },
            {
              name: "1280x720",
              input: ["-itsoffset", "1", "-i", join(FIXTURES, "pgs-720.sup")],
              size: { width: 640, height: 360 },
              at: 3.5,
              expected: [164, 304, 475, 335],
            },
            {
              name: "1920x1080",
              input: ["-itsoffset", "1", "-i", join(FIXTURES, "pgs-1080.sup")],
              size: { width: 960, height: 540 },
              at: 3.5,
              expected: [246, 456, 713, 503],
            },
          ] as const;

          for (const track of tracks) {
            const dvb = yield* film(
              root,
              `dvb-${track.name}.ts`,
              picture(`${String(track.size.width)}x${String(track.size.height)}`),
              track.input,
              ["-c:v", "libx264", "-preset", "ultrafast", "-c:s", "dvbsub"],
            );

            const gray = yield* burnedFrame(
              dvb,
              burnPlan(track.size, "dvb_subtitle", 1, "cpu"),
              join(root, `dvb-${track.name}`),
              track.at,
            );

            near(brightBox(gray, track.size.width), track.expected, `DVB ${track.name}`);
          }
        }).pipe(Effect.scoped),
      240_000,
    );

    it.effect(
      "draws an XSUB track on the canvas the file stores with it",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "media-xsub-" });
          const size = { width: 640, height: 360 };

          const dvd = yield* film(
            root,
            "dvd.mkv",
            picture("640x360"),
            ["-i", VOBSUB],
            ["-c:v", "libx264", "-preset", "ultrafast", "-c:s", "copy"],
          );

          // XSUB holds four colours, as DVD subtitles do, and AVI stores its 720x576 canvas.
          const xsub = yield* film(
            root,
            "xsub.avi",
            picture("640x360"),
            ["-canvas_size", "720x576", "-i", VOBSUB],
            ["-c:v", "libx264", "-preset", "ultrafast", "-c:s", "xsub"],
          );

          const expected = brightBox(
            yield* burnedFrame(dvd, burnPlan(size, "dvd_subtitle", 1, "cpu"), join(root, "dvd"), 1),
            640,
          );

          assert.isDefined(expected, "the DVD track draws");

          near(
            brightBox(
              yield* burnedFrame(xsub, burnPlan(size, "xsub", 1, "cpu"), join(root, "xsub"), 1),
              640,
            ),
            expected,
            "XSUB",
          );
        }).pipe(Effect.scoped),
      120_000,
    );

    it.effect(
      "draws a PGS canvas ffmpeg learns only from its first packet where it belongs",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "media-pgs-late-" });

          // Noise keeps each picture at 40 Mbit/s, so ffmpeg's probe reads about a second and the
          // bar, from 2.5 s, is past it; the noise never reaches the bar's white.
          const cases = [
            {
              name: "1280x720 canvas over 1920x1080",
              sup: "pgs-720.sup",
              size: { width: 1920, height: 1080 },
              expected: [492, 912, 1427, 1007],
            },
            {
              name: "1920x1080 canvas over 1920x800",
              sup: "pgs-1080.sup",
              size: { width: 1920, height: 800 },
              expected: [613, 676, 1304, 745],
            },
          ] as const;

          for (const item of cases) {
            const late = yield* film(
              root,
              `${item.sup}-${String(item.size.height)}.mkv`,
              `color=c=gray:s=${String(item.size.width)}x${String(item.size.height)}:r=24:d=5,noise=alls=30:allf=t`,
              ["-itsoffset", "2.5", "-i", join(FIXTURES, item.sup)],
              [
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-b:v",
                "40M",
                "-g",
                "24",
                "-c:s",
                "copy",
              ],
            );

            const gray = yield* burnedFrame(
              late,
              burnPlan(item.size, "hdmv_pgs_subtitle", 1, "cpu"),
              join(root, item.name.replaceAll(" ", "-")),
              3.5,
            );

            near(brightBox(gray, item.size.width), item.expected, item.name);
          }
        }).pipe(Effect.scoped),
      240_000,
    );
  });
});
