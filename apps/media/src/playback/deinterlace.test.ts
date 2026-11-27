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

/** The tools the server runs: `FFMPEG_PATH` and `FFPROBE_PATH` when set, to try another build. */
const TOOLS = {
  FFMPEG_PATH: process.env["FFMPEG_PATH"] ?? "ffmpeg",
  FFPROBE_PATH: process.env["FFPROBE_PATH"] ?? "ffprobe",
};

const SOURCES = LibraryId.make("interlaced");

const SECONDS = 8;

const FRAME = 1 / 25;

/** One AAC frame of the sources' 48 kHz audio. */
const AUDIO_FRAME = 1024 / 48_000;

const WIDTH = 720;

const HEIGHT = 576;

/** How far the box moves each field, the distance after which it starts again, and its width. */
const BOX = { step: 8, run: 640, width: 48, top: 192, height: 192 } as const;

/** Rows inside the box, where its position is read. */
const ROWS = { from: 250, to: 330 } as const;

/**
 * Fifty pictures a second of a white box on black moving `BOX.step` pixels each, woven by `weave`
 * into 25 frames of two fields.
 */
const movingBox = (weave: string): string =>
  [
    `color=c=black:s=${String(WIDTH)}x${String(HEIGHT)}:r=50:d=${String(SECONDS)}[ground]`,
    `color=c=white:s=${String(BOX.width)}x${String(BOX.height)}:r=50:d=${String(SECONDS)}[box]`,
    `[ground][box]overlay=x='mod(n*${String(BOX.step)},${String(BOX.run)})':y=${String(BOX.top)},${weave}[out0]`,
  ].join(";");

const TOP_FIRST = movingBox("tinterlace=interleave_top,setfield=tff");

const BOTTOM_FIRST = movingBox("tinterlace=interleave_bottom,setfield=bff");

const TONE = [
  "-f",
  "lavfi",
  "-i",
  `sine=frequency=440:sample_rate=48000:duration=${String(SECONDS)}`,
];

const QUIET = ["-hide_banner", "-nostdin", "-v", "error", "-y"];

/** Plays H.264 alone, so anything else is encoded to it. */
const h264Browser: ClientCapabilities = {
  containers: [],
  videoCodecs: [{ codec: "h264" }],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 1920,
  maxHeight: 1080,
  hls: false,
  mse: true,
};

/** Plays HEVC alone, so even H.264 is encoded, and a CPU may encode HEVC for it. */
const hevcDevice: ClientCapabilities = {
  containers: [],
  videoCodecs: [{ codec: "hevc", profiles: ["Main"] }],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 1920,
  maxHeight: 1080,
  hls: true,
  mse: false,
};

interface Fixture {
  readonly key: string;
  readonly name: string;
  readonly file: string;
  /** The ffmpeg runs that write it, each given its output path. */
  readonly runs: (output: string) => ReadonlyArray<ReadonlyArray<string>>;
  readonly client: ClientCapabilities;
  readonly codec: string;
  /** Whether its frames are fields of a moving box to measure, or progressive pictures. */
  readonly frames: "woven" | "progressive";
  /** The field each frame shows first. */
  readonly first: "top" | "bottom";
  readonly audio: boolean;
}

/** MPEG-2 coded as fields, top first; ffmpeg's Matroska says `tb`, top coded, bottom shown. */
const topFirst: Fixture = {
  key: "top",
  name: "top-field-first MPEG-2 in Matroska",
  file: "Woven Top (2001)/Woven Top (2001).mkv",
  runs: (output) => [
    [
      ...QUIET,
      "-f",
      "lavfi",
      "-i",
      TOP_FIRST,
      ...TONE,
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-c:v",
      "mpeg2video",
      "-flags",
      "+ildct+ilme",
      "-q:v",
      "2",
      "-g",
      "12",
      "-c:a",
      "aac",
      output,
    ],
  ],
  client: h264Browser,
  codec: "h264",
  frames: "woven",
  first: "top",
  audio: true,
};

