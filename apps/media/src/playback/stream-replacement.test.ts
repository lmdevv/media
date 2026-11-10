import { assert, describe, layer } from "@effect/vitest";
import { Duration, Effect, Fiber, FileSystem, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { type ClientCapabilities, NegotiateResponse } from "@media/contracts/media-playback";

import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import { signTestToken } from "../testing/test-tokens.ts";
import * as PlaybackReporter from "./playback-reporter.ts";

const hasFfmpeg = await ffmpegAvailable();

const gate = {
  folder: "",
  entered: Promise.withResolvers<void>(),
  released: Promise.withResolvers<void>(),
};

const holdingRemoval = (real: FileSystem.FileSystem): FileSystem.FileSystem =>
  FileSystem.FileSystem.of({
    ...real,
    remove: (path, options) =>
      Effect.suspend(() =>
        gate.folder !== "" && path.endsWith(gate.folder)
          ? Effect.andThen(
              Effect.sync(() => gate.entered.resolve()),
              Effect.andThen(
                Effect.promise(() => gate.released.promise),
                real.remove(path, options),
              ),
            )
          : real.remove(path, options),
      ),
  });

const remuxing: ClientCapabilities = {
  containers: ["mp4"],
  videoCodecs: [{ codec: "h264" }],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 1920,
  maxHeight: 1080,
  hls: true,
  mse: true,
};

const decodeNegotiation = Schema.decodeUnknownEffect(Schema.toCodecJson(NegotiateResponse));

describe.skipIf(!hasFfmpeg)("stream replacement", () => {
  layer(MediaTestServer.layer({}, { fileSystem: holdingRemoval }), {
    excludeTestServices: true,
    timeout: "120 seconds",
  })((it) => {
    it.effect(
      "ends and reports the replaced stream when the replacing caller leaves midway",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;
          const recording = yield* PlaybackReporter.Recording;

          const token = signTestToken({
            fid: server.fileId("movies", library.remuxMovie),
            sid: "replaced-midway",
          });

          const negotiate = HttpClient.execute(
            HttpClientRequest.post(`${server.baseUrl}/api/playback/negotiate`).pipe(
              HttpClientRequest.bodyJsonUnsafe({ token, capabilities: remuxing }),
            ),
          ).pipe(Effect.orDie);

          const first = yield* negotiate;

          assert.strictEqual(first.status, 200);

          const replaced = (yield* decodeNegotiation(yield* first.json.pipe(Effect.orDie)).pipe(
            Effect.orDie,
          )).streamId;

          assert.isString(replaced);
          gate.folder = replaced ?? "";

          const second = yield* Effect.forkChild(negotiate);

          yield* Effect.promise(() => gate.entered.promise);
          yield* Fiber.interrupt(second);
          yield* Effect.sleep(Duration.millis(300));
          gate.released.resolve();

          const ended = yield* recording.events.pipe(
            Effect.map((events) =>
              events.filter(
                (event) =>
                  PlaybackReporter.PlaybackEvent.guards.StreamEnded(event) &&
                  event.streamId === replaced,
              ),
            ),
            Effect.filterOrFail((events) => events.length > 0),
            Effect.retry(Schedule.spaced("50 millis")),
            Effect.timeout(Duration.seconds(5)),
            Effect.orDie,
          );

          assert.deepInclude(ended[0], { reason: "replaced" });
        }),
      60_000,
    );
  });
});
