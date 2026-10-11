/**
 * Serves a file over HTTP with validators and single byte ranges: `ETag`, `Last-Modified`,
 * `If-None-Match`, `If-Range`, `Range` (206 and 416), and bodiless `HEAD`.
 */
import { Effect } from "effect";

import { ByteRange, parseByteRange } from "./byte-range.ts";
import * as Files from "./files.ts";

/** `Cache-Control` for audio streams: private to the listener, reusable for an hour. */
export const STREAM_CACHE_CONTROL = "private, max-age=3600";

/** How a file response describes its body. */
export interface FileResponseOptions {
  readonly contentType: string;
  readonly cacheControl: string;
  /** Extra headers sent with every status, such as stream timing. */
  readonly headers?: ReadonlyArray<readonly [string, string]>;
}

const etagOf = (size: number, mtimeMs: number): string =>
  `"${size.toString(36)}-${Math.trunc(mtimeMs).toString(36)}"`;

const matchesEtag = (header: string, etag: string): boolean =>
  header.trim() === "*" ||
  header.split(",").some((candidate) => candidate.trim().replace(/^W\//, "") === etag);

/**
 * Builds the response for `request` from the file at `path`. Fails with `FileError` when the
 * file cannot be read; a missing file has `missing: true`.
 */
export const fileResponse = Effect.fn("FileResponse.make")(function* (
  request: Request,
  path: string,
  options: FileResponseOptions,
) {
  const info = yield* Files.statPath(path);

  if (info.kind !== "file") {
    return yield* new Files.FileError({ operation: "serve", path, missing: true, cause: null });
  }

  const { size, mtimeMs } = info;
  const etag = etagOf(size, mtimeMs);
  const lastModified = new Date(Math.trunc(mtimeMs)).toUTCString();

  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": options.cacheControl,
    "Content-Type": options.contentType,
    ETag: etag,
    "Last-Modified": lastModified,
  });

  for (const [name, value] of options.headers ?? []) headers.set(name, value);

  const ifNoneMatch = request.headers.get("If-None-Match");

  if (ifNoneMatch !== null && matchesEtag(ifNoneMatch, etag)) {
    return new Response(null, { status: 304, headers });
  }

  const ifRange = request.headers.get("If-Range");
  const rangeAllowed = ifRange === null || ifRange === etag || ifRange === lastModified;

  const range = parseByteRange(
    rangeAllowed ? (request.headers.get("Range") ?? undefined) : undefined,
    size,
  );

  const withBody = request.method !== "HEAD";

  return ByteRange.$match(range, {
    Full: () => {
      headers.set("Content-Length", String(size));

      return new Response(withBody && size > 0 ? Files.readRange(path, 0, size - 1) : null, {
        status: 200,
        headers,
      });
    },
    Partial: ({ start, end }) => {
      headers.set("Content-Length", String(end - start + 1));
      headers.set("Content-Range", `bytes ${start}-${end}/${size}`);

      return new Response(withBody ? Files.readRange(path, start, end) : null, {
        status: 206,
        headers,
      });
    },
    Unsatisfiable: () => {
      headers.set("Content-Range", `bytes */${size}`);

      return new Response(null, { status: 416, headers });
    },
  });
});