/** H.264 coded as fields, bottom first, in MP4, which ffprobe reads as `tt`: the container lies. */
const bottomFirst: Fixture = {
  key: "bottom",
  name: "bottom-field-first H.264 in MP4 that reads as top first",
  file: "Woven Bottom (2002)/Woven Bottom (2002).mp4",
  runs: (output) => [
    [
      ...QUIET,
      "-f",
      "lavfi",
      "-i",
      BOTTOM_FIRST,
      ...TONE,
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-flags",
      "+ildct",
      "-g",
      "25",
      "-c:a",
      "aac",
      output,
    ],
  ],
  client: hevcDevice,
  codec: "hevc",
  frames: "woven",
  first: "bottom",
  audio: true,
};

/** Progressive H.264 in Matroska flagged top field first: every frame is a whole picture. */
const flaggedProgressive: Fixture = {
  key: "flagged",
  name: "progressive H.264 flagged interlaced",
  file: "Flagged Progressive (2003)/Flagged Progressive (2003).mkv",
  runs: (output) => [
    [
      ...QUIET,
      "-f",
      "lavfi",
      "-i",
      `testsrc2=s=720x576:r=25:d=${String(SECONDS)}`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-g",
      "25",
      `${output}.part.mkv`,
    ],
    [...QUIET, "-i", `${output}.part.mkv`, "-c", "copy", "-field_order", "tt", output],
  ],
  client: hevcDevice,
  codec: "hevc",
  frames: "progressive",
  first: "top",
  audio: false,
};

/** MPEG-4 Part 2 coded as fields in AVI, which says nothing of fields: only its frames do. */
const unflagged: Fixture = {
  key: "avi",
  name: "interlaced MPEG-4 in AVI without a field order",
  file: "Fields In Avi (2004)/Fields In Avi (2004).avi",
  runs: (output) => [
    [
      ...QUIET,
      "-f",
      "lavfi",
      "-i",
      TOP_FIRST,
      "-c:v",
      "mpeg4",
      "-flags",
      "+ildct+ilme",
      "-q:v",
      "2",
      output,
    ],
  ],
  client: h264Browser,
  codec: "h264",
  frames: "woven",
  first: "top",
  audio: false,
};

const FIXTURES: ReadonlyArray<Fixture> = [topFirst, bottomFirst, flaggedProgressive, unflagged];

/** Writes `fixture` in the sources library, once, scans it, and answers its file and path. */
const added = Effect.fn("Deinterlace.added")(function* (fixture: Fixture) {
  const workspace = yield* FixtureWorkspace.Service;
  const tools = yield* MediaTools.Service;
  const scanner = yield* LibraryScanner.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(workspace.root, "interlaced");
  const file = path.join(root, fixture.file);

  if (!(yield* fs.exists(file))) {
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });

    for (const run of fixture.runs(file)) yield* tools.ffmpeg(run);
  }

  yield* scanner.scan({ libraryId: SOURCES, root, mode: "incremental" });

  return { fileId: MemoryLibrary.fileIdOf(SOURCES, fixture.file), source: file };
}, Effect.orDie);

const decodeNegotiation = Schema.decodeUnknownEffect(Schema.toCodecJson(NegotiateResponse));

const decodeSeek = Schema.decodeUnknownEffect(Schema.toCodecJson(SeekResponse));

/** The body of a negotiation, or of a seek or stop of a stream. */
type RequestBody =
  | { readonly token: string; readonly capabilities: ClientCapabilities }
  | { readonly token: string; readonly streamId: string; readonly positionSeconds?: number };

const posted = (url: string, body: RequestBody) =>
  HttpClient.execute(HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body))).pipe(
    Effect.flatMap((response) => response.json),
    Effect.orDie,
  );

const fetched = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      response.arrayBuffer.pipe(
        Effect.map((body) => ({ status: response.status, body: new Uint8Array(body) })),
      ),
    ),
    Effect.orDie,
  );

/** The playlist's init segment and segments, with the time each segment starts at. */
const segmentsOf = Effect.fn("Deinterlace.segmentsOf")(function* (playlistUrl: string) {
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

  return { init: new URL(init, playlist).href, segments, end: start };
});

/** `parts` written one after another into a file of the scope's. */
const joined = Effect.fn("Deinterlace.joined")(function* (parts: ReadonlyArray<Uint8Array>) {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* fs.makeTempFileScoped({ suffix: ".mp4" });

  yield* fs.writeFile(file, Buffer.concat(parts));

  return file;
});

