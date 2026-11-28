import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { LibraryId, type MediaFileId } from "@media/contracts/ids";
import { type ClientCapabilities, NegotiateResponse } from "@media/contracts/media-playback";

import * as LibraryScanner from "../library/library-scanner.ts";
import * as MemoryLibrary from "../library/memory-library.ts";
import * as MediaTools from "../media/media-tools.ts";
import { ffmpegAvailable, qsvUsable, vaapiUsable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import { ambientBox, dolbyVisionBox, withSampleEntryBox } from "../testing/mp4-boxes.ts";
import { signTestToken } from "../testing/test-tokens.ts";

const hasFfmpeg = await ffmpegAvailable();

const hasQsv = hasFfmpeg && (await qsvUsable());

const hasVaapi = hasFfmpeg && (await vaapiUsable());

const TOOLS = {
  FFMPEG_PATH: process.env["FFMPEG_PATH"] ?? "ffmpeg",
  FFPROBE_PATH: process.env["FFPROBE_PATH"] ?? "ffprobe",
};

const SOURCES = LibraryId.make("hdr");

const QUIET = ["-hide_banner", "-nostdin", "-v", "error", "-y"];

const WIDTH = 640;

const HEIGHT = 360;

/** Gray levels of the ramp, R'G'B' in full range, each 80 pixels wide across the top half. */
const RAMP = [0, 8, 16, 32, 64, 128, 192, 255] as const;

/** Colour bars along the bottom half, R'G'B' in full range. */
const BARS = [
  [192, 0, 0],
  [0, 192, 0],
  [0, 0, 192],
  [192, 192, 0],
  [0, 192, 192],
  [192, 0, 192],
  [224, 172, 140],
  [64, 64, 64],
] as const;

const hex = (rgb: ReadonlyArray<number>): string =>
  `0x${rgb.map((value) => value.toString(16).padStart(2, "0")).join("")}`;

/** The SDR picture both HDR fixtures carry: the ramp over the bars, drawn on an RGB canvas. */
const PICTURE = [
  `color=c=black:s=${String(WIDTH)}x${String(HEIGHT)}:r=24:d=4`,
  "format=rgb24",
  ...RAMP.map(
    (level, index) =>
      `drawbox=x=${String(index * 80)}:y=0:w=80:h=180:color=${hex([level, level, level])}:t=fill`,
  ),
  ...BARS.map(
    (rgb, index) => `drawbox=x=${String(index * 80)}:y=180:w=80:h=180:color=${hex(rgb)}:t=fill`,
  ),
].join(",");

/**
 * One HDR fixture: the SDR picture placed in HDR, SDR white at 100 cd/m² in PQ, or at HLG's
 * reference white (75 %, 203 cd/m² on a 1000 cd/m² display) in HLG, encoded by libx265, PQ with
 * HDR10's mastering display and content light levels. `kind` is the range the tone map reads,
 * `source` the kind the service's table of source colours names.
 */
interface Fixture {
  readonly name: string;
  readonly file: string;
  readonly kind: "hdr10" | "hlg";
  readonly source: string;
  readonly graph: string;
  readonly params: string;
  readonly transfer: string;
  /** An MP4 whose video carries this box in its sample entry, as an iPhone's HLG or a Dolby Vision copy does. */
  readonly box?: Uint8Array;
}

const HDR10_GRAPH = `${PICTURE},zscale=tin=bt709:pin=bt709:min=gbr:rin=full:t=smpte2084:p=bt2020:m=bt2020nc:r=tv:npl=100,format=yuv420p10le`;

const HDR10_PARAMS =
  "log-level=error:hdr10=1:repeat-headers=1:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50):max-cll=1000,400";

const HLG_GRAPH = `${PICTURE},zscale=tin=bt709:pin=bt709:min=gbr:rin=full:t=linear:p=bt2020,format=gbrpf32le,colorchannelmixer=rr=0.203:gg=0.203:bb=0.203,zscale=tin=linear:pin=bt2020:min=gbr:t=arib-std-b67:m=bt2020nc:r=tv:npl=1000,format=yuv420p10le`;

const HDR10: Fixture = {
  name: "HDR10",
  file: "hdr10.mkv",
  kind: "hdr10",
  source: "hdr10",
  graph: HDR10_GRAPH,
  params: HDR10_PARAMS,
  transfer: "smpte2084",
};

const HLG: Fixture = {
  name: "HLG",
  file: "hlg.mkv",
  kind: "hlg",
  source: "hlg",
  graph: HLG_GRAPH,
  params: "log-level=error",
  transfer: "arib-std-b67",
};

/** HDR10 with a Dolby Vision profile 8.1 configuration record, its base layer's range HDR10. */
const DOLBY_VISION_81: Fixture = {
  name: "Dolby Vision 8.1",
  file: "dolby-vision-8.1.mp4",
  kind: "hdr10",
  source: "dolby-vision-8.1",
  graph: HDR10_GRAPH,
  params: HDR10_PARAMS,
  transfer: "smpte2084",
  box: dolbyVisionBox(8, 4, 1),
};

const FIXTURES: ReadonlyArray<Fixture> = [
  HDR10,
  HLG,
  {
    name: "HLG with an ambient viewing environment",
    file: "hlg-ambient.mp4",
    kind: "hlg",
    source: "hlg",
    graph: HLG_GRAPH,
    params: "log-level=error",
    transfer: "arib-std-b67",
    box: ambientBox(3_140_000, 15_635, 16_450),
  },
  DOLBY_VISION_81,
];

/** The kinds a burned-in subtitle is drawn over, each with the subtitle muxed in as stream 2. */
const SUBTITLED: ReadonlyArray<Fixture> = [HDR10, HLG, DOLBY_VISION_81];

/**
 * A text subtitle of two filled boxes from the first picture to the last: mid gray (128) over the
 * ramp's black cell, and an olive yellow (160, 160, 0) over the last bar's dark gray one. Drawn in
 * SDR after the tone map, they keep those levels; drawn into the HDR picture before it, their code
 * values read as PQ or HLG levels and come out far brighter (gray 128 near 240 in PQ).
 */
const BOXES = [
  "[Script Info]",
  "ScriptType: v4.00+",
  "PlayResX: 640",
  "PlayResY: 360",
  "",
  "[V4+ Styles]",
  "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
  "Style: Box,Sans,20,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1",
  "",
  "[Events]",
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  String.raw`Dialogue: 0,0:00:00.00,0:00:04.00,Box,,0,0,0,,{\pos(0,0)\1c&H808080&\p1}m 0 0 l 80 0 80 180 0 180{\p0}`,
  String.raw`Dialogue: 0,0:00:00.00,0:00:04.00,Box,,0,0,0,,{\pos(560,180)\1c&H00A0A0&\p1}m 0 0 l 80 0 80 180 0 180{\p0}`,
  "",
].join("\n");

/**
 * The only side data an SDR stream may carry, on the stream or its first picture: the encoder's own
 * unregistered SEI. Anything else, HDR10's static metadata, HDR10+, Dolby Vision, an ambient viewing
 * environment, or a kind not met yet, fails.
 */
const SDR_SIDE_DATA: ReadonlySet<string> = new Set(["H.26[45] User Data Unregistered SEI message"]);

/** The tone maps each path may run for each kind: libplacebo's first, where the build has it. */
const TONE_MAPS = {
  cpu: { hdr10: ["tonemap.cpu"], hlg: ["tonemap.cpu"] },
  qsv: {
    hdr10: ["tonemap.qsv.placebo", "tonemap.qsv"],
    hlg: ["tonemap.qsv.placebo", "tonemap.qsv"],
  },
  vaapi: {
    hdr10: ["tonemap.vaapi.placebo", "tonemap.vaapi"],
    hlg: ["tonemap.vaapi.placebo", "tonemap.cpu"],
  },
} as const satisfies Record<string, Record<Fixture["kind"], ReadonlyArray<string>>>;

/** A browser on an SDR display: H.264 alone. */
const sdrBrowser: ClientCapabilities = {
  containers: [],
  videoCodecs: [{ codec: "h264" }],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 1920,
  maxHeight: 1080,
  hls: false,
  mse: true,
};

/** The name of `fixture`'s copy with the boxes' subtitle muxed in. */
const subtitledName = (fixture: Fixture): string =>
  `${fixture.file.replace(/\.[^.]+$/u, "")}-subtitled.mkv`;

/**
 * Writes `fixture` in the sources library, once, and with `subtitled` its copy with the boxes'
 * subtitle, scans the library, and answers the file asked for.
 */
const added = Effect.fn("HdrColour.added")(function* (fixture: Fixture, subtitled: boolean) {
  const workspace = yield* FixtureWorkspace.Service;
  const tools = yield* MediaTools.Service;
  const scanner = yield* LibraryScanner.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(workspace.root, "hdr");
  const file = path.join(root, fixture.file);

  if (!(yield* fs.exists(file))) {
    yield* fs.makeDirectory(root, { recursive: true });
    const written = fixture.box === undefined ? file : `${file}.plain.mp4`;

    yield* tools.ffmpeg([
      ...QUIET,
      "-f",
      "lavfi",
      "-i",
      fixture.graph,
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=4",
      "-c:v",
      "libx265",
      "-preset",
      "ultrafast",
      "-x265-params",
      fixture.params,
      "-color_primaries",
      "bt2020",
      "-color_trc",
      fixture.transfer,
      "-colorspace",
      "bt2020nc",
      "-c:a",
      "aac",
      ...(fixture.box === undefined ? [] : ["-tag:v", "hvc1"]),
      written,
    ]);

    if (fixture.box !== undefined) {
      yield* fs.writeFile(file, withSampleEntryBox(yield* fs.readFile(written), fixture.box));
      yield* fs.remove(written);
    }
  }

  const copy = path.join(root, subtitledName(fixture));

  if (subtitled && !(yield* fs.exists(copy))) {
    const script = path.join(root, "boxes.ass");

    yield* fs.writeFileString(script, BOXES);
    yield* tools.ffmpeg([
      ...QUIET,
      "-i",
      file,
      "-i",
      script,
      "-map",
      "0",
      "-map",
      "1",
      "-c",
      "copy",
      copy,
    ]);
  }

  yield* scanner.scan({ libraryId: SOURCES, root, mode: "incremental" });

  return MemoryLibrary.fileIdOf(SOURCES, subtitled ? subtitledName(fixture) : fixture.file);
}, Effect.orDie);

const decodeNegotiation = Schema.decodeUnknownEffect(Schema.toCodecJson(NegotiateResponse));

const fetched = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) => response.arrayBuffer),
    Effect.map((body) => new Uint8Array(body)),
    Effect.orDie,
  );

