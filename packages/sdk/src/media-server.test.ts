import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";

import {
  ClientDiagnosticsRequest,
  ClientErrorReport,
  PlayerObservation,
} from "@media/contracts/diagnostics";
import { StartedPlayback } from "@media/contracts/models/playback";
import { StreamId } from "@media/contracts/media-playback";
import { Effect, Exit, Option, Predicate, Redacted, Schema, Scope } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createMediaServer } from "./media-server";
import type { Playback } from "./playback";
import { reportDiagnostics } from "./player-diagnostics";
import { makeFakePlayer } from "./testing/fake-player";

interface Received {
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: string;
}

const received: Array<Received> = [];

/** How the server answers client errors: accepted, or refused for its budget. */
const answer = { clientErrors: 204 };

const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  let body = "";

  request.on("data", (chunk: Buffer) => {
    body += chunk.toString("utf8");
  });

  request.on("end", () => {
    const path = request.url ?? "";

    received.push({ path, authorization: request.headers.authorization, body });

    if (path === "/api/client-errors" && answer.clientErrors === 429) {
      response
        .writeHead(429, { "content-type": "application/json", "retry-after": "60" })
        .end(JSON.stringify({ code: "rate_limited", message: "Too many reports" }));

      return;
    }

    response.writeHead(204).end();
  });
});

let base = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (address === null || Predicate.isString(address)) throw new Error("The server is not on TCP");

  base = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  received.length = 0;
  answer.clientErrors = 204;
});

const signedIn = () =>
  createMediaServer({ url: base, accessToken: () => Promise.resolve("jwt-1") });

const signedOut = () => createMediaServer({ url: base, accessToken: () => Promise.resolve(null) });

const decodeBatch = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.toCodecJson(ClientDiagnosticsRequest)),
);

const decodeReport = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.toCodecJson(ClientErrorReport)),
);

const context = {
  platform: "web",
  appVersion: "0.2.0",
  kind: "render",
  route: "/movies/watch/title-1",
} as const;

const playbackAt = (mediaBaseUrl: string): Playback => ({
  started: Schema.decodeSync(StartedPlayback)({
    sessionId: "playback-1",
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
        container: "mkv",
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
    token: "t1.ticket",
    tokenExpiresAt: 1_760_000_000_000,
    mediaBaseUrl,
    resumePositionMs: 0,
  }),
  stream: {
    mode: "remux",
    url: `${mediaBaseUrl}/media/hls/AAAAAAAAAAAAAAAAAAAAAA/1/index.m3u8?ticket=t1.ticket`,
    streamId: StreamId.make("AAAAAAAAAAAAAAAAAAAAAA"),
    generation: 1,
    startSeconds: 0,
    durationSeconds: 600,
    video: { codec: "h264", width: 1920, height: 1080, dynamicRange: "sdr" },
    subtitles: [],
    expiresAt: 1_760_000_000_000,
  },
});

describe("createMediaServer", () => {
  it("sends a player's events as the signed-in person, naming the playback by its ticket", async () => {
    const player = await Effect.runPromise(makeFakePlayer(0));
    const scope = Scope.makeUnsafe();
    const playback = playbackAt(base);

    const recorder = await Effect.runPromise(
      reportDiagnostics(player, {
        platform: "web",
        playback: () => Option.some(playback),
        bufferedAheadSeconds: () => 0,
        frames: () => Option.none(),
        send: signedIn().reportClientEvents,
      }).pipe(Scope.provide(scope)),
    );

    recorder.record(PlayerObservation.cases.Attached.make({ mode: "remux", engine: "hls.js" }));
    await Effect.runPromise(Scope.close(scope, Exit.void));

    expect(received.map((each) => [each.path, each.authorization])).toEqual([
      ["/api/playback/diagnostics", "Bearer jwt-1"],
    ]);

    const batch = decodeBatch(received[0]?.body ?? "");

    expect(Redacted.value(batch.token)).toBe("t1.ticket");
    expect(batch.events).toMatchObject([
      { streamId: "AAAAAAAAAAAAAAAAAAAAAA", observation: { _tag: "Attached" } },
    ]);
  });

  it("sends no events while signed out", async () => {
    await signedOut().reportClientEvents({
      token: Redacted.make("t1.ticket"),
      platform: "web",
      events: [
        {
          ageMs: 0,
          observation: PlayerObservation.cases.Attached.make({
            mode: "direct",
            engine: "html-video",
          }),
        },
      ],
    });

    expect(received).toEqual([]);
  });

  it("writes a caught error once per repeat window, as the signed-in person", async () => {
    const media = signedIn();

    await media.reportCaught(new Error("Boom"), context);
    await media.reportCaught(new Error("Boom"), context);
    await media.reportCaught(new Error("Another"), context);

    expect(received.map((each) => [each.path, each.authorization])).toEqual([
      ["/api/client-errors", "Bearer jwt-1"],
      ["/api/client-errors", "Bearer jwt-1"],
    ]);
    expect(received.map((each) => decodeReport(each.body).message)).toEqual(["Boom", "Another"]);
  });

  it("pauses caught errors after the server refuses one for its budget, and never rejects", async () => {
    const media = signedIn();

    answer.clientErrors = 429;
    await media.reportCaught(new Error("First"), context);
    answer.clientErrors = 204;
    await media.reportCaught(new Error("Second"), context);

    expect(received.map((each) => decodeReport(each.body).message)).toEqual(["First"]);
  });

  it("writes nothing while signed out", async () => {
    await signedOut().reportCaught(new Error("Boom"), context);

    expect(received).toEqual([]);
  });
});
