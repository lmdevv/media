import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Layer, Path } from "effect";

import * as DiskCache from "../disk-cache.ts";
import * as MediaTools from "../media/media-tools.ts";
import { copyBytes } from "../testing/byte-copies.ts";
import { invocationsOf, writeFakeFfmpeg } from "../testing/fake-ffmpeg.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import { testConfigLayer } from "../testing/test-config.ts";
import * as BurnedText from "./burned-text.ts";
import {
  type BurnSource,
  isAssScript,
  isFont,
  MAX_SCRIPT_BYTES,
  readWithin,
  TextSource,
} from "./burned-text.ts";

const hasFfmpeg = await ffmpegAvailable();

const FONT = join(import.meta.dirname, "..", "testing", "fixtures", "lar-blocks.ttf");

const SCRIPT = [
  "[Script Info]",
  "ScriptType: v4.00+",
  "",
  "[V4+ Styles]",
  "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
  "Style: Default,Lar Blocks,40,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,0,0,0,1",
  "",
  "[Events]",
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,LAR",
  "",
].join("\n");

/** A stand-in that logs each run and runs the real ffmpeg. */
const logging = await writeFakeFfmpeg({ logInvocations: true });

/** A stand-in whose conversions of an embedded stream 1 and attachment extractions never finish. */
const hanging = await writeFakeFfmpeg({
  rules: [
    { token: "-map 0:1 -c:s", runs: "any", hang: true },
    { token: "-dump_attachment", runs: "any", hang: true },
  ],
});

const sourceOf = (path: string, text: TextSource, modifiedAtMs = 1): BurnSource => ({
  file: { fileId: path, path, sizeBytes: 1, modifiedAtMs, startSeconds: 0 },
  text,
  style: "styled",
});

/** The preparer and the tools over `settings`, keeping their cache in a fresh folder. */
const preparerLayer = (settings: Readonly<Record<string, string>>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "media-burn-data-" });

      return BurnedText.layer.pipe(
        Layer.provide(DiskCache.layer),
        Layer.provideMerge(MediaTools.layer),
        Layer.provide(testConfigLayer({ DATA_DIR: dataDir, ...settings })),
      );
    }),
  ).pipe(Layer.provideMerge(NodeServices.layer));

/**
 * Writes a 2 s film in `folder` whose subtitle track (stream 1) is `script`, read as ASS whatever
 * it starts with, and which attaches the block font; returns its path.
 */
const film = Effect.fn(function* (folder: string, script: string) {
  const fs = yield* FileSystem.FileSystem;
  const tools = yield* MediaTools.Service;
  const input = join(folder, "track.ass");
  const output = join(folder, "Film (2020).mkv");

  yield* fs.writeFileString(input, script);
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
    "-f",
    "ass",
    "-i",
    input,
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
    "-attach",
    FONT,
    "-metadata:s:t:0",
    "mimetype=application/x-truetype-font",
    output,
  ]);

  return output;
});

/** How many of a logging stand-in's runs converted a track to ASS. */
const conversionsOf = (ffmpeg: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const log = yield* fs
      .readFileString(invocationsOf(ffmpeg))
      .pipe(Effect.orElseSucceed(() => ""));

    return log.split("\n").filter((line) => line.includes('"pipe:3"') && line.includes('"ass"'))
      .length;
  });

const conversions = conversionsOf(logging);

/** A stand-in whose first conversion of an embedded stream 1 fails half a second in. */
const failsOnce = await writeFakeFfmpeg({
  rules: [{ token: "-map 0:1 -c:s", runs: "any", delayMs: 500, exitCode: 1, limit: 1 }],
  logInvocations: true,
});

/** A stand-in whose first conversion of an embedded stream 1 starts a second and a half late. */
const startsLate = await writeFakeFfmpeg({
  rules: [{ token: "-map 0:1 -c:s", runs: "any", delayMs: 1500, limit: 1 }],
  logInvocations: true,
});

/** Pieces of `size` bytes, `count` of them, counting in `pulled` how many bytes were taken. */
const pieces = (size: number, count: number, pulled: { bytes: number }) => ({
  async *[Symbol.asyncIterator]() {
    for (let index = 0; index < count; index += 1) {
      pulled.bytes += size;

      yield new Uint8Array(size).fill(0x21);
    }
  },
});

