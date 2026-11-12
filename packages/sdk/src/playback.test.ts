import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";

import { StartedPlayback } from "@media/contracts/models/playback";
import { Milliseconds } from "@media/contracts/units";
import { Effect, Exit, Fiber, Layer, Option, Predicate, Schema, Stream } from "effect";
import type { Scope } from "effect";
import { TestClock } from "effect/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { MediaOrigin } from "./media-http";
import { autoplayCountdown, negotiate, stop, stopNow } from "./playback";

const started = Schema.decodeSync(StartedPlayback)({
  sessionId: "session-1",
  titleId: "title-1",
  episodeId: null,
  episode: null,
  file: {
    id: "file-1",
    titleId: "title-1",
    episodeId: null,
    versionName: null,
    sizeBytes: 1_000,
    probe: {
      container: "mp4",
      durationMs: 600_000,
      bitRate: null,
      video: [],
      audio: [],
      subtitles: [],
    },
    externalSubtitles: [],
    hdr: false,
    missing: false,
    trickplay: null,
  },
  token: "v1.payload.signature",
  tokenExpiresAt: 1_760_000_000_000,
  mediaBaseUrl: "http://127.0.0.1:9",
  resumePositionMs: 0,
});

const advance = (ms: number) =>
  Effect.gen(function* () {
    for (let elapsed = 0; elapsed < ms; elapsed += 100) yield* TestClock.adjust(100);
  });

const onTestClock = <A, E>(body: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(Layer.build(TestClock.layer()), (context) =>
        body.pipe(Effect.provideContext(context)),
      ),
    ),
  );

const received: Array<string> = [];

const receivedBodies: Array<string> = [];

const receivedTypes: Array<string> = [];

const PUBLIC_URL = "http://movies.invalid:18480";

const STREAM_ID = "stream-0123456789abcde";

const mediaServer = createServer((request: IncomingMessage, response: ServerResponse) => {
  let text = "";

  request.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });

  request.on("end", () => {
    received.push(request.url ?? "");
    receivedBodies.push(text);
    receivedTypes.push(request.headers["content-type"] ?? "");

    const body =
      request.url === "/api/playback/negotiate"
        ? {
            mode: "remux",
            url: `${PUBLIC_URL}/media/hls/${STREAM_ID}/0/index.m3u8?token=t`,
            streamId: STREAM_ID,
            generation: 0,
            startSeconds: 0,
            durationSeconds: 600,
            video: { codec: "h264", width: 1920, height: 1080, dynamicRange: "sdr" },
            subtitles: [],
            expiresAt: 1_760_000_000_000,
          }
        : null;

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
});

let mediaServiceUrl = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => mediaServer.listen(0, "127.0.0.1", resolve));
  const address = mediaServer.address();

  if (address === null || Predicate.isString(address)) throw new Error("The server is not on TCP");

  mediaServiceUrl = `http://127.0.0.1:${String(address.port)}/`;
});

afterAll(() => {
  mediaServer.close();
});

const DESKTOP = {
  containers: ["mp4"],
  videoCodecs: [{ codec: "h264" }],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 1920,
  maxHeight: 1080,
  hls: true,
  mse: false,
} as const;

const negotiateAndStop = (session: StartedPlayback) =>
  Effect.gen(function* () {
    const stream = yield* negotiate(session, DESKTOP, Milliseconds.make(0), Option.none());

    yield* stop({ started: session, stream });

    return stream.url;
  });

describe("reaching the media service", () => {
  it("sends playback requests to the URL the session names", async () => {
    received.length = 0;

    const url = await Effect.runPromise(
      negotiateAndStop({ ...started, mediaBaseUrl: mediaServiceUrl }),
    );

    expect(received).toStrictEqual(["/api/playback/negotiate", "/api/playback/stop"]);
    expect(url).toBe(`${PUBLIC_URL}/media/hls/${STREAM_ID}/0/index.m3u8?token=t`);
  });

  it("sends them to a provided MediaOrigin instead, and keeps the stream URL public", async () => {
    received.length = 0;

    const url = await Effect.runPromise(
      negotiateAndStop({ ...started, mediaBaseUrl: PUBLIC_URL }).pipe(
        Effect.provideService(MediaOrigin, Option.some(mediaServiceUrl)),
      ),
    );

    expect(received).toStrictEqual(["/api/playback/negotiate", "/api/playback/stop"]);
    expect(url).toBe(`${PUBLIC_URL}/media/hls/${STREAM_ID}/0/index.m3u8?token=t`);
  });
});

describe("stopping a stream as the page goes away", () => {
  it("sends the stop as a simple request before it returns, and nothing for a direct stream", async () => {
    const session = { ...started, mediaBaseUrl: mediaServiceUrl };

    const stream = await Effect.runPromise(
      negotiate(session, DESKTOP, Milliseconds.make(0), Option.none()),
    );

    received.length = 0;
    receivedBodies.length = 0;
    receivedTypes.length = 0;

    const sent = vi.spyOn(globalThis, "fetch");

    stopNow({ started: session, stream });
    stopNow({ started: session, stream: { ...stream, streamId: undefined } });

    // Called before `stopNow` returned, with what lets it leave a page in `pagehide`.
    const calls = [...sent.mock.calls];

    sent.mockRestore();
    expect(calls).toStrictEqual([
      [
        new URL("/api/playback/stop", mediaServiceUrl).href,
        {
          method: "POST",
          keepalive: true,
          headers: { "content-type": "text/plain;charset=UTF-8" },
          body: JSON.stringify({ token: session.token, streamId: STREAM_ID }),
        },
      ],
    ]);

    await vi.waitFor(() => {
      expect(received).toStrictEqual(["/api/playback/stop"]);
    });
    expect(JSON.parse(receivedBodies[0] ?? "null")).toStrictEqual({
      token: session.token,
      streamId: STREAM_ID,
    });
    // `text/plain` needs no CORS preflight, which a page in `pagehide` would never send.
    expect(receivedTypes).toStrictEqual(["text/plain;charset=UTF-8"]);
  });
});

describe("autoplay countdown", () => {
  it("counts down each second to zero", () =>
    onTestClock(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Stream.runCollect(autoplayCountdown(5_000, 1_000)));

        yield* advance(6_000);

        expect(yield* Fiber.await(fiber)).toStrictEqual(
          Exit.succeed([5_000, 4_000, 3_000, 2_000, 1_000, 0]),
        );
      }),
    ));
});
