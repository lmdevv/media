import { TrackId } from "@media/contracts/ids";
import { Lease, serverFunctions } from "@media/contracts/server-functions";
import type { LyricsQuery, LyricsTry } from "@media/contracts/server-functions";
import { describe, expect, it } from "vitest";
import { Context, Duration, Effect, Layer, Ref, Schema } from "effect";

import { Settled } from "../../core/core-jobs.ts";
import * as CoreSession from "../../core/core-session.ts";
import { makeFakeCore, reply } from "../../testing/fake-core.ts";
import { MEDIA_TEST_TIMEOUT, runScoped } from "../testing/music-fixtures.ts";
import * as LrclibClient from "./lrclib-client.ts";
import * as LyricsJob from "./lyrics-job.ts";
import { catalogAnswer } from "./testing/lrclib-catalog.ts";
import { type FakeLrclibHandler, catalog, fakeLrclib, json } from "./testing/fake-lrclib.ts";

const LEASE = Schema.decodeSync(Lease)({ jobId: "job-1", attempt: 1 });

const TRACK = Schema.decodeSync(TrackId)("track-1");

/** A title the stand-in catalog answers with `answer`. */
const titled = (answer: ReturnType<typeof catalogAnswer>): string => {
  for (let n = 0; ; n += 1) {
    const title = `Song ${n}`;

    if (catalogAnswer(title) === answer) return title;
  }
};

const query = (title: string): LyricsQuery => ({
  artist: "Artist",
  title,
  album: "Album",
  durationS: 200,
});

/**
 * Runs one `music.lyrics` job for `title` against a stand-in LRCLIB answering through `handler`,
 * and answers what the job sent to `settle` and what its run returned.
 */
const runJob = (title: string, handler: FakeLrclibHandler = catalog) =>
  Effect.gen(function* () {
    const lrclib = yield* fakeLrclib(handler);
    const settled = yield* Ref.make<ReadonlyArray<LyricsTry>>([]);

    const core = yield* makeFakeCore([
      reply(serverFunctions.musicLyricsSettle, ({ result }) =>
        Ref.update(settled, (seen) => [...seen, result]).pipe(
          Effect.as({ outcome: "held" as const, value: { saved: "found" as const } }),
        ),
      ),
    ]);

    const client = yield* LrclibClient.make({
      baseUrl: lrclib.url,
      userAgent: LrclibClient.USER_AGENT,
      gap: Duration.millis(10),
      timeout: Duration.seconds(2),
      failurePause: Duration.millis(100),
      maxFailurePause: Duration.seconds(30),
      maxBodyBytes: 64 * 1024,
    });

    const services = yield* Layer.build(core.layer);

    const job = yield* LyricsJob.handler.pipe(
      Effect.provideService(CoreSession.Service, Context.get(services, CoreSession.Service)),
      Effect.provideService(LrclibClient.LrclibClient, client),
    );

    const ran = yield* job.run(
      {
        lease: LEASE,
        payload: {
          kind: "music.lyrics",
          trackId: TRACK,
          revision: "r1",
          query: query(title),
        },
      },
      () => Effect.void,
    );

    return { ran, settled: yield* Ref.get(settled), requests: lrclib.requests() };
  });

describe("LyricsJob", { timeout: MEDIA_TEST_TIMEOUT }, () => {
  it("settles synced lyrics LRCLIB found, asking with the song's tags and the User-Agent", () =>
    runScoped(
      Effect.gen(function* () {
        const title = titled("synced");
        const { ran, settled, requests } = yield* runJob(title);

        expect(ran).toBeInstanceOf(Settled);
        expect(settled).toMatchObject([
          {
            outcome: "answered",
            answer: {
              status: "found",
              sets: [
                {
                  kind: "main",
                  origin: { _tag: "Lrclib" },
                  body: {
                    _tag: "Synced",
                    lines: [
                      { text: `${title}, line one`, startMs: 1000 },
                      { text: `${title}, line two`, startMs: 5500 },
                      { text: `${title}, end`, startMs: 10_250 },
                    ],
                  },
                },
              ],
            },
          },
        ]);
        expect(requests).toMatchObject([
          {
            path: "/api/get",
            params: {
              track_name: title,
              artist_name: "Artist",
              album_name: "Album",
              duration: "200",
            },
            userAgent: LrclibClient.USER_AGENT,
          },
        ]);
      }),
    ));

  it("settles a miss after LRCLIB's get and search both find nothing", () =>
    runScoped(
      Effect.gen(function* () {
        const { settled, requests } = yield* runJob(titled("miss"));

        expect(settled).toEqual([{ outcome: "answered", answer: { status: "miss" } }]);
        expect(requests.map((request) => request.path)).toEqual(["/api/get", "/api/search"]);
      }),
    ));

  it("settles an instrumental answer, and plain lyrics as found", () =>
    runScoped(
      Effect.gen(function* () {
        const instrumental = yield* runJob(titled("instrumental"));
        const plain = yield* runJob(titled("plain"));

        expect(instrumental.settled).toMatchObject([
          { outcome: "answered", answer: { status: "instrumental" } },
        ]);
        expect(plain.settled).toMatchObject([
          {
            outcome: "answered",
            answer: { status: "found", sets: [{ body: { _tag: "Plain" } }] },
          },
        ]);
      }),
    ));

  it("settles LRCLIB's 429 as unavailable for its Retry-After, which pauses every lookup", () =>
    runScoped(
      Effect.gen(function* () {
        const { settled } = yield* runJob(titled("synced"), () =>
          json(429, { message: "slow down" }, { "retry-after": "7" }),
        );

        expect(settled).toMatchObject([{ outcome: "unavailable", pauseMs: 7000 }]);
      }),
    ));

  it("settles a record it cannot read as a failed try", () =>
    runScoped(
      Effect.gen(function* () {
        const { settled } = yield* runJob(titled("synced"), () =>
          json(200, { id: 1, instrumental: false, plainLyrics: 7, syncedLyrics: null }),
        );

        expect(settled).toMatchObject([{ outcome: "failed" }]);
      }),
    ));
});