/** The served stream's init segment and first segment, joined into a file of the scope's. */
const servedStart = Effect.fn("HdrColour.servedStart")(function* (playlistUrl: string) {
  const fs = yield* FileSystem.FileSystem;
  const playlist = new URL(playlistUrl);
  const text = new TextDecoder().decode(yield* fetched(playlist.href));
  const init = /#EXT-X-MAP:URI="([^"]+)"/u.exec(text)?.[1] ?? "";
  const first = text.split("\n").find((line) => line !== "" && !line.startsWith("#")) ?? "";
  const file = yield* fs.makeTempFileScoped({ suffix: ".mp4" });

  yield* fs.writeFile(
    file,
    Buffer.concat([
      yield* fetched(new URL(init, playlist).href),
      yield* fetched(new URL(first, playlist).href),
    ]),
  );

  return file;
});

const Described = Schema.fromJsonString(
  Schema.Struct({
    streams: Schema.Array(
      Schema.Struct({
        color_transfer: Schema.optionalKey(Schema.String),
        color_primaries: Schema.optionalKey(Schema.String),
        color_space: Schema.optionalKey(Schema.String),
        color_range: Schema.optionalKey(Schema.String),
        side_data_list: Schema.optionalKey(
          Schema.Array(Schema.Struct({ side_data_type: Schema.optionalKey(Schema.String) })),
        ),
      }),
    ),
    frames: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          side_data_list: Schema.optionalKey(
            Schema.Array(Schema.Struct({ side_data_type: Schema.optionalKey(Schema.String) })),
          ),
        }),
      ),
    ),
  }),
);

