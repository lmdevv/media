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

import { writeFakeFfmpeg } from "../testing/fake-ffmpeg.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import { signTestToken } from "../testing/test-tokens.ts";
import { resolveInsideRoots } from "./file-resolver.ts";
import { decidePlayback, PlaybackPlan } from "./playback-decision.ts";
import * as PlaybackToken from "./playback-token.ts";
import * as StreamSessions from "./stream-sessions.ts";
import * as TranscodeSpace from "./transcode-space.ts";

const hasFfmpeg = await ffmpegAvailable();

const stallsAfterFirstFragment = await writeFakeFfmpeg({ hlsStallsAfterFragments: 1 });

const FIRST_FRAGMENT = /\/f0\.m4s$/u;

const opens = {
  armed: false,
  reached: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
};

const stallNextFirstFragmentOpen = () => {
  opens.armed = true;
  opens.reached = Promise.withResolvers<void>();
  opens.release = Promise.withResolvers<void>();
};

const checks = {
  armed: false,
  reached: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
};

const stallNextSpaceCheck = () => {
  checks.armed = true;
  checks.reached = Promise.withResolvers<void>();
  checks.release = Promise.withResolvers<void>();
};

const releaseStalls = Effect.sync(() => {
  opens.armed = false;
  opens.release.resolve();
  checks.armed = false;
  checks.release.resolve();
});

const stalledOpens = Layer.effect(
  FileSystem.FileSystem,
  Effect.map(FileSystem.FileSystem, (real) =>
    FileSystem.FileSystem.of({
      ...real,
      open: (file, options) =>
        opens.armed && FIRST_FRAGMENT.test(file)
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

const stalledChecks = Layer.effect(
  TranscodeSpace.Service,
  Effect.map(TranscodeSpace.Service, (real) =>
    TranscodeSpace.Service.of({
      ...real,
      check: (bytes) =>
        checks.armed
          ? Effect.suspend(() => {
              checks.armed = false;
              checks.reached.resolve();

              return Effect.promise(() => checks.release.promise);
            }).pipe(Effect.andThen(real.check(bytes)))
          : real.check(bytes),
    }),
  ),
);

const subject = Layer.fresh(StreamSessions.layer).pipe(
  Layer.provideMerge(stalledChecks),
  Layer.provide(stalledOpens),
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

const failsWith = <A, E>(exit: Exit.Exit<A, E>, tag: string): boolean =>
  Exit.isFailure(exit) && Option.exists(Cause.findErrorOption(exit.cause), Predicate.isTagged(tag));

describe.skipIf(!hasFfmpeg)("stream request bounds", () => {
  layer(subject, { excludeTestServices: true, timeout: "120 seconds" })((it) => {
    it.effect(
      "a segment request answers within its bound while opening a fragment cannot be interrupted",
      () =>
        Effect.gen(function* () {
          const sessions = yield* StreamSessions.Service;
          const server = yield* MediaTestServer.Service;
          const fs = yield* FileSystem.FileSystem;
          const who = yield* viewer;

          stallNextFirstFragmentOpen();

          const started = yield* start(who);

          const requested = yield* Effect.forkChild(
            sessions
              .segment(started.streamId, started.generation, started.segmentIndex, who.grant)
              .pipe(Effect.scoped, Effect.exit),
          );

          yield* Effect.promise(() => opens.reached.promise);

          const answered = yield* Fiber.join(requested).pipe(Effect.timeout("35 seconds"));

          assert.isTrue(
            failsWith(answered, "SegmentNotReady"),
            `the request answers not ready: ${String(answered)}`,
          );

          yield* releaseStalls;
          yield* sessions
            .segment(started.streamId, started.generation, started.segmentIndex, who.grant)
            .pipe(Effect.scoped, Effect.timeout("15 seconds"));
          yield* sessions.stop(started.streamId, who.grant);

          const gone = yield* fs.exists(`${server.transcodeDir}/${started.streamId}`).pipe(
            Effect.orDie,
            Effect.repeat({
              until: (exists) => !exists,
              schedule: Schedule.spaced("100 millis"),
              times: 50,
            }),
            Effect.map((exists) => !exists),
          );

          assert.isTrue(gone, "the stream's teardown finished");
        }).pipe(Effect.ensuring(releaseStalls)),
      90_000,
    );

    it.effect(
      "a start held in its disk check holds no slot, so another household start plays",
      () =>
        Effect.gen(function* () {
          const sessions = yield* StreamSessions.Service;
          const held = yield* viewer;
          const other = yield* viewer;

          stallNextSpaceCheck();

          const holding = yield* Effect.forkChild(start(held).pipe(Effect.exit));

          yield* Effect.promise(() => checks.reached.promise);

          const playing = yield* start(other).pipe(Effect.timeout("15 seconds"));

          yield* sessions
            .segment(playing.streamId, playing.generation, playing.segmentIndex, other.grant)
            .pipe(Effect.scoped);
          yield* sessions.stop(playing.streamId, other.grant);
          yield* releaseStalls;

          const resumed = yield* Fiber.join(holding).pipe(Effect.timeout("15 seconds"));

          assert.isTrue(Exit.isSuccess(resumed), `the held start goes on: ${String(resumed)}`);

          if (Exit.isSuccess(resumed)) yield* sessions.stop(resumed.value.streamId, held.grant);
        }).pipe(Effect.ensuring(releaseStalls)),
      60_000,
    );
  });
});
