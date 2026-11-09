import { assert, describe, layer } from "@effect/vitest";
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Option,
  Path,
  Predicate,
  Redacted,
  Schedule,
} from "effect";

import type { ClientCapabilities } from "@media/contracts/media-playback";

import { writeFakeFfmpeg } from "../testing/fake-ffmpeg.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import { signTestToken } from "../testing/test-config.ts";
import { resolveInsideRoots } from "./file-resolver.ts";
import type { HardwareEncoder } from "./hardware-acceleration.ts";
import { decidePlayback, PlaybackPlan } from "./playback-decision.ts";
import * as PlaybackToken from "./playback-token.ts";
import * as StreamSessions from "./stream-sessions.ts";

const hasFfmpeg = await ffmpegAvailable();

const stallsAfterFirstFragment = await writeFakeFfmpeg({
  hlsStallsAfterFragments: 1,
  qsvFailsFromSeconds: 1_000_000,
});

const failsOnCue = await writeFakeFfmpeg({ hlsStallsAfterFragments: 1, hlsStallsUntilCue: true });

const failsOnCueDuringMove = await writeFakeFfmpeg({
  hlsStallsAfterFragments: 1,
  hlsStallsUntilCue: true,
});

const RUN_FOLDER = /\/transcode\/[^/]+\/\d+$/u;

const folders = {
  armed: false,
  reached: Promise.withResolvers<void>(),
  fail: Promise.withResolvers<void>(),
};

const failNextRunFolderOnCue = () => {
  folders.armed = true;
  folders.reached = Promise.withResolvers<void>();
  folders.fail = Promise.withResolvers<void>();
};

const failingRunFolders = (real: FileSystem.FileSystem): FileSystem.FileSystem =>
  FileSystem.FileSystem.of({
    ...real,
    makeDirectory: (target, options) =>
      folders.armed && RUN_FOLDER.test(target)
        ? Effect.suspend(() => {
            folders.armed = false;
            folders.reached.resolve();

            return Effect.promise(() => folders.fail.promise).pipe(
              Effect.andThen(Effect.die(new Error("no space left on the transcode disk"))),
            );
          })
        : real.makeDirectory(target, options),
  });

const KEPT_INIT = /init-\d+\.mp4\.tmp$/u;

const copies = {
  armed: false,
  reached: Promise.withResolvers<void>(),
  resume: Promise.withResolvers<void>(),
};

const holdNextInitCopy = () => {
  copies.armed = true;
  copies.reached = Promise.withResolvers<void>();
  copies.resume = Promise.withResolvers<void>();
};

const heldInitCopies = (real: FileSystem.FileSystem): FileSystem.FileSystem =>
  FileSystem.FileSystem.of({
    ...real,
    writeFile: (to, bytes, options) =>
      copies.armed && KEPT_INIT.test(to)
        ? Effect.suspend(() => {
            copies.armed = false;
            copies.reached.resolve();

            return Effect.promise(() => copies.resume.promise);
          }).pipe(Effect.andThen(real.writeFile(to, bytes, options)))
        : real.writeFile(to, bytes, options),
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

const viewer = (audience: PlaybackToken.PlaybackGrant["audience"], hardware?: HardwareEncoder) =>
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
      hardware,
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

const firstFragmentWritten = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { transcodeDir } = yield* MediaTestServer.Service;
  const streams = yield* fs.readDirectory(transcodeDir);

  return yield* Effect.forEach(streams, (stream) =>
    fs.exists(path.join(transcodeDir, stream, "1", "f0.m4s")),
  );
}).pipe(
  Effect.filterOrFail(
    (written) => written.includes(true),
    () => "no fragment written yet",
  ),
  Effect.retry(Schedule.spaced("100 millis")),
  Effect.timeout("15 seconds"),
  Effect.orDie,
);

const server = MediaTestServer.layer(
  {
    FFMPEG_PATH: stallsAfterFirstFragment,
    MAX_CONCURRENT_TRANSCODES: "1",
    STREAM_IDLE_SECONDS: "1",
  },
  { fileSystem: heldInitCopies },
);

