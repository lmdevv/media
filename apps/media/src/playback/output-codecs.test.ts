import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path, Predicate, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { LibraryId, type MediaFileId } from "@media/contracts/ids";
import {
  type ClientCapabilities,
  NegotiateResponse,
  PrepareDownloadResponse,
  SeekResponse,
} from "@media/contracts/media-playback";

import * as LibraryScanner from "../library/library-scanner.ts";
import * as MemoryLibrary from "../library/memory-library.ts";
import * as MediaTools from "../media/media-tools.ts";
import { ffmpegAvailable, qsvUsable, vaapiUsable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import { signTestToken } from "../testing/test-tokens.ts";
import { levelOf } from "./output-levels.ts";

const hasFfmpeg = await ffmpegAvailable();

const hasQsv = hasFfmpeg && (await qsvUsable());

const hasVaapi = hasFfmpeg && (await vaapiUsable());

const SOURCES = LibraryId.make("output-codecs");

/** MPEG-2, which none of the clients below plays, so every one of them gets an encode. */
const SOURCE_FILE = "Mpeg Two (2012)/Mpeg Two (2012).mkv";

const SOURCE_SECONDS = 14;

/**
 * Fourteen seconds at 24 fps that cut to another picture at 3.083 s and 7.083 s, under a second
 * before the planned starts at 4 and 8 s: an encoder that sets a keyframe at a scene cut may then
 * skip the forced one that follows it, as libx265 without `forced-idr` does.
 */
const PICTURE = [
  "testsrc2=s=320x180:r=24,trim=end_frame=74[a]",
  "mandelbrot=s=320x180:r=24,trim=end_frame=96,setpts=PTS-STARTPTS[b]",
  "smptehdbars=s=320x180:r=24,trim=end_frame=166,setpts=PTS-STARTPTS[c]",
  "[a][b][c]concat=n=3:v=1:a=0,format=yuv420p[out0]",
].join(";");

const FRAME = 1 / 24;

/** One AAC frame of the source's 48 kHz audio. */
const AUDIO_FRAME = 1024 / 48_000;

/** Six seconds of 640x360 at 60 fps in MPEG-2, whose sample rate a low level holds only smaller. */
const FAST_FILE = "Mpeg Sixty (2013)/Mpeg Sixty (2013).mkv";

/**
 * Forty seconds of 320x180 at 6 fps in MPEG-2 with AAC. An encoder's held pictures last longer at
 * a low rate: without its live options, SVT-AV1 held more than the muxer's 10 seconds of them, at
 * every level of parallelism, with Debian's 2.3 and with 4.1, so the copied audio ran ahead into
 * earlier fragments and each fragment after the first opened without sound. At 8 fps its smallest
 * pipeline already kept up.
 */
const SLOW_FILE = "Mpeg Six (2015)/Mpeg Six (2015).mkv";

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

const decodePrepared = Schema.decodeUnknownEffect(Schema.toCodecJson(PrepareDownloadResponse));

const Probed = Schema.fromJsonString(
  Schema.Struct({
    streams: Schema.Array(
      Schema.Struct({
        codec_name: Schema.String,
        profile: Schema.optional(Schema.String),
        codec_tag_string: Schema.String,
        level: Schema.optional(Schema.Finite),
        width: Schema.optional(Schema.Finite),
        height: Schema.optional(Schema.Finite),
        coded_width: Schema.optional(Schema.Finite),
        coded_height: Schema.optional(Schema.Finite),
        color_transfer: Schema.optional(Schema.String),
        color_primaries: Schema.optional(Schema.String),
        side_data_list: Schema.optional(
          Schema.Array(Schema.Struct({ side_data_type: Schema.String })),
        ),
      }),
    ),
    packets: Schema.Array(
      Schema.Struct({
        pts_time: Schema.FiniteFromString,
        dts_time: Schema.FiniteFromString,
        flags: Schema.String,
      }),
    ),
  }),
);

/** Writes `name` in the sources library from `picture` and a tone of `seconds`, once, and scans it. */
const addFile = Effect.fn("OutputCodecs.addFile")(function* (
  name: string,
  picture: string,
  seconds: number,
  keyframeEvery: number,
) {
  const workspace = yield* FixtureWorkspace.Service;
  const tools = yield* MediaTools.Service;
  const scanner = yield* LibraryScanner.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(workspace.root, "output-codecs");
  const file = path.join(root, name);

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
      picture,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:sample_rate=48000:duration=${String(seconds)}`,
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-c:v",
      "mpeg2video",
      "-g",
      String(keyframeEvery),
      "-c:a",
      "aac",
      file,
    ]);
  }

  yield* scanner.scan({ libraryId: SOURCES, root, mode: "incremental" });

  return MemoryLibrary.fileIdOf(SOURCES, name);
}, Effect.orDie);

const addSource = addFile(SOURCE_FILE, PICTURE, SOURCE_SECONDS, 12);

const addFastSource = addFile(FAST_FILE, "testsrc2=s=640x360:r=60:duration=6[out0]", 6, 30);

const addSlowSource = addFile(SLOW_FILE, "testsrc2=s=320x180:r=6:duration=40[out0]", 40, 12);

/**
 * The sources streams are played from: a key for session ids, each file, its frame duration, and
 * where a seek lands.
 */
const PLAYED = [
  { key: "cuts", name: "the scene-cut source", file: addSource, frame: FRAME, seekTo: 7.3 },
  { key: "slow", name: "a 6 fps source", file: addSlowSource, frame: 1 / 6, seekTo: 20.3 },
] as const;

type Played = (typeof PLAYED)[number];

/**
 * Sixteen seconds of 640x360 H.264 in MP4 at a variable frame rate, as a phone records: 4 s at
 * 60 fps, then 12 s at 15 fps. ffprobe reads an average of 26.25 fps and a base rate of 60.
 */
const VFR_FILE = "Phone Clip (2016)/Phone Clip (2016).mp4";

const addVfrSource = Effect.gen(function* () {
  const workspace = yield* FixtureWorkspace.Service;
  const tools = yield* MediaTools.Service;
  const scanner = yield* LibraryScanner.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(workspace.root, "output-codecs");
  const file = path.join(root, VFR_FILE);

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
      "testsrc2=s=640x360:r=60:duration=4",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=640x360:r=15:duration=12",
      "-filter_complex",
      "[0:v][1:v]concat=n=2:v=1:a=0[v]",
      "-map",
      "[v]",
      "-fps_mode",
      "vfr",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      file,
    ]);
  }

  yield* scanner.scan({ libraryId: SOURCES, root, mode: "incremental" });

  return MemoryLibrary.fileIdOf(SOURCES, VFR_FILE);
}).pipe(Effect.orDie);

/** Six seconds of HEVC Main 10 in HDR10, with mastering display and content light levels. */
const HDR_FILE = "Pq Ten (2014)/Pq Ten (2014).mkv";

const addHdrSource = Effect.gen(function* () {
  const workspace = yield* FixtureWorkspace.Service;
  const tools = yield* MediaTools.Service;
  const scanner = yield* LibraryScanner.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(workspace.root, "output-codecs");
  const file = path.join(root, HDR_FILE);

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
      "testsrc2=s=640x360:r=24:duration=6",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=6",
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-vf",
      "format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc",
      "-c:v",
      "libx265",
      "-preset",
      "ultrafast",
      "-x265-params",
      [
        "log-level=error",
        "keyint=48",
        "colorprim=bt2020",
        "transfer=smpte2084",
        "colormatrix=bt2020nc",
        "master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1)",
        "max-cll=1000,400",
        "hdr10=1",
      ].join(":"),
      "-c:a",
      "aac",
      file,
    ]);
  }

  yield* scanner.scan({ libraryId: SOURCES, root, mode: "incremental" });

  return MemoryLibrary.fileIdOf(SOURCES, HDR_FILE);
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
  | {
      readonly token: string;
      readonly capabilities: ClientCapabilities;
      readonly quality?: "standard" | "high";
    }
  | { readonly token: string; readonly streamId: string; readonly positionSeconds?: number };

const posted = (url: string, body: RequestBody) =>
  HttpClient.execute(HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body))).pipe(
    Effect.flatMap((response) => response.json),
    Effect.orDie,
  );

const SAMPLE_TABLE_PATH = ["moov", "trak", "mdia", "minf", "stbl"];

/**
 * The sample dependency boxes (`sdtp`) in `init`'s sample tables that list no sample. With one,
 * AVFoundation exposes no video track and Apple's players say "Cannot Open"; ffmpeg 7.1 writes one
 * for an encoder that marks pictures disposable, as libx265 and libsvtav1 do.
 */
const emptySampleDependencies = (init: Uint8Array, start = 0, end = init.byteLength, depth = 0) => {
  const view = new DataView(init.buffer, init.byteOffset, init.byteLength);
  let found = 0;

  for (let at = start; at + 8 <= end && view.getUint32(at) >= 8; at += view.getUint32(at)) {
    const size = view.getUint32(at);
    const type = String.fromCodePoint(...init.subarray(at + 4, at + 8));

    if (depth === SAMPLE_TABLE_PATH.length) found += type === "sdtp" && size === 12 ? 1 : 0;
    else if (type === SAMPLE_TABLE_PATH[depth]) {
      found += emptySampleDependencies(init, at + 8, at + size, depth + 1);
    }
  }

  return found;
};

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

/** What ffprobe reads from `parts` written one after another: the video stream and its packets. */
const probeSegment = Effect.fn("OutputCodecs.probeSegment")(function* (
  parts: ReadonlyArray<Uint8Array>,
) {
  const fs = yield* FileSystem.FileSystem;
  const tools = yield* MediaTools.Service;
  const file = yield* fs.makeTempFileScoped({ suffix: ".mp4" });

  yield* fs.writeFile(file, Buffer.concat(parts));

  return yield* Schema.decodeEffect(Probed)(
    yield* tools.ffprobe([
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,profile,codec_tag_string,level,width,height,coded_width,coded_height,color_transfer,color_primaries:stream_side_data=side_data_type:packet=pts_time,dts_time,flags",
      "-of",
      "json",
      file,
    ]),
  );
}, Effect.scoped);

const AudioPackets = Schema.fromJsonString(
  Schema.Struct({
    packets: Schema.Array(
      Schema.Struct({ pts_time: Schema.FiniteFromString, duration_time: Schema.FiniteFromString }),
    ),
  }),
);

/**
 * When the audio of `parts`, written one after another, starts and ends: its earliest packet, and
 * the end of its latest. None without audio.
 */
const audioSpan = Effect.fn("OutputCodecs.audioSpan")(function* (parts: ReadonlyArray<Uint8Array>) {
  const fs = yield* FileSystem.FileSystem;
  const tools = yield* MediaTools.Service;
  const file = yield* fs.makeTempFileScoped({ suffix: ".mp4" });

  yield* fs.writeFile(file, Buffer.concat(parts));

  const { packets } = yield* Schema.decodeEffect(AudioPackets)(
    yield* tools.ffprobe([
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "packet=pts_time,duration_time",
      "-of",
      "json",
      file,
    ]),
  );

  return packets.length === 0
    ? undefined
    : {
        start: Math.min(...packets.map((packet) => packet.pts_time)),
        end: Math.max(...packets.map((packet) => packet.pts_time + packet.duration_time)),
      };
}, Effect.scoped);

/**
 * Fetches the init segment of `playlistUrl`, which must carry no empty sample dependency box, and
 * its segments from the one that holds `position` on, and checks each, fetched alone with the
 * init segment: served, in the case's codec, profile, and sample entry,
 * opening on a keyframe at its planned start that no picture of the segment is presented before,
 * and carrying the sound of its whole interval: its audio starts no later than one audio frame
 * after its video, and no earlier than one audio frame before its first video packet is decoded,
 * as the muxer cuts a fragment there; and, before another segment, runs on to where that one's
 * first packet is decoded, a `frame` after its own last, within an audio frame.
 */
const checkSegments = Effect.fn("OutputCodecs.checkSegments")(function* (
  playlistUrl: string,
  position: number,
  expected: Case,
  frame: number,
) {
  const { init, segments } = yield* segmentsOf(playlistUrl);
  const initBytes = yield* fetched(init);

  assert.strictEqual(initBytes.status, 200, "init segment");
  assert.strictEqual(emptySampleDependencies(initBytes.body), 0, `${expected.name}: init segment`);

  const holding = segments.findLastIndex((segment) => segment.start <= position + frame / 2);
  const checked = segments.slice(Math.max(0, holding));

  assert.isAtLeast(checked.length, 2, "segments to check");

  for (const [index, segment] of checked.entries()) {
    const served = yield* fetched(segment.url);
    const at = `${expected.name}, the segment at ${segment.start.toFixed(3)} s`;

    assert.strictEqual(served.status, 200, `${at}: ${new TextDecoder().decode(served.body)}`);
    const probed = yield* probeSegment([initBytes.body, served.body]).pipe(Effect.orDie);
    const [stream] = probed.streams;
    const [first] = probed.packets;

    assert.deepStrictEqual(
      [stream?.codec_name, stream?.profile, stream?.codec_tag_string],
      [expected.codec, expected.profile, expected.tag],
      at,
    );
    assert.isDefined(first, at);
    assert.isTrue(first.flags.startsWith("K"), `${at}: the first packet is a keyframe`);
    assert.approximately(first.pts_time, segment.start, frame / 2, `${at}: where it starts`);
    assert.approximately(
      Math.min(...probed.packets.map((packet) => packet.pts_time)),
      first.pts_time,
      frame / 2,
      `${at}: no picture is presented before its keyframe, as an open GOP's leading pictures are`,
    );

    const audio = yield* audioSpan([initBytes.body, served.body]).pipe(Effect.orDie);
    const decoded = probed.packets.map((packet) => packet.dts_time);

    assert.isDefined(audio, `${at}: it carries sound`);
    assert.isAtMost(
      audio.start,
      first.pts_time + AUDIO_FRAME,
      `${at}: its sound starts with its picture`,
    );
    assert.isAtLeast(
      audio.start,
      Math.min(...decoded) - AUDIO_FRAME,
      `${at}: its sound starts in its own interval`,
    );

    if (index < checked.length - 1) {
      assert.isAtLeast(
        audio.end,
        Math.max(...decoded) + frame - AUDIO_FRAME,
        `${at}: its sound runs on to the next segment`,
      );
    }
  }
});

