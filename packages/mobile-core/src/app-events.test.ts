import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import vm from "node:vm";

import { MOVIES_ROUTES, MUSIC_ROUTES } from "@media/contracts/app-routes";
import {
  AppEvent,
  AppName,
  AppRelease,
  AppEventsRequest,
  BundleOrigin,
  ClientErrorKind,
  ClientPlatform,
  ContentSource,
  ErrorClass,
  FrameSource,
  MAX_APP_EVENTS,
  MoviesRoute,
  MusicRoute,
  OpenCache,
  TimedScreen,
} from "@media/contracts/diagnostics";
import { RateLimited, commandError } from "@media/contracts/errors";
import { TransportError } from "@media/sdk/effect";
import { createMediaServer } from "@media/sdk/promise";
import { Option, Predicate, Result, Schema } from "effect";
import * as fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";

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
import type {
  AppEventsOptions,
  FrameEnd,
  GlobalErrorUtils,
  Owner,
  SendAppEvents,
} from "./app-events";

/** The monotonic clock at the start of each test, as `CACurrentMediaTime` reads after boot. */
const BOOTED = 86_400_000;

const WALL = 1_800_000_000_000;

/** The address Metro served the app's JavaScript from, as React Native's `SourceCode` reports it. */
const SCRIPT_URL =
  "http://127.0.0.1:8081/apps/mobile/movies/node_modules/expo-router/entry.bundle?platform=ios&dev=false&transform.routerRoot=src/app";

/** The same address as a Hermes stack frame names it, its query after `//&`. */
const SCRIPT_IN_STACK =
  "http://127.0.0.1:8081/apps/mobile/movies/node_modules/expo-router/entry.bundle//&platform=ios&dev=false&transform.routerRoot=src/app";

/** A frame mark's refresh at monotonic time `at`, on time unless `hitched`. */
const drawn = (at: number, hitched = false): FrameEnd => ({ at, hitched });

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
      scriptUrl: SCRIPT_URL,
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
/**
 * An error of `Type` as Hermes throws it from the bundle Metro served: a frame in that bundle, one in
 * another file, and one in native code.
 */
const thrown = (message: string, Type: ErrorConstructor = TypeError): Error => {
  const error = new Type(message);

  error.stack = [
    `${error.name}: ${message}`,
    `    at Album (${SCRIPT_IN_STACK}:4123:17)`,
    "    at render (address at /var/containers/Bundle/Application/X/Lar.app/main.jsbundle:1:52344)",
    "    at apply (native)",
  ].join("\n");

  return error;
};

/** The frames `thrown`'s stack reduces to. */
const THROWN_FRAMES = [
  { source: "bundle", line: 4123, column: 17 },
  { source: "other", line: 1, column: 52344 },
  { source: "native", line: 0, column: 0 },
];

