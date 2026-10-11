import { join } from "node:path";

import { TrackId } from "@music/commands/ids";
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";

import * as Files from "./files.ts";
import {
  fixtureLibrary,
  MEDIA_TEST_TIMEOUT,
  probe,
  temporaryDirectory,
  testConfig,
} from "./testing/fixtures.ts";
import * as Transcoder from "./transcoder.ts";
import { runScoped } from "./testing/run.ts";

const indexOfAtom = (bytes: Uint8Array, name: string): number =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).indexOf(name, 0, "latin1");

const transcoderWith = (dataDir: string, cacheMaxBytes: number) =>
  Layer.build(Transcoder.layer.pipe(Layer.provide(testConfig(dataDir, cacheMaxBytes)))).pipe(
    Effect.flatMap((context) => Transcoder.Transcoder.pipe(Effect.provideContext(context))),
  );

describe("Transcoder", { timeout: MEDIA_TEST_TIMEOUT }, () => {
  it("writes fast-start AAC that ffprobe can read and reuses it", () =>
    runScoped(
      Effect.gen(function* () {
        const { root } = yield* fixtureLibrary;
        const dataDir = yield* temporaryDirectory("data");
        const transcoder = yield* transcoderWith(dataDir, 512 * 1024 * 1024);

        const input = {
          trackId: TrackId.make("track1"),
          profile: "aac-128" as const,
          source: join(root, "The Sine Waves/Harmonics/01 Fundamental.flac"),
          mtimeMs: 1234.5,
        };

        const output = yield* transcoder.transcode(input);

        expect(output).toBe(join(dataDir, "cache", "aac-128", "track1-1234.m4a"));
        const probed = yield* probe(output);

        expect(probed.streams).toMatchObject([
          { codec_name: "aac", sample_rate: "44100", channels: 2 },
        ]);
        const bytes = yield* Files.readWholeFile(output);

        expect(indexOfAtom(bytes, "moov")).toBeLessThan(indexOfAtom(bytes, "mdat"));

        const before = yield* Files.statPath(output);

        expect(yield* transcoder.transcode(input)).toBe(output);
        expect((yield* Files.statPath(output)).size).toBe(before.size);
        expect(yield* transcoder.ffmpegAvailable).toBe(true);
      }),
    ));

  it("evicts the least recently served file when the cache is over its limit", () =>
    runScoped(
      Effect.gen(function* () {
        const { root } = yield* fixtureLibrary;

        const sources = {
          a: join(root, "Aurora Tones/First Light/01 Dawn.flac"),
          b: join(root, "Aurora Tones/First Light/02 Morning Haze.flac"),
          c: join(root, "Aurora Tones/First Light/03 Golden Hour.flac"),
        };

        const transcodeWith = (
          transcoder: Transcoder.Transcoder["Service"],
          id: keyof typeof sources,
        ) =>
          transcoder.transcode({
            trackId: TrackId.make(id),
            profile: "aac-320",
            source: sources[id],
            mtimeMs: 1,
          });

        // Measure the three outputs, then size the cache so any two fit and three do not.
        const measuring = yield* transcoderWith(
          yield* temporaryDirectory("measure"),
          512 * 1024 * 1024,
        );

        const sizes = yield* Effect.forEach(["a", "b", "c"] as const, (id) =>
          transcodeWith(measuring, id).pipe(
            Effect.flatMap(Files.statPath),
            Effect.map((info) => info.size),
          ),
        );

        // The largest pair is everything except the smallest file.
        const limit = sizes.reduce((sum, size) => sum + size, 0) - Math.min(...sizes);
        const dataDir = yield* temporaryDirectory("data");
        const transcoder = yield* transcoderWith(dataDir, limit);

        yield* transcodeWith(transcoder, "a");
        yield* Effect.sleep("5 millis");
        yield* transcodeWith(transcoder, "b");
        yield* Effect.sleep("5 millis");
        // Serving A again makes B the least recently used entry.
        yield* transcodeWith(transcoder, "a");
        yield* Effect.sleep("5 millis");
        yield* transcodeWith(transcoder, "c");

        expect((yield* Files.listNames(join(dataDir, "cache", "aac-320"))).toSorted()).toEqual([
          "a-1.m4a",
          "c-1.m4a",
        ]);
      }),
    ));
});