/**
 * Negotiates `expected.client` for `played`, checks the codec the answer names and where the
 * encode runs, then every segment from the start, and after a seek every segment from there.
 */
const plays = Effect.fn("OutputCodecs.plays")(function* (
  expected: Case,
  path: "cpu" | "qsv" | "vaapi",
  played: Played,
) {
  const server = yield* MediaTestServer.Service;
  const fileId: MediaFileId = yield* played.file;

  const token = signTestToken({
    fid: fileId,
    sid: `output-${path}-${expected.codec}-${played.key}`,
  });

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

  yield* checkSegments(local(negotiated.url), 0, expected, played.frame);

  const sought = yield* decodeSeek(
    yield* posted(`${server.baseUrl}/api/playback/seek`, {
      token,
      streamId: negotiated.streamId ?? "",
      positionSeconds: played.seekTo,
    }),
  ).pipe(Effect.orDie);

  assert.strictEqual(sought.video.codec, expected.codec, `${expected.name}, after a seek`);
  yield* checkSegments(local(sought.playlistUrl), played.seekTo, expected, played.frame);
  yield* posted(`${server.baseUrl}/api/playback/stop`, {
    token,
    streamId: negotiated.streamId ?? "",
  });
});

/**
 * Downloads the source at the standard quality for `expected.client` from a server on `path` and
 * checks the MP4 the service wrote: encoded on the CPU whatever the path, in the codec the answer
 * names, and that codec's profile and sample entry.
 */
