/**
 * What every Lar iOS app reports about itself: how long a cold launch and each screen open took
 * until the person saw the result, and the unexpected errors it caught, sent in batches through
 * `POST /api/app-events` as `AppEvent`s.
 *
 * Every timing is a span of the device's monotonic clock, the one iOS stamps touches and frames
 * with, and ends on a frame the app's `LaunchClock` module saw drawn: a `FrameMark` view reports
 * the first display refresh in which it is in the window, inside the screen's bounds, and covered
 * by no opaque view such as the splash screen. A cold launch runs from the process start the
 * kernel records; a screen open from the touch that ended the press. A span that crosses a trip to
 * the background, or comes out negative or past its bound, is dropped.
 *
 * Every event belongs to one account on one server, its owner. Events wait in memory for their
 * owner only: a new owner or a sign-out drops them and the saved crash reports of anyone else, and
 * an event that happens while no one is known is not kept.
 *
 * No string the app reads at run time goes out. An event holds numbers and members of sets fixed in
 * the code: an error report names the error's class from a fixed list, the route pattern from the
 * app's route list, and each stack frame as which code it runs in and its line and column, which
 * the source map of the bundle the batch names turns back into source; nothing of its message, its
 * own name, or its stack's file and function names.
 *
 * Sending never blocks the app and never polls: events go out `FLUSH_DELAY_MS` after the first one
 * while the app is active, and in one batch as it leaves for the background; no request starts in
 * the background otherwise. A fatal error ends the app before any request could finish, so its
 * report is written to the crash file at once and goes out after a later launch's first frame.
 */
import {
  APP_ROUTE,
  AppEvent,
  type AppEventsRequest,
  type AppName,
  AppRelease,
  type AppRoute,
  type BundleOrigin,
  type ClientErrorKind,
  type ContentSource,
  ErrorClass,
  type ErrorFrame,
  type FrameSource,
  MAX_APP_EVENT_AGE_MS,
  MAX_APP_EVENTS,
  MAX_APP_TIMING_MS,
  MAX_ERROR_FRAMES,
  MAX_FRAME_POSITION,
  type OpenCache,
  type QueuedAppEvent,
  type TimedScreen,
} from "@media/contracts/diagnostics";
import { RequestId } from "@media/contracts/request-id";
import { Option, Predicate, Schema } from "effect";

/** Sends one batch as the owner's session, as `MediaServer.reportAppEvents` does. */
export type SendAppEvents = (request: AppEventsRequest) => Promise<"sent" | "signed-out">;

/** Who an event belongs to: one account on one server. */
export interface Owner {
  /** The media server's address. */
  readonly server: string;
  /** The account's user id on that server. */
  readonly account: string;
}

/**
 * The file that keeps fatal error reports until a later launch sends them. Both calls are
 * synchronous, so a report is on disk before the fatal error ends the app.
 */
export interface CrashFile {
  /** The file's contents; null when there is no file. */
  readonly read: () => string | null;
  readonly write: (contents: string) => void;
}

/**
 * The display refresh at which a frame mark first saw its frame on screen, in milliseconds on the
 * monotonic clock, and whether it came after one or more refreshes the app missed, when the frame
 * may have shown a refresh or more later.
 */
export interface FrameEnd {
  readonly at: number;
  readonly hitched: boolean;
}

/** Where the app stands, as React Native's `AppState` names it. */
export type AppStateName = "active" | "background" | "inactive" | "unknown" | "extension";

/** Whether the launch's first screen is Home, whose screen and content the launch times. */
export type Landing = "home" | "elsewhere";

/** A screen's hold on the press that opened it; only it can close that press's timer. */
export interface OpenClaim {
  readonly token: number;
  /** The navigation route instance that claimed it, such as React Navigation's route key. */
  readonly route: string;
  readonly cache: OpenCache;
}

