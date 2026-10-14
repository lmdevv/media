import { join } from "node:path";

import { TrackId } from "@music/commands/ids";
import { describe, expect, it } from "vitest";
import { Cause, Clock, Effect, Exit, Fiber, Layer, Option, Schedule, Stream } from "effect";
import { TestClock } from "effect/testing";

import * as Files from "./files.ts";
import {
  fixtureLibrary,
  MEDIA_TEST_TIMEOUT,
  probe,
  temporaryDirectory,
  testConfig,
} from "./testing/fixtures.ts";
import * as Transcoder from "./transcoder.ts";
import { adtsPayload } from "./testing/adts.ts";
import { ffmpegHangingOnName } from "./testing/hanging-ffmpeg.ts";
import { mediaData, withoutIndex } from "./testing/mp4-boxes.ts";
import { runScoped } from "./testing/run.ts";
import { sineSegment } from "./testing/sine.ts";

const indexOfAtom = (bytes: Uint8Array, name: string): number =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).indexOf(name, 0, "latin1");

const transcoderWith = (dataDir: string, cacheMaxBytes: number) =>
  Layer.build(Transcoder.layer.pipe(Layer.provide(testConfig(dataDir, cacheMaxBytes)))).pipe(
    Effect.flatMap((context) => Transcoder.Transcoder.pipe(Effect.provideContext(context))),
  );

/** An `aac-128` transcode of `source`, a song with ID `id`. */
const aacInput = (id: string, source: string): Transcoder.TranscodeInput => ({
  trackId: TrackId.make(id),
  profile: "aac-128",
  source,
  mtimeMs: 1,
  codec: "mp3",
});

