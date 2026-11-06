import { assert, describe, layer } from "@effect/vitest";
import { Effect, Fiber, Layer, Option, Predicate, Redacted, Result } from "effect";

import { type ClientCapabilities } from "@media/contracts/media-playback";

import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as MediaTools from "../media/media-tools.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import { signTestToken } from "../testing/test-config.ts";
import { resolveInsideRoots } from "./file-resolver.ts";
import * as KeyframeIndex from "./keyframe-index.ts";
import { decidePlayback, PlaybackPlan } from "./playback-decision.ts";
import * as PlaybackToken from "./playback-token.ts";
import * as StreamOwners from "./stream-owners.ts";
import * as StreamSessions from "./stream-sessions.ts";
import * as TranscodeSpace from "./transcode-space.ts";

const hasFfmpeg = await ffmpegAvailable();

const pending = {
  armed: false,
  holding: Promise.withResolvers<void>(),
  held: Promise.withResolvers<void>(),
};

const holdNextStart = () => {
  pending.armed = true;
  pending.holding = Promise.withResolvers<void>();
  pending.held = Promise.withResolvers<void>();
};

const space = Layer.effect(
  TranscodeSpace.Service,
  Effect.map(TranscodeSpace.Service, (real) =>
    TranscodeSpace.Service.of({
      ...real,
      check: (bytes) =>
        Effect.suspend(() => {
          if (!pending.armed || bytes !== 0) return real.check(bytes);
          pending.armed = false;
          pending.holding.resolve();

          return Effect.promise(() => pending.held.promise).pipe(Effect.andThen(real.check(bytes)));
        }),
    }),
  ),
);

const encoders = {
  watching: false,
  started: 0,
  live: 0,
  peak: 0,
  holding: Promise.withResolvers<void>(),
  held: Promise.withResolvers<void>(),
  registered: 0,
  thirdRegistered: Promise.withResolvers<void>(),
};

const watchEncoders = () => {
  encoders.watching = true;
  encoders.started = 0;
  encoders.live = 0;
  encoders.peak = 0;
  encoders.holding = Promise.withResolvers<void>();
  encoders.held = Promise.withResolvers<void>();
  encoders.registered = 0;
  encoders.thirdRegistered = Promise.withResolvers<void>();
};

const owners = Layer.effect(
  StreamOwners.Service,
  Effect.map(StreamOwners.Service, (real) =>
    StreamOwners.Service.of({
      ...real,
      opened: (streamId, sessionId) =>
        real.opened(streamId, sessionId).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (!encoders.watching) return;
              encoders.registered += 1;

              if (encoders.registered === 3) encoders.thirdRegistered.resolve();
            }),
          ),
        ),
    }),
  ),
);

const tools = Layer.effect(
  MediaTools.Service,
  Effect.gen(function* () {
    const real = yield* MediaTools.Service;
    const monitorScope = yield* Effect.scope;

    return MediaTools.Service.of({
      ...real,
      startFfmpeg: (args) =>
        Effect.gen(function* () {
          const running = yield* real.startFfmpeg(args);

          if (!encoders.watching) return running;
          encoders.started += 1;
          encoders.live += 1;
          encoders.peak = Math.max(encoders.peak, encoders.live);

          // The fixture is short; a stopped encoder keeps running until its scope closes.
          yield* running.suspend(true);

          yield* running.exit.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                encoders.live -= 1;
              }),
            ),
            Effect.ignore,
            Effect.forkIn(monitorScope),
          );

          // Finalizers run last in, first out: this one runs before the process is killed.
          if (encoders.started === 1) {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => encoders.holding.resolve()).pipe(
                Effect.andThen(Effect.promise(() => encoders.held.promise)),
              ),
            );
          }

          return running;
        }),
    });
  }),
);

const subject = Layer.fresh(StreamSessions.layer).pipe(
  Layer.provideMerge(tools),
  Layer.provideMerge(owners),
  Layer.provideMerge(space),
  Layer.provideMerge(MediaTestServer.layer({ MAX_CONCURRENT_REMUXES: "1" })),
);

const capabilities: ClientCapabilities = {
  containers: [],
  videoCodecs: [{ codec: "h264" }],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 1920,
  maxHeight: 1080,
  hls: true,
  mse: true,
};

const setup = Effect.gen(function* () {
  const server = yield* MediaTestServer.Service;
  const { library } = yield* FixtureWorkspace.Service;

  const token = signTestToken({
    fid: server.fileId("movies", library.directMovie),
    sid: crypto.randomUUID(),
  });

  const grant = yield* (yield* PlaybackToken.Service).verify(
    Redacted.make(token),
    PlaybackToken.PLAY,
  );

  const file = yield* resolveInsideRoots(grant.fileId, { sidecars: true });

  const plan = decidePlayback(file.probe, capabilities, {
    audioIndex: undefined,
    hardware: undefined,
    softwareToneMapping: false,
  });

  if (!PlaybackPlan.$is("Hls")(plan)) return yield* Effect.die("expected HLS");
  const keyframes = yield* (yield* KeyframeIndex.Service).keyframes(file);

  return {
    grant,
    request: {
      file,
      plan,
      client: capabilities,
      audioIndex: undefined,
      startSeconds: 0,
      quality: undefined,
      burnSubtitle: undefined,
      keyframes,
    },
  };
});

const stillWaiting = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Fiber.await(fiber).pipe(Effect.timeoutOption("1 second"), Effect.map(Option.isNone));