/** What the app runs on: its clocks, timers, and crash file. */
export interface AppEventsOptions {
  readonly app: AppName;
  /** The app's version, such as `0.9.0`; a version the server does not read goes out as `0.0.0`. */
  readonly release: string;
  readonly development: boolean;
  /**
   * The address the app's JavaScript was loaded from (React Native's `SourceCode.scriptURL`): a
   * file in the app for an embedded bundle, or a dev server's URL. It stays on the device; the batch
   * says only which of the two it is, and frames in this file count as the bundle's.
   */
  readonly scriptUrl: string | null;
  /**
   * When this process started, on `monotonicNow`'s clock; null when it is unknown, or when iOS
   * prewarmed the process before anyone opened the app.
   */
  readonly processStartedAt: number | null;
  /** The app's JavaScript started while the app was in the background, as for a background task. */
  readonly startedInBackground: boolean;
  readonly crashes: CrashFile;
  /**
   * The device's monotonic clock in milliseconds, the clock of native touch and frame times
   * (`CACurrentMediaTime`). It never steps, and stops while the device sleeps.
   */
  readonly monotonicNow: () => number;
  /** The wall clock, in epoch milliseconds: how long ago an event happened, across launches. */
  readonly wallNow: () => number;
  /** Runs `run` after `ms`; answers a function that cancels it. */
  readonly schedule: (ms: number, run: () => void) => () => void;
}

/** One app's reporter. */
export interface AppEvents {
  /**
   * `owner` is signed in, and `send` sends as them until the answer is called. Events of anyone
   * else, waiting or saved, are dropped; the owner's own, a saved crash included, go out.
   */
  readonly attach: (owner: Owner, send: SendAppEvents) => () => void;
  /** Nobody is signed in any more: every waiting event and saved crash report is dropped. */
  readonly signedOut: () => void;
  /** The app moved to `state`; React Native's `AppState` change events go here. */
  readonly appStateChanged: (state: AppStateName) => void;
  /** The launch's first screen rendered: Home, or another screen, which times no launch. */
  readonly landed: (landing: Landing) => void;
  /** Whether a cold launch still waits for Home's frame marks. */
  readonly launchPending: () => boolean;
  /** Home's screen was first in view, with the splash screen gone, at frame `end`. */
  readonly firstScreenVisible: (end: FrameEnd) => void;
  /** Home's real content from `source` was first in view at frame `end`. */
  readonly homeContentVisible: (end: FrameEnd, source: ContentSource) => void;
  /**
   * A press is opening the screen of record `id`; `touchedAt` is the monotonic time of the touch
   * that ended it. A later press replaces it. The id only matches the press to its screen; no
   * event carries it.
   */
  readonly pressed: (screen: TimedScreen, id: string, touchedAt: number) => void;
  /**
   * The focused screen of record `id`, navigation route instance `route`, mounted with its content
   * `cache`d or not; answers its claim on the press that opened it, or none when no press waits
   * for it, another screen claimed it, or the press is too old.
   */
  readonly claimOpen: (
    screen: TimedScreen,
    id: string,
    route: string,
    cache: OpenCache,
  ) => Option.Option<OpenClaim>;
  /** The claiming screen lost focus or unmounted before its content was in view. */
  readonly releaseOpen: (claim: OpenClaim) => void;
  /** The claiming screen's content was first in view at frame `end`. */
  readonly openContentVisible: (claim: OpenClaim, end: FrameEnd) => void;
  /**
   * The route pattern on screen now, such as `/(tabs)/(home)`, which error reports name; one not
   * in the app's route list goes out as `unknown`.
   */
  readonly routeChanged: (route: string) => void;
  /**
   * Reports an unexpected error caught as `kind`. A `fatal` one is saved to the crash file at
   * once; any other goes out with the next batch, at most once per repeat window. Never throws.
   */
  readonly caught: (cause: unknown, kind: ClientErrorKind, fatal: boolean) => void;
}

/** How long a batch gathers events before it goes out while the app is active. */
export const FLUSH_DELAY_MS = 10_000;

/** The most events waiting to go out; past it the oldest are dropped. */
export const MAX_PENDING_EVENTS = 100;

/** The most fatal error reports the crash file keeps. */
export const MAX_SAVED_CRASHES = 5;

/** How long a cold launch waits for its first screen before it is dropped. */
export const LAUNCH_WAIT_MS = 120_000;