describe("launch timing", () => {
  it("records Home's screen and its content as two marks, each from the process start", async () => {
    const phone = device();
    const events = phone.open();
    const server = recordingSender();

    events.attach(LUCIA, server.send);
    events.landed("home");
    events.firstScreenVisible(drawn(BOOTED + 7300, true));
    events.homeContentVisible(drawn(BOOTED + 7566), "network");
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.requests[0]).toMatchObject({
      platform: "ios",
      app: "music",
      release: "0.9.0",
      bundle: "dev-server",
    });
    expect(server.events()).toEqual([
      {
        _tag: "Launched",
        firstScreenVisibleMs: 8200,
        firstScreenHitched: true,
        homeContent: { ms: 8466, source: "network", hitched: false },
      },
    ]);
  });

  it("never raises an earlier content mark to the screen mark", async () => {
    const phone = device();
    const events = phone.open();
    const server = recordingSender();

    events.attach(LUCIA, server.send);
    events.landed("home");
    events.homeContentVisible(drawn(BOOTED + 120), "downloads");
    events.firstScreenVisible(drawn(BOOTED + 160));
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.events()).toEqual([
      {
        _tag: "Launched",
        firstScreenVisibleMs: 1060,
        firstScreenHitched: false,
        homeContent: { ms: 1020, source: "downloads", hitched: false },
      },
    ]);
  });

  it("sends the launch without Home's content when none showed within a minute", async () => {
    const phone = device();
    const events = phone.open();
    const server = recordingSender();

    events.attach(LUCIA, server.send);
    events.landed("home");
    events.firstScreenVisible(drawn(BOOTED + 100));
    phone.advance(HOME_WAIT_MS + FLUSH_DELAY_MS);
    await settled();

    expect(server.events()).toEqual([
      { _tag: "Launched", firstScreenVisibleMs: 1000, firstScreenHitched: false },
    ]);
  });

  it("drops a launch that went to the background before Home showed", async () => {
    const phone = device();
    const events = phone.open();
    const server = recordingSender();

    events.attach(LUCIA, server.send);
    events.landed("home");
    events.appStateChanged("background");
    events.appStateChanged("active");
    events.firstScreenVisible(drawn(BOOTED + 100));
    events.homeContentVisible(drawn(BOOTED + 100), "network");
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
    events.firstScreenVisible(drawn(BOOTED + 100));
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

    events.openContentVisible(claim, drawn(BOOTED + 277, true));
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.events()).toEqual([
      {
        _tag: "ScreenOpened",
        screen: "album",
        cache: "fetched",
        contentVisibleMs: 267,
        hitched: true,
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
    events.openContentVisible(claim, drawn(BOOTED + 81));
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.events()).toEqual([
      {
        _tag: "ScreenOpened",
        screen: "title",
        cache: "kept",
        contentVisibleMs: 81,
        hitched: false,
      },
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

    events.openContentVisible(first, drawn(BOOTED + 900));
    events.openContentVisible(second, drawn(BOOTED + 400));
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.events()).toEqual([expect.objectContaining({ contentVisibleMs: 300 })]);
  });

  it("closes a timer only for the route instance that claimed it", async () => {
    const phone = device();
    const events = phone.open({ processStartedAt: null });
    const server = recordingSender();

    events.attach(LUCIA, server.send);
    events.pressed("artist", "artist_1", BOOTED);
    const claim = Option.getOrThrow(events.claimOpen("artist", "artist_1", "k1", "kept"));

    expect(events.claimOpen("artist", "artist_1", "k2", "kept")).toEqual(Option.none());
    events.openContentVisible({ ...claim, route: "k2" }, drawn(BOOTED + 50));
    events.openContentVisible(claim, drawn(BOOTED + 70));
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
    events.openContentVisible(blurred, drawn(BOOTED + 200));
    phone.advance(300);
    events.pressed("title", "title_2", BOOTED + 300);
    const left = Option.getOrThrow(events.claimOpen("title", "title_2", "k2", "fetched"));

    events.appStateChanged("background");
    events.appStateChanged("active");
    events.openContentVisible(left, drawn(BOOTED + 500));
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

    events.openContentVisible(late, drawn(BOOTED + OPEN_WAIT_MS + 1));
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

  it("carries nothing from the error's text, only its class, frame positions, and route", async () => {
    const phone = device();
    const events = phone.open({ processStartedAt: null });
    const server = recordingSender();

    events.attach(LUCIA, server.send);
    events.routeChanged("/(app)/(tabs)/(library)/album/[id]");
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
        route: "/(app)/(tabs)/(library)/album/[id]",
        errorClass: "TypeError",
        frames: THROWN_FRAMES,
      },
    ]);

    const wire = JSON.stringify(server.requests);

    for (const text of PRIVATE) expect(wire).not.toContain(text);
  });

  it("sends a made-up rejection's name, title, file, and host nowhere", async () => {
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
    events.routeChanged("/(app)/(tabs)/(home)");

    // The rejection a reviewer forced through Metro's inspector: a renamed Error whose stack names
    // a person, a title, a file, and a host where a function and a bundle would be.
    const failure = new Error(
      "Fictional Nerea Marlow opened Cloud Orchard from leaf.mkv on 192.0.2.44:8112",
    );

    failure.name = "NereaMarlow";
    failure.stack = [
      `${failure.name}: ${failure.message}`,
      "    at CloudOrchard (address at /synthetic/NereaMarlow/PrivateLeaf.js:14:9)",
      "    at travel (https://fictional-lar.js/synthetic/index.bundle:18:2)",
    ].join("\n");
    tracking[0]?.onUnhandled(1, failure);
    events.caught(failure, "uncaught", true);
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.events()).toEqual([
      {
        _tag: "ErrorCaught",
        kind: "unhandled-rejection",
        fatal: false,
        route: "/(app)/(tabs)/(home)",
        errorClass: "Error",
        frames: [
          { source: "other", line: 14, column: 9 },
          { source: "other", line: 18, column: 2 },
        ],
      },
    ]);

    const sent = `${JSON.stringify(server.requests)}${phone.file.contents ?? ""}`;

    for (const word of ["NereaMarlow", "CloudOrchard", "PrivateLeaf.js", "fictional-lar.js"]) {
      expect(sent).not.toContain(word);
    }
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

    expect(server.events()).toEqual([expect.objectContaining({ frames: THROWN_FRAMES })]);
  });

  it("names an error's class from a fixed list, never by a name it gives itself", async () => {
    const phone = device();
    const events = phone.open({ processStartedAt: null });
    const server = recordingSender();
    const requestId = "6f1c2b8e-3d4a-4f5b-9c6d-7e8f9a0b1c2d";

    class LuciaGarcia extends Error {}

    const renamed = new RangeError("x");

    renamed.name = "LuciaGarcia";
    const decodeFailure = Schema.decodeUnknownResult(Schema.Finite)("Lucía");

    events.attach(LUCIA, server.send);

    const causes: ReadonlyArray<unknown> = [
      renamed,
      new LuciaGarcia("x"),
      new TransportError({ operation: "titles.get", message: "Lucía", cause: "x", requestId }),
      commandError({ code: "not_found", message: "Lucía" }),
      Result.isFailure(decodeFailure) ? decodeFailure.failure : null,
      { _tag: "LuciaGarcia", message: "x" },
      { _tag: "TypeError" },
      "Lucía García",
      undefined,
    ];

    // Each on its own route, so no two count as one repeated error.
    for (const [index, cause] of causes.entries()) {
      events.routeChanged(MUSIC_ROUTES[index] ?? "unknown");
      events.caught(cause, "uncaught", false);
    }

    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(
      server
        .events()
        .map((event) => (AppEvent.guards.ErrorCaught(event) ? event.errorClass : null)),
    ).toEqual([
      "RangeError",
      "Other",
      "TransportError",
      "NotFound",
      "SchemaError",
      "NotAnError",
      "NotAnError",
      "NotAnError",
      "NotAnError",
    ]);
    expect(server.events()[2]).not.toHaveProperty("requestId");
    expect(JSON.stringify(server.requests)).not.toContain("Lucía");
  });

  it("takes the class and request id only from an error the SDK or Effect built", async () => {
    const answered = "0b9d6f2a-7c1e-4a3b-8d5f-2e6c9a1b7d40";
    const forged = "deadbeef-cafe-4dad-8bad-feedface2027";
    const fromService = await rejectionFrom(404, answered);

    class Retrying extends TransportError {}

    const realm: unknown = vm.runInNewContext(`
      class TransportError extends Error {}
      const error = new TransportError("Iona Rhee");
      error._tag = "TransportError";
      error.requestId = "${forged}";
      error;
    `);

    const handMade = { _tag: "TransportError", message: "x", requestId: forged };

    Object.setPrototypeOf(handMade, TransportError.prototype);

    const causes: ReadonlyArray<unknown> = [
      // What a verifier rejected with in both apps: a plain object with an SDK tag and an id.
      {
        name: "IonaRhee",
        _tag: "TransportError",
        message: "Iona Rhee opened Cedar Lantern from CandleRoom.mkv on 192.0.2.73:9777",
        stack:
          "Iona Rhee opened Cedar Lantern from CandleRoom.mkv on 192.0.2.73:9777\n    at CedarLantern (https://candle-room.invalid/tmp/CandleRoom.js:31337:31415)",
        requestId: forged,
      },
      new Retrying({ operation: "titles.get", message: "x", cause: null, requestId: forged }),
      realm,
      handMade,
      new Proxy(new TransportError({ operation: "x", message: "x", cause: null }), {
        get: () => forged,
      }),
      new TransportError({ operation: "titles.get", message: "x", cause: null, requestId: forged }),
      fromService,
    ];

    // An error the SDK built keeps the id it read from the response, whatever the app writes later.
    Object.assign(Predicate.isObject(fromService) ? fromService : {}, { requestId: forged });

    const phone = device();
    const events = phone.open({ processStartedAt: null });
    const server = recordingSender();

    events.attach(LUCIA, server.send);

    for (const [index, cause] of causes.entries()) {
      events.routeChanged(MUSIC_ROUTES[index] ?? "unknown");
      events.caught(cause, "unhandled-rejection", false);
    }

    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(
      server
        .events()
        .filter(AppEvent.guards.ErrorCaught)
        .map((event) => [event.errorClass, event.requestId]),
    ).toEqual([
      ["NotAnError", undefined],
      ["TransportError", undefined],
      ["Other", undefined],
      ["NotAnError", undefined],
      ["NotAnError", undefined],
      ["TransportError", undefined],
      ["NotFound", answered],
    ]);
    expect(JSON.stringify(server.requests)).not.toContain(forged);
  });

  it("counts a frame as the bundle's only in the file the app's JavaScript came from", async () => {
    const phone = device();

    const events = phone.open({
      processStartedAt: null,
      scriptUrl: "file:///private/var/containers/Bundle/Application/X/movies.app/main.jsbundle",
    });

    const server = recordingSender();

    events.attach(LUCIA, server.send);
    events.caught(thrown("x"), "uncaught", false);
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.requests[0]).toMatchObject({ bundle: "embedded" });
    expect(server.events()).toEqual([
      expect.objectContaining({
        frames: [
          { source: "other", line: 4123, column: 17 },
          { source: "bundle", line: 1, column: 52344 },
          { source: "native", line: 0, column: 0 },
        ],
      }),
    ]);
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

  it("names a route outside the app's own list unknown", async () => {
    const phone = device();
    const events = phone.open({ processStartedAt: null });
    const server = recordingSender();

    events.attach(LUCIA, server.send);
    events.routeChanged("/album/Lucía García");
    events.caught(thrown("x"), "uncaught", false);
    events.routeChanged("/(tabs)/(home)");
    events.caught(thrown("x", RangeError), "uncaught", false);
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.events()).toEqual([
      expect.objectContaining({ route: "unknown", errorClass: "TypeError" }),
      expect.objectContaining({ route: "unknown", errorClass: "RangeError" }),
    ]);
  });

  it("sends a version the server does not read as 0.0.0", async () => {
    const phone = device();

    const events = phone.open({
      processStartedAt: null,
      release: "0.9.0-lucia.1",
      scriptUrl: null,
    });

    const server = recordingSender();

    events.attach(LUCIA, server.send);
    events.caught(thrown("x"), "uncaught", false);
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.requests[0]).toMatchObject({ release: "0.0.0", bundle: "embedded" });
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
    events.caught(thrown("Mateo's own", RangeError), "uncaught", false);
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
    events.caught(thrown("Mateo's", RangeError), "uncaught", false);
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

    after.firstScreenVisible(drawn(BOOTED + 5));
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

      events.openContentVisible(claim, drawn(phone.clock.mono + 1));
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

      events.openContentVisible(claim, drawn(phone.clock.mono + 1 + index));
    }

    events.attach(LUCIA, server.send);
    await settled();
    await settled();

    expect(server.requests.map((request) => request.events.length)).toEqual([
      MAX_APP_EVENTS,
      MAX_PENDING_EVENTS - MAX_APP_EVENTS,
    ]);
    expect(server.events()[0]).toMatchObject({ contentVisibleMs: 21 });
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
    events.firstScreenVisible(drawn(BOOTED + 100));
    events.homeContentVisible(drawn(BOOTED + 100), "network");
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
          firstScreenHitched: false,
          homeContent: { ms: 1000, source: "network", hitched: false },
        },
      },
    ]);
  });
});

