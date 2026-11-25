import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { LibraryId, type MediaFileId } from "@media/contracts/ids";
import { type ClientCapabilities, NegotiateResponse } from "@media/contracts/media-playback";

import * as LibraryScanner from "../library/library-scanner.ts";
import * as MemoryLibrary from "../library/memory-library.ts";
import * as MediaTools from "../media/media-tools.ts";
import { writeFakeFfmpeg } from "../testing/fake-ffmpeg.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import { signTestToken } from "../testing/test-tokens.ts";

const hasFfmpeg = await ffmpegAvailable();

const cutsOnlyAtStart = await writeFakeFfmpeg({ hlsFragmentSeconds: 1000 });

const OPEN_GOP = LibraryId.make("open-gop");

const OPEN_GOP_FILE = "Open Gop (2011)/Open Gop (2011).mkv";

const hevcScreen: ClientCapabilities = {
  containers: [],
  videoCodecs: [{ codec: "hevc", maxBitDepth: 8 }],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 1920,
  maxHeight: 1080,
  hls: false,
  mse: true,
};

/** Matroska stores times in whole milliseconds; the copies keep them on finer clocks. */
const ROUNDING = 0.0015;

const decodeNegotiation = Schema.decodeUnknownEffect(Schema.toCodecJson(NegotiateResponse));

const PacketTimes = Schema.fromJsonString(
  Schema.Struct({
    packets: Schema.Array(
      Schema.Struct({ stream_index: Schema.Int, pts_time: Schema.FiniteFromString }),
    ),
  }),
);

const FailedBody = Schema.fromJsonString(
  Schema.TaggedStruct("TranscodeFailed", { detail: Schema.String }),
);

interface Packets {
  readonly video: ReadonlyArray<number>;
  readonly audio: ReadonlyArray<number>;
}

const audioFromZero = (times: ReadonlyArray<number>): ReadonlyArray<number> =>
  times.filter((time) => time >= 0);

const probePackets = Effect.fn("SegmentCuts.probePackets")(function* (file: string) {
  const tools = yield* MediaTools.Service;

  const { packets } = yield* Schema.decodeEffect(PacketTimes)(
    yield* tools.ffprobe([
      "-v",
      "error",
      "-show_entries",
      "packet=stream_index,pts_time",
      "-of",
      "json",
      file,
    ]),
  );

  const of = (stream: number) =>
    packets
      .filter((packet) => packet.stream_index === stream)
      .map((packet) => packet.pts_time)
      .toSorted((left, right) => left - right);

  return { video: of(0), audio: of(1) } satisfies Packets;
});

const probeSegment = Effect.fn("SegmentCuts.probeSegment")(function* (
  init: Uint8Array,
  segment: Uint8Array,
) {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* fs.makeTempFileScoped({ suffix: ".mp4" });

  yield* fs.writeFile(file, Buffer.concat([init, segment]));

  return yield* probePackets(file);
}, Effect.scoped);

const addOpenGop = Effect.gen(function* () {
  const workspace = yield* FixtureWorkspace.Service;
  const tools = yield* MediaTools.Service;
  const scanner = yield* LibraryScanner.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(workspace.root, "open-gop");
  const file = path.join(root, OPEN_GOP_FILE);

  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* tools.ffmpeg([
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=24000/1001:duration=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=30",
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-c:v",
    "libx265",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-x265-params",
    "log-level=error:keyint=240:min-keyint=240:scenecut=0:open-gop=1:bframes=3",
    "-c:a",
    "aac",
    file,
  ]);
  yield* scanner.scan({ libraryId: OPEN_GOP, root, mode: "incremental" });

  const packets = yield* probePackets(file);

  return {
    fileId: MemoryLibrary.fileIdOf(OPEN_GOP, OPEN_GOP_FILE),
    source: { video: packets.video, audio: audioFromZero(packets.audio) },
  };
}).pipe(Effect.orDie);

const fetched = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      response.arrayBuffer.pipe(
        Effect.map((body) => ({ status: response.status, body: new Uint8Array(body) })),
      ),
    ),
    Effect.orDie,
  );

