import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Layer, Redacted, Schedule } from "effect";

import type { ClientCapabilities } from "@media/contracts/media-playback";

import * as MediaTools from "../media/media-tools.ts";
import { writeFakeFfmpeg } from "../testing/fake-ffmpeg.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import { signTestToken } from "../testing/test-config.ts";
import { resolveInsideRoots } from "./file-resolver.ts";
import { decidePlayback, PlaybackPlan } from "./playback-decision.ts";
import * as PlaybackToken from "./playback-token.ts";
import * as StreamSessions from "./stream-sessions.ts";

const hasFfmpeg = await ffmpegAvailable();

const stallsAfterFirstFragment = await writeFakeFfmpeg({ hlsStallsAfterFragments: 1 });

const FIRST_RUN_FRAGMENT = /\/1\/f0\.m4s$/u;

const opens = {
  armed: false,
  reached: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
};

const stallNextFirstRunOpen = () => {
  opens.armed = true;
  opens.reached = Promise.withResolvers<void>();
  opens.release = Promise.withResolvers<void>();
};

const releaseOpens = Effect.sync(() => {
  opens.armed = false;
  opens.release.resolve();
});

const encoders = { live: 0, stopsBegun: 0 };

const stalledOpens = Layer.effect(
  FileSystem.FileSystem,
  Effect.map(FileSystem.FileSystem, (real) =>
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
    }),
  ),
);

const tools = Layer.effect(
  MediaTools.Service,
  Effect.map(MediaTools.Service, (real) =>
    MediaTools.Service.of({
      ...real,
      startFfmpeg: (args) =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              encoders.live -= 1;
            }),
          );

          const running = yield* real.startFfmpeg(args);
          encoders.live += 1;

          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              encoders.stopsBegun += 1;
            }),
          );

          return running;
        }),
    }),
  ),
);

const subject = (settings: Record<string, string>) =>
  Layer.fresh(StreamSessions.layer).pipe(
    Layer.provideMerge(tools),
    Layer.provide(stalledOpens),
    Layer.provideMerge(
      MediaTestServer.layer({
        FFMPEG_PATH: stallsAfterFirstFragment,
        MAX_CONCURRENT_TRANSCODES: "1",
        ...settings,
      }),
    ),
  );

const smallScreen: ClientCapabilities = {
  containers: [],
  videoCodecs: [{ codec: "h264", maxBitDepth: 8 }],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 1920,
  maxHeight: 120,
  hls: false,
  mse: true,
};

const viewer = Effect.gen(function* () {
  const server = yield* MediaTestServer.Service;
  const { library } = yield* FixtureWorkspace.Service;

  const token = signTestToken({
    fid: server.fileId("movies", library.directMovie),
    sid: crypto.randomUUID(),
  });

  const verified = yield* (yield* PlaybackToken.Service).verify(
    Redacted.make(token),
    PlaybackToken.PLAY,
  );

  const file = yield* resolveInsideRoots(verified.fileId, { sidecars: true });

  const plan = decidePlayback(file.probe, smallScreen, {
    audioIndex: undefined,
    hardware: undefined,
    softwareToneMapping: false,
  });

  if (!PlaybackPlan.$is("Hls")(plan)) return yield* Effect.die("expected HLS");

  return {
    grant: { ...verified, audience: "household" as const },
    request: {
      file,
      plan,
      client: smallScreen,
      audioIndex: undefined,
      startSeconds: 0,
      quality: undefined,
      burnSubtitle: undefined,
      keyframes: undefined,
    },
  };
});

type Viewer = Effect.Success<typeof viewer>;

const start = ({ grant, request }: Viewer) =>
  StreamSessions.Service.use((sessions) =>
    sessions.negotiate(grant).pipe(
      Effect.flatMap((negotiation) => negotiation.start(request)),
      Effect.scoped,
    ),
  );

const until = <A, R>(check: Effect.Effect<A, never, R>, done: (value: A) => boolean) =>
  check.pipe(Effect.repeat({ until: done, schedule: Schedule.spaced("100 millis"), times: 50 }));

const exists = (target: string) =>
  FileSystem.FileSystem.use((fs) => fs.exists(target)).pipe(Effect.orDie);

describe.skipIf(!hasFfmpeg)("stream readers", () => {
  layer(subject({}), { excludeTestServices: true, timeout: "120 seconds" })((it) => {
    it.effect(
      "stopping a stream stops its encoder and frees its slot while one of its reads cannot be interrupted",
      () =>
        Effect.gen(function* () {
          const sessions = yield* StreamSessions.Service;
          const server = yield* MediaTestServer.Service;
          const who = yield* viewer;

          stallNextFirstRunOpen();

          const started = yield* start(who);
          const streamFolder = `${server.transcodeDir}/${started.streamId}`;

          yield* Effect.promise(() => opens.reached.promise);

          const stopsBefore = encoders.stopsBegun;

          yield* sessions.stop(started.streamId, who.grant).pipe(Effect.timeout("10 seconds"));

          const stopped = yield* until(
            Effect.sync(() => encoders.stopsBegun - stopsBefore),
            (count) => count > 0,
          );

          assert.strictEqual(stopped, 1, "the encoder's stop began while the read is held");
          assert.strictEqual(
            yield* until(
              Effect.sync(() => encoders.live),
              (live) => live === 0,
            ),
            0,
            "the encoder exited while the read is held",
          );

          const other = yield* viewer;
          const after = yield* start(other).pipe(Effect.timeout("15 seconds"));

          yield* sessions.stop(after.streamId, other.grant);

          assert.isTrue(yield* exists(streamFolder), "the stream's folder outlives the held read");

          yield* releaseOpens;

          assert.isFalse(
            yield* until(exists(streamFolder), (present) => !present),
            "the stream's folder goes once the read ends",
          );
        }).pipe(Effect.ensuring(releaseOpens)),
      60_000,
    );
  });
});
