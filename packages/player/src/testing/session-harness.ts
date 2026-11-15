/**
 * Music group sessions for tests: members whose players follow one session's clock, each with a
 * real `PlaybackController` and `SessionPlayback` over an engine that plays in time, and a core
 * that keeps the session's clock and queue as `core.together` does, every call and every new view
 * one network latency away. Time is Effect's test clock, which the follower, the engines, the core,
 * and the session's timers all read.
 */
import type { SessionClock } from "@media/contracts/clock";
import { positionAt } from "@media/contracts/clock";
import { EpochMillis } from "@media/contracts/units";
import { Clock, Data, Effect, Fiber, ManagedRuntime, Result } from "effect";
import { TestClock } from "effect/testing";

import type { EngineEvent, EnginePlayback, EngineSource, PlayerEngine } from "../engine";
import { PlaybackController } from "../playback-controller";
import type { MusicCommands, Track } from "../playback-controller";
import { SessionPlayback, SessionPresence } from "../session-playback";
import type {
  ServerTime,
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

/** The session every world plays; a call naming another is refused, as for a session left. */
const SESSION_ID = "session";

/** How far past an end the core carries a skip's start, as `CARRY_MAX_MS` in the core. */
const CARRY_MAX_MS = 10_000;

/** How long before an end the entry a skip carries into was queued first, as `FIRST_BY_MS`. */
const FIRST_BY_MS = 3_000;

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

  constructor(now: () => number, late = false) {
    this.#now = now;
    this.#late = late;
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
    this.#playing = autoplay;
    this.#note("load", startMs);
    await Promise.resolve();

    const started: EngineEvent = { type: autoplay ? "playing" : "paused" };

    if (this.#late) this.#unreported = started;
    else this.#emit(started);
  }

  preload(source: EngineSource | null): void {
    this.#queued = source;
  }

  async play(): Promise<void> {
    if (this.#current === null) return;

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

const songOf = (source: EngineSource | null): string | null =>
  source === null ? null : (source.key.split(":")[0] ?? null);

/** A queue entry of the session, with its song. */
interface Entry {
  readonly key: string;
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
  /** The heartbeats their device's clock is corrected by, when it is not the server's own. */
  readonly presence: SessionPresence | null;
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

/** A call a member made to the core, and how it ended. */
interface Call {
  readonly by: string;
  readonly op: SessionOp;
  readonly at: number;
  readonly outcome: "applied" | "refused";
  /** Where a skip started the entry it played; null for any other move or a refusal. */
  readonly startedAt: number | null;
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
  /** Takes entry `key` out of the queue. */
  readonly remove: (key: string) => void;
  /** Moves entry `key` to the front of the queue. */
  readonly toFront: (key: string) => void;
  /** Lets guests control, or not. */
  readonly allowControl: (allowed: boolean) => void;
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
  let playing: Entry = { key: "start:session", track: first };

  const newEntry = (track: Track): Entry => {
    entryCount += 1;

    return { key: `entry-${String(entryCount)}`, track };
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

  const viewFor = (seat: Seat): SessionFollow => {
    const shown = (entry: Entry): SessionSong => ({
      key: entry.key,
      track: seat.hidden.has(entry.track.id) ? null : entry.track,
    });

    const listed = now() >= seat.listedFrom;

    return {
      sessionId: SESSION_ID,
      hosting: seat.hosting,
      mayControl: seat.hosting || guestsControl,
      clock,
      playing: shown(playing),
      queued: listed ? queue.slice(0, 20).map(shown) : [],
      listing: listed ? (queue.length > 0 ? "listed" : "empty") : "loading",
    };
  };

  /** Each member hears the session as it is now, one latency later, as a subscription does. */
  const deliver = (): void => {
    for (const seat of seats) {
      const view = viewFor(seat);

      void later(LATENCY_MS, () => {
        seat.playback.update(view);
      });
    }
  };

  const apply = (by: string, op: SessionOp, sessionId = SESSION_ID): SessionClock => {
    const seat = seats.find((candidate) => candidate.name === by);
    const allowed = seat === undefined || seat.hosting || guestsControl;
    const at = now();

    const refuse = (message: string): never => {
      calls.push({ by, op, at, outcome: "refused", startedAt: null });

      throw new Refused({ message });
    };

    if (sessionId !== SESSION_ID) return refuse("You are no longer in that group session");

    if (!allowed) return refuse("The host has not let guests control playback");

    const server = serverNow();

    const moved = (fields: Partial<SessionClock>): SessionClock => ({
      ...clock,
      ...fields,
      anchorServerTime: server,
      revision: clock.revision + 1,
    });

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
    deliver();

    return clock;
  };

  const control = (by: string, op: SessionOp, sessionId: string): Promise<SessionClock> =>
    runtime.runPromise(
      Effect.gen(function* () {
        yield* Effect.sleep(LATENCY_MS);

        const answer = yield* Effect.try({
          try: () => apply(by, op, sessionId),
          catch: (cause) => (cause instanceof Refused ? cause : new Refused({ message: "failed" })),
        });

        yield* Effect.sleep(LATENCY_MS);

        return answer;
      }),
    );

  const heartbeat = (): Promise<{ readonly serverTime: number }> =>
    runtime.runPromise(
      Effect.gen(function* () {
        yield* Effect.sleep(LATENCY_MS);

        const serverTime = serverNow();

        yield* Effect.sleep(LATENCY_MS);

        return { serverTime };
      }),
    );

  /** The timers of a device whose clock is off from the server's by `device`. */
  const timersOf = (device: DeviceClock): SessionTimers => ({
    now: () => serverNow() + device.skewMs,
    after: timers.after,
  });

  /** The server's time as a device off by `device` reads it from its own heartbeats. */
  const presenceOver = (device: DeviceClock): SessionPresence => {
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

    const presence = new SessionPresence(beat, timersOf(device));

    presence.keep(SESSION_ID);

    return presence;
  };

  /** The server's time, known from the start, as for a device whose clock is the server's. */
  const exactTime: ServerTime = { now: serverNow, subscribe: () => () => undefined };

  const join: World["join"] = (name, seatOptions) => {
    const engine = new TimedEngine(now, seatOptions.reportsLate === true);
    const sources = instantSources();

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
        nowPlaying: { setHandlers: () => {}, show: () => {}, commanded: () => {} },
        resume: { load: () => null, save: () => {} },
      },
    );

    controller.start();

    const { deviceClock } = seatOptions;
    const presence = deviceClock === undefined ? null : presenceOver(deviceClock);

    const playback = new SessionPlayback({
      controller,
      commands: { heartbeat, control: (op, sessionId) => control(name, op, sessionId) },
      serverTime: presence ?? exactTime,
      describe: (cause) => (cause instanceof Refused ? cause.message : "failed"),
      timers: deviceClock === undefined ? timers : timersOf(deviceClock),
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
      presence,
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

  const world: World = {
    now,
    serverNow,
    clock: () => clock,
    playing: () => playing,
    queue: () => queue,
    shared: () => positionAt(clock, serverNow()),
    calls,
    join,
    move: (by, op) => apply(by, op),
    control,
    add: (track, at = "end") => {
      const entry = newEntry(track);

      queue = at === "next" ? [entry, ...queue] : [...queue, entry];
      noteQueuedFirst();
      deliver();

      return entry.key;
    },
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
