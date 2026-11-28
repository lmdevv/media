import { createServer } from "node:http";
import { join, sep } from "node:path";
import { deflateSync } from "node:zlib";

import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { serverFunctions } from "@media/contracts/server-functions";
import type { SessionStatus } from "@media/contracts/server-functions";
import { artworkTicketId, loadTicketKeyRing } from "@media/contracts/ticket";
import { TICKET_TEST_KEYS } from "@media/contracts/ticket-vectors";
import { EpochMillis } from "@media/contracts/units";
import {
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import { FetchHttpClient, HttpServer } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as ArtworkStore from "../artwork/artwork-store.ts";
import * as CachePruner from "../cache-pruner.ts";
import * as CoreTickets from "../core/core-tickets.ts";
import { serve } from "../http/http-server.ts";
import * as MediaTools from "../media/media-tools.ts";
import * as StreamOwners from "../playback/stream-owners.ts";
import { makeFakeCore, stream } from "../testing/fake-core.ts";
import { testConfigLayer } from "../testing/test-config.ts";
import { testArtworkKeysLayer } from "../testing/test-tokens.ts";
import { saveArt } from "./art-store.ts";
import * as Files from "./music-files.ts";
import * as MusicRoutes from "./music-routes.ts";
import {
  adobeSegment,
  areaScale,
  beforeJpegEnd,
  beforePngEnd,
  beforeSecondScan,
  iccSegment,
  jpegSegment,
  decodeRgba,
  exifOrientation,
  fidelity,
  jpegComponents,
  jpegProfile,
  orient,
  pngChunk,
  pngChunkTypes,
  SRGB_CHUNKS,
  withChunks,
  withSegment,
} from "./testing/cover-images.ts";
import { makeDirectory, PNG, removeDirectory, writeBytes } from "./testing/music-fixtures.ts";
import { ffmpeg, ffprobe, writeScript } from "./testing/music-songs.ts";
import * as TrackSources from "./track-sources.ts";
import * as MusicTranscoder from "./transcoder.ts";

const COVERS = join(import.meta.dirname, "..", "testing", "fixtures", "covers");

/**
 * The least PSNR, in dB, of a copy against the original shrunk by area averaging, over white and
 * over black, and of its alpha. Every copy here scores 34 or more on ffmpeg 7.1 and 9.0; a copy of
 * `photo.jpg` turned or mirrored the wrong way scores 14 to 16, with red and green swapped 17, and
 * `soft-alpha.png` turned the wrong way 25 to 27, or without its transparency 2.
 */
const FAITHFUL_DB = 30;

let work = "";

let baseUrl = "";

let scopes: Array<Scope.Closeable> = [];

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

/** A shareable ticket for the artwork with hash `hash`, as the music commands sign it. */
const artTicket = async (hash: string) => {
  const ring = await loadTicketKeyRing(TICKET_TEST_KEYS.k1);

  if (!ring.ok) throw new Error("The test keys are unusable");

  return (
    await ring.value.issueShareable({
      resource: { kind: "artwork", id: await artworkTicketId(hash) },
      now: Date.now(),
    })
  ).ticket;
};

/** How a test server differs from the default one. */
interface ServerOptions {
  /** Its ffmpeg, when not this test's (`FFMPEG_PATH`, so the suite runs on the image's and CI's). */
  readonly ffmpegPath?: string;
  /** Its file system, built from the real one. */
  readonly fileSystem?: (real: FileSystem.FileSystem) => FileSystem.FileSystem;
}

/** A media server with the music routes, keeping its files in `data`. */
const startServer = async (data: string, options: ServerOptions = {}) => {
  const ffmpegPath = options.ffmpegPath ?? process.env["FFMPEG_PATH"] ?? "ffmpeg";
  const fileSystem = options.fileSystem;
  const scope = await run(Scope.make());

  scopes = [...scopes, scope];

  const status = await run(
    SubscriptionRef.make<SessionStatus>({
      state: "live",
      endsAt: EpochMillis.make(Date.now() + 60 * 60 * 1000),
      guest: false,
    }),
  );

  const fake = await run(
    makeFakeCore([stream(serverFunctions.sessionStatus, () => SubscriptionRef.changes(status))]),
  );

  const config = testConfigLayer({
    DATA_DIR: data,
    LIBRARY_ROOTS: join(work, "library"),
    FFMPEG_PATH: ffmpegPath,
    FFPROBE_PATH: process.env["FFPROBE_PATH"] ?? "ffprobe",
  });

  // The routes' own file system, so a stand-in reaches the files they answer with.
  const routes =
    fileSystem === undefined
      ? MusicRoutes.layer
      : MusicRoutes.layer.pipe(
          Layer.provide(
            Layer.effect(
              FileSystem.FileSystem,
              Effect.gen(function* () {
                return fileSystem(yield* FileSystem.FileSystem);
              }),
            ),
          ),
        );

  const http = serve(routes).pipe(
    Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })),
    Layer.provideMerge(
      CoreTickets.layer({
        ticketKeys: Redacted.make(TICKET_TEST_KEYS.k1),
        idle: Duration.seconds(30),
      }).pipe(Layer.provide(fake.layer), Layer.provide(StreamOwners.layer)),
    ),
    Layer.provide(
      Layer.succeed(
        TrackSources.Service,
        TrackSources.Service.of({
          resolve: () => Effect.succeedNone,
          forget: () => Effect.void,
        }),
      ),
    ),
    Layer.provide(
      ArtworkStore.layer.pipe(
        Layer.provide([testArtworkKeysLayer, MediaTools.layer, FetchHttpClient.layer]),
      ),
    ),
    Layer.provide(MusicTranscoder.layer.pipe(Layer.provide([MediaTools.layer, CachePruner.layer]))),
    Layer.provide(config),
    Layer.provide(NodeServices.layer),
  );

  const built = await run(Layer.buildWithScope(http, scope));

  return run(
    HttpServer.addressFormattedWith((url) => Effect.succeed(url)).pipe(
      Effect.provideContext(built),
    ),
  );
};

