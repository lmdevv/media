import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";

import { AppEventsRequest, MAX_APP_EVENTS } from "@media/contracts/diagnostics";
import type { AppEvent } from "@media/contracts/diagnostics";
import { RateLimited } from "@media/contracts/errors";
import { TransportError } from "@media/sdk/effect";
import { createMediaServer } from "@media/sdk/promise";
import { Option, Predicate, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  FLUSH_DELAY_MS,
  HOME_WAIT_MS,
  MAX_PENDING_EVENTS,
  MAX_PROCESS_AGE_MS,
  createAppEvents,
  reportUncaught,
  withoutPaths,
} from "./app-events";
import type { AppEventsOptions, AppStateName, GlobalErrorUtils, SendAppEvents } from "./app-events";

const START = 1_800_000_000_000;

interface Timer {
  readonly at: number;
  readonly run: () => void;
  cancelled: boolean;
}

/** A device for one app: a clock, timers and frames that run when the test says, and a file. */
const device = (file: { contents: string | null } = { contents: null }) => {
  const clock = { now: START };
  const timers: Array<Timer> = [];
  const frames: Array<() => void> = [];

  const advance = (ms: number): void => {
    const until = clock.now + ms;

    for (;;) {
      const due = timers
        .filter((timer) => !timer.cancelled && timer.at <= until)
        .reduce<Timer | null>(
          (first, timer) => (first === null || timer.at < first.at ? timer : first),
          null,
        );

      if (due === null) break;
      due.cancelled = true;
      clock.now = due.at;
      due.run();
    }

    clock.now = until;
  };

  const open = (overrides: Partial<AppEventsOptions> = {}) =>
    createAppEvents({
      app: "music",
      release: "0.9.0",
      development: false,
      processStartedAt: clock.now - 900,
      startedInBackground: false,
      crashes: {
        read: () => file.contents,
        write: (contents) => {
          file.contents = contents;
        },
      },
      now: () => clock.now,
      schedule: (ms, run) => {
        const timer: Timer = { at: clock.now + ms, run, cancelled: false };

        timers.push(timer);

        return () => {
          timer.cancelled = true;
        };
      },
      nextFrame: (run) => {
        frames.push(run);
      },
      ...overrides,
    });

  return {
    clock,
    file,
    open,
    advance,
    /** Draws the next frame `ms` from now, running what waited for it. */
    frame: (ms = 16): void => {
      advance(ms);

      for (const run of frames.splice(0)) run();
    },
  };
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

const settled = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

describe("launch timing", () => {
  it("times a cold launch from the process start to its first frame and to Home's content", async () => {
    const phone = device();
    const events = phone.open();
    const server = recordingSender();

    events.attach(server.send);
    phone.advance(400);
    events.firstScreen("home");
    phone.frame(16);
    phone.advance(300);
    events.homeContent("network");
    phone.frame(20);
    await settled();

    expect(server.requests).toEqual([]);

    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({ platform: "ios", app: "music", release: "0.9.0" });

    expect(server.events()).toEqual([
      { _tag: "Launched", kind: "cold", firstFrameMs: 1316, home: { ms: 1636, source: "network" } },
    ]);
  });

  it("sends a launch that landed elsewhere at its first frame, without Home", async () => {
    const phone = device();
    const events = phone.open();
    const server = recordingSender();

    events.attach(server.send);
    events.firstScreen("elsewhere");
    phone.frame(50);
    events.homeContent("network");
    phone.frame();
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.events()).toEqual([{ _tag: "Launched", kind: "cold", firstFrameMs: 950 }]);
  });

  it("counts Home drawn behind the splash screen from the first frame", async () => {
    const phone = device();
    const events = phone.open();
    const server = recordingSender();

    events.homeContent("downloads");
    phone.frame(100);
    events.firstScreen("home");
    phone.frame(100);
    events.attach(server.send);
    await settled();

    expect(server.events()).toEqual([
      {
        _tag: "Launched",
        kind: "cold",
        firstFrameMs: 1100,
        home: { ms: 1100, source: "downloads" },
      },
    ]);
  });

  it("gives up on Home's content after a minute, and sends the launch without it", async () => {
    const phone = device();
    const events = phone.open();
    const server = recordingSender();

    events.attach(server.send);
    events.firstScreen("home");
    phone.frame(100);
    phone.advance(HOME_WAIT_MS + FLUSH_DELAY_MS);
    await settled();

    expect(server.events()).toEqual([{ _tag: "Launched", kind: "cold", firstFrameMs: 1000 }]);
  });

  it("ends a launch when the app leaves for the background, and sends at once", async () => {
    const phone = device();
    const events = phone.open();
    const server = recordingSender();

    events.attach(server.send);
    events.firstScreen("home");
    phone.frame(100);
    events.appStateChanged("background");
    await settled();

    expect(server.events()).toEqual([{ _tag: "Launched", kind: "cold", firstFrameMs: 1000 }]);
  });

  it("times a warm launch from the return to the foreground to the next frame", async () => {
    const phone = device();
    const events = phone.open({ processStartedAt: null });
    const server = recordingSender();

    events.attach(server.send);
    events.appStateChanged("background");
    phone.advance(60_000);
    events.appStateChanged("inactive");
    events.appStateChanged("active");
    phone.frame(34);
    events.homeContent("network");
    phone.frame();
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.events()).toEqual([{ _tag: "Launched", kind: "warm", firstFrameMs: 34 }]);
  });

  it.each<[string, Partial<AppEventsOptions>]>([
    ["the process start is unknown or prewarmed", { processStartedAt: null }],
    [
      "JavaScript started long after the process",
      { processStartedAt: START - MAX_PROCESS_AGE_MS - 1 },
    ],
    ["the app launched in the background", { startedInBackground: true }],
  ])("times no cold launch when %s", async (_case, overrides) => {
    const phone = device();
    const events = phone.open(overrides);
    const server = recordingSender();

    events.attach(server.send);
    events.firstScreen("home");
    phone.frame();
    events.homeContent("network");
    phone.frame();
    phone.advance(HOME_WAIT_MS + FLUSH_DELAY_MS);
    await settled();

    expect(server.events()).toEqual([]);
  });
});

