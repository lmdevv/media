import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { LibraryId, type MediaFileId } from "@media/contracts/ids";
import {
  type ClientCapabilities,
  NegotiateResponse,
  SeekResponse,
} from "@media/contracts/media-playback";

import * as LibraryScanner from "../library/library-scanner.ts";
import * as MemoryLibrary from "../library/memory-library.ts";
import * as MediaTools from "../media/media-tools.ts";
import { ffmpegAvailable, qsvUsable, vaapiUsable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import { signTestToken } from "../testing/test-tokens.ts";

const hasFfmpeg = await ffmpegAvailable();

const hasQsv = hasFfmpeg && (await qsvUsable());

const hasVaapi = hasFfmpeg && (await vaapiUsable());

const SOURCES = LibraryId.make("output-codecs");

/** MPEG-2, which none of the clients below plays, so every one of them gets an encode. */
const SOURCE_FILE = "Mpeg Two (2012)/Mpeg Two (2012).mkv";

const SOURCE_SECONDS = 14;

const FRAME = 1 / 24;

const client = (videoCodecs: ClientCapabilities["videoCodecs"]): ClientCapabilities => ({
  containers: [],
  videoCodecs,
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 1920,
  maxHeight: 1080,
  hls: false,
  mse: true,
});

interface Case {
  readonly name: string;
  readonly client: ClientCapabilities;
  /** The codec, its profile, and its sample entry, as ffprobe names them. */
  readonly codec: string;
  readonly profile: string;
  readonly tag: string;
  /** Where the encode runs on a GPU path; a CPU path always encodes on the CPU. */
  readonly onGpu: boolean;
}

const h264Only: Case = {
  name: "an H.264 browser",
  client: client([{ codec: "h264" }]),
  codec: "h264",
  profile: "High",
  tag: "avc1",
  onGpu: true,
};

const hevcOnly: Case = {
  name: "a device that plays only HEVC",
  client: client([{ codec: "hevc", profiles: ["Main"] }]),
  codec: "hevc",
  profile: "Main",
  tag: "hvc1",
  onGpu: true,
};

const av1Only: Case = {
  name: "a device that plays only AV1",
  client: client([{ codec: "av1", profiles: ["Main"] }]),
  codec: "av1",
  profile: "Main",
  tag: "av01",
  onGpu: true,
};

/** Plays H.264 and HEVC: a GPU encodes HEVC for it, a CPU H.264. */
const appleLike = client([{ codec: "h264" }, { codec: "hevc" }]);

const CPU_CASES: ReadonlyArray<Case> = [
  h264Only,
  hevcOnly,
  av1Only,
  { ...h264Only, name: "a device that plays H.264 and HEVC, from a CPU", client: appleLike },
];

const GPU_CASES: ReadonlyArray<Case> = [
  h264Only,
  hevcOnly,
  av1Only,
  { ...hevcOnly, name: "a device that plays H.264 and HEVC, from a GPU", client: appleLike },
];

const decodeNegotiation = Schema.decodeUnknownEffect(Schema.toCodecJson(NegotiateResponse));

const decodeSeek = Schema.decodeUnknownEffect(Schema.toCodecJson(SeekResponse));

const Probed = Schema.fromJsonString(
  Schema.Struct({
    streams: Schema.Array(
      Schema.Struct({
        codec_name: Schema.String,
        profile: Schema.optional(Schema.String),
        codec_tag_string: Schema.String,
      }),
    ),
    packets: Schema.Array(
      Schema.Struct({ pts_time: Schema.FiniteFromString, flags: Schema.String }),
    ),
  }),
);

const addSource = Effect.gen(function* () {
  const workspace = yield* FixtureWorkspace.Service;
  const tools = yield* MediaTools.Service;
  const scanner = yield* LibraryScanner.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(workspace.root, "output-codecs");
  const file = path.join(root, SOURCE_FILE);

  if (!(yield* fs.exists(file))) {
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
      `testsrc2=size=320x180:rate=24:duration=${String(SOURCE_SECONDS)}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:sample_rate=48000:duration=${String(SOURCE_SECONDS)}`,
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-c:v",
      "mpeg2video",
      "-g",
      "12",
      "-c:a",
      "aac",
      file,
    ]);
  }

  yield* scanner.scan({ libraryId: SOURCES, root, mode: "incremental" });

  return MemoryLibrary.fileIdOf(SOURCES, SOURCE_FILE);
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

/** The body of a negotiation, or of a seek or stop of a stream. */
type RequestBody =
  | { readonly token: string; readonly capabilities: ClientCapabilities }
  | { readonly token: string; readonly streamId: string; readonly positionSeconds?: number };

const posted = (url: string, body: RequestBody) =>
  HttpClient.execute(HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body))).pipe(
    Effect.flatMap((response) => response.json),
    Effect.orDie,
  );

/** The playlist's segments with the time each starts at, from its durations. */
const segmentsOf = Effect.fn("OutputCodecs.segmentsOf")(function* (playlistUrl: string) {
  const playlist = new URL(playlistUrl);
  const text = new TextDecoder().decode((yield* fetched(playlist.href)).body);
  const lines = text.split("\n");
  const init = /#EXT-X-MAP:URI="([^"]+)"/u.exec(text)?.[1] ?? "";
  const segments: Array<{ readonly url: string; readonly start: number }> = [];
  let start = 0;

  for (const [index, line] of lines.entries()) {
    const duration = /^#EXTINF:([\d.]+),/u.exec(line)?.[1];
    const uri = lines[index + 1];

    if (duration !== undefined && uri !== undefined) {
      segments.push({ url: new URL(uri, playlist).href, start });
      start += Number(duration);
    }
  }

  return { init: new URL(init, playlist).href, segments };
});

