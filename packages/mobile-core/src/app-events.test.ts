import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";

import { AppEvent, AppEventsRequest, MAX_APP_EVENTS } from "@media/contracts/diagnostics";
import { RateLimited } from "@media/contracts/errors";
import { TransportError } from "@media/sdk/effect";
import { createMediaServer } from "@media/sdk/promise";
import { Option, Predicate, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  CRASH_READ_DELAY_MS,
  FLUSH_DELAY_MS,
  HOME_WAIT_MS,
  MAX_PENDING_EVENTS,
  MAX_PROCESS_AGE_MS,
  OPEN_WAIT_MS,
  createAppEvents,
  reportUncaught,
  touchTime,
} from "./app-events";
import type { AppEventsOptions, GlobalErrorUtils, Owner, SendAppEvents } from "./app-events";

/** The monotonic clock at the start of each test, as `CACurrentMediaTime` reads after boot. */
const BOOTED = 86_400_000;

const WALL = 1_800_000_000_000;

const LUCIA: Owner = { server: "http://media.local", account: "user_lucia" };

const MATEO: Owner = { server: "http://media.local", account: "user_mateo" };

interface Timer {
  readonly at: number;
  readonly run: () => void;
  cancelled: boolean;
}

/** The crash file: its contents, and how often it was read. */
interface File {
  contents: string | null;
  reads: number;
}

const emptyFile = (): File => ({ contents: null, reads: 0 });

/**
 * A device for one app: a monotonic clock that timers run on, a wall clock that may step on its
 * own, and a crash file.
 */
const device = (file: File = emptyFile()) => {
  const clock = { mono: BOOTED, wall: WALL };
  const timers: Array<Timer> = [];

  const advance = (ms: number): void => {
    const until = clock.mono + ms;

    for (;;) {
      const due = timers
        .filter((timer) => !timer.cancelled && timer.at <= until)
        .reduce<Timer | null>(
          (first, timer) => (first === null || timer.at < first.at ? timer : first),
          null,
        );

      if (due === null) break;
      due.cancelled = true;
      clock.wall += due.at - clock.mono;
      clock.mono = due.at;
      due.run();
    }

    clock.wall += until - clock.mono;
    clock.mono = until;
  };

  const open = (overrides: Partial<AppEventsOptions> = {}) =>
    createAppEvents({
      app: "music",
      release: "0.9.0",
      development: false,
      processStartedAt: clock.mono - 900,
      startedInBackground: false,
      crashes: {
        read: () => {
          file.reads += 1;

          return file.contents;
        },
        write: (contents) => {
          file.contents = contents;
        },
      },
      monotonicNow: () => clock.mono,
      wallNow: () => clock.wall,
      schedule: (ms, run) => {
        const timer: Timer = { at: clock.mono + ms, run, cancelled: false };

        timers.push(timer);

        return () => {
          timer.cancelled = true;
        };
      },
      ...overrides,
    });

  return { clock, file, open, advance };
};

/** A server that answers each batch as `answer` says and keeps what it was sent. */
const recordingSender = () => {
  const requests: Array<AppEventsRequest> = [];
  const answer = { next: (): Promise<"sent" | "signed-out"> => Promise.resolve("sent") };

  const send: SendAppEvents = (request) => {
    requests.push(request);

    return answer.next();
  };

  return {
    send,
    answer,
    requests,
    events: (): ReadonlyArray<AppEvent> =>
      requests.flatMap((request) => request.events.map((queued) => queued.event)),
  };
};

const offline = () =>
  Promise.reject(
    new TransportError({ operation: "appEvents", message: "offline", cause: "no route" }),
  );

const nothing = (): void => undefined;

const settled = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/** An error as Hermes throws it, with a stack of two frames. */
const thrown = (message: string, name = "TypeError"): Error => {
  const error = new Error(message);

  error.name = name;
  error.stack = [
    `${name}: ${message}`,
    "    at Album (http://127.0.0.1:8081/index.bundle//&platform=ios&dev=false:4123:17)",
    "    at render (address at /var/containers/Bundle/Application/X/Lar.app/main.jsbundle:1:52344)",
  ].join("\n");

  return error;
};

