import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { LibraryId, type MediaFileId } from "@media/contracts/ids";
import { type ClientCapabilities, NegotiateResponse } from "@media/contracts/media-playback";

import * as LibraryScanner from "../library/library-scanner.ts";
import * as MemoryLibrary from "../library/memory-library.ts";
import * as MediaTools from "../media/media-tools.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import { dolbyVisionBox, withSampleEntryBox } from "../testing/mp4-boxes.ts";
import { signTestToken } from "../testing/test-tokens.ts";

const hasFfmpeg = await ffmpegAvailable();

const TOOLS = {
  FFMPEG_PATH: process.env["FFMPEG_PATH"] ?? "ffmpeg",
  FFPROBE_PATH: process.env["FFPROBE_PATH"] ?? "ffprobe",
};

const SOURCES = LibraryId.make("dolby-vision");

const QUIET = ["-hide_banner", "-nostdin", "-v", "error", "-y"];

/** The base layers the fixtures are coded in: their transfer and libx265's options. */
const BASES = {
  hdr10: { transfer: "smpte2084", params: "log-level=error:hdr10=1" },
  hlg: { transfer: "arib-std-b67", params: "log-level=error" },
  sdr: { transfer: "bt709", params: "log-level=error" },
  ipt: { transfer: undefined, params: "log-level=error" },
} as const;

/**
 * A Dolby Vision fixture: a second of HEVC Main 10 in `base`'s colour, in MP4 with the configuration
 * record of `profile`, `compatibility` (`dolbyVisionBox`) and in Matroska copied from it, which no
 * client plays as stored. None has an RPU in its pictures, which no encoder here writes, so each
 * profile 8 fixture is its base layer alone; profile 8 with an RPU is decided in
 * `colour-decisions.test.ts` and played by the grid's fixtures.
 */
interface Fixture {
  readonly name: string;
  readonly base: keyof typeof BASES;
  readonly profile: number;
  readonly compatibility: number;
}

const FIXTURES = {
  dv7: { name: "dv7", base: "hdr10", profile: 7, compatibility: 6 },
  dv81: { name: "dv81", base: "hdr10", profile: 8, compatibility: 1 },
  dv82: { name: "dv82", base: "sdr", profile: 8, compatibility: 2 },
  dv84: { name: "dv84", base: "hlg", profile: 8, compatibility: 4 },
  dv5: { name: "dv5", base: "ipt", profile: 5, compatibility: 0 },
  dv5Hdr10: { name: "dv5-claims-hdr10", base: "ipt", profile: 5, compatibility: 1 },
  dv8BluRay: { name: "dv8-blu-ray-id", base: "hdr10", profile: 8, compatibility: 6 },
  hlgClaimsHdr10: { name: "dv84-claims-hdr10", base: "hlg", profile: 8, compatibility: 1 },
  pqClaimsSdr: { name: "dv81-claims-sdr", base: "hdr10", profile: 8, compatibility: 2 },
  iptClaims81: { name: "dv5-claims-81", base: "ipt", profile: 8, compatibility: 1 },
} as const satisfies Record<string, Fixture>;

/** An iPhone, as its app declares it: HEVC with HDR10, HLG, and Dolby Vision, MP4 and HLS. */
const iphone: ClientCapabilities = {
  containers: ["mp4", "mov"],
  videoCodecs: [
    { codec: "h264", maxLevel: 52, maxBitDepth: 8 },
    {
      codec: "hevc",
      profiles: ["Main", "Main 10"],
      maxBitDepth: 10,
      dynamicRanges: ["hdr10", "hlg", "dolby-vision"],
    },
  ],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 3840,
  maxHeight: 2160,
  hls: true,
  mse: false,
};

/** A browser on an HDR display: HEVC with HDR10 and HLG, no Dolby Vision. */
const hdrBrowser: ClientCapabilities = {
  containers: ["mp4"],
  videoCodecs: [
    { codec: "h264", maxBitDepth: 8 },
    { codec: "hevc", maxBitDepth: 10, dynamicRanges: ["hdr10", "hlg"] },
  ],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 3840,
  maxHeight: 2160,
  hls: false,
  mse: true,
};

