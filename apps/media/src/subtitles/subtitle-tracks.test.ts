import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Path } from "effect";

import { MediaFileId } from "@media/contracts/ids";

import * as DiskCache from "../disk-cache.ts";
import * as MediaTools from "../media/media-tools.ts";
import type { CheckedMediaFile } from "../playback/file-resolver.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import { testConfigLayer } from "../testing/test-config.ts";
import * as SubtitleConverter from "./subtitle-tracks.ts";
import { sidecarTrackId, subtitleTracks } from "./subtitle-tracks.ts";

const hasFfmpeg = await ffmpegAvailable();

const srt = (text: string): string => `1\n00:00:01,000 --> 00:00:02,000\n${text}\n`;

const filmFolder = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folder = yield* fs.makeTempDirectoryScoped({ prefix: "movies-subtitles-" });

  const sidecar = (name: string): CheckedMediaFile["subtitles"][number] => ({
    path: path.join(folder, name),
    readPath: path.join(folder, name),
    format: "srt",
    forced: false,
    hearingImpaired: false,
    default: false,
  });

  const film = (names: ReadonlyArray<string>): CheckedMediaFile => ({
    fileId: MediaFileId.make("film"),
    path: path.join(folder, "Film (2020).mkv"),
    sizeBytes: 1000,
    modifiedAtMs: 1,
    probe: {
      container: "mkv",
      formatName: "matroska,webm",
      durationSeconds: 10,
      startSeconds: 0,
      audio: [],
      subtitles: [],
      chapters: [],
    },
    subtitles: names.map(sidecar),
  });

  return { folder, film };
});

const converterIn = (dataDir: string) =>
  Layer.build(
    SubtitleConverter.layer.pipe(
      Layer.provide(DiskCache.layer),
      Layer.provide(MediaTools.layer),
      Layer.provide(testConfigLayer({ DATA_DIR: dataDir })),
      Layer.provide(NodeServices.layer),
    ),
  ).pipe(Effect.map((context) => Context.get(context, SubtitleConverter.Service)));

describe.skipIf(!hasFfmpeg)("subtitle tracks", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("keeps a sidecar's ID when other sidecars come and go", () =>
      Effect.gen(function* () {
        const { film } = yield* filmFolder;
        const english = sidecarTrackId("/films/Film (2020).en.srt");

        assert.match(english, /^x[0-9a-f]{12}$/);
        assert.strictEqual(sidecarTrackId("/elsewhere/Film (2020).en.srt"), english);

        const before = subtitleTracks(film(["Film (2020).en.srt"])).map((track) => track.id);

        const after = subtitleTracks(film(["Film (2020).de.srt", "Film (2020).en.srt"])).map(
          (track) => track.id,
        );

        assert.include(after, before[0]);
        assert.strictEqual(new Set(after).size, 2);
      }),
    );

    it.effect(
      "converts a sidecar again when it changes, and finds it after a new one appears",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { folder, film } = yield* filmFolder;
          const english = path.join(folder, "Film (2020).en.srt");

          yield* fs.writeFileString(english, srt("First version"));

          const converted = yield* Effect.gen(function* () {
            const converter = yield* converterIn(path.join(folder, "data"));
            const id = sidecarTrackId(english);
            const first = yield* converter.toWebVtt(film(["Film (2020).en.srt"]), id);

            yield* fs.writeFileString(english, srt("Second version, longer"));

            yield* fs.writeFileString(path.join(folder, "Film (2020).de.srt"), srt("Deutsch"));

            const second = yield* converter.toWebVtt(
              film(["Film (2020).de.srt", "Film (2020).en.srt"]),
              id,
            );

            return [first, second] as const;
          });

          assert.include(converted[0], "First version");
          assert.include(converted[1], "Second version, longer");
        }),
    );
  });
});