describe("screen-open timing", () => {
  it("times a press to the first frame of the screen's real content", async () => {
    const phone = device();
    const events = phone.open({ processStartedAt: null });
    const server = recordingSender();

    events.attach(server.send);
    events.pressed("album", "album_1");
    phone.advance(40);
    const claim = events.claimOpen("album", "album_1");

    phone.advance(300);
    events.openContent(Option.getOrThrow(claim));
    phone.frame(16);
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.events()).toEqual([
      { _tag: "ScreenOpened", screen: "album", id: "album_1", durationMs: 356 },
    ]);
  });

  it("never lets a late answer for an earlier id close a later press's timer", async () => {
    const phone = device();
    const events = phone.open({ processStartedAt: null });
    const server = recordingSender();

    events.attach(server.send);
    events.pressed("album", "album_a");
    const first = Option.getOrThrow(events.claimOpen("album", "album_a"));

    phone.advance(500);
    events.pressed("album", "album_b");
    phone.advance(20);
    const second = Option.getOrThrow(events.claimOpen("album", "album_b"));

    phone.advance(80);
    events.openContent(first);
    phone.frame(10);
    phone.advance(90);
    events.openContent(second);
    phone.frame(10);
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.events()).toEqual([
      { _tag: "ScreenOpened", screen: "album", id: "album_b", durationMs: 210 },
    ]);
  });

  it("keeps a screen that mounted for an earlier press of the same id off the later timer", async () => {
    const phone = device();
    const events = phone.open({ processStartedAt: null });
    const server = recordingSender();

    events.attach(server.send);
    events.pressed("artist", "artist_1");
    const earlier = Option.getOrThrow(events.claimOpen("artist", "artist_1"));

    phone.advance(1000);
    events.pressed("artist", "artist_1");
    phone.advance(100);
    events.openContent(earlier);
    phone.frame(10);
    const later = Option.getOrThrow(events.claimOpen("artist", "artist_1"));

    phone.advance(40);
    events.openContent(later);
    phone.frame(10);
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.events()).toEqual([
      { _tag: "ScreenOpened", screen: "artist", id: "artist_1", durationMs: 160 },
    ]);
  });

  it("gives a press to one screen only, and only to the screen of its id", () => {
    const events = device().open({ processStartedAt: null });

    expect(Option.isNone(events.claimOpen("title", "title_1"))).toBe(true);

    events.pressed("title", "title_1");

    expect(Option.isNone(events.claimOpen("title", "title_2"))).toBe(true);
    expect(Option.isNone(events.claimOpen("album", "title_1"))).toBe(true);
    expect(Option.isSome(events.claimOpen("title", "title_1"))).toBe(true);
    expect(Option.isNone(events.claimOpen("title", "title_1"))).toBe(true);
  });

  it("drops a press whose screen was still loading when the app left for the background", async () => {
    const phone = device();
    const events = phone.open({ processStartedAt: null });
    const server = recordingSender();

    events.attach(server.send);
    events.pressed("title", "title_1");
    const claim = Option.getOrThrow(events.claimOpen("title", "title_1"));

    events.appStateChanged("background");
    events.appStateChanged("active");
    events.openContent(claim);
    phone.frame();
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.events().filter(Predicate.isTagged("ScreenOpened"))).toEqual([]);
  });
});

