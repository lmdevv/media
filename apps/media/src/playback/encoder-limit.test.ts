import { assert, describe, layer } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Layer, Option, Predicate, Redacted } from "effect";

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

const encoders = { started: 0, live: 0, peak: 0 };

const exits = {
  armed: false,
  reached: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
};

const holdNextExit = () => {
  exits.armed = true;
  exits.reached = Promise.withResolvers<void>();
  exits.release = Promise.withResolvers<void>();
};

const releaseHolds = Effect.sync(() => {
  exits.armed = false;
  exits.release.resolve();
});

const tools = Layer.effect(
  MediaTools.Service,
  Effect.map(MediaTools.Service, (real) =>
    MediaTools.Service.of({
      ...real,
      startFfmpeg: (args) =>
        Effect.gen(function* () {
          encoders.started += 1;

          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              encoders.live -= 1;
            }),
          );

          const held = { gate: Option.none<Promise<void>>() };

          yield* Effect.addFinalizer(() =>
            Option.match(held.gate, {
              onNone: () => Effect.void,
              onSome: (gate) =>
                Effect.sync(() => exits.reached.resolve()).pipe(
                  Effect.andThen(Effect.promise(() => gate)),
                ),
            }),
          );

          const running = yield* real.startFfmpeg(args);
          encoders.live += 1;
          encoders.peak = Math.max(encoders.peak, encoders.live);

          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              if (!exits.armed) return;
              exits.armed = false;
              held.gate = Option.some(exits.release.promise);
            }),
          );

          return running;
        }),
    }),
  ),
);

const subject = () =>
  Layer.fresh(StreamSessions.layer).pipe(
    Layer.provideMerge(tools),
    Layer.provideMerge(
      MediaTestServer.layer({
        FFMPEG_PATH: stallsAfterFirstFragment,
        MAX_CONCURRENT_TRANSCODES: "1",
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

const viewer = (audience: PlaybackToken.PlaybackGrant["audience"]) =>
  Effect.gen(function* () {
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
      grant: { ...verified, audience },
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

type Viewer = Effect.Success<ReturnType<typeof viewer>>;

const start = ({ grant, request }: Viewer) =>
  StreamSessions.Service.use((sessions) =>
    sessions.negotiate(grant).pipe(
      Effect.flatMap((negotiation) => negotiation.start(request)),
      Effect.scoped,
    ),
  );

const playing = (who: Viewer) =>
  Effect.gen(function* () {
    const sessions = yield* StreamSessions.Service;
    const started = yield* start(who);

    yield* sessions.segment(started.streamId, started.generation, started.segmentIndex, who.grant);

    return started;
  });

const failsWith = <A, E>(exit: Exit.Exit<A, E>, tag: string): boolean =>
  Exit.isFailure(exit) && Option.exists(Cause.findErrorOption(exit.cause), Predicate.isTagged(tag));

const watchEncoders = Effect.sync(() => {
  encoders.peak = encoders.live;
});

describe.skipIf(!hasFfmpeg)("transcode limit", () => {
  layer(subject(), { excludeTestServices: true, timeout: "120 seconds" })((it) => {
    for (const audience of ["household", "guest"] as const) {
      it.effect(
        `a ${audience} stream's seek past what is produced never runs more encoders than the limit`,
        () =>
          Effect.gen(function* () {
            const sessions = yield* StreamSessions.Service;
            const who = yield* viewer(audience);
            const started = yield* playing(who);

            yield* watchEncoders;

            const moved = yield* sessions
              .seek(started.streamId, 8, who.grant)
              .pipe(
                Effect.ensuring(sessions.stop(started.streamId, who.grant).pipe(Effect.ignore)),
              );

            assert.isAbove(moved.generation, started.generation, "the seek started a new encoder");
            assert.isAtMost(encoders.peak, 1, "encoders running at once");
          }),
        60_000,
      );
    }
  });

  layer(subject(), { excludeTestServices: true, timeout: "120 seconds" })((it) => {
    it.effect(
      "a seek waiting for its slot starts no encoder once its stream stops",
      () =>
        Effect.gen(function* () {
          const sessions = yield* StreamSessions.Service;
          const who = yield* viewer("household");
          const started = yield* playing(who);
          const before = encoders.started;

          holdNextExit();

          const seeking = yield* Effect.forkChild(
            sessions.seek(started.streamId, 6, who.grant).pipe(Effect.exit),
          );

          yield* Effect.promise(() => exits.reached.promise);
          yield* sessions.stop(started.streamId, who.grant).pipe(Effect.timeout("10 seconds"));
          yield* releaseHolds;

          const sought = yield* Fiber.join(seeking).pipe(Effect.timeout("15 seconds"));

          assert.strictEqual(encoders.started - before, 0, "encoders started for the seek");
          assert.isTrue(
            failsWith(sought, "StreamNotFound"),
            `the seek finds its stream gone: ${String(sought)}`,
          );
        }).pipe(Effect.ensuring(releaseHolds)),
      60_000,
    );
  });
});