describe.skipIf(!hasFfmpeg)("stream displacement", () => {
  layer(server, { excludeTestServices: true, timeout: "120 seconds" })((it) => {
    it.effect(
      "a household stream starts while an idle release stops the guest it displaced",
      () =>
        Effect.gen(function* () {
          const sessions = yield* StreamSessions.Service;
          const guest = yield* viewer("guest");
          const household = yield* viewer("household");
          const playing = yield* start(guest);

          yield* sessions
            .segment(playing.streamId, playing.generation, playing.segmentIndex, guest.grant)
            .pipe(Effect.scoped);

          holdNextInitCopy();
          yield* Effect.promise(() => copies.reached.promise);

          const taking = yield* Effect.forkChild(start(household));
          yield* Effect.sleep("300 millis");
          copies.resume.resolve();

          const taken = yield* Fiber.join(taking).pipe(Effect.timeout("10 seconds"));

          yield* sessions.stop(taken.streamId, household.grant);
          yield* sessions.stop(playing.streamId, guest.grant);
        }).pipe(Effect.ensuring(Effect.sync(() => copies.resume.resolve()))),
      60_000,
    );
  });

  layer(server, { excludeTestServices: true, timeout: "120 seconds" })((it) => {
    it.effect(
      "a household stream takes a guest's slot without waiting out the guest's slow first segment",
      () =>
        Effect.gen(function* () {
          const sessions = yield* StreamSessions.Service;
          const guest = yield* viewer("guest", "qsv");
          const household = yield* viewer("household");

          assert.strictEqual(guest.request.plan.mode, "transcode-qsv");

          const starting = yield* Effect.forkChild(start(guest));
          yield* firstFragmentWritten;

          const taken = yield* start(household).pipe(Effect.timeout("8 seconds"));
          const kept = yield* Fiber.join(starting).pipe(Effect.timeout("8 seconds"));

          yield* sessions.playlist(kept.streamId, kept.generation, guest.grant);

          yield* sessions.stop(taken.streamId, household.grant);
          yield* sessions.stop(kept.streamId, guest.grant);
        }),
      60_000,
    );
  });

  layer(
    MediaTestServer.layer(
      { FFMPEG_PATH: failsOnCue, MAX_CONCURRENT_TRANSCODES: "1" },
      { fileSystem: heldInitCopies },
    ),
    { excludeTestServices: true, timeout: "120 seconds" },
  )((it) => {
    it.effect(
      "a guest's segment request answers not ready when its encoder fails while it is displaced",
      () =>
        Effect.gen(function* () {
          const sessions = yield* StreamSessions.Service;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const guest = yield* viewer("guest");
          const household = yield* viewer("household");
          const playing = yield* start(guest);
          const { streamId, generation, segmentIndex } = playing;
          const view = yield* sessions.playlist(streamId, generation, guest.grant);

          assert.isAbove(
            view.plan.starts.length,
            segmentIndex + 1,
            "the stream has a next segment",
          );

          yield* sessions
            .segment(streamId, generation, segmentIndex, guest.grant)
            .pipe(Effect.scoped);

          const waiting = yield* Effect.forkChild(
            sessions
              .segment(streamId, generation, segmentIndex + 1, guest.grant)
              .pipe(Effect.scoped, Effect.exit),
          );

          holdNextInitCopy();
          const taking = yield* Effect.forkChild(start(household));
          yield* Effect.promise(() => copies.reached.promise);
          yield* fs.writeFileString(path.join(path.dirname(failsOnCue), "cue"), "");
          yield* Effect.sleep("500 millis");
          copies.resume.resolve();

          const answered = yield* Fiber.join(waiting).pipe(Effect.timeout("10 seconds"));

          const failure = Exit.isFailure(answered)
            ? Cause.findErrorOption(answered.cause)
            : Option.none();

          assert.isTrue(
            Option.exists(failure, Predicate.isTagged("SegmentNotReady")),
            `the player retries the segment: ${String(answered)}`,
          );

          const taken = yield* Fiber.join(taking).pipe(Effect.timeout("10 seconds"));

          yield* sessions.stop(taken.streamId, household.grant);
          yield* sessions.stop(streamId, guest.grant);
        }).pipe(Effect.ensuring(Effect.sync(() => copies.resume.resolve()))),
      60_000,
    );
  });

  layer(
    MediaTestServer.layer(
      { FFMPEG_PATH: failsOnCueDuringMove, MAX_CONCURRENT_TRANSCODES: "2" },
      { fileSystem: failingRunFolders },
    ),
    { excludeTestServices: true, timeout: "120 seconds" },
  )((it) => {
    it.effect(
      "a household segment request answers not ready when its encoder fails while a move fails partway",
      () =>
        Effect.gen(function* () {
          const sessions = yield* StreamSessions.Service;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const household = yield* viewer("household");
          const { streamId, generation, segmentIndex } = yield* start(household);

          yield* sessions
            .segment(streamId, generation, segmentIndex, household.grant)
            .pipe(Effect.scoped);

          const waiting = yield* Effect.forkChild(
            sessions
              .segment(streamId, generation, segmentIndex + 1, household.grant)
              .pipe(Effect.scoped, Effect.exit),
          );

          yield* Effect.sleep("300 millis");
          failNextRunFolderOnCue();

          const seeking = yield* Effect.forkChild(
            sessions.seek(streamId, 6, household.grant).pipe(Effect.exit),
          );

          yield* Effect.promise(() => folders.reached.promise);
          yield* fs.writeFileString(path.join(path.dirname(failsOnCueDuringMove), "cue"), "");
          yield* Effect.sleep("500 millis");
          folders.fail.resolve();

          const answered = yield* Fiber.join(waiting).pipe(Effect.timeout("10 seconds"));

          const failure = Exit.isFailure(answered)
            ? Cause.findErrorOption(answered.cause)
            : Option.none();

          assert.isTrue(
            Option.exists(failure, Predicate.isTagged("SegmentNotReady")),
            `the player retries the segment: ${String(answered)}`,
          );

          yield* Fiber.join(seeking).pipe(Effect.timeout("10 seconds"));
          yield* sessions.stop(streamId, household.grant);
        }).pipe(Effect.ensuring(Effect.sync(() => folders.fail.resolve()))),
      60_000,
    );
  });
});