/** Writes `fixture` in MP4 and Matroska in the sources library, once, and scans it. */
const added = Effect.fn("DolbyVisionCopies.added")(function* (fixture: Fixture) {
  const workspace = yield* FixtureWorkspace.Service;
  const tools = yield* MediaTools.Service;
  const scanner = yield* LibraryScanner.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(workspace.root, "dolby-vision");
  const mp4 = path.join(root, `${fixture.name}.mp4`);
  const base = BASES[fixture.base];

  if (!(yield* fs.exists(mp4))) {
    yield* fs.makeDirectory(root, { recursive: true });
    const plain = path.join(root, `${fixture.name}.plain.mp4`);

    yield* tools.ffmpeg([
      ...QUIET,
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x240:rate=24:duration=1",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=1",
      "-c:v",
      "libx265",
      "-preset",
      "ultrafast",
      "-vf",
      [
        ...(base.transfer === undefined
          ? []
          : [`setparams=color_primaries=bt2020:color_trc=${base.transfer}:colorspace=bt2020nc`]),
        "format=yuv420p10le",
      ].join(","),
      "-x265-params",
      base.params,
      "-tag:v",
      "hvc1",
      "-c:a",
      "aac",
      plain,
    ]);

    // Matroska takes the stream from an MP4 whose entry is still `hvc1`, which it accepts; profile
    // 5's MP4 then names its entry `dvh1`, as its files do.
    const recorded = path.join(root, `${fixture.name}.recorded.mp4`);
    const record = dolbyVisionBox(fixture.profile, 6, fixture.compatibility);
    const bytes = yield* fs.readFile(plain);

    yield* fs.writeFile(recorded, withSampleEntryBox(bytes, record));
    yield* tools.ffmpeg([
      ...QUIET,
      "-i",
      recorded,
      "-map",
      "0",
      "-c",
      "copy",
      "-strict",
      "unofficial",
      path.join(root, `${fixture.name}.mkv`),
    ]);
    yield* fs.writeFile(
      mp4,
      withSampleEntryBox(bytes, record, fixture.profile === 5 ? "dvh1" : undefined),
    );
    yield* fs.remove(plain);
    yield* fs.remove(recorded);
  }

  yield* scanner.scan({ libraryId: SOURCES, root, mode: "incremental" });

  return {
    mp4: MemoryLibrary.fileIdOf(SOURCES, `${fixture.name}.mp4`),
    mkv: MemoryLibrary.fileIdOf(SOURCES, `${fixture.name}.mkv`),
  };
}, Effect.orDie);

const Refusal = Schema.Struct({ reason: Schema.optionalKey(Schema.String) });

const decodeNegotiation = Schema.decodeUnknownEffect(Schema.toCodecJson(NegotiateResponse));

const fetched = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) => response.arrayBuffer),
    Effect.map((body) => new Uint8Array(body)),
    Effect.orDie,
  );

/** The boxes of a served init segment that say what it is: its sample entry and Dolby Vision record. */
const BOXES = ["hvc1", "hev1", "dvh1", "dvcC", "dvvC"] as const;

const Probed = Schema.fromJsonString(
  Schema.Struct({
    streams: Schema.Array(Schema.Struct({ color_transfer: Schema.optionalKey(Schema.String) })),
  }),
);

/**
 * What `file` gets for `client`: its mode, or the refusal's reason; for a stream, the dynamic range
 * the answer says it delivers, and the served init segment's boxes and the transfer its first
 * fragment states.
 */
const delivered = Effect.fn("DolbyVisionCopies.delivered")(function* (
  file: MediaFileId,
  client: ClientCapabilities,
  name: string,
) {
  const server = yield* MediaTestServer.Service;
  const tools = yield* MediaTools.Service;
  const fs = yield* FileSystem.FileSystem;
  const token = signTestToken({ fid: file, sid: name });
  const local = (url: string) => url.replace(/^https?:\/\/[^/]+/u, server.baseUrl);

  const response = yield* HttpClient.execute(
    HttpClientRequest.post(`${server.baseUrl}/api/playback/negotiate`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ token, capabilities: client }),
    ),
  ).pipe(Effect.orDie);

  const body = yield* response.json.pipe(Effect.orDie);

  if (response.status !== 200) {
    const reason = (yield* Schema.decodeUnknownEffect(Refusal)(body).pipe(Effect.orDie)).reason;

    return `refused ${reason ?? `${String(response.status)} ${JSON.stringify(body)}`}`;
  }

  const answer = yield* decodeNegotiation(body).pipe(Effect.orDie);

  if (answer.mode === "direct") return "direct";
  const playlist = new URL(local(answer.url));
  const text = new TextDecoder().decode(yield* fetched(playlist.href));

  const init = yield* fetched(
    new URL(/#EXT-X-MAP:URI="([^"]+)"/u.exec(text)?.[1] ?? "", playlist).href,
  );

  const first = text.split("\n").find((line) => line !== "" && !line.startsWith("#")) ?? "";
  const served = yield* fs.makeTempFileScoped({ suffix: ".mp4" });

  yield* fs.writeFile(served, Buffer.concat([init, yield* fetched(new URL(first, playlist).href)]));

  const probed = yield* tools
    .ffprobe([
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=color_transfer",
      "-of",
      "json",
      served,
    ])
    .pipe(Effect.flatMap(Schema.decodeEffect(Probed)), Effect.orDie);

  const boxes = BOXES.filter((kind) => Buffer.from(init).includes(Buffer.from(kind)));

  // Each answer holds a stream slot until it is stopped.
  yield* HttpClient.execute(
    HttpClientRequest.post(`${server.baseUrl}/api/playback/stop`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ token, streamId: answer.streamId }),
    ),
  ).pipe(Effect.orDie);

  return `${answer.mode} says ${answer.video.dynamicRange}, sends ${boxes.join("+")} ${probed.streams[0]?.color_transfer ?? "untagged"}`;
}, Effect.scoped);

