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
import { signTestToken } from "../testing/test-tokens.ts";

const hasFfmpeg = await ffmpegAvailable();

const hasQsv = hasFfmpeg && (await qsvUsable());

const hasVaapi = hasFfmpeg && (await vaapiUsable());

const TOOLS = {
  FFMPEG_PATH: process.env["FFMPEG_PATH"] ?? "ffmpeg",
  FFPROBE_PATH: process.env["FFPROBE_PATH"] ?? "ffprobe",
};

const SOURCES = LibraryId.make("hdr-keep");

const QUIET = ["-hide_banner", "-nostdin", "-v", "error", "-y"];

/** Colour cells across the top half, R'G'B' in full range, each 80 pixels wide. */
const CELLS = [
  [0, 0, 0],
  [64, 64, 64],
  [255, 255, 255],
  [224, 32, 32],
  [32, 200, 32],
  [32, 32, 224],
  [224, 200, 32],
  [224, 172, 140],
] as const;

const hex = (rgb: ReadonlyArray<number>): string =>
  `0x${rgb.map((value) => value.toString(16).padStart(2, "0")).join("")}`;

/** Eight cells over a moving band, so a scaled, re-encoded picture has both flat and busy parts. */
const PICTURE = [
  "testsrc2=s=640x360:r=24:d=6",
  "format=rgb24",
  ...CELLS.map(
    (rgb, index) => `drawbox=x=${String(index * 80)}:y=0:w=80:h=180:color=${hex(rgb)}:t=fill`,
  ),
].join(",");

/** One HDR source: the picture in HDR10 with its static metadata, or in HLG, by libx265. */
interface Fixture {
  readonly name: string;
  readonly file: string;
  readonly kind: "hdr10" | "hlg";
  readonly transfer: string;
  readonly graph: string;
  readonly params: string;
}

const FIXTURES: ReadonlyArray<Fixture> = [
  {
    name: "HDR10",
    file: "hdr10.mkv",
    kind: "hdr10",
    transfer: "smpte2084",
    graph: `${PICTURE},zscale=tin=bt709:pin=bt709:min=gbr:rin=full:t=smpte2084:p=bt2020:m=bt2020nc:r=tv:npl=100,format=yuv420p10le`,
    params:
      "log-level=error:keyint=48:hdr10=1:repeat-headers=1:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50):max-cll=1000,400",
  },
  {
    name: "HLG",
    file: "hlg.mkv",
    kind: "hlg",
    transfer: "arib-std-b67",
    graph: `${PICTURE},zscale=tin=bt709:pin=bt709:min=gbr:rin=full:t=arib-std-b67:p=bt2020:m=bt2020nc:r=tv:npl=1000,format=yuv420p10le`,
    params: "log-level=error:keyint=48",
  },
];

/** A screen that shows HDR10 and HLG, and plays HEVC Main 10 in them; H.264 too when `h264`. */
const hdrScreen = (h264: boolean): ClientCapabilities => ({
  containers: [],
  videoCodecs: [
    ...(h264 ? [{ codec: "h264" }] : []),
    {
      codec: "hevc",
      profiles: ["Main", "Main 10"],
      maxBitDepth: 10,
      dynamicRanges: ["hdr10", "hlg"],
    },
  ],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 1920,
  maxHeight: 1080,
  hls: true,
  mse: false,
  hdrScreen: ["hdr10", "hlg"],
});

/** The same device on an SDR screen. */
const sdrScreen = (h264: boolean): ClientCapabilities => ({
  containers: [],
  videoCodecs: hdrScreen(h264).videoCodecs,
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 1920,
  maxHeight: 1080,
  hls: true,
  mse: false,
});

/** The cap every stream here is played at, so each must encode: 640x360 to 480x270. */
const CAP = { maxHeight: 270 } as const;

/** Writes `fixture` in the sources library, once, scans it, and answers its file and path. */
const added = Effect.fn("HdrKeep.added")(function* (fixture: Fixture) {
  const workspace = yield* FixtureWorkspace.Service;
  const tools = yield* MediaTools.Service;
  const scanner = yield* LibraryScanner.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(workspace.root, "hdr-keep");
  const file = path.join(root, fixture.file);

  if (!(yield* fs.exists(file))) {
    yield* fs.makeDirectory(root, { recursive: true });

    yield* tools.ffmpeg([
      ...QUIET,
      "-f",
      "lavfi",
      "-i",
      fixture.graph,
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=6",
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
      file,
    ]);
  }

  yield* scanner.scan({ libraryId: SOURCES, root, mode: "incremental" });

  return { fileId: MemoryLibrary.fileIdOf(SOURCES, fixture.file), file };
}, Effect.orDie);

