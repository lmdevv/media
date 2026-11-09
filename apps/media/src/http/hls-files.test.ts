import { assert, describe, layer } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Redacted, Schedule } from "effect";
import { HttpClient } from "effect/http";

import type { ClientCapabilities } from "@media/contracts/media-playback";

import { resolveInsideRoots } from "../playback/file-resolver.ts";
import { decidePlayback, PlaybackPlan } from "../playback/playback-decision.ts";
import * as PlaybackToken from "../playback/playback-token.ts";
import * as StreamSessions from "../playback/stream-sessions.ts";
import { writeFakeFfmpeg } from "../testing/fake-ffmpeg.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import { signTestToken } from "../testing/test-config.ts";

const hasFfmpeg = await ffmpegAvailable();

const stallsAfterFirstFragment = await writeFakeFfmpeg({ hlsStallsAfterFragments: 1 });

const FIRST_RUN_FRAGMENT = /\/1\/f0\.m4s$/u;

const opens = {
  armed: false,
  reached: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
};

const stallNextFragmentOpen = Effect.sync(() => {
  opens.armed = true;
  opens.reached = Promise.withResolvers<void>();
  opens.release = Promise.withResolvers<void>();
});

const releaseOpens = Effect.sync(() => {
  opens.armed = false;
  opens.release.resolve();
});

// Node's `fs.open` acquires its handle uninterruptibly, as on a hung network share.
const stalledOpens = (real: FileSystem.FileSystem) =>
  FileSystem.FileSystem.of({
    ...real,
    open: (file, options) =>
      opens.armed && FIRST_RUN_FRAGMENT.test(file)
        ? Effect.uninterruptible(
            Effect.suspend(() => {
              opens.armed = false;
              opens.reached.resolve();

              return Effect.promise(() => opens.release.promise);
            }),
          ).pipe(Effect.andThen(real.open(file, options)))
        : real.open(file, options),
  });

const smallScreen: ClientCapabilities = {
  containers: [],
  videoCodecs: [{ codec: "h264", maxBitDepth: 8 }],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 1920,
  maxHeight: 120,
  hls: false,
  mse: true,
};

const playing = Effect.gen(function* () {
  const server = yield* MediaTestServer.Service;
  const sessions = yield* StreamSessions.Service;
  const { library } = yield* FixtureWorkspace.Service;

  const token = signTestToken({
    fid: server.fileId("movies", library.directMovie),
    sid: crypto.randomUUID(),
  });

  const verified = yield* (yield* PlaybackToken.Service).verify(
    Redacted.make(token),
    PlaybackToken.PLAY,
  );

  const grant = { ...verified, audience: "household" as const };
  const file = yield* resolveInsideRoots(grant.fileId, { sidecars: true });

  const plan = decidePlayback(file.probe, smallScreen, {
    audioIndex: undefined,
    hardware: undefined,
    softwareToneMapping: false,
  });

  if (!PlaybackPlan.$is("Hls")(plan)) return yield* Effect.die("expected HLS");

  const started = yield* sessions.negotiate(grant).pipe(
    Effect.flatMap((negotiation) =>
      negotiation.start({
        file,
        plan,
        client: smallScreen,
        audioIndex: undefined,
        startSeconds: 0,
        quality: undefined,
        burnSubtitle: undefined,
        keyframes: undefined,
      }),
    ),
    Effect.scoped,
  );

  const url = `${server.baseUrl}/media/hls/${started.streamId}/${String(started.generation)}/${String(started.segmentIndex)}.m4s?token=${encodeURIComponent(token)}`;

  const first = yield* HttpClient.get(url);

  assert.strictEqual(first.status, 200, "the first segment plays");
  yield* first.arrayBuffer;

  return {
    grant,
    started,
    url,
    runFolder: `${server.transcodeDir}/${started.streamId}/1`,
  };
});

const exists = (target: string) =>
  FileSystem.FileSystem.use((fs) => fs.exists(target)).pipe(Effect.orDie);

describe.skipIf(!hasFfmpeg)("HLS files", () => {
  layer(
    MediaTestServer.layer({ FFMPEG_PATH: stallsAfterFirstFragment }, { fileSystem: stalledOpens }),
    { excludeTestServices: true, timeout: "120 seconds" },
  )((it) => {
    it.effect(
      "a segment request answers within its bound while opening the file it serves cannot be interrupted",
      () =>
        Effect.gen(function* () {
          const sessions = yield* StreamSessions.Service;
          const { grant, started, url } = yield* playing;

          yield* stallNextFragmentOpen;

          const requested = yield* Effect.forkChild(HttpClient.get(url));
          yield* Effect.promise(() => opens.reached.promise);

          const answered = yield* Fiber.join(requested).pipe(Effect.timeout("35 seconds"));

          assert.strictEqual(answered.status, 503, "the request answers not ready");

          yield* releaseOpens;
          yield* sessions.stop(started.streamId, grant);
        }).pipe(Effect.ensuring(releaseOpens)),
      90_000,
    );

    it.effect(
      "a stopped run keeps its folder while opening a file it serves cannot be interrupted",
      () =>
        Effect.gen(function* () {
          const sessions = yield* StreamSessions.Service;
          const { grant, started, url, runFolder } = yield* playing;

          yield* stallNextFragmentOpen;

          const requested = yield* Effect.forkChild(HttpClient.get(url));
          yield* Effect.promise(() => opens.reached.promise);
          yield* sessions.stop(started.streamId, grant).pipe(Effect.timeout("10 seconds"));

          const removedEarly = yield* exists(runFolder).pipe(
            Effect.repeat({
              until: (present) => !present,
              schedule: Schedule.spaced("100 millis"),
              times: 20,
            }),
            Effect.map((present) => !present),
          );

          assert.isFalse(removedEarly, "the run's folder outlives the pending open");

          yield* releaseOpens;
          yield* Fiber.join(requested).pipe(
            Effect.flatMap((response) => response.arrayBuffer),
            Effect.timeout("35 seconds"),
            Effect.ignore,
          );

          const gone = yield* exists(runFolder).pipe(
            Effect.repeat({
              until: (present) => !present,
              schedule: Schedule.spaced("100 millis"),
              times: 50,
            }),
            Effect.map((present) => !present),
          );

          assert.isTrue(gone, "the run's folder goes once the request let go of its files");
        }).pipe(Effect.ensuring(releaseOpens)),
      90_000,
    );
  });
});
