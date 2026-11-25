import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { LibraryId } from "@media/contracts/ids";
import { type ClientCapabilities, NegotiateResponse } from "@media/contracts/media-playback";

import * as LibraryScanner from "../library/library-scanner.ts";
import * as MemoryLibrary from "../library/memory-library.ts";
import * as MediaTools from "../media/media-tools.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import { signTestToken } from "../testing/test-tokens.ts";

const hasFfmpeg = await ffmpegAvailable();

const FILM = "Lossless (2019)/Lossless (2019).mkv";

const browser: ClientCapabilities = {
  containers: [],
  videoCodecs: [{ codec: "h264", maxBitDepth: 8 }],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 1920,
  maxHeight: 1080,
  hls: false,
  mse: true,
};

const decodeNegotiation = Schema.decodeUnknownEffect(Schema.toCodecJson(NegotiateResponse));

/** Four seconds of lossless FFV1 at 16 bits per component, 4:4:4, in a library of its own. */
const addFilm = Effect.fn(function* (library: string) {
  const workspace = yield* FixtureWorkspace.Service;
  const tools = yield* MediaTools.Service;
  const scanner = yield* LibraryScanner.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const libraryId = LibraryId.make(library);
  const root = path.join(workspace.root, library);
  const output = path.join(root, FILM);

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
    "testsrc2=size=320x240:rate=24:duration=4",
    "-pix_fmt",
    "yuv444p16le",
    "-c:v",
    "ffv1",
    "-g",
    "24",
    output,
  ]);
  yield* scanner.scan({ libraryId, root, mode: "incremental" });

  return MemoryLibrary.fileIdOf(libraryId, FILM);
});

const options = { excludeTestServices: true, timeout: "120 seconds" } as const;

describe.skipIf(!hasFfmpeg)("the software floor", () => {
  layer(
    MediaTestServer.layer({ HARDWARE_ACCELERATION: "none" }),
    options,
  )((it) => {
    it.effect(
      "plays a 16-bit 4:4:4 FFV1 file on a server without a GPU",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const fileId = yield* addFilm("lossless");

          const answer = yield* HttpClient.execute(
            HttpClientRequest.post(`${server.baseUrl}/api/playback/negotiate`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                token: signTestToken({ fid: fileId, sid: "lossless" }),
                capabilities: browser,
              }),
            ),
          ).pipe(Effect.orDie);

          const body = yield* answer.json.pipe(Effect.orDie);

          assert.strictEqual(answer.status, 200, JSON.stringify(body));
          const stream = yield* decodeNegotiation(body).pipe(Effect.orDie);

          assert.strictEqual(stream.mode, "transcode-software");

          const playlist = new URL(stream.url);

          const segment = yield* HttpClient.get(
            `${server.baseUrl}${new URL(`1.m4s${playlist.search}`, playlist).pathname}${playlist.search}`,
          ).pipe(Effect.orDie);

          assert.strictEqual(segment.status, 200);
        }),
      60_000,
    );
  });
});