/** Writes `bytes` to a file of its own named `name` and answers its path. */
const coverFile = async (name: string, bytes: Uint8Array) => {
  const file = join(work, name);

  await writeBytes(file, bytes);

  return file;
};

/**
 * What the art route of the server at `server` answers at `?w=width` for the cover in `file`, which
 * it stores first as the scanner does.
 */
const serveArt = async (
  file: string,
  width: string,
  server = baseUrl,
  data = join(work, "data"),
) => {
  const original = await run(Files.readWholeFile(file));
  const hash = await run(saveArt(data, original).pipe(Effect.map(Option.getOrThrow)));

  const response = await fetch(
    `${server}/music/art/${hash}?ticket=${await artTicket(hash)}&w=${width}`,
  );

  const bytes = new Uint8Array(await response.arrayBuffer());
  const copy = await coverFile(`copy-${hash}-${width}`, bytes);

  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    cacheControl: response.headers.get("cache-control"),
    original,
    bytes,
    copy,
    isOriginal: Buffer.from(bytes).equals(Buffer.from(original)),
  };
};

/**
 * A stand-in ffmpeg named `name` that logs each run, waits `seconds`, and then runs this test's
 * ffmpeg, or exits with `exit`, or is killed; `runs` counts its runs so far.
 */
const countingFfmpeg = async (
  name: string,
  options: { seconds?: number; exit?: number | "killed" } = {},
) => {
  const log = join(work, `${name}.log`);
  const script = join(work, `${name}.sh`);
  const real = process.env["FFMPEG_PATH"] ?? "ffmpeg";

  await writeBytes(log, "");
  await writeScript(script, [
    `echo run >> '${log}'`,
    options.seconds === undefined ? "" : `sleep ${String(options.seconds)}`,
    options.exit === undefined
      ? `exec '${real}' "$@"`
      : options.exit === "killed"
        ? "kill -9 $$"
        : `exit ${String(options.exit)}`,
  ]);

  const runs = async () =>
    Buffer.from(await run(Files.readWholeFile(log)))
      .toString("latin1")
      .split("\n")
      .filter((line) => line === "run").length;

  return { path: script, runs };
};

/** The sizes of the files in `folder`, none when it is missing. */
const sizesIn = async (folder: string) =>
  run(
    Files.listFiles(folder).pipe(
      Effect.flatMap((files) =>
        Effect.forEach(files, (file) =>
          Files.statPath(file.path).pipe(Effect.map(({ size }) => size)),
        ),
      ),
      Effect.orElseSucceed(() => []),
    ),
  );

/** True for the path of a resized music cover. */
const isCopy = (path: string) => path.includes(`${sep}artwork${sep}s`);

/** `width,height` of the image in `file`, as stored. */
const sizeOf = async (file: string) =>
  (
    await ffprobe(["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", file])
  ).trim();

/**
 * `width,height` of the copy the art route serves at `?w=width` of a test pattern `size` big, saved
 * at the highest quality so a smaller copy takes fewer bytes.
 */
const servedArtSize = async (size: string, width: string) => {
  const original = join(work, `pattern-${size}.jpg`);

  await ffmpeg(
    ["-f", "lavfi", "-i", `testsrc=size=${size}`, "-frames:v", "1", "-q:v", "1"].concat(original),
  );

  return sizeOf((await serveArt(original, width)).copy);
};

/**
 * Expects the art route to serve a copy of the cover in `file` at `width` in `contentType` that
 * shows the original shrunk by area averaging, turned upright by `orientation`, within
 * `FAITHFUL_DB`.
 */