describe("launch timing", () => {
  it("records Home's screen and its content as two marks, each from the process start", async () => {
    const phone = device();
    const events = phone.open();
    const server = recordingSender();

    events.attach(LUCIA, server.send);
    events.landed("home");
    events.firstScreenVisible(BOOTED + 7300);
    events.homeContentVisible(BOOTED + 7566, "network");
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.requests[0]).toMatchObject({ platform: "ios", app: "music", release: "0.9.0" });
    expect(server.events()).toEqual([
      {
        _tag: "Launched",
        firstScreenVisibleMs: 8200,
        homeContent: { ms: 8466, source: "network" },
      },
    ]);
  });

  it("never raises an earlier content mark to the screen mark", async () => {
    const phone = device();
    const events = phone.open();
    const server = recordingSender();

    events.attach(LUCIA, server.send);
    events.landed("home");
    events.homeContentVisible(BOOTED + 120, "downloads");
    events.firstScreenVisible(BOOTED + 160);
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.events()).toEqual([
      {
        _tag: "Launched",
        firstScreenVisibleMs: 1060,
        homeContent: { ms: 1020, source: "downloads" },
      },
    ]);
  });

  it("sends the launch without Home's content when none showed within a minute", async () => {
    const phone = device();
    const events = phone.open();
    const server = recordingSender();

    events.attach(LUCIA, server.send);
    events.landed("home");
    events.firstScreenVisible(BOOTED + 100);
    phone.advance(HOME_WAIT_MS + FLUSH_DELAY_MS);
    await settled();

    expect(server.events()).toEqual([{ _tag: "Launched", firstScreenVisibleMs: 1000 }]);
  });

  it("drops a launch that went to the background before Home showed", async () => {
    const phone = device();
    const events = phone.open();
    const server = recordingSender();

    events.attach(LUCIA, server.send);
    events.landed("home");
    events.appStateChanged("background");
    events.appStateChanged("active");
    events.firstScreenVisible(BOOTED + 100);
    events.homeContentVisible(BOOTED + 100, "network");
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.events()).toEqual([]);
    expect(events.launchPending()).toBe(false);
  });

  it("times no launch that landed elsewhere first", async () => {
    const phone = device();
    const events = phone.open();
    const server = recordingSender();

    events.attach(LUCIA, server.send);
    events.landed("elsewhere");
    events.landed("home");
    events.firstScreenVisible(BOOTED + 100);
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.events()).toEqual([]);
  });

  it.each<[string, Partial<AppEventsOptions>]>([
    ["the process start is unknown or prewarmed", { processStartedAt: null }],
    ["the JavaScript started in the background", { startedInBackground: true }],
    [
      "the process ran long before its JavaScript",
      { processStartedAt: BOOTED - MAX_PROCESS_AGE_MS - 1 },
    ],
  ])("times no launch when %s", (_case, overrides) => {
    const events = device().open(overrides);

    expect(events.launchPending()).toBe(false);
  });
});

