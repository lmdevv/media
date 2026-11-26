import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";

import { StartedPlayback } from "@media/contracts/models/playback";
import { Milliseconds } from "@media/contracts/units";
import { Effect, Exit, Fiber, Layer, Option, Predicate, Redacted, Schema, Stream } from "effect";
import type { Scope } from "effect";
import { TestClock } from "effect/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { MediaOrigin } from "./media-http";
import {
  autoplayCountdown,
  inGeneration,
  lendToReceiver,
  negotiate,
  recoveryFor,
  seekStream,
  stop,
  stopNow,
} from "./playback";

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
      chapters: [],
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

const CREDENTIAL = `r1.${"A".repeat(43)}`;

/** A negotiation's answer: a remuxed stream. */
const NEGOTIATED = {
  mode: "remux",
  url: `${PUBLIC_URL}/media/hls/${STREAM_ID}/0/index.m3u8?token=t`,
  streamId: STREAM_ID,
  generation: 0,
  startSeconds: 0,
  durationSeconds: 600,
  video: { codec: "h264", width: 1920, height: 1080, dynamicRange: "sdr" },
  subtitles: [],
  expiresAt: 1_760_000_000_000,
};

/** A seek's answer after a failed Quick Sync run: a CPU replacement capped at 1080p. */
const RELOADED = {
  streamId: STREAM_ID,
  generation: 2,
  playlistUrl: `${PUBLIC_URL}/media/hls/${STREAM_ID}/2/index.m3u8?token=t`,
  mode: "transcode-software",
  video: { codec: "h264", width: 1920, height: 1080, dynamicRange: "sdr" },
  transcode: {
    stages: [
      { op: "decode", domain: "cpu", impl: "decode.cpu" },
      { op: "encode", domain: "cpu", impl: "encode.cpu" },
    ],
    changes: [
      {
        at: 1_760_000_000_000,
        generation: 2,
        cause: "source",
        excluded: ["decode.qsv", "encode.qsv"],
        reason: "file-only",
      },
    ],
  },
};

/** A transcode whose one change gives `reason`, as a media service of any version may answer. */
const transcodeGiving = (reason: string) => ({
  stages: [{ op: "encode", domain: "cpu", impl: "encode.cpu" }],
  changes: [
    { at: 1_760_000_000_000, generation: 2, cause: "source", excluded: ["encode.qsv"], reason },
  ],
});

const GIVING = /^\/(?<kind>reason|failing)\/(?<reason>[a-z-]+)(?<route>\/api\/playback\/\w+)$/u;

/**
 * What the media server answers below `/reason/<code>`: negotiations and seeks whose change gives
 * `<code>`; below `/failing/<code>`, a `TranscodeFailed` giving it. Null for any other route.
 */
const answerGiving = (url: string | undefined) => {
  const { kind, reason = "", route } = GIVING.exec(url ?? "")?.groups ?? {};

  if (kind === "failing") {
    return {
      status: 500,
      body: { _tag: "TranscodeFailed", streamId: STREAM_ID, mode: "transcode-qsv", reason },
    };
  }

  if (route === "/api/playback/negotiate") {
    return {
      status: 200,
      body: { ...NEGOTIATED, mode: "transcode-software", transcode: transcodeGiving(reason) },
    };
  }

  return route === "/api/playback/seek"
    ? { status: 200, body: { ...RELOADED, transcode: transcodeGiving(reason) } }
    : null;
};

/** What the media server answers on the route `url`; null for any other. */
const answerTo = (url: string | undefined) => {
  if (url === "/api/playback/receiver") return { credential: CREDENTIAL };

  if (url === "/api/playback/seek") return RELOADED;

  return url === "/api/playback/negotiate" ? NEGOTIATED : null;
};

