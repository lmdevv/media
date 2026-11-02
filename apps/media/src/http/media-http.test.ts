import { assert, describe, layer } from "@effect/vitest";
import { Duration, Effect, FileSystem, Path, Predicate, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";

import { artworkUrl } from "@movies/contracts/artwork";
import { LibraryId } from "@movies/contracts/ids";
import { RequestId } from "@movies/contracts/request-id";
import {
  type ClientCapabilities,
  HealthResponse,
  NegotiateResponse,
  type PlaybackQuality,
  SeekResponse,
} from "@movies/contracts/media-playback";

import * as ArtworkKeys from "../artwork/artwork-keys.ts";
import * as DiskCache from "../disk-cache.ts";
import * as LibraryScanner from "../library/library-scanner.ts";
import * as MemoryLibrary from "../library/memory-library.ts";
import * as MediaTools from "../media/media-tools.ts";
import { parseFfprobeJson } from "../media/media-probe.ts";
import * as FileResolver from "../playback/file-resolver.ts";
import { fragmentSpan, videoTiming } from "../playback/fmp4-fragments.ts";
import * as KeyframeIndex from "../playback/keyframe-index.ts";
import * as PlaybackReporter from "../playback/playback-reporter.ts";
import {
  ffmpegAvailable,
  qsvUsable,
  softwareToneMappingAvailable,
  vaapiUsable,
} from "../testing/fixture-library.ts";
import { copyBytes } from "../testing/byte-copies.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import { signTestToken } from "../testing/test-config.ts";
import * as TestConvex from "../testing/test-convex.ts";
import { sidecarTrackId } from "../subtitles/subtitle-tracks.ts";

const hasFfmpeg = await ffmpegAvailable();

const hasQsv = hasFfmpeg && (await qsvUsable());

const hasVaapi = hasFfmpeg && (await vaapiUsable());

const canToneMap = hasFfmpeg && (await softwareToneMappingAvailable());

const browser: ClientCapabilities = {
  containers: ["mp4", "webm"],
  videoCodecs: [{ codec: "h264", maxBitDepth: 8 }, { codec: "vp9" }, { codec: "av1" }],
  audioCodecs: [{ codec: "aac" }, { codec: "mp3" }, { codec: "opus" }, { codec: "flac" }],
  maxWidth: 3840,
  maxHeight: 2160,
  hls: false,
  mse: true,
};

const withDolbyAudio: ClientCapabilities = {
  containers: browser.containers,
  videoCodecs: browser.videoCodecs,
  audioCodecs: browser.audioCodecs.concat([
    { codec: "ac3", maxChannels: 6 },
    { codec: "eac3", maxChannels: 8 },
  ]),
  maxWidth: browser.maxWidth,
  maxHeight: browser.maxHeight,
  hls: false,
  mse: true,
};

const smallScreen: ClientCapabilities = {
  containers: [],
  videoCodecs: browser.videoCodecs,
  audioCodecs: browser.audioCodecs,
  maxWidth: 1920,
  maxHeight: 120,
  hls: false,
  mse: true,
};

const smallScreenWithDolbyAudio: ClientCapabilities = {
  containers: smallScreen.containers,
  videoCodecs: smallScreen.videoCodecs,
  audioCodecs: withDolbyAudio.audioCodecs,
  maxWidth: smallScreen.maxWidth,
  maxHeight: smallScreen.maxHeight,
  hls: false,
  mse: true,
};

const decodeHealth = Schema.decodeUnknownEffect(HealthResponse);

const UNKNOWN_STREAM = "AAAAAAAAAAAAAAAAAAAAAA";

const forge = (token: string): string => {
  const middle = token.length - 10;

  return `${token.slice(0, middle)}${token[middle] === "A" ? "B" : "A"}${token.slice(middle + 1)}`;
};

interface RequestBody {
  readonly token: string;
  readonly capabilities?: ClientCapabilities;
  readonly startSeconds?: number;
  readonly audioStreamIndex?: number;
  readonly streamId?: string;
  readonly positionSeconds?: number;
}

interface WireBatch {
  readonly token: string;
  readonly platform: string;
  readonly events: ReadonlyArray<{
    readonly ageMs: number;
    readonly streamId?: string;
    readonly observation: Readonly<Record<string, string | number>>;
  }>;
}

const decodeNegotiation = Schema.decodeUnknownEffect(Schema.toCodecJson(NegotiateResponse));

const decodeSeek = Schema.decodeUnknownEffect(SeekResponse);

const local = (baseUrl: string, url: string): string => {
  const parsed = new URL(url);

  return `${baseUrl}${parsed.pathname}${parsed.search}`;
};

const get = (url: string, headers: Readonly<Record<string, string>> = {}) =>
  HttpClient.get(url, { headers }).pipe(Effect.orDie);

const post = (url: string, body: RequestBody | WireBatch) =>
  HttpClient.execute(HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body))).pipe(
    Effect.orDie,
  );

const bytes = (response: HttpClientResponse.HttpClientResponse) =>
  response.arrayBuffer.pipe(
    Effect.map((buffer) => new Uint8Array(buffer)),
    Effect.orDie,
  );

const json = (response: HttpClientResponse.HttpClientResponse) => response.json.pipe(Effect.orDie);

const negotiate = Effect.fn(function* (body: {
  readonly token: string;
  readonly capabilities: ClientCapabilities;
  readonly startSeconds?: number;
  readonly audioStreamIndex?: number;
  readonly quality?: PlaybackQuality;
}) {
  const server = yield* MediaTestServer.Service;
  const response = yield* post(`${server.baseUrl}/api/playback/negotiate`, body);

  return { status: response.status, body: yield* json(response) };
});

const negotiated = Effect.fn(function* (body: Parameters<typeof negotiate>[0]) {
  const result = yield* negotiate(body);

  assert.strictEqual(result.status, 200, JSON.stringify(result.body));

  return yield* decodeNegotiation(result.body).pipe(Effect.orDie);
});

const ffprobeBytes = Effect.fn(function* (
  data: Uint8Array,
  suffix: string,
  args: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const tools = yield* MediaTools.Service;
  const file = yield* fs.makeTempFileScoped({ suffix });

  yield* fs.writeFile(file, data);

  return { file, output: yield* tools.ffprobe(["-v", "error", ...args, file]) };
});

const probeBytes = Effect.fn(function* (data: Uint8Array) {
  const { file, output } = yield* ffprobeBytes(data, ".mp4", [
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
  ]);

  return yield* parseFfprobeJson(output, file);
});

const probeImage = Effect.fn(function* (data: Uint8Array) {
  const { output } = yield* ffprobeBytes(data, ".jpg", ["-print_format", "json", "-show_streams"]);

  return yield* Schema.decodeEffect(
    Schema.fromJsonString(
      Schema.Struct({
        streams: Schema.Tuple([Schema.Struct({ width: Schema.Int, height: Schema.Int })]),
      }),
    ),
  )(output).pipe(Effect.map((probe) => probe.streams[0]));
});

const streamFile = (playlistUrl: string, name: string) => {
  const playlist = new URL(playlistUrl);

  return get(new URL(`${name}${playlist.search}`, playlist).toString());
};

