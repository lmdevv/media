/**
 * What every Lar iOS app reports about itself: how long each launch and each screen open took,
 * and the unexpected errors it caught, sent in batches through `POST /api/app-events` as
 * `AppEvent`s.
 *
 * Times are the wall clock in epoch milliseconds, the clock the process start is recorded in. A
 * cold launch runs from the process start to the first frame of the app's own screen, and to the
 * first frame of Home with real content when the launch landed on Home. A warm launch runs from
 * the moment JavaScript learns the app is active again after the background to its next frame.
 * A screen open runs from the press to the first frame that shows the record's real content.
 *
 * Sending never blocks the app and never polls: events wait in memory, at most
 * `MAX_PENDING_EVENTS`, and go out `FLUSH_DELAY_MS` after the first one while the app is active and
 * someone is signed in, and at once when the app moves to the background. A batch that could not
 * reach the server waits for the next of those moments; nothing retries on a timer. A fatal error
 * ends the app before any request could finish, so its report is written to the crash file at once
 * and goes out with the next launch's first batch.
 */
import {
  AppEvent,
  type AppEventsRequest,
  type AppName,
  type ClientErrorKind,
  type ContentSource,
  MAX_APP_EVENT_AGE_MS,
  MAX_APP_EVENTS,
  type QueuedAppEvent,
  type TimedScreen,
} from "@media/contracts/diagnostics";
import { reportGate, reportOf } from "@media/sdk/promise";
import { Option, Predicate, Schema } from "effect";

/** Sends one batch as the signed-in person, as `MediaServer.reportAppEvents` does. */
export type SendAppEvents = (request: AppEventsRequest) => Promise<"sent" | "signed-out">;

/**
 * The file that keeps fatal error reports until a later launch sends them. Both calls are
 * synchronous, so a report is on disk before the fatal error ends the app.
 */
export interface CrashFile {
  /** The file's contents; null when there is no file. */
  readonly read: () => string | null;
  readonly write: (contents: string) => void;
}

/** Where the app stands, as React Native's `AppState` names it. */
export type AppStateName = "active" | "background" | "inactive" | "unknown" | "extension";

/** Whether the screen a launch first drew is Home, whose content the launch then waits for. */
export type Landing = "home" | "elsewhere";

/** A screen's hold on the press that opened it; only it can close that press's timer. */
export interface OpenClaim {
  readonly token: number;
}

/** What the app runs on: its clock, timers, and frames. */
export interface AppEventsOptions {
  readonly app: AppName;
  readonly release: string;
  readonly development: boolean;
  /**
   * When this process started, in epoch milliseconds, as the operating system records it; null
   * when it is unknown, or when iOS prewarmed the process before anyone opened the app.
   */
  readonly processStartedAt: number | null;
  /** The app's JavaScript started while the app was in the background, as for a background task. */
  readonly startedInBackground: boolean;
  readonly crashes: CrashFile;
  /** The wall clock, in epoch milliseconds. */
  readonly now: () => number;
  /** Runs `run` after `ms`; answers a function that cancels it. */
  readonly schedule: (ms: number, run: () => void) => () => void;
  /** Runs `run` just before the next frame draws, as `requestAnimationFrame` does. */
  readonly nextFrame: (run: () => void) => void;
}

/** One app's reporter. */
export interface AppEvents {
  /**
   * Sends events with `send` until the answer is called, starting with any already waiting, such
   * as a crash saved by the last launch. Attach only while someone is signed in.
   */
  readonly attach: (send: SendAppEvents) => () => void;
  /** The app moved to `state`; React Native's `AppState` change events go here. */
  readonly appStateChanged: (state: AppStateName) => void;
  /**
   * The launch's first screen of the app's own is about to draw: its next frame is the launch's
   * first. Only the first call of a launch counts.
   */
  readonly firstScreen: (landing: Landing) => void;
  /** Home is about to draw real content from `source`; only the first call of a launch counts. */
  readonly homeContent: (source: ContentSource) => void;
  /** A press is opening the screen of record `id`, which starts that screen's timer. */
  readonly pressed: (screen: TimedScreen, id: string) => void;
  /**
   * A screen of record `id` mounted; answers its claim on the press that opened it, or none when
   * no press is waiting for it, another screen claimed it, or a later press replaced it.
   */
  readonly claimOpen: (screen: TimedScreen, id: string) => Option.Option<OpenClaim>;
  /** The claimed screen is about to draw its real content; times the open when the claim still holds. */
  readonly openContent: (claim: OpenClaim) => void;
  /** The route pattern on screen now, such as `/album/[id]`, which error reports name. */
  readonly routeChanged: (route: string) => void;
  /**
   * Reports an unexpected error caught as `kind`. A `fatal` one is saved to the crash file at
   * once; any other goes out with the next batch, at most once per repeat window.
   */
  readonly caught: (cause: unknown, kind: ClientErrorKind, fatal: boolean) => void;
}