/**
 * What `reportAppEvents` rejects with when the media service answers `status` with a command
 * failure under request id `requestId`: an error the SDK built from a real response.
 */
const rejectionFrom = async (status: number, requestId: string): Promise<Error> => {
  const http = createServer((_request: IncomingMessage, response: ServerResponse) => {
    response
      .writeHead(status, { "content-type": "application/json", "x-request-id": requestId })
      .end(JSON.stringify({ code: "not_found", message: "Lucía García's album" }));
  });

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();

  if (address === null || Predicate.isString(address)) throw new Error("The server is not on TCP");

  const media = createMediaServer({
    url: `http://127.0.0.1:${String(address.port)}`,
    accessToken: () => Promise.resolve("jwt-1"),
  });

  const batch: AppEventsRequest = {
    platform: "ios",
    app: "music",
    release: "0.9.0",
    bundle: "embedded",
    development: false,
    events: [
      {
        ageMs: 0,
        event: { _tag: "Launched", firstScreenVisibleMs: 1000, firstScreenHitched: false },
      },
    ],
  };

  const rejection = await media.reportAppEvents(batch).then(
    () => new Error("The server took the batch"),
    (cause: unknown) =>
      cause instanceof Error ? cause : new Error("The SDK rejected a non-error"),
  );

  http.close();

  return rejection;
};