/** The colour tags of `file`'s video and the types of side data on it and its first picture. */
const described = Effect.fn("HdrColour.described")(function* (file: string) {
  const tools = yield* MediaTools.Service;

  const output = yield* tools.ffprobe([
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-read_intervals",
    "%+#1",
    "-show_entries",
    "stream=color_transfer,color_primaries,color_space,color_range:stream_side_data=side_data_type:frame_side_data=side_data_type",
    "-of",
    "json",
    file,
  ]);

  const parsed = yield* Schema.decodeEffect(Described)(output);
  const [stream] = parsed.streams;

  return {
    tags: [stream?.color_transfer, stream?.color_primaries, stream?.color_space],
    range: stream?.color_range,
    sideData: [
      ...(stream?.side_data_list ?? []),
      ...(parsed.frames?.[0]?.side_data_list ?? []),
    ].map((item) => item.side_data_type ?? ""),
  };
}, Effect.orDie);

/** The mean R'G'B' of the middle of each 80x180 cell of `file`'s first picture, in BT.709. */
const cells = Effect.fn("HdrColour.cells")(
  function* (file: string) {
    const tools = yield* MediaTools.Service;
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.makeTempFileScoped({ suffix: ".rgb" });

    yield* tools.ffmpeg([
      ...QUIET,
      "-i",
      file,
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      "-vf",
      "zscale=p=bt709:t=bt709:m=gbr:r=full,format=gbrp,format=rgb24",
      "-f",
      "rawvideo",
      raw,
    ]);

    const rgb = yield* fs.readFile(raw);

    const mean = (column: number, row: number) => {
      const sum = [0, 0, 0];
      let count = 0;

      for (let y = row * 180 + 60; y < row * 180 + 120; y += 1) {
        for (let x = column * 80 + 25; x < column * 80 + 55; x += 1) {
          for (const channel of [0, 1, 2] as const) {
            sum[channel] = (sum[channel] ?? 0) + (rgb[(y * WIDTH + x) * 3 + channel] ?? 0);
          }

          count += 1;
        }
      }

      return sum.map((value) => value / count);
    };

    return {
      ramp: RAMP.map((_, column) => mean(column, 0)),
      bars: BARS.map((_, column) => mean(column, 1)),
    };
  },
  Effect.scoped,
  Effect.orDie,
);