describe.skipIf(!hasFfmpeg)("slot credit", () => {
  layer(subject, { excludeTestServices: true, timeout: "120 seconds" })((it) => {
    it.effect(
      "credits an older start's slot to a newer one of the session, and to no other session",
      () =>
        Effect.gen(function* () {
          const sessions = yield* StreamSessions.Service;
          const { grant, request } = yield* setup;
          const other = yield* setup;

          const start = (as: PlaybackToken.PlaybackGrant) =>
            Effect.gen(function* () {
              const negotiation = yield* sessions.negotiate(as);

              return yield* negotiation.start(request);
            }).pipe(Effect.scoped, Effect.result);

          holdNextStart();
          const older = yield* Effect.forkChild(start(grant));
          yield* Effect.promise(() => pending.holding.promise);

          const newer = yield* start(grant);

          assert.isTrue(Result.isSuccess(newer), "the older start's slot does not count");

          if (Result.isFailure(newer)) return;

          assert.strictEqual(yield* sessions.activeCount, 1);

          const full = yield* start(other.grant);

          assert.isTrue(
            Result.isFailure(full) && Predicate.isTagged(full.failure, "TranscodeCapacityReached"),
          );

          pending.held.resolve();
          const stale = yield* Fiber.join(older);

          assert.isTrue(
            Result.isFailure(stale) && Predicate.isTagged(stale.failure, "StreamNotFound"),
          );

          yield* sessions.playlist(newer.success.streamId, newer.success.generation, grant);

          assert.strictEqual(yield* sessions.activeCount, 1);
          assert.isTrue(
            Result.isFailure(yield* start(other.grant)),
            "the newer one keeps its slot",
          );

          yield* sessions.stop(newer.success.streamId, grant);
          const free = yield* start(other.grant);

          assert.isTrue(Result.isSuccess(free), "stopping frees the last slot");

          if (Result.isSuccess(free)) yield* sessions.stop(free.success.streamId, other.grant);
        }).pipe(Effect.ensuring(Effect.sync(() => pending.held.resolve()))),
      60_000,
    );

    it.effect(
      "starts no encoder while one its slot credits is still stopping",
      () =>
        Effect.gen(function* () {
          const sessions = yield* StreamSessions.Service;
          const { grant, request } = yield* setup;

          const start = Effect.gen(function* () {
            const negotiation = yield* sessions.negotiate(grant);

            return yield* negotiation.start(request);
          }).pipe(Effect.scoped, Effect.result);

          watchEncoders();

          const first = yield* start;

          assert.isTrue(Result.isSuccess(first));

          const second = yield* Effect.forkChild(start);
          yield* Effect.promise(() => encoders.holding.promise);

          const third = yield* Effect.forkChild(start);
          yield* Effect.promise(() => encoders.thirdRegistered.promise);

          yield* Fiber.await(third).pipe(Effect.timeoutOption("1 second"));
          const whileStopping = encoders.peak;

          encoders.held.resolve();
          const newest = yield* Fiber.join(third);

          yield* Fiber.join(second);

          assert.strictEqual(whileStopping, 1, "MAX_CONCURRENT_REMUXES=1 bounds running encoders");
          assert.isTrue(Result.isSuccess(newest), "the newest starts once the first stopped");

          if (Result.isSuccess(newest)) yield* sessions.stop(newest.success.streamId, grant);

          assert.strictEqual(encoders.peak, 1);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              encoders.held.resolve();
              encoders.watching = false;
            }),
          ),
        ),
      60_000,
    );

    it.effect(
      "a guest stream waits behind a household one and starts once it stops",
      () =>
        Effect.gen(function* () {
          const sessions = yield* StreamSessions.Service;
          const { grant, request } = yield* setup;
          const guest = { ...(yield* setup).grant, audience: "guest" as const };

          const start = (as: PlaybackToken.PlaybackGrant) =>
            Effect.gen(function* () {
              const negotiation = yield* sessions.negotiate(as);

              return yield* negotiation.start(request);
            }).pipe(Effect.scoped);

          const household = yield* start(grant);
          const waiting = yield* Effect.forkChild(start(guest));

          assert.isTrue(yield* stillWaiting(waiting), "MAX_CONCURRENT_REMUXES=1 is taken");

          yield* sessions.stop(household.streamId, grant);
          const started = yield* Fiber.join(waiting);

          assert.strictEqual(yield* sessions.activeCount, 1);

          yield* sessions.stop(started.streamId, guest);
        }),
      60_000,
    );

    it.effect(
      "a household stream takes a guest's slot, and the guest resumes once it stops",
      () =>
        Effect.gen(function* () {
          const sessions = yield* StreamSessions.Service;
          const { grant, request } = yield* setup;
          const guest = { ...(yield* setup).grant, audience: "guest" as const };

          const start = (as: PlaybackToken.PlaybackGrant) =>
            Effect.gen(function* () {
              const negotiation = yield* sessions.negotiate(as);

              return yield* negotiation.start(request);
            }).pipe(Effect.scoped);

          const playing = yield* start(guest);
          const { streamId, generation, segmentIndex } = playing;
          yield* sessions.segment(streamId, generation, segmentIndex, guest);

          const household = yield* start(grant);

          assert.strictEqual(yield* sessions.activeCount, 1, "the guest's encoder stopped");
          yield* sessions.playlist(streamId, generation, guest);

          const next = yield* Effect.forkChild(
            sessions.segment(streamId, generation, segmentIndex, guest),
          );

          assert.isTrue(yield* stillWaiting(next), "the guest waits for the slot");

          yield* sessions.stop(household.streamId, grant);
          const served = yield* Fiber.join(next);

          assert.isAbove(served.paths.length, 0);
          assert.strictEqual(yield* sessions.activeCount, 1);

          yield* sessions.stop(streamId, guest);
        }),
      60_000,
    );
  });
});
