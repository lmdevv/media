import { assert, describe, layer } from "@effect/vitest";
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Redacted,
  Schedule,
} from "effect";

import type { ClientCapabilities } from "@media/contracts/media-playback";

import * as MediaTools from "../media/media-tools.ts";
import { writeFakeFfmpeg } from "../testing/fake-ffmpeg.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import { signTestToken } from "../testing/test-config.ts";
import { resolveInsideRoots } from "./file-resolver.ts";
import { segmentAt } from "./hls-plan.ts";
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

const KEPT_INIT = /init-\d+\.mp4\.tmp$/u;

const copies = {
  armed: false,
  reached: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
};

const holdNextInitCopy = () => {
  copies.armed = true;
  copies.reached = Promise.withResolvers<void>();
  copies.release = Promise.withResolvers<void>();
};

const releaseHolds = Effect.sync(() => {
  exits.armed = false;
  exits.release.resolve();
  copies.armed = false;
  copies.release.resolve();
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

const heldInitCopies = Layer.effect(
  FileSystem.FileSystem,
  Effect.map(FileSystem.FileSystem, (real) =>
    FileSystem.FileSystem.of({
      ...real,
      writeFile: (to, bytes, options) =>
        copies.armed && KEPT_INIT.test(to)
          ? Effect.suspend(() => {
              copies.armed = false;
              copies.reached.resolve();

              return Effect.promise(() => copies.release.promise);
            }).pipe(Effect.andThen(real.writeFile(to, bytes, options)))
          : real.writeFile(to, bytes, options),
    }),
  ),
);

const subject = () =>
  Layer.fresh(StreamSessions.layer).pipe(
    Layer.provideMerge(tools),
    Layer.provide(heldInitCopies),
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
      "a household stream starts in bounded time while the guest it displaced cannot keep its init",
      () =>
        Effect.gen(function* () {
          const sessions = yield* StreamSessions.Service;
          const guest = yield* viewer("guest");
          const household = yield* viewer("household");
          const kept = yield* playing(guest);

          holdNextInitCopy();
          const taking = yield* Effect.forkChild(start(household));
          yield* Effect.promise(() => copies.reached.promise);

          const taken = yield* Fiber.join(taking).pipe(Effect.timeout("15 seconds"));

          yield* sessions.stop(kept.streamId, guest.grant).pipe(Effect.timeout("10 seconds"));
          yield* sessions.stop(taken.streamId, household.grant);
        }).pipe(Effect.ensuring(releaseHolds)),
      60_000,
    );
  });

  layer(subject(), { excludeTestServices: true, timeout: "120 seconds" })((it) => {
    it.effect(
      "stopping ends in bounded time while an encoder's exit is unconfirmed, and its slot stays taken until then",
      () =>
        Effect.gen(function* () {
          const sessions = yield* StreamSessions.Service;
          const guest = yield* viewer("guest");
          const stopped = yield* playing(guest);

          yield* watchEncoders;
          holdNextExit();
          yield* sessions.stop(stopped.streamId, guest.grant).pipe(Effect.timeout("10 seconds"));

          const refused = yield* start(yield* viewer("household")).pipe(
            Effect.timeout("20 seconds"),
            Effect.exit,
          );

          assert.isTrue(
            failsWith(refused, "TranscodeCapacityReached"),
            `a household stream finds the slot still taken: ${String(refused)}`,
          );

          yield* releaseHolds;

          const household = yield* viewer("household");
          const after = yield* start(household).pipe(Effect.timeout("10 seconds"));

          assert.isAtMost(encoders.peak, 1, "encoders running at once");
          yield* sessions.stop(after.streamId, household.grant);
        }).pipe(Effect.ensuring(releaseHolds)),
      60_000,
    );

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

  for (const audience of ["household", "guest"] as const) {
    layer(subject(), { excludeTestServices: true, timeout: "120 seconds" })((it) => {
      it.effect(
        `a ${audience} seek whose request is interrupted while the previous encoder stops still moves the stream and strands no place`,
        () =>
          Effect.gen(function* () {
            const sessions = yield* StreamSessions.Service;
            const who = yield* viewer(audience);
            const started = yield* playing(who);

            const before = encoders.started;

            holdNextExit();
            const seeking = yield* Effect.forkChild(sessions.seek(started.streamId, 6, who.grant));

            yield* Effect.promise(() => exits.reached.promise);
            yield* Fiber.interrupt(seeking);
            yield* releaseHolds;

            const moved = yield* sessions.seek(started.streamId, 6, who.grant);
            const index = segmentAt(moved.plan, who.request.file.probe.startSeconds + 6);

            assert.isAbove(moved.generation, started.generation, "the seek moved the stream");

            yield* sessions
              .segment(started.streamId, moved.generation, index, who.grant)
              .pipe(Effect.timeout("15 seconds"));

            assert.strictEqual(encoders.started - before, 1, "encoders started for both seeks");

            const household = yield* viewer("household");

            if (audience === "household") yield* sessions.stop(started.streamId, who.grant);
            const after = yield* start(household).pipe(Effect.timeout("15 seconds"));

            assert.isAtMost(encoders.peak, 1, "encoders running at once");
            yield* sessions.stop(after.streamId, household.grant);
            yield* sessions.stop(started.streamId, who.grant).pipe(Effect.ignore);
          }).pipe(Effect.ensuring(releaseHolds)),
        60_000,
      );
    });
  }

  for (const ending of ["stopped", "replaced"] as const) {
    layer(subject(), { excludeTestServices: true, timeout: "120 seconds" })((it) => {
      it.effect(
        `a stream ${ending} while its previous encoder's exit is unconfirmed keeps that run's files until it exits`,
        () =>
          Effect.gen(function* () {
            const sessions = yield* StreamSessions.Service;
            const server = yield* MediaTestServer.Service;
            const fs = yield* FileSystem.FileSystem;
            const who = yield* viewer("household");
            const started = yield* playing(who);
            const streamFolder = `${server.transcodeDir}/${started.streamId}`;
            const firstRun = `${streamFolder}/1`;

            holdNextExit();

            const seeking = yield* Effect.forkChild(
              sessions.seek(started.streamId, 8, who.grant).pipe(Effect.exit),
            );

            yield* Effect.promise(() => exits.reached.promise);

            const replacing =
              ending === "stopped"
                ? yield* sessions
                    .stop(started.streamId, who.grant)
                    .pipe(Effect.timeout("10 seconds"), Effect.as(Option.none()))
                : Option.some(yield* Effect.forkChild(start(who).pipe(Effect.exit)));

            const removedEarly = yield* fs.exists(firstRun).pipe(
              Effect.orDie,
              Effect.repeat({
                until: (exists) => !exists,
                schedule: Schedule.spaced("100 millis"),
                times: 40,
              }),
              Effect.map((exists) => !exists),
            );

            assert.isFalse(removedEarly, "the stopping run's folder outlives its unconfirmed exit");

            yield* releaseHolds;
            yield* Fiber.join(seeking).pipe(Effect.timeout("15 seconds"));

            const gone = yield* fs.exists(streamFolder).pipe(
              Effect.orDie,
              Effect.repeat({
                until: (exists) => !exists,
                schedule: Schedule.spaced("100 millis"),
                times: 100,
              }),
              Effect.map((exists) => !exists),
            );

            assert.isTrue(gone, "the stream's folder is removed once every run stopped");

            if (Option.isSome(replacing)) {
              const next = yield* Fiber.join(replacing.value).pipe(Effect.timeout("15 seconds"));

              if (Exit.isSuccess(next)) yield* sessions.stop(next.value.streamId, who.grant);
            }
          }).pipe(Effect.ensuring(releaseHolds)),
        60_000,
      );
    });
  }
});
