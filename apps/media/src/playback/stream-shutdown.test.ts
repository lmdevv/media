import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import {
  Clock,
  Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Schedule,
  Scope,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import type { ClientCapabilities } from "@media/contracts/media-playback";

import * as MediaTools from "../media/media-tools.ts";
import { writeFakeFfmpeg } from "../testing/fake-ffmpeg.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import { signTestToken } from "../testing/test-config.ts";
import { resolveInsideRoots } from "./file-resolver.ts";
import { decidePlayback, PlaybackPlan } from "./playback-decision.ts";
import * as PlaybackReporter from "./playback-reporter.ts";
import * as PlaybackToken from "./playback-token.ts";
import * as StreamSessions from "./stream-sessions.ts";

const hasFfmpeg = await ffmpegAvailable();

const stallsAfterFirstFragment = await writeFakeFfmpeg({ hlsStallsAfterFragments: 1 });

const STREAMS = 3;

const STOP_WAIT_MS = 3000;

const exits = { held: false, release: Promise.withResolvers<void>() };

const holdExits = Effect.sync(() => {
  exits.held = true;
  exits.release = Promise.withResolvers<void>();
});

const releaseExits = Effect.sync(() => {
  exits.held = false;
  exits.release.resolve();
});

const tools = Layer.effect(
  MediaTools.Service,
  Effect.map(MediaTools.Service, (real) =>
    MediaTools.Service.of({
      ...real,
      startFfmpeg: (args) =>
        Effect.gen(function* () {
          const gate = { held: Option.none<Promise<void>>() };

          // Finalizers run last in, first out: this one runs after the process is killed.
          yield* Effect.addFinalizer(() =>
            Option.match(gate.held, {
              onNone: () => Effect.void,
              onSome: (held) => Effect.promise(() => held),
            }),
          );

          const running = yield* real.startFfmpeg(args);

          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              if (exits.held) gate.held = Option.some(exits.release.promise);
            }),
          );

          return running;
        }),
    }),
  ),
);