/** How long a batch gathers events before it goes out while the app is active. */
export const FLUSH_DELAY_MS = 10_000;

/** The most events waiting to go out; past it the oldest are dropped. */
export const MAX_PENDING_EVENTS = 100;

/** The most fatal error reports the crash file keeps. */
export const MAX_SAVED_CRASHES = 5;

/** How long a cold launch that landed on Home waits for its content before it is sent without. */
export const HOME_WAIT_MS = 60_000;

/** How long a press waits for its screen to claim and draw it. */
export const OPEN_WAIT_MS = 60_000;

/**
 * The longest a process may have run before its JavaScript starts and still count as a cold
 * launch; past it the process was already running, as when development JavaScript reloads.
 */
export const MAX_PROCESS_AGE_MS = 30_000;

const SavedCrashes = Schema.Array(
  Schema.Struct({ id: Schema.String, at: Schema.Finite, event: AppEvent }),
);

const crashCodec = Schema.fromJsonString(Schema.toCodecJson(SavedCrashes));

const decodeCrashes = Schema.decodeOption(crashCodec);

const encodeCrashes = Schema.encodeOption(crashCodec);

interface SavedCrash {
  readonly id: string;
  readonly at: number;
  readonly event: AppEvent;
}

interface Pending {
  readonly event: AppEvent;
  readonly at: number;
  /** The crash file entry this event is, removed once the server has answered it. */
  readonly crashId: Option.Option<string>;
}

interface LaunchTrace {
  readonly id: number;
  readonly kind: "cold" | "warm";
  readonly zero: number;
  readonly framing: boolean;
  readonly firstFrameAt: Option.Option<number>;
  readonly landing: Landing;
  readonly home: Option.Option<{ readonly at: number; readonly source: ContentSource }>;
  readonly homing: boolean;
  readonly cancelWait: Option.Option<() => void>;
}

interface WaitingOpen {
  readonly token: number;
  readonly screen: TimedScreen;
  readonly id: string;
  readonly pressedAt: number;
  readonly claimed: boolean;
}