const fetchSegment = Effect.fn(function* (playlistUrl: string, index: number) {
  const init = yield* streamFile(playlistUrl, "init.mp4");
  const segment = yield* streamFile(playlistUrl, `${index}.m4s`);

  return { init, segment };
});

const decodeVideoPackets = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      packets: Schema.NonEmptyArray(
        Schema.Struct({
          pts_time: Schema.FiniteFromString,
          duration_time: Schema.FiniteFromString,
        }),
      ),
    }),
  ),
);

const videoPackets = Effect.fn(function* (data: Uint8Array) {
  const { output } = yield* ffprobeBytes(data, ".mp4", [
    "-select_streams",
    "v:0",
    "-show_entries",
    "packet=pts_time,duration_time",
    "-of",
    "json",
  ]);

  return (yield* decodeVideoPackets(output).pipe(Effect.orDie)).packets;
});

const decodeAudioPackets = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      packets: Schema.NonEmptyArray(
        Schema.Struct({
          pts_time: Schema.FiniteFromString,
          /** ffprobe 6 leaves it out for a priming frame it trims. */
          duration_time: Schema.optional(Schema.FiniteFromString),
        }),
      ),
    }),
  ),
);

const audioPackets = Effect.fn(function* (data: Uint8Array) {
  const { output } = yield* ffprobeBytes(data, ".mp4", [
    "-select_streams",
    "a:0",
    "-show_entries",
    "packet=pts_time,duration_time",
    "-of",
    "json",
  ]);

  return (yield* decodeAudioPackets(output).pipe(Effect.orDie)).packets.map((packet) => ({
    pts_time: packet.pts_time,
    duration_time: packet.duration_time ?? 0,
  }));
});

const spanOf = (
  packets: ReadonlyArray<{ readonly pts_time: number; readonly duration_time: number }>,
) => ({
  start: Math.min(...packets.map((packet) => packet.pts_time)),
  end: Math.max(...packets.map((packet) => packet.pts_time + packet.duration_time)),
});

