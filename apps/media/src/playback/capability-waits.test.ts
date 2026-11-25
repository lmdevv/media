import { assert, describe, layer } from "@effect/vitest";
import { Clock, Duration, Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { type ClientCapabilities, NegotiateResponse } from "@media/contracts/media-playback";

import { writeFakeFfmpeg } from "../testing/fake-ffmpeg.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import { signTestToken } from "../testing/test-tokens.ts";

const hasFfmpeg = await ffmpegAvailable();

/** Opening the Quick Sync device never returns, as a wedged driver's would not. */
const wedgedDevice = await writeFakeFfmpeg({
  rules: [{ token: "nullsrc=s=64x64", runs: "any", hang: true }],
});

/** A browser that takes MP4 and no AC-3, with a screen `maxHeight` tall. */
const browser = (
  containers: ClientCapabilities["containers"],
  maxHeight: number,
): ClientCapabilities => ({
  containers,
  videoCodecs: [{ codec: "h264", maxBitDepth: 8 }],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 1920,
  maxHeight,
  hls: false,
  mse: true,
});

/** Plays the H.264/AAC MP4 as it is. */
const chromium = browser(["mp4"], 1080);

/** Takes no MKV and no AC-3: the remux's video is copied, its audio converted. */
const mkvless = browser([], 1080);

/** A small screen, where every file is scaled down and so encoded. */
const smallScreen = browser([], 120);

const decodeNegotiation = Schema.decodeUnknownEffect(Schema.toCodecJson(NegotiateResponse));

/** Negotiates `relativePath` for `capabilities`; its answer and how long it took. */
const negotiateTimed = Effect.fn(function* (
  relativePath: string,
  sid: string,
  capabilities: ClientCapabilities,
) {
  const server = yield* MediaTestServer.Service;
  const started = yield* Clock.currentTimeMillis;

  const response = yield* HttpClient.execute(
    HttpClientRequest.post(`${server.baseUrl}/api/playback/negotiate`).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        token: signTestToken({ fid: server.fileId("movies", relativePath), sid }),
        capabilities,
      }),
    ),
  ).pipe(Effect.timeout(Duration.seconds(20)), Effect.orDie);

  const body = yield* response.json.pipe(Effect.orDie);

  assert.strictEqual(response.status, 200, JSON.stringify(body));

  return {
    answer: yield* decodeNegotiation(body).pipe(Effect.orDie),
    millis: (yield* Clock.currentTimeMillis) - started,
  };
});

const options = { excludeTestServices: true, timeout: "120 seconds" } as const;

describe.skipIf(!hasFfmpeg)("negotiations and the capability service", () => {
  layer(
    MediaTestServer.layer(
      { FFMPEG_PATH: wedgedDevice, HARDWARE_ACCELERATION: "qsv" },
      { probeTimeout: Duration.seconds(60) },
    ),
    options,
  )((it) => {
    it.effect(
      "plays a file directly, or copies it, at once while the GPU device has not answered",
      () =>
        Effect.gen(function* () {
          const { library } = yield* FixtureWorkspace.Service;
          const direct = yield* negotiateTimed(library.directMovie, "direct", chromium);

          assert.strictEqual(direct.answer.mode, "direct");
          assert.isBelow(direct.millis, 2000);

          const copied = yield* negotiateTimed(library.remuxMovie, "copied", mkvless);

          assert.strictEqual(copied.answer.mode, "audio-transcode");
          assert.isBelow(copied.millis, 5000);
        }),
      60_000,
    );
  });

  layer(
    MediaTestServer.layer(
      { FFMPEG_PATH: wedgedDevice, HARDWARE_ACCELERATION: "qsv" },
      { probeTimeout: Duration.seconds(60), negotiationBudget: Duration.seconds(3) },
    ),
    options,
  )((it) => {
    it.effect(
      "waits for the GPU device no longer than an encode's negotiation budget",
      () =>
        Effect.gen(function* () {
          const { library } = yield* FixtureWorkspace.Service;
          const encoded = yield* negotiateTimed(library.directMovie, "encoded", smallScreen);

          assert.strictEqual(encoded.answer.mode, "transcode-software");
          assert.isBelow(encoded.millis, 10_000);
        }),
      60_000,
    );
  });
});
