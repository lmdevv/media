import { join } from "node:path";

import { assert, describe, layer } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Path, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { LibraryId } from "@media/contracts/ids";
import {
  type ClientCapabilities,
  NegotiateResponse,
  SeekResponse,
} from "@media/contracts/media-playback";

import * as LibraryScanner from "../library/library-scanner.ts";
import * as MemoryLibrary from "../library/memory-library.ts";
import * as MediaTools from "../media/media-tools.ts";
import { invocationsOf, type RunRule, writeFakeFfmpeg } from "../testing/fake-ffmpeg.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import { signTestToken } from "../testing/test-tokens.ts";

const hasFfmpeg = await ffmpegAvailable();

const VOBSUB = join(import.meta.dirname, "..", "testing", "fixtures", "vobsub.mkv");

const FILM = "Recovered (2021)/Recovered (2021).mkv";

/**
 * What ffmpeg prints when `vpp_qsv`, here scaling and tone mapping at once, fails at start. In a
 * run that burns a subtitle in after a seek, the picture's `trim` is the graph's first filter, so
 * `vpp_qsv` is its second.
 */
const VPP_FAILED = "[Parsed_vpp_qsv_1 @ 0x1] Invalid color_matrix.";

/** The first stream run that tone-maps on Quick Sync fails; its probe then fails too. */
const TONE_MAP_FAILS: ReadonlyArray<RunRule> = [
  { token: "tonemap=1", runs: "hls", stderr: VPP_FAILED, arm: "tonemap", limit: 1 },
  { token: "tonemap=1", runs: "probe", stderr: VPP_FAILED, armedBy: "tonemap" },
];

/** Then the first run that tone-maps on the CPU fails, naming nothing. */
const CPU_TONE_MAP_FAILS: RunRule = {
  token: "zscale",
  runs: "hls",
  stderr: "Conversion failed!",
  limit: 1,
};

/** Then every software encode fails. */
const SOFTWARE_FAILS: RunRule = { token: "libx264", runs: "hls", stderr: "Conversion failed!" };

const once = await writeFakeFfmpeg({ rules: TONE_MAP_FAILS, logInvocations: true });

const onceMore = await writeFakeFfmpeg({ rules: TONE_MAP_FAILS, logInvocations: true });

const twice = await writeFakeFfmpeg({
  rules: [...TONE_MAP_FAILS, CPU_TONE_MAP_FAILS],
  logInvocations: true,
});

const thrice = await writeFakeFfmpeg({
  rules: [...TONE_MAP_FAILS, CPU_TONE_MAP_FAILS, SOFTWARE_FAILS],
  logInvocations: true,
});

/** ffmpeg starts for every stream run but the second, which never starts. */
const replacementNeverStarts = (real: MediaTools.Interface): MediaTools.Interface => {
  let streamRuns = 0;

  return MediaTools.Service.of({
    ...real,
    startFfmpeg: (args) => {
      if (args.includes("hls")) streamRuns += 1;

      return streamRuns === 2
        ? Effect.fail(
            new MediaTools.MediaToolFailed({
              tool: "ffmpeg",
              exitCode: null,
              signal: null,
              stderr: "could not start ffmpeg",
              stderrHead: "",
              cause: new Error("spawn EAGAIN"),
            }),
          )
        : real.startFfmpeg(args);
    },
  });
};

/** Runs stall after their first fragment until killed, so a seek replaces a live run. */
const stalling = await writeFakeFfmpeg({ hlsStallsAfterFragments: 1, logInvocations: true });

const browser: ClientCapabilities = {
  containers: [],
  videoCodecs: [{ codec: "h264", maxBitDepth: 8 }],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 1920,
  maxHeight: 1080,
  hls: false,
  mse: true,
};

/** The browser on a small screen, where a 1080p source is scaled down. */
const smallBrowser: ClientCapabilities = {
  containers: [],
  videoCodecs: [{ codec: "h264", maxBitDepth: 8 }],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 1920,
  maxHeight: 120,
  hls: false,
  mse: true,
};