/** How long a cold launch that showed Home waits for Home's content before it is sent without. */
export const HOME_WAIT_MS = 60_000;

/** How long a press waits for its screen to claim it and show its content. */
export const OPEN_WAIT_MS = 60_000;

/**
 * How long after the first screen rendered the crash file may be read when no frame mark said the
 * first frame was drawn, as on a launch that times nothing.
 */
export const CRASH_READ_DELAY_MS = 2000;

/** How long an error report that went out is not sent again. */
export const REPEAT_WINDOW_MS = 30_000;

/**
 * The longest a process may have run before its JavaScript starts and still count as a cold
 * launch; past it the process was already running, as when development JavaScript reloads.
 */
export const MAX_PROCESS_AGE_MS = 30_000;

const OwnerSchema = Schema.Struct({ server: Schema.String, account: Schema.String });

const SavedCrashes = Schema.Array(
  Schema.Struct({ id: Schema.String, at: Schema.Finite, owner: OwnerSchema, event: AppEvent }),
);

const crashCodec = Schema.fromJsonString(Schema.toCodecJson(SavedCrashes));

const decodeCrashes = Schema.decodeOption(crashCodec);

const encodeCrashes = Schema.encodeOption(crashCodec);

const isRequestId = Schema.is(RequestId);

const isRelease = Schema.is(AppRelease);

const isErrorClass = Schema.is(ErrorClass);

type SavedCrash = (typeof SavedCrashes.Type)[number];

interface Pending {
  readonly event: AppEvent;
  /** When it happened, on the wall clock. */
  readonly at: number;
  /** The crash file entry this event is, removed once the server has answered it. */
  readonly crashId: Option.Option<string>;
}

interface LaunchTrace {
  /** The process start, on the monotonic clock. */
  readonly zero: number;
  readonly firstScreen: Option.Option<FrameEnd>;
  readonly home: Option.Option<{ readonly end: FrameEnd; readonly source: ContentSource }>;
  readonly cancelWait: () => void;
}

interface WaitingOpen {
  readonly token: number;
  readonly screen: TimedScreen;
  readonly id: string;
  readonly touchedAt: number;
  readonly claim: Option.Option<{ readonly route: string }>;
}

const sameOwner = (left: Owner, right: Owner): boolean =>
  left.server === right.server && left.account === right.account;

const isOwnedBy = (owner: Option.Option<Owner>, candidate: Owner): boolean =>
  Option.isSome(owner) && sameOwner(owner.value, candidate);

/** A span from `from` to `to` in whole milliseconds, or none when it is negative or past `max`. */
const span = (from: number, to: number, max: number): Option.Option<number> => {
  const ms = Math.round(to - from);

  return ms >= 0 && ms <= max ? Option.some(ms) : Option.none();
};

const POSITION = /:(\d{1,9}):(\d{1,9})$/u;

/**
 * The string `cause` holds at `key`, own or inherited; none when it holds no string there, or
 * reading it throws, as a getter may.
 */
const stringAt = (cause: unknown, key: string): Option.Option<string> =>
  Option.liftThrowable(() =>
    Predicate.hasProperty(cause, key) && Predicate.isString(cause[key]) ? cause[key] : null,
  )().pipe(Option.flatMap(Option.fromNullishOr));

/** JavaScript's own error types, each by the name `ErrorClass` gives it. */
const BUILT_IN_ERRORS = [
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "EvalError",
  "URIError",
  "AggregateError",
] as const satisfies ReadonlyArray<ErrorClass>;

/**
 * The prototype of each of JavaScript's own error types, with its name; `AggregateError` only where
 * the runtime has it.
 */
const builtInPrototypes: ReadonlyArray<readonly [object, (typeof BUILT_IN_ERRORS)[number]]> = [
  [Error.prototype, "Error"],
  [TypeError.prototype, "TypeError"],
  [RangeError.prototype, "RangeError"],
  [ReferenceError.prototype, "ReferenceError"],
  [SyntaxError.prototype, "SyntaxError"],
  [EvalError.prototype, "EvalError"],
  [URIError.prototype, "URIError"],
  ...(typeof AggregateError === "undefined"
    ? []
    : [[AggregateError.prototype, "AggregateError"] as const]),
];

