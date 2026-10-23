import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeMedia } from "./fake-media";
import { fetchFinishedFile, FetchOutcome } from "./finished-file";
import type { FinishedFileRequest } from "./finished-file";
import { nodeTransfer } from "./node-transfer";

const SONG = "/media/stream/t1";

let media: FakeMedia;

let base: string;

let dir: string;

let waits: Array<number>;

beforeEach(async () => {
  media = new FakeMedia();
  base = await media.listen();
  dir = await mkdtemp(join(tmpdir(), "finished-file-"));
  waits = [];
});

afterEach(async () => {
  await media.close();
  await rm(dir, { recursive: true, force: true });
});

/** A request for `SONG`, signed afresh each time, into `dir`. */
const request = (overrides: Partial<FinishedFileRequest> = {}): FinishedFileRequest => {
  let signatures = 0;

  return {
    sign: () => {
      signatures += 1;

      return Promise.resolve(`${base}${SONG}?p=aac-320&sig=${String(signatures)}`);
    },
    destination: (contentType) => (contentType === "audio/mp4" ? join(dir, "song.m4a") : null),
    signal: new AbortController().signal,
    sleep: (ms) => {
      waits.push(ms);

      return Promise.resolve();
    },
    ...overrides,
  };
};

describe("fetchFinishedFile", () => {
  it("waits while the media service prepares the file, then writes all of it", async () => {
    media.serve(SONG, "finished mp4 bytes", { preparing: 2 });

    const outcome = await fetchFinishedFile(nodeTransfer, request());

    expect(outcome).toEqual(
      FetchOutcome.Fetched({
        destination: join(dir, "song.m4a"),
        bytes: 18,
        contentType: "audio/mp4",
      }),
    );

    expect(await readFile(join(dir, "song.m4a"), "utf8")).toBe("finished mp4 bytes");
    expect(waits).toEqual([2000, 2000]);

    expect(media.seen.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `HEAD ${SONG}?p=aac-320&sig=1&finished=1`,
      `HEAD ${SONG}?p=aac-320&sig=1&finished=1`,
      `HEAD ${SONG}?p=aac-320&sig=1&finished=1`,
      `GET ${SONG}?p=aac-320&sig=1&finished=1`,
    ]);
  });

  it("signs again once when the media service refuses the URL", async () => {
    media.serve(SONG, "bytes", { refusals: [403] });

    const outcome = await fetchFinishedFile(nodeTransfer, request());

    expect(FetchOutcome.$is("Fetched")(outcome)).toBe(true);
    expect(media.seen.at(-1)?.url).toContain("sig=2");
  });

  it("gives up without retrying when the fresh URL is refused too", async () => {
    media.serve(SONG, "bytes", { refusals: [403, 403] });

    expect(await fetchFinishedFile(nodeTransfer, request())).toEqual(
      FetchOutcome.Failed({ message: "The media service refused the song", retryable: false }),
    );
  });

  it("reports a song the media service no longer has as gone", async () => {
    expect(await fetchFinishedFile(nodeTransfer, request())).toEqual(FetchOutcome.Gone());
  });

  it("refuses a file this device can't keep before downloading it", async () => {
    media.serve(SONG, "ogg bytes", { contentType: "audio/ogg" });

    const outcome = await fetchFinishedFile(nodeTransfer, request());

    expect(outcome).toEqual(
      FetchOutcome.Failed({ message: "This device can’t keep audio/ogg", retryable: false }),
    );

    expect(media.seen.map(({ method }) => method)).toEqual(["HEAD"]);
  });

  it("tells a server refusal to sign from a lost connection", async () => {
    const refused = await fetchFinishedFile(
      nodeTransfer,
      request({
        sign: () =>
          Promise.reject(new ConvexError({ code: "not_found", message: "Song not found" })),
      }),
    );

    const offline = await fetchFinishedFile(
      nodeTransfer,
      request({ sign: () => Promise.reject(new Error("socket closed")) }),
    );

    expect(refused).toEqual(FetchOutcome.Failed({ message: "Song not found", retryable: false }));

    expect(offline).toEqual(
      FetchOutcome.Failed({ message: "Couldn’t reach the server", retryable: true }),
    );
  });

  it("stops polling when its signal aborts", async () => {
    media.serve(SONG, "bytes", { preparing: 100 });
    const stop = new AbortController();

    const outcome = await fetchFinishedFile(
      nodeTransfer,
      request({
        signal: stop.signal,
        sleep: () => {
          stop.abort();

          return Promise.resolve();
        },
      }),
    );

    expect(outcome).toEqual(FetchOutcome.Stopped());
    expect(media.seen).toHaveLength(1);
  });
});
