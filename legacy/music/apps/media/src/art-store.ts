/**
 * Content-addressed artwork under `MEDIA_DATA_DIR/art/<sha256>`. A hash names exactly one image,
 * so files are written once and served as immutable.
 */
import { createHash, randomUUID } from "node:crypto";
import { basename, join } from "node:path";

import { Effect, Option } from "effect";

import * as Files from "./files.ts";

const HASH = /^[0-9a-f]{64}$/;

const UNKNOWN_TYPE = "application/octet-stream";

/** True when `hash` has the shape of an artwork hash, which also rules out path tricks. */
export const isArtHash = (hash: string): boolean => HASH.test(hash);

/** Absolute path of the artwork with `hash`. */
export const artPath = (dataDir: string, hash: string): string => join(dataDir, "art", hash);

/**
 * Stores image bytes once and returns their SHA-256 hex hash. Bytes that are not a PNG, JPEG, GIF,
 * or WebP image are not stored, so the art route never serves anything but images.
 */
export const saveArt = Effect.fn("ArtStore.save")(function* (dataDir: string, bytes: Uint8Array) {
  if (imageContentType(bytes) === UNKNOWN_TYPE) return Option.none<string>();
  const hash = createHash("sha256").update(bytes).digest("hex");
  const path = artPath(dataDir, hash);
  const existing = yield* Files.statPath(path).pipe(Effect.option);

  if (Option.isNone(existing)) {
    yield* Files.makeDirectory(join(dataDir, "art"));
    yield* Files.writeFileAtomic(path, bytes, randomUUID());
  }

  return Option.some(hash);
});

/**
 * Deletes stored artwork whose hash is not in `inUse`, and leftovers of interrupted writes, when
 * they were last written before `before` (milliseconds since the epoch). Artwork written since
 * may belong to a scan that has not stored its songs yet. Other files are left alone.
 *
 * @returns How many files were deleted.
 */
export const sweepArt = Effect.fn("ArtStore.sweep")(function* (
  dataDir: string,
  inUse: ReadonlySet<string>,
  before: number,
) {
  const files = yield* Files.listFiles(join(dataDir, "art"));

  const unused = files.filter((file) => {
    const name = basename(file.path);

    return file.mtimeMs < before && (isArtHash(name) ? !inUse.has(name) : name.endsWith(".part"));
  });

  yield* Effect.forEach(unused, (file) => Files.removePath(file.path), { discard: true });

  return unused.length;
});

/** The image `Content-Type` from the first bytes of a file. */
export const imageContentType = (head: Uint8Array): string => {
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47)
    return "image/png";

  if (head[0] === 0xff && head[1] === 0xd8) return "image/jpeg";

  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return "image/gif";
  const text = new TextDecoder().decode(head.subarray(0, 12));

  if (text.startsWith("RIFF") && text.slice(8, 12) === "WEBP") return "image/webp";

  return UNKNOWN_TYPE;
};