describe("screen-open timing", () => {
  it("times the touch to the frame its content showed, with the cache state it mounted with", async () => {
    const phone = device();
    const events = phone.open({ processStartedAt: null });
    const server = recordingSender();

    events.attach(LUCIA, server.send);
    phone.advance(40);
    events.pressed("album", "album_1", BOOTED + 10);
    const claim = Option.getOrThrow(events.claimOpen("album", "album_1", "album-key-1", "fetched"));

    events.openContentVisible(claim, BOOTED + 277);
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.events()).toEqual([
      {
        _tag: "ScreenOpened",
        screen: "album",
        id: "album_1",
        cache: "fetched",
        contentVisibleMs: 267,
      },
    ]);
  });

  it("measures on the monotonic clock, so a wall clock step changes nothing", async () => {
    const phone = device();
    const events = phone.open({ processStartedAt: null });
    const server = recordingSender();

    events.attach(LUCIA, server.send);
    events.pressed("title", "title_1", BOOTED);
    const claim = Option.getOrThrow(events.claimOpen("title", "title_1", "t", "kept"));

    phone.clock.wall -= 500;
    events.openContentVisible(claim, BOOTED + 81);
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.events()).toEqual([
      { _tag: "ScreenOpened", screen: "title", id: "title_1", cache: "kept", contentVisibleMs: 81 },
    ]);
  });

  it("never lets an earlier press's screen close a later press's timer", async () => {
    const phone = device();
    const events = phone.open({ processStartedAt: null });
    const server = recordingSender();

    events.attach(LUCIA, server.send);
    events.pressed("album", "album_1", BOOTED);
    const first = Option.getOrThrow(events.claimOpen("album", "album_1", "k1", "fetched"));

    phone.advance(100);
    events.pressed("album", "album_2", BOOTED + 100);
    const second = Option.getOrThrow(events.claimOpen("album", "album_2", "k2", "fetched"));

    events.openContentVisible(first, BOOTED + 900);
    events.openContentVisible(second, BOOTED + 400);
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.events()).toEqual([
      expect.objectContaining({ id: "album_2", contentVisibleMs: 300 }),
    ]);
  });

  it("closes a timer only for the route instance that claimed it", async () => {
    const phone = device();
    const events = phone.open({ processStartedAt: null });
    const server = recordingSender();

    events.attach(LUCIA, server.send);
    events.pressed("artist", "artist_1", BOOTED);
    const claim = Option.getOrThrow(events.claimOpen("artist", "artist_1", "k1", "kept"));

    expect(events.claimOpen("artist", "artist_1", "k2", "kept")).toEqual(Option.none());
    events.openContentVisible({ ...claim, route: "k2" }, BOOTED + 50);
    events.openContentVisible(claim, BOOTED + 70);
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.events()).toEqual([expect.objectContaining({ contentVisibleMs: 70 })]);
  });

  it("reads the touch's time from a press, and none from a press with no touch", () => {
    expect(touchTime({ nativeEvent: { timestamp: 86_400_123.5 } })).toEqual(
      Option.some(86_400_123.5),
    );
    expect(touchTime({ nativeEvent: {} })).toEqual(Option.none());
    expect(touchTime({ nativeEvent: undefined })).toEqual(Option.none());
  });

  it("gives a press to its own screen and id only", () => {
    const events = device().open({ processStartedAt: null });

    events.pressed("album", "album_1", BOOTED);

    expect(events.claimOpen("artist", "album_1", "k", "kept")).toEqual(Option.none());
    expect(events.claimOpen("album", "album_2", "k", "kept")).toEqual(Option.none());
    expect(Option.isSome(events.claimOpen("album", "album_1", "k", "kept"))).toBe(true);
  });

  it("drops an open whose screen blurred, or whose app left for the background", async () => {
    const phone = device();
    const events = phone.open({ processStartedAt: null });
    const server = recordingSender();

    events.attach(LUCIA, server.send);
    events.pressed("title", "title_1", BOOTED);
    const blurred = Option.getOrThrow(events.claimOpen("title", "title_1", "k1", "fetched"));

    events.releaseOpen(blurred);
    events.openContentVisible(blurred, BOOTED + 200);
    phone.advance(300);
    events.pressed("title", "title_2", BOOTED + 300);
    const left = Option.getOrThrow(events.claimOpen("title", "title_2", "k2", "fetched"));

    events.appStateChanged("background");
    events.appStateChanged("active");
    events.openContentVisible(left, BOOTED + 500);
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.events()).toEqual([]);
  });

  it("drops a press too old to claim, and content that showed too late", async () => {
    const phone = device();
    const events = phone.open({ processStartedAt: null });
    const server = recordingSender();

    events.attach(LUCIA, server.send);
    events.pressed("title", "title_1", BOOTED);
    const late = Option.getOrThrow(events.claimOpen("title", "title_1", "k1", "fetched"));

    events.openContentVisible(late, BOOTED + OPEN_WAIT_MS + 1);
    events.pressed("title", "title_2", BOOTED);
    phone.advance(OPEN_WAIT_MS + 1);

    expect(events.claimOpen("title", "title_2", "k2", "fetched")).toEqual(Option.none());
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.events()).toEqual([]);
  });
});