const downloads = Effect.fn("OutputCodecs.downloads")(function* (
  expected: Case,
  path: "cpu" | "qsv" | "vaapi",
) {
  const server = yield* MediaTestServer.Service;
  const fileId: MediaFileId = yield* addSource;

  const token = signTestToken({
    fid: fileId,
    sid: `download-${path}-${expected.codec}`,
    pur: "download",
  });

  const ready = yield* posted(`${server.baseUrl}/api/downloads/prepare`, {
    token,
    capabilities: expected.client,
    quality: "standard",
  }).pipe(
    Effect.flatMap(decodePrepared),
    Effect.orDie,
    Effect.filterOrFail(
      (answer): answer is Extract<PrepareDownloadResponse, { readonly _tag: "Ready" }> =>
        Predicate.isTagged(answer, "Ready"),
    ),
    Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 300 }),
    Effect.orDie,
  );

  assert.strictEqual(ready.mode, "transcode-software", expected.name);
  assert.strictEqual(ready.video.codec, expected.codec, expected.name);

  const file = yield* fetched(ready.url.replace(/^https?:\/\/[^/]+/u, server.baseUrl));

  assert.strictEqual(file.status, 200, expected.name);
  const [stream] = (yield* probeSegment([file.body]).pipe(Effect.orDie)).streams;

  assert.deepStrictEqual(
    [stream?.codec_name, stream?.profile, stream?.codec_tag_string],
    [expected.codec, expected.profile, expected.tag],
    `${expected.name}'s download`,
  );
});

