import { join } from "node:path";

import { TrackId } from "@media/contracts/ids";
import { describe, expect, it } from "vitest";
import { Cause, Clock, Duration, Effect, Exit, Fiber, Option, Schedule, Stream } from "effect";
import { TestClock } from "effect/testing";

import * as Files from "./music-files.ts";
import { adtsPayload } from "./testing/adts.ts";
import { ffmpegHangingOnName } from "./testing/hanging-ffmpeg.ts";
import { mediaData, withoutIndex } from "./testing/mp4-boxes.ts";
import {
  listNames,
  MEDIA_TEST_TIMEOUT,
  probe,
  runScoped,
  songLibrary,
  temporaryDirectory,
  transcoderWith,
} from "./testing/music-fixtures.ts";
import { sineSegment } from "./testing/sine.ts";
import * as Transcoder from "./transcoder.ts";

const indexOfAtom = (bytes: Uint8Array, name: string): number =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).indexOf(name, 0, "latin1");

const settledPrepare = (
  transcoder: Transcoder.Interface,
  input: Transcoder.TranscodeInput,
  pause: Effect.Effect<void> = Effect.sleep("50 millis"),
): Effect.Effect<Transcoder.Prepared> =>
  transcoder.prepare(input).pipe(
    Effect.filterOrElse(
      (prepared) => !Transcoder.Prepared.$is("Pending")(prepared),
      () => pause.pipe(Effect.andThen(settledPrepare(transcoder, input, pause))),
    ),
  );

