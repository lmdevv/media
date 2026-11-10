import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path, Predicate, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";

import {
  type ClientCapabilities,
  type DownloadQuality,
  PrepareDownloadResponse,
} from "@media/contracts/media-playback";

import * as MediaTools from "../media/media-tools.ts";
import { parseFfprobeJson } from "../media/media-probe.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import { signTestToken } from "../testing/test-tokens.ts";

const hasFfmpeg = await ffmpegAvailable();

const iphone: ClientCapabilities = {
  containers: ["mp4", "mov"],
  videoCodecs: [{ codec: "h264", maxLevel: 52, maxBitDepth: 8 }, { codec: "hevc" }],
  audioCodecs: [{ codec: "aac" }, { codec: "ac3", maxChannels: 6 }, { codec: "eac3" }],
  maxWidth: 3840,
  maxHeight: 2160,
  hls: true,
  mse: false,
};

const tinyScreen: ClientCapabilities = {
  containers: iphone.containers,
  videoCodecs: iphone.videoCodecs,
  audioCodecs: iphone.audioCodecs,
  maxWidth: 1920,
  maxHeight: 120,
  hls: true,
  mse: false,
};

const decodeRefusal = Schema.decodeUnknownEffect(Schema.Struct({ reason: Schema.String }));

const byName = (left: string, right: string) => left.localeCompare(right);

const decodePrepared = Schema.decodeUnknownEffect(Schema.toCodecJson(PrepareDownloadResponse));

const local = (baseUrl: string, url: string): string => {
  const parsed = new URL(url);

  return `${baseUrl}${parsed.pathname}${parsed.search}`;
};

const get = (url: string, headers: Readonly<Record<string, string>> = {}) =>
  HttpClient.get(url, { headers }).pipe(Effect.orDie);

const bytes = (response: HttpClientResponse.HttpClientResponse) =>
  response.arrayBuffer.pipe(
    Effect.map((buffer) => new Uint8Array(buffer)),
    Effect.orDie,
  );

const prepare = Effect.fn(function* (body: {
  readonly token: string;
  readonly capabilities: ClientCapabilities;
  readonly quality: DownloadQuality;
  readonly audioStreamIndex?: number;
}) {
  const server = yield* MediaTestServer.Service;

  const response = yield* HttpClient.execute(
    HttpClientRequest.post(`${server.baseUrl}/api/downloads/prepare`).pipe(
      HttpClientRequest.bodyJsonUnsafe(body),
    ),
  ).pipe(Effect.orDie);

  return { status: response.status, body: yield* response.json.pipe(Effect.orDie) };
});

const prepared = Effect.fn(function* (body: Parameters<typeof prepare>[0]) {
  const result = yield* prepare(body);

  assert.strictEqual(result.status, 200, JSON.stringify(result.body));

  return yield* decodePrepared(result.body).pipe(Effect.orDie);
});

const readyOf = (answer: PrepareDownloadResponse) =>
  Predicate.isTagged(answer, "Ready")
    ? Effect.succeed(answer)
    : Effect.die(new Error(`Expected a ready download, got ${JSON.stringify(answer)}`));

const untilReady = Effect.fn(function* (body: Parameters<typeof prepare>[0]) {
  const answers: Array<PrepareDownloadResponse> = [];

  const ready = yield* prepared(body).pipe(
    Effect.tap((answer) => Effect.sync(() => answers.push(answer))),
    Effect.repeat({
      schedule: Schedule.spaced("200 millis"),
      until: (answer) => Predicate.isTagged(answer, "Ready"),
      times: 300,
    }),
  );

  return { ready: yield* readyOf(ready), answers };
});

const probeBytes = Effect.fn(function* (data: Uint8Array) {
  const fs = yield* FileSystem.FileSystem;
  const tools = yield* MediaTools.Service;
  const file = yield* fs.makeTempFileScoped({ suffix: ".mp4" });

  yield* fs.writeFile(file, data);

  const output = yield* tools.ffprobe([
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    file,
  ]);

  return yield* parseFfprobeJson(output, file);
});

