/**
 * The lyrics worker against a stand-in LRCLIB over real HTTP and the in-memory backend: how it
 * matches songs, what it saves, how it paces requests, how an LRCLIB outage pauses every lookup
 * without costing any of them a try, and that a save after a lost lease is dropped.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect, Layer, Option, Schedule, Stream } from "effect";

import * as LrclibClient from "./lrclib-client.ts";
import * as LyricsWorker from "./lyrics-worker.ts";
import { type LookupQuery, MediaBackend } from "./media-backend.ts";
import {
  type FakeLrclibHandler,
  type FakeLrclibReply,
  fakeLrclib,
  json,
  NOT_FOUND,
  record,
} from "./testing/fake-lrclib.ts";
import { MEDIA_TEST_TIMEOUT } from "./testing/fixtures.ts";
import {
  layerMemory,
  type MemoryLookup,
  MemoryMediaBackendControl,
} from "./testing/memory-media-backend.ts";
import { runScoped } from "./testing/run.ts";

const GAP_MS = 150;

const SYMPATHY: LookupQuery = {
  artist: "Massive Attack",
  title: "Unfinished Sympathy",
  album: "Blue Lines",
  durationS: 308,
};

const SYNCED =
  "[00:12.00] I know that I've imagined love before\n[00:18.50] And how it could be with you";

const found = (id: number, extra: Partial<Parameters<typeof record>[0]> = {}): FakeLrclibReply =>
  json(
    200,
    record({
      id,
      trackName: SYMPATHY.title,
      artistName: SYMPATHY.artist,
      duration: SYMPATHY.durationS,
      syncedLyrics: SYNCED,
      ...extra,
    }),
  );

/**
 * Starts the worker against a stand-in answering with `handler`, and returns the backend's test
 * controls and the stand-in.
 */
const start = (handler: FakeLrclibHandler, options: Partial<LrclibClient.Options> = {}) =>
  Effect.gen(function* () {
    const lrclib = yield* fakeLrclib(handler);

    const client = Layer.effect(
      LrclibClient.LrclibClient,
      LrclibClient.make({
        baseUrl: lrclib.url,
        userAgent: LrclibClient.USER_AGENT,
        gap: Duration.millis(GAP_MS),
        timeout: Duration.seconds(5),
        failurePause: Duration.millis(50),
        maxFailurePause: Duration.millis(200),
        maxBodyBytes: 64 * 1024,
        ...options,
      }),
    );

    const services = Layer.merge(layerMemory, client);

    const context = yield* Layer.build(
      Layer.merge(services, LyricsWorker.layer.pipe(Layer.provide(services))),
    );

    const control = yield* MemoryMediaBackendControl.pipe(Effect.provideContext(context));

    return { control, lrclib };
  });

type Control = MemoryMediaBackendControl["Service"];

const lookupOf = (control: Control, lookupId: MemoryLookup["id"]) =>
  control.lookups.pipe(Effect.map((lookups) => lookups.find((lookup) => lookup.id === lookupId)));

const ANSWERED: ReadonlySet<string> = new Set(["found", "instrumental", "miss"]);

/**
 * Waits until the lookup has an answer, running the backend's scheduled retries and pause ends as
 * soon as they are scheduled, as if their time had come.
 */
const answerOf = (control: Control, lookupId: MemoryLookup["id"]) =>
  control.runScheduled.pipe(
    Effect.andThen(lookupOf(control, lookupId)),
    Effect.repeat({
      schedule: Schedule.spaced("20 millis"),
      until: (lookup) => ANSWERED.has(lookup?.state.status ?? ""),
      times: 500,
    }),
  );

/** Waits until `ready` holds for the stand-in's requests. */
const requestsUntil = (
  lrclib: { readonly requests: () => ReadonlyArray<unknown> },
  ready: (count: number) => boolean,
) =>
  Effect.sync(() => lrclib.requests().length).pipe(
    Effect.repeat({ schedule: Schedule.spaced("10 millis"), until: ready, times: 500 }),
  );

