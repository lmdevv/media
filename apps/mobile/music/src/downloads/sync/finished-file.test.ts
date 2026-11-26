import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NotFound } from "@media/contracts/errors";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeMedia } from "./fake-media";
import { fetchFinishedFile, FetchOutcome, observedTransfer } from "./finished-file";
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

const request = (overrides: Partial<FinishedFileRequest> = {}): FinishedFileRequest => {
  let signatures = 0;

  return {
    sign: () => {
      signatures += 1;

      return Promise.resolve(`${base}${SONG}?p=aac-320&ticket=${String(signatures)}`);
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
      `HEAD ${SONG}?p=aac-320&ticket=1&finished=1`,
      `HEAD ${SONG}?p=aac-320&ticket=1&finished=1`,
      `HEAD ${SONG}?p=aac-320&ticket=1&finished=1`,
      `GET ${SONG}?p=aac-320&ticket=1&finished=1`,
    ]);
  });

  it("asks for a new ticket once when the media service refuses the one it had", async () => {
    media.serve(SONG, "bytes", { refusals: [401] });

    const outcome = await fetchFinishedFile(nodeTransfer, request());

    expect(FetchOutcome.$is("Fetched")(outcome)).toBe(true);
    expect(media.seen.at(-1)?.url).toContain("ticket=2");
  });

  it("gives up without retrying when the fresh ticket is refused too", async () => {
    media.serve(SONG, "bytes", { refusals: [401, 401] });

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

  it("tells the core's refusal of a ticket from a lost connection", async () => {
    const refused = await fetchFinishedFile(
      nodeTransfer,
      request({ sign: () => Promise.reject(new NotFound({ message: "Song not found" })) }),
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

/** A transfer over Node and the statuses it told of, null for no answer. */
const observed = () => {
  const told: Array<number | null> = [];

  return {
    transfer: observedTransfer(nodeTransfer, (status) => {
      told.push(status);
    }),
    told,
  };
};

describe("observedTransfer", () => {
  it("tells nothing for a fetch that lands", async () => {
    media.serve(SONG, "bytes");
    const { transfer, told } = observed();

    expect(FetchOutcome.$is("Fetched")(await fetchFinishedFile(transfer, request()))).toBe(true);
    expect(told).toEqual([]);
  });

  it("tells each error status the media service or its proxy answers", async () => {
    media.serve(SONG, "bytes", { refusals: [502], preparing: 1 });
    const { transfer, told } = observed();

    expect(await fetchFinishedFile(transfer, request())).toEqual(
      FetchOutcome.Failed({ message: "The media service answered 502", retryable: true }),
    );

    expect(await fetchFinishedFile(transfer, request())).toEqual(
      FetchOutcome.Fetched({
        destination: join(dir, "song.m4a"),
        bytes: 5,
        contentType: "audio/mp4",
      }),
    );

    expect(told).toEqual([502, 503]);
  });

  it("tells no answer when nothing listens at the media service's address", async () => {
    await media.close();
    const { transfer, told } = observed();
    const destination = join(dir, "cover.jpg");
    const signal = new AbortController().signal;

    await fetchFinishedFile(transfer, request());
    await transfer.download({ url: `${base}/art/a1`, destination, signal });

    expect(told).toEqual([null, null]);
    media = new FakeMedia();
    await media.listen();
  });

  it("tells nothing of a request its signal stopped", async () => {
    media.serve(SONG, "bytes");
    const stop = new AbortController();
    const { transfer, told } = observed();

    stop.abort();
    await fetchFinishedFile(transfer, request({ signal: stop.signal }));
    await transfer.download({
      url: `${base}${SONG}`,
      destination: join(dir, "s"),
      signal: stop.signal,
    });

    expect(told).toEqual([]);
  });
});
