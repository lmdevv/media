import { join } from "node:path";

import { assert, describe, layer } from "@effect/vitest";
import { Clock, Effect, Fiber, FileSystem, Option, Path, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { LibraryId } from "@media/contracts/ids";
import {
  type ClientCapabilities,
  NegotiateResponse,
  SeekResponse,
} from "@media/contracts/media-playback";

import * as LibraryScanner from "../library/library-scanner.ts";
import { capabilityOf } from "./capability-inventory.ts";
import * as TranscodeCapabilities from "./transcode-capabilities.ts";
import { capabilityKey, ImplId } from "./video-ops.ts";
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
 * run that burns a subtitle in after a seek, the picture's `trim` is the graph's first filter and
 * the decoder's map into Quick Sync (`hwmap`, `format`) the next two, so `vpp_qsv` is its fourth.
 */
const VPP_FAILED = "[Parsed_vpp_qsv_3 @ 0x1] Invalid color_matrix.";

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

/**
 * Runs from the start write two seconds, so a seek past them starts a new run, and every run that
 * starts eight seconds in or later fails at once, whatever its stages.
 */
const DAMAGED_LATE = {
  hlsFromStartSeconds: 2,
  hlsFailsFromSeconds: 8,
  logInvocations: true,
} as const;

const damagedLate = await writeFakeFfmpeg(DAMAGED_LATE);

/** The same on a build whose CPU cannot tone-map, so a tone map off the GPU has nowhere to go. */
const damagedLateWithoutCpuToneMap = await writeFakeFfmpeg({
  ...DAMAGED_LATE,
  withoutCpuToneMap: true,
});

/** As `damagedLate`, and once a run seeks, every probe takes four seconds, so a diagnosis is slow. */
const slowDiagnosis = await writeFakeFfmpeg({
  ...DAMAGED_LATE,
  rules: [
    { token: "-ss ", runs: "hls", arm: "seeked" },
    { token: "-progress", runs: "probe", armedBy: "seeked", delayMs: 4000 },
  ],
});

/**
 * Runs from the start write two seconds, so a seek past them starts a new run, and the first run
 * that seeks fails at once, naming nothing; every later one plays through.
 */
const failsOnceSeeking = await writeFakeFfmpeg({
  hlsFromStartSeconds: 2,
  rules: [{ token: "-ss ", runs: "hls", stderr: "Conversion failed!", limit: 1 }],
  logInvocations: true,
});

/**
 * The first stream run that tone-maps on Quick Sync fails; from then on every probe takes eight
 * seconds, longer than a diagnosis's whole budget.
 */
const outlastsDiagnosis = await writeFakeFfmpeg({
  rules: [
    { token: "tonemap=1", runs: "hls", stderr: VPP_FAILED, arm: "slow", limit: 1 },
    { token: "-progress", runs: "probe", armedBy: "slow", delayMs: 8000 },
  ],
  logInvocations: true,
});

/** Runs as usual, logging every run. */
const plain = await writeFakeFfmpeg({ logInvocations: true });

/** The tone map fails once, as `once` does, for a stream that encodes HEVC. */
const toneMapFailsUnderHevc = await writeFakeFfmpeg({
  rules: TONE_MAP_FAILS,
  logInvocations: true,
});

/** What ffmpeg prints when Quick Sync's HEVC encoder fails at start. */
const HEVC_QSV_FAILED = "[hevc_qsv @ 0x1] Error initializing the encoder: device failed (-17)";

/** The first stream run that encodes HEVC on Quick Sync fails; its probe then fails too. */
const hevcEncoderFails = await writeFakeFfmpeg({
  rules: [
    { token: "hevc_qsv", runs: "hls", stderr: HEVC_QSV_FAILED, arm: "hevc", limit: 1 },
    { token: "hevc_qsv", runs: "probe", stderr: HEVC_QSV_FAILED, armedBy: "hevc" },
  ],
  logInvocations: true,
});

/** The first stream run that encodes HEVC on Quick Sync fails, naming the encoder; probes pass. */
const hevcEncoderFailsOnce = await writeFakeFfmpeg({
  rules: [{ token: "hevc_qsv", runs: "hls", stderr: HEVC_QSV_FAILED, limit: 1 }],
  logInvocations: true,
});

/** What ffmpeg prints when `vpp_qsv`, deinterlacing and scaling at once, fails at start. */
const DEINTERLACE_FAILED = "[Parsed_vpp_qsv_3 @ 0x1] Failed to configure the deinterlacer.";

/** The first stream run that deinterlaces on Quick Sync fails; its probe then fails too. */
const deinterlacerFails = await writeFakeFfmpeg({
  rules: [
    {
      token: "deinterlace=advanced",
      runs: "hls",
      stderr: DEINTERLACE_FAILED,
      arm: "deinterlace",
      limit: 1,
    },
    {
      token: "deinterlace=advanced",
      runs: "probe",
      stderr: DEINTERLACE_FAILED,
      armedBy: "deinterlace",
    },
  ],
  logInvocations: true,
});

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

/** A device that plays H.264 and HEVC SDR, as Safari or an iPhone does. */
const hevcDevice: ClientCapabilities = {
  containers: [],
  videoCodecs: [{ codec: "h264" }, { codec: "hevc", profiles: ["Main"] }],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 1920,
  maxHeight: 1080,
  hls: true,
  mse: false,
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

/** How a film's picture is coded. */
const PICTURES = {
  /** HEVC Main 10 tagged HDR10. */
  hdr: [
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x360:rate=24:duration=12",
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
  ],
  /** MPEG-2 coded as fields, top first, 25 frames a second. */
  interlaced: [
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x360:rate=50:duration=12",
    "-vf",
    "tinterlace=interleave_top,setfield=tff",
    "-c:v",
    "mpeg2video",
    "-flags",
    "+ildct+ilme",
    "-g",
    "12",
  ],
} as const;

/**
 * Twelve seconds at 640x360, HDR10 HEVC or interlaced MPEG-2, with an AAC track (1), an AC-3
 * track (2), and a DVD subtitle (3), in a library of its own.
 */
const addFilm = Effect.fn(function* (library: string, picture: keyof typeof PICTURES = "hdr") {
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
    ...PICTURES[picture].slice(0, 4),
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
    ...PICTURES[picture].slice(4),
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

/** The status and body of a GET of `url` on the test server. */
const fetchAnswer = Effect.fn(function* (url: string) {
  const server = yield* MediaTestServer.Service;
  const parsed = new URL(url);

  const response = yield* HttpClient.get(
    `${server.baseUrl}${parsed.pathname}${parsed.search}`,
  ).pipe(Effect.orDie);

  return { status: response.status, body: yield* response.text.pipe(Effect.orDie) };
});

const seekTo = Effect.fn(function* (token: string, streamId: string, positionSeconds: number) {
  const server = yield* MediaTestServer.Service;

  return yield* HttpClient.execute(
    HttpClientRequest.post(`${server.baseUrl}/api/playback/seek`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ token, streamId, positionSeconds }),
    ),
  ).pipe(
    Effect.flatMap((response) => response.json),
    Effect.flatMap(decodeSeek),
    Effect.orDie,
  );
});

/** What the server answers a seek of `streamId` to `positionSeconds`: its status and body. */
const seekAnswer = Effect.fn(function* (token: string, streamId: string, positionSeconds: number) {
  const server = yield* MediaTestServer.Service;

  const response = yield* HttpClient.execute(
    HttpClientRequest.post(`${server.baseUrl}/api/playback/seek`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ token, streamId, positionSeconds }),
    ),
  ).pipe(Effect.orDie);

  return { status: response.status, body: yield* response.json.pipe(Effect.orDie) };
});