describe("error reports", () => {
  const PRIVATE = ["Lucía", "Garc", "Sintel", "192.168", "lucia", "mkv", "Movies/"];

  it("carries nothing from the error's text, only its class, frames, and route pattern", async () => {
    const phone = device();
    const events = phone.open({ processStartedAt: null });
    const server = recordingSender();

    events.attach(LUCIA, server.send);
    events.routeChanged("/(app)/(tabs)/(home,playlists,library,search)/album/[id]");
    events.caught(
      thrown("Lucía García can't play Sintel.mkv from http://192.168.1.20:8080/Movies/x"),
      "render",
      false,
    );
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.events()).toEqual([
      {
        _tag: "ErrorCaught",
        kind: "render",
        fatal: false,
        route: "/(app)/(tabs)/(home,playlists,library,search)/album/[id]",
        errorClass: "TypeError",
        frames: [
          { fn: "Album", file: "index.bundle", line: 4123, column: 17 },
          { fn: "render", file: "main.jsbundle", line: 1, column: 52344 },
        ],
      },
    ]);

    const wire = JSON.stringify(server.requests);

    for (const text of PRIVATE) expect(wire).not.toContain(text);
  });

  it("adds no frames from a message whose lines look like a stack", async () => {
    const phone = device();
    const events = phone.open({ processStartedAt: null });
    const server = recordingSender();

    events.attach(LUCIA, server.send);
    events.caught(
      thrown("bad\n    at Lucia (Garcia.js:1:2)\n    at Sintel (x.bundle:3:4)"),
      "uncaught",
      false,
    );
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.events()).toEqual([
      expect.objectContaining({
        frames: [
          { fn: "Album", file: "index.bundle", line: 4123, column: 17 },
          { fn: "render", file: "main.jsbundle", line: 1, column: 52344 },
        ],
      }),
    ]);
  });

  it("names a free-form error name, a thrown value, and an SDK error by what they are", async () => {
    const phone = device();
    const events = phone.open({ processStartedAt: null });
    const server = recordingSender();
    const requestId = "6f1c2b8e-3d4a-4f5b-9c6d-7e8f9a0b1c2d";

    events.attach(LUCIA, server.send);
    events.caught(thrown("x", "Lucía's error"), "uncaught", false);
    events.caught("Lucía García", "unhandled-rejection", false);
    events.caught({ _tag: "TransportError", requestId, message: "Lucía" }, "uncaught", false);
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.events()).toEqual([
      expect.objectContaining({ errorClass: "Error" }),
      expect.objectContaining({ errorClass: "string", frames: [] }),
      expect.objectContaining({ errorClass: "TransportError", requestId }),
    ]);
    expect(JSON.stringify(server.requests)).not.toContain("Lucía");
  });

  it("has no field that holds an error's message, name, or stack", () => {
    expect(Object.keys(AppEvent.cases.ErrorCaught.fields).toSorted()).toEqual([
      "_tag",
      "errorClass",
      "fatal",
      "frames",
      "kind",
      "requestId",
      "route",
    ]);
  });

  it("names the root for a route that is not a pattern", async () => {
    const phone = device();
    const events = phone.open({ processStartedAt: null });
    const server = recordingSender();

    events.attach(LUCIA, server.send);
    events.routeChanged("/album/Lucía García");
    events.caught(thrown("x"), "uncaught", false);
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.events()).toEqual([expect.objectContaining({ route: "/" })]);
  });

  it("sends a repeated error once per window", async () => {
    const phone = device();
    const events = phone.open({ processStartedAt: null });
    const server = recordingSender();

    events.attach(LUCIA, server.send);
    events.caught(thrown("x"), "uncaught", false);
    events.caught(thrown("y"), "uncaught", false);
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.events()).toHaveLength(1);
  });

  it("keeps React Native's handler running and never throws, even when reading the error throws", () => {
    const phone = device();
    const events = phone.open({ processStartedAt: null });
    const handled: Array<boolean | undefined> = [];

    let handler: (cause: unknown, isFatal?: boolean) => void = (_cause, isFatal) => {
      handled.push(isFatal);
    };

    const errorUtils: GlobalErrorUtils = {
      getGlobalHandler: () => handler,
      setGlobalHandler: (next) => {
        handler = next;
      },
    };

    reportUncaught(events, { errorUtils, hermes: null, development: false });
    events.attach(LUCIA, recordingSender().send);
    const hostile = new Error("x");

    for (const key of ["message", "stack", "name", "_tag", "constructor"]) {
      Object.defineProperty(hostile, key, {
        get: () => {
          throw new Error(`no ${key}`);
        },
      });
    }

    expect(() => handler(hostile, true)).not.toThrow();
    expect(handled).toEqual([true]);
    expect(phone.file.contents).toContain('"errorClass":"Error"');
  });

  it("reports unhandled rejections Hermes tracks", async () => {
    const phone = device();
    const events = phone.open({ processStartedAt: null });
    const tracking: Array<{ readonly onUnhandled: (id: number, cause: unknown) => void }> = [];

    reportUncaught(events, {
      errorUtils: { getGlobalHandler: () => () => undefined, setGlobalHandler: () => undefined },
      hermes: {
        enablePromiseRejectionTracker: (options: (typeof tracking)[number]) =>
          tracking.push(options),
      },
      development: false,
    });

    const server = recordingSender();

    events.attach(LUCIA, server.send);
    tracking[0]?.onUnhandled(1, thrown("nobody awaited this"));
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.events()).toEqual([
      expect.objectContaining({
        kind: "unhandled-rejection",
        fatal: false,
        errorClass: "TypeError",
      }),
    ]);
  });
});