/** A negotiation's body, its capabilities the browser's unless given. */
interface NegotiateBody {
  readonly token: string;
  readonly capabilities?: ClientCapabilities;
  readonly startSeconds?: number;
  readonly audioStreamIndex?: number;
  readonly burnInSubtitle?: string;
  readonly quality?: { readonly maxHeight?: number; readonly maxBitrate?: number };
}

/** The viewer's choices every replacement must keep. */
const CHOICES = {
  startSeconds: 6,
  audioStreamIndex: 2,
  burnInSubtitle: "e3",
  quality: { maxHeight: 180, maxBitrate: 1_500_000 },
} as const;

const decodeNegotiation = Schema.decodeUnknownEffect(Schema.toCodecJson(NegotiateResponse));

const decodeSeek = Schema.decodeUnknownEffect(Schema.toCodecJson(SeekResponse));

/**
 * Twelve seconds of HEVC Main 10 tagged HDR10 at 640x360 with an AAC track (1), an AC-3 track (2),
 * and a DVD subtitle (3), in a library of its own.
 */
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
    "testsrc2=size=640x360:rate=24:duration=12",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=12",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=660:sample_rate=48000:duration=12",
    "-i",
    VOBSUB,
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-map",
    "2:a",
    "-map",
    "3:s",
    "-vf",
    "format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc",
    "-c:v",
    "libx265",
    "-preset",
    "ultrafast",
    "-x265-params",
    "log-level=error:keyint=48",
    "-color_primaries",
    "bt2020",
    "-color_trc",
    "smpte2084",
    "-colorspace",
    "bt2020nc",
    "-c:a:0",
    "aac",
    "-c:a:1",
    "ac3",
    "-c:s",
    "copy",
    output,
  ]);
  yield* scanner.scan({ libraryId, root, mode: "incremental" });

  return MemoryLibrary.fileIdOf(libraryId, FILM);
});

const negotiate = Effect.fn(function* (body: NegotiateBody) {
  const server = yield* MediaTestServer.Service;

  const response = yield* HttpClient.execute(
    HttpClientRequest.post(`${server.baseUrl}/api/playback/negotiate`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ capabilities: body.capabilities ?? browser, ...body }),
    ),
  ).pipe(Effect.orDie);

  return { status: response.status, body: yield* response.json.pipe(Effect.orDie) };
});

const negotiated = Effect.fn(function* (body: NegotiateBody) {
  const answer = yield* negotiate(body);

  assert.strictEqual(answer.status, 200, JSON.stringify(answer.body));

  return yield* decodeNegotiation(answer.body).pipe(Effect.orDie);
});

const fetchStatus = Effect.fn(function* (url: string) {
  const server = yield* MediaTestServer.Service;
  const parsed = new URL(url);

  return yield* HttpClient.get(`${server.baseUrl}${parsed.pathname}${parsed.search}`).pipe(
    Effect.map((response) => response.status),
    Effect.orDie,
  );
});

const segmentOf = (playlist: string, index: number): string => {
  const url = new URL(playlist);

  return new URL(`${String(index)}.m4s${url.search}`, url).toString();
};

/** The arguments of each HLS run of `streamId` the stand-in at `ffmpeg` logged, in order. */
const runsOf = (ffmpeg: string, streamId: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const log = yield* fs.readFileString(invocationsOf(ffmpeg)).pipe(Effect.orDie);

    return log
      .split("\n")
      .filter((line) => line.includes(`/${streamId}/`) && line.includes('"hls"'))
      .map((line) => Schema.decodeUnknownSync(Schema.Array(Schema.String))(JSON.parse(line)));
  });

const valuesAfter = (args: ReadonlyArray<string>, flag: string): ReadonlyArray<string> =>
  args.flatMap((arg, index) => (arg === flag ? [args[index + 1] ?? ""] : []));

/** What a replacement must keep: where it reads from, the audio it maps, the rate, the subtitle. */
const kept = (args: ReadonlyArray<string>) => ({
  seeks: valuesAfter(args, "-ss"),
  audio: args.slice(args.lastIndexOf("-map"), args.indexOf("-map_metadata")),
  maxrate: valuesAfter(args, "-maxrate"),
  subtitle: valuesAfter(args, "-filter_complex").some((graph) => graph.includes("[0:3]")),
});

