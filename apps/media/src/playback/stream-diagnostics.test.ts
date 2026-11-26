import { dirname, join } from "node:path";

import { assert, describe, layer } from "@effect/vitest";
import {
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Ref,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { LibraryId } from "@media/contracts/ids";
import {
  type ClientCapabilities,
  NegotiateResponse,
  PlaybackApiError,
  TranscodeReason,
} from "@media/contracts/media-playback";
import { PlaybackMode, StartedPlayback } from "@media/contracts/models/playback";
import { EvidenceReason } from "@media/contracts/server-functions";
import { Milliseconds } from "@media/contracts/units";
import { Playback } from "@media/sdk/effect";

import * as CoreSession from "../core/core-session.ts";
import * as CoreStatus from "../core/core-status.ts";
import * as LibraryScanner from "../library/library-scanner.ts";
import * as MemoryLibrary from "../library/memory-library.ts";
import * as MediaTools from "../media/media-tools.ts";
import { invocationsOf, writeFakeFfmpeg } from "../testing/fake-ffmpeg.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import { signTestToken } from "../testing/test-tokens.ts";
import { RELEASE } from "../release.ts";
import { capabilityOf } from "./capability-inventory.ts";
import * as TranscodeCapabilities from "./transcode-capabilities.ts";
import { VIDEO_OPS } from "./video-pipeline.ts";
import { capabilityKey, ImplId } from "./video-ops.ts";

const hasFfmpeg = await ffmpegAvailable();

/** Quick Sync runs write four seconds, then exit with status 1 naming nothing. */
const failsAfterFour = await writeFakeFfmpeg({ qsvFailsAfterSeconds: 4, logInvocations: true });

/** A path no fixture has, in a line as ffmpeg would print it: quoted, then bare. */
const LEAKED = "/zz-vault/Quokka Heist (1999)/Quokka Heist.mkv";

const LEAKED_PARTS = ["zz-vault", "Quokka", "Heist", "1999", ".mkv"];

const ENCODER_FAILED = `[h264_qsv @ 0x1] Error submitting frame from '${LEAKED}': device lost in ${LEAKED}`;

const TONE_MAP_FAILED = `[Parsed_vpp_qsv_1 @ 0x1] Could not open '${LEAKED}' for ${LEAKED}`;

/**
 * Quick Sync's tone map probes always fail, and the first Quick Sync stream run fails naming its
 * encoder, as does every encoder probe after it: each line names a path.
 */
const leakingEncoder = await writeFakeFfmpeg({
  rules: [
    { token: "tonemap=1", runs: "probe", stderr: TONE_MAP_FAILED },
    { token: "h264_qsv", runs: "hls", stderr: ENCODER_FAILED, arm: "encoder", limit: 1 },
    { token: "h264_qsv", runs: "probe", stderr: ENCODER_FAILED, armedBy: "encoder" },
  ],
  logInvocations: true,
});

/** What the stand-in's failing runs write to standard error, rewritten before each case. */
const STDERR = "stderr.txt";

/** A ticket a playback URL in ffmpeg's log could carry. */
const SECRET = "Zq7SecretTicketValue";

/** A file whose every HLS run fails, by a word its name holds. */
const DOOMED = "Doomed";

/**
 * Ways ffmpeg's log could spell `path` under `root`: whole, quoted, relative, Windows-style,
 * percent-encoded, inside a longer token, and in URLs whose ticket is spelled out or encoded.
 */
const spellingsOf = (path: string, root: string): ReadonlyArray<string> => {
  const relative = path.slice(root.length + 1);

  return [
    path,
    `'${path}'`,
    `"${path}"`,
    relative,
    `C:${path.replaceAll("/", "\\")}`,
    encodeURIComponent(path),
    encodeURI(path),
    `file:${path}`,
    `subtitles=filename=${path}:si=0`,
    `concat:${path}|${relative}`,
    `../media/hls/a/1/0.m4s?%74icket=${SECRET}`,
    `http://media.test/media/hls/a/1/0.m4s?ticket=${SECRET}&x=1`,
  ];
};

/** The device check's log: libva's lines, then the driver line with a path after its version. */
const DEVICE_LOG = [
  "libva info: VA-API version 1.22.0",
  `[AVHWDeviceContext @ 0x1] VAAPI driver: Intel iHD driver for Intel(R) Gen Graphics - 25.2.6 (${LEAKED}).`,
].join("\n");

/**
 * The device check prints a driver line with a path in it, and Quick Sync's tone map probes fail
 * printing every spelling of another; every HLS run of a file named `Doomed`, and every Quick Sync
 * HLS run, fails writing the text of `STDERR`.
 */
const leakingRuns = await writeFakeFfmpeg({
  rules: [
    { token: "nullsrc=s=64x64", runs: "any", stderr: DEVICE_LOG, exitCode: 0 },
    { token: "tonemap=1", runs: "probe", stderr: spellingsOf(LEAKED, "/zz-vault").join(" ") },
    { token: DOOMED, runs: "hls", stderrFrom: STDERR },
    { token: "h264_qsv", runs: "hls", stderrFrom: STDERR },
  ],
});

/** Where an ffmpeg line can start, so a case's failure reaches each of the classifier's branches. */
const LINE_STARTS = [
  "",
  "[h264_qsv @ 0x1] ",
  "[Parsed_vpp_qsv_0 @ 0x2] ",
  "[vist#0:0/h264 @ 0x3] ",
  "Error opening input file ",
  "[aost#0:1/aac @ 0x4] ",
  "[out#0/hls @ 0x5] ",
  "No space left on device ",
  "Device creation failed: ",
  "libva info: ",
] as const;

const OPS: ReadonlySet<string> = new Set([
  "decode",
  "scale",
  "tonemap",
  "burn-image",
  "encode",
  "move",
]);

const DOMAIN_NAMES: ReadonlySet<string> = new Set(["cpu", "qsv", "vaapi"]);

const CAUSES: ReadonlySet<string> = new Set([
  "capability",
  "source",
  "undecided",
  "not-video",
  "unexplained",
  "capability-lost",
]);

const IMPLS: ReadonlySet<string> = new Set(VIDEO_OPS.map((row) => row.id));

const among =
  (known: ReadonlySet<string> | ReadonlyArray<string>) =>
  (text: string): boolean =>
    "has" in known ? known.has(text) : known.includes(text);

/** The text a field of a summary, a failure, or a report may hold, by its path in the answer. */
const FIELDS = new Map<string, (text: string) => boolean>([
  ["transcode.stages.op", among(OPS)],
  ["transcode.stages.domain", among(DOMAIN_NAMES)],
  ["transcode.stages.impl", among(IMPLS)],
  ["transcode.stages.move.from", among(DOMAIN_NAMES)],
  ["transcode.stages.move.to", among(DOMAIN_NAMES)],
  ["transcode.changes.cause", among(CAUSES)],
  ["transcode.changes.excluded", among(IMPLS)],
  ["transcode.changes.reason", among(TranscodeReason.literals)],
  ["_tag", (text) => text === "TranscodeFailed"],
  ["streamId", (text) => /^[\w-]+$/u.test(text)],
  ["mode", among(PlaybackMode.literals)],
  ["reason", among(TranscodeReason.literals)],
  ["version", (text) => text === RELEASE],
  ["transcoding.build.version", (text) => /^[\w.+~-]+$/u.test(text)],
  ["transcoding.build.kernel", (text) => /^[\w.+~-]+$/u.test(text)],
  ["transcoding.devices.domain", among(DOMAIN_NAMES)],
  ["transcoding.devices.node", (text) => text === "renderD128"],
  ["transcoding.devices.pci", (text) => /^[0-9a-f]{4}:[0-9a-f]{4}( rev [0-9a-f]{2})?$/u.test(text)],
  ["transcoding.devices.kernelDriver", (text) => /^[\w-]+$/u.test(text)],
  [
    "transcoding.devices.userDriver",
    (text) => text === "Intel iHD driver for Intel(R) Gen Graphics 25.2.6",
  ],
  ["transcoding.capabilities.key", (text) => IMPLS.has(text.slice(0, text.indexOf(":")))],
  ["transcoding.capabilities.domain", among(DOMAIN_NAMES)],
  ["transcoding.capabilities.status", among(["unknown", "verified", "unsupported"])],
  ["transcoding.capabilities.source", among(["listing", "probe"])],
  ["transcoding.capabilities.reason", among(EvidenceReason.literals)],
  ["transcoding.capabilities.quarantineEndsAt", (text) => text === "restart"],
]);

const isJsonArray = (value: Schema.Json): value is Schema.JsonArray => Array.isArray(value);

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !isJsonArray(value);

/** Every string in `value`, with the path of keys that leads to it, array positions left out. */
const stringsOf = (value: Schema.Json, at = ""): ReadonlyArray<readonly [string, string]> => {
  if (Predicate.isString(value)) return [[at, value]];

  if (isJsonArray(value)) return value.flatMap((item) => stringsOf(item, at));

  if (isJsonObject(value)) {
    return Object.entries(value).flatMap(([key, item]) =>
      stringsOf(item, at === "" ? key : `${at}.${key}`),
    );
  }

  return [];
};

/** An answer's `transcode` summary alone, null when it has none. */
const summaryIn = (body: Schema.Json): Schema.Json => ({
  transcode: isJsonObject(body) ? (body["transcode"] ?? null) : null,
});

/** Fails unless every string field of `answer` holds what `FIELDS` allows there. */
const assertCodesOnly = (answer: Schema.Json, label: string) => {
  for (const [field, text] of stringsOf(answer)) {
    const allowed = FIELDS.get(field);

    assert.isTrue(
      allowed !== undefined && allowed(text),
      `${label}: ${field} holds ${JSON.stringify(text)}`,
    );
  }
};

const decodeJson = Schema.decodeUnknownEffect(Schema.Json);

/** A browser on a 4K screen: H.264 only, so other codecs transcode at full size on the GPU. */
const wideBrowser: ClientCapabilities = {
  containers: [],
  videoCodecs: [{ codec: "h264", maxBitDepth: 8 }],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 3840,
  maxHeight: 2160,
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

const WIDE_FILM = "Wide Harbor (2020)/Wide Harbor (2020).mkv";

const decodeNegotiation = Schema.decodeUnknownEffect(Schema.toCodecJson(NegotiateResponse));

const decodeFailure = Schema.decodeUnknownEffect(Schema.toCodecJson(PlaybackApiError));

/** Twelve seconds of MPEG-2 at 2560x1440 with an AAC track, wider than the CPU encodes. */
const addWideFilm = Effect.fn(function* (library: string) {
  const workspace = yield* FixtureWorkspace.Service;
  const tools = yield* MediaTools.Service;
  const scanner = yield* LibraryScanner.Service;
  const fs = yield* FileSystem.FileSystem;
  const libraryId = LibraryId.make(library);
  const root = join(workspace.root, library);
  const output = join(root, WIDE_FILM);

  yield* fs.makeDirectory(join(root, "Wide Harbor (2020)"), { recursive: true });
  yield* tools.ffmpeg([
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=2560x1440:rate=24:duration=12",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=12",
    "-c:v",
    "mpeg2video",
    "-q:v",
    "8",
    "-g",
    "24",
    "-c:a",
    "aac",
    output,
  ]);
  yield* scanner.scan({ libraryId, root, mode: "incremental" });

  return MemoryLibrary.fileIdOf(libraryId, WIDE_FILM);
});

/** A start of `token`'s file on the test server, as a player holds it. */
const startedWith = (token: string, mediaBaseUrl: string): StartedPlayback =>
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
        durationMs: 12_000,
        bitRate: null,
        video: [],
        audio: [],
        subtitles: [],
        chapters: [],
      },
      externalSubtitles: [],
      hdr: false,
      missing: false,
      trickplay: null,
    },
    token,
    tokenExpiresAt: Date.now() + 3_600_000,
    mediaBaseUrl,
    resumePositionMs: 0,
  });