/** The sources a level is checked against. */
const LEVEL_SOURCES = {
  "24 fps": addSource,
  "60 fps": addFastSource,
  "a variable frame rate": addVfrSource,
} as const;

/** A device that plays one codec up to a declared level, and the source that tests it. */
interface LevelCase {
  readonly codec: "hevc" | "av1";
  /** The highest level the device declares, in ffprobe's units. */
  readonly declared: number;
  readonly source: keyof typeof LEVEL_SOURCES;
}

const LEVEL_CASES: ReadonlyArray<LevelCase> = [
  { codec: "hevc", declared: 63, source: "60 fps" },
  { codec: "av1", declared: 1, source: "60 fps" },
  { codec: "hevc", declared: 60, source: "24 fps" },
  { codec: "av1", declared: 0, source: "24 fps" },
  { codec: "hevc", declared: 63, source: "a variable frame rate" },
  { codec: "av1", declared: 1, source: "a variable frame rate" },
];

/** How a test names `level`'s device and source. */
const levelName = (level: LevelCase): string =>
  `an ${level.codec === "hevc" ? "HEVC" : "AV1"} device at level ${String(level.declared)}, from ${level.source}`;

/** The most of `times`, in seconds, that fall in any one second. */
const mostInASecond = (times: ReadonlyArray<number>): number =>
  Math.max(
    0,
    ...times.map((start) => times.filter((time) => time >= start && time < start + 0.999).length),
  );