const luma = (rgb: ReadonlyArray<number>): number =>
  0.2126 * (rgb[0] ?? 0) + 0.7152 * (rgb[1] ?? 0) + 0.0722 * (rgb[2] ?? 0);

/** The hue angle of an R'G'B' colour, in degrees, from its opponent axes. */
const hue = (rgb: ReadonlyArray<number>): number => {
  const [r = 0, g = 0, b = 0] = rgb;

  return ((Math.atan2(Math.sqrt(3) * (g - b), 2 * r - g - b) * 180) / Math.PI + 360) % 360;
};

/**
 * Plays `fixture` on `path` for an SDR browser and checks what it serves: the summary names the
 * source's kind and a tone map on that path; the stream is tagged SDR BT.709 in limited range and
 * carries no HDR metadata, on the stream or its first picture; and its first picture keeps the
 * ramp's grays neutral, black black, every step of the ramp apart, and each bar's hue. With
 * `subtitled`, the boxes' subtitle is burned in, and its boxes keep their SDR levels.
 */
const plays = Effect.fn("HdrColour.plays")(function* (
  fixture: Fixture,
  path: "cpu" | "qsv" | "vaapi",
  subtitled: boolean,
) {
  const server = yield* MediaTestServer.Service;
  const fileId: MediaFileId = yield* added(fixture, subtitled);
  const token = signTestToken({ fid: fileId, sid: `hdr-${path}-${fixture.file}` });
  const local = (url: string) => url.replace(/^https?:\/\/[^/]+/u, server.baseUrl);
  const at = `${fixture.name}${subtitled ? " with a subtitle" : ""} on ${path}`;

  const negotiated = yield* HttpClient.execute(
    HttpClientRequest.post(`${server.baseUrl}/api/playback/negotiate`).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        token,
        capabilities: sdrBrowser,
        burnInSubtitle: subtitled ? "e2" : undefined,
      }),
    ),
  ).pipe(
    Effect.flatMap((response) => response.json),
    Effect.flatMap(decodeNegotiation),
    Effect.orDie,
  );

  const toneMap = negotiated.transcode?.stages.find((stage) => stage.op === "tonemap");

  assert.strictEqual(negotiated.transcode?.source, fixture.source, at);
  assert.strictEqual(negotiated.video.dynamicRange, "sdr", at);
  assert.isDefined(toneMap, `${at}: a tone map`);
  // libplacebo where the build has it, else the GPU's own; VA-API's own takes no HLG, which
  // carries no mastering display metadata, so its chain then maps on the CPU.
  assert.include(TONE_MAPS[path][fixture.kind], toneMap.impl, at);

  const served = yield* servedStart(local(negotiated.url));

  // Each answer holds a stream slot until it is stopped.
  yield* HttpClient.execute(
    HttpClientRequest.post(`${server.baseUrl}/api/playback/stop`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ token, streamId: negotiated.streamId }),
    ),
  ).pipe(Effect.orDie);

  const description = yield* described(served);

  assert.deepStrictEqual(description.tags, ["bt709", "bt709", "bt709"], at);
  assert.notStrictEqual(description.range, "pc", at);
  assert.deepStrictEqual(
    description.sideData.filter((type) => !SDR_SIDE_DATA.has(type)),
    [],
    `${at}: side data left on the SDR stream`,
  );

  const { ramp, bars } = yield* cells(served);

  for (const [index, rgb] of ramp.entries()) {
    assert.isBelow(
      Math.max(...rgb) - Math.min(...rgb),
      6,
      `${at}: gray ${String(RAMP[index])} neutral`,
    );
  }

  if (subtitled) {
    const [red = 0, green = 0, blue = 0] = bars[7] ?? [];

    assert.approximately(luma(ramp[0] ?? []), 128, 10, `${at}: the gray box keeps SDR's 128`);
    assert.approximately(red, 160, 12, `${at}: the yellow box keeps its red`);
    assert.approximately(green, 160, 12, `${at}: the yellow box keeps its green`);
    assert.isBelow(blue, 30, `${at}: the yellow box keeps no blue`);
  } else {
    assert.isBelow(luma(ramp[0] ?? []), 12, `${at}: black stays black`);
  }

  // The GPU's own tone map, which runs where libplacebo does not, crushes the lowest steps of the
  // ramp into black (see `video-ops-intel.ts`); every other holds them apart. Under a subtitle the
  // ramp's first cell is the gray box.
  const crushes = toneMap.impl === `tonemap.${path}`;

  for (const [index, rgb] of ramp.slice(1).entries()) {
    if ((crushes && (RAMP[index + 1] ?? 0) < 32) || (subtitled && index === 0)) continue;

    assert.isAbove(
      luma(rgb) - luma(ramp[index] ?? []),
      1.5,
      `${at}: gray ${String(RAMP[index + 1])} apart from gray ${String(RAMP[index])}`,
    );
  }

  for (const [index, rgb] of bars.slice(0, 7).entries()) {
    const want = hue(BARS[index] ?? []);
    const off = Math.abs(((hue(rgb) - want + 540) % 360) - 180);

    assert.isBelow(off, 20, `${at}: bar ${String(index)} keeps its hue (${hue(rgb).toFixed(0)}°)`);
  }
}, Effect.scoped);

describe.skipIf(!hasFfmpeg)("HDR to SDR", () => {
  layer(MediaTestServer.layer(TOOLS), { excludeTestServices: true, timeout: "180 seconds" })(
    (it) => {
      for (const fixture of FIXTURES) {
        it.effect(
          `serves ${fixture.name} as SDR BT.709 on the CPU`,
          () => plays(fixture, "cpu", false),
          120_000,
        );
      }

      for (const fixture of SUBTITLED) {
        it.effect(
          `burns a subtitle into ${fixture.name} in SDR on the CPU`,
          () => plays(fixture, "cpu", true),
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
            `serves ${fixture.name} as SDR BT.709 on ${path}`,
            () => plays(fixture, path, false),
            120_000,
          );
        }

        for (const fixture of SUBTITLED) {
          it.effect(
            `burns a subtitle into ${fixture.name} in SDR on ${path}`,
            () => plays(fixture, path, true),
            120_000,
          );
        }
      });
    });
  }
});