const decodeNegotiation = Schema.decodeUnknownEffect(Schema.toCodecJson(NegotiateResponse));

const fetched = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) => response.arrayBuffer),
    Effect.map((body) => new Uint8Array(body)),
    Effect.orDie,
  );

const text = (url: string) =>
  fetched(url).pipe(Effect.map((body) => new TextDecoder().decode(body)));

/** The `EXT-X-STREAM-INF` attributes of a multivariant playlist, and its variant's URI. */
const streamInf = (playlist: string) => {
  const lines = playlist.split("\n");
  const at = lines.findIndex((line) => line.startsWith("#EXT-X-STREAM-INF:"));
  const attributes = new Map<string, string>();

  for (const match of (lines[at] ?? "").matchAll(/([A-Z-]+)=("[^"]*"|[^,]*)/gu)) {
    attributes.set(match[1] ?? "", (match[2] ?? "").replaceAll('"', ""));
  }

  return { attributes, uri: lines[at + 1] ?? "" };
};

/**
 * The codec string of the HEVC stream whose sample entry `init` holds, from its `hvcC` box
 * (ISO/IEC 14496-15, E.3): profile, compatibility flags in reverse bit order, tier and level, then
 * the constraint flags without trailing zero bytes.
 */
const hvcCodecString = (init: Uint8Array): string => {
  const at = Buffer.from(init).indexOf("hvcC") + 4;
  const profile = init[at + 1] ?? 0;
  const compatibility = Buffer.from(init).readUInt32BE(at + 2);
  let reversed = 0;

  for (let bit = 0; bit < 32; bit += 1) {
    if ((compatibility & (1 << bit)) !== 0) reversed |= 1 << (31 - bit);
  }

  const constraints = [...init.subarray(at + 6, at + 12)].map((byte) =>
    byte.toString(16).toUpperCase(),
  );

  while (constraints.at(-1) === "0") constraints.pop();

  return [
    "hvc1",
    String(profile & 31),
    (reversed >>> 0).toString(16).toUpperCase(),
    `${(profile & 32) === 0 ? "L" : "H"}${String(init[at + 12] ?? 0)}`,
    ...constraints,
  ].join(".");
};

const Described = Schema.fromJsonString(
  Schema.Struct({
    streams: Schema.Array(
      Schema.Struct({
        codec_name: Schema.optionalKey(Schema.String),
        profile: Schema.optionalKey(Schema.String),
        pix_fmt: Schema.optionalKey(Schema.String),
        color_transfer: Schema.optionalKey(Schema.String),
        color_primaries: Schema.optionalKey(Schema.String),
        color_space: Schema.optionalKey(Schema.String),
        color_range: Schema.optionalKey(Schema.String),
      }),
    ),
    frames: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          side_data_list: Schema.optionalKey(
            Schema.Array(
              Schema.Struct({
                side_data_type: Schema.optionalKey(Schema.String),
                max_luminance: Schema.optionalKey(Schema.String),
                min_luminance: Schema.optionalKey(Schema.String),
                green_x: Schema.optionalKey(Schema.String),
                max_content: Schema.optionalKey(Schema.Finite),
                max_average: Schema.optionalKey(Schema.Finite),
              }),
            ),
          ),
        }),
      ),
    ),
  }),
);