const LOCATION = /(^|[\s(@='"])((?:[a-z][\w+.-]*:\/\/|\/)[^\s()'"]+)/giu;

const POSITION = /(?::\d+){1,2}$/u;

/**
 * `text` with every URL and absolute path cut to its last segment and its line and column, so a
 * stack names `main.jsbundle:1:2345` and never where the app is installed, a server address, or a
 * query string.
 */
export const withoutPaths = (text: string): string =>
  text.replace(LOCATION, (_whole, before: string, location: string) => {
    const position = POSITION.exec(location)?.[0] ?? "";
    const withQuery = location.slice(0, location.length - position.length);

    const path = (withQuery.split("?")[0] ?? "").replace(/\/+$/u, "");

    return `${before}${path.slice(path.lastIndexOf("/") + 1)}${position}`;
  });

const isOlderThan = (at: number, now: number, ms: number): boolean => now - at > ms;

const timing = (from: number, to: number): number => Math.max(0, Math.round(to - from));

/** A reporter for one app, reading the crash file the last launch may have left. */
export const createAppEvents = (options: AppEventsOptions): AppEvents => {
  const { now, schedule, nextFrame, crashes } = options;
  const gate = reportGate();
  const startedAt = now();

  const readCrashes = (): ReadonlyArray<SavedCrash> =>
    Option.getOrElse(
      Option.flatMap(Option.fromNullishOr(crashes.read()), (text) => decodeCrashes(text)),
      () => [],
    );

  const writeCrashes = (saved: ReadonlyArray<SavedCrash>): void => {
    const text = encodeCrashes(saved);

    if (Option.isSome(text)) crashes.write(text.value);
  };

  const coldLaunch = (): Option.Option<LaunchTrace> =>
    Option.filter(
      Option.fromNullishOr(options.processStartedAt),
      (zero) => !options.startedInBackground && !isOlderThan(zero, startedAt, MAX_PROCESS_AGE_MS),
    ).pipe(
      Option.map((zero) => ({
        id: 0,
        kind: "cold",
        zero,
        framing: false,
        firstFrameAt: Option.none(),
        landing: "elsewhere",
        home: Option.none(),
        homing: false,
        cancelWait: Option.none(),
      })),
    );

  let pending: Array<Pending> = readCrashes().map(({ id, at, event }) => ({
    event,
    at,
    crashId: Option.some(id),
  }));

  let sender = Option.none<SendAppEvents>();
  let sending = false;
  let cancelFlush = Option.none<() => void>();
  let pausedUntil = 0;
  let active = !options.startedInBackground;
  let wasBackground = !active;
  let launch = coldLaunch();
  let open = Option.none<WaitingOpen>();
  let nextToken = 0;
  let launches = 0;
  let route = "/";

  const forgetCrashes = (sent: ReadonlyArray<Pending>): void => {
    const ids = new Set(sent.flatMap((each) => Option.toArray(each.crashId)));

    if (ids.size === 0) return;
    writeCrashes(readCrashes().filter((saved) => !ids.has(saved.id)));
  };

  const queued = (batch: ReadonlyArray<Pending>, at: number): Array<QueuedAppEvent> =>
    batch.map((each) => ({ ageMs: Math.max(0, Math.round(at - each.at)), event: each.event }));

  const stopTimer = (): void => {
    Option.map(cancelFlush, (cancel) => cancel());
    cancelFlush = Option.none();
  };

  const arm = (): void => {
    if (
      Option.isSome(cancelFlush) ||
      sending ||
      Option.isNone(sender) ||
      !active ||
      pending.length === 0 ||
      now() < pausedUntil
    ) {
      return;
    }

    cancelFlush = Option.some(
      schedule(FLUSH_DELAY_MS, () => {
        cancelFlush = Option.none();
        flush();
      }),
    );
  };

  const requeue = (batch: ReadonlyArray<Pending>): void => {
    pending = [...batch, ...pending].slice(-MAX_PENDING_EVENTS);
  };

  const refused = (batch: ReadonlyArray<Pending>, cause: unknown): void => {
    // A batch that never reached the server waits for the next send; any answer from the server
    // settles it, so a batch the server refuses can't come back on every launch.
    if (Predicate.isTagged(cause, "TransportError")) {
      requeue(batch);

      return;
    }

    if (Predicate.isTagged(cause, "RateLimited")) {
      const seconds = Predicate.hasProperty(cause, "retryAfterSeconds")
        ? cause.retryAfterSeconds
        : undefined;

      pausedUntil = now() + (Predicate.isNumber(seconds) ? seconds : 60) * 1000;
    }

    forgetCrashes(batch);
  };

  /** Sends `batch`, settles it by the answer, and sends the next batch when this one went out. */
  const deliver = async (
    send: SendAppEvents,
    batch: ReadonlyArray<Pending>,
    at: number,
  ): Promise<void> => {
    let sent = false;

    try {
      sent =
        (await send({
          platform: "ios",
          app: options.app,
          release: options.release,
          development: options.development,
          events: queued(batch, at),
        })) === "sent";

      if (sent) forgetCrashes(batch);
      else requeue(batch);
    } catch (cause) {
      refused(batch, cause);
    }

    sending = false;

    if (sent) flush();
  };

  function flush(): void {
    stopTimer();

    if (sending || Option.isNone(sender) || pending.length === 0 || now() < pausedUntil) return;
    const send = sender.value;
    const at = now();
    const fresh = pending.filter((each) => !isOlderThan(each.at, at, MAX_APP_EVENT_AGE_MS));

    forgetCrashes(pending.filter((each) => !fresh.includes(each)));
    const batch = fresh.slice(0, MAX_APP_EVENTS);

    pending = fresh.slice(MAX_APP_EVENTS);

    if (batch.length === 0) return;
    sending = true;
    void deliver(send, batch, at);
  }

  const enqueue = (event: AppEvent, at: number): void => {
    pending.push({ event, at, crashId: Option.none() });

    if (pending.length > MAX_PENDING_EVENTS) {
      const oldest = pending.findIndex((each) => Option.isNone(each.crashId));

      pending.splice(oldest < 0 ? 0 : oldest, 1);
    }

    arm();
  };

  const finishLaunch = (trace: LaunchTrace): void => {
    Option.map(trace.cancelWait, (cancel) => cancel());
    launch = Option.none();

    if (Option.isNone(trace.firstFrameAt)) return;
    const frame = trace.firstFrameAt.value;

    const home = Option.filter(trace.home, () => trace.kind === "cold" && trace.landing === "home");

    Option.map(
      AppEvent.cases.Launched.makeOption({
        kind: trace.kind,
        firstFrameMs: timing(trace.zero, frame),
        ...Option.match(home, {
          onNone: () => ({}),
          onSome: ({ at, source }) => ({
            home: { ms: timing(trace.zero, Math.max(at, frame)), source },
          }),
        }),
      }),
      (event) => enqueue(event, frame),
    );
  };

  /** Ends the launch once it knows all it will: its first frame, and Home's when it waits for it. */
  const settleLaunch = (trace: LaunchTrace): void => {
    if (Option.isNone(trace.firstFrameAt)) return;

    if (trace.kind === "warm" || trace.landing === "elsewhere" || Option.isSome(trace.home)) {
      finishLaunch(trace);

      return;
    }

    if (Option.isNone(trace.cancelWait)) {
      const cancelWait = schedule(HOME_WAIT_MS, () => {
        Option.map(launch, finishLaunch);
      });

      launch = Option.some({ ...trace, cancelWait: Option.some(cancelWait) });
    }
  };

  const update = (change: (trace: LaunchTrace) => LaunchTrace): Option.Option<LaunchTrace> => {
    launch = Option.map(launch, change);

    return launch;
  };

  const firstScreen = (landing: Landing): void => {
    if (Option.isNone(launch) || launch.value.framing) return;
    const { id } = launch.value;

    update((trace) => ({ ...trace, framing: true, landing }));
    nextFrame(() => {
      const drawn = Option.filter(launch, (trace) => trace.id === id);

      if (Option.isNone(drawn)) return;
      Option.map(
        update((trace) => ({ ...trace, firstFrameAt: Option.some(now()) })),
        settleLaunch,
      );
    });
  };

  const homeContent = (source: ContentSource): void => {
    if (Option.isNone(launch) || launch.value.kind === "warm" || launch.value.homing) return;
    const { id } = launch.value;

    update((trace) => ({ ...trace, homing: true }));
    nextFrame(() => {
      const drawn = Option.filter(launch, (trace) => trace.id === id);

      if (Option.isNone(drawn)) return;
      Option.map(
        update((trace) => ({ ...trace, home: Option.some({ at: now(), source }) })),
        settleLaunch,
      );
    });
  };

  const toBackground = (): void => {
    Option.map(launch, finishLaunch);
    open = Option.none();
    flush();
    active = false;
    wasBackground = true;
  };

  const toForeground = (): void => {
    active = true;

    if (wasBackground) {
      wasBackground = false;
      launches += 1;
      launch = Option.some({
        id: launches,
        kind: "warm",
        zero: now(),
        framing: false,
        firstFrameAt: Option.none(),
        landing: "elsewhere",
        home: Option.none(),
        homing: false,
        cancelWait: Option.none(),
      });
      firstScreen("elsewhere");
    }

    arm();
  };

  return {
    attach: (send) => {
      sender = Option.some(send);
      flush();

      return () => {
        if (Option.contains(sender, send)) {
          sender = Option.none();
          stopTimer();
        }
      };
    },
    appStateChanged: (state) => {
      if (state === "background") toBackground();
      else if (state === "active") toForeground();
    },
    firstScreen,
    homeContent,
    pressed: (screen, id) => {
      nextToken += 1;
      open = Option.some({ token: nextToken, screen, id, pressedAt: now(), claimed: false });
    },
    claimOpen: (screen, id) => {
      if (Option.isNone(open)) return Option.none();
      const waiting = open.value;

      if (
        waiting.claimed ||
        waiting.screen !== screen ||
        waiting.id !== id ||
        isOlderThan(waiting.pressedAt, now(), OPEN_WAIT_MS)
      ) {
        return Option.none();
      }

      open = Option.some({ ...waiting, claimed: true });

      return Option.some({ token: waiting.token });
    },
    openContent: (claim) =>
      nextFrame(() => {
        const waiting = Option.filter(open, (each) => each.token === claim.token);

        if (Option.isNone(waiting)) return;
        open = Option.none();
        const { screen, id, pressedAt } = waiting.value;
        const at = now();

        Option.map(
          AppEvent.cases.ScreenOpened.makeOption({
            screen,
            id,
            durationMs: timing(pressedAt, at),
          }),
          (event) => enqueue(event, at),
        );
      }),
    routeChanged: (next) => {
      route = next;
    },
    caught: (cause, kind, fatal) => {
      const at = now();

      const report = reportOf(cause, {
        platform: "ios",
        appVersion: options.release,
        kind,
        route,
      });

      const stack = Option.filter(
        Option.map(Option.fromNullishOr(report.stack), withoutPaths),
        (text) => text.length > 0,
      );

      const event = AppEvent.cases.ErrorCaught.makeOption({
        kind,
        fatal,
        route: report.route,
        name: report.name,
        message: withoutPaths(report.message),
        ...Option.match(stack, { onNone: () => ({}), onSome: (text) => ({ stack: text }) }),
        ...Option.match(Option.fromNullishOr(report.requestId), {
          onNone: () => ({}),
          onSome: (requestId) => ({ requestId }),
        }),
      });

      if (Option.isNone(event)) return;

      if (fatal) {
        const id = `${at.toString(36)}${Math.random().toString(36).slice(2, 8)}`;

        writeCrashes([...readCrashes(), { id, at, event: event.value }].slice(-MAX_SAVED_CRASHES));

        return;
      }

      if (gate.admits(report, at)) enqueue(event.value, at);
    },
  };
};

/** React Native's global error handler, as `ErrorUtils` holds it. */
type GlobalHandler = (cause: unknown, isFatal?: boolean) => void;

/** React Native's `ErrorUtils` global. */
export interface GlobalErrorUtils {
  readonly getGlobalHandler: () => GlobalHandler;
  readonly setGlobalHandler: (handler: GlobalHandler) => void;
}

interface RejectionTracking {
  readonly enablePromiseRejectionTracker: (tracking: {
    readonly allRejections: boolean;
    readonly onUnhandled: (id: number, cause: unknown) => void;
    readonly onHandled: (id: number) => void;
  }) => void;
}

const isRejectionTracking = (runtime: unknown): runtime is RejectionTracking =>
  Predicate.hasProperty(runtime, "enablePromiseRejectionTracker") &&
  Predicate.isFunction(runtime.enablePromiseRejectionTracker);

/** Where uncaught errors surface in the JavaScript runtime. */
export interface UncaughtSources {
  readonly errorUtils: GlobalErrorUtils;
  /** The `HermesInternal` global, whose promise rejection tracking finds unhandled rejections. */
  readonly hermes: unknown;
  /** In development, a rejection also shows as a warning, as React Native's own tracking does. */
  readonly development: boolean;
}

/**
 * Reports every uncaught error and unhandled promise rejection to `events`. The global handler
 * React Native set still runs after the report, so a fatal error still ends the app. Hermes tracks
 * rejections only once something turns it on, which React Native does only in development; this
 * turns it on in every build.
 */
export const reportUncaught = (events: AppEvents, sources: UncaughtSources): void => {
  const previous = sources.errorUtils.getGlobalHandler();

  sources.errorUtils.setGlobalHandler((cause, isFatal) => {
    try {
      events.caught(cause, "uncaught", isFatal === true);
    } finally {
      previous(cause, isFatal);
    }
  });

  if (!isRejectionTracking(sources.hermes)) return;
  sources.hermes.enablePromiseRejectionTracker({
    allRejections: true,
    onUnhandled: (_id, cause) => {
      events.caught(cause, "unhandled-rejection", false);

      if (sources.development) console.warn("Unhandled promise rejection", cause);
    },
    onHandled: () => undefined,
  });
};