const expectFaithfulCopy = async (
  file: string,
  width: string,
  contentType: string,
  orientation = 1,
) => {
  const served = await serveArt(file, width);

  expect([file, width, served.status, served.contentType, served.isOriginal]).toEqual([
    file,
    width,
    200,
    contentType,
    false,
  ]);
  expect(served.bytes.length).toBeLessThan(served.original.length);
  const copy = await decodeRgba(served.copy);
  const shown = orient(await decodeRgba(file, true), orientation);

  // The shorter side is the asked size and the longer side keeps the cover's shape.
  expect(Math.min(copy.width, copy.height)).toBe(
    Math.min(Number(width), shown.width, shown.height),
  );
  expect(copy.width / copy.height).toBeCloseTo(shown.width / shown.height, 1);
  const scores = fidelity(copy, areaScale(shown, copy.width, copy.height));

  expect(
    Math.min(scores.white, scores.black, scores.alpha),
    `${file} at ${width}`,
  ).toBeGreaterThanOrEqual(FAITHFUL_DB);

  return served;
};

/** Expects the art route to serve the cover in `file`, asked at `width`, exactly as stored. */
const expectOriginal = async (file: string, width = "144", server = baseUrl) => {
  const served = await serveArt(file, width, server);

  expect([file, served.status, served.isOriginal]).toEqual([file, 200, true]);

  return served;
};

/** `width,height` of the image a response holds, written to a file named `name`. */
const responseSize = async (response: Response, name: string) =>
  sizeOf(await coverFile(name, new Uint8Array(await response.arrayBuffer())));

/** Makes a cover with ffmpeg `args` into a file named `name`, and answers its path. */
const madeWith = (name: string, args: ReadonlyArray<string>) => async () => {
  const file = join(work, name);

  await ffmpeg(["-v", "error", ...args, file]);

  return file;
};

/** Writes `bytes` to a cover file named `name`, and answers its path. */
const splicedAs = (name: string, bytes: Uint8Array) => () => coverFile(name, bytes);

/** The fixture cover named `name`. */
const fixture = (name: string) => () => Promise.resolve(join(COVERS, name));

/**
 * Stand-ins for a prune landing after the art route chose a copy: one removes the copy before the
 * route opens it, one right after.
 */
const removeBefore = (real: FileSystem.FileSystem): FileSystem.FileSystem => ({
  ...real,
  open: (path, options) =>
    isCopy(path)
      ? real.remove(path).pipe(Effect.ignore, Effect.andThen(real.open(path, options)))
      : real.open(path, options),
  stream: (path, options) =>
    isCopy(path)
      ? Stream.unwrap(real.remove(path).pipe(Effect.ignore, Effect.as(real.stream(path, options))))
      : real.stream(path, options),
});

const removeAfter = (real: FileSystem.FileSystem): FileSystem.FileSystem => ({
  ...real,
  open: (path, options) =>
    isCopy(path)
      ? real.open(path, options).pipe(Effect.tap(() => real.remove(path).pipe(Effect.ignore)))
      : real.open(path, options),
  stream: (path, options) =>
    isCopy(path)
      ? Stream.unwrap(real.remove(path).pipe(Effect.ignore, Effect.as(real.stream(path, options))))
      : real.stream(path, options),
});

/**
 * A stand-in that counts the stored covers the art route opens, which it does only to tell a
 * cover's kind, and the most it holds open at once.
 */
const countingOpens = () => {
  const counts = { opened: 0, open: 0, most: 0 };

  const opening = Effect.acquireRelease(
    Effect.sync(() => {
      counts.opened += 1;
      counts.open += 1;
      counts.most = Math.max(counts.most, counts.open);
    }),
    () =>
      Effect.sync(() => {
        counts.open -= 1;
      }),
  );

  const fileSystem = (real: FileSystem.FileSystem): FileSystem.FileSystem => ({
    ...real,
    open: (path, options) =>
      isCopy(path) ? real.open(path, options) : Effect.andThen(opening, real.open(path, options)),
  });

  return { fileSystem, counts };
};

/** What the art route answers for `url`, and when its headers came, from `started`. */
const fetchArt = async (url: string, original: Uint8Array, started: number) => {
  const response = await fetch(url);
  const answeredMs = performance.now() - started;
  const bytes = new Uint8Array(await response.arrayBuffer());

  return {
    status: response.status,
    cacheControl: response.headers.get("cache-control"),
    isOriginal: Buffer.from(bytes).equals(Buffer.from(original)),
    answeredMs,
  };
};

beforeAll(async () => {
  work = await makeDirectory("cover-art");
  baseUrl = await startServer(join(work, "data"));
}, 60_000);

afterAll(async () => {
  await Promise.all(scopes.map((scope) => run(Scope.close(scope, Exit.void))));
  await removeDirectory(work);
});