const openStream = Effect.fn("SegmentCuts.openStream")(function* (fileId: MediaFileId) {
  const server = yield* MediaTestServer.Service;

  const negotiated = yield* HttpClient.execute(
    HttpClientRequest.post(`${server.baseUrl}/api/playback/negotiate`).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        token: signTestToken({ fid: fileId }),
        capabilities: hevcScreen,
      }),
    ),
  ).pipe(
    Effect.flatMap((response) => response.json),
    Effect.flatMap(decodeNegotiation),
    Effect.orDie,
  );

  const playlist = new URL(negotiated.url.replace(/^https?:\/\/[^/]+/u, server.baseUrl));
  const text = new TextDecoder().decode((yield* fetched(playlist.toString())).body);
  const init = /#EXT-X-MAP:URI="([^"]+)"/u.exec(text)?.[1] ?? "";

  return {
    mode: negotiated.mode,
    init: new URL(init, playlist).toString(),
    segments: text
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => new URL(line, playlist).toString()),
  };
});

const ascending = (times: ReadonlyArray<number>): ReadonlyArray<number> =>
  times.toSorted((left, right) => left - right);

const checkEachOnce = (
  served: ReadonlyArray<number>,
  source: ReadonlyArray<number>,
  label: string,
) => {
  const sorted = ascending(served);

  const differ = Array.from(
    { length: Math.max(sorted.length, source.length) },
    (_, index) => index,
  ).find(
    (index) =>
      !(Math.abs((sorted[index] ?? Number.NaN) - (source[index] ?? Number.NaN)) <= ROUNDING),
  );

  assert.isTrue(
    differ === undefined,
    `${label}: ${String(sorted.length)} packets served, ${String(source.length)} in the source; packet ${String(differ)} differs`,
  );
};

describe.skipIf(!hasFfmpeg)("segment cuts", () => {
  layer(MediaTestServer.layer(), { excludeTestServices: true, timeout: "120 seconds" })((it) => {
    it.effect(
      "serves an open-GOP HEVC copy with each source packet in exactly one segment",
      () =>
        Effect.gen(function* () {
          const { fileId, source } = yield* addOpenGop;
          const stream = yield* openStream(fileId);

          assert.strictEqual(stream.mode, "remux");
          assert.isAtLeast(stream.segments.length, 3, "segments cut at the CRA keyframes");

          const init = yield* fetched(stream.init);

          assert.strictEqual(init.status, 200, "init segment");

          const served = yield* Effect.forEach(stream.segments, fetched);

          for (const [index, segment] of served.entries()) {
            assert.strictEqual(segment.status, 200, `segment ${String(index)}`);
          }

          const packets = yield* Effect.forEach(served, (segment) =>
            probeSegment(init.body, segment.body),
          ).pipe(Effect.orDie);

          checkEachOnce(
            packets.flatMap((segment) => segment.video),
            source.video,
            "video",
          );
          checkEachOnce(
            packets.flatMap((segment) => segment.audio),
            source.audio,
            "audio",
          );
        }),
      120_000,
    );
  });

  layer(MediaTestServer.layer({ FFMPEG_PATH: cutsOnlyAtStart }), {
    excludeTestServices: true,
    timeout: "120 seconds",
  })((it) => {
    it.effect(
      "fails a segment whose planned start ffmpeg did not cut rather than serve another segment's fragment",
      () =>
        Effect.gen(function* () {
          const { fileId } = yield* addOpenGop;
          const stream = yield* openStream(fileId);

          assert.strictEqual(stream.mode, "remux");

          const init = yield* fetched(stream.init);

          assert.strictEqual(init.status, 200, "init segment");

          const answers = yield* Effect.forEach(stream.segments, fetched);

          assert.deepStrictEqual(
            answers.map((answer) => answer.status),
            [200, ...stream.segments.slice(1).map(() => 500)],
            "only the first planned start was cut",
          );

          for (const [index, answer] of answers.entries()) {
            if (index === 0) continue;

            const failure = yield* Schema.decodeEffect(FailedBody)(
              new TextDecoder().decode(answer.body),
            ).pipe(Effect.orDie);

            assert.include(failure.detail, `did not cut at planned segment ${String(index)}`);
          }

          const packets = yield* Effect.forEach(
            answers.filter((answer) => answer.status === 200),
            (answer) => probeSegment(init.body, answer.body),
          ).pipe(Effect.orDie);

          for (const kind of ["video", "audio"] as const) {
            const served = ascending(packets.flatMap((segment) => segment[kind]));

            assert.isTrue(
              served.every(
                (time, index) => index === 0 || time - (served[index - 1] ?? 0) > ROUNDING,
              ),
              `no ${kind} packet is served twice`,
            );
          }
        }),
      120_000,
    );
  });
});
