/**
 * Music group sessions for tests: members whose players follow one session's clock, each with a
 * real `PlaybackController` and `SessionPlayback` over an engine that plays in time, and a core
 * that keeps the session's clock and queue as `core.together` does, every call and every new view
 * one network latency away. Time is Effect's test clock, which the follower, the engines, the core,
 * and the session's timers all read; a device's wall clock may be set apart from it.
 */
import type { SessionClock } from "@media/contracts/clock";
import { positionAt } from "@media/contracts/clock";
import { EpochMillis } from "@media/contracts/units";
import { Clock, Data, Effect, Fiber, ManagedRuntime, Result } from "effect";
import { TestClock } from "effect/testing";

import type { EngineEvent, EnginePlayback, EngineSource, PlayerEngine } from "../engine";
import type { MediaSessionHandlers } from "../media-session";
import { PlaybackController } from "../playback-controller";
import type { MusicCommands, NowPlayingControls, Track } from "../playback-controller";
import { SessionPlayback, SessionPresence } from "../session-playback";
import type {
  ServerTime,
  SessionEnd,
  SessionFollow,
  SessionOp,
  SessionRunner,
  SessionSong,
  SessionTimers,
} from "../session-playback";
import { streamUrl } from "../source-resolver";
import type { SourceResolver } from "../source-resolver";

/** When every scenario starts, on the device's clock. */
const START = 1_760_000_000_000;

/** How far the server's clock runs ahead of every device's. */
const SERVER_OFFSET_MS = 4_000;

/** Each way of every call to the core, and of every view it delivers. */
const LATENCY_MS = 30;

/** How far time moves per step, for the engines to notice the end of a song. */
const STEP_MS = 10;

/** The session every world starts in; a call naming another is refused, as for a session left. */
const SESSION_ID = "session";

/** How far past an end the core carries a skip's start, as `CARRY_MAX_MS` in the core. */
const CARRY_MAX_MS = 10_000;

/** How long before an end the entry a skip carries into was queued first, as `FIRST_BY_MS`. */
const FIRST_BY_MS = 3_000;

/** How early before an end on the clock the core takes a host's end, as `ENDED_EARLY_MS`. */
const ENDED_EARLY_MS = 1_500;

/** A song of `seconds`, named `id`. */
export const song = (id: string, seconds: number): Track => ({
  id,
  title: `Song ${id}`,
  artist: "Artist",
  album: "Album",
  artUrl: null,
  durationMs: seconds * 1000,
  codec: "AAC",
  lossless: false,
});

/** The core refused a call, as `core.together` does. */
class Refused extends Data.TaggedError("Refused")<{ readonly message: string }> {}

/** Something an engine did, when, for checks on what each member heard. */
interface Heard {
  readonly at: number;
  readonly kind: "load" | "advance" | "seek" | "play" | "pause" | "ended";
  readonly song: string | null;
  readonly positionMs: number;
}

/**
 * An engine that plays in time on the test clock: its position moves at its speed while it plays,
 * and at the end of a song it moves on to the preloaded one without a gap, carrying the time past
 * the end, as the gapless engine does, or ends.
 */
class TimedEngine implements PlayerEngine {
  readonly heard: Array<Heard> = [];
  readonly #now: () => number;
  readonly #listeners = new Set<(event: EngineEvent) => void>();
  #current: EngineSource | null = null;
  #queued: EngineSource | null = null;
  #anchorMs = 0;
  #anchorAt = 0;
  #playing = false;
  #stalled = false;
  #rate = 1;
  #lastTime = 0;
  /** Reports a load's start on its next tick rather than at once, as the iOS engine's status does. */
  readonly #late: boolean;
  #unreported: EngineEvent | null = null;
  /**
   * The browser refuses to start it until the person taps the page, as Chromium does under
   * `--autoplay-policy=document-user-activation-required`; one tap allows it from then on.
   */
  #blocked: boolean;

  constructor(now: () => number, late = false, blocked = false) {
    this.#now = now;
    this.#late = late;
    this.#blocked = blocked;
  }

