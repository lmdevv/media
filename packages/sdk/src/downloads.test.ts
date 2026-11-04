import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";

import { StartedPlayback } from "@media/contracts/models/playback";
import { Effect, Option, Predicate, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prepare } from "./downloads";

const received: Array<{ readonly url: string; readonly body: string }> = [];

const answers: Array<readonly [number, unknown]> = [];

const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  let body = "";

  request.on("data", (chunk: Buffer) => {
    body += chunk.toString("utf8");
  });

  request.on("end", () => {
    received.push({ url: request.url ?? "", body });
    const [status, answer] = answers.shift() ?? [404, ""];

    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(answer));
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

const started = () =>
  Schema.decodeSync(StartedPlayback)({
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
    token: "v1.payload.signature",
    tokenExpiresAt: 1_760_000_000_000,
    mediaBaseUrl: `${base}/`,
    resumePositionMs: 0,
  });

const capabilities = {
  containers: ["mp4"],
  videoCodecs: [{ codec: "h264" }],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 1920,
  maxHeight: 1080,
  hls: true,
  mse: false,
} as const;

const run = (audio: Option.Option<number>) =>
  Effect.runPromise(Effect.result(prepare(started(), capabilities, "standard", audio)));

describe("Downloads.prepare", () => {
  it("asks with the token and quality, and reads progress, then the ready file", async () => {
    answers.push(
      [200, { _tag: "Preparing", progress: 0.25, estimatedBytes: 1_000_000 }],
      [
        200,
        {
          _tag: "Ready",
          mode: "remux",
          url: `${base}/media/downloads/file-1/abc.mp4?token=t`,
          sizeBytes: 900_000,
          container: "mp4",
          durationSeconds: 600,
          video: { codec: "h264", width: 1920, height: 1080, dynamicRange: "sdr" },
          audio: null,
          subtitles: [],
          expiresAt: 1_760_000_000_000,
        },
      ],
    );

    expect(await run(Option.some(2))).toMatchObject({
      success: { _tag: "Preparing", progress: 0.25 },
    });
    expect(received.at(-1)?.url).toBe("/api/downloads/prepare");
    expect(JSON.parse(received.at(-1)?.body ?? "")).toMatchObject({
      token: "v1.payload.signature",
      quality: "standard",
      audioStreamIndex: 2,
    });

    expect(await run(Option.none())).toMatchObject({
      success: { _tag: "Ready", mode: "remux", sizeBytes: 900_000 },
    });
  });

  it("reports the playback API's tagged failures", async () => {
    answers.push([507, { _tag: "InsufficientTranscodeSpace", freeBytes: 1, requiredBytes: 2 }]);

    expect(await run(Option.none())).toMatchObject({
      failure: { _tag: "InsufficientTranscodeSpace" },
    });
  });
});