/** What ffprobe reads from the init segment followed by `segment`: its stream and packets. */
const probeSegment = Effect.fn("OutputCodecs.probeSegment")(function* (
  init: Uint8Array,
  segment: Uint8Array,
) {
  const fs = yield* FileSystem.FileSystem;
  const tools = yield* MediaTools.Service;
  const file = yield* fs.makeTempFileScoped({ suffix: ".mp4" });

  yield* fs.writeFile(file, Buffer.concat([init, segment]));

  return yield* Schema.decodeEffect(Probed)(
    yield* tools.ffprobe([
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,profile,codec_tag_string:packet=pts_time,flags",
      "-of",
      "json",
      file,
    ]),
  );
}, Effect.scoped);

/**
 * Fetches the segments of `playlistUrl` from the one that holds `position` on and checks each:
 * served, in the case's codec, profile, and sample entry, and opening on a keyframe at its
 * planned start that no picture of the segment is presented before.
 */
const checkSegments = Effect.fn("OutputCodecs.checkSegments")(function* (
  playlistUrl: string,
  position: number,
  expected: Case,
) {
  const { init, segments } = yield* segmentsOf(playlistUrl);
  const initBytes = yield* fetched(init);

  assert.strictEqual(initBytes.status, 200, "init segment");

  const holding = segments.findLastIndex((segment) => segment.start <= position + FRAME / 2);
  const checked = segments.slice(Math.max(0, holding));

  assert.isAtLeast(checked.length, 2, "segments to check");

  for (const segment of checked) {
    const served = yield* fetched(segment.url);
    const at = `${expected.name}, the segment at ${segment.start.toFixed(3)} s`;

    assert.strictEqual(served.status, 200, `${at}: ${new TextDecoder().decode(served.body)}`);
    const probed = yield* probeSegment(initBytes.body, served.body).pipe(Effect.orDie);
    const [stream] = probed.streams;
    const [first] = probed.packets;

    assert.deepStrictEqual(
      [stream?.codec_name, stream?.profile, stream?.codec_tag_string],
      [expected.codec, expected.profile, expected.tag],
      at,
    );
    assert.isDefined(first, at);
    assert.isTrue(first.flags.startsWith("K"), `${at}: the first packet is a keyframe`);
    assert.approximately(first.pts_time, segment.start, FRAME / 2, `${at}: where it starts`);
    assert.approximately(
      Math.min(...probed.packets.map((packet) => packet.pts_time)),
      first.pts_time,
      FRAME / 2,
      `${at}: no picture is presented before its keyframe, as an open GOP's leading pictures are`,
    );
  }
});

/**
 * Negotiates `expected.client`, checks the codec the answer names and where the encode runs, then
 * every segment from the start, and after a seek every segment from there.
 */
const plays = Effect.fn("OutputCodecs.plays")(function* (
  expected: Case,
  path: "cpu" | "qsv" | "vaapi",
) {
  const server = yield* MediaTestServer.Service;
  const fileId: MediaFileId = yield* addSource;
  const token = signTestToken({ fid: fileId, sid: `output-${path}-${expected.codec}` });
  const local = (url: string) => url.replace(/^https?:\/\/[^/]+/u, server.baseUrl);

  const negotiated = yield* decodeNegotiation(
    yield* posted(`${server.baseUrl}/api/playback/negotiate`, {
      token,
      capabilities: expected.client,
    }),
  ).pipe(Effect.orDie);

  const domain = path === "cpu" || !expected.onGpu ? "cpu" : path;

  assert.strictEqual(
    negotiated.mode,
    domain === "cpu" ? "transcode-software" : `transcode-${domain}`,
    expected.name,
  );
  assert.strictEqual(negotiated.video.codec, expected.codec, expected.name);
  assert.deepInclude(negotiated.transcode?.stages.at(-1), { op: "encode", domain }, expected.name);

  yield* checkSegments(local(negotiated.url), 0, expected);

  const sought = yield* decodeSeek(
    yield* posted(`${server.baseUrl}/api/playback/seek`, {
      token,
      streamId: negotiated.streamId ?? "",
      positionSeconds: 7.3,
    }),
  ).pipe(Effect.orDie);

  assert.strictEqual(sought.video.codec, expected.codec, `${expected.name}, after a seek`);
  yield* checkSegments(local(sought.playlistUrl), 7.3, expected);
  yield* posted(`${server.baseUrl}/api/playback/stop`, {
    token,
    streamId: negotiated.streamId ?? "",
  });
});

describe.skipIf(!hasFfmpeg)("output codecs", () => {
  layer(MediaTestServer.layer(), { excludeTestServices: true, timeout: "180 seconds" })((it) => {
    for (const expected of CPU_CASES) {
      it.effect(
        `encodes ${expected.codec} on the CPU for ${expected.name}`,
        () => plays(expected, "cpu"),
        120_000,
      );
    }
  });

  for (const path of ["qsv", "vaapi"] as const) {
    const device = path === "qsv" ? process.env["QSV_DEVICE"] : process.env["VAAPI_DEVICE"];

    describe.runIf(path === "qsv" ? hasQsv : hasVaapi)(path, () => {
      layer(
        MediaTestServer.layer({
          FFMPEG_PATH: process.env["FFMPEG_PATH"] ?? "ffmpeg",
          HARDWARE_ACCELERATION: path,
          QSV_DEVICE: device ?? "/dev/dri/renderD128",
          VAAPI_DEVICE: device ?? "/dev/dri/renderD128",
        }),
        { excludeTestServices: true, timeout: "180 seconds" },
      )((it) => {
        for (const expected of GPU_CASES) {
          it.effect(
            `encodes ${expected.codec} on ${path} for ${expected.name}`,
            () => plays(expected, path),
            120_000,
          );
        }
      });
    });
  }
});