const playlistSegments = Effect.fn(function* (playlistUrl: string) {
  const text = yield* (yield* get(playlistUrl)).text.pipe(Effect.orDie);
  const durations = [...text.matchAll(/#EXTINF:([\d.]+),/g)].map((match) => Number(match[1]));

  return durations.map((duration, index) => ({
    start: durations.slice(0, index).reduce((total, previous) => total + previous, 0),
    duration,
  }));
});

const generationListings = {
  active: 0,
  most: 0,
  arrival: Promise.withResolvers<void>(),
};

const overlappingListings = (real: FileSystem.FileSystem): FileSystem.FileSystem =>
  FileSystem.FileSystem.of({
    ...real,
    readDirectory: (path, options) =>
      /[/\\]transcode[/\\][^/\\]+[/\\]\d+$/.test(path)
        ? Effect.promise(() => {
            const previous = generationListings.arrival;

            generationListings.active += 1;
            generationListings.most = Math.max(generationListings.most, generationListings.active);
            generationListings.arrival = Promise.withResolvers<void>();
            previous.resolve();

            return generationListings.arrival.promise;
          }).pipe(
            Effect.timeoutOption(Duration.millis(300)),
            Effect.andThen(real.readDirectory(path, options)),
            Effect.ensuring(
              Effect.sync(() => {
                generationListings.active -= 1;
              }),
            ),
          )
        : real.readDirectory(path, options),
  });

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
};

describe.skipIf(!hasFfmpeg)("media service over HTTP", () => {
  layer(MediaTestServer.layer(), { excludeTestServices: true, timeout: "120 seconds" })((it) => {
    it.effect("reports health", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const response = yield* get(`${server.baseUrl}/api/health`);

        assert.deepStrictEqual(yield* json(response), {
          status: "ok",
          activeStreams: 0,
          hardwareAcceleration: "none",
          backend: "standalone",
        });
      }),
    );

    it.effect("has no Convex URL for apps when it runs standalone", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const response = yield* get(`${server.baseUrl}/api/client-config`);

        assert.deepStrictEqual(yield* json(response), {});
      }),
    );

    it.effect("serves artwork by sealed key, resized on request, and refuses others", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const workspace = yield* FixtureWorkspace.Service;
        const keys = yield* ArtworkKeys.Service;
        const path = yield* Path.Path;

        const poster = yield* keys.seal(
          ArtworkKeys.ArtworkSource.Local({
            path: path.join(workspace.library.moviesRoot, "Big Buck Fixture (2008)/poster.jpg"),
          }),
        );

        const original = yield* get(artworkUrl(server.baseUrl, poster));

        assert.strictEqual(original.status, 200);
        assert.strictEqual(original.headers["content-type"], "image/jpeg");

        const resized = yield* get(artworkUrl(server.baseUrl, poster, 185));
        const image = yield* probeImage(new Uint8Array(yield* resized.arrayBuffer));

        assert.strictEqual(resized.status, 200);
        assert.deepStrictEqual([image.width, image.height], [185, 278]);
        assert.strictEqual((yield* get(`${server.baseUrl}/artwork/${poster}?w=100`)).status, 400);

        const outside = yield* keys.seal(ArtworkKeys.ArtworkSource.Local({ path: "/etc/passwd" }));

        assert.strictEqual((yield* get(artworkUrl(server.baseUrl, outside))).status, 404);
        assert.strictEqual((yield* get(`${server.baseUrl}/artwork/a1.forged`)).status, 404);
      }),
    );

    it.effect("plays a compatible MP4 directly with byte ranges and validators", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const { library } = yield* FixtureWorkspace.Service;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fileId = server.fileId("movies", library.directMovie);
        const token = signTestToken({ fid: fileId, sid: "direct" });
        const result = yield* negotiated({ token, capabilities: browser });

        assert.strictEqual(result.mode, "direct");
        assert.strictEqual(
          result.url,
          `http://media.test/media/direct/${fileId}?token=${encodeURIComponent(token)}`,
        );
        assert.strictEqual(result.video.codec, "h264");
        assert.strictEqual(result.audio?.codec, "aac");
        assert.approximately(result.durationSeconds, 12, 0.1);

        const original = yield* fs.readFile(path.join(library.moviesRoot, library.directMovie));
        const url = local(server.baseUrl, result.url);
        const partial = yield* get(url, { range: "bytes=100-1123" });

        assert.strictEqual(partial.status, 206);
        assert.strictEqual(partial.headers["content-range"], `bytes 100-1123/${original.length}`);
        assert.strictEqual(partial.headers["content-type"], "video/mp4");
        assert.deepStrictEqual(yield* bytes(partial), original.subarray(100, 1124));

        const suffix = yield* get(url, { range: "bytes=-16" });

        assert.deepStrictEqual(yield* bytes(suffix), original.subarray(original.length - 16));

        const unsatisfiable = yield* get(url, { range: `bytes=${original.length}-` });

        assert.strictEqual(unsatisfiable.status, 416);
        assert.strictEqual(unsatisfiable.headers["content-range"], `bytes */${original.length}`);

        const full = yield* get(url);
        const etag = full.headers["etag"] ?? "";

        assert.strictEqual(full.status, 200);
        assert.isFalse(etag.startsWith("W/"));
        assert.strictEqual((yield* bytes(full)).length, original.length);

        const notModified = yield* get(url, { "if-none-match": etag });

        assert.strictEqual(notModified.status, 304);
        const staleRange = yield* get(url, { range: "bytes=0-9", "if-range": '"stale"' });

        assert.strictEqual(staleRange.status, 200);

        const head = yield* HttpClient.execute(HttpClientRequest.head(url)).pipe(Effect.orDie);

        assert.strictEqual(head.status, 200);
        assert.strictEqual(head.headers["content-length"], String(original.length));
      }),
    );

    it.effect("rejects missing, forged, expired, and mismatched tokens", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const { library } = yield* FixtureWorkspace.Service;
        const fileId = server.fileId("movies", library.directMovie);
        const other = server.fileId("movies", library.messyMovie);

        assert.strictEqual((yield* get(`${server.baseUrl}/media/direct/${fileId}`)).status, 401);

        const expired = yield* get(
          `${server.baseUrl}/media/direct/${fileId}?token=${signTestToken({ fid: fileId, exp: Date.now() - 1 })}`,
        );

        assert.strictEqual(expired.status, 401);
        assert.deepStrictEqual(yield* json(expired), {
          _tag: "PlaybackTokenInvalid",
          reason: "expired",
          message: "Playback token has expired",
        });

        const valid = signTestToken({ fid: fileId });
        const middle = valid.length - 10;
        const forged = `${valid.slice(0, middle)}${valid[middle] === "A" ? "B" : "A"}${valid.slice(middle + 1)}`;

        assert.strictEqual(
          (yield* get(`${server.baseUrl}/media/direct/${fileId}?token=${forged}`)).status,
          401,
        );

        const mismatched = yield* get(
          `${server.baseUrl}/media/direct/${fileId}?token=${signTestToken({ fid: other })}`,
        );

        assert.strictEqual(mismatched.status, 403);

        const unknown = yield* negotiate({
          token: signTestToken({ fid: "no-such-file" }),
          capabilities: browser,
        });

        assert.strictEqual(unknown.status, 404);
      }),
    );

    it.effect("remuxes MKV to fMP4 HLS that ffprobe reads back", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const { library } = yield* FixtureWorkspace.Service;
        const fileId = server.fileId("movies", library.remuxMovie);

        const result = yield* negotiated({
          token: signTestToken({ fid: fileId, sid: "remux" }),
          capabilities: withDolbyAudio,
        });

        assert.strictEqual(result.mode, "remux");
        assert.strictEqual(result.generation, 1);

        const playlistUrl = local(server.baseUrl, result.url);
        const playlist = yield* get(playlistUrl);
        const text = yield* playlist.text.pipe(Effect.orDie);

        assert.strictEqual(playlist.headers["content-type"], "application/vnd.apple.mpegurl");
        assert.include(text, "#EXT-X-PLAYLIST-TYPE:VOD");
        assert.include(text, '#EXT-X-MAP:URI="init.mp4?token=');
        const durations = [...text.matchAll(/#EXTINF:([\d.]+),/g)].map((match) => Number(match[1]));

        // Keyframes every 2 s: one per segment for the first eight seconds, so playback starts
        // on a short segment, then grouped into 4 s; ffmpeg builds differ by a few milliseconds.
        assert.strictEqual(durations.length, 5);

        for (const [index, duration] of durations.entries()) {
          assert.approximately(duration, index < 4 ? 2 : 4, 0.05);
        }

        assert.include(text, "#EXT-X-ENDLIST");

        const parts = [];

        for (let index = 0; index < durations.length; index += 1) {
          const { init, segment } = yield* fetchSegment(playlistUrl, index);

          assert.strictEqual(segment.status, 200);
          const media = yield* bytes(segment);
          const probe = yield* probeBytes(concat(yield* bytes(init), media));

          assert.strictEqual(probe.video?.codec, "h264");
          assert.strictEqual(probe.audio[0]?.codec, "ac3");
          parts.push(media);
        }

        const { init } = yield* fetchSegment(playlistUrl, 0);
        const whole = yield* probeBytes(concat(yield* bytes(init), ...parts));

        assert.approximately(whole.durationSeconds, 12, 0.3);
      }),
    );

    it.effect("starts a resumed or sought remux on the segment the playlist names", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const { library } = yield* FixtureWorkspace.Service;
        const fileId = server.fileId("movies", library.remuxMovie);
        const token = signTestToken({ fid: fileId, sid: "preroll" });
        const frame = 1 / 24;

        const segmentMatches = Effect.fn(function* (playlistUrl: string, position: number) {
          const segments = yield* playlistSegments(playlistUrl);
          const index = segments.findLastIndex((segment) => segment.start <= position);
          const planned = segments[index];
          const { init, segment } = yield* fetchSegment(playlistUrl, index);

          assert.strictEqual(segment.status, 200);

          const span = spanOf(
            yield* videoPackets(concat(yield* bytes(init), yield* bytes(segment))),
          );

          assert.approximately(span.start, planned?.start ?? 0, frame);
          assert.approximately(span.end - span.start, planned?.duration ?? 0, frame);
        });

        const resumed = yield* negotiated({ token, capabilities: withDolbyAudio, startSeconds: 7 });

        assert.strictEqual(resumed.mode, "remux");
        yield* segmentMatches(local(server.baseUrl, resumed.url), 7);

        const seek = yield* post(`${server.baseUrl}/api/playback/seek`, {
          token,
          streamId: resumed.streamId ?? "",
          positionSeconds: 5,
        });

        const sought = yield* decodeSeek(yield* json(seek)).pipe(Effect.orDie);

        assert.strictEqual(sought.generation, 2);
        yield* segmentMatches(local(server.baseUrl, sought.playlistUrl), 5);
      }),
    );

    it.effect("starts a resume on its keyframe when the keyframe index places it late", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const workspace = yield* FixtureWorkspace.Service;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const library = LibraryId.make("late-keyframe");
        const root = path.join(workspace.root, "late-keyframe");
        const copy = path.join(root, workspace.library.remuxMovie);
        const frame = 1 / 24;

        yield* fs.makeDirectory(path.dirname(copy), { recursive: true });
        yield* copyBytes(
          path.join(workspace.library.moviesRoot, workspace.library.remuxMovie),
          copy,
        );
        yield* (yield* LibraryScanner.Service)
          .scan({ libraryId: library, root, mode: "incremental" })
          .pipe(Effect.orDie);

        const fileId = MemoryLibrary.fileIdOf(library, workspace.library.remuxMovie);
        const file = yield* (yield* FileResolver.Service).resolve(fileId).pipe(Effect.orDie);
        const keyframes = yield* (yield* KeyframeIndex.Service).keyframes(file).pipe(Effect.orDie);
        const late = keyframes.findLast((time) => time <= 7) ?? 0;

        yield* (yield* DiskCache.Service).write(
          "keyframes",
          `${fileId}:${String(file.sizeBytes)}:${String(file.modifiedAtMs)}`,
          JSON.stringify(keyframes.map((time) => (time === late ? time + 0.01 : time))),
        );

        const resumed = yield* negotiated({
          token: signTestToken({ fid: fileId, sid: "late-keyframe" }),
          capabilities: withDolbyAudio,
          startSeconds: 7,
        });

        assert.strictEqual(resumed.mode, "remux");
        const playlistUrl = local(server.baseUrl, resumed.url);
        const segments = yield* playlistSegments(playlistUrl);
        const index = segments.findLastIndex((segment) => segment.start <= 7);
        const first = yield* fetchSegment(playlistUrl, index);
        const second = yield* fetchSegment(playlistUrl, index + 1);
        const header = yield* bytes(first.init);
        const resumedPackets = yield* videoPackets(concat(header, yield* bytes(first.segment)));
        const nextPackets = yield* videoPackets(concat(header, yield* bytes(second.segment)));
        const resumedSpan = spanOf(resumedPackets);

        assert.approximately(resumedSpan.start, late, frame);
        assert.approximately(
          resumedSpan.end - resumedSpan.start,
          segments[index]?.duration ?? 0,
          frame,
        );
        assert.approximately(spanOf(nextPackets).start, resumedSpan.end, frame);

        const resumedTimes = new Set(resumedPackets.map((packet) => packet.pts_time));

        assert.isFalse(nextPackets.some((packet) => resumedTimes.has(packet.pts_time)));
      }),
    );

    it.effect("transcodes down to the viewer's quality cap, and plays directly within it", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const { library } = yield* FixtureWorkspace.Service;
        const fileId = server.fileId("movies", library.directMovie);

        const capped = yield* negotiated({
          token: signTestToken({ fid: fileId, sid: "quality" }),
          capabilities: browser,
          quality: { maxHeight: 120 },
        });

        assert.strictEqual(capped.mode, "transcode-software");
        assert.strictEqual(capped.video.height, 120);

        const within = yield* negotiated({
          token: signTestToken({ fid: fileId, sid: "quality" }),
          capabilities: browser,
          quality: { maxHeight: 1080, maxBitrate: 50_000_000 },
        });

        assert.strictEqual(within.mode, "direct");
      }),
    );

    it.effect("transcodes only the audio when the video can be copied", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const { library } = yield* FixtureWorkspace.Service;
        const fileId = server.fileId("movies", library.remuxMovie);

        const result = yield* negotiated({
          token: signTestToken({ fid: fileId, sid: "audio" }),
          capabilities: browser,
          audioStreamIndex: 2,
        });

        assert.strictEqual(result.mode, "audio-transcode");
        assert.deepStrictEqual(result.audio, { streamIndex: 2, codec: "aac", channels: 2 });

        const { init, segment } = yield* fetchSegment(local(server.baseUrl, result.url), 1);
        const probe = yield* probeBytes(concat(yield* bytes(init), yield* bytes(segment)));

        assert.strictEqual(probe.video?.codec, "h264");
        assert.deepStrictEqual([probe.audio[0]?.codec, probe.audio[0]?.channels], ["aac", 2]);
      }),
    );

    it.effect("tone-maps HDR to SDR in software when ffmpeg can, and refuses it otherwise", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const { library } = yield* FixtureWorkspace.Service;
        const fileId = server.fileId("movies", library.hdrMovie);
        const token = signTestToken({ fid: fileId, sid: "hdr" });
        const result = yield* negotiate({ token, capabilities: browser });

        if (!canToneMap) {
          assert.strictEqual(result.status, 422);
          assert.deepStrictEqual(result.body, {
            _tag: "UnsupportedPlayback",
            reason: "hdr-tone-mapping-requires-hardware",
          });

          return;
        }

        const stream = yield* negotiated({ token, capabilities: browser });

        assert.strictEqual(stream.mode, "transcode-software");
        assert.strictEqual(stream.video.dynamicRange, "sdr");

        const { init, segment } = yield* fetchSegment(local(server.baseUrl, stream.url), 0);
        const probe = yield* probeBytes(concat(yield* bytes(init), yield* bytes(segment)));

        assert.strictEqual(probe.video?.codec, "h264");
        assert.strictEqual(probe.video?.dynamicRange, "sdr");
        assert.strictEqual(probe.video?.bitDepth, 8);
      }),
    );

    it.effect("transcodes in software, seeks to a new generation, and rejects the old one", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const { library } = yield* FixtureWorkspace.Service;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fileId = server.fileId("movies", library.directMovie);
        const token = signTestToken({ fid: fileId, sid: "software" });
        const result = yield* negotiated({ token, capabilities: smallScreen, startSeconds: 8 });

        assert.strictEqual(result.mode, "transcode-software");
        const streamId = result.streamId ?? "";
        assert.deepStrictEqual(result.video, {
          codec: "h264",
          width: 212,
          height: 120,
          dynamicRange: "sdr",
        });
        const firstPlaylist = local(server.baseUrl, result.url);
        const started = yield* fetchSegment(firstPlaylist, 2);

        const startedProbe = yield* probeBytes(
          concat(yield* bytes(started.init), yield* bytes(started.segment)),
        );

        assert.deepStrictEqual(
          [startedProbe.video?.codec, startedProbe.video?.width, startedProbe.video?.height],
          ["h264", 212, 120],
        );

        const before = yield* fetchSegment(firstPlaylist, 0);

        assert.strictEqual(before.segment.status, 410);
        assert.deepStrictEqual(yield* json(before.segment), {
          _tag: "StreamGenerationGone",
          streamId,
          generation: 1,
          currentGeneration: 2,
        });

        assert.strictEqual((yield* get(firstPlaylist)).status, 410);
        assert.isFalse(yield* fs.exists(path.join(server.transcodeDir, streamId, "1")));

        const secondPlaylist = firstPlaylist.replace("/1/index.m3u8", "/2/index.m3u8");
        const rewound = yield* fetchSegment(secondPlaylist, 0);

        assert.strictEqual(rewound.segment.status, 200);

        const probe = yield* probeBytes(
          concat(yield* bytes(rewound.init), yield* bytes(rewound.segment)),
        );

        assert.approximately(probe.durationSeconds, 4, 0.2);

        const seek = yield* post(`${server.baseUrl}/api/playback/seek`, {
          token,
          streamId,
          positionSeconds: 1,
        });

        assert.deepStrictEqual(yield* json(seek), {
          streamId,
          generation: 2,
          playlistUrl: `http://media.test/media/hls/${streamId}/2/index.m3u8?token=${encodeURIComponent(token)}`,
        });

        const stop = yield* post(`${server.baseUrl}/api/playback/stop`, {
          token,
          streamId,
        });

        assert.strictEqual(stop.status, 204);
        assert.isFalse(yield* fs.exists(path.join(server.transcodeDir, streamId)));
        assert.strictEqual((yield* get(secondPlaylist)).status, 404);

        const events = yield* (yield* PlaybackReporter.Recording).events;

        assert.isTrue(
          events.some(
            (event) =>
              PlaybackReporter.PlaybackEvent.guards.StreamEnded(event) &&
              event.streamId === result.streamId &&
              event.reason === "stopped",
          ),
        );
      }),
    );

    it.effect("converts embedded and sidecar text subtitles to WebVTT", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const { library } = yield* FixtureWorkspace.Service;
        const fileId = server.fileId("movies", library.remuxMovie);

        const result = yield* negotiated({
          token: signTestToken({ fid: fileId, sid: "subs" }),
          capabilities: withDolbyAudio,
        });

        assert.deepStrictEqual(
          result.subtitles.map((track) => [track.id, track.source, track.language, track.forced]),
          [
            ["e3", "embedded", "eng", false],
            [sidecarTrackId("Remux Fixture (2015).en.srt"), "sidecar", "eng", false],
            [sidecarTrackId("Remux Fixture (2015).fr.forced.ass"), "sidecar", "fre", true],
          ],
        );

        const texts = [];

        for (const track of result.subtitles) {
          const response = yield* get(local(server.baseUrl, track.url ?? ""));

          assert.strictEqual(response.headers["content-type"], "text/vtt; charset=utf-8");
          texts.push(yield* response.text.pipe(Effect.orDie));
        }

        assert.isTrue(texts.every((text) => text.startsWith("WEBVTT")));
        assert.include(texts[0], "Hello from the fixture.");
        // Cue times may carry the container start offset of the ffmpeg build that made the fixture.
        assert.match(texts[0] ?? "", /00:01\.0\d\d --> 00:03\.0\d\d/);
        assert.include(texts[1], "Second");
        assert.include(texts[2], "Bonjour");
      }),
    );

    it.effect("limits how fast one address may call the unauthenticated routes", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;

        const statuses = yield* Effect.forEach(
          Array.from({ length: 150 }, (_, index) => index),
          () => get(`${server.baseUrl}/api/health`),
          { concurrency: 16 },
        );

        const refused = statuses.filter((response) => response.status === 429);

        assert.isAbove(refused.length, 0);
        assert.isAtLeast(statuses.filter((response) => response.status === 200).length, 60);
        assert.match(refused[0]?.headers["retry-after"] ?? "", /^\d+$/);
      }),
    );

    it.effect("answers unknown streams with a recoverable error", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;

        const response = yield* get(
          `${server.baseUrl}/media/hls/AAAAAAAAAAAAAAAAAAAAAA/1/index.m3u8?token=${signTestToken({ fid: "x" })}`,
        );

        assert.strictEqual(response.status, 404);
        assert.deepStrictEqual(yield* json(response), {
          _tag: "StreamNotFound",
          streamId: "AAAAAAAAAAAAAAAAAAAAAA",
        });
      }),
    );
  });

  layer(MediaTestServer.layer({ STREAM_IDLE_SECONDS: "1", MAX_CONCURRENT_TRANSCODES: "1" }), {
    excludeTestServices: true,
    timeout: "120 seconds",
  })("with short idle timeout and one transcode slot", (it) => {
    it.effect(
      "limits concurrent transcodes and releases idle encoders, keeping their streams",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const fileId = server.fileId("movies", library.directMovie);
          const one = `one-${crypto.randomUUID()}`;
          const token = signTestToken({ fid: fileId, sid: one });
          const two = signTestToken({ fid: fileId, sid: `two-${crypto.randomUUID()}` });
          const first = yield* negotiated({ token, capabilities: smallScreen });
          const run = path.join(server.transcodeDir, first.streamId ?? "", "1");

          const about = (message: string) =>
            server
              .logged()
              .find(
                (entry) =>
                  entry.message === message && entry.annotations["streamId"] === first.streamId,
              );

          assert.isTrue(yield* fs.exists(run));

          const second = yield* negotiate({ token: two, capabilities: smallScreen });

          assert.strictEqual(second.status, 503);
          assert.deepStrictEqual(second.body, { _tag: "TranscodeCapacityReached", limit: 1 });

          yield* Effect.sleep("2500 millis");

          assert.isFalse(yield* fs.exists(run));
          assert.strictEqual((yield* get(local(server.baseUrl, first.url))).status, 200);

          const events = yield* (yield* PlaybackReporter.Recording).events;

          assert.isFalse(
            events.some(
              (event) =>
                PlaybackReporter.PlaybackEvent.guards.StreamEnded(event) &&
                event.streamId === first.streamId,
            ),
          );
          assert.deepInclude(about("Stream.released")?.annotations, {
            sessionId: one,
            liveness: "unknown",
            inFlight: 0,
          });

          const retry = yield* negotiated({ token: two, capabilities: smallScreen });

          assert.strictEqual(retry.mode, "transcode-software");

          const stopped = yield* post(`${server.baseUrl}/api/playback/stop`, {
            token,
            streamId: first.streamId ?? "",
          });

          assert.strictEqual(stopped.status, 204);
          assert.strictEqual((yield* get(local(server.baseUrl, first.url))).status, 404);

          const failed = about("MediaRoutes.request_failed");

          assert.deepInclude(failed?.annotations, {
            route: "playlist",
            status: 404,
            error: "Stream not found: renegotiate playback",
            sessionId: one,
            userId: "user_test",
          });
          assert.strictEqual(failed?.level, "WARN");

          const done = yield* post(`${server.baseUrl}/api/playback/stop`, {
            token: two,
            streamId: retry.streamId ?? "",
          });

          assert.strictEqual(done.status, 204);
        }),
    );

    it.effect("revives a released remux on the segment the playlist names, without preroll", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const { library } = yield* FixtureWorkspace.Service;
        const fileId = server.fileId("movies", library.remuxMovie);
        const token = signTestToken({ fid: fileId, sid: `revived-${crypto.randomUUID()}` });
        const frame = 1 / 24;
        const stream = yield* negotiated({ token, capabilities: withDolbyAudio });
        const playlistUrl = local(server.baseUrl, stream.url);

        assert.strictEqual(stream.mode, "remux");
        assert.strictEqual((yield* fetchSegment(playlistUrl, 0)).segment.status, 200);

        yield* Effect.sleep("2500 millis");

        const logged = (message: string) =>
          server
            .logged()
            .filter(
              (entry) =>
                entry.message === message && entry.annotations["streamId"] === stream.streamId,
            );

        assert.lengthOf(logged("Stream.released"), 1);

        const segments = yield* playlistSegments(playlistUrl);
        const index = segments.findLastIndex((segment) => segment.start <= 7);
        const planned = segments[index];
        const { init, segment } = yield* fetchSegment(playlistUrl, index);

        assert.strictEqual(segment.status, 200);
        assert.deepInclude(logged("Stream.resumed")[0]?.annotations, {
          generation: 1,
          segment: index,
        });

        const span = spanOf(yield* videoPackets(concat(yield* bytes(init), yield* bytes(segment))));

        assert.approximately(span.start, planned?.start ?? 0, frame);
        assert.approximately(span.end - span.start, planned?.duration ?? 0, frame);
      }),
    );

    it.effect(
      "revives a released stream with the audio the earlier run left off at",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const fileId = server.fileId("movies", library.remuxMovie);

          const revivedAudio = Effect.fn(function* (capabilities: ClientCapabilities) {
            const token = signTestToken({ fid: fileId, sid: `revived-${crypto.randomUUID()}` });
            const stream = yield* negotiated({ token, capabilities });
            const playlistUrl = local(server.baseUrl, stream.url);
            const segments = yield* playlistSegments(playlistUrl);
            const index = segments.findLastIndex((segment) => segment.start <= 7);
            const before = yield* fetchSegment(playlistUrl, index - 1);

            yield* Effect.sleep("2500 millis");

            const after = yield* fetchSegment(playlistUrl, index);
            const init = yield* bytes(before.init);

            const resumed = server
              .logged()
              .find(
                (entry) =>
                  entry.message === "Stream.resumed" &&
                  entry.annotations["streamId"] === stream.streamId,
              );

            const generation = resumed?.annotations["generation"];

            if (!Predicate.isNumber(generation)) return assert.fail("the stream was not revived");

            const run = path.join(server.transcodeDir, stream.streamId ?? "", String(generation));

            const fragments = (yield* fs.readDirectory(run)).filter((name) =>
              name.endsWith(".m4s"),
            );

            const timing = videoTiming(yield* fs.readFile(path.join(run, "init.mp4")));

            if (timing === undefined) return assert.fail("the run's init segment has no video");

            const starts = yield* Effect.forEach(fragments, (name) =>
              Effect.map(
                fs.readFile(path.join(run, name)),
                (data) => fragmentSpan(timing, data)?.start ?? Number.NaN,
              ),
            );

            return {
              mode: stream.mode,
              planned: segments[index]?.start ?? 0,
              firstFragment: Math.min(...starts),
              before: spanOf(yield* audioPackets(concat(init, yield* bytes(before.segment)))),
              after: spanOf(yield* audioPackets(concat(init, yield* bytes(after.segment)))),
            };
          });

          // Remux with AC-3 to AAC: the revived run seeks from the segment before, not the file's
          // start, and its AAC frames continue the earlier run's.
          const remux = yield* revivedAudio(browser);

          assert.strictEqual(remux.mode, "audio-transcode");
          assert.isAbove(remux.firstFragment, 0);
          assert.approximately(remux.after.start, remux.before.end, 0.0015);

          // Encode with AC-3 copied: the revived run drops the copied audio its seek landed before,
          // which it can only do knowing the track runs on.
          const encode = yield* revivedAudio(smallScreenWithDolbyAudio);

          assert.strictEqual(encode.mode, "transcode-software");
          assert.isAtMost(encode.planned - encode.after.start, 0.033);
        }),
      60_000,
    );
  });

  layer(
    MediaTestServer.layer({
      HARDWARE_ACCELERATION: "qsv",
      QSV_DEVICE: "/dev/dri/no-such-render-node",
    }),
    {
      excludeTestServices: true,
      timeout: "120 seconds",
    },
  )("when QSV fails", (it) => {
    it.effect("falls back to software and reports the mode change", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const { library } = yield* FixtureWorkspace.Service;
        const fileId = server.fileId("movies", library.directMovie);

        const result = yield* negotiated({
          token: signTestToken({ fid: fileId, sid: "fallback" }),
          capabilities: smallScreen,
        });

        assert.strictEqual(result.mode, "transcode-software");
        const { segment } = yield* fetchSegment(local(server.baseUrl, result.url), 0);

        assert.strictEqual(segment.status, 200);
        const events = yield* (yield* PlaybackReporter.Recording).events;

        assert.isTrue(
          events.some(
            (event) =>
              PlaybackReporter.PlaybackEvent.guards.ModeChanged(event) &&
              event.from === "transcode-qsv" &&
              event.to === "transcode-software",
          ),
        );

        const health = yield* get(`${server.baseUrl}/api/health`);

        const status = yield* decodeHealth(yield* json(health)).pipe(Effect.orDie);

        assert.strictEqual(status.hardwareAcceleration, "none");
      }),
    );
  });

  layer(MediaTestServer.layer({ LOG_LEVEL: "debug" }), {
    excludeTestServices: true,
    timeout: "120 seconds",
  })("with debug logs", (it) => {
    it.effect("times every segment: encoder wait, disk read, and network write", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const { library } = yield* FixtureWorkspace.Service;

        const stream = yield* negotiated({
          token: signTestToken({ fid: server.fileId("movies", library.remuxMovie), sid: "timed" }),
          capabilities: browser,
        });

        const { segment } = yield* fetchSegment(local(server.baseUrl, stream.url), 0);
        const body = yield* bytes(segment);

        assert.isTrue(Schema.is(RequestId)(segment.headers["x-request-id"]));

        const timed = yield* Effect.sync(() =>
          server
            .logged()
            .find(
              (entry) =>
                entry.message === "MediaRoutes.segment" && entry.annotations["segment"] === 0,
            ),
        ).pipe(
          Effect.repeat({ until: (entry) => entry !== undefined, schedule: Schedule.spaced(20) }),
          Effect.timeout("5 seconds"),
          Effect.orDie,
        );

        assert.deepInclude(timed?.annotations, {
          route: "hls",
          streamId: stream.streamId,
          sessionId: "timed",
          bytes: body.length,
          completed: true,
          requestId: segment.headers["x-request-id"],
        });

        for (const part of ["elapsedMs", "encoderWaitMs", "diskReadMs", "networkWriteMs"]) {
          assert.isAtLeast(Number(timed?.annotations[part]), 0, part);
        }
      }),
    );

    it.effect("logs a refused token below WARN, so no stranger can flood the log", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;

        const refused = yield* get(
          `${server.baseUrl}/media/hls/AAAAAAAAAAAAAAAAAAAAAA/1/0.m4s?token=v1.forged.token`,
        );

        assert.strictEqual(refused.status, 401);

        const logged = server
          .logged()
          .filter(
            (entry) =>
              entry.message === "MediaRoutes.request_failed" && entry.annotations["status"] === 401,
          );

        assert.deepStrictEqual(
          logged.map((entry) => entry.level),
          ["DEBUG"],
        );
      }),
    );

    it.effect("logs a forged signature below WARN and files it under no session", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const forged = forge(signTestToken({ fid: "file_1", sid: "forger" }));
        const claimed = "BBBBBBBBBBBBBBBBBBBBBB";

        for (const file of ["index.m3u8", "0.m4s"]) {
          const refused = yield* get(
            `${server.baseUrl}/media/hls/${claimed}/1/${file}?token=${forged}`,
          );

          assert.strictEqual(refused.status, 401);
        }

        assert.deepStrictEqual(
          server
            .logged()
            .filter((entry) => entry.annotations["claimedStreamId"] === claimed)
            .map((entry) => [entry.message, entry.level, entry.annotations["sessionId"]]),
          [
            ["MediaRoutes.request_failed", "DEBUG", undefined],
            ["MediaRoutes.request_failed", "DEBUG", undefined],
          ],
        );
      }),
    );

    it.effect("logs a member's failing requests within a budget, with path parameters cut", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const token = signTestToken({ fid: "file_1", sid: "flood" });
        const junk = "x".repeat(100);

        for (let index = 0; index < 100; index += 1) {
          const response = yield* get(
            `${server.baseUrl}/media/hls/AAAAAAAAAAAAAAAAAAAAAA/1/${junk}?token=${token}`,
          );

          assert.strictEqual(response.status, 404);
        }

        const failures = server
          .logged()
          .filter(
            (entry) =>
              entry.message === "MediaRoutes.request_failed" &&
              entry.annotations["sessionId"] === "flood",
          );

        assert.strictEqual(failures.length, 100);
        assert.isAtMost(failures.filter((entry) => entry.level === "WARN").length, 32);
        assert.isAtLeast(failures.filter((entry) => entry.level === "WARN").length, 30);
        assert.isTrue(
          failures.every((entry) => {
            const file = entry.annotations["file"];

            return Predicate.isString(file) && file.length <= 65;
          }),
          "file cut short",
        );
      }),
    );

    it.effect("files a player's event under a stream only for the stream's own session", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const { library } = yield* FixtureWorkspace.Service;
        const fileId = server.fileId("movies", library.remuxMovie);
        const owner = signTestToken({ fid: fileId, sid: "owner" });

        const stream = yield* negotiated({ token: owner, capabilities: browser });

        const event = {
          ageMs: 0,
          streamId: stream.streamId ?? "",
          observation: { _tag: "BufferingStarted", positionSeconds: 1, bufferedAheadSeconds: 0 },
        };

        for (const token of [owner, signTestToken({ fid: fileId, sid: "intruder" })]) {
          const sent = yield* post(`${server.baseUrl}/api/playback/diagnostics`, {
            token,
            platform: "web",
            events: [event],
          });

          assert.strictEqual(sent.status, 204);
        }

        assert.deepStrictEqual(
          server
            .logged()
            .filter((entry) => entry.message === "Player.buffering_started")
            .map((entry) => [
              entry.annotations["sessionId"],
              entry.annotations["streamId"],
              entry.annotations["claimedStreamId"],
            ]),
          [
            ["owner", stream.streamId, null],
            ["intruder", null, stream.streamId],
          ],
        );

        const intruding = yield* get(
          `${server.baseUrl}/media/hls/${stream.streamId ?? ""}/1/0.m4s?token=${signTestToken({ fid: fileId, sid: "intruder" })}`,
        );

        assert.isAtLeast(intruding.status, 400);
        assert.deepStrictEqual(
          server
            .logged()
            .filter(
              (entry) =>
                entry.message === "MediaRoutes.request_failed" &&
                entry.annotations["sessionId"] === "intruder",
            )
            .map((entry) => [entry.annotations["streamId"], entry.annotations["claimedStreamId"]]),
          [[null, stream.streamId]],
        );
      }),
    );

    it.effect("takes a player's events, and refuses batches outside the limits", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const token = signTestToken({ fid: "file_1", sid: "reported" });

        const observation = {
          _tag: "BufferingStarted",
          positionSeconds: 1,
          bufferedAheadSeconds: 0,
        };

        const stall = { ageMs: 0, observation };

        const send = (body: WireBatch) =>
          HttpClient.execute(
            HttpClientRequest.post(`${server.baseUrl}/api/playback/diagnostics`).pipe(
              HttpClientRequest.bodyJsonUnsafe(body),
            ),
          ).pipe(Effect.orDie);

        assert.strictEqual((yield* send({ token, platform: "web", events: [stall] })).status, 204);
        assert.isTrue(
          server
            .logged()
            .some(
              (entry) =>
                entry.message === "Player.buffering_started" &&
                entry.annotations["sessionId"] === "reported",
            ),
        );

        const tooMany = Array.from({ length: 101 }, () => stall);

        assert.strictEqual((yield* send({ token, platform: "web", events: tooMany })).status, 400);
        assert.strictEqual(
          (yield* send({
            token,
            platform: "web",
            events: [{ ageMs: 0, observation: { ...observation, _tag: "Unknown" } }],
          })).status,
          400,
        );
        assert.strictEqual(
          (yield* send({ token, platform: "web", events: [{ ...stall, ageMs: 3_600_000 }] }))
            .status,
          400,
        );
        assert.strictEqual(
          (yield* send({ token: "v1.forged.token", platform: "web", events: [stall] })).status,
          401,
        );

        const hundred = Array.from({ length: 100 }, () => stall);

        const refused = yield* send({ token, platform: "web", events: hundred }).pipe(
          Effect.repeat({ until: (response) => response.status === 429, times: 5 }),
        );

        assert.strictEqual(refused.status, 429);
        assert.match(refused.headers["retry-after"] ?? "", /^[1-9]\d*$/u);
      }),
    );
  });

  layer(MediaTestServer.layer(), {
    excludeTestServices: true,
    timeout: "120 seconds",
  })("with default logs", (it) => {
    it.effect("files a refused expired token under its session as a failed request", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const token = signTestToken({ fid: "file_1", sid: "lapsed", exp: Date.now() - 1 });

        for (const file of ["index.m3u8", "0.m4s"]) {
          const refused = yield* get(
            `${server.baseUrl}/media/hls/${UNKNOWN_STREAM}/1/${file}?token=${token}`,
          );

          assert.strictEqual(refused.status, 401);
        }

        assert.deepStrictEqual(
          server
            .logged()
            .filter((entry) => entry.annotations["sessionId"] === "lapsed")
            .map((entry) => [
              entry.message,
              entry.level,
              entry.annotations["route"],
              entry.annotations["status"],
              entry.annotations["userId"],
              entry.annotations["error"],
            ]),
          [
            [
              "MediaRoutes.request_failed",
              "WARN",
              "playlist",
              401,
              "user_test",
              "Playback token has expired",
            ],
            [
              "MediaRoutes.request_failed",
              "WARN",
              "hls",
              401,
              "user_test",
              "Playback token has expired",
            ],
          ],
        );
      }),
    );

    it.effect("logs a player's expired-token refusals within its session's budget", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const token = signTestToken({ fid: "file_1", sid: "lapsed-flood", exp: Date.now() - 1 });

        for (let index = 0; index < 100; index += 1) {
          const refused = yield* get(
            `${server.baseUrl}/media/hls/${UNKNOWN_STREAM}/1/${index}.m4s?token=${token}`,
          );

          assert.strictEqual(refused.status, 401);
        }

        const warnings = server
          .logged()
          .filter(
            (entry) => entry.annotations["sessionId"] === "lapsed-flood" && entry.level === "WARN",
          );

        assert.isAtLeast(warnings.length, 30);
        assert.isAtMost(warnings.length, 32);
      }),
    );

    it.effect(
      "keeps a member's real failures at WARN, in the replayed session too, however many expired tokens are replayed",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;

          for (let session = 0; session < 4; session += 1) {
            const token = signTestToken({
              fid: "file_1",
              sid: `replayed-${String(session)}`,
              exp: 1,
            });

            for (let index = 0; index < 40; index += 1) {
              const refused = yield* get(
                `${server.baseUrl}/media/hls/${UNKNOWN_STREAM}/1/${index}.m4s?token=${token}`,
              );

              assert.strictEqual(refused.status, 401);
            }
          }

          for (const sid of ["after-replay", "replayed-0"]) {
            const live = yield* get(
              `${server.baseUrl}/media/hls/${UNKNOWN_STREAM}/1/99.m4s?token=${signTestToken({ fid: "file_1", sid })}`,
            );

            assert.strictEqual(live.status, 404);

            assert.deepStrictEqual(
              server
                .logged()
                .filter(
                  (entry) =>
                    entry.annotations["sessionId"] === sid && entry.annotations["status"] === 404,
                )
                .map((entry) => [entry.message, entry.level]),
              [["MediaRoutes.request_failed", "WARN"]],
            );
          }
        }),
    );
  });

  layer(MediaTestServer.layer({ LOG_LEVEL: "debug" }, { convex: true }), {
    excludeTestServices: true,
    timeout: "120 seconds",
  })("with Convex and debug logs", (it) => {
    it.effect("files every request after its session ended under it, outside the budget", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const convex = yield* TestConvex.Service;

        yield* convex.end("hammered");
        yield* convex.report("after-hammered", "paused", 0);

        for (let index = 0; index < 100; index += 1) {
          const exp = index % 2 === 0 ? Date.now() + 60_000 : Date.now() - 1;

          const refused = yield* get(
            `${server.baseUrl}/media/hls/${UNKNOWN_STREAM}/1/${index}.m4s?token=${signTestToken({ fid: "file_1", sid: "hammered", exp })}`,
          );

          assert.strictEqual(refused.status, 410);
        }

        const logged = server
          .logged()
          .filter((entry) => entry.annotations["sessionId"] === "hammered");

        assert.strictEqual(logged.length, 100);

        assert.deepStrictEqual(
          [
            ...new Set(
              logged.map((entry) =>
                JSON.stringify([
                  entry.message,
                  entry.level,
                  entry.annotations["userId"],
                  entry.annotations["status"],
                ]),
              ),
            ),
          ],
          [JSON.stringify(["MediaRoutes.request_after_session_ended", "DEBUG", "user_test", 410])],
        );

        const live = yield* get(
          `${server.baseUrl}/media/hls/${UNKNOWN_STREAM}/1/0.m4s?token=${signTestToken({ fid: "file_1", sid: "after-hammered" })}`,
        );

        assert.strictEqual(live.status, 404);

        assert.deepStrictEqual(
          server
            .logged()
            .filter((entry) => entry.annotations["sessionId"] === "after-hammered")
            .map((entry) => [entry.message, entry.level]),
          [["MediaRoutes.request_failed", "WARN"]],
        );
      }),
    );
  });

  layer(MediaTestServer.layer({}, { convex: true }), {
    excludeTestServices: true,
    timeout: "120 seconds",
  })("with Convex and default logs", (it) => {
    it.effect("files no failure for a request after its session ended, its token expired too", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        yield* (yield* TestConvex.Service).end("finished");

        for (const exp of [Date.now() + 60_000, Date.now() - 1]) {
          const refused = yield* get(
            `${server.baseUrl}/media/hls/${UNKNOWN_STREAM}/1/0.m4s?token=${signTestToken({ fid: "file_1", sid: "finished", exp })}`,
          );

          assert.strictEqual(refused.status, 410);
        }

        assert.deepStrictEqual(
          server.logged().filter((entry) => entry.annotations["sessionId"] === "finished"),
          [],
        );
      }),
    );
  });

  layer(MediaTestServer.layer({ CONVEX_PUBLIC_URL: "https://convex.example.com/" }), {
    excludeTestServices: true,
    timeout: "120 seconds",
  })("with a public Convex URL", (it) => {
    it.effect("tells apps where to sign in", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const response = yield* get(`${server.baseUrl}/api/client-config`);

        assert.deepStrictEqual(yield* json(response), { convexUrl: "https://convex.example.com" });
      }),
    );
  });

  layer(
    MediaTestServer.layer({
      HARDWARE_ACCELERATION: "auto",
      FFMPEG_PATH: process.env["FFMPEG_PATH"] ?? "ffmpeg",
      QSV_DEVICE: process.env["QSV_DEVICE"] ?? "/dev/dri/renderD128",
    }),
    { excludeTestServices: true, timeout: "120 seconds" },
  )("on Intel Quick Sync hardware", (it) => {
    it.effect.skipIf(!hasQsv)("tone-maps HDR10 HEVC to SDR H.264", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const { library } = yield* FixtureWorkspace.Service;
        const fileId = server.fileId("movies", library.hdrMovie);

        const result = yield* negotiated({
          token: signTestToken({ fid: fileId, sid: "qsv" }),
          capabilities: browser,
        });

        assert.strictEqual(result.mode, "transcode-qsv");
        assert.deepStrictEqual(result.video, {
          codec: "h264",
          width: 320,
          height: 180,
          dynamicRange: "sdr",
        });
        const { init, segment } = yield* fetchSegment(local(server.baseUrl, result.url), 0);
        const probe = yield* probeBytes(concat(yield* bytes(init), yield* bytes(segment)));

        assert.deepStrictEqual(
          [probe.video?.codec, probe.video?.bitDepth, probe.video?.dynamicRange],
          ["h264", 8, "sdr"],
        );
      }),
    );
  });

  layer(
    MediaTestServer.layer({
      HARDWARE_ACCELERATION: "vaapi",
      FFMPEG_PATH: process.env["FFMPEG_PATH"] ?? "ffmpeg",
      VAAPI_DEVICE: process.env["VAAPI_DEVICE"] ?? "/dev/dri/renderD128",
    }),
    { excludeTestServices: true, timeout: "120 seconds" },
  )("on VA-API hardware", (it) => {
    it.effect.skipIf(!hasVaapi)("tone-maps HDR10 HEVC to SDR H.264", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const { library } = yield* FixtureWorkspace.Service;
        const fileId = server.fileId("movies", library.hdrMovie);

        const result = yield* negotiated({
          token: signTestToken({ fid: fileId, sid: "vaapi" }),
          capabilities: browser,
        });

        assert.strictEqual(result.mode, "transcode-vaapi");
        const { init, segment } = yield* fetchSegment(local(server.baseUrl, result.url), 0);
        const probe = yield* probeBytes(concat(yield* bytes(init), yield* bytes(segment)));

        assert.deepStrictEqual(
          [probe.video?.codec, probe.video?.bitDepth, probe.video?.dynamicRange],
          ["h264", 8, "sdr"],
        );
      }),
    );
  });
});