/** Each string the batches carry on the wire, with the name of the field that holds it. */
const wireStrings = (
  requests: ReadonlyArray<AppEventsRequest>,
): ReadonlyArray<readonly [string, string]> => {
  const found: Array<readonly [string, string]> = [];

  JSON.stringify(requests, (key: string, value: Schema.Json) => {
    if (Predicate.isString(value)) found.push([key, value]);

    return value;
  });

  return found;
};

describe("what goes out", () => {
  /** The ids the media service answered under, and the errors the SDK built from those answers. */
  const ANSWERED = [
    "3c5e7a91-2b4d-4f6a-8c1e-9d0b2a4c6e81",
    "7e1a3c5b-9d2f-4b8a-a6c4-1e3f5a7b9c02",
  ] as const;

  const fromService: Array<Error> = [];

  beforeAll(async () => {
    fromService.push(await rejectionFrom(404, ANSWERED[0]), await rejectionFrom(502, ANSWERED[1]));
  });

  /** Every string a batch may carry outside `release` and `requestId`: the contract's fixed sets. */
  const FIXED = new Set<string>([
    ...Object.keys(AppEvent.cases),
    ...ClientPlatform.literals,
    ...AppName.literals,
    ...BundleOrigin.literals,
    ...ContentSource.literals,
    ...TimedScreen.literals,
    ...OpenCache.literals,
    ...ClientErrorKind.literals,
    ...ErrorClass.literals,
    ...FrameSource.literals,
    ...MoviesRoute.literals,
    ...MusicRoute.literals,
  ]);

  const isRelease = Schema.is(AppRelease);

  /** Whether `value` is in its field's set: a request id only as the media service answered it. */
  const inItsSet = ([field, value]: readonly [string, string]): boolean => {
    if (field === "release") return isRelease(value);

    return field === "requestId" ? ANSWERED.some((id) => id === value) : FIXED.has(value);
  };

  const decodeStrictly = Schema.decodeUnknownResult(AppEventsRequest, {
    onExcessProperty: "error",
  });

  /** Text a running app might read: anything, names, identifiers, and the contract's own words. */
  const text = fc.oneof(
    fc.string(),
    fc.constantFrom("NereaMarlow", "CloudOrchard", "PrivateLeaf.js", "fictional-lar.js", "Lucía"),
    fc.stringMatching(/^[A-Za-z_$][\w$]{0,15}$/u),
    fc.constantFrom(
      SCRIPT_URL,
      SCRIPT_IN_STACK,
      "native",
      ...MOVIES_ROUTES,
      ...MUSIC_ROUTES,
      ...ErrorClass.literals,
    ),
  );

  const stackLine = fc.oneof(
    fc
      .tuple(text, fc.oneof(text, fc.constant(SCRIPT_IN_STACK)), fc.nat(), fc.nat())
      .map(
        ([fn, file, line, column]) => `    at ${fn} (${file}:${String(line)}:${String(column)})`,
      ),
    fc.tuple(text, text).map(([fn, file]) => `${fn}@${file}`),
    text,
  );

  const stack = fc.array(stackLine, { maxLength: 10 }).map((lines) => lines.join("\n"));

  const BUILT_IN = [Error, TypeError, RangeError, ReferenceError, SyntaxError, EvalError, URIError];

  /** Anything an app might throw or reject with. */
  const thrownValue: fc.Arbitrary<unknown> = fc.oneof(
    text,
    fc.integer(),
    fc.constantFrom(null, undefined, true),
    fc.record(
      {
        _tag: text,
        name: text,
        message: text,
        stack,
        requestId: fc.oneof(text, fc.uuid({ version: 4 })),
      },
      { requiredKeys: [] },
    ),
    fc
      .tuple(fc.constantFrom(...BUILT_IN), text, fc.option(text), stack)
      .map(([Type, message, name, trace]) => {
        const error = new Type(message);

        if (name !== null) error.name = name;
        error.stack = trace;

        return error;
      }),
    fc.tuple(text, text, stack).map(([className, message, trace]) => {
      class Custom extends Error {}

      Object.defineProperty(Custom, "name", { value: className });
      const error = new Custom(message);

      error.stack = trace;

      return error;
    }),
    fc.tuple(text, fc.uuid({ version: 4 }), stack).map(([message, requestId, trace]) => {
      const error = new TransportError({ operation: message, message, cause: message, requestId });

      error.stack = trace;

      return error;
    }),
    fc.nat().map((index) => fromService[index % fromService.length]),
    fc
      .tuple(
        fc.record({ _tag: text, message: text, stack, requestId: fc.uuid({ version: 4 }) }),
        fc.constantFrom(TransportError.prototype, TypeError.prototype, Error.prototype),
      )
      .map(([fields, prototype]) => {
        Object.setPrototypeOf(fields, prototype);

        return fields;
      }),
  );

  type Action =
    | {
        readonly type: "caught";
        readonly cause: unknown;
        readonly kind: ClientErrorKind;
        readonly fatal: boolean;
      }
    | { readonly type: "route"; readonly route: string }
    | {
        readonly type: "open";
        readonly screen: TimedScreen;
        readonly id: string;
        readonly key: string;
        readonly cache: OpenCache;
        readonly ms: number;
        readonly hitched: boolean;
      }
    | {
        readonly type: "launch";
        readonly ms: number;
        readonly hitched: boolean;
        readonly source: ContentSource;
      };

  const action: fc.Arbitrary<Action> = fc.oneof(
    fc.record({
      type: fc.constant("caught" as const),
      cause: thrownValue,
      kind: fc.constantFrom(...ClientErrorKind.literals),
      fatal: fc.boolean(),
    }),
    fc.record({ type: fc.constant("route" as const), route: text }),
    fc.record({
      type: fc.constant("open" as const),
      screen: fc.constantFrom(...TimedScreen.literals),
      id: text,
      key: text,
      cache: fc.constantFrom(...OpenCache.literals),
      ms: fc.nat(5000),
      hitched: fc.boolean(),
    }),
    fc.record({
      type: fc.constant("launch" as const),
      ms: fc.nat(20_000),
      hitched: fc.boolean(),
      source: fc.constantFrom(...ContentSource.literals),
    }),
  );

  it("never sends a string outside its fixed set, whatever the app reads or throws", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...AppName.literals),
        fc.array(action, { minLength: 1, maxLength: 12 }),
        async (app, actions) => {
          const phone = device();
          const events = phone.open({ app });
          const server = recordingSender();

          events.attach(LUCIA, server.send);
          events.landed("home");

          for (const each of actions) {
            const now = phone.clock.mono;

            if (each.type === "caught") events.caught(each.cause, each.kind, each.fatal);
            else if (each.type === "route") events.routeChanged(each.route);
            else if (each.type === "launch") {
              events.firstScreenVisible(drawn(now + each.ms, each.hitched));
              events.homeContentVisible(drawn(now + each.ms, each.hitched), each.source);
            } else {
              events.pressed(each.screen, each.id, now);
              Option.map(events.claimOpen(each.screen, each.id, each.key, each.cache), (claim) =>
                events.openContentVisible(claim, drawn(now + each.ms, each.hitched)),
              );
            }

            phone.advance(10);
          }

          phone.advance(FLUSH_DELAY_MS);
          await settled();
          await settled();

          // Fatal reports wait in the crash file for a later launch.
          const later = phone.open({ app, processStartedAt: null });

          later.attach(LUCIA, server.send);
          later.landed("elsewhere");
          phone.advance(CRASH_READ_DELAY_MS + FLUSH_DELAY_MS);
          await settled();
          await settled();

          const reports = server.events().filter(AppEvent.guards.ErrorCaught);

          // Something went out for every run that caught an error, so the check below isn't empty.
          if (actions.some((each) => each.type === "caught")) {
            expect(reports.length).toBeGreaterThan(0);
          }

          expect(
            server.requests.every((request) => Result.isSuccess(decodeStrictly(request))),
          ).toBe(true);
          expect(wireStrings(server.requests).filter((each) => !inItsSet(each))).toEqual([]);
        },
      ),
      { numRuns: 300 },
    );
  });
});
