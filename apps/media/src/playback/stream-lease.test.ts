import { assert, describe, layer, live } from "@effect/vitest";
import {
  Deferred,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Path,
  PlatformError,
  Redacted,
  Ref,
  Schedule,
  Schema,
  Tracer,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import type { LogRecord } from "@media/contracts/diagnostics";
import {
  type ClientCapabilities,
  HealthResponse,
  NegotiateResponse,
  StreamId,
} from "@media/contracts/media-playback";

import { writeFakeFfmpeg } from "../testing/fake-ffmpeg.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import { signTestToken } from "../testing/test-config.ts";
import * as TestConvex from "../testing/test-convex.ts";
import * as PlaybackReporter from "./playback-reporter.ts";
import * as PlaybackToken from "./playback-token.ts";
import * as StreamSessions from "./stream-sessions.ts";

const hasFfmpeg = await ffmpegAvailable();

const qsvLostOnRestart = await writeFakeFfmpeg({ qsvFailsFromSeconds: 1 });

const qsvLostAfterEarlyFirstFragment = await writeFakeFfmpeg({
  qsvFailsAfterFirstFragmentBefore: 2,
});

const qsvLostWithoutToneMapping = await writeFakeFfmpeg({
  qsvFailsFromSeconds: 1,
  withoutSoftwareToneMapping: true,
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

const withDolbyAudio: ClientCapabilities = {
  containers: ["mp4", "webm"],
  videoCodecs: [{ codec: "h264", maxBitDepth: 8 }],
  audioCodecs: [
    { codec: "aac" },
    { codec: "ac3", maxChannels: 6 },
    { codec: "eac3", maxChannels: 8 },
  ],
  maxWidth: 3840,
  maxHeight: 2160,
  hls: false,
  mse: true,
};

const QUIET = Duration.millis(2500);

const EXPIRY_MS = 6000;

const UNATTENDED_MS = 10_000;

const LIVENESS_FIELDS = ["liveness", "inFlight", "lastRequestAgeMs", "lastProgressAgeMs"];

const decodeNegotiation = Schema.decodeUnknownEffect(Schema.toCodecJson(NegotiateResponse));

const decodeHealth = Schema.decodeUnknownEffect(Schema.toCodecJson(HealthResponse));

const KEPT_INIT = /\/init-\d+\.mp4\.tmp$/u;

const disk = {
  removals: new Array<{ readonly path: string; readonly runs: ReadonlyArray<string> }>(),
  copies: new Array<string>(),
  refuseCopies: false,
  beforeCopy: (_to: string): Effect.Effect<void> => Effect.void,
  refuseRenamesIn: "",
  beforeStat: (_path: string): Effect.Effect<void> => Effect.void,
};

const scriptedDisk = (real: FileSystem.FileSystem): FileSystem.FileSystem =>
  FileSystem.FileSystem.of({
    ...real,
    remove: (path, options) =>
      real.readDirectory(path).pipe(
        Effect.orElseSucceed(() => []),
        Effect.tap((names) =>
          Effect.sync(() => {
            disk.removals.push({ path, runs: names.filter((name) => /^\d+$/u.test(name)) });
          }),
        ),
        Effect.andThen(real.remove(path, options)),
      ),
    writeFile: (to, bytes, options) =>
      !KEPT_INIT.test(to)
        ? real.writeFile(to, bytes, options)
        : Effect.suspend(() => disk.beforeCopy(to)).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                disk.refuseCopies
                  ? Effect.fail(
                      PlatformError.systemError({
                        _tag: "WriteZero",
                        module: "FileSystem",
                        method: "writeFile",
                        description: "the disk is full",
                      }),
                    )
                  : Effect.sync(() => {
                      disk.copies.push(to);
                    }).pipe(Effect.andThen(real.writeFile(to, bytes, options))),
              ),
            ),
          ),
    rename: (from, to) =>
      Effect.suspend(() =>
        disk.refuseRenamesIn !== "" && from.includes(disk.refuseRenamesIn)
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "FileSystem",
                method: "rename",
                description: "the rename failed",
              }),
            )
          : real.rename(from, to),
      ),
    stat: (path) =>
      Effect.suspend(() => disk.beforeStat(path)).pipe(Effect.andThen(real.stat(path))),
  });

const decodeTagged = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ _tag: Schema.String })),
);

const tagOf = (body: Uint8Array) => decodeTagged(new TextDecoder().decode(body));

interface Negotiation {
  readonly name: string;
  readonly file?: "direct" | "remux" | "hdr";
  readonly exp?: number;
  readonly startSeconds?: number;
}

const negotiate = Effect.fn(function* ({ name, file = "direct", exp, startSeconds }: Negotiation) {
  const sid = `${name}-${crypto.randomUUID()}`;
  const server = yield* MediaTestServer.Service;

  yield* (yield* TestConvex.Service).report(sid, "paused", 0);
  const { library } = yield* FixtureWorkspace.Service;
  const files = { direct: library.directMovie, remux: library.remuxMovie, hdr: library.hdrMovie };
  const fid = server.fileId("movies", files[file]);
  const token = signTestToken(exp === undefined ? { fid, sid } : { fid, sid, exp });

  const response = yield* HttpClient.execute(
    HttpClientRequest.post(`${server.baseUrl}/api/playback/negotiate`).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        token,
        capabilities: file === "remux" ? withDolbyAudio : smallScreen,
        startSeconds,
      }),
    ),
  ).pipe(Effect.orDie);

  assert.strictEqual(response.status, 200, `negotiating ${sid}`);
  const negotiated = yield* response.json.pipe(Effect.flatMap(decodeNegotiation), Effect.orDie);
  const playlist = new URL(negotiated.url.replace(/^https?:\/\/[^/]+/u, server.baseUrl));

  return {
    sid,
    fid,
    token,
    mode: negotiated.mode,
    streamId: negotiated.streamId ?? "",
    file: (fileName: string) => new URL(`${fileName}${playlist.search}`, playlist).toString(),
  };
});

