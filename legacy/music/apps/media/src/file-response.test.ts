import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { Effect, Schedule } from "effect";

import { fileResponse, STREAM_CACHE_CONTROL } from "./file-response.ts";
import * as Files from "./files.ts";
import { temporaryDirectory } from "./testing/fixtures.ts";
import { canCountOpenFiles, openDescriptors } from "./testing/open-files.ts";
import { runScoped } from "./testing/run.ts";

const options = { contentType: "audio/flac", cacheControl: STREAM_CACHE_CONTROL };

/** A four megabyte file, more than one read of a file stream. */
const largeFile = Effect.gen(function* () {
  const path = join(yield* temporaryDirectory("files"), "song.flac");

  yield* Files.writeFileAtomic(path, new Uint8Array(randomBytes(4 * 1024 * 1024)), "w");

  return path;
});

const descriptors = (path: string): Effect.Effect<number> =>
  Effect.promise(() => openDescriptors(path));

/** Polls until nothing holds `path` open, for up to two seconds, and returns the last count. */
const settledDescriptors = (path: string): Effect.Effect<number> =>
  descriptors(path).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("20 millis"),
      until: (open) => open === 0,
      times: 100,
    }),
  );

/** A request from a client that can go away, as `@hono/node-server` aborts its signal then. */
const clientRequest = (headers: Readonly<Record<string, string>> = {}) => {
  const client = new AbortController();

  return {
    request: new Request("http://media.test/song", { signal: client.signal, headers }),
    leave: () => {
      client.abort();
    },
  };
};

describe.skipIf(!canCountOpenFiles())("fileResponse", () => {
  for (const range of [undefined, "bytes=1000-"]) {
    it(`closes the file when the client leaves without reading the body (${range ?? "whole file"})`, () =>
      runScoped(
        Effect.gen(function* () {
          const path = yield* largeFile;
          const { request, leave } = clientRequest(range === undefined ? {} : { Range: range });
          const response = yield* fileResponse(request, path, options);

          expect(response.status).toBe(range === undefined ? 200 : 206);
          // The body opened the file and nobody reads or cancels it, as with a server that never
          // started sending it.
          yield* descriptors(path).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("10 millis"),
              until: (open) => open > 0,
              times: 100,
            }),
          );

          leave();
          expect(yield* settledDescriptors(path)).toBe(0);
        }),
      ));
  }

  it("never holds the file for a client that left before the response was built", () =>
    runScoped(
      Effect.gen(function* () {
        const path = yield* largeFile;
        const { request, leave } = clientRequest();

        leave();
        const response = yield* fileResponse(request, path, options);

        expect(response.status).toBe(200);

        yield* Effect.sleep("200 millis");
        expect(yield* descriptors(path)).toBe(0);
      }),
    ));

  it("streams the whole file to a client that reads it, then closes it", () =>
    runScoped(
      Effect.gen(function* () {
        const path = yield* largeFile;
        const response = yield* fileResponse(new Request("http://media.test/song"), path, options);

        const body = yield* Effect.promise(
          async () => new Uint8Array(await response.arrayBuffer()),
        );

        // Compared as one buffer: a deep comparison of four megabytes takes seconds.
        expect(Buffer.from(body).equals(yield* Files.readWholeFile(path))).toBe(true);
        expect(yield* settledDescriptors(path)).toBe(0);
      }),
    ));
});