const subject = tools.pipe(
  Layer.provideMerge(
    MediaTestServer.layer({
      FFMPEG_PATH: stallsAfterFirstFragment,
      MAX_CONCURRENT_TRANSCODES: String(STREAMS),
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

const playing = (sessions: StreamSessions.Interface, { grant, request }: Viewer) =>
  sessions.negotiate(grant).pipe(
    Effect.flatMap((negotiation) => negotiation.start(request)),
    Effect.scoped,
    Effect.tap((started) =>
      sessions
        .segment(started.streamId, started.generation, started.segmentIndex, grant)
        .pipe(Effect.scoped),
    ),
  );

const freshSessions = (scope: Scope.Scope) =>
  Layer.buildWithScope(Layer.fresh(StreamSessions.layer), scope).pipe(
    Effect.map((built) => Context.get(built, StreamSessions.Service)),
  );

describe.skipIf(!hasFfmpeg)("stream shutdown", () => {
  layer(subject, { excludeTestServices: true, timeout: "120 seconds" })((it) => {
    it.effect(
      "a stopped stream's run counts as awaiting exit until its encoder exits",
      () =>
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          const sessions = yield* freshSessions(scope);
          const who = yield* viewer;
          const started = yield* playing(sessions, who);

          yield* holdExits;
          yield* sessions.stop(started.streamId, who.grant).pipe(Effect.timeout("10 seconds"));

          assert.strictEqual(
            yield* sessions.runsAwaitingExit,
            1,
            "the stopped stream's run while its exit is unconfirmed",
          );

          yield* releaseExits;

          const left = yield* sessions.runsAwaitingExit.pipe(
            Effect.repeat({
              until: (count) => count === 0,
              schedule: Schedule.spaced("100 millis"),
              times: 50,
            }),
          );

          assert.strictEqual(left, 0, "runs awaiting exit once the encoder exited");
          yield* Scope.close(scope, Exit.void);
        }).pipe(Effect.ensuring(releaseExits)),
      60_000,
    );

    it.effect(
      "a seek does not wait for a response its previous run is still sending",
      () =>
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          const sessions = yield* freshSessions(scope);
          const who = yield* viewer;
          const started = yield* playing(sessions, who);
          const response = yield* Scope.make();

          yield* sessions
            .segment(started.streamId, started.generation, started.segmentIndex, who.grant)
            .pipe(Scope.provide(response));

          const began = yield* Clock.currentTimeMillis;
          const moved = yield* sessions.seek(started.streamId, 8, who.grant);
          const elapsed = (yield* Clock.currentTimeMillis) - began;

          assert.isAbove(moved.generation, started.generation, "the seek started a new run");
          assert.isBelow(elapsed, STOP_WAIT_MS, `the seek took ${String(elapsed)} ms`);
          assert.strictEqual(
            yield* sessions.runsAwaitingExit.pipe(
              Effect.repeat({
                until: (count) => count === 1,
                schedule: Schedule.spaced("100 millis"),
                times: 50,
              }),
            ),
            1,
            "runs awaiting exit once the previous encoder exited, its response still open",
          );

          yield* Scope.close(response, Exit.void);
          yield* Scope.close(scope, Exit.void);
        }),
      60_000,
    );

    it.effect(
      "shutting down closes every stream within one stop's bound while their encoders' exits are unconfirmed",
      () =>
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          const sessions = yield* freshSessions(scope);

          for (let stream = 0; stream < STREAMS; stream += 1) {
            yield* playing(sessions, yield* viewer);
          }

          yield* holdExits;

          const began = yield* Clock.currentTimeMillis;
          yield* Scope.close(scope, Exit.void).pipe(Effect.timeout("30 seconds"));
          const elapsed = (yield* Clock.currentTimeMillis) - began;

          assert.isBelow(elapsed, 2 * STOP_WAIT_MS, `shutdown took ${String(elapsed)} ms`);
        }).pipe(Effect.ensuring(releaseExits)),
      60_000,
    );
  });
});

describe.skipIf(!hasFfmpeg)("service shutdown", () => {
  layer(NodeServices.layer, { excludeTestServices: true, timeout: "60 seconds" })((it) => {
    it.effect(
      "closes every stream and deletes its output",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const transcodeDir = yield* fs.makeTempDirectoryScoped({ prefix: "movies-shutdown-" });
          const scope = yield* Scope.make();

          const context = yield* Layer.buildWithScope(
            MediaTestServer.layer({ TRANSCODE_DIR: transcodeDir }),
            scope,
          );

          const server = Context.get(context, MediaTestServer.Service);
          const recording = Context.get(context, PlaybackReporter.Recording);
          const { library } = Context.get(context, FixtureWorkspace.Service);
          const client = Context.get(context, HttpClient.HttpClient);
          const fileId = server.fileId("movies", library.remuxMovie);

          const response = yield* client.execute(
            HttpClientRequest.post(`${server.baseUrl}/api/playback/negotiate`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                token: signTestToken({ fid: fileId, sid: "shutdown" }),
                capabilities: {
                  containers: ["mp4"],
                  videoCodecs: [{ codec: "h264" }],
                  audioCodecs: [{ codec: "aac" }],
                  maxWidth: 1920,
                  maxHeight: 1080,
                  hls: true,
                  mse: true,
                },
              }),
            ),
          );

          assert.strictEqual(response.status, 200);
          assert.strictEqual((yield* fs.readDirectory(transcodeDir)).length, 1);

          yield* Scope.close(scope, Exit.void);

          assert.deepStrictEqual(yield* fs.readDirectory(transcodeDir), []);
          const events = yield* recording.events;

          assert.isTrue(
            events.some(
              (event) =>
                PlaybackReporter.PlaybackEvent.guards.StreamEnded(event) &&
                event.reason === "shutdown",
            ),
          );
        }),
      60_000,
    );
  });
});