describe("music cover art", { timeout: 120_000 }, () => {
  it("serves a cover resized to a size music draws covers at, with ranges, and refuses other sizes", async () => {
    const original = join(work, "cover.jpg");

    await ffmpeg(
      ["-f", "lavfi", "-i", "testsrc=size=600x600", "-frames:v", "1", "-q:v", "1"].concat(original),
    );
    const bytes = await run(Files.readWholeFile(original));
    const hash = await run(saveArt(join(work, "data"), bytes).pipe(Effect.map(Option.getOrThrow)));
    const ticket = await artTicket(hash);

    const sized = (width: string, query = `ticket=${ticket}`) =>
      `${baseUrl}/music/art/${hash}?${query}&w=${width}`;

    // A 48-point row on a 3x phone draws 144 pixels, and gets a copy of exactly that.
    const row = await fetch(sized("144"));

    expect(row.status).toBe(200);
    expect(row.headers.get("content-type")).toBe("image/jpeg");
    expect(row.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const length = Number(row.headers.get("content-length"));

    expect(length).toBeLessThan(bytes.length);
    expect(await responseSize(row, "row.jpg")).toBe("144,144");

    // A copy the cache pruner removed is made again on the next request.
    await removeDirectory(join(work, "data", "artwork", "s144"));
    expect(await responseSize(await fetch(sized("144")), "again.jpg")).toBe("144,144");

    const head = await fetch(sized("144"), { method: "HEAD" });

    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(length));

    const part = await fetch(sized("144"), { headers: { range: "bytes=0-9" } });

    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 0-9/${String(length)}`);
    await part.arrayBuffer();

    const refused = await fetch(sized("145"));

    expect([refused.status, await refused.text()]).toEqual([400, "Invalid width"]);
    expect((await fetch(sized("144", "ticket=nope"))).status).toBe(401);
    const missing = "f".repeat(64);

    expect(
      (await fetch(`${baseUrl}/music/art/${missing}?ticket=${await artTicket(missing)}&w=144`))
        .status,
    ).toBe(404);
  });

  it("resizes a cover that is not square by its shorter side, and never enlarges one", async () => {
    // A cover is drawn as a square crop, so the crop of each copy needs the asked size each way.
    expect(
      await Promise.all([
        servedArtSize("1200x600", "144"),
        servedArtSize("600x1200", "144"),
        servedArtSize("1201x599", "336"),
        servedArtSize("1600x1600", "504"),
      ]),
    ).toEqual(["288,144", "144,288", "674,336", "504,504"]);
  });

  it("never serves a cover larger, either way or in bytes, than it is stored", async () => {
    const sizes = ["1x1", "3x1", "1x3", "101x101", "640x480", "3000x100"];
    const widths = ["144", "96", "96", "144", "1280", "144"];

    expect(
      await Promise.all(sizes.map((size, index) => servedArtSize(size, widths[index] ?? ""))),
    ).toEqual(sizes.map((size) => size.replace("x", ",")));

    // The smallest PNG: any copy of it takes more bytes.
    await expectOriginal(await coverFile("one-pixel.png", PNG));

    // A JPEG saved at low quality: the copy, at the route's quality, would take more bytes.
    const coarse = join(work, "coarse.jpg");

    await ffmpeg(
      ["-f", "lavfi", "-i", "testsrc2=size=1600x1600", "-frames:v", "1", "-q:v", "31"].concat(
        coarse,
      ),
    );
    await expectOriginal(coarse, "1280");
  });

  it("copies an 8-bit YCbCr JPEG without a profile, baseline or progressive, so it looks the same", async () => {
    const photo = join(COVERS, "photo.jpg");

    const adobe = await coverFile(
      "adobe-ycbcr.jpg",
      withSegment(await run(Files.readWholeFile(photo)), 0xee, adobeSegment(1)),
    );

    // Saturated colour bars and text, coded 4:2:0: a 4:2:0 copy of it scores under 29 dB.
    const colourful = join(work, "colourful.jpg");

    await ffmpeg(
      ["-f", "lavfi", "-i", "testsrc2=size=1600x1600", "-frames:v", "1", "-q:v", "2"].concat(
        "-pix_fmt",
        "yuvj420p",
        colourful,
      ),
    );

    const files = [photo, join(COVERS, "progressive.jpg"), adobe, colourful];

    const served = await Promise.all(
      files.flatMap((file) =>
        ["96", "144"].map((width) => expectFaithfulCopy(file, width, "image/jpeg")),
      ),
    );

    expect(served.map(({ bytes }) => [jpegComponents(bytes), jpegProfile(bytes).length])).toEqual(
      served.map(() => [3, 0]),
    );
  });

  it("copies a JPEG with an RGB profile, carrying the profile byte for byte", async () => {
    // `profiled.jpg` carries a profile that swaps red and green: a copy without it shows them swapped.
    const served = await Promise.all(
      [join(COVERS, "adobe-rgb.jpg"), join(COVERS, "profiled.jpg")].map((file) =>
        expectFaithfulCopy(file, "144", "image/jpeg"),
      ),
    );

    // The copy holds the same values in the same three components under the same profile, so a
    // colour-managed renderer turns both into the same colours.
    for (const { bytes, original } of served) {
      expect(jpegComponents(bytes)).toBe(jpegComponents(original));
      expect(jpegProfile(original).length).toBeGreaterThan(0);
      expect(jpegProfile(bytes)).toEqual(jpegProfile(original));
    }
  });

  it("copies a JPEG with an EXIF orientation turned upright, its pixels as shown", async () => {
    const photo = await run(Files.readWholeFile(join(COVERS, "photo.jpg")));
    const profiled = await run(Files.readWholeFile(join(COVERS, "adobe-rgb.jpg")));

    await Promise.all(
      [2, 3, 4, 5, 6, 7, 8].map(async (orientation) =>
        expectFaithfulCopy(
          await coverFile(
            `oriented-${String(orientation)}.jpg`,
            withSegment(photo, 0xe1, exifOrientation(orientation)),
          ),
          "144",
          "image/jpeg",
          orientation,
        ),
      ),
    );

    const both = await coverFile(
      "oriented-profiled.jpg",
      withSegment(profiled, 0xe1, exifOrientation(6)),
    );

    const served = await expectFaithfulCopy(both, "96", "image/jpeg", 6);

    expect(jpegProfile(served.bytes)).toEqual(jpegProfile(served.original));
    // A cover stored rotated: 240x320 shown 320x240.
    expect(
      await sizeOf(
        (await expectFaithfulCopy(join(COVERS, "rotated.jpg"), "144", "image/jpeg", 6)).copy,
      ),
    ).toBe("192,144");
  });

  it("copies an 8-bit RGBA PNG, untagged or sRGB, as a PNG that keeps its transparency", async () => {
    const soft = join(COVERS, "soft-alpha.png");

    const tagged = await coverFile(
      "soft-alpha-srgb.png",
      withChunks(await run(Files.readWholeFile(soft)), SRGB_CHUNKS),
    );

    const [, , served] = await Promise.all([
      expectFaithfulCopy(soft, "96", "image/png"),
      expectFaithfulCopy(soft, "144", "image/png"),
      expectFaithfulCopy(tagged, "144", "image/png"),
    ]);

    // The copy says sRGB as its original does.
    expect(pngChunkTypes(served.bytes)).toEqual(expect.arrayContaining(["sRGB"]));

    // A lime disc on magenta that is fully transparent: the magenta never bleeds into the disc.
    const disc = await serveArt(join(COVERS, "transparent.png"), "144");
    const { data } = await decodeRgba(disc.copy);

    expect([disc.contentType, data[3]]).toEqual(["image/png", 0]);

    const bled = Array.from({ length: data.length / 4 }, (_, pixel) => pixel * 4).filter(
      (at) => (data[at + 3] ?? 0) > 32 && (data[at] ?? 0) - (data[at + 1] ?? 0) > 24,
    );

    expect(bled).toEqual([]);
  });

  it("copies an 8-bit RGB PNG, untagged or sRGB, as a JPEG that looks the same", async () => {
    const photo = join(COVERS, "photo.png");

    const tagged = await coverFile(
      "photo-srgb.png",
      withChunks(await run(Files.readWholeFile(photo)), SRGB_CHUNKS),
    );

    await Promise.all([
      expectFaithfulCopy(photo, "96", "image/jpeg"),
      expectFaithfulCopy(photo, "144", "image/jpeg"),
      expectFaithfulCopy(tagged, "144", "image/jpeg"),
    ]);
  });

  it("serves every other kind of cover as stored", async () => {
    const photo = join(COVERS, "photo.jpg");
    const photoBytes = await run(Files.readWholeFile(photo));
    const soft = join(COVERS, "soft-alpha.png");
    const softBytes = await run(Files.readWholeFile(soft));
    const photoPng = await run(Files.readWholeFile(join(COVERS, "photo.png")));

    const profile = jpegProfile(await run(Files.readWholeFile(join(COVERS, "adobe-rgb.jpg"))));

    const others: ReadonlyArray<readonly [string, () => Promise<string>]> = [
      ["gray JPEG", fixture("gray.jpg")],
      ["gray JPEG with a gray profile", fixture("gray-profiled.jpg")],
      ["CMYK JPEG", fixture("cmyk.jpg")],
      [
        "RGB-coded JPEG",
        splicedAs("rgb-coded.jpg", withSegment(photoBytes, 0xee, adobeSegment(0))),
      ],
      [
        "JPEG with a multi-picture index",
        splicedAs("mpf.jpg", withSegment(photoBytes, 0xe2, Buffer.from("MPF\0II*\0", "latin1"))),
      ],
      [
        "JPEG with an unknown segment",
        splicedAs("app3.jpg", withSegment(photoBytes, 0xe3, Buffer.from("Meta", "latin1"))),
      ],
      [
        "RGB PNG with a transparent colour",
        splicedAs(
          "rgb-key.png",
          withChunks(photoPng, [pngChunk("tRNS", Uint8Array.of(0, 255, 0, 0, 0, 255))]),
        ),
      ],
      ["gray PNG", madeWith("gray.png", ["-i", photo, "-pix_fmt", "gray"])],
      ["gray PNG with alpha", madeWith("gray-alpha.png", ["-i", soft, "-pix_fmt", "ya8"])],
      ["16-bit RGBA PNG", madeWith("deep.png", ["-i", soft, "-pix_fmt", "rgba64be"])],
      ["palette PNG with transparency", fixture("palette.png")],
      ["PNG with gamma alone", fixture("gamma.png")],
      [
        "RGBA PNG with gamma alone",
        splicedAs("rgba-gamma.png", withChunks(softBytes, SRGB_CHUNKS.slice(1, 2))),
      ],
      [
        "RGBA PNG with an ICC profile",
        splicedAs(
          "rgba-icc.png",
          withChunks(softBytes, [
            pngChunk(
              "iCCP",
              Buffer.concat([Buffer.from("Adobe RGB\0\0", "latin1"), deflateSync(profile)]),
            ),
          ]),
        ),
      ],
      [
        "RGBA PNG with EXIF",
        splicedAs(
          "rgba-exif.png",
          withChunks(softBytes, [pngChunk("eXIf", exifOrientation(6).subarray(6))]),
        ),
      ],
      ["APNG", fixture("animated.png")],
      ["GIF", fixture("animated.gif")],
      ["animated WebP", fixture("animated.webp")],
      ["WebP with alpha", fixture("alpha.webp")],
    ];

    const served = await Promise.all(others.map(async ([, make]) => expectOriginal(await make())));

    expect(served.map(({ isOriginal }, index) => [others[index]?.[0], isOriginal])).toEqual(
      others.map(([kind]) => [kind, true]),
    );
  });

  it("serves a cover as stored when its header is cut short or damaged", async () => {
    const photo = await run(Files.readWholeFile(join(COVERS, "photo.jpg")));
    const soft = Buffer.from(await run(Files.readWholeFile(join(COVERS, "soft-alpha.png"))));
    const frame = Buffer.from(photo).indexOf(Buffer.from([0xff, 0xc0]));
    const scan = Buffer.from(photo).indexOf(Buffer.from([0xff, 0xda]));
    const badCrc = Buffer.from(soft);

    badCrc[29] = (badCrc[29] ?? 0) ^ 0xff;

    const damaged = [
      ["cut-in-frame.jpg", photo.subarray(0, frame + 9)],
      ["cut-after-scan-header.jpg", photo.subarray(0, scan + 14)],
      ["cut-mid-image.jpg", photo.subarray(0, Math.floor(photo.length / 2))],
      ["bad-header-crc.png", badCrc],
      ["cut-in-header.png", soft.subarray(0, 20)],
    ] as const;

    await Promise.all(
      damaged.map(async ([name, bytes]) => expectOriginal(await coverFile(name, bytes))),
    );
  });

  it("serves a cover as stored, never 503, when a copy cannot be made", async () => {
    const broken = await startServer(join(work, "broken-data"), {
      ffmpegPath: join(work, "no-such-ffmpeg"),
    });

    const served = await serveArt(
      join(COVERS, "photo.jpg"),
      "144",
      broken,
      join(work, "broken-data"),
    );

    expect([served.status, served.contentType, served.isOriginal]).toEqual([
      200,
      "image/jpeg",
      true,
    ]);
  });

  it("serves as stored a cover with a picture-changing tag after its image data, at any size", async () => {
    // The third verifier's 800x400 RGB PNG: an EXIF orientation after the image data, which
    // browsers ignore and ffmpeg 9 applies.
    const probe = join(COVERS, "exif-after-data.png");
    const photo = await run(Files.readWholeFile(join(COVERS, "photo.jpg")));
    const photoPng = await run(Files.readWholeFile(join(COVERS, "photo.png")));
    const soft = await run(Files.readWholeFile(join(COVERS, "soft-alpha.png")));
    const profile = jpegProfile(await run(Files.readWholeFile(join(COVERS, "adobe-rgb.jpg"))));
    const turned = jpegSegment(0xe1, exifOrientation(6));
    const eXIf = pngChunk("eXIf", exifOrientation(6).subarray(6));

    const trailing = await Promise.all([
      coverFile("jpeg-exif-at-end.jpg", beforeJpegEnd(photo, turned)),
      coverFile(
        "jpeg-icc-at-end.jpg",
        beforeJpegEnd(photo, jpegSegment(0xe2, iccSegment(profile))),
      ),
      coverFile(
        "progressive-exif-between-scans.jpg",
        beforeSecondScan(await run(Files.readWholeFile(join(COVERS, "progressive.jpg"))), turned),
      ),
      coverFile(
        "oriented-exif-at-end.jpg",
        beforeJpegEnd(await run(Files.readWholeFile(join(COVERS, "rotated.jpg"))), turned),
      ),
      coverFile("rgb-png-exif-at-end.png", beforePngEnd(photoPng, [eXIf])),
      coverFile("rgba-png-exif-at-end.png", beforePngEnd(soft, [eXIf])),
    ]);

    await Promise.all(
      [
        ...["144", "576", "1280"].map((width) => [probe, width] as const),
        ...trailing.map((file) => [file, "144"] as const),
      ].map(([file, width]) => expectOriginal(file, width)),
    );
  });

  it("decides once, per cover and size, to serve the stored cover, and keeps no copy then", async () => {
    // A JPEG saved at low quality: its copy at 1280 would take more bytes than it.
    const coarse = join(work, "coarse-once.jpg");

    await ffmpeg(
      ["-f", "lavfi", "-i", "testsrc2=size=1600x1600", "-frames:v", "1", "-q:v", "31"].concat(
        coarse,
      ),
    );
    const counting = await countingFfmpeg("decided-once");
    const data = join(work, "decided-once-data");
    const server = await startServer(data, { ffmpegPath: counting.path });
    const first = await serveArt(coarse, "1280", server, data);

    expect([first.status, first.isOriginal, await counting.runs()]).toEqual([200, true, 1]);
    // The larger output is gone.
    expect(
      (await sizesIn(join(data, "artwork", "s1280"))).filter(
        (size) => size >= first.original.length,
      ),
    ).toEqual([]);
    const second = await serveArt(coarse, "1280", server, data);

    expect([second.status, second.isOriginal, await counting.runs()]).toEqual([200, true, 1]);

    // An ffmpeg that fails is run once too.
    const failing = await countingFfmpeg("fails-once", { exit: 1 });
    const failingData = join(work, "fails-once-data");
    const failingServer = await startServer(failingData, { ffmpegPath: failing.path });

    const once = await serveArt(join(COVERS, "photo.jpg"), "144", failingServer, failingData);
    const again = await serveArt(join(COVERS, "photo.jpg"), "144", failingServer, failingData);

    expect([once.status, once.isOriginal, once.cacheControl, again.isOriginal]).toEqual([
      200,
      true,
      "public, max-age=31536000, immutable",
      true,
    ]);
    expect(await failing.runs()).toBe(1);
  });

  it("decides nothing when a copy's run is killed, and runs it again on a later request", async () => {
    const photo = join(COVERS, "photo.jpg");

    // Killed, as by the kernel, and stopped by a signal ffmpeg catches, which it exits 255 for.
    const stops = await Promise.all(
      (["killed", 255] as const).map(async (exit) => {
        const name = `stopped-${String(exit)}`;
        const stopped = await countingFfmpeg(name, { exit });
        const data = join(work, `${name}-data`);
        const server = await startServer(data, { ffmpegPath: stopped.path });
        const first = await serveArt(photo, "144", server, data);
        const second = await serveArt(photo, "144", server, data);

        return {
          answers: [first, second].map(({ status, isOriginal, cacheControl }) => [
            status,
            isOriginal,
            cacheControl,
          ]),
          runs: await stopped.runs(),
          kept: await sizesIn(join(data, "artwork", "s144")),
        };
      }),
    );

    // Each request was served the stored cover, unkept, and ran the copy, and no decision or
    // output was kept.
    expect(stops).toEqual(
      stops.map(() => ({
        answers: [
          [200, true, "no-store"],
          [200, true, "no-store"],
        ],
        runs: 2,
        kept: [],
      })),
    );
  });

  it("serves the stored cover, unkept, to first requests past 16 copies under way", async () => {
    // The bound is MAX_COVER_COPIES: two copies encode and the rest wait for an encoder.
    const bound = 16;
    const counting = await countingFfmpeg("admission", { seconds: 1 });
    const data = join(work, "admission-data");
    const server = await startServer(data, { ffmpegPath: counting.path });

    const covers = await Promise.all(
      Array.from({ length: bound + 8 }, async (_, index) => {
        const file = join(work, `distinct-${String(index)}.jpg`);
        const size = `${String(300 + index)}x${String(300 + index)}`;

        await ffmpeg(
          ["-f", "lavfi", "-i", `testsrc=size=${size}`, "-frames:v", "1", "-q:v", "1"].concat(file),
        );
        const original = await run(Files.readWholeFile(file));
        const hash = await run(saveArt(data, original).pipe(Effect.map(Option.getOrThrow)));

        return {
          original,
          url: `${server}/music/art/${hash}?ticket=${await artTicket(hash)}&w=144`,
        };
      }),
    );

    const served = await Promise.all(
      covers.map(async ({ original, url }) => {
        const response = await fetch(url);
        const bytes = new Uint8Array(await response.arrayBuffer());

        return {
          status: response.status,
          cacheControl: response.headers.get("cache-control"),
          isOriginal: Buffer.from(bytes).equals(Buffer.from(original)),
        };
      }),
    );

    const stored = served.filter(({ isOriginal }) => isOriginal);

    expect(served.map(({ status }) => status)).toEqual(served.map(() => 200));
    expect(await counting.runs()).toBe(bound);
    expect(stored.length).toBe(served.length - bound);
    // A client asks again for a cover served as stored because copies were busy.
    expect(stored.map(({ cacheControl }) => cacheControl)).toEqual(stored.map(() => "no-store"));
  });

  it("tells a cover's kind under the bound on copies, and serves first requests past it at once", async () => {
    // The bound is MAX_COVER_COPIES. Thirty covers whose kinds the server has not told: the fifth
    // review's JPEG, each with its own comment, which took 15,478 reads to tell at 496adedc.
    const bound = 16;
    const counting = await countingFfmpeg("unknown-kinds", { seconds: 1 });
    const opens = countingOpens();
    const data = join(work, "unknown-kinds-data");

    const server = await startServer(data, {
      ffmpegPath: counting.path,
      fileSystem: opens.fileSystem,
    });

    const fine = await run(Files.readWholeFile(join(COVERS, "fine-text.jpg")));

    const covers = await Promise.all(
      Array.from({ length: 30 }, async (_, index) => {
        const original = withSegment(fine, 0xfe, Buffer.from(`cover ${String(index)}`, "latin1"));
        const hash = await run(saveArt(data, original).pipe(Effect.map(Option.getOrThrow)));

        return {
          original,
          url: `${server}/music/art/${hash}?ticket=${await artTicket(hash)}&w=144`,
        };
      }),
    );

    const first = performance.now();

    const served = await Promise.all(
      covers.map(({ original, url }) => fetchArt(url, original, first)),
    );

    const stored = served.filter(({ isOriginal }) => isOriginal);
    const slowest = Math.max(...stored.map(({ answeredMs }) => answeredMs));

    // Sixteen covers had their kinds told and copies made, never more at once. The rest read
    // nothing but their first bytes and were served at once, unkept: within a few hundred
    // milliseconds alone, about a second beside the rest of the suite, 13.6 s or more at 496adedc.
    expect(
      {
        statuses: served.map(({ status }) => status),
        runs: await counting.runs(),
        told: opens.counts.opened,
        mostAtOnce: opens.counts.most <= bound,
        stored: stored.map(({ cacheControl }) => cacheControl),
        storedAtOnce: slowest < 3_000,
      },
      `the slowest stored cover was answered after ${String(Math.round(slowest))} ms`,
    ).toEqual({
      statuses: served.map(() => 200),
      runs: bound,
      told: bound,
      mostAtOnce: true,
      stored: Array.from({ length: 30 - bound }, () => "no-store"),
      storedAtOnce: true,
    });

    // The same thirty again: the sixteen copies from disk, the other fourteen told and made now.
    const again = performance.now();

    const servedAgain = await Promise.all(
      covers.map(({ original, url }) => fetchArt(url, original, again)),
    );

    expect(servedAgain.map(({ status, isOriginal }) => [status, isOriginal])).toEqual(
      servedAgain.map(() => [200, false]),
    );
    expect([await counting.runs(), opens.counts.opened, opens.counts.most <= bound]).toEqual([
      30,
      30,
      true,
    ]);
  });

  it("tells a cover's kind once, for every size", async () => {
    const opens = countingOpens();
    const data = join(work, "kind-once-data");
    const server = await startServer(data, { fileSystem: opens.fileSystem });

    // A cover copied and a cover served as stored, each asked at three sizes at once.
    const sized = await Promise.all(
      ["photo.jpg", "cmyk.jpg"].flatMap((name) =>
        ["144", "120", "96"].map((width) => serveArt(join(COVERS, name), width, server, data)),
      ),
    );

    expect([sized.map(({ status }) => status), opens.counts.opened]).toEqual([
      sized.map(() => 200),
      2,
    ]);
  });

  it("serves a chosen copy whole, or the stored cover, when the copy is removed meanwhile", async () => {
    const photo = join(COVERS, "photo.jpg");
    const beforeData = join(work, "removed-before-data");
    const afterData = join(work, "removed-after-data");
    const before = await startServer(beforeData, { fileSystem: removeBefore });
    const after = await startServer(afterData, { fileSystem: removeAfter });
    const gone = await serveArt(photo, "144", before, beforeData);

    expect([gone.status, gone.isOriginal]).toEqual([200, true]);
    const kept = await serveArt(photo, "144", after, afterData);

    expect([kept.status, kept.isOriginal, await sizeOf(kept.copy)]).toEqual([
      200,
      false,
      "144,144",
    ]);
  });
});