describe("reading a converted track", () => {
  it("stops once the bytes read reach the bound, holding no more than it and one piece", async () => {
    const pulled = { bytes: 0 };
    const piece = 64 * 1024;

    // A header four times the bound, as a script's [Fonts] section can be.
    assert.isUndefined(
      await readWithin(pieces(piece, (4 * MAX_SCRIPT_BYTES) / piece, pulled), MAX_SCRIPT_BYTES),
    );
    assert.isAtMost(pulled.bytes, MAX_SCRIPT_BYTES + piece);

    const small = { bytes: 0 };

    assert.lengthOf((await readWithin(pieces(10, 3, small), MAX_SCRIPT_BYTES)) ?? "", 30);
  });
});

describe("an ASS script's start", () => {
  it("is its [Script Info] section, after a byte order mark and blank lines, as ffmpeg reads it", () => {
    assert.isTrue(isAssScript("[Script Info]\nScriptType: v4.00+\n"));
    assert.isTrue(isAssScript("﻿\r\n\n[Script Info]\n"));
    assert.isFalse(isAssScript("WEBVTT\n\n[Script Info]\n"));
    assert.isFalse(isAssScript(" [Script Info]\n"));
    assert.isFalse(isAssScript("[script info]\n"));
    assert.isFalse(isAssScript(""));
  });
});