/**
 * Negotiates `expected`'s device on a server on `path` and reads the first segments it serves:
 * the codec it names, at the size the answer gives, stating a level at or under the one the device
 * declared, and within that level's luma samples a second in its fastest second.
 */
const holdsLevel = Effect.fn("OutputCodecs.holdsLevel")(function* (
  expected: LevelCase,
  path: "cpu" | "qsv" | "vaapi",
) {
  const server = yield* MediaTestServer.Service;
  const fileId: MediaFileId = yield* LEVEL_SOURCES[expected.source];
  const name = levelName(expected);
  const limits = levelOf(expected.codec, expected.declared);

  const token = signTestToken({
    fid: fileId,
    sid: `level-${path}-${expected.codec}-${String(expected.declared)}-${expected.source}`,
  });

  const local = (url: string) => url.replace(/^https?:\/\/[^/]+/u, server.baseUrl);

  const negotiated = yield* decodeNegotiation(
    yield* posted(`${server.baseUrl}/api/playback/negotiate`, {
      token,
      capabilities: client([
        { codec: expected.codec, profiles: ["Main"], maxLevel: expected.declared },
      ]),
    }),
  ).pipe(Effect.orDie);

  assert.strictEqual(
    negotiated.mode,
    path === "cpu" ? "transcode-software" : `transcode-${path}`,
    name,
  );
  assert.strictEqual(negotiated.video.codec, expected.codec, name);
  assert.isDefined(limits, name);

  const { init, segments } = yield* segmentsOf(local(negotiated.url));
  const initBytes = yield* fetched(init);

  for (const segment of segments.slice(0, 2)) {
    const served = yield* fetched(segment.url);
    const at = `${name}, the segment at ${segment.start.toFixed(3)} s`;

    assert.strictEqual(served.status, 200, at);

    const probed = yield* probeSegment([initBytes.body, served.body]).pipe(Effect.orDie);
    const [stream] = probed.streams;

    assert.isDefined(stream, at);
    assert.deepStrictEqual(
      [stream.codec_name, stream.width, stream.height],
      [expected.codec, negotiated.video.width, negotiated.video.height],
      at,
    );
    assert.isDefined(stream.level, at);
    assert.isAtMost(stream.level, expected.declared, at);

    const pictures = mostInASecond(probed.packets.map((packet) => packet.pts_time));

    assert.isAtMost(
      pictures * (stream.coded_width ?? Number.NaN) * (stream.coded_height ?? Number.NaN),
      limits.maxSampleRate,
      `${at}: luma samples in its fastest second, ${String(pictures)} pictures`,
    );
  }

  yield* posted(`${server.baseUrl}/api/playback/stop`, {
    token,
    streamId: negotiated.streamId ?? "",
  });
});

