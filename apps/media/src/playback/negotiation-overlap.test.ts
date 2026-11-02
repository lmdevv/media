import { assert, describe, layer } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { type ClientCapabilities, NegotiateResponse } from "@movies/contracts/media-playback";

import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import { signTestToken } from "../testing/test-config.ts";

const hasFfmpeg = await ffmpegAvailable();

const gate = {
  file: "",
  entered: Promise.withResolvers<void>(),
  released: Promise.withResolvers<void>(),
};

const arm = (file: string) => {
  gate.file = file;
  gate.entered = Promise.withResolvers<void>();
  gate.released = Promise.withResolvers<void>();
};

const holdingResolve = (real: FileSystem.FileSystem): FileSystem.FileSystem =>
  FileSystem.FileSystem.of({
    ...real,
    realPath: (path) =>
      Effect.suspend(() => {
        if (gate.file === "" || !path.endsWith(gate.file)) return real.realPath(path);
        gate.file = "";

        return Effect.sync(() => gate.entered.resolve()).pipe(
          Effect.andThen(Effect.promise(() => gate.released.promise)),
          Effect.andThen(real.realPath(path)),
        );
      }),
  });

const codecs = {
  videoCodecs: [{ codec: "h264" }],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 1920,
  maxHeight: 1080,
  hls: true,
  mse: true,
} as const;

const playsMp4: ClientCapabilities = { ...codecs, containers: ["mp4"] };

const needsHls: ClientCapabilities = { ...codecs, containers: [] };

const decodeNegotiation = Schema.decodeUnknownEffect(Schema.toCodecJson(NegotiateResponse));

const negotiate = Effect.fn(function* (token: string, capabilities: ClientCapabilities) {
  const server = yield* MediaTestServer.Service;

  const response = yield* HttpClient.execute(
    HttpClientRequest.post(`${server.baseUrl}/api/playback/negotiate`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ token, capabilities }),
    ),
  ).pipe(Effect.orDie);

  if (response.status !== 200) return { status: response.status, stream: undefined };

  const negotiated = yield* response.json.pipe(Effect.flatMap(decodeNegotiation), Effect.orDie);
  const playlist = negotiated.url.replace(/^https?:\/\/[^/]+/u, server.baseUrl);

  return {
    status: response.status,
    stream:
      negotiated.streamId === undefined
        ? undefined
        : { mode: negotiated.mode, streamId: negotiated.streamId, playlist },
  };
});

const playlistStatus = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.map((response) => response.status),
    Effect.orDie,
  );

const stop = Effect.fn(function* (token: string, streamId: string) {
  const server = yield* MediaTestServer.Service;

  yield* HttpClient.execute(
    HttpClientRequest.post(`${server.baseUrl}/api/playback/stop`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ token, streamId }),
    ),
  ).pipe(Effect.orDie);
});

const tokenFor = Effect.fn(function* (sid: string) {
  const server = yield* MediaTestServer.Service;
  const { library } = yield* FixtureWorkspace.Service;

  return {
    token: signTestToken({ fid: server.fileId("movies", library.directMovie), sid }),
    file: library.directMovie,
  };
});

describe.skipIf(!hasFfmpeg)("overlapping negotiations", () => {
  layer(MediaTestServer.layer({ MAX_CONCURRENT_REMUXES: "1" }, { fileSystem: holdingResolve }), {
    excludeTestServices: true,
    timeout: "120 seconds",
  })((it) => {
    it.effect(
      "leaves no stream or remux slot behind when a newer negotiation chose direct play",
      () =>
        Effect.gen(function* () {
          const { token, file } = yield* tokenFor(`older-hls-${crypto.randomUUID()}`);

          arm(file);
          const older = yield* Effect.forkChild(negotiate(token, needsHls));
          yield* Effect.promise(() => gate.entered.promise);

          const newer = yield* negotiate(token, playsMp4);

          assert.deepStrictEqual(newer, { status: 200, stream: undefined }, "plays direct");
          gate.released.resolve();

          const late = yield* Fiber.join(older);

          if (late.stream !== undefined) {
            assert.strictEqual(yield* playlistStatus(late.stream.playlist), 404, "no orphan");
          }

          assert.strictEqual(late.status, 404, "the older negotiation was replaced meanwhile");

          const other = yield* tokenFor(`other-${crypto.randomUUID()}`);
          const next = yield* negotiate(other.token, needsHls);

          assert.strictEqual(next.status, 200, "the remux slot is free");

          if (next.stream !== undefined) yield* stop(other.token, next.stream.streamId);
        }),
      60_000,
    );
  });

  layer(MediaTestServer.layer({}, { fileSystem: holdingResolve }), {
    excludeTestServices: true,
    timeout: "120 seconds",
  })((it) => {
    it.effect(
      "keeps the newer negotiation's stream when an older one finishes with direct play",
      () =>
        Effect.gen(function* () {
          const { token, file } = yield* tokenFor(`older-direct-${crypto.randomUUID()}`);

          arm(file);
          const older = yield* Effect.forkChild(negotiate(token, playsMp4));
          yield* Effect.promise(() => gate.entered.promise);

          const newer = yield* negotiate(token, needsHls);
          const stream = newer.stream;

          assert.strictEqual(newer.status, 200);
          assert.isDefined(stream);
          gate.released.resolve();
          yield* Fiber.join(older);

          assert.strictEqual(yield* playlistStatus(stream.playlist), 200, "still served");
          yield* stop(token, stream.streamId);
        }),
      60_000,
    );
  });
});
