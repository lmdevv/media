import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Context, Effect, Exit, FileSystem, Layer, Scope } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import { signTestToken } from "../testing/test-config.ts";
import * as PlaybackReporter from "./playback-reporter.ts";

const hasFfmpeg = await ffmpegAvailable();

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