const recovering = (ffmpeg: string) =>
  MediaTestServer.layer({ FFMPEG_PATH: ffmpeg, HARDWARE_ACCELERATION: "qsv" });

const options = { excludeTestServices: true, timeout: "180 seconds" } as const;

describe.skipIf(!hasFfmpeg)("stream recovery", () => {
  layer(
    recovering(once),
    options,
  )((it) => {
    it.effect(
      "replaces a tone map that fails at start and keeps the encode on the GPU, and another viewer's chain",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;
          const fileId = yield* addFilm("recovered-once");

          const other = yield* negotiated({
            token: signTestToken({
              fid: server.fileId("movies", library.directMovie),
              sid: "other",
            }),
            capabilities: smallBrowser,
          });

          assert.strictEqual(other.mode, "transcode-qsv");

          const film = yield* negotiated({
            token: signTestToken({ fid: fileId, sid: "film" }),
            ...CHOICES,
          });

          assert.strictEqual(film.mode, "transcode-qsv", "the encode stays on the GPU");
          assert.strictEqual(film.generation, 2, "the negotiation answers the generation that ran");
          assert.strictEqual(yield* fetchStatus(segmentOf(film.url, 3)), 200);

          const runs = yield* runsOf(once, film.streamId ?? "");
          const [first = [], replacement = []] = runs;

          assert.lengthOf(runs, 2);
          assert.isTrue(first.join(" ").includes("tonemap=1"));
          assert.isTrue(replacement.join(" ").includes("zscale"), "tone-mapped on the CPU");
          assert.include(replacement, "h264_qsv");
          assert.include(replacement, "-hwaccel");
          assert.deepStrictEqual(kept(replacement), kept(first));
          assert.isTrue(kept(first).subtitle);
          assert.deepStrictEqual(kept(first).maxrate, ["1500000"]);

          // The other viewer's run went on as it was, and a new viewer of an SDR file still gets
          // the whole chain on the GPU: the quarantined tone map is in neither.
          assert.strictEqual(yield* fetchStatus(segmentOf(other.url, 4)), 200);

          const next = yield* negotiated({
            token: signTestToken({
              fid: server.fileId("movies", library.directMovie),
              sid: "next",
            }),
            capabilities: smallBrowser,
          });

          assert.strictEqual(next.mode, "transcode-qsv");

          for (const run of [
            ...(yield* runsOf(once, other.streamId ?? "")),
            ...(yield* runsOf(once, next.streamId ?? "")),
          ]) {
            assert.include(run, "h264_qsv");
            assert.include(run, "-hwaccel");
            assert.notInclude(run.join(" "), "zscale");
          }
        }),
      120_000,
    );
  });

  layer(
    recovering(twice),
    options,
  )((it) => {
    it.effect(
      "runs on the CPU after a second failure, keeping what the viewer chose",
      () =>
        Effect.gen(function* () {
          const fileId = yield* addFilm("recovered-twice");

          const film = yield* negotiated({
            token: signTestToken({ fid: fileId, sid: "film" }),
            ...CHOICES,
          });

          assert.strictEqual(film.mode, "transcode-software");
          assert.strictEqual(film.generation, 3);
          assert.strictEqual(yield* fetchStatus(segmentOf(film.url, 3)), 200);

          const runs = yield* runsOf(twice, film.streamId ?? "");
          const [first = []] = runs;
          const last = runs.at(-1) ?? [];

          assert.lengthOf(runs, 3);
          assert.include(last, "libx264");
          assert.notInclude(last, "-hwaccel");
          assert.notInclude(last, "-init_hw_device");
          assert.deepStrictEqual(kept(last), kept(first));
        }),
      120_000,
    );
  });

  layer(
    recovering(thrice),
    options,
  )((it) => {
    it.effect(
      "answers TranscodeFailed after a third failure and leaves nothing to attach to",
      () =>
        Effect.gen(function* () {
          const fileId = yield* addFilm("recovered-thrice");
          const token = signTestToken({ fid: fileId, sid: "film" });
          const answer = yield* negotiate({ token, ...CHOICES });

          assert.strictEqual(answer.status, 500, JSON.stringify(answer.body));
          assert.deepInclude(answer.body, { _tag: "TranscodeFailed" });

          const server = yield* MediaTestServer.Service;
          const fs = yield* FileSystem.FileSystem;
          const log = yield* fs.readFileString(invocationsOf(thrice)).pipe(Effect.orDie);
          const hlsRuns = log.split("\n").filter((line) => line.includes('"hls"'));

          assert.lengthOf(hlsRuns, 3, "three ffmpeg starts for one position, no more");

          const streams = yield* fs
            .readDirectory(server.transcodeDir)
            .pipe(Effect.orElseSucceed(() => []));

          assert.deepStrictEqual(
            streams.filter((name) => name !== "downloads"),
            [],
            "no stream is left behind",
          );
        }),
      120_000,
    );
  });

  layer(
    MediaTestServer.layer({ FFMPEG_PATH: stalling }),
    options,
  )((it) => {
    it.effect(
      "changes nothing when a replaced generation's run ends after a seek",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;

          const token = signTestToken({
            fid: server.fileId("movies", library.directMovie),
            sid: "late",
          });

          const stream = yield* negotiated({ token, capabilities: smallBrowser });
          const waiting = yield* fetchStatus(segmentOf(stream.url, 1)).pipe(Effect.forkChild);

          yield* Effect.sleep("300 millis");

          const moved = yield* HttpClient.execute(
            HttpClientRequest.post(`${server.baseUrl}/api/playback/seek`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                token,
                streamId: stream.streamId,
                positionSeconds: 10,
              }),
            ),
          ).pipe(
            Effect.flatMap((response) => response.json),
            Effect.flatMap(decodeSeek),
            Effect.orDie,
          );

          const late = yield* Fiber.join(waiting);

          // The second generation's run has started; give a late replacement time to show.
          yield* runsOf(stalling, stream.streamId ?? "").pipe(
            Effect.filterOrFail((runs) => runs.length >= 2),
            Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 50 }),
            Effect.orDie,
          );
          yield* Effect.sleep("1 second");

          assert.strictEqual(late, 410, "the old generation's reader is told it moved");
          assert.strictEqual(moved.generation, (stream.generation ?? 0) + 1);
          assert.lengthOf(yield* runsOf(stalling, stream.streamId ?? ""), 2, "no replacement run");
          assert.deepStrictEqual(
            server
              .logged()
              .filter(
                (entry) =>
                  entry.annotations["streamId"] === stream.streamId &&
                  (entry.message === "StreamSessions.encoder_failed" ||
                    entry.message === "StreamSessions.pipeline_replaced"),
              ),
            [],
          );
        }),
      60_000,
    );
  });

  layer(
    MediaTestServer.layer(
      { FFMPEG_PATH: onceMore, HARDWARE_ACCELERATION: "qsv" },
      { mediaTools: replacementNeverStarts },
    ),
    options,
  )((it) => {
    it.effect(
      "answers TranscodeFailed when a replacement's ffmpeg never starts, leaving no stream",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const fs = yield* FileSystem.FileSystem;
          const fileId = yield* addFilm("never-replaced");

          const answer = yield* negotiate({
            token: signTestToken({ fid: fileId, sid: "film" }),
            ...CHOICES,
          });

          assert.strictEqual(answer.status, 500, JSON.stringify(answer.body));
          assert.deepInclude(answer.body, {
            _tag: "TranscodeFailed",
            detail: "could not start ffmpeg",
          });

          const streams = yield* fs
            .readDirectory(server.transcodeDir)
            .pipe(Effect.orElseSucceed(() => []));

          assert.deepStrictEqual(
            streams.filter((name) => name !== "downloads"),
            [],
            "no generation is left to attach to",
          );
        }),
      120_000,
    );
  });
});