describe.skipIf(!hasFfmpeg)("a burned-in text track's limits", () => {
  layer(preparerLayer({ FFMPEG_PATH: logging }), { excludeTestServices: true })((scoped) => {
    scoped.effect(
      "refuses a track that does not start as an ASS script, which the filter cannot read",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "media-burn-" });
          // ffmpeg 9 fails to start the `subtitles` filter on such a file; 7.1 draws nothing.
          const output = yield* film(root, `WEBVTT\n\n${SCRIPT}`);
          const preparer = yield* BurnedText.Service;

          const failed = yield* preparer
            .prepare(sourceOf(output, TextSource.Embedded({ stream: 1 })), path.join(root, "out"))
            .pipe(Effect.flip);

          assert.strictEqual(failed.reason, "not-a-script");
        }).pipe(Effect.scoped),
      60_000,
    );

    scoped.effect(
      "refuses a track of 32 MiB or more as ASS, fonts in its [Fonts] section included",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "media-burn-" });
          const sidecar = path.join(root, "Film (2020).en.ass");
          const [info, rest] = SCRIPT.split("\n[V4+ Styles]");

          // A font in the script's own section, as libass loads it, larger than the bound.
          yield* fs.writeFileString(
            sidecar,
            `${info ?? ""}\n[Fonts]\nfontname: big_0.ttf\n${"!".repeat(MAX_SCRIPT_BYTES)}\n\n[V4+ Styles]${rest ?? ""}`,
          );

          const preparer = yield* BurnedText.Service;

          const failed = yield* preparer
            .prepare(
              sourceOf(sidecar, TextSource.Sidecar({ path: sidecar })),
              path.join(root, "out"),
            )
            .pipe(Effect.flip);

          assert.strictEqual(failed.reason, "too-large");
        }).pipe(Effect.scoped),
      60_000,
    );

    scoped.effect(
      "converts an embedded track once for each version of the file, however many ask at once",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "media-burn-" });
          const output = yield* film(root, SCRIPT);
          const preparer = yield* BurnedText.Service;
          const before = yield* conversions;

          const prepare = (version: number, folder: string) =>
            preparer.prepare(
              sourceOf(output, TextSource.Embedded({ stream: 1 }), version),
              path.join(root, folder),
            );

          const [first, second] = yield* Effect.all([prepare(1, "a"), prepare(1, "b")], {
            concurrency: "unbounded",
          });

          yield* prepare(1, "c");

          assert.strictEqual((yield* conversions) - before, 1);
          assert.strictEqual(
            yield* fs.readFileString(second.subtitle ?? ""),
            yield* fs.readFileString(first.subtitle ?? ""),
          );
          assert.include(yield* fs.readFileString(first.subtitle ?? ""), "LAR");

          // A changed file is a new version, converted again.
          yield* prepare(2, "d");

          assert.strictEqual((yield* conversions) - before, 2);
        }).pipe(Effect.scoped),
      60_000,
    );

    scoped.effect("keeps an extracted font only as a regular file within its size", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "media-burn-fonts-" });
        const font = path.join(root, "0.font");
        const linked = path.join(root, "1.font");
        const notes = path.join(root, "2.font");
        const folder = path.join(root, "3.font");

        yield* copyBytes(FONT, font);
        yield* fs.symlink(font, linked);
        yield* fs.writeFileString(notes, "these are notes, not a font\n");
        yield* fs.makeDirectory(folder);

        const size = Number((yield* fs.stat(font)).size);

        assert.isTrue(yield* isFont(font, size));
        assert.isFalse(yield* isFont(font, size - 1), "larger than ffprobe said");
        assert.isFalse(yield* isFont(linked, size), "a link");
        assert.isFalse(yield* isFont(notes, size), "not a font");
        assert.isFalse(yield* isFont(folder, size), "a folder");
        assert.isFalse(yield* isFont(path.join(root, "4.font"), size), "missing");
      }).pipe(Effect.scoped),
    );
  });

  layer(preparerLayer({ FFMPEG_PATH: failsOnce }), { excludeTestServices: true })((scoped) => {
    scoped.effect(
      "hands a conversion's failure to everyone waiting on it, and keeps none of it for the next",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "media-burn-" });
          const output = yield* film(root, SCRIPT);
          const preparer = yield* BurnedText.Service;
          const source = sourceOf(output, TextSource.Embedded({ stream: 1 }));

          const both = yield* Effect.all(
            [
              Effect.flip(preparer.prepare(source, path.join(root, "a"))),
              Effect.flip(preparer.prepare(source, path.join(root, "b"))),
            ],
            { concurrency: "unbounded" },
          );

          assert.deepStrictEqual(
            both.map((failure) => failure.reason),
            ["unreadable", "unreadable"],
          );
          assert.strictEqual(yield* conversionsOf(failsOnce), 1, "one conversion, shared");

          const next = yield* preparer.prepare(source, path.join(root, "c"));

          assert.include(yield* fs.readFileString(next.subtitle ?? ""), "LAR");
          assert.strictEqual(yield* conversionsOf(failsOnce), 2, "converted again");
        }).pipe(Effect.scoped),
      60_000,
    );
  });

  layer(preparerLayer({ FFMPEG_PATH: startsLate }), { excludeTestServices: true })((scoped) => {
    scoped.effect(
      "keeps converting for a caller still waiting when another stops waiting",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "media-burn-" });
          const output = yield* film(root, SCRIPT);
          const preparer = yield* BurnedText.Service;
          const source = sourceOf(output, TextSource.Embedded({ stream: 1 }));

          const leaving = yield* Effect.forkChild(preparer.prepare(source, path.join(root, "a")));
          const staying = yield* Effect.forkChild(preparer.prepare(source, path.join(root, "b")));

          yield* Effect.sleep("300 millis");
          yield* Fiber.interrupt(leaving);

          const files = yield* Fiber.join(staying);

          assert.include(yield* fs.readFileString(files.subtitle ?? ""), "LAR");
          assert.strictEqual(yield* conversionsOf(startsLate), 1, "the one conversion finished");
        }).pipe(Effect.scoped),
      60_000,
    );
  });

  layer(
    preparerLayer({
      FFMPEG_PATH: hanging,
      FILE_SCAN_TIMEOUT_SECONDS: "1",
      PROBE_TIMEOUT_SECONDS: "3",
    }),
    { excludeTestServices: true },
  )((scoped) => {
    scoped.effect(
      "stops a conversion at its time limit, and draws without fonts whose extraction stops at its",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "media-burn-" });
          // The stand-in runs the real ffmpeg for this, within the probe timeout.
          const output = yield* film(root, SCRIPT);
          const preparer = yield* BurnedText.Service;

          const failed = yield* preparer
            .prepare(sourceOf(output, TextSource.Embedded({ stream: 1 })), path.join(root, "a"))
            .pipe(Effect.flip);

          assert.strictEqual(failed.reason, "timed-out");

          // A sidecar still converts, and the film's attachment never comes out, so the subtitle
          // draws in the fallback font.
          const sidecar = path.join(root, "Film (2020).en.srt");

          yield* fs.writeFileString(sidecar, "1\n00:00:01,000 --> 00:00:02,000\nA line\n");

          const files = yield* preparer.prepare(
            { ...sourceOf(output, TextSource.Sidecar({ path: sidecar })), style: "plain" },
            path.join(root, "b"),
          );

          assert.deepStrictEqual(Object.keys(files), ["subtitle"]);
        }).pipe(Effect.scoped),
      60_000,
    );
  });
});