const Packets = Schema.fromJsonString(
  Schema.Struct({
    packets: Schema.Array(
      Schema.Struct({
        pts_time: Schema.FiniteFromString,
        dts_time: Schema.FiniteFromString,
        flags: Schema.String,
      }),
    ),
  }),
);

/** The packets of `file`'s first stream of `kind` (`v`, `a`), in decoding order. */
const packetsOf = Effect.fn("Deinterlace.packetsOf")(function* (file: string, kind: "v" | "a") {
  const tools = yield* MediaTools.Service;

  const output = yield* tools.ffprobe([
    "-v",
    "error",
    "-select_streams",
    `${kind}:0`,
    "-show_entries",
    "packet=pts_time,dts_time,flags",
    "-of",
    "json",
    file,
  ]);

  return (yield* Schema.decodeEffect(Packets)(output)).packets;
}, Effect.orDie);

/**
 * The share of `file`'s frames ffmpeg's `idet` finds interlaced, of those it decides either way,
 * by its decision over several frames.
 */
const interlacedShare = Effect.fn("Deinterlace.interlacedShare")(
  function* (file: string) {
    const tools = yield* MediaTools.Service;
    const fs = yield* FileSystem.FileSystem;
    const log = yield* fs.makeTempFileScoped({ suffix: ".txt" });

    yield* tools.ffmpeg([
      ...QUIET,
      "-i",
      file,
      "-map",
      "0:v:0",
      "-vf",
      `idet,metadata=mode=print:key=lavfi.idet.multiple.current_frame:file=${log}`,
      "-f",
      "null",
      "-",
    ]);

    const printed = yield* fs.readFileString(log);
    const decisions = [...printed.matchAll(/current_frame=(\w+)/gu)].map((match) => match[1]);
    const interlaced = decisions.filter((kind) => kind === "tff" || kind === "bff").length;
    const decided = interlaced + decisions.filter((kind) => kind === "progressive").length;

    return decided === 0 ? Number.NaN : interlaced / decided;
  },
  Effect.scoped,
  Effect.orDie,
);

/** Rows of a frame: all of them, or one field's. */
type Rows = "all" | "top" | "bottom";

/**
 * Where the box's middle is, column-wise, in each of `file`'s frames, read in gray from `rows`
 * between `ROWS.from` and `ROWS.to`.
 */
const boxPositions = Effect.fn("Deinterlace.boxPositions")(function* (file: string, rows: Rows) {
  const tools = yield* MediaTools.Service;
  const fs = yield* FileSystem.FileSystem;
  const gray = yield* fs.makeTempFileScoped({ suffix: ".gray" });

  yield* tools.ffmpeg([
    ...QUIET,
    "-i",
    file,
    "-map",
    "0:v:0",
    // Each decoded frame once: ffmpeg 7.1's constant-rate output repeats the last.
    "-fps_mode",
    "passthrough",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "gray",
    gray,
  ]);

  const pixels = yield* fs.readFile(gray);
  const size = WIDTH * HEIGHT;
  const step = rows === "all" ? 1 : 2;
  const from = rows === "bottom" ? ROWS.from + 1 : ROWS.from;

  return Array.from({ length: Math.floor(pixels.length / size) }, (_, index) => {
    let sum = 0;
    let count = 0;

    for (let row = from; row < ROWS.to; row += step) {
      for (let column = 0; column < WIDTH; column += 1) {
        if ((pixels[index * size + row * WIDTH + column] ?? 0) > 128) {
          sum += column;
          count += 1;
        }
      }
    }

    return count === 0 ? Number.NaN : sum / count;
  });
}, Effect.scoped);

/**
 * The PSNR of `file`'s first `frames` frames against `source`'s, put through `reference` first
 * when given, in decibels, from the mean of the squared errors ffmpeg's `psnr` reports frame by
 * frame.
 */