/** `url`, which names the service's public address, on the test server. */
const local = (baseUrl: string, url: string): string => {
  const parsed = new URL(url);

  return `${baseUrl}${parsed.pathname}${parsed.search}`;
};

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

/** The first report the media service's real status layer sends the core from now. */
const firstReport = Effect.gen(function* () {
  const sent = yield* Ref.make<ReadonlyArray<unknown>>([]);

  const session = CoreSession.Service.of({
    status: Effect.succeed("signed-in"),
    run: () => Effect.die(new Error("not used")),
    watch: () => Stream.die(new Error("not used")),
    call: (fn, ...params) =>
      Ref.update(sent, (known) => [...known, ...params]).pipe(
        Effect.andThen(Schema.decodeEffect(fn.result)(null)),
        Effect.orDie,
      ),
  });

  yield* Layer.build(
    CoreStatus.layer.pipe(Layer.provide(Layer.succeed(CoreSession.Service, session))),
  );

  const [report] = yield* Ref.get(sent).pipe(
    Effect.filterOrFail((known) => known.length > 0),
    Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 100 }),
    Effect.orDie,
  );

  return report;
}).pipe(Effect.scoped);

const options = { excludeTestServices: true, timeout: "180 seconds" } as const;

describe.skipIf(!hasFfmpeg)("stream diagnostics", () => {
  layer(
    MediaTestServer.layer({ FFMPEG_PATH: failsAfterFour, HARDWARE_ACCELERATION: "qsv" }),
    options,
  )((it) => {
    it.effect(
      "negotiate and seek name their generation's stages, and a reload after a recovery that shrinks the picture shows the chain that replaced it",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const fs = yield* FileSystem.FileSystem;
          const fileId = yield* addWideFilm("wide");
          const token = signTestToken({ fid: fileId, sid: "wide" });
          const started = startedWith(token, server.baseUrl);

          const stream = yield* Playback.negotiate(
            started,
            wideBrowser,
            Milliseconds.make(0),
            Option.none(),
          );

          const playback: Playback.Playback = { started, stream };
          const streamId = stream.streamId ?? "";

          assert.strictEqual(stream.mode, "transcode-qsv");
          assert.strictEqual(stream.generation, 1);
          assert.deepStrictEqual(stream.video, {
            codec: "h264",
            width: 2560,
            height: 1440,
            dynamicRange: "sdr",
          });
          assert.deepStrictEqual(stream.transcode?.changes, []);
          assert.deepInclude(stream.transcode?.stages.at(-1), {
            op: "encode",
            domain: "qsv",
            impl: "encode.qsv",
          });
          assert.isTrue(
            stream.transcode?.stages.every((stage) => stage.domain === "qsv"),
            JSON.stringify(stream.transcode),
          );

          // A seek into what the run produced stays in its generation, and says so.
          const within = yield* Playback.seekStream(playback, Milliseconds.make(1000));

          assert.isTrue(Option.isSome(within));

          if (Option.isSome(within)) {
            assert.strictEqual(within.value.generation, 1);
            assert.strictEqual(within.value.mode, "transcode-qsv");
            assert.deepStrictEqual(within.value.video, stream.video);
            assert.deepStrictEqual(within.value.transcode, stream.transcode);
          }

          // The Quick Sync run wrote its four seconds and failed.
          yield* fs.readFileString(join(server.transcodeDir, streamId, "1", "ffmpeg.m3u8")).pipe(
            Effect.filterOrFail((text) => text.includes("#EXT-X-ENDLIST")),
            Effect.retry(Schedule.spaced("50 millis")),
            Effect.timeout(Duration.seconds(30)),
            Effect.orDie,
          );

          // The player's next segment meets the failure: its generation is gone.
          const gone = yield* HttpClient.get(local(server.baseUrl, segmentOf(stream.url, 3))).pipe(
            Effect.orDie,
          );

          assert.strictEqual(gone.status, 410);

          const failure = yield* decodeFailure(yield* gone.json.pipe(Effect.orDie)).pipe(
            Effect.orDie,
          );

          assert.strictEqual(Playback.recoveryFor(failure), "reload-playlist");

          // The reload: a seek to where the player is, then the generation it names.
          const reloaded = yield* Playback.seekStream(playback, Milliseconds.make(4000));

          assert.isTrue(Option.isSome(reloaded));

          if (Option.isNone(reloaded)) return;
          const next = Playback.inGeneration(playback, reloaded.value);
          const summary = reloaded.value.transcode;

          assert.deepStrictEqual(next.stream.transcode, summary, "the player holds the new chain");
          assert.strictEqual(next.stream.generation, 2);
          assert.strictEqual(next.stream.mode, "transcode-software");
          assert.deepStrictEqual(next.stream.video, {
            codec: "h264",
            width: 1920,
            height: 1080,
            dynamicRange: "sdr",
          });
          assert.isTrue(
            summary.stages.every((stage) => stage.domain === "cpu"),
            JSON.stringify(summary),
          );
          assert.deepInclude(summary.stages.at(-1), {
            op: "encode",
            domain: "cpu",
            impl: "encode.cpu",
          });

          const [change, ...others] = summary.changes;

          assert.lengthOf(others, 0);
          assert.strictEqual(change?.generation, 2);
          assert.strictEqual(change?.cause, "source", "the probes passed: only this file fails");
          assert.include(change?.excluded ?? [], "encode.qsv");

          // And that is the chain that runs: the replacement plays, encoding 1080p on the CPU.
          const served = yield* HttpClient.get(
            local(server.baseUrl, segmentOf(next.stream.url, 3)),
          ).pipe(Effect.orDie);

          assert.strictEqual(served.status, 200);
          const [, replacement = []] = yield* runsOf(failsAfterFour, streamId);

          assert.include(replacement, "libx264");
          assert.notInclude(replacement, "h264_qsv");
          assert.isTrue(
            replacement.some((arg) => arg.includes("1920") && arg.includes("1080")),
            replacement.join(" "),
          );
        }),
      120_000,
    );
  });

  layer(
    MediaTestServer.layer({ FFMPEG_PATH: leakingEncoder, HARDWARE_ACCELERATION: "qsv" }),
    options,
  )((it) => {
    it.effect(
      "a recovery's change and the status report keep no part of a path from ffmpeg's log",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const capabilities = yield* TranscodeCapabilities.Service;
          const { library, root } = yield* FixtureWorkspace.Service;
          const token = signTestToken({ fid: server.fileId("movies", library.directMovie) });

          const response = yield* HttpClient.execute(
            HttpClientRequest.post(`${server.baseUrl}/api/playback/negotiate`).pipe(
              HttpClientRequest.bodyJsonUnsafe({ token, capabilities: smallBrowser }),
            ),
          ).pipe(Effect.orDie);

          const body = yield* response.json.pipe(Effect.orDie);

          assert.strictEqual(response.status, 200, JSON.stringify(body));

          const stream = yield* decodeNegotiation(body).pipe(Effect.orDie);

          assert.strictEqual(stream.generation, 2, "the negotiation answers the run that started");
          assert.strictEqual(stream.mode, "transcode-software");
          assert.deepInclude(stream.transcode?.stages.at(-1), { op: "encode", domain: "cpu" });

          const [change] = stream.transcode?.changes ?? [];

          assert.strictEqual(change?.cause, "capability", "the encoder's probe failed again");
          assert.deepStrictEqual(change?.excluded, ["encode.qsv"]);
          assert.strictEqual(change?.reason, "reproduced");

          // Warmup proves the tone maps last; their probes' lines name the path too.
          const toneMap = capabilityKey(ImplId("tonemap.qsv"), "pq");

          yield* capabilities.inventory.pipe(
            Effect.filterOrFail((known) => capabilityOf(known, toneMap).status === "unsupported"),
            Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 600 }),
            Effect.orDie,
          );

          const report = yield* firstReport;
          const wire = [JSON.stringify(body), JSON.stringify(report)];

          for (const text of wire) {
            for (const part of [...LEAKED_PARTS, root]) assert.notInclude(text, part);
          }

          assert.hasAllKeys(report, [
            "version",
            "activeStreams",
            "runsAwaitingExit",
            "startedAt",
            "transcoding",
          ]);

          const { transcoding } = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              transcoding: Schema.Struct({
                build: Schema.Unknown,
                devices: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
                capabilities: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
              }),
            }),
          )(report).pipe(Effect.orDie);

          assert.hasAllKeys(transcoding.build, ["version", "kernel", "checkedAt"]);

          for (const device of transcoding.devices) {
            assert.hasAllKeys(device, [
              "domain",
              "node",
              "opened",
              "pci",
              "kernelDriver",
              "userDriver",
              "checkedAt",
            ]);
          }

          assert.deepInclude(transcoding.devices[0], {
            domain: "qsv",
            node: "renderD128",
            opened: true,
          });

          for (const capability of transcoding.capabilities) {
            assert.hasAllKeys(capability, [
              "key",
              "domain",
              "status",
              "source",
              "checkedAt",
              "reason",
              "quarantineEndsAt",
            ]);
          }

          const known = (key: string) =>
            transcoding.capabilities.find((capability) => capability["key"] === key);

          assert.deepInclude(known(toneMap), {
            domain: "qsv",
            status: "unsupported",
            source: "probe",
            reason: "refused",
            quarantineEndsAt: null,
          });
          assert.isNumber(
            known("encode.qsv:h264/8/cbr")?.["quarantineEndsAt"],
            "the encoder is quarantined after its probe reproduced the failure",
          );
        }),
      120_000,
    );
  });

  layer(
    MediaTestServer.layer({ FFMPEG_PATH: leakingRuns, HARDWARE_ACCELERATION: "qsv" }),
    options,
  )((it) => {
    let cases = 0;

    it.effect.prop(
      "whatever ffmpeg prints, every text field of a negotiation, a seek, a failure, and the status report is a code, an implementation, a domain, or a device's identity",
      {
        start: Schema.Literals(LINE_STARTS),
        noise: Schema.Array(Schema.String),
        end: Schema.String,
      },
      ({ start, noise, end }) =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const workspace = yield* FixtureWorkspace.Service;
          const scanner = yield* LibraryScanner.Service;
          const fs = yield* FileSystem.FileSystem;
          const libraryId = LibraryId.make("cases");
          const root = join(workspace.root, "cases");
          const original = join(workspace.library.moviesRoot, workspace.library.directMovie);

          cases += 1;
          const playing = `Quokka's Cut ${String(cases)} (1999)`;
          const doomed = `${DOOMED} Quokka's ${String(cases)} (1999)`;

          for (const name of [playing, doomed]) {
            yield* fs.makeDirectory(join(root, name), { recursive: true });
            yield* fs.copyFile(original, join(root, name, `${name}.mp4`));
          }

          yield* scanner.scan({ libraryId, root, mode: "incremental" });

          /** Makes failing runs print the case's text around every spelling of `name`'s path. */
          const failWith = (name: string) =>
            fs.writeFileString(
              join(dirname(leakingRuns), STDERR),
              [
                ...noise,
                ...spellingsOf(join(root, name, `${name}.mp4`), workspace.root).map(
                  (spelling, index) => `${start}${noise[index] ?? ""}${spelling}${end}`,
                ),
              ].join("\n"),
            );

          /** The status and JSON body of what `route` answers `request`. */
          const post = (
            route: string,
            request: (
              request: HttpClientRequest.HttpClientRequest,
            ) => HttpClientRequest.HttpClientRequest,
          ) =>
            HttpClient.execute(request(HttpClientRequest.post(`${server.baseUrl}${route}`))).pipe(
              Effect.flatMap((response) =>
                response.json.pipe(
                  Effect.flatMap(decodeJson),
                  Effect.map((json) => ({ status: response.status, json })),
                ),
              ),
              Effect.orDie,
            );

          yield* failWith(playing);

          const token = signTestToken({
            fid: MemoryLibrary.fileIdOf(libraryId, `${playing}/${playing}.mp4`),
            sid: `playing-${String(cases)}`,
          });

          const negotiated = yield* post(
            "/api/playback/negotiate",
            HttpClientRequest.bodyJsonUnsafe({ token, capabilities: smallBrowser }),
          );

          /** What each answer must hold codes only in, and the whole bodies, by what they answered. */
          const coded: Array<readonly [string, Schema.Json]> = [];
          const bodies: Array<Schema.Json> = [negotiated.json];

          // The Quick Sync run failed. A replacement plays unless every chain left was blamed too,
          // as when the log names the decoder on the GPU and then on the CPU.
          if (negotiated.status === 200) {
            const stream = yield* decodeNegotiation(negotiated.json).pipe(Effect.orDie);

            assert.isAbove(stream.transcode?.changes.length ?? 0, 0, "the change is shown");

            const moved = yield* post(
              "/api/playback/seek",
              HttpClientRequest.bodyJsonUnsafe({
                token,
                streamId: stream.streamId,
                positionSeconds: 1,
              }),
            );

            assert.strictEqual(moved.status, 200, JSON.stringify(moved.json));
            // Stopped, so the cases after it find an encoder slot free.
            yield* post(
              "/api/playback/stop",
              HttpClientRequest.bodyJsonUnsafe({ token, streamId: stream.streamId }),
            );
            coded.push(
              ["negotiation", summaryIn(negotiated.json)],
              ["seek", summaryIn(moved.json)],
            );
            bodies.push(moved.json);
          } else {
            assert.strictEqual(negotiated.status, 500, JSON.stringify(negotiated.json));
            coded.push(["failure", negotiated.json]);
          }

          yield* failWith(doomed);

          const failed = yield* post(
            "/api/playback/negotiate",
            HttpClientRequest.bodyJsonUnsafe({
              token: signTestToken({
                fid: MemoryLibrary.fileIdOf(libraryId, `${doomed}/${doomed}.mp4`),
                sid: `doomed-${String(cases)}`,
              }),
              capabilities: smallBrowser,
            }),
          );

          assert.strictEqual(failed.status, 500, JSON.stringify(failed.json));
          const report = yield* firstReport.pipe(Effect.flatMap(decodeJson), Effect.orDie);

          coded.push(["failure", failed.json], ["status report", report]);
          bodies.push(failed.json, report);

          for (const [label, answer] of coded) assertCodesOnly(answer, label);

          // The driver line went out as its name and version, without what followed them.
          assert.deepInclude(stringsOf(report), [
            "transcoding.devices.userDriver",
            "Intel iHD driver for Intel(R) Gen Graphics 25.2.6",
          ]);

          for (const body of bodies) {
            for (const part of [SECRET, "Quokka", "zz-vault", workspace.root]) {
              assert.notInclude(JSON.stringify(body), part);
            }
          }

          // The readable line stays in the server's own log.
          assert.isTrue(
            server
              .logged()
              .some(
                (record) =>
                  JSON.stringify(record.message).includes("StreamSessions.encoder_failed") &&
                  Predicate.isString(record.annotations["detail"]) &&
                  record.annotations["detail"] !== "",
              ),
            "the service logged the failure",
          );
        }),
      { timeout: 300_000, arbitrary: { runs: 8, maxShrinks: 3 } },
    );
  });
});