const collect = (bytes: Stream.Stream<Uint8Array, Transcoder.TranscodeError>) =>
  Stream.runCollect(bytes).pipe(Effect.map((chunks) => Buffer.concat(chunks)));

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
          codec: "flac",
        };

        const { path: output, timing } = yield* transcoder.transcode(input);

        expect(Option.isNone(timing)).toBe(true);
        expect(output).toBe(join(dataDir, "cache", "aac-128", "track1-1234.m4a"));
        const probed = yield* probe(output);

        expect(probed.streams).toMatchObject([
          { codec_name: "aac", sample_rate: "44100", channels: 2 },
        ]);
        const bytes = yield* Files.readWholeFile(output);

        expect(indexOfAtom(bytes, "moov")).toBeLessThan(indexOfAtom(bytes, "mdat"));

        const before = yield* Files.statPath(output);

        expect((yield* transcoder.transcode(input)).path).toBe(output);
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
            codec: "flac",
          });

        // Measure the three outputs, then size the cache so any two fit and three do not.
        const measuring = yield* transcoderWith(
          yield* temporaryDirectory("measure"),
          512 * 1024 * 1024,
        );

        const sizes = yield* Effect.forEach(["a", "b", "c"] as const, (id) =>
          transcodeWith(measuring, id).pipe(
            Effect.flatMap(({ path }) => Files.statPath(path)),
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

  it("streams a fragmented transcode while ffmpeg writes it and shares it between readers", () =>
    runScoped(
      Effect.gen(function* () {
        const scratch = yield* temporaryDirectory("sine");
        // Four minutes: long enough that ffmpeg is still busy when the first bytes are out.
        const source = yield* sineSegment(scratch, "long", "mp3", 0, 48_000 * 240);
        const dataDir = yield* temporaryDirectory("data");
        const transcoder = yield* transcoderWith(dataDir, 512 * 1024 * 1024);
        const cacheDir = join(dataDir, "cache", "fmp4-aac");

        const input = {
          trackId: TrackId.make("long"),
          profile: "fmp4-aac" as const,
          source,
          mtimeMs: 1,
          codec: "mp3",
        };

        const [live, finished] = yield* Effect.scoped(
          Effect.gen(function* () {
            const [first, second] = yield* Effect.all(
              [transcoder.open(input), transcoder.open(input)],
              { concurrency: 2 },
            );

            if (!Transcoder.Opened.$is("Live")(first) || !Transcoder.Opened.$is("Live")(second)) {
              throw new Error("Expected live transcodes");
            }

            expect(
              Option.isNone(yield* Effect.option(Files.statPath(join(cacheDir, "long-1.m4a")))),
            ).toBe(true);

            const [one, two] = yield* Effect.all([collect(first.bytes), collect(second.bytes)], {
              concurrency: 2,
            });

            // `equals`, because `toEqual` diffs megabytes byte by byte.
            expect(two.equals(one)).toBe(true);

            return [{ bytes: one, timing: first.timing }, yield* first.finished] as const;
          }),
        );

        // The stream is the finished file without its index, byte for byte.
        expect(live.bytes.equals(withoutIndex(yield* Files.readWholeFile(finished.path)))).toBe(
          true,
        );

        // Priming and rate are exact up front; the length is the source's estimate.
        const measured = Option.getOrThrow(finished.timing);
        const expected = Option.getOrThrow(live.timing);

        expect(expected.primingSamples).toBe(measured.primingSamples);
        expect(expected.sampleRate).toBe(measured.sampleRate);
        expect(Math.abs(expected.durationSamples - measured.durationSamples)).toBeLessThan(
          measured.sampleRate / 10,
        );

        // Once its readers are done, the live copy is gone and a new request finds the file.
        expect((yield* Files.listNames(cacheDir)).toSorted()).toEqual([
          "long-1.m4a",
          "long-1.m4a.json",
        ]);

        const again = yield* Effect.scoped(transcoder.open(input));

        expect(Transcoder.Opened.$is("Finished")(again)).toBe(true);
      }),
    ));

  it("streams an AAC transcode as ADTS while ffmpeg writes the fast-start file", () =>
    runScoped(
      Effect.gen(function* () {
        const scratch = yield* temporaryDirectory("sine");
        const source = yield* sineSegment(scratch, "long", "mp3", 0, 48_000 * 240);
        const dataDir = yield* temporaryDirectory("data");
        const transcoder = yield* transcoderWith(dataDir, 512 * 1024 * 1024);
        const cacheDir = join(dataDir, "cache", "aac-320");

        const input = {
          trackId: TrackId.make("long"),
          profile: "aac-320" as const,
          source,
          mtimeMs: 1,
          codec: "mp3",
        };

        const [streamed, finished] = yield* Effect.scoped(
          Effect.gen(function* () {
            const opened = yield* transcoder.open(input);

            if (!Transcoder.Opened.$is("Live")(opened))
              throw new Error("Expected a live transcode");

            expect(Option.isNone(opened.timing)).toBe(true);
            expect(
              Option.isNone(yield* Effect.option(Files.statPath(join(cacheDir, "long-1.m4a")))),
            ).toBe(true);

            return [yield* collect(opened.bytes), yield* opened.finished] as const;
          }),
        );

        // The stream carries exactly the finished file's frames, each behind an ADTS header.
        const file = yield* Files.readWholeFile(finished.path);

        expect(indexOfAtom(file, "moov")).toBeLessThan(indexOfAtom(file, "mdat"));
        expect(adtsPayload(streamed)?.equals(mediaData(file))).toBe(true);

        const copy = join(scratch, "streamed.aac");

        yield* Files.writeFileAtomic(copy, streamed, "copy");
        const probed = yield* probe(copy);

        expect(probed.format.format_name).toBe("aac");
        expect(probed.streams).toMatchObject([
          { codec_name: "aac", sample_rate: "44100", channels: 2 },
        ]);

        expect(yield* Files.listNames(cacheDir)).toEqual(["long-1.m4a"]);
        expect(
          Transcoder.Opened.$is("Finished")(yield* Effect.scoped(transcoder.open(input))),
        ).toBe(true);
      }),
    ));

  it("runs two transcodes at once and times each out from its start, not from its wait", () =>
    runScoped(
      Effect.gen(function* () {
        const clock = yield* TestClock.make();

        yield* Effect.gen(function* () {
          const scratch = yield* temporaryDirectory("ffmpeg");
          const ffmpeg = yield* Effect.promise(() => ffmpegHangingOnName(scratch));
          const library = yield* temporaryDirectory("library");
          const dataDir = yield* temporaryDirectory("data");

          const transcoder = yield* Layer.build(
            Transcoder.layer.pipe(Layer.provide(testConfig(dataDir, undefined, ffmpeg.path))),
          ).pipe(
            Effect.flatMap((context) => Transcoder.Transcoder.pipe(Effect.provideContext(context))),
          );

          const started = Effect.promise(ffmpeg.started);

          const startedRuns = (count: number) =>
            clock.withLive(
              started.pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("20 millis"),
                  until: (runs) => runs >= count,
                  times: 250,
                }),
              ),
            );

          // Two songs whose ffmpeg never finishes take both slots.
          const stuck = yield* Effect.forEach(["hang-a", "hang-b"], (name) =>
            sineSegment(library, name, "mp3", 0, 48_000).pipe(
              Effect.flatMap((source) => transcoder.transcode(aacInput(name, source))),
              Effect.exit,
              Effect.forkScoped,
            ),
          );

          expect(yield* startedRuns(2)).toBe(2);
          const source = yield* sineSegment(library, "next", "mp3", 0, 48_000);

          const next = yield* transcoder
            .transcode(aacInput("next", source))
            .pipe(Effect.forkScoped);

          // The third waits for a slot.
          yield* clock.withLive(Effect.sleep("300 millis"));
          expect(yield* started).toBe(2);

          // Ten minutes on, the stuck ones time out and free their slots. The third has not run
          // yet, so its own ten minutes start now.
          yield* clock.adjust("10 minutes");

          for (const exit of yield* Fiber.joinAll(stuck)) {
            expect(Exit.isFailure(exit)).toBe(true);

            if (Exit.isFailure(exit)) {
              expect(Cause.findErrorOption(exit.cause)).toEqual(
                Option.some(expect.objectContaining({ cause: "timeout" })),
              );
            }
          }

          const transcoded = yield* Fiber.join(next);

          expect(transcoded.path).toBe(join(dataDir, "cache", "aac-128", "next-1.m4a"));
          expect(yield* started).toBe(3);
        }).pipe(Effect.provideService(Clock.Clock, clock));
      }),
    ));

  it("stops a transcode a second after its last reader leaves, and starts over later", () =>
    runScoped(
      Effect.gen(function* () {
        const scratch = yield* temporaryDirectory("sine");
        const source = yield* sineSegment(scratch, "long", "mp3", 0, 48_000 * 240);
        const dataDir = yield* temporaryDirectory("data");
        const transcoder = yield* transcoderWith(dataDir, 512 * 1024 * 1024);
        const cacheDir = join(dataDir, "cache", "fmp4-aac");

        const input = {
          trackId: TrackId.make("left"),
          profile: "fmp4-aac" as const,
          source,
          mtimeMs: 1,
          codec: "mp3",
        };

        const firstChunk = Effect.scoped(
          transcoder
            .open(input)
            .pipe(
              Effect.flatMap((opened) =>
                Transcoder.Opened.$is("Live")(opened)
                  ? Stream.runCollect(Stream.take(opened.bytes, 1))
                  : Effect.succeed([]),
              ),
            ),
        );

        const liveFiles = Files.listNames(cacheDir).pipe(
          Effect.map((names) => names.filter((name) => name.endsWith(".live.part"))),
        );

        expect(yield* firstChunk).toHaveLength(1);
        const running = yield* liveFiles;

        // Back within the grace period: the same run (with the same live file) goes on.
        expect(running).toHaveLength(1);
        expect(yield* firstChunk).toHaveLength(1);
        expect(yield* liveFiles).toEqual(running);

        // Gone for longer: ffmpeg stops and leaves nothing behind.
        yield* Effect.sleep("1500 millis");
        expect(yield* Files.listNames(cacheDir)).toEqual([]);

        const finished = yield* transcoder.transcode(input);

        expect(Option.isSome(finished.timing)).toBe(true);
        expect((yield* Files.listNames(cacheDir)).toSorted()).toEqual([
          "left-1.m4a",
          "left-1.m4a.json",
        ]);
      }),
    ));
});
