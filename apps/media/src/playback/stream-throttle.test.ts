import { assert, describe, layer } from "@effect/vitest";
import { Duration, Effect, Fiber, FileSystem, Path, Ref, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { LibraryId } from "@media/contracts/ids";
import { type ClientCapabilities, NegotiateResponse } from "@media/contracts/media-playback";

import * as LibraryScanner from "../library/library-scanner.ts";
import * as MemoryLibrary from "../library/memory-library.ts";
import * as MediaTools from "../media/media-tools.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import { signTestToken } from "../testing/test-config.ts";
import * as TestConvex from "../testing/test-convex.ts";

const hasFfmpeg = await ffmpegAvailable();

const LONG = LibraryId.make("long");

const LONG_FILE = "Long Fixture (2020)/Long Fixture (2020).mkv";

const LONG_SECONDS = 600;

const smallScreen: ClientCapabilities = {
  containers: [],
  videoCodecs: [{ codec: "h264", maxBitDepth: 8 }],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 1920,
  maxHeight: 90,
  hls: false,
  mse: true,
};

const decodeNegotiation = Schema.decodeUnknownEffect(Schema.toCodecJson(NegotiateResponse));

const addLongClip = Effect.gen(function* () {
  const workspace = yield* FixtureWorkspace.Service;
  const tools = yield* MediaTools.Service;
  const scanner = yield* LibraryScanner.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(workspace.root, "long");
  const output = path.join(root, LONG_FILE);

  yield* fs.makeDirectory(path.dirname(output), { recursive: true });

  yield* tools.ffmpeg([
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=320x180:rate=24:duration=${String(LONG_SECONDS)}`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "48",
    output,
  ]);

  yield* scanner.scan({ libraryId: LONG, root, mode: "incremental" });

  return MemoryLibrary.fileIdOf(LONG, LONG_FILE);
});

const writtenFragments = Effect.fn(function* (streamId: string) {
  const server = yield* MediaTestServer.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const names = yield* fs
    .readDirectory(path.join(server.transcodeDir, streamId, "1"))
    .pipe(Effect.orElseSucceed(() => []));

  return names.filter((name) => /^f\d+\.m4s$/.test(name)).length;
});

const negotiateLong = Effect.fn(function* (sid: string, fileId: string) {
  const server = yield* MediaTestServer.Service;
  const token = signTestToken({ fid: fileId, sid });

  const response = yield* HttpClient.execute(
    HttpClientRequest.post(`${server.baseUrl}/api/playback/negotiate`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ token, capabilities: smallScreen }),
    ),
  ).pipe(Effect.orDie);

  assert.strictEqual(response.status, 200, `negotiating ${sid}`);
  const negotiated = yield* response.json.pipe(Effect.flatMap(decodeNegotiation), Effect.orDie);
  const playlist = new URL(negotiated.url.replace(/^https?:\/\/[^/]+/u, server.baseUrl));

  return {
    token,
    mode: negotiated.mode,
    streamId: negotiated.streamId ?? "",
    file: (name: string) => new URL(`${name}${playlist.search}`, playlist).toString(),
  };
});

type LongStream = Effect.Success<ReturnType<typeof negotiateLong>>;

const fetched = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      response.arrayBuffer.pipe(
        Effect.map((body) => ({ status: response.status, body: new Uint8Array(body) })),
      ),
    ),
    Effect.orDie,
  );

const stop = Effect.fn(function* (stream: LongStream) {
  const server = yield* MediaTestServer.Service;

  const response = yield* HttpClient.execute(
    HttpClientRequest.post(`${server.baseUrl}/api/playback/stop`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ token: stream.token, streamId: stream.streamId }),
    ),
  ).pipe(Effect.orDie);

  assert.strictEqual(response.status, 204, `stopping ${stream.streamId}`);
});

const playing = Effect.fn(function* (sid: string) {
  const convex = yield* TestConvex.Service;
  const position = yield* Ref.make(0);

  yield* convex.report(sid, "playing", 0);

  return yield* Ref.updateAndGet(position, (ms) => ms + 300).pipe(
    Effect.flatMap((ms) => convex.report(sid, "playing", ms)),
    Effect.repeat(Schedule.spaced("300 millis")),
    Effect.forkChild,
  );
});

const logsOf = Effect.fn(function* (message: string, streamId: string) {
  const server = yield* MediaTestServer.Service;

  return server
    .logged()
    .filter((entry) => entry.message === message && entry.annotations["streamId"] === streamId);
});

const awaitLogged = (message: string, streamId: string) =>
  logsOf(message, streamId).pipe(
    Effect.filterOrFail((records) => records.length > 0),
    Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
    Effect.orDie,
  );

const awaitThrottled = (streamId: string) =>
  Effect.gen(function* () {
    const before = yield* writtenFragments(streamId);
    yield* Effect.sleep(Duration.seconds(2));
    const after = yield* writtenFragments(streamId);

    return before > 0 && after === before ? after : yield* Effect.fail("still writing");
  }).pipe(Effect.retry({ times: 15 }), Effect.orDie);

const segmentFrom = (playlist: string, seconds: number): number => {
  const durations = playlist
    .split("\n")
    .flatMap((line) => (line.startsWith("#EXTINF:") ? [Number.parseFloat(line.slice(8))] : []));

  let start = 0;

  for (const [index, duration] of durations.entries()) {
    if (start >= seconds) return index;
    start += duration;
  }

  return durations.length - 1;
};

describe.skipIf(!hasFfmpeg)("stream throttling", () => {
  layer(MediaTestServer.layer({ STREAM_BUFFER_AHEAD_SECONDS: "20" }), {
    excludeTestServices: true,
    timeout: "120 seconds",
  })((it) => {
    it.effect(
      "pauses ffmpeg ahead of the player and continues when the player catches up",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const fileId = yield* addLongClip.pipe(Effect.orDie);
          const token = signTestToken({ fid: fileId, sid: "throttle" });

          const response = yield* HttpClient.execute(
            HttpClientRequest.post(`${server.baseUrl}/api/playback/negotiate`).pipe(
              HttpClientRequest.bodyJsonUnsafe({ token, capabilities: smallScreen }),
            ),
          ).pipe(Effect.orDie);

          const negotiated = yield* response.json.pipe(
            Effect.flatMap(decodeNegotiation),
            Effect.orDie,
          );

          assert.strictEqual(negotiated.mode, "transcode-software");
          const streamId = negotiated.streamId ?? "";

          yield* Effect.sleep(Duration.seconds(4));
          const paused = yield* writtenFragments(streamId);
          yield* Effect.sleep(Duration.seconds(2));

          assert.strictEqual(yield* writtenFragments(streamId), paused);
          assert.isBelow(paused, LONG_SECONDS / 4);

          const playlist = new URL(negotiated.url.replace(/^https?:\/\/[^/]+/u, server.baseUrl));
          const index = paused - 2;

          const segment = yield* HttpClient.get(
            new URL(`${String(index)}.m4s${playlist.search}`, playlist).toString(),
          ).pipe(Effect.orDie);

          assert.strictEqual(segment.status, 200);
          yield* Effect.sleep(Duration.seconds(3));
          assert.isAbove(yield* writtenFragments(streamId), paused);
        }),
      60_000,
    );
  });

  layer(
    MediaTestServer.layer(
      {
        STREAM_BUFFER_AHEAD_SECONDS: "20",
        STREAM_IDLE_SECONDS: "1",
        MAX_CONCURRENT_TRANSCODES: "1",
      },
      { convex: true },
    ),
    { excludeTestServices: true, timeout: "120 seconds" },
  )("with Convex, a one second idle timeout, and one transcode slot", (it) => {
    it.effect(
      "keeps a playing session's paused encoder rather than releasing it",
      () =>
        Effect.gen(function* () {
          const convex = yield* TestConvex.Service;
          const fileId = yield* addLongClip.pipe(Effect.orDie);
          const sid = `held-${crypto.randomUUID()}`;
          const feed = yield* playing(sid);
          const stream = yield* negotiateLong(sid, fileId);

          assert.strictEqual(stream.mode, "transcode-software");

          yield* Effect.sleep(Duration.seconds(4));
          const paused = yield* writtenFragments(stream.streamId);
          yield* Effect.sleep(Duration.seconds(2));

          assert.strictEqual(yield* writtenFragments(stream.streamId), paused);
          assert.deepStrictEqual(yield* logsOf("Stream.released", stream.streamId), []);

          const segment = yield* fetched(stream.file(`${String(paused - 2)}.m4s`));

          assert.strictEqual(segment.status, 200);
          yield* Effect.sleep(Duration.seconds(3));
          assert.isAbove(yield* writtenFragments(stream.streamId), paused);

          yield* Fiber.interrupt(feed);
          yield* convex.end(sid);
          yield* awaitLogged("Stream.ended", stream.streamId);
        }),
      60_000,
    );

    it.effect(
      "releases a throttled encoder and restarts it minutes in with the same init segment",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const convex = yield* TestConvex.Service;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const fileId = yield* addLongClip.pipe(Effect.orDie);
          const sid = `far-${crypto.randomUUID()}`;
          const feed = yield* playing(sid);
          const stream = yield* negotiateLong(sid, fileId);
          const playlist = yield* fetched(stream.file("index.m3u8"));
          const init = yield* fetched(stream.file("init.mp4"));

          assert.strictEqual(init.status, 200);
          yield* awaitThrottled(stream.streamId);
          yield* Fiber.interrupt(feed);
          yield* convex.report(sid, "paused", 3000);

          const released = yield* awaitLogged("Stream.released", stream.streamId);

          assert.deepInclude(released[0]?.annotations, { liveness: "paused", generation: 1 });
          assert.isFalse(
            yield* fs
              .exists(path.join(server.transcodeDir, stream.streamId, "1"))
              .pipe(Effect.orDie),
            "the stopped ffmpeg's run folder is gone",
          );

          const slot = `slot-${crypto.randomUUID()}`;

          yield* convex.report(slot, "paused", 0);
          yield* stop(yield* negotiateLong(slot, fileId));

          const far = segmentFrom(new TextDecoder().decode(playlist.body), 240);

          assert.strictEqual(
            (yield* fetched(stream.file(`${String(far)}.m4s`))).status,
            200,
            `segment ${String(far)}, four minutes in`,
          );

          const resumed = yield* logsOf("Stream.resumed", stream.streamId);

          assert.lengthOf(resumed, 1);
          assert.deepInclude(resumed[0]?.annotations, { generation: 1, segment: far });

          const second = yield* fetched(stream.file("init.mp4"));

          assert.strictEqual(second.status, 200);
          assert.deepStrictEqual(second.body, init.body, "the restarted run's init segment");
          assert.deepStrictEqual(yield* logsOf("Stream.moved", stream.streamId), []);

          yield* convex.end(sid);
          yield* awaitLogged("Stream.ended", stream.streamId);
        }),
      90_000,
    );
  });
});