/** `file`'s video: codec, profile, layout, colour tags, and its first picture's side data. */
const described = Effect.fn("HdrKeep.described")(function* (file: string) {
  const tools = yield* MediaTools.Service;

  const output = yield* tools.ffprobe([
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-read_intervals",
    "%+#1",
    "-show_entries",
    "stream=codec_name,profile,pix_fmt,color_transfer,color_primaries,color_space,color_range:frame_side_data=side_data_type,green_x,max_luminance,min_luminance,max_content,max_average",
    "-of",
    "json",
    file,
  ]);

  const parsed = yield* Schema.decodeEffect(Described)(output);
  const [stream] = parsed.streams;
  const sideData = parsed.frames?.[0]?.side_data_list ?? [];

  return {
    format: [stream?.codec_name, stream?.profile, stream?.pix_fmt],
    tags: [
      stream?.color_transfer,
      stream?.color_primaries,
      stream?.color_space,
      stream?.color_range,
    ],
    mastering: sideData
      .filter((item) => item.side_data_type === "Mastering display metadata")
      .map((item) => [item.green_x, item.max_luminance, item.min_luminance]),
    light: sideData
      .filter((item) => item.side_data_type === "Content light level metadata")
      .map((item) => [item.max_content, item.max_average]),
    dynamic: sideData
      .map((item) => item.side_data_type ?? "")
      .filter((type) => /2094|dolby|dovi/iu.test(type)),
  };
}, Effect.orDie);

/** The mean 10-bit Y, Cb, and Cr of the middle of each cell of `file`'s first picture at 480x270. */
const cellCodes = Effect.fn("HdrKeep.cellCodes")(
  function* (file: string) {
    const tools = yield* MediaTools.Service;
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.makeTempFileScoped({ suffix: ".yuv" });

    yield* tools.ffmpeg([
      ...QUIET,
      "-i",
      file,
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      "-vf",
      "scale=480:270:flags=bicubic,format=yuv420p10le",
      "-f",
      "rawvideo",
      raw,
    ]);

    const bytes = yield* fs.readFile(raw);
    const samples = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    const chroma = 480 * 270;

    const mean = (plane: number, width: number, x0: number, x1: number, y0: number, y1: number) => {
      let sum = 0;

      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) sum += samples[plane + y * width + x] ?? 0;
      }

      return sum / ((x1 - x0) * (y1 - y0));
    };

    // Each 80x180 cell is 60x135 at 480x270; its middle third stays clear of the edges' blur.
    return CELLS.map((_, index) => {
      const x0 = index * 60 + 20;
      const y0 = 45;

      return [
        mean(0, 480, x0, x0 + 20, y0, y0 + 45),
        mean(chroma, 240, x0 / 2, x0 / 2 + 10, y0 / 2, y0 / 2 + 22),
        mean(chroma + chroma / 4, 240, x0 / 2, x0 / 2 + 10, y0 / 2, y0 / 2 + 22),
      ];
    });
  },
  Effect.scoped,
  Effect.orDie,
);

/**
 * Plays `fixture` on `path` for a device whose screen shows its HDR, capped so it must encode, and
 * checks what it serves: HEVC Main 10 in the source's range, with no tone map and no reason for
 * SDR; a multivariant playlist whose one variant states the range, the codec string the init
 * segment's `hvcC` gives with the audio's, the picture, and the frame rate; and bytes tagged with
 * the source's transfer, BT.2020, and limited range, carrying the source's static metadata (HDR10)
 * and no dynamic metadata, whose cells match the source scaled the same way within 4 codes of 1023.
 * The same device on an SDR screen gets the media playlist alone and SDR.
 */