const paths = (requests: ReadonlyArray<{ readonly path: string }>) =>
  requests.map((request) => request.path);

describe("LyricsWorker", { timeout: MEDIA_TEST_TIMEOUT }, () => {
  it("saves synced lyrics /api/get finds, asking with the tags and whole seconds", () =>
    runScoped(
      Effect.gen(function* () {
        const { control, lrclib } = yield* start(() => found(80110));
        const lookupId = yield* control.queueLookup(SYMPATHY);
        const lookup = yield* answerOf(control, lookupId);

        expect(lookup?.answer).toMatchObject({
          kind: "found",
          recordId: 80110,
          sets: [
            {
              kind: "main",
              origin: { _tag: "Lrclib", recordId: 80110 },
              body: { _tag: "Synced", lines: [{ startMs: 12_000 }, { startMs: 18_500 }] },
            },
          ],
        });

        expect(lrclib.requests()[0]?.userAgent).toMatch(
          /^music\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\//u,
        );
        expect(lrclib.requests()).toMatchObject([
          {
            path: "/api/get",
            params: {
              track_name: "Unfinished Sympathy",
              artist_name: "Massive Attack",
              album_name: "Blue Lines",
              duration: "308",
            },
          },
        ]);
      }),
    ));

  it("falls back to a search result whose title, artist, and length match", () =>
    runScoped(
      Effect.gen(function* () {
        const { control, lrclib } = yield* start((request) =>
          request.path === "/api/get"
            ? NOT_FOUND
            : json(200, [
                record({
                  id: 1,
                  trackName: "Unfinished Sympathy",
                  artistName: "Massive Attack",
                  duration: 321,
                  syncedLyrics: SYNCED,
                }),
                record({
                  id: 2,
                  trackName: "Unfinished Sympathy (Live)",
                  artistName: "Massive Attack",
                  duration: 308,
                  syncedLyrics: SYNCED,
                }),
                record({
                  id: 3,
                  trackName: "Unfinished Sympathy",
                  artistName: "Massive Attack",
                  duration: 309,
                  plainLyrics: "Plain words",
                }),
                record({
                  id: 4,
                  trackName: "UNFINISHED SYMPATHY - 2012 Remaster",
                  artistName: "Massive Attack feat. Shara Nelson",
                  duration: 307,
                  syncedLyrics: SYNCED,
                }),
              ]),
        );

        const lookup = yield* answerOf(control, yield* control.queueLookup(SYMPATHY));

        // Of the two that match, the one with synced lyrics wins.
        expect(lookup?.answer).toMatchObject({ kind: "found", recordId: 4 });
        expect(paths(lrclib.requests())).toEqual(["/api/get", "/api/search"]);
        expect(lrclib.requests()[1]?.params).toEqual({
          track_name: "Unfinished Sympathy",
          artist_name: "Massive Attack",
        });
      }),
    ));

  it("saves a miss when no search result matches the length or the names", () =>
    runScoped(
      Effect.gen(function* () {
        const { control } = yield* start((request) =>
          request.path === "/api/get"
            ? NOT_FOUND
            : json(200, [
                record({
                  id: 1,
                  trackName: "Unfinished Sympathy",
                  artistName: "Massive Attack",
                  duration: 311,
                  syncedLyrics: SYNCED,
                }),
                record({
                  id: 2,
                  trackName: "Unfinished Symphony",
                  artistName: "Massive Attack",
                  duration: 308,
                  syncedLyrics: SYNCED,
                }),
                record({
                  id: 3,
                  trackName: "Unfinished Sympathy",
                  artistName: "Shara Nelson & Massive Attack",
                  duration: 308,
                  syncedLyrics: SYNCED,
                }),
              ]),
        );

        const lookup = yield* answerOf(control, yield* control.queueLookup(SYMPATHY));

        expect(lookup?.answer).toEqual({ kind: "miss" });
      }),
    ));

  it("saves a miss when neither /api/get nor /api/search finds the song", () =>
    runScoped(
      Effect.gen(function* () {
        const { control, lrclib } = yield* start((request) =>
          request.path === "/api/get" ? NOT_FOUND : json(200, []),
        );

        const lookup = yield* answerOf(control, yield* control.queueLookup(SYMPATHY));

        expect(lookup).toMatchObject({ state: { status: "miss" }, answer: { kind: "miss" } });
        expect(paths(lrclib.requests())).toEqual(["/api/get", "/api/search"]);
      }),
    ));

  it("saves an instrumental answer, whatever text the record holds", () =>
    runScoped(
      Effect.gen(function* () {
        const { control } = yield* start(() =>
          found(77, { instrumental: true, plainLyrics: "[Instrumental]" }),
        );

        const lookup = yield* answerOf(control, yield* control.queueLookup(SYMPATHY));

        expect(lookup?.answer).toEqual({ kind: "instrumental", recordId: 77 });
      }),
    ));

  it("pauses every lookup for Retry-After after a 429, without counting a try", () =>
    runScoped(
      Effect.gen(function* () {
        let calls = 0;

        const { control, lrclib } = yield* start(
          () => {
            calls += 1;

            return calls === 1
              ? json(429, { message: "slow down" }, { "retry-after": "1" })
              : found(5);
          },
          { maxFailurePause: Duration.seconds(2) },
        );

        const first = yield* control.queueLookup(SYMPATHY);
        const second = yield* control.queueLookup({ ...SYMPATHY, title: "Safe from Harm" });
        const answers = [yield* answerOf(control, first), yield* answerOf(control, second)];

        expect(answers.map((lookup) => lookup?.state.status)).toEqual(["found", "found"]);
        expect(answers.map((lookup) => lookup?.state)).not.toContainEqual(
          expect.objectContaining({ attempts: 1 }),
        );

        const [limited, next] = lrclib.requests();

        expect((next?.at ?? 0) - (limited?.at ?? 0)).toBeGreaterThanOrEqual(1000);
      }),
    ));

  it("keeps lookups queued while LRCLIB is down, pausing all of them, never giving up", () =>
    runScoped(
      Effect.gen(function* () {
        let calls = 0;

        const { control, lrclib } = yield* start(
          () => {
            calls += 1;

            return calls <= 8 ? { status: 503, body: "Service Unavailable" } : found(9);
          },
          { failurePause: Duration.millis(300), maxFailurePause: Duration.millis(300) },
        );

        const lookupId = yield* control.queueLookup(SYMPATHY);

        yield* control.queueLookup({ ...SYMPATHY, title: "Safe from Harm" });
        yield* requestsUntil(lrclib, (count) => count >= 1);
        yield* Effect.sleep("150 millis");

        // The outage paused the queue for both lookups, and cost neither a try.
        expect(lrclib.requests()).toHaveLength(1);
        expect(yield* control.pausedUntil).not.toBeNull();
        expect((yield* control.lookups).map((lookup) => lookup.state)).toEqual([
          expect.objectContaining({ status: "queued", attempts: 0 }),
          expect.objectContaining({ status: "queued", attempts: 0 }),
        ]);

        const lookup = yield* answerOf(control, lookupId);

        expect(lookup?.state).toMatchObject({ status: "found" });
        expect(lrclib.requests().length).toBeGreaterThanOrEqual(9);

        const arrivals = lrclib.requests().map((request) => request.at);
        const gaps = arrivals.slice(1, 8).map((at, index) => at - (arrivals[index] ?? at));

        expect(Math.min(...gaps)).toBeGreaterThanOrEqual(295);
      }),
    ));

  it("treats a 4xx other than 404 as LRCLIB unavailable, not as a miss", () =>
    runScoped(
      Effect.gen(function* () {
        let calls = 0;

        const { control } = yield* start(() => {
          calls += 1;

          return calls === 1 ? json(400, { message: "Bad Request" }) : found(3);
        });

        const lookup = yield* answerOf(control, yield* control.queueLookup(SYMPATHY));

        expect(lookup?.state).toMatchObject({ status: "found" });
        expect(lookup?.answer).toMatchObject({ kind: "found", recordId: 3 });
      }),
    ));

  it("counts an unreadable record as a failed try, then saves the lyrics", () =>
    runScoped(
      Effect.gen(function* () {
        let calls = 0;

        const { control, lrclib } = yield* start(() => {
          calls += 1;

          return calls === 1 ? { status: 200, body: "{not json" } : found(9);
        });

        const lookupId = yield* control.queueLookup(SYMPATHY);

        yield* requestsUntil(lrclib, (count) => count >= 1);
        yield* lookupOf(control, lookupId).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("10 millis"),
            until: (lookup) => lookup?.state.status === "waiting",
            times: 500,
          }),
        );

        const lookup = yield* answerOf(control, lookupId);

        expect(lookup?.answer).toMatchObject({ kind: "found", recordId: 9 });
        expect(lrclib.requests()).toHaveLength(2);
      }),
    ));

  it("counts a search result it cannot read as a failed try, never a miss", () =>
    runScoped(
      Effect.gen(function* () {
        const { control } = yield* start((request) =>
          request.path === "/api/get"
            ? NOT_FOUND
            : json(200, [
                {
                  ...record({
                    id: 1,
                    trackName: SYMPATHY.title,
                    artistName: SYMPATHY.artist,
                    duration: SYMPATHY.durationS,
                    syncedLyrics: SYNCED,
                  }),
                  duration: "308",
                },
              ]),
        );

        const lookup = yield* lookupOf(control, yield* control.queueLookup(SYMPATHY)).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("10 millis"),
            until: (current) => current?.answer !== undefined,
            times: 500,
          }),
        );

        expect(lookup?.state).toMatchObject({ status: "waiting", attempts: 1 });
        expect(lookup?.answer).toEqual({ kind: "failed" });
      }),
    ));

  it("gives up on a record unreadable five times", () =>
    runScoped(
      Effect.gen(function* () {
        const { control, lrclib } = yield* start(() => ({ status: 200, body: "{not json" }));
        const lookup = yield* answerOf(control, yield* control.queueLookup(SYMPATHY));

        expect(lookup?.state).toMatchObject({ status: "miss" });
        expect(paths(lrclib.requests())).toEqual(Array.from({ length: 5 }, () => "/api/get"));
      }),
    ));

  it("matches whole artist names, so a band named with punctuation matches only itself", () =>
    runScoped(
      Effect.gen(function* () {
        const results = new Map([
          ["Back in Black", "AC"],
          ["September", "Earth"],
          ["Teardrop", "Massive Attack feat. Elizabeth Fraser"],
        ]);

        const { control } = yield* start((request) => {
          if (request.path === "/api/get") return NOT_FOUND;
          const title = request.params["track_name"] ?? "";

          return json(200, [
            record({
              id: title.length,
              trackName: title,
              artistName: results.get(title) ?? "",
              duration: 200,
              syncedLyrics: SYNCED,
            }),
          ]);
        });

        const songs = [
          { artist: "AC/DC", title: "Back in Black" },
          { artist: "Earth, Wind & Fire", title: "September" },
          { artist: "Massive Attack", title: "Teardrop" },
        ];

        const ids = yield* Effect.forEach(songs, (song) =>
          control.queueLookup({ ...song, album: "Album", durationS: 200 }),
        );

        const answers = yield* Effect.forEach(ids, (id) => answerOf(control, id));

        expect(answers.map((lookup) => lookup?.answer?.kind)).toEqual(["miss", "miss", "found"]);
      }),
    ));

  it("tries a claim that failed again, with the queue unchanged", () =>
    runScoped(
      Effect.gen(function* () {
        const { control, lrclib } = yield* start(() => found(12));

        yield* control.failNextClaim;
        const lookup = yield* answerOf(control, yield* control.queueLookup(SYMPATHY));

        expect(lookup?.answer).toMatchObject({ kind: "found", recordId: 12 });
        expect(lrclib.requests()).toHaveLength(1);
      }),
    ));

  it("takes the most urgent lookup once LRCLIB's pause is over, not the one it waited with", () =>
    runScoped(
      Effect.gen(function* () {
        let calls = 0;

        const { control, lrclib } = yield* start(
          () => {
            calls += 1;

            return calls === 1
              ? json(429, { message: "slow down" }, { "retry-after": "1" })
              : found(calls);
          },
          { maxFailurePause: Duration.seconds(2) },
        );

        yield* control.queueLookup(SYMPATHY);
        yield* control.queueLookup({ ...SYMPATHY, title: "Safe from Harm" });
        yield* requestsUntil(lrclib, (count) => count >= 1);
        yield* control.lookups.pipe(
          Effect.repeat({
            schedule: Schedule.spaced("10 millis"),
            until: (lookups) => lookups.some((lookup) => lookup.answer !== undefined),
            times: 500,
          }),
        );
        yield* control.runScheduled;

        const playing = yield* control.queueLookup({ ...SYMPATHY, title: "Teardrop" }, "play");

        yield* answerOf(control, playing);

        expect(lrclib.requests().map((request) => request.params["track_name"])).toEqual([
          "Unfinished Sympathy",
          "Teardrop",
        ]);
      }),
    ));

  it("sends one request at a time, the gap apart", () =>
    runScoped(
      Effect.gen(function* () {
        const { control, lrclib } = yield* start((request) =>
          request.path === "/api/get" ? NOT_FOUND : json(200, []),
        );

        const ids = [
          yield* control.queueLookup(SYMPATHY),
          yield* control.queueLookup({ ...SYMPATHY, title: "Safe from Harm" }),
          yield* control.queueLookup({ ...SYMPATHY, title: "Daydreaming" }),
        ];

        yield* Effect.forEach(ids, (id) => answerOf(control, id));
        const arrivals = lrclib.requests().map((request) => request.at);

        expect(arrivals).toHaveLength(6);

        const gaps = arrivals.slice(1).map((at, index) => at - (arrivals[index] ?? at));

        expect(Math.min(...gaps)).toBeGreaterThanOrEqual(GAP_MS - 5);
      }),
    ));

  it("drops the answer of a lookup whose lease ran out, and asks again", () =>
    runScoped(
      Effect.gen(function* () {
        const { promise: held, resolve: release } = Promise.withResolvers<void>();
        let calls = 0;

        const { control, lrclib } = yield* start(async () => {
          calls += 1;

          if (calls === 1) await held;

          return found(calls);
        });

        const lookupId = yield* control.queueLookup(SYMPATHY);

        yield* Effect.sync(() => lrclib.requests()).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("10 millis"),
            until: (requests) => requests.length > 0,
            times: 500,
          }),
        );

        yield* control.expireLease(lookupId);
        yield* Effect.sync(release);
        const lookup = yield* answerOf(control, lookupId);

        expect(yield* control.droppedSaves).toEqual([lookupId]);
        // The second try answered it.
        expect(lookup).toMatchObject({
          state: { status: "found" },
          answer: { kind: "found", recordId: 2 },
        });
      }),
    ));
});

describe("the in-memory lyrics queue", () => {
  it("lists ten lookups at most, songs playing first, the newest of them first", () =>
    runScoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(layerMemory);
        const control = yield* MemoryMediaBackendControl.pipe(Effect.provideContext(context));
        const backend = yield* MediaBackend.pipe(Effect.provideContext(context));
        const backfill = Array.from({ length: 12 }, (_, index) => `Backfill ${String(index)}`);

        yield* Effect.forEach(backfill, (title) => control.queueLookup({ ...SYMPATHY, title }));
        yield* control.queueLookup({ ...SYMPATHY, title: "Played first" }, "play");
        yield* Effect.sleep("5 millis");
        yield* control.queueLookup({ ...SYMPATHY, title: "Played last" }, "play");

        const queue = yield* backend.lyricQueue.pipe(Stream.runHead);

        expect(Option.getOrThrow(queue).map((entry) => entry.query.title)).toEqual([
          "Played last",
          "Played first",
          ...backfill.slice(0, 8),
        ]);
      }),
    ));
});