describe("owners", () => {
  it("never sends a report queued under one account under another", async () => {
    const phone = device();
    const events = phone.open({ processStartedAt: null });
    const lucia = recordingSender();
    const mateo = recordingSender();

    lucia.answer.next = offline;
    events.attach(LUCIA, lucia.send);
    events.caught(thrown("while the server was down"), "uncaught", false);
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(lucia.requests).toHaveLength(1);

    events.signedOut();
    events.attach(MATEO, mateo.send);
    events.caught(thrown("Mateo's own", "RangeError"), "uncaught", false);
    phone.advance(FLUSH_DELAY_MS);
    events.appStateChanged("background");
    await settled();

    expect(mateo.events()).toEqual([expect.objectContaining({ errorClass: "RangeError" })]);
  });

  it("drops one account's waiting events when another signs in without a sign-out between", async () => {
    const phone = device();
    const events = phone.open({ processStartedAt: null });
    const lucia = recordingSender();
    const mateo = recordingSender();

    events.attach(LUCIA, lucia.send)();
    events.caught(thrown("Lucía's"), "uncaught", false);
    events.attach(MATEO, mateo.send);
    phone.advance(FLUSH_DELAY_MS);
    events.appStateChanged("background");
    await settled();

    expect(lucia.requests).toEqual([]);
    expect(mateo.requests).toEqual([]);
  });

  it("puts nothing back for an account whose batch failed after another signed in", async () => {
    const phone = device();
    const events = phone.open({ processStartedAt: null });
    const mateo = recordingSender();
    let fail = nothing;

    events.attach(
      LUCIA,
      () =>
        new Promise((_resolve, reject) => {
          fail = () => {
            reject(new TransportError({ operation: "appEvents", message: "offline", cause: "x" }));
          };
        }),
    );
    events.caught(thrown("Lucía's"), "uncaught", false);
    phone.advance(FLUSH_DELAY_MS);
    events.signedOut();
    events.attach(MATEO, mateo.send);
    fail();
    await settled();
    events.caught(thrown("Mateo's", "RangeError"), "uncaught", false);
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(mateo.events()).toEqual([expect.objectContaining({ errorClass: "RangeError" })]);
  });

  it("keeps nothing that happened while nobody was signed in", async () => {
    const phone = device();
    const events = phone.open({ processStartedAt: null });
    const server = recordingSender();

    events.caught(thrown("before sign-in"), "uncaught", false);
    events.caught(thrown("fatal before sign-in"), "uncaught", true);
    events.attach(LUCIA, server.send);
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.requests).toEqual([]);
    expect(phone.file.contents).toBeNull();
  });

  it("saves a fatal error under its owner and sends it after a later launch's first frame", async () => {
    const file = emptyFile();
    const crashing = device(file);
    const before = crashing.open({ processStartedAt: null });
    const server = recordingSender();

    before.attach(LUCIA, server.send);
    before.caught(thrown("fatal one"), "uncaught", true);
    crashing.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.requests).toEqual([]);
    expect(file.contents).toContain(LUCIA.account);

    const relaunched = device(file);

    relaunched.clock.wall = WALL + 3_600_000;
    file.reads = 0;
    const after = relaunched.open();

    after.attach(LUCIA, server.send);
    after.landed("home");
    relaunched.advance(10);
    await settled();

    expect(file.reads).toBe(0);
    expect(server.requests).toEqual([]);

    after.firstScreenVisible(BOOTED + 5);
    relaunched.advance(0);

    expect(file.reads).toBe(1);
    relaunched.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.requests[0]?.events.map((queued) => queued.ageMs)).toEqual([
      3_600_000 + 10 + FLUSH_DELAY_MS,
    ]);
    expect(server.events()).toEqual([expect.objectContaining({ fatal: true })]);
    expect(file.contents).toBe("[]");
  });

  it("reads the crash file a moment after the first screen rendered when no mark came", async () => {
    const file = emptyFile();
    const events = device(file);
    const reporter = events.open({ processStartedAt: null });

    reporter.attach(LUCIA, recordingSender().send);
    reporter.landed("elsewhere");
    events.advance(CRASH_READ_DELAY_MS - 1);

    expect(file.reads).toBe(0);

    events.advance(1);

    expect(file.reads).toBe(1);
  });

  it("drops another account's saved crash, and clears the file on sign-out", async () => {
    const file = emptyFile();
    const crashing = device(file);

    crashing.open({ processStartedAt: null }).attach(LUCIA, recordingSender().send);
    const before = crashing.open({ processStartedAt: null });

    before.attach(LUCIA, recordingSender().send);
    before.caught(thrown("Lucía's crash"), "uncaught", true);

    const relaunched = device(file);
    const after = relaunched.open({ processStartedAt: null });
    const mateo = recordingSender();

    after.attach(MATEO, mateo.send);
    after.landed("home");
    relaunched.advance(CRASH_READ_DELAY_MS);
    relaunched.advance(FLUSH_DELAY_MS);
    await settled();

    expect(mateo.requests).toEqual([]);
    expect(file.contents).toBe("[]");

    after.caught(thrown("Mateo's crash"), "uncaught", true);

    expect(file.contents).toContain(MATEO.account);

    after.signedOut();

    expect(file.contents).toBe("[]");
  });

  it("keeps a saved crash while the server can't be reached, and drops it once the server refuses it", async () => {
    const file = emptyFile();
    const phone = device(file);
    const crashed = phone.open({ processStartedAt: null });

    crashed.attach(LUCIA, recordingSender().send);
    crashed.caught(thrown("kept"), "uncaught", true);
    const events = phone.open({ processStartedAt: null });
    const server = recordingSender();

    server.answer.next = offline;
    events.attach(LUCIA, server.send);
    events.landed("home");
    phone.advance(CRASH_READ_DELAY_MS + FLUSH_DELAY_MS);
    await settled();

    expect(server.requests).toHaveLength(1);
    expect(file.contents).toContain("TypeError");

    server.answer.next = () =>
      Promise.reject(new RateLimited({ message: "Too many app events", retryAfterSeconds: 30 }));
    events.appStateChanged("background");
    await settled();

    expect(server.requests).toHaveLength(2);
    expect(file.contents).toBe("[]");
  });
});