/** How each file of `fixture` reaches the iPhone and the HDR browser. */
const ladder = Effect.fn("DolbyVisionCopies.ladder")(function* (fixture: Fixture) {
  const files = yield* added(fixture);

  return {
    "iphone mp4": yield* delivered(files.mp4, iphone, `${fixture.name}-iphone-mp4`),
    "iphone mkv": yield* delivered(files.mkv, iphone, `${fixture.name}-iphone-mkv`),
    "hdr browser mp4": yield* delivered(files.mp4, hdrBrowser, `${fixture.name}-hdr-mp4`),
    "hdr browser mkv": yield* delivered(files.mkv, hdrBrowser, `${fixture.name}-hdr-mkv`),
  };
});

const refused = "refused dolby-vision-not-convertible";

describe.skipIf(!hasFfmpeg)("Dolby Vision as each client receives it", () => {
  layer(MediaTestServer.layer(TOOLS), { excludeTestServices: true, timeout: "180 seconds" })(
    (it) => {
      it.effect(
        "copies profile 8 without an RPU as its base layer alone, never as stored, and says the base's range",
        () =>
          Effect.gen(function* () {
            for (const [fixture, base] of [
              [FIXTURES.dv81, "hdr10, sends hvc1 smpte2084"],
              [FIXTURES.dv84, "hlg, sends hvc1 arib-std-b67"],
              [FIXTURES.dv82, "sdr, sends hvc1 bt709"],
            ] as const) {
              const copy = `remux says ${base}`;

              assert.deepStrictEqual(
                yield* ladder(fixture),
                {
                  "iphone mp4": copy,
                  "iphone mkv": copy,
                  "hdr browser mp4": copy,
                  "hdr browser mkv": copy,
                },
                fixture.name,
              );
            }
          }),
        150_000,
      );

      it.effect(
        "never plays profile 7 as stored, and copies it as its HDR10 base layer alone",
        () =>
          Effect.gen(function* () {
            assert.deepStrictEqual(yield* ladder(FIXTURES.dv7), {
              "iphone mp4": "remux says hdr10, sends hvc1 smpte2084",
              "iphone mkv": "remux says hdr10, sends hvc1 smpte2084",
              "hdr browser mp4": "remux says hdr10, sends hvc1 smpte2084",
              "hdr browser mkv": "remux says hdr10, sends hvc1 smpte2084",
            });
          }),
        150_000,
      );

      it.effect(
        "refuses profile 5 without an RPU, and a record the table names no base layer for, everywhere",
        () =>
          Effect.gen(function* () {
            for (const fixture of [FIXTURES.dv5, FIXTURES.dv5Hdr10, FIXTURES.dv8BluRay]) {
              assert.deepStrictEqual(
                yield* ladder(fixture),
                {
                  "iphone mp4": refused,
                  "iphone mkv": refused,
                  "hdr browser mp4": refused,
                  "hdr browser mkv": refused,
                },
                fixture.name,
              );
            }
          }),
        150_000,
      );

      it.effect(
        "does not believe a record whose base layer the pictures' transfer contradicts or does not state",
        () =>
          Effect.gen(function* () {
            // HLG pictures whose record says HDR10, PQ pictures whose record says SDR, and IPT that
            // states no transfer with a record that says HDR10: without an RPU none can be shown.
            for (const fixture of [
              FIXTURES.hlgClaimsHdr10,
              FIXTURES.pqClaimsSdr,
              FIXTURES.iptClaims81,
            ]) {
              assert.deepStrictEqual(
                yield* ladder(fixture),
                {
                  "iphone mp4": refused,
                  "iphone mkv": refused,
                  "hdr browser mp4": refused,
                  "hdr browser mkv": refused,
                },
                fixture.name,
              );
            }
          }),
        150_000,
      );
    },
  );
});
