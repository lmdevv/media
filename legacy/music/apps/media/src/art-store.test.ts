import { createHash } from "node:crypto";
import { join } from "node:path";

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Effect, Option } from "effect";

import { artPath, imageContentType, isArtHash, saveArt, sweepArt } from "./art-store.ts";
import * as Files from "./files.ts";
import { setFileTime } from "./testing/file-times.ts";
import { temporaryDirectory } from "./testing/fixtures.ts";
import { runScoped } from "./testing/run.ts";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const jpeg = (fill: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, fill, fill, fill]);

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const HOUR = 60 * 60 * 1000;

describe("imageContentType", () => {
  it("names PNG, JPEG, GIF, and WebP from their first bytes, and nothing else", () => {
    expect(imageContentType(png)).toBe("image/png");
    expect(imageContentType(jpeg(1))).toBe("image/jpeg");
    expect(imageContentType(new TextEncoder().encode("GIF89a"))).toBe("image/gif");
    expect(imageContentType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(imageContentType(new TextEncoder().encode("RIFF\0\0\0\0WAVEfmt "))).toBe(
      "application/octet-stream",
    );
    expect(imageContentType(new TextEncoder().encode("<svg></svg>"))).toBe(
      "application/octet-stream",
    );
    expect(imageContentType(new Uint8Array())).toBe("application/octet-stream");
  });
});

describe("isArtHash", () => {
  it("accepts exactly 64 lowercase hex digits, which rules out paths", () => {
    expect(isArtHash(sha256(png))).toBe(true);
    expect(isArtHash(sha256(png).toUpperCase())).toBe(false);
    expect(isArtHash(`${sha256(png)}0`)).toBe(false);
    expect(isArtHash("../../etc/passwd")).toBe(false);

    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(isArtHash(text)).toBe(/^[0-9a-f]{64}$/u.test(text));
      }),
    );
  });
});

describe("saveArt", () => {
  it("stores an image once under its hash and refuses what is not an image", () =>
    runScoped(
      Effect.gen(function* () {
        const dataDir = yield* temporaryDirectory("data");
        const hash = yield* saveArt(dataDir, png);

        expect(hash).toEqual(Option.some(sha256(png)));
        expect(yield* Files.readWholeFile(artPath(dataDir, sha256(png)))).toEqual(Buffer.from(png));

        const written = yield* Files.statPath(artPath(dataDir, sha256(png)));

        yield* Effect.sleep("20 millis");
        expect(yield* saveArt(dataDir, png)).toEqual(hash);
        expect((yield* Files.statPath(artPath(dataDir, sha256(png)))).mtimeMs).toBe(
          written.mtimeMs,
        );

        expect(yield* saveArt(dataDir, new TextEncoder().encode("<html></html>"))).toEqual(
          Option.none(),
        );
        expect(yield* Files.listNames(join(dataDir, "art"))).toEqual([sha256(png)]);
      }),
    ));
});

describe("sweepArt", () => {
  it("deletes old artwork nothing uses and old partial writes, and keeps the rest", () =>
    runScoped(
      Effect.gen(function* () {
        const dataDir = yield* temporaryDirectory("data");
        const art = join(dataDir, "art");
        const [used, unused, fresh] = [jpeg(1), jpeg(2), jpeg(3)];

        for (const image of [used, unused, fresh]) yield* saveArt(dataDir, image);
        yield* Files.writeFileAtomic(join(art, "leftover.part"), png, "w");
        yield* Files.writeFileAtomic(join(art, "README"), png, "w");

        const old = Date.now() - 2 * HOUR;

        for (const name of [sha256(used), sha256(unused), "leftover.part", "README"]) {
          yield* Effect.promise(() => setFileTime(join(art, name), old));
        }

        const removed = yield* sweepArt(dataDir, new Set([sha256(used)]), Date.now() - HOUR);

        expect(removed).toBe(2);
        expect((yield* Files.listNames(art)).toSorted()).toEqual(
          ["README", sha256(fresh), sha256(used)].toSorted(),
        );
      }),
    ));

  it("finds nothing to delete in a data folder without artwork", () =>
    runScoped(
      Effect.gen(function* () {
        const dataDir = yield* temporaryDirectory("data");

        expect(yield* sweepArt(dataDir, new Set(), Date.now())).toBe(0);
      }),
    ));
});