const uncaught = (message: string): Error => {
  const error = new TypeError(message);

  error.stack = [
    `TypeError: ${message}`,
    "    at Album (http://127.0.0.1:8081/node_modules/expo-router/entry.bundle?platform=ios&dev=true:4123:17)",
    "    at render (address at /private/var/containers/Bundle/Application/1F2E/music.app/main.jsbundle:1:52344)",
  ].join("\n");

  return error;
};

describe("error reports", () => {
  it("sends a caught error with its route pattern and no paths in its stack", async () => {
    const phone = device();
    const events = phone.open({ processStartedAt: null });
    const server = recordingSender();

    events.attach(server.send);
    events.routeChanged("/album/[id]");
    events.caught(uncaught("undefined is not a function"), "render", false);
    events.caught(uncaught("undefined is not a function"), "render", false);
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.events()).toEqual([
      {
        _tag: "ErrorCaught",
        kind: "render",
        fatal: false,
        route: "/album/[id]",
        name: "TypeError",
        message: "undefined is not a function",
        stack: [
          "TypeError: undefined is not a function",
          "    at Album (entry.bundle:4123:17)",
          "    at render (address at main.jsbundle:1:52344)",
        ].join("\n"),
      },
    ]);
  });

  it("saves a fatal error at once and sends it from the next launch", async () => {
    const file = { contents: null };
    const crashing = device(file);
    const before = crashing.open({ processStartedAt: null });
    const server = recordingSender();

    before.attach(server.send);
    before.caught(uncaught("fatal one"), "uncaught", true);
    crashing.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.requests).toEqual([]);
    expect(file.contents).toContain("fatal one");

    const relaunched = device(file);

    relaunched.clock.now = START + 3_600_000;
    const after = relaunched.open({ processStartedAt: null });

    after.attach(server.send);
    await settled();

    expect(server.requests[0]?.events).toHaveLength(1);
    expect(server.requests[0]?.events[0]).toMatchObject({
      ageMs: 3_600_000,
      event: { _tag: "ErrorCaught", fatal: true, message: "fatal one" },
    });
    expect(file.contents).toBe("[]");
  });

  it("keeps a saved crash while the server can't be reached, and drops it once the server refuses it", async () => {
    const file = { contents: null };
    const phone = device(file);

    phone.open({ processStartedAt: null }).caught(uncaught("kept"), "uncaught", true);
    const events = phone.open({ processStartedAt: null });
    const server = recordingSender();

    server.answer.next = () =>
      Promise.reject(
        new TransportError({ operation: "appEvents", message: "offline", cause: "no route" }),
      );
    events.attach(server.send);
    await settled();

    expect(file.contents).toContain("kept");

    server.answer.next = () =>
      Promise.reject(new RateLimited({ message: "Too many app events", retryAfterSeconds: 30 }));
    events.appStateChanged("background");
    await settled();

    expect(server.requests).toHaveLength(2);
    expect(file.contents).toBe("[]");

    server.answer.next = () => Promise.resolve("sent");
    events.appStateChanged("active");
    events.caught(uncaught("during the pause"), "uncaught", false);
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.requests).toHaveLength(2);

    phone.advance(30_000);
    events.appStateChanged("background");
    await settled();

    expect(server.requests).toHaveLength(3);
  });

  it("reports what reaches React Native's global handler, and still runs the handler", async () => {
    const phone = device();
    const events = phone.open({ processStartedAt: null });
    const handled: Array<[string, boolean | undefined]> = [];

    let handler: (cause: unknown, isFatal?: boolean) => void = (cause, isFatal) => {
      handled.push([cause instanceof Error ? cause.message : "", isFatal]);
    };

    const errorUtils: GlobalErrorUtils = {
      getGlobalHandler: () => handler,
      setGlobalHandler: (next) => {
        handler = next;
      },
    };

    const tracking: Array<{ readonly onUnhandled: (id: number, cause: unknown) => void }> = [];

    reportUncaught(events, {
      errorUtils,
      hermes: {
        enablePromiseRejectionTracker: (options: (typeof tracking)[number]) =>
          tracking.push(options),
      },
      development: false,
    });

    handler(uncaught("thrown in a timer"), true);
    tracking[0]?.onUnhandled(1, new Error("nobody awaited this"));
    const server = recordingSender();

    events.attach(server.send);
    await settled();

    expect(handled).toEqual([["thrown in a timer", true]]);
    expect(phone.file.contents).toContain("thrown in a timer");

    expect(server.events()).toEqual([
      expect.objectContaining({
        _tag: "ErrorCaught",
        kind: "unhandled-rejection",
        fatal: false,
        message: "nobody awaited this",
      }),
    ]);
  });
});

