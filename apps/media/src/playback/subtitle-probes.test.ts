import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Result } from "effect";

import * as MediaTools from "../media/media-tools.ts";
import { copyBytes } from "../testing/byte-copies.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import { testConfigLayer } from "../testing/test-config.ts";
import { PROBE_CLIPS, PROBE_SCRIPT, readbackVerdict } from "./probe-clips.ts";
import { probeFor } from "./video-pipeline.ts";
import { filterValue, probeCommandArgs, type RunFiles } from "./video-render.ts";
import { capabilityKey, ImplId } from "./video-ops.ts";

const hasFfmpeg = await ffmpegAvailable();

const FONT = join(import.meta.dirname, "..", "testing", "fixtures", "lar-blocks.ttf");

/** Every character ffmpeg's option and graph parsers read specially, and a newline. */
const HOSTILE = "it's [a], b: c; d \\ e\nf ";

/** A 320x240 gray picture with `bands` (column ranges at a level) painted over `base`. */
const picture = (
  base: number,
  bands: ReadonlyArray<readonly [number, number, number]>,
): Uint8Array => {
  const gray = new Uint8Array(320 * 240).fill(base);

  for (let y = 0; y < 240; y += 1) {
    for (const [from, to, level] of bands) gray.fill(level, y * 320 + from, y * 320 + to);
  }

  return gray;
};

describe("filter values", () => {
  it("leaves plain values as they are and escapes every special character twice", () => {
    assert.strictEqual(filterValue("source_fps"), "source_fps");
    assert.strictEqual(filterValue("1920"), "1920");
    assert.strictEqual(filterValue("(main_w-overlay_w)/2"), "(main_w-overlay_w)/2");
    // A colon separates options, a comma filters, and a quote quotes at both levels.
    assert.strictEqual(filterValue("a:b"), "a\\\\:b");
    assert.strictEqual(filterValue("a,b"), "a\\,b");
    assert.strictEqual(filterValue("it's"), "it\\\\\\'s");
    assert.strictEqual(filterValue(" a\n"), "\\\\\\ a\\\\\\\n");
  });
});

describe("subtitle probe pictures", () => {
  it("passes a canvas blended with straight alpha, and fails one blended any other way", () => {
    const blended = picture(128, [
      [107, 213, 235],
      [213, 320, 182],
    ]);

    assert.isTrue(readbackVerdict("blend", blended).passed);
    // Alpha ignored: the clear band comes out as the canvas's black.
    assert.isFalse(
      readbackVerdict(
        "blend",
        picture(16, [
          [107, 213, 235],
          [213, 320, 235],
        ]),
      ).passed,
    );
    // Taken as premultiplied: the half band comes out gray.
    assert.isFalse(readbackVerdict("blend", picture(128, [[107, 213, 235]])).passed);
    // Nothing drawn.
    assert.isFalse(readbackVerdict("blend", picture(128, [])).passed);
    assert.isFalse(readbackVerdict("blend", new Uint8Array(100)).passed);
    assert.include(readbackVerdict("blend", blended).detail, "half 182");
  });

  it("passes a glyph drawn in the middle, and fails a picture without it", () => {
    assert.isTrue(readbackVerdict("glyph", picture(128, [[130, 190, 235]])).passed);
    assert.isFalse(readbackVerdict("glyph", picture(128, [])).passed);
    assert.isFalse(readbackVerdict("glyph", picture(235, [])).passed);
  });
});

/**
 * The text row's probe drawn on a gray clip made in `root`, from `files`, through the service's
 * tools: the picture it read back, judged, and the start of what ffmpeg logged.
 */
const drawText = Effect.fnUntraced(function* (root: string, files: RunFiles) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tools = yield* MediaTools.Service;
  const clip = path.join(root, "gray.mkv");
  const readback = path.join(root, "readback.gray");

  yield* tools.ffmpeg([
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-y",
    ...PROBE_CLIPS["h264-8-gray"].args,
    clip,
  ]);

  const plan = probeFor(capabilityKey(ImplId("burn-text.cpu"), "ass"), {
    domains: [],
    verified: new Set([capabilityKey(ImplId("decode.cpu"), "h264/yuv420p")]),
    excluded: new Set(),
  });

  if (plan === undefined || Result.isFailure(plan)) {
    assert.fail("the text row has no probe plan");
  }

  assert.strictEqual(plan.success.readback, "glyph");

  const log = yield* tools.ffmpegLog(
    probeCommandArgs(plan.success.pipeline, plan.success.input, clip, 0, { files, readback }),
  );

  return { verdict: readbackVerdict("glyph", yield* fs.readFile(readback)), log };
});

/**
 * The fonts file the NixOS module gives ffmpeg, which scripts/check-sandbox.sh passes on. ffmpeg
 * runs without HOME, so a fontconfig without the module's prebuilt cache logs that it has nowhere
 * to write one.
 */
const moduleFonts = process.env["FONTCONFIG_FILE"];

describe.skipIf(!hasFfmpeg)("a text subtitle's files at any path", () => {
  layer(
    MediaTools.layer.pipe(
      Layer.provide(testConfigLayer({})),
      Layer.provideMerge(NodeServices.layer),
    ),
    { excludeTestServices: true },
  )((scoped) => {
    scoped.effect(
      "draws from a script and fonts whose paths hold every character special to filters",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "media-filter-values-" });
          const folder = path.join(root, HOSTILE);
          const fonts = path.join(folder, `fonts ${HOSTILE}`);
          const script = path.join(folder, `script ${HOSTILE}.ass`);

          yield* fs.makeDirectory(fonts, { recursive: true });
          yield* copyBytes(FONT, path.join(fonts, "0.font"));
          // A block of the attached font over the probe's glyph window: a fallback font's "L"
          // leaves the middle of the picture gray.
          yield* fs.writeFileString(
            script,
            [
              "[Script Info]",
              "ScriptType: v4.00+",
              "PlayResX: 320",
              "PlayResY: 240",
              "",
              "[V4+ Styles]",
              "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
              "Style: Default,Lar Blocks,96,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1",
              "",
              "[Events]",
              "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
              "Dialogue: 0,0:00:00.00,0:00:10.00,Default,,0,0,0,,{\\pos(160,120)}L",
              "",
            ].join("\n"),
          );

          const { verdict } = yield* drawText(root, { subtitle: script, fonts });

          assert.isTrue(verdict.passed, verdict.detail);
        }).pipe(Effect.scoped),
      60_000,
    );

    scoped.effect.skipIf(moduleFonts === undefined)(
      "draws the probe's glyph from the fonts FONTCONFIG_FILE names, with no cache to write",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "media-module-fonts-" });
          const script = path.join(root, "probe-script.ass");

          yield* fs.writeFileString(script, PROBE_SCRIPT);

          const { verdict, log } = yield* drawText(root, { subtitle: script });

          assert.isTrue(verdict.passed, verdict.detail);
          assert.notInclude(log, "Fontconfig");
        }).pipe(Effect.scoped),
      60_000,
    );
  });
});