describe("sending", () => {
  it("sends one batch as the app leaves for the background, and nothing more until it is back", async () => {
    const phone = device();
    const events = phone.open({ processStartedAt: null });
    const server = recordingSender();

    events.attach(LUCIA, server.send);

    for (let index = 0; index < MAX_APP_EVENTS + 10; index += 1) {
      events.pressed("title", `title_${String(index)}`, phone.clock.mono);

      const claim = Option.getOrThrow(
        events.claimOpen("title", `title_${String(index)}`, "k", "kept"),
      );

      events.openContentVisible(claim, phone.clock.mono + 1);
    }

    events.appStateChanged("background");
    await settled();
    await settled();
    phone.advance(FLUSH_DELAY_MS * 3);
    await settled();

    expect(server.requests.map((request) => request.events.length)).toEqual([MAX_APP_EVENTS]);

    events.appStateChanged("active");
    await settled();

    expect(server.requests).toHaveLength(1);

    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.requests.map((request) => request.events.length)).toEqual([MAX_APP_EVENTS, 10]);
  });

  it("starts no request when a sender attaches in the background", async () => {
    const phone = device();
    const events = phone.open({ processStartedAt: null, startedInBackground: true });
    const server = recordingSender();

    events.attach(LUCIA, () => Promise.resolve("sent"));
    events.caught(thrown("x"), "uncaught", false);
    events.attach(LUCIA, server.send);
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.requests).toEqual([]);
  });

  it("keeps the newest events past the cap, and sends them in batches the server takes", async () => {
    const phone = device();
    const events = phone.open({ processStartedAt: null });
    const server = recordingSender();
    const parked = recordingSender();

    parked.answer.next = offline;
    events.attach(LUCIA, parked.send)();

    for (let index = 0; index < MAX_PENDING_EVENTS + 20; index += 1) {
      events.pressed("title", `title_${String(index)}`, phone.clock.mono);

      const claim = Option.getOrThrow(
        events.claimOpen("title", `title_${String(index)}`, "k", "kept"),
      );

      events.openContentVisible(claim, phone.clock.mono + 1);
    }

    events.attach(LUCIA, server.send);
    await settled();
    await settled();

    expect(server.requests.map((request) => request.events.length)).toEqual([
      MAX_APP_EVENTS,
      MAX_PENDING_EVENTS - MAX_APP_EVENTS,
    ]);
    expect(server.events()[0]).toMatchObject({ id: "title_20" });
  });

  it("reaches the media server's route through the SDK as the signed-in person", async () => {
    const bodies: Array<{ readonly authorization: string | undefined; readonly body: string }> = [];

    const http = createServer((request: IncomingMessage, response: ServerResponse) => {
      let body = "";

      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });

      request.on("end", () => {
        bodies.push({ authorization: request.headers.authorization, body });
        response.writeHead(204).end();
      });
    });

    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();

    if (address === null || Predicate.isString(address))
      throw new Error("The server is not on TCP");

    const media = createMediaServer({
      url: `http://127.0.0.1:${String(address.port)}`,
      accessToken: () => Promise.resolve("jwt-1"),
    });

    const phone = device();
    const events = phone.open();

    events.attach(LUCIA, media.reportAppEvents);
    events.landed("home");
    events.firstScreenVisible(BOOTED + 100);
    events.homeContentVisible(BOOTED + 100, "network");
    events.appStateChanged("background");
    await new Promise((resolve) => setTimeout(resolve, 200));
    http.close();

    expect(bodies.map((each) => each.authorization)).toEqual(["Bearer jwt-1"]);

    const decoded = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.toCodecJson(AppEventsRequest)),
    )(bodies[0]?.body);

    expect(decoded.events).toEqual([
      {
        ageMs: 0,
        event: {
          _tag: "Launched",
          firstScreenVisibleMs: 1000,
          homeContent: { ms: 1000, source: "network" },
        },
      },
    ]);
  });
});