/**
 * Negotiates `expected.client`, which plays SDR alone, for the HDR10 source on `path`, and reads
 * the first segments: tone-mapped there, and tagged as BT.709 SDR with none of the source's
 * mastering display or content light levels.
 */
const mapsToSdr = Effect.fn("OutputCodecs.mapsToSdr")(function* (
  expected: Case,
  path: "cpu" | "qsv" | "vaapi",
) {
  const server = yield* MediaTestServer.Service;
  const fileId: MediaFileId = yield* addHdrSource;
  const token = signTestToken({ fid: fileId, sid: `sdr-${path}-${expected.codec}` });
  const local = (url: string) => url.replace(/^https?:\/\/[^/]+/u, server.baseUrl);

  const negotiated = yield* decodeNegotiation(
    yield* posted(`${server.baseUrl}/api/playback/negotiate`, {
      token,
      capabilities: expected.client,
    }),
  ).pipe(Effect.orDie);

  assert.strictEqual(negotiated.video.codec, expected.codec, expected.name);
  assert.strictEqual(negotiated.video.dynamicRange, "sdr", expected.name);
  assert.deepInclude(
    negotiated.transcode?.stages.find((stage) => stage.op === "tonemap"),
    { domain: path },
    expected.name,
  );

  const { init, segments } = yield* segmentsOf(local(negotiated.url));
  const initBytes = yield* fetched(init);

  for (const segment of segments.slice(0, 2)) {
    const served = yield* fetched(segment.url);
    const at = `${expected.name}, the segment at ${segment.start.toFixed(3)} s`;

    assert.strictEqual(served.status, 200, at);

    const [stream] = (yield* probeSegment([initBytes.body, served.body]).pipe(Effect.orDie))
      .streams;

    assert.isDefined(stream, at);
    assert.deepStrictEqual(
      [stream.codec_name, stream.color_transfer, stream.color_primaries],
      [expected.codec, "bt709", "bt709"],
      at,
    );
    assert.deepStrictEqual(
      (stream.side_data_list ?? []).map((side) => side.side_data_type),
      [],
      at,
    );
  }

  yield* posted(`${server.baseUrl}/api/playback/stop`, {
    token,
    streamId: negotiated.streamId ?? "",
  });
});

describe.skipIf(!hasFfmpeg)("output codecs", () => {
  layer(MediaTestServer.layer(), { excludeTestServices: true, timeout: "180 seconds" })((it) => {
    for (const expected of CPU_CASES) {
      it.effect(
        `downloads ${expected.codec} encoded on the CPU for ${expected.name}`,
        () => downloads(expected, "cpu"),
        120_000,
      );
    }

    for (const played of PLAYED) {
      for (const expected of CPU_CASES) {
        it.effect(
          `encodes ${expected.codec} on the CPU from ${played.name} for ${expected.name}`,
          () => plays(expected, "cpu", played),
          120_000,
        );
      }
    }

    for (const expected of LEVEL_CASES) {
      it.effect(
        `holds ${levelName(expected)} to its level on the CPU`,
        () => holdsLevel(expected, "cpu"),
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
        for (const expected of CPU_CASES) {
          it.effect(
            `downloads ${expected.codec} encoded on the CPU of a ${path} server for ${expected.name}`,
            () => downloads(expected, path),
            120_000,
          );
        }

        for (const played of PLAYED) {
          for (const expected of GPU_CASES) {
            it.effect(
              `encodes ${expected.codec} on ${path} from ${played.name} for ${expected.name}`,
              () => plays(expected, path, played),
              120_000,
            );
          }
        }

        for (const expected of LEVEL_CASES) {
          it.effect(
            `holds ${levelName(expected)} to its level on ${path}`,
            () => holdsLevel(expected, path),
            120_000,
          );
        }

        if (path === "qsv") {
          for (const expected of [h264Only, hevcOnly, av1Only]) {
            it.effect(
              `tags ${expected.codec} tone-mapped on qsv as BT.709 SDR without HDR metadata`,
              () => mapsToSdr(expected, path),
              120_000,
            );
          }
        }
      });
    });
  }
});