const psnrAgainst = Effect.fn("Deinterlace.psnrAgainst")(
  function* (file: string, source: string, frames: number, reference = "null") {
    const tools = yield* MediaTools.Service;
    const fs = yield* FileSystem.FileSystem;
    const log = yield* fs.makeTempFileScoped({ suffix: ".txt" });

    yield* tools.ffmpeg([
      ...QUIET,
      "-i",
      file,
      "-i",
      source,
      "-filter_complex",
      `[1:v:0]${reference}[reference];[0:v:0][reference]psnr=stats_file=${log}`,
      "-frames:v",
      String(frames),
      "-f",
      "null",
      "-",
    ]);

    const stats = yield* fs.readFileString(log);
    const errors = [...stats.matchAll(/mse_avg:([\d.]+)/gu)].map((match) => Number(match[1]));
    const mean = errors.reduce((total, error) => total + error, 0) / errors.length;

    return mean === 0 ? Number.POSITIVE_INFINITY : 10 * Math.log10((255 * 255) / mean);
  },
  Effect.scoped,
  Effect.orDie,
);

/**
 * Plays `fixture` on `path` and checks what it serves: the summary names the deinterlace stage on
 * that path; every segment opens on a keyframe at its planned start; the frames run at the
 * source's 25 a second for its whole length; and, for woven fields, `idet` finds no combing left
 * where it finds it in the source, and each frame shows the box where the source's first field
 * puts it (the other field's place, 8 pixels on, is a wrong field order); for whole pictures, the
 * frames pass through untouched. After a seek, sound and picture start within a frame.
 */