describe.skipIf(!hasFfmpeg)("downloads over HTTP", () => {
  layer(MediaTestServer.layer(), { excludeTestServices: true, timeout: "120 seconds" })((it) => {
    it.effect(
      "keeps a file the device plays within the quality as it is",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const fileId = server.fileId("movies", library.directMovie);
          const token = signTestToken({ fid: fileId, sid: "download-direct", pur: "download" });

          const result = yield* readyOf(
            yield* prepared({ token, capabilities: iphone, quality: "standard" }),
          );

          const original = yield* fs.readFile(path.join(library.moviesRoot, library.directMovie));

          assert.strictEqual(result.mode, "direct");
          assert.strictEqual(
            result.url,
            `http://media.test/media/direct/${fileId}?token=${encodeURIComponent(token)}`,
          );
          assert.strictEqual(result.sizeBytes, original.length);
          assert.strictEqual(result.container, "mp4");
          assert.deepStrictEqual(result.audio, { streamIndex: 1, codec: "aac", channels: 1 });
        }),
      60_000,
    );

    it.effect(
      "writes an MKV as an MP4 once, reports progress, and serves byte ranges",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;
          const fileId = server.fileId("movies", library.remuxMovie);
          const token = signTestToken({ fid: fileId, sid: "download-remux", pur: "download" });
          const first = yield* prepared({ token, capabilities: iphone, quality: "standard" });

          assert.isTrue(Predicate.isTagged(first, "Preparing"));

          const { ready, answers } = yield* untilReady({
            token,
            capabilities: iphone,
            quality: "standard",
          });

          for (const answer of answers.slice(0, -1)) {
            assert.isTrue(Predicate.isTagged(answer, "Preparing"));
          }

          assert.strictEqual(ready.mode, "remux");
          assert.strictEqual(ready.container, "mp4");
          assert.deepStrictEqual(ready.audio, { streamIndex: 1, codec: "ac3", channels: 1 });
          assert.match(
            ready.url,
            new RegExp(`/media/downloads/${fileId}/[a-f0-9]{24}\\.mp4\\?token=`),
          );
          assert.strictEqual(ready.subtitles.length, 3);

          for (const subtitle of ready.subtitles) {
            const vtt = yield* get(local(server.baseUrl, subtitle.url));

            assert.strictEqual(vtt.status, 200);
          }

          const url = local(server.baseUrl, ready.url);
          const partial = yield* get(url, { range: "bytes=0-99" });

          assert.strictEqual(partial.status, 206);
          assert.strictEqual(partial.headers["content-range"], `bytes 0-99/${ready.sizeBytes}`);
          assert.strictEqual((yield* bytes(partial)).length, 100);

          const whole = yield* bytes(yield* get(url));

          assert.strictEqual(whole.length, ready.sizeBytes);
          const probe = yield* probeBytes(whole);

          assert.strictEqual(probe.container, "mp4");
          assert.strictEqual(probe.video?.codec, "h264");
          assert.deepStrictEqual(
            probe.audio.map((track) => track.codec),
            ["ac3"],
          );
          assert.approximately(probe.durationSeconds, 12, 0.5);

          const again = yield* readyOf(
            yield* prepared({
              token: signTestToken({ fid: fileId, sid: "download-remux-2", pur: "download" }),
              capabilities: iphone,
              quality: "standard",
            }),
          );

          assert.strictEqual(again.sizeBytes, ready.sizeBytes);
        }),
      120_000,
    );

    it.effect(
      "keeps another audio track when asked for it",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;
          const remux = server.fileId("movies", library.remuxMovie);

          const { ready } = yield* untilReady({
            token: signTestToken({ fid: remux, sid: "download-audio", pur: "download" }),
            capabilities: iphone,
            quality: "high",
            audioStreamIndex: 2,
          });

          assert.strictEqual(ready.audio?.streamIndex, 2);
          assert.strictEqual(ready.audio?.codec, "eac3");

          const probe = yield* probeBytes(
            yield* bytes(yield* get(local(server.baseUrl, ready.url))),
          );

          assert.deepStrictEqual(
            probe.audio.map((track) => track.codec),
            ["eac3"],
          );
        }),
      120_000,
    );

    it.effect(
      "encodes down for a device that needs it",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;
          const direct = server.fileId("movies", library.directMovie);

          const { ready } = yield* untilReady({
            token: signTestToken({ fid: direct, sid: "download-encode", pur: "download" }),
            capabilities: tinyScreen,
            quality: "standard",
          });

          assert.strictEqual(ready.mode, "transcode-software");
          assert.deepStrictEqual([ready.video.codec, ready.video.height], ["h264", 120]);

          const probe = yield* probeBytes(
            yield* bytes(yield* get(local(server.baseUrl, ready.url))),
          );

          assert.deepStrictEqual([probe.video?.codec, probe.video?.height], ["h264", 120]);
          assert.strictEqual(probe.audio[0]?.codec, "aac");
        }),
      120_000,
    );

    it.effect(
      "stops the MP4 a download session no longer asks for",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const fileId = server.fileId("movies", library.remuxMovie);
          const token = signTestToken({ fid: fileId, sid: "download-switch", pur: "download" });
          const folder = path.join(server.transcodeDir, "downloads", fileId);
          const listing = fs.readDirectory(folder).pipe(Effect.orElseSucceed(() => []));
          const before = yield* listing;

          const smallerScreen: ClientCapabilities = {
            containers: tinyScreen.containers,
            videoCodecs: tinyScreen.videoCodecs,
            audioCodecs: tinyScreen.audioCodecs,
            maxWidth: tinyScreen.maxWidth,
            maxHeight: 90,
            hls: true,
            mse: false,
          };

          const first = yield* prepared({
            token,
            capabilities: smallerScreen,
            quality: "standard",
          });

          assert.isTrue(Predicate.isTagged(first, "Preparing"));

          const { ready } = yield* untilReady({
            token,
            capabilities: tinyScreen,
            quality: "standard",
          });

          const name = new URL(ready.url).pathname.split("/").at(-1) ?? "";

          assert.strictEqual(ready.video.height, 120);
          assert.deepStrictEqual(
            (yield* listing).toSorted(byName),
            [...before, name].toSorted(byName),
          );
        }),
      120_000,
    );

    it.effect(
      "serves a download only to a token for its file",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;
          const fileId = server.fileId("movies", library.remuxMovie);
          const token = signTestToken({ fid: fileId, sid: "download-access", pur: "download" });

          const { ready } = yield* untilReady({ token, capabilities: iphone, quality: "standard" });
          const name = new URL(ready.url).pathname.split("/").at(-1) ?? "";
          const other = server.fileId("movies", library.directMovie);

          const otherToken = encodeURIComponent(
            signTestToken({ fid: other, sid: "download-access", pur: "download" }),
          );

          const denied = yield* get(
            `${server.baseUrl}/media/downloads/${fileId}/${name}?token=${otherToken}`,
          );

          assert.strictEqual(denied.status, 403);

          const unknown = yield* get(
            `${server.baseUrl}/media/downloads/${fileId}/${"0".repeat(24)}.mp4?token=${encodeURIComponent(token)}`,
          );

          assert.strictEqual(unknown.status, 404);

          const unsigned = yield* prepare({
            token: "v1.e30.AAAA",
            capabilities: iphone,
            quality: "standard",
          });

          assert.strictEqual(unsigned.status, 401);
        }),
      120_000,
    );

    it.effect(
      "keeps download tokens to downloads and playback tokens to streaming",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;
          const fileId = server.fileId("movies", library.remuxMovie);

          const downloading = signTestToken({
            fid: fileId,
            sid: "purpose-download",
            pur: "download",
          });

          const playing = signTestToken({ fid: fileId, sid: "purpose-play" });

          const { ready } = yield* untilReady({
            token: downloading,
            capabilities: iphone,
            quality: "standard",
          });

          const refused = yield* prepare({
            token: playing,
            capabilities: iphone,
            quality: "standard",
          });

          assert.deepStrictEqual(
            [refused.status, (yield* decodeRefusal(refused.body).pipe(Effect.orDie)).reason],
            [401, "wrong_purpose"],
          );

          const played = yield* get(
            local(server.baseUrl, ready.url).replace(
              encodeURIComponent(downloading),
              encodeURIComponent(playing),
            ),
          );

          assert.strictEqual(played.status, 401);

          const streamed = yield* HttpClient.execute(
            HttpClientRequest.post(`${server.baseUrl}/api/playback/negotiate`).pipe(
              HttpClientRequest.bodyJsonUnsafe({ token: downloading, capabilities: iphone }),
            ),
          ).pipe(Effect.orDie);

          assert.deepStrictEqual(
            [
              streamed.status,
              (yield* streamed.json.pipe(Effect.flatMap(decodeRefusal), Effect.orDie)).reason,
            ],
            [401, "wrong_purpose"],
          );
        }),
      120_000,
    );
  });
});