const prototypeOf = (cause: unknown): Option.Option<object | null> =>
  Option.liftThrowable(() => (Predicate.isObject(cause) ? Reflect.getPrototypeOf(cause) : null))();

const isError = (cause: unknown): boolean =>
  Option.getOrElse(Option.liftThrowable(() => cause instanceof Error)(), () => false);

/**
 * What kind of error `cause` is, from `ErrorClass`'s fixed list: the SDK's, the contracts', or
 * Effect's tag when it has one of theirs; one of JavaScript's own types when it is exactly one;
 * `NotAnError` for a thrown value that is no error; `Other` for anything else. A name the error
 * gives itself only picks a member of the list.
 */
export const errorClassOf = (cause: unknown): ErrorClass => {
  const tagged = Option.filter(stringAt(cause, "_tag"), isErrorClass);

  if (Option.isSome(tagged) && !BUILT_IN_ERRORS.some((name) => name === tagged.value)) {
    return tagged.value;
  }

  const prototype = prototypeOf(cause);

  const builtIn = builtInPrototypes.find(([candidate]) =>
    Option.exists(prototype, (own) => own === candidate),
  );

  if (builtIn !== undefined) return builtIn[1];

  return isError(cause) ? "Other" : "NotAnError";
};

/** `place` without its query or fragment, the part of a script's address that names its file. */
const fileOf = (place: string): string => place.replace(/[?#].*$/su, "").replace(/^.*\//su, "");

/** Which code a frame at `place` runs in, the app's bundle being the file at `scriptUrl`. */
const sourceOf = (place: string, scriptUrl: string | null): FrameSource => {
  if (place === "native" || place === "[native code]") return "native";

  return scriptUrl !== null && place.length > 0 && fileOf(place) === fileOf(scriptUrl)
    ? "bundle"
    : "other";
};

/** A line or column the stack gives, or 0 for none or one past `MAX_FRAME_POSITION`. */
const positionOf = (digits: string | undefined): number => {
  const value = Number(digits ?? "0");

  return value <= MAX_FRAME_POSITION ? value : 0;
};

/** The frame a stack line names, reduced to which code it runs in and its position. */
const frameOf = (line: string, scriptUrl: string | null): Option.Option<ErrorFrame> => {
  const text = line.trim();
  const hermes = /^at (?:\S+ \((.*)\)|(.*))$/u.exec(text);
  const jsc = hermes === null ? /^[^@\s]*@(.+)$/u.exec(text) : null;

  if (hermes === null && jsc === null) return Option.none();

  const location = ((hermes === null ? jsc?.[1] : (hermes[1] ?? hermes[2])) ?? "").replace(
    /^address at /u,
    "",
  );

  const position = POSITION.exec(location);
  const place = position === null ? location : location.slice(0, position.index);

  return Option.some({
    source: sourceOf(place, scriptUrl),
    line: positionOf(position?.[1]),
    column: positionOf(position?.[2]),
  });
};

/**
 * `cause`'s stack as frames of numbers, the bundle being the file at `scriptUrl`. The stack's text
 * up to the end of the error's message is skipped first, since a message can span lines that look
 * like frames.
 */
export const framesOf = (cause: unknown, scriptUrl: string | null): ReadonlyArray<ErrorFrame> => {
  const stack = stringAt(cause, "stack");

  if (Option.isNone(stack)) return [];

  const message = Option.getOrElse(stringAt(cause, "message"), () => "");
  const cut = message.length > 0 ? stack.value.indexOf(message) : -1;
  const body = cut < 0 ? stack.value : stack.value.slice(cut + message.length);

  return body
    .split("\n")
    .flatMap((line) => Option.toArray(frameOf(line, scriptUrl)))
    .slice(0, MAX_ERROR_FRAMES);
};

/** Where JavaScript loaded from `scriptUrl` came from: a dev server's address, or the app. */
const bundleOriginOf = (scriptUrl: string | null): BundleOrigin =>
  scriptUrl !== null && /^https?:\/\//iu.test(scriptUrl) ? "dev-server" : "embedded";

const TouchEvent = Schema.Struct({
  timestamp: Schema.Finite.check(Schema.isGreaterThan(0)),
});

const decodeTouch = Schema.decodeUnknownOption(TouchEvent);

/**
 * The monotonic time of the touch that ended `press`: React Native's `nativeEvent.timestamp`,
 * which iOS stamps on the clock frame marks report on. None for a press with no touch, such as a
 * menu action.
 */
export const touchTime = (press: { readonly nativeEvent: unknown }): Option.Option<number> =>
  Option.map(decodeTouch(press.nativeEvent), (touch) => touch.timestamp);

/** The request id an SDK error names, when it names one in the media service's shape. */
const requestIdOf = (cause: unknown): Option.Option<string> =>
  Option.filter(stringAt(cause, "requestId"), isRequestId);

/** A gate that admits one report per key per `REPEAT_WINDOW_MS`, remembering at most 100 keys. */
const repeatGate = () => {
  const sentAt = new Map<string, number>();

  return (key: string, now: number): boolean => {
    for (const [seen, at] of sentAt) {
      if (now - at >= REPEAT_WINDOW_MS) sentAt.delete(seen);
    }

    if (sentAt.has(key)) return false;

    if (sentAt.size >= 100) {
      const oldest = sentAt.keys().next();

      if (oldest.done !== true) sentAt.delete(oldest.value);
    }

    sentAt.set(key, now);

    return true;
  };
};

/** A reporter for one app. It reads the crash file only once a launch has drawn its first frame. */
export const createAppEvents = (options: AppEventsOptions): AppEvents => {
  const { monotonicNow, wallNow, schedule, crashes, scriptUrl } = options;
  const admits = repeatGate();
  const release = isRelease(options.release) ? options.release : "0.0.0";
  const bundle = bundleOriginOf(scriptUrl);
  const isRoute = Schema.is(APP_ROUTE[options.app]);

  let owner = Option.none<Owner>();
  let sender = Option.none<{ readonly owner: Owner; readonly send: SendAppEvents }>();
  let pending: Array<Pending> = [];
  /** The crash file as last read or written; null until it has been read. */
  let saved: Array<SavedCrash> | null = null;
  const enqueuedCrashes = new Set<string>();
  let clearSaved = false;
  let firstFrameDrawn = false;
  let readWanted = false;
  let sending = false;
  let cancelFlush = Option.none<() => void>();
  let pausedUntil = 0;
  let active = !options.startedInBackground;
  let landing = Option.none<Landing>();
  let launch = Option.none<LaunchTrace>();
  let open = Option.none<WaitingOpen>();
  let nextToken = 0;
  let route: AppRoute = "unknown";

  const readCrashFile = (): Array<SavedCrash> =>
    Option.match(
      Option.flatMap(Option.fromNullishOr(crashes.read()), (text) => decodeCrashes(text)),
      { onNone: () => [], onSome: (entries) => [...entries] },
    );

  const writeCrashFile = (entries: Array<SavedCrash>): void => {
    saved = entries;
    const text = encodeCrashes(entries);

    if (Option.isSome(text)) crashes.write(text.value);
  };

  /** Keeps only the current owner's saved crashes, queueing theirs; clears all after sign-out. */
  const reconcileSaved = (): void => {
    if (saved === null) return;

    if (Option.isNone(owner)) {
      if (clearSaved && saved.length > 0) writeCrashFile([]);

      return;
    }

    const current = owner.value;
    const kept = saved.filter((entry) => sameOwner(entry.owner, current));

    if (kept.length !== saved.length) writeCrashFile(kept);

    for (const entry of kept) {
      if (enqueuedCrashes.has(entry.id)) continue;
      enqueuedCrashes.add(entry.id);
      pending.push({ event: entry.event, at: entry.at, crashId: Option.some(entry.id) });
    }
  };

  const readSaved = (): void => {
    if (saved !== null) return;
    saved = readCrashFile();
    reconcileSaved();
    arm();
  };

  /** Reads the crash file once the first frame is drawn; at once when it already was. */
  const wantSaved = (): void => {
    if (saved !== null) {
      reconcileSaved();

      return;
    }

    readWanted = true;

    if (firstFrameDrawn) schedule(0, readSaved);
  };

  const frameDrawn = (): void => {
    if (firstFrameDrawn) return;
    firstFrameDrawn = true;

    if (readWanted) schedule(0, readSaved);
  };

  const forgetCrashes = (sent: ReadonlyArray<Pending>): void => {
    const ids = new Set(sent.flatMap((each) => Option.toArray(each.crashId)));

    if (ids.size === 0 || saved === null) return;
    writeCrashFile(saved.filter((entry) => !ids.has(entry.id)));
  };

  const queued = (batch: ReadonlyArray<Pending>, at: number): Array<QueuedAppEvent> =>
    batch.map((each) => ({ ageMs: Math.max(0, Math.round(at - each.at)), event: each.event }));

  const stopTimer = (): void => {
    Option.map(cancelFlush, (cancel) => cancel());
    cancelFlush = Option.none();
  };

  function arm(): void {
    if (
      Option.isSome(cancelFlush) ||
      sending ||
      Option.isNone(sender) ||
      !active ||
      pending.length === 0 ||
      monotonicNow() < pausedUntil
    ) {
      return;
    }

    cancelFlush = Option.some(
      schedule(FLUSH_DELAY_MS, () => {
        cancelFlush = Option.none();
        flush(false);
      }),
    );
  }

  /** Puts `batch`, which `from`'s sender could not deliver, back, unless the owner changed. */
  const requeue = (from: Owner, batch: ReadonlyArray<Pending>): void => {
    if (!isOwnedBy(owner, from)) return;
    pending = [...batch, ...pending].slice(-MAX_PENDING_EVENTS);
  };

  const refused = (from: Owner, batch: ReadonlyArray<Pending>, cause: unknown): void => {
    // A batch that never reached the server waits for the next send; any answer from the server
    // settles it, so a batch the server refuses can't come back on every launch.
    if (Predicate.isTagged(cause, "TransportError")) {
      requeue(from, batch);

      return;
    }

    if (Predicate.isTagged(cause, "RateLimited")) {
      const seconds = Predicate.hasProperty(cause, "retryAfterSeconds")
        ? cause.retryAfterSeconds
        : undefined;

      pausedUntil = monotonicNow() + (Predicate.isNumber(seconds) ? seconds : 60) * 1000;
    }

    forgetCrashes(batch);
  };

  /** Sends `batch` as `from`, settles it by the answer, and sends the next while active. */
  const deliver = async (
    from: Owner,
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
          release,
          bundle,
          development: options.development,
          events: queued(batch, at),
        })) === "sent";

      if (sent) forgetCrashes(batch);
      else requeue(from, batch);
    } catch (cause) {
      refused(from, batch, cause);
    }

    sending = false;

    if (sent) flush(false);
  };

  /**
   * Sends the next batch to the attached sender. Only while active, unless `leaving`: the one
   * batch that goes as the app moves to the background.
   */
  function flush(leaving: boolean): void {
    stopTimer();

    if (
      (!active && !leaving) ||
      sending ||
      Option.isNone(sender) ||
      !isOwnedBy(owner, sender.value.owner) ||
      pending.length === 0 ||
      monotonicNow() < pausedUntil
    ) {
      return;
    }

    const { owner: from, send } = sender.value;
    const at = wallNow();
    const fresh = pending.filter((each) => at - each.at <= MAX_APP_EVENT_AGE_MS);

    forgetCrashes(pending.filter((each) => !fresh.includes(each)));
    const batch = fresh.slice(0, MAX_APP_EVENTS);

    pending = fresh.slice(MAX_APP_EVENTS);

    if (batch.length === 0) return;
    sending = true;
    void deliver(from, send, batch, at);
  }

  /** Keeps `event` for the current owner; with nobody known, it is dropped. */
  const enqueue = (event: AppEvent): void => {
    if (Option.isNone(owner)) return;
    pending.push({ event, at: wallNow(), crashId: Option.none() });

    if (pending.length > MAX_PENDING_EVENTS) {
      const oldest = pending.findIndex((each) => Option.isNone(each.crashId));

      pending.splice(oldest < 0 ? 0 : oldest, 1);
    }

    arm();
  };

  const dropLaunch = (): void => {
    Option.map(launch, (trace) => trace.cancelWait());
    launch = Option.none();
  };

  const sendLaunch = (trace: LaunchTrace): void => {
    dropLaunch();

    const firstScreen = Option.flatMap(trace.firstScreen, ({ at }) =>
      span(trace.zero, at, MAX_APP_TIMING_MS),
    );

    if (Option.isNone(firstScreen) || Option.isNone(trace.firstScreen)) return;

    const home = Option.flatMap(trace.home, ({ end, source }) =>
      Option.map(span(trace.zero, end.at, MAX_APP_TIMING_MS), (ms) => ({
        ms,
        source,
        hitched: end.hitched,
      })),
    );

    Option.map(
      AppEvent.cases.Launched.makeOption({
        firstScreenVisibleMs: firstScreen.value,
        firstScreenHitched: trace.firstScreen.value.hitched,
        ...Option.match(home, {
          onNone: () => ({}),
          onSome: (homeContent) => ({ homeContent }),
        }),
      }),
      enqueue,
    );
  };

  /** Sends the launch once both marks are in, or waits for Home's content after the first. */
  const settleLaunch = (trace: LaunchTrace): void => {
    if (Option.isNone(trace.firstScreen)) return;

    if (Option.isSome(trace.home)) {
      sendLaunch(trace);

      return;
    }

    trace.cancelWait();

    const cancelWait = schedule(HOME_WAIT_MS, () => {
      Option.map(launch, sendLaunch);
    });

    launch = Option.some({ ...trace, cancelWait });
  };

  const coldLaunch = (): Option.Option<LaunchTrace> =>
    Option.filter(
      Option.fromNullishOr(options.processStartedAt),
      (zero) =>
        !options.startedInBackground &&
        Option.isSome(span(zero, monotonicNow(), MAX_PROCESS_AGE_MS)),
    ).pipe(
      Option.map((zero) => ({
        zero,
        firstScreen: Option.none(),
        home: Option.none(),
        cancelWait: schedule(LAUNCH_WAIT_MS, dropLaunch),
      })),
    );

  launch = coldLaunch();

  const toBackground = (): void => {
    dropLaunch();
    open = Option.none();
    flush(true);
    active = false;
  };

  const toForeground = (): void => {
    active = true;
    arm();
  };

  const saveCrash = (from: Owner, event: AppEvent): void => {
    const at = wallNow();
    const id = `${at.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const entries = saved ?? readCrashFile();

    writeCrashFile([...entries, { id, at, owner: from, event }].slice(-MAX_SAVED_CRASHES));
  };

  const report = (cause: unknown, kind: ClientErrorKind, fatal: boolean): void => {
    if (Option.isNone(owner)) return;
    const from = owner.value;
    const frames = framesOf(cause, scriptUrl);
    const errorClass = errorClassOf(cause);

    const event = AppEvent.cases.ErrorCaught.makeOption({
      kind,
      fatal,
      route,
      errorClass,
      frames,
      ...Option.match(requestIdOf(cause), {
        onNone: () => ({}),
        onSome: (requestId) => ({ requestId }),
      }),
    });

    if (Option.isNone(event)) return;

    if (fatal) {
      saveCrash(from, event.value);

      return;
    }

    const first = frames[0];
    const key = `${kind}\u0000${errorClass}\u0000${route}\u0000${first === undefined ? "" : `${first.source}:${String(first.line)}:${String(first.column)}`}`;

    if (admits(key, monotonicNow())) enqueue(event.value);
  };

  return {
    attach: (next, send) => {
      if (Option.isSome(owner) && !sameOwner(owner.value, next)) pending = [];
      owner = Option.some(next);
      clearSaved = false;
      const attached = { owner: next, send };

      sender = Option.some(attached);
      wantSaved();
      flush(false);
      arm();

      return () => {
        if (Option.contains(sender, attached)) {
          sender = Option.none();
          stopTimer();
        }
      };
    },
    signedOut: () => {
      owner = Option.none();
      sender = Option.none();
      pending = [];
      clearSaved = true;
      stopTimer();
      wantSaved();
    },
    appStateChanged: (state) => {
      if (state === "background") toBackground();
      else if (state === "active") toForeground();
    },
    landed: (next) => {
      if (Option.isSome(landing)) return;
      landing = Option.some(next);

      if (next === "elsewhere") dropLaunch();
      schedule(CRASH_READ_DELAY_MS, frameDrawn);
    },
    launchPending: () => Option.isSome(launch),
    firstScreenVisible: (end) => {
      frameDrawn();

      if (Option.isNone(launch) || Option.isSome(launch.value.firstScreen)) return;
      const trace = { ...launch.value, firstScreen: Option.some(end) };

      launch = Option.some(trace);
      settleLaunch(trace);
    },
    homeContentVisible: (end, source) => {
      if (Option.isNone(launch) || Option.isSome(launch.value.home)) return;
      const trace = { ...launch.value, home: Option.some({ end, source }) };

      launch = Option.some(trace);
      settleLaunch(trace);
    },
    pressed: (screen, id, touchedAt) => {
      nextToken += 1;

      open = Option.some({
        token: nextToken,
        screen,
        id,
        touchedAt,
        claim: Option.none(),
      }).pipe(Option.filter(() => Option.isSome(span(touchedAt, monotonicNow(), OPEN_WAIT_MS))));
    },
    claimOpen: (screen, id, claimingRoute, cache) => {
      if (Option.isNone(open)) return Option.none();
      const waiting = open.value;

      if (
        Option.isSome(waiting.claim) ||
        waiting.screen !== screen ||
        waiting.id !== id ||
        Option.isNone(span(waiting.touchedAt, monotonicNow(), OPEN_WAIT_MS))
      ) {
        return Option.none();
      }

      open = Option.some({ ...waiting, claim: Option.some({ route: claimingRoute }) });

      return Option.some({ token: waiting.token, route: claimingRoute, cache });
    },
    releaseOpen: (claim) => {
      if (Option.exists(open, (waiting) => waiting.token === claim.token)) open = Option.none();
    },
    openContentVisible: (claim, end) => {
      const waiting = Option.filter(
        open,
        (each) =>
          each.token === claim.token &&
          Option.exists(each.claim, (held) => held.route === claim.route),
      );

      if (Option.isNone(waiting)) return;
      open = Option.none();
      const { screen, touchedAt } = waiting.value;

      Option.map(
        Option.flatMap(span(touchedAt, end.at, OPEN_WAIT_MS), (contentVisibleMs) =>
          AppEvent.cases.ScreenOpened.makeOption({
            screen,
            cache: claim.cache,
            contentVisibleMs,
            hitched: end.hitched,
          }),
        ),
        enqueue,
      );
    },
    routeChanged: (next) => {
      route = isRoute(next) ? next : "unknown";
    },
    caught: (cause, kind, fatal) => {
      try {
        report(cause, kind, fatal);
      } catch {
        // A report that can't be made is dropped; the caller may be ending the app.
      }
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
 * React Native set runs after the report, whatever the report did, so a fatal error still ends
 * the app. Hermes tracks rejections only once something turns it on, which React Native does only
 * in development; this turns it on in every build.
 */
export const reportUncaught = (events: AppEvents, sources: UncaughtSources): void => {
  const previous = sources.errorUtils.getGlobalHandler();

  sources.errorUtils.setGlobalHandler((cause, isFatal) => {
    events.caught(cause, "uncaught", isFatal === true);
    previous(cause, isFatal);
  });

  if (!isRejectionTracking(sources.hermes)) return;
  sources.hermes.enablePromiseRejectionTracker({
    allRejections: true,
    onUnhandled: (_id, cause) => {
      events.caught(cause, "unhandled-rejection", false);

      if (sources.development) console.warn("Unhandled promise rejection");
    },
    onHandled: () => undefined,
  });
};