const plays = Effect.fn("Deinterlace.plays")(function* (
  fixture: Fixture,
  path: "cpu" | "qsv" | "vaapi",
) {
  const server = yield* MediaTestServer.Service;
  const { fileId, source }: { fileId: MediaFileId; source: string } = yield* added(fixture);
  const token = signTestToken({ fid: fileId, sid: `deinterlace-${path}-${fixture.key}` });
  const local = (url: string) => url.replace(/^https?:\/\/[^/]+/u, server.baseUrl);
  const at = `${fixture.name} on ${path}`;

  const negotiated = yield* decodeNegotiation(
    yield* posted(`${server.baseUrl}/api/playback/negotiate`, {
      token,
      capabilities: fixture.client,
    }),
  ).pipe(Effect.orDie);

  assert.strictEqual(negotiated.video.codec, fixture.codec, at);
  assert.deepInclude(
    negotiated.transcode?.stages.find((stage) => stage.op === "deinterlace"),
    { domain: path, impl: `deinterlace.${path}` },
    at,
  );

  const { init, segments, end } = yield* segmentsOf(local(negotiated.url));
  const initBytes = yield* fetched(init);
  const bodies: Array<Uint8Array> = [];

  assert.approximately(end, SECONDS, FRAME, `${at}: the playlist's length`);

  for (const segment of segments) {
    const served = yield* fetched(segment.url);

    assert.strictEqual(served.status, 200, `${at}: the segment at ${segment.start.toFixed(3)} s`);
    bodies.push(served.body);

    const [first] = yield* packetsOf(yield* joined([initBytes.body, served.body]), "v");
    const opening = `${at}: the segment at ${segment.start.toFixed(3)} s`;

    assert.isDefined(first, opening);
    assert.isTrue(first.flags.startsWith("K"), `${opening} opens on a keyframe`);
    assert.approximately(first.pts_time, segment.start, FRAME / 2, `${opening} starts there`);
  }

  const whole = yield* joined([initBytes.body, ...bodies]);

  const times = (yield* packetsOf(whole, "v"))
    .map((packet) => packet.pts_time)
    .toSorted((a, b) => a - b);

  assert.lengthOf(times, SECONDS * 25, `${at}: one frame for each of the source's`);
  assert.approximately(
    (times.at(-1) ?? 0) + FRAME,
    SECONDS,
    FRAME / 2,
    `${at}: where the frames end`,
  );

  for (const [index, time] of times.entries()) {
    assert.approximately(
      time,
      index * FRAME,
      FRAME / 4,
      `${at}: frame ${String(index)} at the source's rate`,
    );
  }

  if (fixture.frames === "woven") {
    assert.isAbove(yield* interlacedShare(source), 0.9, `${at}: idet finds the source combed`);
    assert.isAtMost(
      yield* interlacedShare(whole),
      0.15,
      `${at}: idet finds the output progressive`,
    );

    const shown = yield* boxPositions(whole, "all");
    const first = yield* boxPositions(source, fixture.first);
    const second = yield* boxPositions(source, fixture.first === "top" ? "bottom" : "top");

    assert.lengthOf(shown, first.length, at);

    for (const [index, position] of shown.entries()) {
      const expected = first[index] ?? Number.NaN;

      // Where the box starts its run again, a frame's fields are far apart and no order shows.
      if (Math.abs((second[index] ?? Number.NaN) - expected) <= BOX.step) {
        assert.approximately(
          position,
          expected,
          2,
          `${at}: the box in frame ${String(index)} where its first field puts it`,
        );
      }
    }
  } else {
    // Deinterlacing a whole picture costs it detail wherever it moves; the encode costs every
    // picture some. Passed through, the frames are nearer the source than its deinterlaced copy.
    const untouched = yield* psnrAgainst(whole, source, 50);
    const deinterlaced = yield* psnrAgainst(whole, source, 50, "bwdif=mode=send_frame:deint=all");

    assert.isAbove(
      untouched,
      deinterlaced + 3,
      `${at}: frames flagged progressive pass through, not deinterlaced`,
    );
  }

  if (fixture.audio) {
    const position = 4.5;

    const sought = yield* decodeSeek(
      yield* posted(`${server.baseUrl}/api/playback/seek`, {
        token,
        streamId: negotiated.streamId ?? "",
        positionSeconds: position,
      }),
    ).pipe(Effect.orDie);

    const after = yield* segmentsOf(local(sought.playlistUrl));
    const holding = after.segments.findLast((segment) => segment.start <= position + FRAME / 2);

    assert.isDefined(holding, `${at}: a segment holds the seek`);

    const served = yield* fetched(holding.url);
    const file = yield* joined([(yield* fetched(after.init)).body, served.body]);
    const pictures = yield* packetsOf(file, "v");
    const picture = Math.min(...pictures.map((packet) => packet.pts_time));
    const decoded = Math.min(...pictures.map((packet) => packet.dts_time));
    const sound = Math.min(...(yield* packetsOf(file, "a")).map((packet) => packet.pts_time));

    const [opening] = pictures;

    assert.isDefined(opening, `${at}: after a seek, a picture`);
    assert.isTrue(opening.flags.startsWith("K"), `${at}: after a seek, a keyframe first`);
    assert.approximately(picture, holding.start, FRAME / 2, `${at}: after a seek, where it starts`);
    // As the grid's `audio-start` reads it: the muxer cuts the sound where the first picture is
    // decoded, which an encoder that reorders pictures does before it is shown.
    assert.isAtMost(
      sound,
      picture + AUDIO_FRAME,
      `${at}: after a seek, sound starts by the picture`,
    );
    assert.isAtLeast(
      sound,
      decoded - AUDIO_FRAME,
      `${at}: after a seek, sound starts in its segment`,
    );
  }

  yield* posted(`${server.baseUrl}/api/playback/stop`, {
    token,
    streamId: negotiated.streamId ?? "",
  });
}, Effect.scoped);

describe.skipIf(!hasFfmpeg)("deinterlacing", () => {
  layer(MediaTestServer.layer(TOOLS), { excludeTestServices: true, timeout: "180 seconds" })(
    (it) => {
      for (const fixture of FIXTURES) {
        it.effect(
          `plays ${fixture.name} deinterlaced on the CPU`,
          () => plays(fixture, "cpu"),
          120_000,
        );
      }
    },
  );

  for (const path of ["qsv", "vaapi"] as const) {
    const device = path === "qsv" ? process.env["QSV_DEVICE"] : process.env["VAAPI_DEVICE"];

    describe.runIf(path === "qsv" ? hasQsv : hasVaapi)(path, () => {
      layer(
        MediaTestServer.layer({
          ...TOOLS,
          HARDWARE_ACCELERATION: path,
          QSV_DEVICE: device ?? "/dev/dri/renderD128",
          VAAPI_DEVICE: device ?? "/dev/dri/renderD128",
        }),
        { excludeTestServices: true, timeout: "180 seconds" },
      )((it) => {
        for (const fixture of FIXTURES) {
          it.effect(
            `plays ${fixture.name} deinterlaced on ${path}`,
            () => plays(fixture, path),
            120_000,
          );
        }
      });
    });
  }
});