type Negotiated = Effect.Success<ReturnType<typeof negotiate>>;

const fetched = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      response.arrayBuffer.pipe(
        Effect.map((body) => ({ status: response.status, body: new Uint8Array(body) })),
      ),
    ),
    Effect.orDie,
  );

const status = (url: string) => fetched(url).pipe(Effect.map((response) => response.status));

type PlaybackPost =
  | { readonly token: string; readonly capabilities: ClientCapabilities }
  | { readonly token: string; readonly streamId: string; readonly positionSeconds: number };

const posted = Effect.fn(function* (route: string, body: PlaybackPost) {
  const server = yield* MediaTestServer.Service;

  const response = yield* HttpClient.execute(
    HttpClientRequest.post(`${server.baseUrl}${route}`).pipe(
      HttpClientRequest.bodyJsonUnsafe(body),
    ),
  ).pipe(Effect.orDie);

  const answer = yield* response.arrayBuffer.pipe(Effect.orDie);

  return { status: response.status, body: new Uint8Array(answer) };
});

const textOf = (body: Uint8Array) => new TextDecoder().decode(body);

const stop = Effect.fn(function* (stream: Negotiated) {
  const server = yield* MediaTestServer.Service;

  const response = yield* HttpClient.execute(
    HttpClientRequest.post(`${server.baseUrl}/api/playback/stop`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ token: stream.token, streamId: stream.streamId }),
    ),
  ).pipe(Effect.orDie);

  assert.strictEqual(response.status, 204, `stopping ${stream.sid}`);
});

const logsOf = Effect.fn(function* (message: string, streamId: string) {
  const server = yield* MediaTestServer.Service;

  return server
    .logged()
    .filter((entry) => entry.message === message && entry.annotations["streamId"] === streamId);
});

const endedEvents = Effect.fn(function* (streamId: string) {
  const events = yield* (yield* PlaybackReporter.Recording).events;

  return events.flatMap((event) =>
    PlaybackReporter.PlaybackEvent.guards.StreamEnded(event) && event.streamId === streamId
      ? [event]
      : [],
  );
});

const assertExplained = (records: ReadonlyArray<LogRecord>) => {
  for (const record of records) {
    for (const field of LIVENESS_FIELDS) {
      assert.property(record.annotations, field, `the record names ${field}`);
    }
  }
};

const runFolder = Effect.fn(function* (streamId: string, run: number) {
  const server = yield* MediaTestServer.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  return yield* fs.exists(path.join(server.transcodeDir, streamId, String(run))).pipe(Effect.orDie);
});

const playing = Effect.fn(function* (sid: string) {
  const convex = yield* TestConvex.Service;
  const position = yield* Ref.make(0);

  return yield* Ref.updateAndGet(position, (ms) => ms + 300).pipe(
    Effect.flatMap((ms) => convex.report(sid, "playing", ms)),
    Effect.repeat(Schedule.spaced("300 millis")),
    Effect.forkChild,
  );
});

const awaitEnded = (streamId: string, seconds = 5) =>
  endedEvents(streamId).pipe(
    Effect.repeat({
      until: (events) => events.length > 0,
      schedule: Schedule.spaced("100 millis"),
      times: seconds * 10,
    }),
  );

const awaitLogged = (message: string, streamId: string) =>
  logsOf(message, streamId).pipe(
    Effect.filterOrFail((records) => records.length > 0),
    Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
    Effect.orDie,
  );

const closing = { hook: (): void => {} };

const closeWatcher = Tracer.make({
  span: (options) => {
    if (options.name === "StreamSessions.close") closing.hook();

    return new Tracer.NativeSpan(options);
  },
});

const activeStreams = Effect.fn(function* () {
  const server = yield* MediaTestServer.Service;
  const response = yield* HttpClient.get(`${server.baseUrl}/api/health`).pipe(Effect.orDie);

  return (yield* response.json.pipe(Effect.flatMap(decodeHealth), Effect.orDie)).activeStreams;
});

