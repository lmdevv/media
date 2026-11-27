import { createServer } from "node:http";
import type { Server } from "node:http";

import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeOutput } from "@/player/fake-output";
import { NativeEngine, observedOpen } from "@/player/native-engine";

import {
  coverFailed,
  coverUnread,
  launchDoubt,
  listenForMediaRequests,
  mediaRequest,
} from "./media-requests";
import { reachWatch } from "./reach-watch";
import type { WatchTimers } from "./reach-watch";

const Address = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Int }));

/** A media service answering each path with the status the test set, 502 by default. */
const mediaService = async () => {
  const statuses = new Map<string, number>();

  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fake").pathname;

    response.writeHead(statuses.get(path) ?? 502).end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  return {
    base: `http://127.0.0.1:${String(Address(server.address()).port)}`,
    statuses,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
};

/** Timers the test moves by hand, so real requests run on real ones. */
const handClock = () => {
  let at = 0;
  const tasks = new Map<{ readonly at: number }, () => void>();

  const timers: WatchTimers = {
    now: () => at,
    after: (ms, run) => {
      const task = { at: at + ms };

      tasks.set(task, run);

      return () => {
        tasks.delete(task);
      };
    },
  };

  /** Runs each task due by now, one at a time, letting its work settle in between. */
  const runDue = async (): Promise<void> => {
    const due = Array.from(tasks).find(([task]) => task.at <= at);

    if (due === undefined) return;
    tasks.delete(due[0]);
    due[1]();
    await new Promise((resolve) => setImmediate(resolve));
    await runDue();
  };

  const advance = async (ms: number): Promise<void> => {
    at += ms;
    await runDue();
  };

  return { timers, advance, scheduled: () => tasks.size };
};

const UP = { connected: true, waitingSince: null };

/** A needed watch with its socket open, listening at `base`, on a server whose health the test sets. */
const watching = (base: string, clock: ReturnType<typeof handClock>) => {
  const health = { up: true, sent: 0 };

  const watch = reachWatch(() => {
    health.sent += 1;

    return Promise.resolve(health.up);
  }, clock.timers);

  watch.need(true);
  watch.connection(UP);
  const stop = listenForMediaRequests(base, watch);

  return {
    watch,
    health,
    close: () => {
      stop();
      watch.close();
    },
  };
};

/** iOS's words for a cover the media service answered with `code`. */
const status = (code: number) => ({
  error: `Download marked as failed because of invalid response status code ${String(code)}`,
});

/** Waits, on real time, until `done` holds; fails after two seconds. */
const until = async (done: () => boolean, waited = 0): Promise<void> => {
  if (done()) return;

  if (waited > 2000) throw new Error("timed out");
  await new Promise((resolve) => setTimeout(resolve, 10));
  await until(done, waited + 10);
};

let media: Awaited<ReturnType<typeof mediaService>>;

let clock: ReturnType<typeof handClock>;

const closing: Array<() => void> = [];

beforeEach(async () => {
  media = await mediaService();
  clock = handClock();
});

afterEach(async () => {
  for (const close of closing.splice(0)) close();
  await media.close();
});

const watchMedia = (base = media.base) => {
  const made = watching(base, clock);

  closing.push(made.close);

  return made;
};

describe("the app's requests to the media service", () => {
  it("doubts the media service when any fetch to it gets a 502, and checks it a settle later", async () => {
    const { health, watch } = watchMedia();

    health.up = false;
    await fetch(`${media.base}/media/music/stream/a?ticket=t`);
    await clock.advance(1000);

    expect(health.sent).toBe(1);

    await clock.advance(3000);

    expect(watch.lost()).toBe(true);
  });

  it("doubts it when a fetch gets no answer at all", async () => {
    const gone = await mediaService();
    const { health } = watchMedia(gone.base);

    await gone.close();
    await expect(fetch(`${gone.base}/music/art/a`)).rejects.toThrow();
    await clock.advance(1000);

    expect(health.sent).toBe(1);
  });

  it("checks nothing for a 404, a 503, the health check, the core, another server, or a stopped fetch", async () => {
    const other = await mediaService();
    const { health } = watchMedia();

    media.statuses.set("/music/art/missing", 404);
    media.statuses.set("/media/music/stream/preparing", 503);
    const stop = new AbortController();

    stop.abort();
    await fetch(`${media.base}/music/art/missing`);
    await fetch(`${media.base}/media/music/stream/preparing`);
    await fetch(`${media.base}/api/health`);
    await fetch(`${media.base}/convex/api/action`);
    await fetch(`${other.base}/media/music/stream/a`);
    await expect(
      fetch(`${media.base}/media/music/stream/a`, { signal: stop.signal }),
    ).rejects.toThrow();
    await clock.advance(60_000);

    expect(health.sent).toBe(0);
    expect(clock.scheduled()).toBe(0);
    await other.close();
  });

  it("doubts it when the next song's range probe gets a 502", async () => {
    const { health } = watchMedia();
    const engine = new NativeEngine((url) => new FakeOutput(url, "next"));

    engine.preload({
      key: "next",
      url: `${media.base}/media/music/stream/next?p=aac-320`,
      durationMs: 100_000,
      finished: false,
    });

    await until(() => clock.scheduled() > 0);
    await clock.advance(1000);

    expect(health.sent).toBe(1);
    engine.unload();
  });

  it("doubts it when the native player of a preloaded song fails, which no fetch shows", async () => {
    const { health } = watchMedia();
    const opened: Array<FakeOutput> = [];

    const engine = new NativeEngine(
      observedOpen((url) => {
        const output = new FakeOutput(url, `player-${String(opened.length)}`);

        opened.push(output);

        return output;
      }, mediaRequest),
    );

    engine.preload({
      key: "next",
      url: `${media.base}/media/music/stream/next?p=aac-320`,
      durationMs: 100_000,
      finished: true,
    });

    await until(() => opened.length > 0);
    opened[0]?.fail("The server is not reachable");
    opened[0]?.fail("The server is not reachable");
    await clock.advance(1000);

    expect(opened).toHaveLength(1);
    expect(health.sent).toBe(1);
    engine.unload();
  });

  it("doubts each cover once per watch, from its image or its tint, however often it fails", async () => {
    const { health } = watchMedia();
    const cover = `${media.base}/music/art/abc`;

    const scroll = async (left: number): Promise<void> => {
      if (left === 0) return;

      for (const _ of [1, 2, 3, 4]) {
        coverFailed(`${cover}?ticket=${String(left)}`)({
          error: "Image data could not be decoded",
        });
      }

      await clock.advance(1000);
      await scroll(left - 1);
    };

    await scroll(6);
    expect(coverUnread(cover)()).toBeNull();
    await clock.advance(1000);

    expect(health.sent).toBe(1);
  });

  it("reads a cover's status from iOS's words: a missing cover checks nothing, a 502 checks", async () => {
    const { health } = watchMedia();

    coverFailed(`${media.base}/music/art/missing`)(status(404));
    await clock.advance(10_000);

    expect(health.sent).toBe(0);

    coverFailed(`${media.base}/music/art/broken`)(status(502));
    await clock.advance(1000);

    expect(health.sent).toBe(1);
  });
});

describe("a request's watch", () => {
  it("hears nothing, and checks nothing, for a request an earlier connection or sign-in started", async () => {
    const earlier = watching(media.base, clock);
    const started = mediaRequest(`${media.base}/media/music/stream/a`);

    earlier.close();
    const { watch, health } = watchMedia();

    health.up = false;
    started(null);
    await clock.advance(60_000);

    expect(health.sent).toBe(0);
    expect(watch.lost()).toBe(false);
  });

  it("hears nothing for a request to the server the app was connected to before", async () => {
    const before = await mediaService();
    const { watch, health } = watchMedia();

    health.up = false;
    mediaRequest(`${before.base}/media/music/stream/a`)(null);
    coverFailed(`${before.base}/music/art/a`)({ error: "Could not connect to the server." });
    await clock.advance(60_000);

    expect(health.sent).toBe(0);
    expect(watch.lost()).toBe(false);
    await before.close();
  });

  it("hears nothing for a request a closed watch started, though no watch listens until the next", async () => {
    const earlier = watching(media.base, clock);
    const started = mediaRequest(`${media.base}/media/music/stream/a`);

    earlier.close();
    started(null);
    const { health } = watchMedia();

    await clock.advance(60_000);

    expect(health.sent).toBe(0);
  });

  it("keeps the launch read's doubt for the connection's first watch, and only while it lives", async () => {
    const launch = launchDoubt();
    const first = watchMedia();
    const stopFirst = launch.take(first.watch);

    launch.failed();
    await clock.advance(1000);

    expect(first.health.sent).toBe(1);

    stopFirst();
    first.close();
    launch.failed();
    const later = watchMedia();

    launch.take(later.watch);
    await clock.advance(60_000);

    expect(later.health.sent).toBe(0);
  });

  it("never hears a late launch failure once the first watch closed", async () => {
    const launch = launchDoubt();
    const first = watching(media.base, clock);
    const stopFirst = launch.take(first.watch);

    stopFirst();
    first.close();
    launch.failed();
    const { watch, health } = watchMedia();

    health.up = false;
    launch.take(watch);
    await clock.advance(60_000);

    expect(health.sent).toBe(0);
    expect(watch.lost()).toBe(false);
  });

  it("calls the server gone only on failed checks, however many requests doubt it", async () => {
    const { watch, health } = watchMedia();

    const failing = Array.from({ length: 20 }, (_, n) =>
      mediaRequest(`${media.base}/media/music/stream/${String(n)}`),
    );

    for (const told of failing) told(502);

    expect(watch.lost()).toBe(false);

    await clock.advance(60_000);

    expect(health.sent).toBe(1);
    expect(watch.lost()).toBe(false);
  });
});
