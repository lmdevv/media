import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import * as DiskCache from "../disk-cache.ts";
import * as MediaTools from "../media/media-tools.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import { testConfigLayer } from "../testing/test-config.ts";
import * as BurnedText from "./burned-text.ts";
import {
  type Attachment,
  type BurnSource,
  fontsToExtract,
  MAX_FONT_BYTES,
  MAX_FONT_TOTAL,
  MAX_FONTS,
  TextSource,
} from "./burned-text.ts";

const hasFfmpeg = await ffmpegAvailable();

const FONT = join(import.meta.dirname, "..", "testing", "fixtures", "lar-blocks.ttf");

/** A styled script with one cue from 1 s to 9 s, in the attached font. */
const SCRIPT = [
  "[Script Info]",
  "ScriptType: v4.00+",
  "PlayResX: 320",
  "PlayResY: 240",
  "",
  "[V4+ Styles]",
  "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
  "Style: Blocks,Lar Blocks,40,&H0000FFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1",
  "",
  "[Events]",
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  "Dialogue: 0,0:00:01.00,0:00:09.00,Blocks,,0,0,0,,{\\pos(20,20)}LAR",
  "",
].join("\n");

/** An attachment to put in the film: its bytes, the type it claims, and the name it gives. */
interface Attached {
  readonly file: string;
  readonly mimetype: string;
  readonly name: string;
}

const sourceOf = (path: string, text: TextSource, startSeconds = 0): BurnSource => ({
  file: { fileId: path, path, sizeBytes: 1, modifiedAtMs: 1, startSeconds },
  text,
  style: "styled",
});

/** The preparer and the tools, keeping their cache in a fresh folder. */
const preparerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "media-burn-data-" });

    return BurnedText.layer.pipe(
      Layer.provide(DiskCache.layer),
      Layer.provideMerge(MediaTools.layer),
      Layer.provide(testConfigLayer({ DATA_DIR: dataDir })),
    );
  }),
);

/** Writes a 2 s film with the script as its subtitle track (stream 1) and `attached` files. */
const film = Effect.fn(function* (folder: string, attached: ReadonlyArray<Attached>) {
  const fs = yield* FileSystem.FileSystem;
  const tools = yield* MediaTools.Service;
  const script = join(folder, "script.ass");
  const output = join(folder, "Film (2020).mkv");

  yield* fs.writeFileString(script, SCRIPT);
  yield* tools.ffmpeg([
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=gray:size=320x240:rate=10:duration=2",
    "-i",
    script,
    "-map",
    "0:v",
    "-map",
    "1:s",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-c:s",
    "copy",
    ...attached.flatMap((attachment, index) => [
      "-attach",
      attachment.file,
      `-metadata:s:t:${String(index)}`,
      `mimetype=${attachment.mimetype}`,
      `-metadata:s:t:${String(index)}`,
      `filename=${attachment.name}`,
    ]),
    output,
  ]);

  return output;
});