/** The index of the segment of the playlist at `url` that holds `seconds` into the stream. */
const segmentHolding = Effect.fn(function* (url: string, seconds: number) {
  const playlist = yield* fetchAnswer(url);

  const durations = playlist.body
    .split("\n")
    .filter((line) => line.startsWith("#EXTINF:"))
    .map((line) => Number.parseFloat(line.slice("#EXTINF:".length)));

  let start = 0;

  for (const [index, duration] of durations.entries()) {
    if (seconds < start + duration) return index;
    start += duration;
  }

  return durations.length - 1;
});

/** Waits until the server logged `message` for `streamId`. */
const awaitLogged = (message: string, streamId: string) =>
  Effect.gen(function* () {
    const server = yield* MediaTestServer.Service;

    return server
      .logged()
      .filter((entry) => entry.message === message && entry.annotations["streamId"] === streamId);
  }).pipe(
    Effect.filterOrFail((entries) => entries.length > 0),
    Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
    Effect.orDie,
  );

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
    recovering(damagedLateWithoutCpuToneMap),
    options,
  )((it) => {
    it.effect(
      "answers TranscodeFailed to the request that meets the end of recovery mid-stream",
      () =>
        Effect.gen(function* () {
          const fileId = yield* addFilm("no-chain-left");
          const token = signTestToken({ fid: fileId, sid: "film" });
          const film = yield* negotiated({ token });

          assert.strictEqual(film.mode, "transcode-qsv");
          assert.strictEqual(yield* fetchStatus(segmentOf(film.url, 0)), 200);

          // Ten seconds in, every run fails; without the GPU nothing else can tone-map.
          const moved = yield* seekTo(token, film.streamId ?? "", 10);
          const index = yield* segmentHolding(moved.playlistUrl, 10);
          const ended = yield* fetchAnswer(segmentOf(moved.playlistUrl, index));

          assert.strictEqual(ended.status, 500, ended.body);
          assert.include(ended.body, '"_tag":"TranscodeFailed"');
          assert.strictEqual(yield* fetchStatus(segmentOf(moved.playlistUrl, index)), 404);
        }),
      120_000,
    );
  });

  layer(
    MediaTestServer.layer({ FFMPEG_PATH: damagedLate, STREAM_IDLE_SECONDS: "1" }),
    options,
  )((it) => {
    it.effect(
      "remembers a position that ended in failure: an idle release and a retry start no run there",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;

          const token = signTestToken({
            fid: server.fileId("movies", library.directMovie),
            sid: "damaged",
          });

          const stream = yield* negotiated({ token, capabilities: smallBrowser });
          const streamId = stream.streamId ?? "";

          assert.strictEqual(stream.mode, "transcode-software");
          assert.strictEqual(yield* fetchStatus(segmentOf(stream.url, 0)), 200);

          const moved = yield* seekTo(token, streamId, 10);
          const index = yield* segmentHolding(moved.playlistUrl, 10);
          const failed = yield* fetchAnswer(segmentOf(moved.playlistUrl, index));

          assert.strictEqual(failed.status, 500, failed.body);
          const runs = (yield* runsOf(damagedLate, streamId)).length;

          yield* awaitLogged("Stream.released", streamId);
          const retried = yield* fetchAnswer(segmentOf(moved.playlistUrl, index));

          assert.strictEqual(retried.status, 500, retried.body);
          assert.include(retried.body, '"_tag":"TranscodeFailed"');
          assert.lengthOf(yield* runsOf(damagedLate, streamId), runs, "no run starts there again");
        }),
      120_000,
    );
  });

  layer(
    MediaTestServer.layer({ FFMPEG_PATH: failsOnceSeeking }),
    options,
  )((it) => {
    it.effect(
      "forgets a position that ended in failure once a later run serves it, so a seek straight back plays",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;

          const token = signTestToken({
            fid: server.fileId("movies", library.directMovie),
            sid: "forgotten",
          });

          const stream = yield* negotiated({ token, capabilities: smallBrowser });
          const streamId = stream.streamId ?? "";

          assert.strictEqual(stream.mode, "transcode-software");
          assert.strictEqual(yield* fetchStatus(segmentOf(stream.url, 0)), 200);

          // The run at ten seconds fails, and recovery gives up there.
          const failedAt = yield* seekTo(token, streamId, 10);
          const index = yield* segmentHolding(failedAt.playlistUrl, 10);
          const failed = yield* fetchAnswer(segmentOf(failedAt.playlistUrl, index));

          assert.strictEqual(failed.status, 500, failed.body);

          // A run from four seconds plays through that position and serves it.
          const earlier = yield* seekTo(token, streamId, 4);
          const from = yield* segmentHolding(earlier.playlistUrl, 4);

          for (let segment = from; segment <= index; segment += 1) {
            assert.strictEqual(
              yield* fetchStatus(segmentOf(earlier.playlistUrl, segment)),
              200,
              `segment ${String(segment)}`,
            );
          }

          // Back to the start, whose run ends early, then straight back to ten seconds.
          const start = yield* seekTo(token, streamId, 0);

          assert.strictEqual(yield* fetchStatus(segmentOf(start.playlistUrl, 0)), 200);
          const back = yield* seekAnswer(token, streamId, 10);

          assert.strictEqual(back.status, 200, JSON.stringify(back.body));
          const moved = yield* decodeSeek(back.body).pipe(Effect.orDie);

          assert.strictEqual(yield* fetchStatus(segmentOf(moved.playlistUrl, index)), 200);
        }),
      120_000,
    );
  });

  layer(
    MediaTestServer.layer(
      { FFMPEG_PATH: outlastsDiagnosis, HARDWARE_ACCELERATION: "qsv" },
      { diagnosisBudget: TranscodeCapabilities.DiagnosisBudget.defaultValue() },
    ),
    options,
  )((it) => {
    it.effect(
      "keeps this stream off the stages a diagnosis could not decide in the service's budget, and sets nothing aside for others",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const capabilities = yield* TranscodeCapabilities.Service;
          const fileId = yield* addFilm("undecided");
          const toneMap = capabilityKey(ImplId("tonemap.qsv"), "pq");

          const film = yield* negotiated({
            token: signTestToken({ fid: fileId, sid: "film" }),
            ...CHOICES,
          });

          assert.strictEqual(film.mode, "transcode-qsv", "the encode stays on the GPU");
          assert.strictEqual(film.generation, 2);
          assert.strictEqual(yield* fetchStatus(segmentOf(film.url, 3)), 200);

          const [first = [], replacement = []] = yield* runsOf(
            outlastsDiagnosis,
            film.streamId ?? "",
          );

          assert.isTrue(first.join(" ").includes("tonemap=1"));
          assert.isTrue(replacement.join(" ").includes("zscale"), "tone-mapped on the CPU");
          assert.notInclude(replacement.join(" "), "vpp_qsv", "both suspects kept off");
          assert.include(replacement, "h264_qsv");

          const replaced = server
            .logged()
            .filter(
              (entry) =>
                entry.annotations["streamId"] === film.streamId &&
                entry.message === "StreamSessions.pipeline_replaced",
            );

          assert.deepStrictEqual(
            replaced.map((entry) => [entry.annotations["cause"], entry.annotations["excluded"]]),
            [["Undecided", "scale.qsv,tonemap.qsv"]],
          );

          // Nothing was decided: the tone map is neither quarantined nor kept from the file.
          const known = yield* capabilities.inventory;

          assert.strictEqual(capabilityOf(known, toneMap).status, "verified");
          assert.isTrue(Option.isNone(capabilityOf(known, toneMap).quarantine));
          assert.isTrue(
            [...known.exclusions.values()].every((excluded) => excluded.size === 0),
            "no file is kept from a row",
          );
        }),
      120_000,
    );
  });

  layer(
    recovering(slowDiagnosis),
    options,
  )((it) => {
    it.effect(
      "stops a stream at once while its failed run is being diagnosed, and starts nothing after",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;
          const fs = yield* FileSystem.FileSystem;

          const token = signTestToken({
            fid: server.fileId("movies", library.directMovie),
            sid: "stopped",
          });

          const stream = yield* negotiated({ token, capabilities: smallBrowser });
          const streamId = stream.streamId ?? "";

          assert.strictEqual(stream.mode, "transcode-qsv");
          assert.strictEqual(yield* fetchStatus(segmentOf(stream.url, 0)), 200);

          const moved = yield* seekTo(token, streamId, 10);
          const index = yield* segmentHolding(moved.playlistUrl, 10);

          const waiting = yield* fetchAnswer(segmentOf(moved.playlistUrl, index)).pipe(
            Effect.forkChild,
          );

          // The run at ten seconds failed; its diagnosis's probes now take four seconds each.
          yield* awaitLogged("StreamSessions.encoder_failed", streamId);
          const started = yield* Clock.currentTimeMillis;

          const stopped = yield* HttpClient.execute(
            HttpClientRequest.post(`${server.baseUrl}/api/playback/stop`).pipe(
              HttpClientRequest.bodyJsonUnsafe({ token, streamId }),
            ),
          ).pipe(Effect.orDie);

          const stopMillis = (yield* Clock.currentTimeMillis) - started;
          const answered = yield* Fiber.join(waiting);

          assert.isBelow(stopped.status, 300);
          assert.isBelow(stopMillis, 2000, "the stop does not wait for the diagnosis");
          assert.strictEqual(answered.status, 404, answered.body);

          // Give a replacement every chance to start, then look.
          yield* Effect.sleep("5 seconds");

          assert.lengthOf(yield* runsOf(slowDiagnosis, streamId), 2, "no replacement run");
          assert.isFalse(yield* fs.exists(join(server.transcodeDir, streamId)));
          assert.deepStrictEqual(
            server
              .logged()
              .filter(
                (entry) =>
                  entry.annotations["streamId"] === streamId &&
                  entry.message === "StreamSessions.pipeline_replaced",
              ),
            [],
          );
        }),
      120_000,
    );
  });

  layer(
    MediaTestServer.layer({
      FFMPEG_PATH: plain,
      HARDWARE_ACCELERATION: "qsv",
      MAX_CONCURRENT_TRANSCODES: "1",
    }),
    options,
  )((it) => {
    it.effect(
      "probes while playback fills every encoder slot, without disturbing that playback",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const { library } = yield* FixtureWorkspace.Service;
          const capabilities = yield* TranscodeCapabilities.Service;
          const fileId = yield* addFilm("full-slots");

          const playing = yield* negotiated({
            token: signTestToken({ fid: server.fileId("movies", library.directMovie), sid: "a" }),
            capabilities: smallBrowser,
          });

          assert.strictEqual(playing.mode, "transcode-qsv");
          assert.strictEqual(yield* fetchStatus(segmentOf(playing.url, 0)), 200);

          // The HDR film needs a tone map the only slot's playback never probed.
          const refused = yield* negotiate({ token: signTestToken({ fid: fileId, sid: "b" }) });

          const toneMap = capabilityOf(
            yield* capabilities.inventory,
            capabilityKey(ImplId("tonemap.qsv"), "pq"),
          );

          assert.strictEqual(refused.status, 503, JSON.stringify(refused.body));
          assert.deepInclude(refused.body, { _tag: "TranscodeCapacityReached" });
          assert.strictEqual(toneMap.status, "verified", "its probes ran with every slot taken");

          assert.strictEqual(yield* fetchStatus(segmentOf(playing.url, 1)), 200);
          assert.lengthOf(
            yield* runsOf(plain, playing.streamId ?? ""),
            1,
            "the playback kept its run",
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
            reason: "not-started",
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

  layer(
    recovering(toneMapFailsUnderHevc),
    options,
  )((it) => {
    it.effect(
      "keeps an HEVC stream on Quick Sync's HEVC encoder when its tone map is replaced",
      () =>
        Effect.gen(function* () {
          const fileId = yield* addFilm("hevc-kept");

          const film = yield* negotiated({
            token: signTestToken({ fid: fileId, sid: "film" }),
            capabilities: hevcDevice,
            ...CHOICES,
          });

          assert.strictEqual(film.mode, "transcode-qsv");
          assert.strictEqual(film.generation, 2);
          assert.strictEqual(film.video.codec, "hevc", "still HEVC after the replacement");
          assert.strictEqual(yield* fetchStatus(segmentOf(film.url, 3)), 200);

          const runs = yield* runsOf(toneMapFailsUnderHevc, film.streamId ?? "");
          const [first = [], replacement = []] = runs;

          assert.lengthOf(runs, 2);
          assert.include(first, "hevc_qsv");
          assert.isTrue(replacement.join(" ").includes("zscale"), "tone-mapped on the CPU");
          assert.include(replacement, "hevc_qsv");
          assert.deepStrictEqual(valuesAfter(replacement, "-tag:v"), ["hvc1"]);
          assert.deepStrictEqual(kept(replacement), kept(first));
        }),
      120_000,
    );
  });

  layer(
    recovering(hevcEncoderFails),
    options,
  )((it) => {
    it.effect(
      "falls from HEVC to H.264 on Quick Sync when the HEVC encoder fails, and says why",
      () =>
        Effect.gen(function* () {
          const fileId = yield* addFilm("hevc-lost");

          const film = yield* negotiated({
            token: signTestToken({ fid: fileId, sid: "film" }),
            capabilities: hevcDevice,
            ...CHOICES,
          });

          assert.strictEqual(film.generation, 2);
          assert.strictEqual(film.mode, "transcode-qsv", "still on Quick Sync");
          assert.strictEqual(film.video.codec, "h264", "the next target");
          assert.strictEqual(yield* fetchStatus(segmentOf(film.url, 3)), 200);
          assert.deepInclude(film.transcode?.changes[0], {
            generation: 2,
            reason: "reproduced",
            excluded: ["encode.qsv.hevc"],
          });

          const runs = yield* runsOf(hevcEncoderFails, film.streamId ?? "");
          const [first = [], replacement = []] = runs;

          assert.lengthOf(runs, 2);
          assert.include(first, "hevc_qsv");
          assert.include(replacement, "h264_qsv");
          assert.deepStrictEqual(valuesAfter(replacement, "-tag:v"), []);
          assert.deepStrictEqual(kept(replacement), kept(first));
        }),
      120_000,
    );
  });

  layer(
    recovering(deinterlacerFails),
    options,
  )((it) => {
    it.effect(
      "deinterlaces on the CPU between Quick Sync's decode and encode when its deinterlacer fails, keeping what the viewer chose",
      () =>
        Effect.gen(function* () {
          const fileId = yield* addFilm("deinterlace-lost", "interlaced");

          const film = yield* negotiated({
            token: signTestToken({ fid: fileId, sid: "film" }),
            ...CHOICES,
          });

          assert.strictEqual(film.generation, 2);
          assert.strictEqual(film.mode, "transcode-qsv", "the encode stays on the GPU");
          assert.strictEqual(yield* fetchStatus(segmentOf(film.url, 3)), 200);
          assert.deepInclude(film.transcode?.changes[0], {
            generation: 2,
            reason: "reproduced",
            excluded: ["deinterlace.qsv"],
          });
          assert.deepInclude(
            film.transcode?.stages.find((stage) => stage.op === "deinterlace"),
            { domain: "cpu", impl: "deinterlace.cpu" },
          );
          assert.deepInclude(film.transcode?.stages[0], { op: "decode", domain: "qsv" });

          const runs = yield* runsOf(deinterlacerFails, film.streamId ?? "");
          const [first = [], replacement = []] = runs;

          assert.lengthOf(runs, 2);
          assert.include(first.join(" "), "deinterlace=advanced");
          assert.include(replacement.join(" "), "bwdif=mode=send_frame:deint=interlaced");
          assert.notInclude(replacement.join(" "), "deinterlace=advanced");
          assert.include(replacement, "h264_qsv");
          assert.include(replacement, "-hwaccel");
          assert.deepStrictEqual(kept(replacement), kept(first));
          assert.isTrue(kept(first).subtitle);
        }),
      120_000,
    );
  });

  layer(
    recovering(hevcEncoderFailsOnce),
    options,
  )((it) => {
    it.effect(
      "continues as H.264 on Quick Sync when only this file fails in the HEVC encoder, and plays the file there again",
      () =>
        Effect.gen(function* () {
          const fileId = yield* addFilm("hevc-file-only");

          const film = yield* negotiated({
            token: signTestToken({ fid: fileId, sid: "film" }),
            capabilities: hevcDevice,
            ...CHOICES,
          });

          assert.strictEqual(film.generation, 2);
          assert.strictEqual(film.mode, "transcode-qsv", "still on Quick Sync");
          assert.strictEqual(film.video.codec, "h264");
          assert.strictEqual(yield* fetchStatus(segmentOf(film.url, 3)), 200);
          assert.deepInclude(film.transcode?.changes[0], {
            generation: 2,
            reason: "file-only",
            excluded: ["encode.qsv.hevc"],
          });

          const runs = yield* runsOf(hevcEncoderFailsOnce, film.streamId ?? "");
          const [first = [], replacement = []] = runs;

          assert.lengthOf(runs, 2);
          assert.include(first, "hevc_qsv");
          assert.include(replacement, "h264_qsv");
          assert.notInclude(replacement, "libx264");
          assert.deepStrictEqual(kept(replacement), kept(first));
          assert.isTrue(kept(first).subtitle);
          assert.deepStrictEqual(kept(first).maxrate, ["1500000"]);

          const later = yield* negotiated({
            token: signTestToken({ fid: fileId, sid: "later" }),
            capabilities: hevcDevice,
          });

          assert.strictEqual(later.mode, "transcode-qsv", "the file keeps Quick Sync's H.264");
          assert.strictEqual(later.video.codec, "h264");
          assert.deepInclude(later.transcode?.stages.at(-1), { op: "encode", domain: "qsv" });
        }),
      120_000,
    );
  });
});