describe("sending", () => {
  it("holds events while nobody is signed in, and sends them once someone is", async () => {
    const phone = device();
    const events = phone.open({ processStartedAt: null });
    const server = recordingSender();

    server.answer.next = () => Promise.resolve("signed-out");
    events.pressed("title", "title_1");
    events.openContent(Option.getOrThrow(events.claimOpen("title", "title_1")));
    phone.frame();
    events.attach(server.send);
    await settled();
    server.answer.next = () => Promise.resolve("sent");
    phone.advance(FLUSH_DELAY_MS);
    await settled();

    expect(server.requests).toHaveLength(1);

    events.attach(server.send);
    await settled();

    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]?.events.map((queued) => queued.event)).toEqual(
      server.requests[0]?.events.map((queued) => queued.event),
    );
  });

  it("stops sending once detached", async () => {
    const phone = device();
    const events = phone.open({ processStartedAt: null });
    const server = recordingSender();

    events.attach(server.send)();
    events.caught(new Error("after sign-out"), "uncaught", false);
    phone.advance(FLUSH_DELAY_MS);
    events.appStateChanged("background");
    await settled();

    expect(server.requests).toEqual([]);
  });

  it("keeps the newest events past the cap, and sends them in batches the server takes", async () => {
    const phone = device();
    const events = phone.open({ processStartedAt: null });
    const server = recordingSender();

    for (let index = 0; index < MAX_PENDING_EVENTS + 20; index += 1) {
      events.pressed("title", `title_${String(index)}`);
      events.openContent(Option.getOrThrow(events.claimOpen("title", `title_${String(index)}`)));
      phone.frame(1);
    }

    events.attach(server.send);
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

    events.attach(media.reportAppEvents);
    events.firstScreen("elsewhere");
    phone.frame(100);
    events.appStateChanged("background" satisfies AppStateName);
    await new Promise((resolve) => setTimeout(resolve, 200));
    http.close();

    expect(bodies.map((each) => each.authorization)).toEqual(["Bearer jwt-1"]);

    const decoded = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.toCodecJson(AppEventsRequest)),
    )(bodies[0]?.body);

    expect(decoded.events).toEqual([
      { ageMs: 0, event: { _tag: "Launched", kind: "cold", firstFrameMs: 1000 } },
    ]);
  });
});

describe("withoutPaths", () => {
  it.each([
    [
      "at f (http://10.0.0.2:8081/index.bundle?platform=ios&dev=true:12:3)",
      "at f (index.bundle:12:3)",
    ],
    [
      "at f (address at /var/containers/Bundle/A/app.app/main.jsbundle:1:9)",
      "at f (address at main.jsbundle:1:9)",
    ],
    ["f@http://media.local/movies/assets/index.js:4:20", "f@index.js:4:20"],
    [
      "open '/var/mobile/Containers/Data/x/Documents/vault/song.m4a' failed",
      "open 'song.m4a' failed",
    ],
    [
      "fetch http://media.local/media/hls/a/1/index.m3u8?token=abc.def failed",
      "fetch index.m3u8 failed",
    ],
    ["Cannot read property 'poster' of undefined", "Cannot read property 'poster' of undefined"],
  ])("%s", (input, output) => {
    expect(withoutPaths(input)).toBe(output);
  });
});