describe.skipIf(!hasFfmpeg)("fragment refresh", () => {
  layer(MediaTestServer.layer({}, { fileSystem: overlappingListings }), {
    excludeTestServices: true,
    timeout: "120 seconds",
  })((it) => {
    it.effect(
      "serves each fragment once when a player asks for several segments at once",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;
          const frame = 1 / 24;

          const result = yield* negotiated({
            token: signTestToken({
              fid: server.fileId("movies", library.remuxMovie),
              sid: "burst",
            }),
            capabilities: withDolbyAudio,
          });

          assert.strictEqual(result.mode, "remux");
          const playlistUrl = local(server.baseUrl, result.url);

          generationListings.most = 0;

          const [init, ...segments] = yield* Effect.all(
            [
              streamFile(playlistUrl, "init.mp4"),
              ...[0, 1, 2].map((index) => streamFile(playlistUrl, `${index}.m4s`)),
            ],
            { concurrency: "unbounded" },
          );

          assert.strictEqual(generationListings.most, 1);
          assert.strictEqual(init.status, 200);
          const header = yield* bytes(init);
          const planned = yield* playlistSegments(playlistUrl);

          const spans = yield* Effect.forEach(
            segments,
            Effect.fnUntraced(function* (segment, index) {
              assert.strictEqual(segment.status, 200);

              const packets = yield* videoPackets(concat(header, yield* bytes(segment)));
              const span = spanOf(packets);

              assert.strictEqual(
                new Set(packets.map((packet) => packet.pts_time)).size,
                packets.length,
              );
              assert.approximately(span.end - span.start, planned[index]?.duration ?? 0, frame);

              return span;
            }),
          );

          for (const [index, span] of spans.entries()) {
            if (index > 0) assert.approximately(span.start, spans[index - 1]?.end ?? 0, frame);
          }
        }),
      60_000,
    );
  });
});