describe.skipIf(!hasFfmpeg)("stream liveness", () => {
  layer(
    MediaTestServer.layer(
      { STREAM_IDLE_SECONDS: "1", MAX_CONCURRENT_TRANSCODES: "1" },
      { convex: true, fileSystem: scriptedDisk },
    ),
    { excludeTestServices: true, timeout: "120 seconds" },
  )("with Convex, a one second idle timeout, and one transcode slot", (it) => {
    it.effect(
      "keeps a playing session's encoder through a request gap past the idle timeout",
      () =>
        Effect.gen(function* () {
          const convex = yield* TestConvex.Service;
          const stream = yield* negotiate({ name: "deep-buffer" });
          const feed = yield* playing(stream.sid);

          for (const name of ["init.mp4", "0.m4s", "1.m4s"]) {
            assert.strictEqual(yield* status(stream.file(name)), 200, name);
          }

          yield* Effect.sleep(QUIET);

          assert.isTrue(yield* runFolder(stream.streamId, 1), "the first run still runs");
          assert.strictEqual(
            yield* status(stream.file("2.m4s")),
            200,
            "the next segment on the same URL",
          );
          assert.deepStrictEqual(yield* logsOf("Stream.released", stream.streamId), []);
          assert.deepStrictEqual(yield* endedEvents(stream.streamId), []);

          yield* Fiber.interrupt(feed);
          yield* convex.end(stream.sid);
          yield* awaitEnded(stream.streamId);
        }),
      60_000,
    );

    it.effect(
      "releases a paused stream's encoder and slot, then resumes it on the next request",
      () =>
        Effect.gen(function* () {
          const stream = yield* negotiate({ name: "paused" });
          const init = yield* fetched(stream.file("init.mp4"));

          assert.strictEqual(init.status, 200);
          assert.strictEqual(yield* status(stream.file("0.m4s")), 200);
          assert.strictEqual(yield* status(stream.file("1.m4s")), 200);
          assert.strictEqual(yield* activeStreams(), 1, "active while its encoder runs");

          yield* Effect.sleep(QUIET);

          const released = yield* logsOf("Stream.released", stream.streamId);

          assert.lengthOf(released, 1);
          assert.deepInclude(released[0]?.annotations, { liveness: "paused", generation: 1 });
          assert.isAtLeast(Number(released[0]?.annotations["lastRequestAgeMs"]), 1000);
          assertExplained(released);
          assert.isFalse(yield* runFolder(stream.streamId, 1), "the run folder is gone");
          assert.strictEqual(yield* activeStreams(), 0, "not active while released");

          const whileReleased = yield* fetched(stream.file("init.mp4"));

          assert.strictEqual(whileReleased.status, 200);
          assert.deepStrictEqual(whileReleased.body, init.body, "the kept init segment");

          const other = yield* negotiate({ name: "takes-the-slot" });

          yield* stop(other);

          assert.strictEqual(yield* status(stream.file("3.m4s")), 200, "the resumed segment");
          assert.strictEqual(yield* activeStreams(), 1, "active again once resumed");

          const resumed = yield* logsOf("Stream.resumed", stream.streamId);

          assert.lengthOf(resumed, 1);
          assert.deepInclude(resumed[0]?.annotations, { generation: 1, segment: 3 });
          assert.deepStrictEqual(
            (yield* fetched(stream.file("init.mp4"))).body,
            init.body,
            "the resumed run's init segment",
          );
          assert.deepStrictEqual(yield* logsOf("Stream.moved", stream.streamId), []);
          assert.deepStrictEqual(yield* endedEvents(stream.streamId), []);

          yield* stop(stream);
        }),
      60_000,
    );

    it.effect(
      "closes a released stream that finds no free slot, so its player negotiates again",
      () =>
        Effect.gen(function* () {
          const convex = yield* TestConvex.Service;

          const requests = [
            ["segment", (stream: Negotiated) => fetched(stream.file("1.m4s"))],
            [
              "seek",
              (stream: Negotiated) =>
                posted("/api/playback/seek", {
                  token: stream.token,
                  streamId: stream.streamId,
                  positionSeconds: 6,
                }),
            ],
            ["init", (stream: Negotiated) => fetched(stream.file("init.mp4"))],
          ] as const;

          for (const [request, send] of requests) {
            const stream = yield* negotiate({ name: `starved-${request}` });

            assert.strictEqual(yield* status(stream.file("0.m4s")), 200);

            disk.refuseCopies = request === "init";
            yield* awaitLogged("Stream.released", stream.streamId);
            disk.refuseCopies = false;

            const holder = yield* negotiate({ name: `holder-${request}` });
            const feed = yield* playing(holder.sid);

            const replacing = yield* posted("/api/playback/negotiate", {
              token: stream.token,
              capabilities: smallScreen,
            });

            assert.strictEqual(replacing.status, 503, "a released stream has no slot to hand over");

            const refused = yield* send(stream);

            assert.strictEqual(refused.status, 404, request);
            assert.deepStrictEqual(JSON.parse(textOf(refused.body)), {
              _tag: "StreamNotFound",
              streamId: stream.streamId,
            });

            const logged = yield* logsOf("Stream.resume_refused", stream.streamId);

            assert.lengthOf(logged, 1);
            assert.strictEqual(logged[0]?.level, "WARN");
            assert.deepInclude(logged[0]?.annotations, {
              reason: "TranscodeCapacityReached",
              slots: "transcode",
            });

            const [ended] = yield* awaitEnded(stream.streamId);

            assert.strictEqual(ended?.reason, "resume-refused");
            assertExplained(yield* logsOf("Stream.ended", stream.streamId));

            const again = yield* posted("/api/playback/negotiate", {
              token: stream.token,
              capabilities: smallScreen,
            });

            assert.strictEqual(again.status, 503, `negotiating ${stream.sid} again`);
            assert.deepStrictEqual(JSON.parse(textOf(again.body)), {
              _tag: "TranscodeCapacityReached",
              limit: 1,
            });

            yield* Fiber.interrupt(feed);
            yield* convex.end(holder.sid);
            yield* awaitEnded(holder.streamId);
          }
        }),
      90_000,
    );

    it.effect(
      "closes running and released streams as soon as their session ends",
      () =>
        Effect.gen(function* () {
          const convex = yield* TestConvex.Service;
          const quiet = yield* negotiate({ name: "ends-released" });

          assert.strictEqual(yield* status(quiet.file("0.m4s")), 200);

          yield* Effect.sleep(QUIET);

          assert.lengthOf(yield* logsOf("Stream.released", quiet.streamId), 1);

          const active = yield* negotiate({ name: "ends-running" });

          yield* convex.report(active.sid, "playing", 0);

          assert.strictEqual(yield* status(active.file("0.m4s")), 200);

          for (const stream of [active, quiet]) {
            yield* convex.end(stream.sid);
            const [event] = yield* awaitEnded(stream.streamId);

            assert.strictEqual(event?.reason, "session-ended");
            assertExplained(yield* logsOf("Stream.ended", stream.streamId));

            const gone = yield* fetched(stream.file("1.m4s"));

            assert.strictEqual(gone.status, 410);
            assert.deepStrictEqual(tagOf(gone.body), { _tag: "PlaybackSessionEnded" });
          }
        }),
      60_000,
    );

    it.effect(
      "closes a stream and refuses its token once its session ends",
      () =>
        Effect.gen(function* () {
          const convex = yield* TestConvex.Service;
          const stream = yield* negotiate({ name: "unlisted-end" });

          assert.strictEqual(yield* status(stream.file("0.m4s")), 200);

          yield* convex.end(stream.sid);
          const [event] = yield* awaitEnded(stream.streamId);

          assert.strictEqual(event?.reason, "session-ended");
          assertExplained(yield* logsOf("Stream.ended", stream.streamId));

          const gone = yield* fetched(stream.file("1.m4s"));

          assert.strictEqual(gone.status, 410);
          assert.deepStrictEqual(tagOf(gone.body), { _tag: "PlaybackSessionEnded" });

          const again = yield* posted("/api/playback/negotiate", {
            token: stream.token,
            capabilities: smallScreen,
          });

          assert.strictEqual(again.status, 410, "no new stream for the ended session");
          assert.deepStrictEqual(tagOf(again.body), { _tag: "PlaybackSessionEnded" });
        }),
      60_000,
    );

    it.effect(
      "refuses the first request of a session that ended before it",
      () =>
        Effect.gen(function* () {
          const convex = yield* TestConvex.Service;
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;
          const sid = `ended-first-${crypto.randomUUID()}`;

          yield* convex.report(sid, "paused", 0);
          yield* convex.end(sid);

          const refused = yield* posted("/api/playback/negotiate", {
            token: signTestToken({ fid: server.fileId("movies", library.directMovie), sid }),
            capabilities: smallScreen,
          });

          assert.strictEqual(refused.status, 410);
          assert.deepStrictEqual(tagOf(refused.body), { _tag: "PlaybackSessionEnded" });
        }),
      30_000,
    );

    it.effect(
      "refuses a token for a session Convex has no record of, and starts no stream",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const recording = yield* PlaybackReporter.Recording;
          const { library } = yield* FixtureWorkspace.Service;
          const sid = `unknown-${crypto.randomUUID()}`;

          const refused = yield* posted("/api/playback/negotiate", {
            token: signTestToken({ fid: server.fileId("movies", library.directMovie), sid }),
            capabilities: smallScreen,
          });

          assert.strictEqual(refused.status, 410);
          assert.deepStrictEqual(tagOf(refused.body), { _tag: "PlaybackSessionEnded" });

          const events = yield* recording.events;

          assert.deepStrictEqual(
            events.filter((event) => event.sessionId === sid),
            [],
          );
        }),
      30_000,
    );

    it.effect(
      "ends a playing session's HLS stream when the session switches to direct play",
      () =>
        Effect.gen(function* () {
          const convex = yield* TestConvex.Service;
          const stream = yield* negotiate({ name: "to-direct" });
          const feed = yield* playing(stream.sid);

          assert.strictEqual(yield* status(stream.file("0.m4s")), 200);

          const direct = yield* posted("/api/playback/negotiate", {
            token: stream.token,
            capabilities: withDolbyAudio,
          });

          assert.strictEqual(direct.status, 200);
          assert.deepInclude(JSON.parse(textOf(direct.body)), { mode: "direct" });
          assert.deepStrictEqual(
            (yield* endedEvents(stream.streamId)).map((event) => event.reason),
            ["replaced"],
          );
          assert.strictEqual(yield* status(stream.file("1.m4s")), 404, "the HLS stream is gone");

          yield* stop(yield* negotiate({ name: "after-direct" }));
          yield* Fiber.interrupt(feed);
          yield* convex.end(stream.sid);
        }),
      60_000,
    );

    it.effect(
      "keeps a paused session's released stream however long the pause",
      () =>
        Effect.gen(function* () {
          const convex = yield* TestConvex.Service;
          const stream = yield* negotiate({ name: "long-pause" });

          assert.strictEqual(yield* status(stream.file("0.m4s")), 200);

          const [released] = yield* awaitLogged("Stream.released", stream.streamId);

          assert.strictEqual(released?.annotations["liveness"], "paused");

          yield* Effect.sleep(Duration.millis(UNATTENDED_MS + 1500));

          assert.deepStrictEqual(yield* endedEvents(stream.streamId), []);
          assert.strictEqual(yield* status(stream.file("index.m3u8")), 200, "still registered");

          yield* convex.end(stream.sid);
          yield* awaitEnded(stream.streamId);
        }),
      60_000,
    );
  });

  layer(
    MediaTestServer.layer({ STREAM_IDLE_SECONDS: "1" }, { fileSystem: scriptedDisk }).pipe(
      Layer.provide(Layer.succeed(Tracer.Tracer, closeWatcher)),
    ),
    { excludeTestServices: true, timeout: "120 seconds" },
  )("standalone, with a one second idle timeout", (it) => {
    it.effect("stops a stream's encoder before it deletes the stream's folder", () =>
      Effect.gen(function* () {
        const stream = yield* negotiate({ name: "folder" });

        assert.strictEqual(yield* status(stream.file("0.m4s")), 200);

        yield* stop(stream);

        assert.deepStrictEqual(
          disk.removals.find((removal) => removal.path.endsWith(`/${stream.streamId}`))?.runs,
          [],
          "every run folder, removed once its ffmpeg stopped, was gone before the stream's folder",
        );
      }),
    );

    it.effect(
      "restarts a released stream's encoder for its init segment when the release kept none",
      () =>
        Effect.gen(function* () {
          const stream = yield* negotiate({ name: "no-kept-init" });
          const first = yield* fetched(stream.file("init.mp4"));

          assert.strictEqual(first.status, 200);
          assert.strictEqual(yield* status(stream.file("0.m4s")), 200);

          disk.refuseCopies = true;
          yield* awaitLogged("Stream.released", stream.streamId);
          disk.refuseCopies = false;

          const again = yield* fetched(stream.file("init.mp4"));

          assert.strictEqual(again.status, 200);
          assert.deepStrictEqual(again.body, first.body, "the restarted run's init segment");
          assert.lengthOf(yield* logsOf("Stream.resumed", stream.streamId), 1);
          assert.strictEqual(yield* status(stream.file("1.m4s")), 200);

          yield* stop(stream);
        }),
      60_000,
    );

    it.effect(
      "restarts a run in the same generation that writes the same init segment",
      () =>
        Effect.gen(function* () {
          for (const file of ["direct", "remux"] as const) {
            const stream = yield* negotiate({ name: `init-${file}`, file });
            const first = yield* fetched(stream.file("init.mp4"));

            assert.strictEqual(stream.mode, file === "direct" ? "transcode-software" : "remux");
            assert.strictEqual(yield* status(stream.file("0.m4s")), 200);

            yield* Effect.sleep(QUIET);

            assert.lengthOf(yield* logsOf("Stream.released", stream.streamId), 1);
            assert.strictEqual(yield* status(stream.file("4.m4s")), 200);
            assert.lengthOf(yield* logsOf("Stream.resumed", stream.streamId), 1);
            assert.isTrue(yield* runFolder(stream.streamId, 2), "the second run's folder");

            const second = yield* fetched(stream.file("init.mp4"));

            assert.strictEqual(second.status, 200);
            assert.deepStrictEqual(second.body, first.body, `${stream.mode} init segment`);

            yield* stop(stream);
          }
        }),
      60_000,
    );

    it.effect("answers every request for an unknown stream with a renegotiate hint", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const token = signTestToken({ fid: "x" });

        for (const name of ["index.m3u8", "init.mp4", "7.m4s"]) {
          const response = yield* fetched(
            `${server.baseUrl}/media/hls/AAAAAAAAAAAAAAAAAAAAAA/1/${name}?token=${token}`,
          );

          assert.strictEqual(response.status, 404, name);
          assert.deepStrictEqual(JSON.parse(new TextDecoder().decode(response.body)), {
            _tag: "StreamNotFound",
            streamId: "AAAAAAAAAAAAAAAAAAAAAA",
          });
        }
      }),
    );

    it.effect(
      "closes a released stream once every token that reached it has expired",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const server = yield* MediaTestServer.Service;
          const expiresAt = Date.now() + EXPIRY_MS;
          const stream = yield* negotiate({ name: "expiring", exp: expiresAt });

          assert.strictEqual(yield* status(stream.file("0.m4s")), 200);

          const released = yield* awaitLogged("Stream.released", stream.streamId);

          assert.lengthOf(released, 1);
          assert.isBelow(Date.parse(released[0]?.timestamp ?? ""), expiresAt, "released first");
          assert.strictEqual(released[0]?.annotations["liveness"], "unknown");

          const [ended] = yield* awaitEnded(stream.streamId, EXPIRY_MS / 1000 + 5);

          assert.strictEqual(ended?.reason, "expired");
          assert.isFalse(
            yield* fs.exists(path.join(server.transcodeDir, stream.streamId)).pipe(Effect.orDie),
          );
        }),
      60_000,
    );

    it.effect("reports how long a stopped stream had been quiet", () =>
      Effect.gen(function* () {
        const stream = yield* negotiate({ name: "quiet-stop" });

        assert.strictEqual(yield* status(stream.file("0.m4s")), 200);

        yield* Effect.sleep(Duration.millis(500));
        yield* stop(stream);

        const [ended] = yield* endedEvents(stream.streamId);

        assert.strictEqual(ended?.reason, "stopped");
        assert.strictEqual(ended?.inFlight, 0);
        assert.isAtLeast(ended?.lastRequestAgeMs ?? 0, 500);
      }),
    );

    it.effect(
      "keeps only the current generation's init segment once the stream moves on",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const stream = yield* negotiate({ name: "kept-inits" });

          assert.strictEqual(yield* status(stream.file("init.mp4")), 200);
          assert.strictEqual(yield* status(stream.file("0.m4s")), 200);

          yield* awaitLogged("Stream.released", stream.streamId);

          assert.strictEqual(yield* status(stream.file("4.m4s")), 200, "the resumed segment");

          const moved = yield* posted("/api/playback/seek", {
            token: stream.token,
            streamId: stream.streamId,
            positionSeconds: 0,
          });

          assert.strictEqual(moved.status, 200);
          assert.deepInclude(JSON.parse(textOf(moved.body)), { generation: 2 });

          const names = yield* fs
            .readDirectory(path.join(server.transcodeDir, stream.streamId))
            .pipe(Effect.orDie);

          assert.includeMembers(
            ["3", "init-2.mp4"],
            names,
            "the third run's folder and generation 2's init only",
          );

          yield* stop(stream);
        }),
      60_000,
    );

    it.effect(
      "closes a released stream that no session report or request reached for ten idle periods",
      () =>
        Effect.gen(function* () {
          const stream = yield* negotiate({ name: "unattended" });

          assert.strictEqual(yield* status(stream.file("0.m4s")), 200);

          const [released] = yield* awaitLogged("Stream.released", stream.streamId);
          const [ended] = yield* awaitEnded(stream.streamId, UNATTENDED_MS / 1000 + 5);

          assert.strictEqual(ended?.reason, "unattended");
          assert.strictEqual(ended?.liveness, "unknown");

          const [record] = yield* logsOf("Stream.ended", stream.streamId);
          const after = Date.parse(record?.timestamp ?? "") - Date.parse(released?.timestamp ?? "");

          assert.isAtLeast(after, UNATTENDED_MS - 500, "ten idle periods after the release");
          assert.isBelow(after, UNATTENDED_MS + 2000);
        }),
      60_000,
    );

    it.effect(
      "answers a moved generation when the kept init segment it chose goes before it is read",
      () =>
        Effect.gen(function* () {
          const stream = yield* negotiate({ name: "init-moves" });

          assert.strictEqual(yield* status(stream.file("init.mp4")), 200);
          assert.strictEqual(yield* status(stream.file("0.m4s")), 200);

          yield* awaitLogged("Stream.released", stream.streamId);

          const context = yield* Effect.context<HttpClient.HttpClient | MediaTestServer.Service>();

          const moveOn = Effect.gen(function* () {
            assert.strictEqual(yield* status(stream.file("4.m4s")), 200, "the resumed segment");

            const moved = yield* posted("/api/playback/seek", {
              token: stream.token,
              streamId: stream.streamId,
              positionSeconds: 0,
            });

            assert.deepInclude(JSON.parse(textOf(moved.body)), { generation: 2 });
          }).pipe(Effect.provideContext(context));

          disk.beforeStat = (file) => {
            if (!file.endsWith(`/${stream.streamId}/init-1.mp4`)) return Effect.void;
            disk.beforeStat = () => Effect.void;

            return moveOn;
          };

          const raced = yield* fetched(stream.file("init.mp4"));

          disk.beforeStat = () => Effect.void;

          assert.strictEqual(raced.status, 410);
          assert.deepStrictEqual(JSON.parse(textOf(raced.body)), {
            _tag: "StreamGenerationGone",
            streamId: stream.streamId,
            generation: 1,
            currentGeneration: 2,
          });

          yield* stop(stream);
        }),
      60_000,
    );

    it.effect("keeps a generation's init segment once across its encoder's restarts", () =>
      Effect.gen(function* () {
        const stream = yield* negotiate({ name: "kept-once" });
        const into = (copy: string) => copy.includes(`/${stream.streamId}/`);

        assert.strictEqual(yield* status(stream.file("init.mp4")), 200);
        assert.strictEqual(yield* status(stream.file("0.m4s")), 200);

        yield* awaitLogged("Stream.released", stream.streamId);

        assert.lengthOf(disk.copies.filter(into), 1, "the first release keeps the init segment");
        assert.strictEqual(yield* status(stream.file("4.m4s")), 200, "the resumed segment");

        yield* logsOf("Stream.released", stream.streamId).pipe(
          Effect.filterOrFail((records) => records.length > 1),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
          Effect.orDie,
        );

        assert.lengthOf(disk.copies.filter(into), 1, "the second release finds it kept");
        assert.strictEqual(yield* status(stream.file("init.mp4")), 200);

        yield* stop(stream);
      }),
    );

    for (const reason of ["expired", "unattended"] as const) {
      it.effect(
        `keeps a stream that a request reached as the sweep began to close it as ${reason}`,
        () =>
          Effect.gen(function* () {
            const sessions = yield* StreamSessions.Service;
            const tokens = yield* PlaybackToken.Service;
            const name = `swept-${reason}`;

            const stream = yield* negotiate(
              reason === "expired" ? { name, exp: Date.now() + EXPIRY_MS } : { name },
            );

            assert.strictEqual(yield* status(stream.file("0.m4s")), 200);
            yield* awaitLogged("Stream.released", stream.streamId);

            const renewed = signTestToken({ fid: stream.fid, sid: stream.sid });
            const grant = yield* tokens.verify(Redacted.make(renewed), PlaybackToken.PLAY);
            const reached = yield* Deferred.make<boolean>();
            const context = yield* Effect.context();

            closing.hook = () => {
              closing.hook = () => {};

              const admitted = Effect.runSyncWith(context)(
                sessions.playlist(StreamId.make(stream.streamId), 1, grant).pipe(
                  Effect.as(true),
                  Effect.orElseSucceed(() => false),
                ),
              );

              Deferred.doneUnsafe(reached, Effect.succeed(admitted));
            };

            const admitted = yield* Deferred.await(reached).pipe(
              Effect.timeout(
                Duration.millis((reason === "expired" ? EXPIRY_MS : UNATTENDED_MS) + 5000),
              ),
              Effect.orDie,
            );

            const playlist = new URL(stream.file("index.m3u8"));
            playlist.searchParams.set("token", renewed);

            assert.isTrue(admitted, "the request got in before the close decided anything");
            assert.strictEqual(yield* status(playlist.toString()), 200, "the stream stays");
            assert.deepStrictEqual(yield* endedEvents(stream.streamId), []);

            yield* stop({ ...stream, token: renewed });
          }),
        60_000,
      );
    }

    it.effect("logs no release for a stream that stops while its release keeps the init", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stream = yield* negotiate({ name: "stopped-in-release" });
        const context = yield* Effect.context<HttpClient.HttpClient | MediaTestServer.Service>();
        const stopped = yield* Deferred.make<void>();

        assert.strictEqual(yield* status(stream.file("init.mp4")), 200);
        assert.strictEqual(yield* status(stream.file("0.m4s")), 200);

        disk.beforeCopy = (to) => {
          if (!to.includes(`/${stream.streamId}/`)) return Effect.void;
          disk.beforeCopy = () => Effect.void;

          return stop(stream).pipe(
            Effect.andThen(Deferred.succeed(stopped, undefined)),
            Effect.provideContext(context),
          );
        };

        yield* Deferred.await(stopped);
        yield* Effect.sleep(Duration.seconds(1));

        assert.deepStrictEqual(yield* logsOf("Stream.released", stream.streamId), []);
        assert.lengthOf(yield* logsOf("Stream.ended", stream.streamId), 1);
        assert.isFalse(
          yield* fs.exists(path.join(server.transcodeDir, stream.streamId)).pipe(Effect.orDie),
        );
      }),
    );

    it.effect("leaves no temporary init segment behind when keeping one fails", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stream = yield* negotiate({ name: "rename-fails" });

        assert.strictEqual(yield* status(stream.file("init.mp4")), 200);
        assert.strictEqual(yield* status(stream.file("0.m4s")), 200);

        disk.refuseRenamesIn = stream.streamId;
        yield* awaitLogged("Stream.released", stream.streamId);
        disk.refuseRenamesIn = "";

        assert.deepStrictEqual(
          yield* fs
            .readDirectory(path.join(server.transcodeDir, stream.streamId))
            .pipe(Effect.orDie),
          [],
          "neither a run folder nor a kept or temporary init segment",
        );
        assert.strictEqual(yield* status(stream.file("init.mp4")), 200);

        yield* stop(stream);
      }),
    );
  });

  describe("standalone, with Quick Sync that fails after the first fragment of an early run", () => {
    const server = MediaTestServer.layer(
      {
        FFMPEG_PATH: qsvLostAfterEarlyFirstFragment,
        HARDWARE_ACCELERATION: "qsv",
        STREAM_IDLE_SECONDS: "1",
        MAX_CONCURRENT_TRANSCODES: "1",
      },
      { fileSystem: scriptedDisk },
    );

    const fallsBack = Effect.fn(function* (move: "seek" | "revive") {
      const recording = yield* PlaybackReporter.Recording;
      const stream = yield* negotiate({ name: `qsv-first-fragment-${move}`, startSeconds: 8 });

      assert.strictEqual(stream.mode, "transcode-qsv");
      assert.strictEqual(yield* status(stream.file("init.mp4")), 200);

      const seeking = move === "seek";

      if (seeking) {
        const moved = yield* posted("/api/playback/seek", {
          token: stream.token,
          streamId: stream.streamId,
          positionSeconds: 0,
        });

        assert.deepInclude(JSON.parse(textOf(moved.body)), { generation: 2 });
      } else {
        yield* awaitLogged("Stream.released", stream.streamId);
      }

      const gone = yield* fetched(stream.file(seeking ? "../2/init.mp4" : "0.m4s"));

      assert.strictEqual(gone.status, 410, "no Quick Sync bytes before the fallback");
      assert.deepStrictEqual(JSON.parse(textOf(gone.body)), {
        _tag: "StreamGenerationGone",
        streamId: stream.streamId,
        generation: seeking ? 2 : 1,
        currentGeneration: seeking ? 3 : 2,
      });

      const changes = (yield* recording.events).flatMap((event) =>
        PlaybackReporter.PlaybackEvent.guards.ModeChanged(event) &&
        event.streamId === stream.streamId
          ? [[event.from, event.to]]
          : [],
      );

      assert.deepStrictEqual(changes, [["transcode-qsv", "transcode-software"]]);

      for (const name of ["init.mp4", "0.m4s"]) {
        const software = `../${seeking ? "3" : "2"}/${name}`;

        assert.strictEqual(yield* status(stream.file(software)), 200, software);
      }

      yield* stop(stream);
    });

    for (const move of ["seek", "revive"] as const) {
      live(
        `falls back to software before a ${move}'s Quick Sync run serves anything`,
        () =>
          Layer.build(server).pipe(
            Effect.flatMap((context) => fallsBack(move).pipe(Effect.provideContext(context))),
          ),
        60_000,
      );
    }
  });

  describe("standalone, with Quick Sync that fails once a run restarts mid-file", () => {
    const server = MediaTestServer.layer(
      {
        FFMPEG_PATH: qsvLostOnRestart,
        HARDWARE_ACCELERATION: "qsv",
        STREAM_IDLE_SECONDS: "1",
        MAX_CONCURRENT_TRANSCODES: "1",
      },
      { fileSystem: scriptedDisk },
    );

    const restartFails = Effect.gen(function* () {
      const recording = yield* PlaybackReporter.Recording;
      const stream = yield* negotiate({ name: "qsv-restart" });

      assert.strictEqual(stream.mode, "transcode-qsv");
      assert.strictEqual(yield* status(stream.file("init.mp4")), 200);
      assert.strictEqual(yield* status(stream.file("0.m4s")), 200);

      yield* awaitLogged("Stream.released", stream.streamId);

      const gone = yield* fetched(stream.file("3.m4s"));

      assert.strictEqual(gone.status, 410);
      assert.deepStrictEqual(JSON.parse(textOf(gone.body)), {
        _tag: "StreamGenerationGone",
        streamId: stream.streamId,
        generation: 1,
        currentGeneration: 2,
      });
      assert.lengthOf(yield* logsOf("Stream.resumed", stream.streamId), 1);

      const changes = (yield* recording.events).flatMap((event) =>
        PlaybackReporter.PlaybackEvent.guards.ModeChanged(event) &&
        event.streamId === stream.streamId
          ? [[event.from, event.to]]
          : [],
      );

      assert.deepStrictEqual(changes, [["transcode-qsv", "transcode-software"]]);
      assert.strictEqual(yield* status(stream.file("../2/index.m3u8")), 200);
      assert.strictEqual(
        yield* status(stream.file("../2/3.m4s")),
        200,
        "segment 3 in generation 2",
      );

      yield* stop(stream);
      yield* stop(yield* negotiate({ name: "after-qsv-restart" }));
    });

    live(
      "moves a released Quick Sync stream whose restart fails to a software generation",
      () =>
        Layer.build(server).pipe(
          Effect.flatMap((context) => restartFails.pipe(Effect.provideContext(context))),
        ),
      60_000,
    );

    const lostWhileReleased = Effect.fn(function* (request: "segment" | "init") {
      const recording = yield* PlaybackReporter.Recording;
      const stream = yield* negotiate({ name: `qsv-lost-${request}` });

      assert.strictEqual(stream.mode, "transcode-qsv");

      for (const name of ["init.mp4", "0.m4s", "1.m4s"]) {
        assert.strictEqual(yield* status(stream.file(name)), 200, name);
      }

      disk.refuseCopies = request === "init";
      yield* awaitLogged("Stream.released", stream.streamId);
      disk.refuseCopies = false;

      const elsewhere = yield* negotiate({ name: "qsv-fails-elsewhere", startSeconds: 6 });

      assert.strictEqual(elsewhere.mode, "transcode-software", "Quick Sync failed meanwhile");
      yield* stop(elsewhere);

      const gone = yield* fetched(stream.file(request === "init" ? "init.mp4" : "3.m4s"));

      assert.strictEqual(gone.status, 410, request);
      assert.deepStrictEqual(JSON.parse(textOf(gone.body)), {
        _tag: "StreamGenerationGone",
        streamId: stream.streamId,
        generation: 1,
        currentGeneration: 2,
      });
      assert.deepStrictEqual(
        yield* logsOf("StreamSessions.encoder_failed", stream.streamId),
        [],
        "no Quick Sync run started for the restart",
      );

      const changes = (yield* recording.events).flatMap((event) =>
        PlaybackReporter.PlaybackEvent.guards.ModeChanged(event) &&
        event.streamId === stream.streamId
          ? [[event.from, event.to]]
          : [],
      );

      assert.deepStrictEqual(changes, [["transcode-qsv", "transcode-software"]]);

      for (const name of ["index.m3u8", "init.mp4", request === "init" ? "1.m4s" : "3.m4s"]) {
        assert.strictEqual(
          yield* status(stream.file(`../2/${name}`)),
          200,
          `${name} in generation 2`,
        );
      }

      yield* stop(stream);
    });

    for (const request of ["segment", "init"] as const) {
      live(
        `restarts a released Quick Sync stream in software, without a doomed run, once Quick Sync failed elsewhere (${request})`,
        () =>
          Layer.build(server).pipe(
            Effect.flatMap((context) =>
              lostWhileReleased(request).pipe(Effect.provideContext(context)),
            ),
          ),
        60_000,
      );
    }

    const withoutToneMapping = MediaTestServer.layer(
      {
        FFMPEG_PATH: qsvLostWithoutToneMapping,
        HARDWARE_ACCELERATION: "qsv",
        STREAM_IDLE_SECONDS: "1",
        MAX_CONCURRENT_TRANSCODES: "1",
      },
      { fileSystem: scriptedDisk },
    );

    const lostForGood = Effect.gen(function* () {
      const stream = yield* negotiate({ name: "qsv-hdr", file: "hdr" });

      assert.strictEqual(stream.mode, "transcode-qsv");

      for (const name of ["init.mp4", "0.m4s", "1.m4s"]) {
        assert.strictEqual(yield* status(stream.file(name)), 200, name);
      }

      yield* awaitLogged("Stream.released", stream.streamId);

      const elsewhere = yield* negotiate({ name: "qsv-fails-before-hdr", startSeconds: 6 });

      assert.strictEqual(elsewhere.mode, "transcode-software", "Quick Sync failed meanwhile");
      yield* stop(elsewhere);

      for (const attempt of ["first", "second"]) {
        const gone = yield* fetched(stream.file("3.m4s"));

        assert.strictEqual(gone.status, 404, `${attempt} request`);
        assert.deepStrictEqual(JSON.parse(textOf(gone.body)), {
          _tag: "StreamNotFound",
          streamId: stream.streamId,
        });
      }

      const ended = yield* endedEvents(stream.streamId);

      assert.deepStrictEqual(
        ended.map((event) => event.reason),
        ["failed"],
      );

      const again = yield* posted("/api/playback/negotiate", {
        token: stream.token,
        capabilities: smallScreen,
      });

      assert.strictEqual(again.status, 422, "the renegotiation names the real refusal");
      assert.deepStrictEqual(JSON.parse(textOf(again.body)), {
        _tag: "UnsupportedPlayback",
        reason: "hdr-tone-mapping-requires-hardware",
      });
      assert.strictEqual(yield* activeStreams(), 0, "no slot held");
    });

    live(
      "closes a released Quick Sync stream that software cannot take over once Quick Sync failed",
      () =>
        Layer.build(withoutToneMapping).pipe(
          Effect.flatMap((context) => lostForGood.pipe(Effect.provideContext(context))),
        ),
      60_000,
    );
  });
});