const mediaServer = createServer((request: IncomingMessage, response: ServerResponse) => {
  let text = "";

  request.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });

  request.on("end", () => {
    received.push(request.url ?? "");
    receivedBodies.push(text);
    receivedTypes.push(request.headers["content-type"] ?? "");

    const { status, body } = answerGiving(request.url) ?? {
      status: 200,
      body: answerTo(request.url),
    };

    response.writeHead(status, { "content-type": "application/json" });
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

describe("following a stream into its next generation", () => {
  it("takes the playlist, mode, picture, and stages the seek names, the rest as it was", async () => {
    const session = { ...started, mediaBaseUrl: mediaServiceUrl };

    const moved = await Effect.runPromise(
      Effect.gen(function* () {
        const stream = yield* negotiate(session, DESKTOP, Milliseconds.make(0), Option.none());
        const playback = { started: session, stream };
        const next = yield* seekStream(playback, Milliseconds.make(4_000));

        return { playback, next: Option.map(next, (seek) => inGeneration(playback, seek)) };
      }),
    );

    expect(Option.isSome(moved.next)).toBe(true);

    if (Option.isNone(moved.next)) return;
    const { stream } = moved.next.value;

    expect(moved.next.value.started).toBe(moved.playback.started);
    expect(stream).toMatchObject({
      url: RELOADED.playlistUrl,
      generation: 2,
      mode: "transcode-software",
      video: { width: 1920, height: 1080 },
      transcode: RELOADED.transcode,
      streamId: STREAM_ID,
      durationSeconds: 600,
    });
  });
});

/** What a player gets when every answer gives `reason`: the stream, its next generation, a failure. */
const playedGiving = (reason: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const session = { ...started, mediaBaseUrl: `${mediaServiceUrl}reason/${reason}/` };
      const stream = yield* negotiate(session, DESKTOP, Milliseconds.make(0), Option.none());
      const playback = { started: session, stream };
      const moved = yield* seekStream(playback, Milliseconds.make(4_000));

      const failure = yield* Effect.flip(
        negotiate(
          { ...started, mediaBaseUrl: `${mediaServiceUrl}failing/${reason}/` },
          DESKTOP,
          Milliseconds.make(0),
          Option.none(),
        ),
      );

      return {
        playing: { mode: stream.mode, transcode: stream.transcode },
        moved: Option.map(moved, (seek) => {
          const next = inGeneration(playback, seek).stream;

          return { generation: next.generation, transcode: next.transcode };
        }),
        failed: Predicate.isTagged(failure, "TranscodeFailed")
          ? { reason: failure.reason, recovery: recoveryFor(failure) }
          : failure,
      };
    }),
  );

/** What a player gets when every answer gives `reason`, the known codes and newer ones alike. */
const playedAsKnown = (reason: string) => ({
  playing: { mode: "transcode-software", transcode: transcodeGiving(reason) },
  moved: Option.some({ generation: 2, transcode: transcodeGiving(reason) }),
  failed: { reason, recovery: "fail" },
});

describe("reading a reason this client's list lacks", () => {
  it("plays, moves, and fails on a code a newer server added as it does on a known one", async () => {
    expect(await playedGiving("file-only")).toStrictEqual(playedAsKnown("file-only"));
    expect(await playedGiving("driver-reset")).toStrictEqual(playedAsKnown("driver-reset"));
  });
});

describe("lending a Cast receiver a credential", () => {
  it("sends the start's ticket and answers the credential, kept redacted", async () => {
    received.length = 0;
    receivedBodies.length = 0;

    const credential = await Effect.runPromise(
      lendToReceiver({ mediaBaseUrl: mediaServiceUrl, token: started.token }),
    );

    expect(received).toStrictEqual(["/api/playback/receiver"]);
    expect(JSON.parse(receivedBodies[0] ?? "")).toStrictEqual({ token: started.token });
    expect(Redacted.value(credential)).toBe(CREDENTIAL);
    expect(JSON.stringify({ credential })).not.toContain(CREDENTIAL);
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
