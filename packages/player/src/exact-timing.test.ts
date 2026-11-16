import { createServer } from "node:http";
import type { OutgoingHttpHeaders } from "node:http";

import { MusicStreamTimingHeader } from "@media/contracts/music-playback";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { askExactTiming, ExactTiming } from "./exact-timing";

const ListeningAddress = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Int }));

/** The finished stream's headers: priming, length, and rate, measured. */
const FINISHED: OutgoingHttpHeaders = {
  [MusicStreamTimingHeader.priming]: "1024",
  [MusicStreamTimingHeader.duration]: "441000",
  [MusicStreamTimingHeader.sampleRate]: "44100",
};

/** Asks the media service for a moment while the song transcodes: `503`, ask again at once. */
const PREPARING: OutgoingHttpHeaders = { "retry-after": "0", "cache-control": "no-store" };

const servers: Array<() => void> = [];

afterEach(() => {
  for (const close of servers.splice(0)) close();
});

/** A media service answering each `HEAD` with the next of `answers`, the last one for ever. */
const mediaService = async (
  answers: ReadonlyArray<readonly [number, OutgoingHttpHeaders]>,
): Promise<{ readonly url: string; readonly asked: () => number }> => {
  let asked = 0;

  const server = createServer((request, response) => {
    const [status, headers] = answers[Math.min(asked, answers.length - 1)] ?? [500, {}];

    asked += 1;
    expect(request.method).toBe("HEAD");
    response.writeHead(status, headers).end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  servers.push(() => {
    server.close();
  });

  const { port } = ListeningAddress(server.address());

  return { url: `http://127.0.0.1:${String(port)}/stream?ticket=t`, asked: () => asked };
};

describe("askExactTiming", () => {
  it("asks again while the song transcodes, until the finished timing comes", async () => {
    const service = await mediaService([
      [503, PREPARING],
      [503, PREPARING],
      [200, FINISHED],
    ]);

    const exact = await askExactTiming(service.url, new AbortController().signal);

    expect(exact).toEqual(
      ExactTiming.Known({
        timing: {
          primingSamples: 1024,
          durationSamples: 441_000,
          sampleRate: 44_100,
          estimated: false,
        },
      }),
    );
    expect(service.asked()).toBe(3);
  });

  it("stops asking once the song moves on", async () => {
    const service = await mediaService([[503, { ...PREPARING, "retry-after": "5" }]]);
    const song = new AbortController();
    const exact = askExactTiming(service.url, song.signal);

    await expect.poll(() => service.asked()).toBe(1);
    song.abort();

    const failed = await exact;

    expect(ExactTiming.$is("Failed")(failed) && failed.reason).toBe("network");
    expect(service.asked()).toBe(1);
  });

  it("gives up once the transcode outlasts its patience", async () => {
    const service = await mediaService([[503, PREPARING]]);
    const exact = await askExactTiming(service.url, new AbortController().signal, 600);

    expect(exact).toEqual(
      ExactTiming.Failed({ reason: "unsupported", message: "The finished stream answered 503" }),
    );
    expect(service.asked()).toBeGreaterThan(1);
  });

  it.each([
    ["a 503 that names no time to ask again", 503, {}, "unsupported"],
    ["a refused ticket", 401, {}, "expired"],
    [
      "a stream still estimated",
      200,
      { ...FINISHED, "x-music-duration-estimated": "1" },
      "unsupported",
    ],
    ["an error", 500, {}, "unsupported"],
  ] as const)("answers %s with a failure at once", async (_, status, headers, reason) => {
    const service = await mediaService([[status, headers]]);
    const exact = await askExactTiming(service.url, new AbortController().signal);

    expect(ExactTiming.$is("Failed")(exact) && exact.reason).toBe(reason);
    expect(service.asked()).toBe(1);
  });
});