const eventually = <A>(count: Effect.Effect<A>, until: (value: A) => boolean) =>
  count.pipe(Effect.repeat({ schedule: Schedule.spaced("20 millis"), until, times: 250 }));

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
        const root = yield* songLibrary("The Sine Waves/Harmonics/01 Fundamental.flac");
        const dataDir = yield* temporaryDirectory("data");
        const transcoder = yield* transcoderWith(dataDir);

        const input = {
          trackId: TrackId.make("track1"),
          profile: "aac-128" as const,
          source: join(root, "The Sine Waves/Harmonics/01 Fundamental.flac"),
          mtimeMs: 1234.5,
          codec: "flac",
        };

        const { path: output, timing } = yield* transcoder.transcode(input);

        expect(Option.isNone(timing)).toBe(true);
        expect(output).toBe(join(dataDir, "cache", "music", "aac-128", "track1-1234.m4a"));
        const probed = yield* probe(output);

        expect(probed.streams).toMatchObject([
          { codec_name: "aac", sample_rate: "44100", channels: 2 },
        ]);
        const bytes = yield* Files.readWholeFile(output);

        expect(indexOfAtom(bytes, "moov")).toBeLessThan(indexOfAtom(bytes, "mdat"));

        const before = yield* Files.statPath(output);

        expect((yield* transcoder.transcode(input)).path).toBe(output);
        expect((yield* Files.statPath(output)).size).toBe(before.size);
      }),
    ));

  it("streams a fragmented transcode while ffmpeg writes it and shares it between readers", () =>
    runScoped(
      Effect.gen(function* () {
        const scratch = yield* temporaryDirectory("sine");
        const source = yield* sineSegment(scratch, "long", "mp3", 0, 48_000 * 240);
        const dataDir = yield* temporaryDirectory("data");
        const transcoder = yield* transcoderWith(dataDir);
        const cacheDir = join(dataDir, "cache", "music", "fmp4-aac");

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

            expect(two.equals(one)).toBe(true);

            return [{ bytes: one, timing: first.timing }, yield* first.finished] as const;
          }),
        );

        expect(live.bytes.equals(withoutIndex(yield* Files.readWholeFile(finished.path)))).toBe(
          true,
        );

        const measured = Option.getOrThrow(finished.timing);
        const expected = Option.getOrThrow(live.timing);

        expect(expected.primingSamples).toBe(measured.primingSamples);
        expect(expected.sampleRate).toBe(measured.sampleRate);
        expect(Math.abs(expected.durationSamples - measured.durationSamples)).toBeLessThan(
          measured.sampleRate / 10,
        );

        expect((yield* listNames(cacheDir)).toSorted()).toEqual(["long-1.m4a", "long-1.m4a.json"]);

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
        const transcoder = yield* transcoderWith(dataDir);
        const cacheDir = join(dataDir, "cache", "music", "aac-320");

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

        expect(yield* listNames(cacheDir)).toEqual(["long-1.m4a"]);
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

          const transcoder = yield* transcoderWith(dataDir, ffmpeg.path);

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

          yield* clock.withLive(Effect.sleep("300 millis"));
          expect(yield* started).toBe(2);

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

          expect(transcoded.path).toBe(join(dataDir, "cache", "music", "aac-128", "next-1.m4a"));
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
        const transcoder = yield* transcoderWith(dataDir);
        const cacheDir = join(dataDir, "cache", "music", "fmp4-aac");

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

        const liveFiles = listNames(join(dataDir, "music", "transcoding")).pipe(
          Effect.map((names) => names.filter((name) => name.endsWith(".live.part"))),
        );

        expect(yield* firstChunk).toHaveLength(1);
        const running = yield* liveFiles;

        expect(running).toHaveLength(1);
        expect(yield* firstChunk).toHaveLength(1);
        expect(yield* liveFiles).toEqual(running);
        // Nothing half written sits where the cache pruner prunes by size.
        expect(yield* listNames(cacheDir)).toEqual([]);

        yield* Effect.sleep("1500 millis");
        expect(yield* listNames(cacheDir)).toEqual([]);

        const finished = yield* transcoder.transcode(input);

        expect(Option.isSome(finished.timing)).toBe(true);
        expect((yield* listNames(cacheDir)).toSorted()).toEqual(["left-1.m4a", "left-1.m4a.json"]);
      }),
    ));

  it("prepares transcodes in the background in a lane of its own, one at a time", () =>
    runScoped(
      Effect.gen(function* () {
        const scratch = yield* temporaryDirectory("ffmpeg");
        const ffmpeg = yield* Effect.promise(() => ffmpegHangingOnName(scratch));
        const library = yield* temporaryDirectory("library");
        const started = Effect.promise(ffmpeg.started);

        const song = (name: string) =>
          sineSegment(library, name, "mp3", 0, 48_000).pipe(
            Effect.map((source) => aacInput(name, source)),
          );

        const listened = yield* transcoderWith(yield* temporaryDirectory("data"), ffmpeg.path);

        yield* Effect.forEach(["hang-a", "hang-b"], (name) =>
          song(name).pipe(Effect.flatMap(listened.transcode), Effect.exit, Effect.forkScoped),
        );
        expect(yield* eventually(started, (runs) => runs >= 2)).toBe(2);
        const wanted = yield* song("wanted");

        expect(yield* listened.prepare(wanted)).toMatchObject({ _tag: "Pending" });
        const ready = yield* settledPrepare(listened, wanted);

        if (!Transcoder.Prepared.$is("Ready")(ready)) expect.unreachable("not prepared");
        const probed = yield* probe(ready.transcoded.path);

        expect(probed.format.format_name).toContain("mp4");
        expect(probed.streams).toMatchObject([{ codec_name: "aac" }]);
        expect(yield* listened.prepare(wanted)).toEqual(ready);

        const downloaded = yield* transcoderWith(yield* temporaryDirectory("data"), ffmpeg.path);

        const before = yield* started;

        expect(yield* downloaded.prepare(yield* song("hang-download"))).toMatchObject({
          _tag: "Pending",
        });
        expect(yield* downloaded.prepare(yield* song("queued"))).toMatchObject({
          _tag: "Pending",
        });

        const played = yield* Effect.forEach(
          ["a", "b"],
          (name) => song(name).pipe(Effect.flatMap(downloaded.transcode)),
          { concurrency: 2 },
        );

        expect(played).toHaveLength(2);
        expect(yield* started).toBe(before + 3);
      }),
    ));

  it("stops a prepared transcode nobody has asked about for a while, and keeps it while asked", () =>
    runScoped(
      Effect.gen(function* () {
        const clock = yield* TestClock.make();

        yield* Effect.gen(function* () {
          const scratch = yield* temporaryDirectory("ffmpeg");
          const ffmpeg = yield* Effect.promise(() => ffmpegHangingOnName(scratch));
          const library = yield* temporaryDirectory("library");

          const transcoder = yield* transcoderWith(yield* temporaryDirectory("data"), ffmpeg.path);

          const input = aacInput("hang", yield* sineSegment(library, "hang", "mp3", 0, 48_000));

          const runs = Effect.promise(async () => ({
            started: await ffmpeg.started(),
            running: await ffmpeg.running(),
          }));

          const almostHold = Duration.toMillis(Transcoder.PREPARE_HOLD) - 1000;

          expect(yield* transcoder.prepare(input)).toMatchObject({ _tag: "Pending" });
          expect(yield* clock.withLive(eventually(runs, ({ running }) => running === 1))).toEqual({
            started: 1,
            running: 1,
          });

          yield* clock.adjust(almostHold);
          expect(yield* transcoder.prepare(input)).toMatchObject({ _tag: "Pending" });
          yield* clock.adjust(almostHold);
          yield* clock.withLive(Effect.sleep("200 millis"));
          expect(yield* runs).toEqual({ started: 1, running: 1 });

          yield* clock.adjust("2 seconds");
          yield* clock.withLive(Effect.sleep("100 millis"));
          yield* clock.adjust("1 second");
          expect(yield* clock.withLive(eventually(runs, ({ running }) => running === 0))).toEqual({
            started: 1,
            running: 0,
          });

          expect(yield* transcoder.prepare(input)).toMatchObject({ _tag: "Pending" });
          expect(yield* clock.withLive(eventually(runs, ({ running }) => running === 1))).toEqual({
            started: 2,
            running: 1,
          });
        }).pipe(Effect.provideService(Clock.Clock, clock));
      }),
    ));

  it("reports a prepared transcode's failure to every ask for a while, then tries again", () =>
    runScoped(
      Effect.gen(function* () {
        const clock = yield* TestClock.make();

        yield* Effect.gen(function* () {
          const scratch = yield* temporaryDirectory("ffmpeg");
          const ffmpeg = yield* Effect.promise(() => ffmpegHangingOnName(scratch));
          const library = yield* temporaryDirectory("library");
          const source = join(library, "junk.mp3");

          yield* Files.writeFileAtomic(source, new TextEncoder().encode("not audio"), "junk");

          const transcoder = yield* transcoderWith(yield* temporaryDirectory("data"), ffmpeg.path);

          const input = aacInput("junk", source);
          const pause = clock.withLive(Effect.sleep("50 millis"));
          const started = Effect.promise(ffmpeg.started);
          const ttl = Duration.toMillis(Transcoder.PREPARE_FAILURE_TTL);

          expect(yield* settledPrepare(transcoder, input, pause)).toMatchObject({
            _tag: "Failed",
            error: { trackId: "junk", profile: "aac-128" },
          });
          expect(yield* started).toBe(1);

          yield* clock.adjust(ttl - 1000);
          expect(yield* transcoder.prepare(input)).toMatchObject({ _tag: "Failed" });
          expect(yield* started).toBe(1);

          yield* clock.adjust("2 seconds");
          expect(yield* transcoder.prepare(input)).toMatchObject({ _tag: "Pending" });
          expect(yield* settledPrepare(transcoder, input, pause)).toMatchObject({
            _tag: "Failed",
          });
          expect(yield* started).toBe(2);
        }).pipe(Effect.provideService(Clock.Clock, clock));
      }),
    ));
});