const keeps = Effect.fn("HdrKeep.keeps")(function* (
  fixture: Fixture,
  path: "cpu" | "qsv" | "vaapi",
) {
  const server = yield* MediaTestServer.Service;
  const { fileId, file }: { fileId: MediaFileId; file: string } = yield* added(fixture);
  const local = (url: string) => url.replace(/^https?:\/\/[^/]+/u, server.baseUrl);
  const at = `${fixture.name} on ${path}`;
  const fs = yield* FileSystem.FileSystem;
  // The CPU encodes HEVC only for a device without H.264.
  const h264 = path !== "cpu";

  // One playback session per path: each negotiation replaces the stream the one before started.
  const negotiate = (capabilities: ClientCapabilities) =>
    HttpClient.execute(
      HttpClientRequest.post(`${server.baseUrl}/api/playback/negotiate`).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          token: signTestToken({ fid: fileId, sid: `hdr-keep-${path}` }),
          capabilities,
          quality: CAP,
        }),
      ),
    ).pipe(
      Effect.flatMap((response) => response.json),
      Effect.flatMap(decodeNegotiation),
      Effect.orDie,
    );

  const negotiated = yield* negotiate(hdrScreen(h264));

  assert.deepStrictEqual(
    negotiated.video,
    { codec: "hevc", width: 480, height: 270, dynamicRange: fixture.kind },
    at,
  );
  assert.strictEqual(negotiated.transcode?.source, fixture.kind, at);
  assert.isUndefined(negotiated.transcode?.sdrReason, at);
  assert.deepStrictEqual(
    negotiated.transcode?.stages
      .filter((stage) => stage.op === "tonemap" || stage.op === "encode")
      .map((stage) => stage.impl),
    [`encode.${path}.hevc`],
    at,
  );

  const index = new URL(local(negotiated.url));
  const multivariant = yield* text(index.href);
  const { attributes, uri } = streamInf(multivariant);
  const media = new URL(uri, index);

  assert.isTrue(media.pathname.endsWith("/video.m3u8"), `${at}: ${multivariant}`);
  const playlist = yield* text(media.href);
  const init = /#EXT-X-MAP:URI="([^"]+)"/u.exec(playlist)?.[1] ?? "";
  const first = playlist.split("\n").find((line) => line !== "" && !line.startsWith("#")) ?? "";
  const initBytes = yield* fetched(new URL(init, media).href);

  assert.strictEqual(attributes.get("VIDEO-RANGE"), fixture.kind === "hdr10" ? "PQ" : "HLG", at);
  assert.strictEqual(attributes.get("CODECS"), `${hvcCodecString(initBytes)},mp4a.40.2`, at);
  assert.match(attributes.get("CODECS") ?? "", /^hvc1\.2\.4\.L\d+\./u, at);
  assert.strictEqual(attributes.get("RESOLUTION"), "480x270", at);
  assert.strictEqual(attributes.get("FRAME-RATE"), "24.000", at);

  const served = yield* fs.makeTempFileScoped({ suffix: ".mp4" });

  yield* fs.writeFile(
    served,
    Buffer.concat([initBytes, yield* fetched(new URL(first, media).href)]),
  );

  const output = yield* described(served);
  const source = yield* described(file);

  assert.deepStrictEqual(output.format, ["hevc", "Main 10", "yuv420p10le"], at);
  assert.deepStrictEqual(output.tags, [fixture.transfer, "bt2020", "bt2020nc", "tv"], at);
  assert.deepStrictEqual(output.mastering, source.mastering, `${at}: mastering display`);
  assert.deepStrictEqual(output.light, source.light, `${at}: content light level`);
  assert.lengthOf(output.mastering, fixture.kind === "hdr10" ? 1 : 0, at);
  assert.deepStrictEqual(output.dynamic, [], `${at}: dynamic metadata`);

  const want = yield* cellCodes(file);
  const got = yield* cellCodes(served);

  for (const [cell, codes] of got.entries()) {
    for (const [channel, code] of codes.entries()) {
      assert.isBelow(
        Math.abs(code - (want[cell]?.[channel] ?? 0)),
        4,
        `${at}: cell ${String(cell)} channel ${String(channel)} kept (${code.toFixed(1)} for ${String(want[cell]?.[channel]?.toFixed(1))})`,
      );
    }
  }

  const toSdr = yield* negotiate(sdrScreen(h264));
  const sdrPlaylist = yield* text(local(toSdr.url));

  assert.strictEqual(toSdr.video.dynamicRange, "sdr", at);
  assert.isTrue(
    sdrPlaylist.startsWith("#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:"),
    `${at}: an SDR stream's playlist is its media playlist`,
  );
  assert.notInclude(sdrPlaylist, "EXT-X-STREAM-INF", at);
}, Effect.scoped);

describe.skipIf(!hasFfmpeg)("HDR kept on a re-encode", () => {
  layer(MediaTestServer.layer(TOOLS), { excludeTestServices: true, timeout: "180 seconds" })(
    (it) => {
      for (const fixture of FIXTURES) {
        it.effect(
          `serves ${fixture.name} as HEVC Main 10 ${fixture.name} on the CPU`,
          () => keeps(fixture, "cpu"),
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
            `serves ${fixture.name} as HEVC Main 10 ${fixture.name} on ${path}`,
            () => keeps(fixture, path),
            120_000,
          );
        }
      });
    });
  }
});