  /** The song it plays, as the id the source's key starts with, or null. */
  get song(): string | null {
    return songOf(this.#current);
  }

  get rate(): number {
    return this.#rate;
  }

  samplePlayback(): EnginePlayback {
    return { positionMs: this.#position(), playing: this.#playing };
  }

  async load(source: EngineSource, startMs: number, autoplay: boolean): Promise<void> {
    // As the HTML engine pauses the element it releases, a load of another source reports a pause.
    if (this.#playing) {
      this.#playing = false;
      this.#emit({ type: "paused" });
    }

    this.#current = source;

    if (this.#queued?.url === source.url) this.#queued = null;

    this.#anchor(startMs);
    this.#playing = autoplay && !this.#blocked;
    this.#note("load", startMs);
    await Promise.resolve();

    if (autoplay && this.#blocked) {
      this.#emit(AUTOPLAY_BLOCKED);

      return;
    }

    const started: EngineEvent = { type: autoplay ? "playing" : "paused" };

    if (this.#late) this.#unreported = started;
    else this.#emit(started);
  }

  preload(source: EngineSource | null): void {
    this.#queued = source;
  }

  async play(): Promise<void> {
    if (this.#current === null) return;

    if (this.#blocked) {
      // As the browser's refusal reaches the HTML and MSE engines, once the element's play rejects.
      await Promise.resolve();
      this.#emit(AUTOPLAY_BLOCKED);

      return;
    }

    this.#anchor(this.#position());
    this.#playing = true;
    this.#note("play", this.#position());
    this.#emit({ type: "playing" });
  }

  pause(): void {
    this.#anchor(this.#position());
    this.#playing = false;
    this.#note("pause", this.#position());
    this.#emit({ type: "paused" });
  }

  seek(positionMs: number): void {
    this.#anchor(positionMs);
    this.#note("seek", positionMs);
    this.#emit({ type: "time", positionMs });
  }

  setVolume(): void {}

  setPlaybackRate(rate: number): void {
    this.#anchor(this.#position());
    this.#rate = rate;
  }

  unload(): void {
    this.#current = null;
    this.#queued = null;
    this.#playing = false;
    this.#anchor(0);
  }

  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** The person taps the page, which lets it start from now on, then does `action` in that tap. */
  tap<A>(action: () => A): A {
    this.#blocked = false;

    return action();
  }

  /** Fails as the media server does once a stream's ticket expired; the player loads it again. */
  expire(): void {
    this.#playing = false;
    this.#emit({ type: "error", reason: "expired", message: "The ticket expired" });
  }

  /** Waits for data while it plays, or plays on. */
  stall(stalled: boolean): void {
    this.#anchor(this.#position());
    this.#stalled = stalled;
    this.#emit({ type: stalled ? "waiting" : "playing" });
  }

  /** Notices the time: moves on at the end of a song, and reports its position now and then. */
  tick(): void {
    const unreported = this.#unreported;

    this.#unreported = null;

    if (unreported !== null) this.#emit(unreported);

    const current = this.#current;

    if (current === null || !this.#playing) return;

    const raw = this.#raw();

    if (raw >= current.durationMs) {
      const next = this.#queued;

      if (next === null) {
        this.#anchor(current.durationMs);
        this.#playing = false;
        this.#note("ended", current.durationMs);
        this.#emit({ type: "time", positionMs: current.durationMs });
        this.#emit({ type: "ended" });

        return;
      }

      this.#current = next;
      this.#queued = null;
      this.#anchor(raw - current.durationMs);
      this.#note("advance", this.#anchorMs);
      this.#emit({ type: "advanced", key: next.key });

      return;
    }

    if (this.#now() - this.#lastTime >= 250) {
      this.#lastTime = this.#now();
      this.#emit({ type: "time", positionMs: this.#position() });
    }
  }

  #raw(): number {
    const moving = this.#playing && !this.#stalled;

    return this.#anchorMs + (moving ? (this.#now() - this.#anchorAt) * this.#rate : 0);
  }

  #position(): number {
    return Math.min(this.#raw(), this.#current?.durationMs ?? 0);
  }

  #anchor(positionMs: number): void {
    this.#anchorMs = positionMs;
    this.#anchorAt = this.#now();
  }

  #note(kind: Heard["kind"], positionMs: number): void {
    this.heard.push({ at: this.#now(), kind, song: this.song, positionMs });
  }

  #emit(event: EngineEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

const AUTOPLAY_BLOCKED: EngineEvent = {
  type: "error",
  reason: "autoplay-blocked",
  message: "The browser blocked playback until you tap play",
};

const songOf = (source: EngineSource | null): string | null =>
  source === null ? null : (source.key.split(":")[0] ?? null);

/** A queue entry of the session, with its song. */
interface Entry {
  readonly key: string;
  /** The entry's id, or null for the song the session started on, as `core.together.get`. */
  readonly entryId: string | null;
  readonly track: Track;
}

/** One person's seat in the session. */
interface Seat {
  readonly name: string;
  readonly hosting: boolean;
  mayControl: boolean;
  readonly playback: SessionPlayback;
  /** Songs this person may not play, which their view hides. */
  readonly hidden: ReadonlySet<string>;
  /** When their view first lists the queue; before, it loads, as its pages do. */
  readonly listedFrom: number;
  /** How much later than a call's answer they hear of the session's change. */
  readonly hearsLateMs: number;
  /** The heartbeats their device's clock is corrected by, when it is not the server's own. */
  readonly presence: SessionPresence | null;
  /** How much later than usual the core's answers to their calls reach them. */
  readonly answersLateMs: number;
  /** How far their device's wall clock was set from where it ran, as a person or NTP sets it. */
  readonly wall: { jumpMs: number };
  /** Their phone's system controls, which order presses against their choices, or null. */
  readonly phone: PhoneControls | null;
}

/**
 * A phone's lock screen and headphones as the iOS app's `RemoteCommands` module and
 * `lockScreenControls` order them (ADR 0018): every press and every choice of the person's takes
 * the next number of one sequence as it is made, and a press, which reaches JavaScript late,
 * applies only if no choice took a number after it. A choice the controller makes while it
 * applies a press is that press.
 */
interface PhoneControls {
  handlers: MediaSessionHandlers | null;
  stamped: number;
  newest: number;
  applying: boolean;
}

/** A device whose clock is off from the server's, and corrected by its own heartbeats. */
interface DeviceClock {
  /** How far the device's clock runs ahead of the server's; behind when negative. */
  readonly skewMs: number;
  /**
   * Each way of its first heartbeat, when it is not the core's usual latency: a lopsided trip
   * makes that sample's estimate of the server's time off by half the difference.
   */
  readonly firstTrip?: { readonly outMs: number; readonly backMs: number };
}

/** A phone's system controls for the controller, ordering presses as `PhoneControls` says. */
const phoneNowPlaying = (phone: PhoneControls): NowPlayingControls => ({
  setHandlers: (handlers) => {
    phone.handlers = handlers;
  },
  show: () => {},
  commanded: () => {
    if (phone.applying) return;

    phone.stamped += 1;
    phone.newest = phone.stamped;
  },
});

/** A call to the core, as the core names it. */
type CallOp =
  | SessionOp
  | ({ readonly kind: "ended" } & SessionEnd)
  | { readonly kind: "playNow"; readonly trackId: string };

/**
 * A call a member made to the core, and how it ended: applied, refused, or for a host's end a
 * little early, scheduled for the end on the clock. The core's own move at that end is a call by
 * `core`.
 */
interface Call {
  readonly by: string;
  readonly op: CallOp;
  readonly at: number;
  readonly outcome: "applied" | "refused" | "scheduled";
  /** Where a move to another entry started it; null for any other move or a refusal. */
  readonly startedAt: number | null;
}

/**
 * A change of the session's song or clock, as the core made it: what played and how before and
 * after, the server's time, and how many entries were queued when it was decided.
 */
export interface Transition {
  readonly by: string;
  readonly kind: CallOp["kind"];
  readonly serverAt: number;
  readonly before: { readonly entry: Entry; readonly clock: SessionClock };
  readonly after: { readonly entry: Entry; readonly clock: SessionClock };
  readonly queued: number;
}

/** A member of the session: their player, and the engine it plays through. */
export interface Member {
  readonly name: string;
  readonly engine: TimedEngine;
  readonly controller: PlaybackController;
  readonly playback: SessionPlayback;
}

/** A session's world: the core, its members, and the test clock they share. */
export interface World {
  readonly now: () => number;
  /** The server's time now. */
  readonly serverNow: () => EpochMillis;
  /** The session's clock as the core keeps it. */
  readonly clock: () => SessionClock;
  /** The song the session plays now, and what it has queued. */
  readonly playing: () => Entry;
  readonly queue: () => ReadonlyArray<Entry>;
  /** The shared position now, by the server's clock. */
  readonly shared: () => number;
  readonly calls: ReadonlyArray<Call>;
  /** Every change of the session's song or clock, in order. */
  readonly transitions: ReadonlyArray<Transition>;
  /** The session the world plays now. */
  readonly sessionId: () => string;
  /** Whether the session is still live: the host has not left. */
  readonly live: () => boolean;
  /** Seats a member who follows the session from now on. */
  readonly join: (
    name: string,
    seat: {
      readonly hosting?: boolean;
      readonly mayControl?: boolean;
      readonly hidden?: ReadonlyArray<string>;
      /** Its engine reports a load's start only on its next status, as the iOS engine does. */
      readonly reportsLate?: boolean;
      /**
       * Its player reads the server's time from its own heartbeats over this clock, rather than
       * knowing it from the start.
       */
      readonly deviceClock?: DeviceClock;
      /** Its view lists the queue only this long after it joins, as pages that load late. */
      readonly listsQueueAfterMs?: number;
      /**
       * It hears of each change this much later than the call that made it answers, as a page
       * whose screen applies a subscription's answer after the mutation's own promise resolves.
       */
      readonly hearsLateMs?: number;
      /** The core's answers to its calls reach it this much later than usual, as on a slow trip. */
      readonly answersLateMs?: number;
      /** Its system controls are a phone's, which order presses against the person's choices. */
      readonly phone?: boolean;
      /** Its browser refuses to start playback until the person taps the page. */
      readonly blocksAutoplay?: boolean;
    },
  ) => Member;
  /**
   * Moves the session as `by` does from a screen of their own, at once, and answers the clock in
   * force; members hear of it one latency later. Throws `Refused` as the core refuses.
   */
  readonly move: (by: string, op: SessionOp) => SessionClock;
  /**
   * `core.together.control` as a member's player calls it, for the session `sessionId` names:
   * refused one latency later once that is not the world's session, as once the person left it.
   */
  readonly control: (by: string, op: SessionOp, sessionId: string) => Promise<SessionClock>;
  /** Queues `track` at the end, or first. */
  readonly add: (track: Track, at?: "next" | "end") => string;
  /**
   * `core.together.add` as `by` calls it, for the session `sessionId` names: queues `trackId` one
   * latency later, refused once that is not the world's session; answers the new entry's id.
   */
  readonly addAs: (
    by: string,
    trackId: string,
    at: "next" | "end",
    sessionId: string | undefined,
  ) => Promise<string>;
  /** Takes entry `key` out of the queue. */
  readonly remove: (key: string) => void;
  /** Moves entry `key` to the front of the queue. */
  readonly toFront: (key: string) => void;
  /** Lets guests control, or not. */
  readonly allowControl: (allowed: boolean) => void;
  /**
   * The person ends the session and starts another on `first`, paused at its start with nothing
   * queued, as they might on another device: every member's view names the new session.
   */
  readonly replaceSession: (first: Track) => void;
  /** The host leaves, which ends the session for everyone, as `core.together.leave` does. */
  readonly hostLeaves: () => void;
  /** Sets `name`'s device wall clock `byMs` from where it ran, as a person or NTP sets it. */
  readonly setWallClock: (name: string, byMs: number) => void;
  /**
   * `name` presses play or pause on their phone's lock screen now; the press reaches the app's
   * JavaScript `deliveredAfterMs` later, as a busy JavaScript thread delivers it.
   */
  readonly press: (name: string, kind: "play" | "pause", deliveredAfterMs: number) => void;
  /** Moves time on by `ms`, letting every timer, engine, and call run in order. */
  readonly advance: (ms: number) => Promise<void>;
  readonly close: () => Promise<void>;
}

/** Lets every promise settled so far run its callbacks. */
const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/** Runs `body` in a world whose session plays `first`, paused at its start, with `queued` next. */
export const scenario = async (
  first: Track,
  queued: ReadonlyArray<Track>,
  body: (world: World) => Promise<void>,
): Promise<void> => {
  const runtime = ManagedRuntime.make(TestClock.layer());

  await runtime.runPromise(TestClock.setTime(START));

  const now = (): number => runtime.runSync(Clock.currentTimeMillis);
  const serverNow = (): EpochMillis => EpochMillis.make(now() + SERVER_OFFSET_MS);

  const timers: SessionTimers = {
    now,
    monotonic: now,
    after: (ms, callback) => {
      const fiber = runtime.runFork(
        Effect.sleep(Math.max(0, ms)).pipe(Effect.andThen(Effect.sync(callback))),
      );

      return () => {
        runtime.runFork(Fiber.interrupt(fiber));
      };
    },
  };

  const runner: SessionRunner = {
    runFork: (effect) => runtime.runFork(effect),
    runPromiseExit: (effect) => runtime.runPromiseExit(effect),
  };

  const later = (ms: number, step: () => void): Promise<void> =>
    runtime.runPromise(Effect.sleep(ms).pipe(Effect.andThen(Effect.sync(step))));

  let clock: SessionClock = {
    status: "paused",
    positionAtAnchorMs: 0,
    anchorServerTime: serverNow(),
    playbackRate: 1,
    revision: 0,
  };

  let entryCount = 0;
  let sessionId = SESSION_ID;
  let live = true;
  let playing: Entry = { key: `start:${SESSION_ID}`, entryId: null, track: first };
  const catalog = new Map<string, Track>([first, ...queued].map((track) => [track.id, track]));

  const newEntry = (track: Track): Entry => {
    entryCount += 1;
    catalog.set(track.id, track);

    const key = `entry-${String(entryCount)}`;

    return { key, entryId: key, track };
  };

  let queue: Array<Entry> = queued.map(newEntry);

  /** The entry queued first and the server time it got there, as the core's `queuedFirst`. */
  let queuedFirst: { readonly key: string; readonly since: number } | null =
    queue[0] === undefined ? null : { key: queue[0].key, since: serverNow() };

  /** Notes the entry queued first after a change to the queue, as every core write does. */
  const noteQueuedFirst = (): void => {
    const head = queue[0];

    if (head?.key === queuedFirst?.key) return;

    queuedFirst = head === undefined ? null : { key: head.key, since: serverNow() };
  };

  /**
   * Where a skip to `entry` starts it, as the core's `carriedPast`: as far as the clock ran past
   * the end of the song playing, only into the entry queued first by `FIRST_BY_MS` before that end,
   * playing on its own since its anchor, up to `CARRY_MAX_MS` and short of the entry's own end.
   */
  const carried = (entry: Entry, server: EpochMillis): number => {
    const length = playing.track.durationMs;

    if (clock.status !== "playing" || clock.positionAtAnchorMs >= length) return 0;

    const endedAt =
      clock.anchorServerTime + (length - clock.positionAtAnchorMs) / clock.playbackRate;

    if (queuedFirst?.key !== entry.key || queuedFirst.since > endedAt - FIRST_BY_MS) return 0;

    const past = positionAt(clock, server) - length;

    return past > 0 && past <= CARRY_MAX_MS && past < entry.track.durationMs ? past : 0;
  };

  let guestsControl = false;
  const seats: Array<Seat> = [];
  const engines: Array<TimedEngine> = [];
  const calls: Array<Call> = [];
  const transitions: Array<Transition> = [];

  const viewFor = (seat: Seat): SessionFollow | null => {
    if (!live) return null;

    const shown = (entry: Entry): SessionSong => ({
      key: entry.key,
      track: seat.hidden.has(entry.track.id) ? null : entry.track,
    });

    const listed = now() >= seat.listedFrom;

    return {
      sessionId,
      hosting: seat.hosting,
      mayControl: seat.hosting || guestsControl,
      clock,
      playing: shown(playing),
      entryId: playing.entryId,
      lengthMs: playing.track.durationMs > 0 ? playing.track.durationMs : null,
      queued: listed ? queue.slice(0, 20).map(shown) : [],
      listing: listed ? (queue.length > 0 ? "listed" : "empty") : "loading",
    };
  };

  /** Each member hears the session as it is now, one latency later, as a subscription does. */
  const deliver = (): void => {
    for (const seat of seats) {
      const view = viewFor(seat);

      void later(LATENCY_MS + seat.hearsLateMs, () => {
        seat.playback.update(view);
      });
    }
  };

  /** Notes a change of the song or the clock that `by`'s `kind` made, decided over `queued`. */
  const note = (
    by: string,
    kind: CallOp["kind"],
    before: Transition["before"],
    queuedThen: number,
  ): void => {
    if (before.entry === playing && before.clock === clock) return;

    transitions.push({
      by,
      kind,
      serverAt: serverNow(),
      before,
      after: { entry: playing, clock },
      queued: queuedThen,
    });
  };

  /** Fails a call `by` made, as the core refuses it. */
  const refusing =
    (by: string, op: CallOp, at: number) =>
    (message: string): never => {
      calls.push({ by, op, at, outcome: "refused", startedAt: null });

      throw new Refused({ message });
    };

  /** A move of the clock, at server time `server`, one revision on. */
  const movedAt =
    (server: EpochMillis) =>
    (fields: Partial<SessionClock>): SessionClock => ({
      ...clock,
      ...fields,
      anchorServerTime: server,
      revision: clock.revision + 1,
    });

  const apply = (by: string, op: SessionOp, calledFor = sessionId): SessionClock => {
    const seat = seats.find((candidate) => candidate.name === by);
    const allowed = seat === undefined || seat.hosting || guestsControl;
    const at = now();
    const refuse = refusing(by, op, at);

    if (calledFor !== sessionId || !live) {
      return refuse("You are no longer in that group session");
    }

    if (!allowed) return refuse("The host has not let guests control playback");

    const server = serverNow();
    const moved = movedAt(server);
    const before = { entry: playing, clock };
    const queuedThen = queue.length;
    const stale = op.revision !== undefined && op.revision !== clock.revision;

    if (stale) return refuse("The session moved on; apply its latest clock and try again");

    let startedAt: number | null = null;

    if (op.kind === "next") {
      const index =
        op.entryId === undefined ? 0 : queue.findIndex((entry) => entry.key === op.entryId);

      const entry = queue[index];

      if (entry === undefined) return refuse("Nothing is queued");

      startedAt = carried(entry, server);
      queue = queue.filter((_, position) => position !== index);
      playing = entry;
      clock = moved({ positionAtAnchorMs: startedAt });
      noteQueuedFirst();
    } else if (op.kind === "play") {
      if (clock.status !== "playing") clock = moved({ status: "playing" });
    } else if (op.kind === "pause") {
      clock = moved({ status: "paused", positionAtAnchorMs: positionAt(clock, server) });
    } else {
      clock = moved({ positionAtAnchorMs: op.positionMs });
    }

    calls.push({ by, op, at, outcome: "applied", startedAt });
    note(by, op.kind, before, queuedThen);
    deliver();

    return clock;
  };

  /**
   * Moves the session on at the end of its song, on the queue as it is now, as the core's
   * `moveOnAtEnd`: to the entry queued first, carried past the end, or with nothing queued,
   * paused back at the song's start. Answers where the next entry started, or null.
   */
  const moveOnAtEnd = (by: string): number | null => {
    const server = serverNow();
    const moved = movedAt(server);
    const before = { entry: playing, clock };
    const queuedThen = queue.length;
    const [next, ...rest] = queue;

    let startedAt: number | null = null;

    if (next === undefined) {
      clock = moved({ status: "paused", positionAtAnchorMs: 0 });
    } else {
      startedAt = carried(next, server);
      queue = rest;
      playing = next;
      clock = moved({ positionAtAnchorMs: startedAt });
      noteQueuedFirst();
    }

    note(by, "ended", before, queuedThen);
    deliver();

    return startedAt;
  };

  /** When the clock reaches the end of the song playing, as the core's `reachedAt`; null never. */
  const endReachedAt = (lengthMs: number): number | null =>
    clock.status === "playing" && clock.positionAtAnchorMs < lengthMs
      ? clock.anchorServerTime + (lengthMs - clock.positionAtAnchorMs) / clock.playbackRate
      : null;

  /**
   * `core.together.ended` as `by`'s player calls it: only the host's; only while the session
   * still plays that entry under that clock; at or past the end on the clock it moves on now, up
   * to `ENDED_EARLY_MS` before it the core moves on itself at the end, and earlier it refuses.
   */
  const applyEnded = (by: string, end: SessionEnd, calledFor: string): SessionClock => {
    const op: CallOp = { kind: "ended", ...end };
    const seat = seats.find((candidate) => candidate.name === by);
    const at = now();
    const refuse = refusing(by, op, at);

    if (calledFor !== sessionId || !live) {
      return refuse("You are no longer in that group session");
    }

    if (seat?.hosting !== true) return refuse("Only the host can do this");

    if (end.revision !== clock.revision || end.entryId !== playing.entryId) {
      return refuse("The session moved on; apply its latest clock and try again");
    }

    const lengthMs = playing.track.durationMs;

    if (!(lengthMs > 0)) return refuse("The session has no length for what it plays");

    const server = serverNow();

    if (positionAt(clock, server) >= lengthMs) {
      const startedAt = moveOnAtEnd(by);

      calls.push({ by, op, at, outcome: "applied", startedAt });

      return clock;
    }

    const endsAt = endReachedAt(lengthMs);

    if (endsAt === null || endsAt - server > ENDED_EARLY_MS) {
      return refuse("What the session plays has not ended on its clock yet");
    }

    const { revision } = clock;
    const { entryId } = playing;
    const scheduledFor = sessionId;

    void later(endsAt - server, () => {
      const same =
        live &&
        sessionId === scheduledFor &&
        clock.revision === revision &&
        playing.entryId === entryId;

      if (!same) return;

      const startedAt = moveOnAtEnd("core");

      calls.push({ by: "core", op, at: now(), outcome: "applied", startedAt });
    });

    calls.push({ by, op, at, outcome: "scheduled", startedAt: null });

    return clock;
  };

  /**
   * `core.together.playNow` as `by` calls it: plays `trackId` from its start, playing, as an entry
   * that never stays queued, while `by` is in the session `calledFor` names and may control.
   */
  const applyPlayNow = (by: string, trackId: string, calledFor: string): SessionClock => {
    const op: CallOp = { kind: "playNow", trackId };
    const seat = seats.find((candidate) => candidate.name === by);
    const at = now();
    const refuse = refusing(by, op, at);

    if (calledFor !== sessionId || !live) {
      return refuse("You are no longer in that group session");
    }

    if (seat?.hosting !== true && !guestsControl) {
      return refuse("The host has not let guests control playback");
    }

    const before = { entry: playing, clock };
    const queuedThen = queue.length;

    playing = newEntry(catalog.get(trackId) ?? song(trackId, 60));
    clock = movedAt(serverNow())({ status: "playing", positionAtAnchorMs: 0 });
    calls.push({ by, op, at, outcome: "applied", startedAt: 0 });
    note(by, "playNow", before, queuedThen);
    deliver();

    return clock;
  };

  /** A call `by` makes to the core: one latency there, and one, plus theirs, back. */
  const call = <A>(by: string, decide: () => A): Promise<A> =>
    runtime.runPromise(
      Effect.gen(function* () {
        const late = seats.find((seat) => seat.name === by)?.answersLateMs ?? 0;

        yield* Effect.sleep(LATENCY_MS);

        const answer = yield* Effect.try({
          try: decide,
          catch: (cause) => (cause instanceof Refused ? cause : new Refused({ message: "failed" })),
        });

        yield* Effect.sleep(LATENCY_MS + late);

        return answer;
      }),
    );

  const control = (by: string, op: SessionOp, calledFor: string): Promise<SessionClock> =>
    call(by, () => apply(by, op, calledFor));

  const heartbeat = (): Promise<{ readonly serverTime: number }> =>
    runtime.runPromise(
      Effect.gen(function* () {
        yield* Effect.sleep(LATENCY_MS);

        const serverTime = serverNow();

        yield* Effect.sleep(LATENCY_MS);

        return { serverTime };
      }),
    );

  /**
   * The timers of a device whose wall clock is off from the server's by `device`, and set
   * `wall.jumpMs` from there since; its monotonic clock, which nothing sets, is the test clock.
   */
  const timersOf = (device: DeviceClock, wall: { readonly jumpMs: number }): SessionTimers => ({
    now: () => serverNow() + device.skewMs + wall.jumpMs,
    monotonic: now,
    after: timers.after,
  });

  /** The server's time as a device off by `device` reads it from its own heartbeats. */
  const presenceOver = (
    device: DeviceClock,
    wall: { readonly jumpMs: number },
  ): SessionPresence => {
    let trips = 0;

    const beat = (): Promise<{ readonly serverTime: number }> => {
      const trip = trips === 0 ? device.firstTrip : undefined;

      trips += 1;

      return runtime.runPromise(
        Effect.gen(function* () {
          yield* Effect.sleep(trip?.outMs ?? LATENCY_MS);

          const serverTime = serverNow();

          yield* Effect.sleep(trip?.backMs ?? LATENCY_MS);

          return { serverTime };
        }),
      );
    };

    const presence = new SessionPresence(beat, timersOf(device, wall));

    presence.keep(SESSION_ID);

    return presence;
  };

  /** The server's time, known from the start, as for a device whose clock is the server's. */
  const exactTime: ServerTime = { now: serverNow, subscribe: () => () => undefined };

  const join: World["join"] = (name, seatOptions) => {
    const engine = new TimedEngine(
      now,
      seatOptions.reportsLate === true,
      seatOptions.blocksAutoplay === true,
    );

    const sources = instantSources();
    const wall = { jumpMs: 0 };

    const phone: PhoneControls | null =
      seatOptions.phone === true
        ? { handlers: null, stamped: 0, newest: 0, applying: false }
        : null;

    const controller = new PlaybackController(
      silentCommands,
      sources,
      { mse: null, create: () => engine },
      {
        canPlay: () => true,
        now,
        monotonicNow: now,
        settings: { quality: "high", volume: 1, gapless: true },
        saveQuality: () => {},
        saveVolume: () => {},
        nowPlaying:
          phone === null
            ? { setHandlers: () => {}, show: () => {}, commanded: () => {} }
            : phoneNowPlaying(phone),
        resume: { load: () => null, save: () => {} },
      },
    );

    controller.start();

    const { deviceClock } = seatOptions;
    const presence = deviceClock === undefined ? null : presenceOver(deviceClock, wall);

    const playback = new SessionPlayback({
      controller,
      commands: {
        heartbeat,
        control: (op, calledFor) => control(name, op, calledFor),
        ended: (end, calledFor) => call(name, () => applyEnded(name, end, calledFor)),
        playNow: (trackId, calledFor) => call(name, () => applyPlayNow(name, trackId, calledFor)),
      },
      serverTime: presence ?? exactTime,
      describe: (cause) => (cause instanceof Refused ? cause.message : "failed"),
      timers: deviceClock === undefined ? timers : timersOf(deviceClock, wall),
      runner,
    });

    playback.start();

    const listsAfter = seatOptions.listsQueueAfterMs ?? 0;

    const seat: Seat = {
      name,
      hosting: seatOptions.hosting === true,
      mayControl: seatOptions.mayControl === true,
      playback,
      hidden: new Set(seatOptions.hidden ?? []),
      listedFrom: now() + listsAfter,
      hearsLateMs: seatOptions.hearsLateMs ?? 0,
      presence,
      answersLateMs: seatOptions.answersLateMs ?? 0,
      wall,
      phone,
    };

    seats.push(seat);
    engines.push(engine);
    playback.update(viewFor(seat));

    if (listsAfter > 0) {
      void later(listsAfter, () => {
        seat.playback.update(viewFor(seat));
      });
    }

    return { name, engine, controller, playback };
  };

  /** One step of time: timers and calls due run, then every engine notices the time. */
  const step = async (): Promise<void> => {
    await runtime.runPromise(TestClock.adjust(STEP_MS));
    await settle();

    for (const engine of engines) engine.tick();

    await settle();
  };

  const advance = async (ms: number): Promise<void> => {
    if (ms <= 0) return;

    await step();

    return advance(ms - STEP_MS);
  };

  const queueAt = (entry: Entry, at: "next" | "end"): void => {
    queue = at === "next" ? [entry, ...queue] : [...queue, entry];
    noteQueuedFirst();
    deliver();
  };

  const seatOf = (name: string): Seat => {
    const seat = seats.find((candidate) => candidate.name === name);

    if (seat === undefined) throw new Error(`${name} has no seat`);

    return seat;
  };

  const world: World = {
    now,
    serverNow,
    clock: () => clock,
    playing: () => playing,
    queue: () => queue,
    shared: () => positionAt(clock, serverNow()),
    calls,
    transitions,
    sessionId: () => sessionId,
    live: () => live,
    join,
    move: (by, op) => apply(by, op),
    control,
    add: (track, at = "end") => {
      const entry = newEntry(track);

      queueAt(entry, at);

      return entry.key;
    },
    addAs: (by, trackId, at, calledFor) =>
      call(by, () => {
        if ((calledFor !== undefined && calledFor !== sessionId) || !live) {
          throw new Refused({ message: "You are no longer in that group session" });
        }

        const entry = newEntry(catalog.get(trackId) ?? song(trackId, 60));

        queueAt(entry, at);

        return entry.key;
      }),
    remove: (key) => {
      queue = queue.filter((entry) => entry.key !== key);
      noteQueuedFirst();
      deliver();
    },
    toFront: (key) => {
      const entry = queue.find((candidate) => candidate.key === key);

      if (entry === undefined) return;

      queue = [entry, ...queue.filter((candidate) => candidate.key !== key)];
      noteQueuedFirst();
      deliver();
    },
    allowControl: (allowed) => {
      guestsControl = allowed;
      deliver();
    },
    replaceSession: (next) => {
      sessionId = `${SESSION_ID}-${String(entryCount + 1)}`;
      catalog.set(next.id, next);
      playing = { key: `start:${sessionId}`, entryId: null, track: next };
      queue = [];
      queuedFirst = null;
      clock = {
        status: "paused",
        positionAtAnchorMs: 0,
        anchorServerTime: serverNow(),
        playbackRate: 1,
        revision: 0,
      };
      deliver();
    },
    hostLeaves: () => {
      live = false;
      deliver();
    },
    setWallClock: (name, byMs) => {
      seatOf(name).wall.jumpMs += byMs;
    },
    press: (name, kind, deliveredAfterMs) => {
      const { phone } = seatOf(name);

      if (phone === null) throw new Error(`${name} has no phone`);

      phone.stamped += 1;

      const stamp = phone.stamped;

      void later(deliveredAfterMs, () => {
        if (stamp < phone.newest) return;

        phone.applying = true;

        try {
          phone.handlers?.[kind]();
        } finally {
          phone.applying = false;
        }
      });
    },
    advance,
    close: async () => {
      for (const seat of seats) {
        seat.playback.update(null);
        seat.presence?.keep(null);
      }

      await runtime.dispose();
    },
  };

  try {
    await body(world);
  } finally {
    await world.close();
  }
};

/** Sources that answer at once, a stream per song, as tickets do. */
const instantSources = (): SourceResolver => {
  let starts = 0;

  return {
    resolve: async (track, profile) => {
      starts += 1;

      return Result.succeed({
        profile,
        origin: "stream",
        playbackId: `start-${String(starts)}`,
        renewAt: Number.POSITIVE_INFINITY,
        source: {
          key: `${track.id}:${profile}:start-${String(starts)}`,
          url: streamUrl("http://media.test", track.id, `ticket-${String(starts)}`, profile),
          durationMs: track.durationMs,
          finished: false,
        },
      });
    },
    discard: () => {},
  };
};

/** The music commands of a player in a session, which never touch the person's own queue. */
const silentCommands: MusicCommands = {
  play: async () => ({ current: "own" }),
  track: async (trackId) => song(trackId, 60),
  jump: async () => {},
  report: async () => {},
};