describe.skipIf(!hasFfmpeg)("burned-in text files", () => {
  layer(preparerLayer.pipe(Layer.provideMerge(NodeServices.layer)), { excludeTestServices: true })(
    (scoped) => {
      scoped.effect(
        "extracts fonts only into its own folder, by its own names, and only fonts",
        () =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped({ prefix: "media-burn-" });
            const outside = yield* fs.makeTempDirectoryScoped({ prefix: "media-burn-outside-" });
            const notFont = join(root, "notes.txt");

            yield* fs.writeFileString(notFont, "these are notes, not a font\n");

            const output = yield* film(root, [
              {
                file: FONT,
                mimetype: "application/x-truetype-font",
                name: "../../escaped.ttf",
              },
              { file: FONT, mimetype: "font/otf", name: path.join(outside, "absolute.ttf") },
              { file: FONT, mimetype: "font/ttf", name: `${"a".repeat(300)}.ttf` },
              { file: FONT, mimetype: "application/x-font-ttf", name: "sub/dir/nested.ttf" },
              { file: notFont, mimetype: "application/x-truetype-font", name: "claims.ttf" },
              { file: notFont, mimetype: "text/plain", name: "readme.txt" },
            ]);

            const stream = path.join(root, "stream");
            const folder = path.join(stream, "subtitle");
            const preparer = yield* BurnedText.Service;

            const files = yield* preparer.prepare(
              sourceOf(output, TextSource.Embedded({ stream: 1 })),
              folder,
            );

            assert.deepStrictEqual(files, {
              subtitle: path.join(folder, "subtitle.ass"),
              fonts: path.join(folder, "fonts"),
            });
            // The four fonts, by the service's names; the text that claims to be a font is gone.
            assert.deepStrictEqual(
              (yield* fs.readDirectory(path.join(folder, "fonts"))).toSorted(),
              ["0.font", "1.font", "2.font", "3.font"],
            );

            for (const name of yield* fs.readDirectory(path.join(folder, "fonts"))) {
              const bytes = yield* fs.readFile(path.join(folder, "fonts", name));

              assert.deepStrictEqual(bytes, yield* fs.readFile(FONT), name);
            }

            // Nothing was written where the file's names point.
            assert.deepStrictEqual((yield* fs.readDirectory(stream)).toSorted(), ["subtitle"]);
            assert.deepStrictEqual((yield* fs.readDirectory(folder)).toSorted(), [
              "fonts",
              "subtitle.ass",
            ]);
            assert.deepStrictEqual(yield* fs.readDirectory(outside), []);
            assert.isFalse(yield* fs.exists(path.join(root, "escaped.ttf")));
            assert.isFalse(yield* fs.exists(path.join(path.dirname(root), "escaped.ttf")));
          }).pipe(Effect.scoped),
        60_000,
      );

      scoped.effect(
        "writes the track as ASS on the file's own clock, and a sidecar's moved onto it",
        () =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectoryScoped({ prefix: "media-burn-" });
            const output = yield* film(root, []);
            const preparer = yield* BurnedText.Service;

            const embedded = yield* preparer.prepare(
              sourceOf(output, TextSource.Embedded({ stream: 1 })),
              path.join(root, "embedded"),
            );

            const script = yield* fs.readFileString(embedded.subtitle ?? "");

            assert.include(script, "Style: Blocks,Lar Blocks,40");
            assert.include(
              script,
              "Dialogue: 0,0:00:01.00,0:00:09.00,Blocks,,0,0,0,,{\\pos(20,20)}LAR",
            );
            // The film carries no fonts, so the subtitle draws in the fallback.
            assert.isUndefined(embedded.fonts);

            // A sidecar counts from the film's first frame, here 10 s into its clock.
            const sidecar = path.join(root, "Film (2020).en.srt");
            const text = "1\n00:00:02,000 --> 00:00:04,500\nA line, with: [specials]\n";

            yield* fs.writeFileString(sidecar, text);

            const moved = yield* preparer.prepare(
              { ...sourceOf(output, TextSource.Sidecar({ path: sidecar }), 10), style: "plain" },
              path.join(root, "sidecar"),
            );

            const converted = yield* fs.readFileString(moved.subtitle ?? "");

            assert.include(converted, "Dialogue: 0,0:00:12.00,0:00:14.50,Default,");
            assert.include(converted, "A line, with: [specials]");
            // The sidecar is read where it is, and left as it was.
            assert.strictEqual(yield* fs.readFileString(sidecar), text);
          }).pipe(Effect.scoped),
        60_000,
      );

      scoped.effect("fails, rather than draw nothing, when the track cannot be read", () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "media-burn-" });
          const output = yield* film(root, []);
          const preparer = yield* BurnedText.Service;

          const failed = yield* preparer
            .prepare(sourceOf(output, TextSource.Embedded({ stream: 7 })), path.join(root, "out"))
            .pipe(Effect.flip);

          assert.instanceOf(failed, BurnedText.BurnTextFailed);
          assert.strictEqual(failed.reason, "unreadable");
        }).pipe(Effect.scoped),
      );
    },
  );
});

/** A font attachment as ffprobe lists it: stream `index`, `bytes` long. */
const font = (index: number, bytes: number, codec = "ttf"): Attachment => ({
  index,
  codec_name: codec,
  extradata_size: bytes,
});

describe("the fonts a stream extracts", () => {
  it("takes fonts by codec or type, in stream order, and nothing else", () => {
    assert.deepStrictEqual(
      fontsToExtract([
        font(2, 100),
        { index: 3, codec_name: "unknown", extradata_size: 100, tags: { mimetype: "font/otf" } },
        { index: 4, codec_name: "unknown", extradata_size: 100, tags: { mimetype: "image/png" } },
        { index: 5, extradata_size: 100, tags: { mimetype: "Application/X-TrueType-Font" } },
        font(6, 0),
      ]).map((chosen) => chosen.index),
      [2, 3, 5],
    );
  });

  it("keeps within the count, the size of each, and the size in all", () => {
    const many = Array.from({ length: MAX_FONTS + 5 }, (_, index) => font(index, 1000));

    assert.lengthOf(fontsToExtract(many), MAX_FONTS);
    assert.deepStrictEqual(
      fontsToExtract([font(1, MAX_FONT_BYTES + 1), font(2, MAX_FONT_BYTES)]).map(
        (chosen) => chosen.index,
      ),
      [2],
    );

    const large = Array.from({ length: 10 }, (_, index) => font(index, MAX_FONT_BYTES));
    const total = fontsToExtract(large).reduce((sum, chosen) => sum + chosen.bytes, 0);

    assert.isAtMost(total, MAX_FONT_TOTAL);
    assert.lengthOf(fontsToExtract(large), MAX_FONT_TOTAL / MAX_FONT_BYTES);
  });
});
