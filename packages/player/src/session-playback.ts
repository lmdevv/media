/**
 * Music group sessions on the player (ADR 0017): the person's music session plays through the
 * same controller and engine as their own queue, following the session's shared clock with the
 * follower `@media/contracts` holds for every client.
 *
 * The session's queue reaches the controller as a queue whose playing entry is first, so the
 * gapless engine preloads what the session plays next and moves on to it by itself at the end of
 * a song. Only the session moves on, though, and the core decides when, as old music's jams did:
 * the host's player says when its engine finished the session's song (`core.together.ended`), and
 * the core, once its own clock agrees, reads its queue and moves on to what is queued then, as far
 * in as the clock ran past the end (`carriedPast`), so every member's engine, which moved on at
 * that end, is still in step; with nothing queued then, it pauses back at the song's start.
 *
 * One identity rule (ADR 0017): every follower is made for one playing entry and one load of it,
 * and stops as soon as either changes; the host's end names the entry and the clock revision it
 * played under and applies only if the core still plays them; a viewer's move goes through the
 * follower, which numbers each command it gives the player. Every call to the core names the
 * session it was made for, which the core refuses once the person is no longer in it, so nothing
 * made for one session lands in the session that replaced it.
 */
import {
  CLOCK_SAMPLING,
  HEARTBEAT_MS,
  estimateClockOffset,
  positionAt,
  toServerTime,
} from "@media/contracts/clock";
import type { ClockSample, SessionClock } from "@media/contracts/clock";
import { run } from "@media/contracts/follower";
import type {
  ClockMove,
  Follower,
  FollowerState,
  Hold,
  SessionPort,
  ViewerMove,
} from "@media/contracts/follower";
import { EpochMillis } from "@media/contracts/units";
import { Data, Effect, Exit, Fiber, Option, Stream } from "effect";

import type { MediaSessionHandlers } from "./media-session";
import type {
  PlaybackController,
  QueueEntry,
  QueueState,
  SessionStart,
  Track,
} from "./playback-controller";

/** A move `core.together.control` takes: one of the clock's, or a skip to a queued entry. */
export type SessionOp =
  | ClockMove
  | { readonly kind: "next"; readonly revision: number; readonly entryId?: string };

/**
 * `core.together.control` in music, for the session `sessionId` names, which the core refuses once
 * the person is no longer in it: answers the clock in force.
 */
export type SessionControl = (op: SessionOp, sessionId: string) => Promise<SessionClock>;

/** What a host's player says finished: the entry it played, under the clock it played it. */
export interface SessionEnd {
  /** The entry's id, or null for the song the session started on. */
  readonly entryId: string | null;
  readonly revision: number;
}

/** The core's group-session calls the music player makes; each rejects with the SDK's errors. */
export interface SessionCommands {
  /** `core.together.heartbeat` in music: keeps the person present and answers the server's time. */
  readonly heartbeat: () => Promise<{ readonly serverTime: number }>;
  readonly control: SessionControl;
  /**
   * `core.together.ended` in music, for the session `sessionId` names: the host's player says what
   * the session plays finished; the core moves on once its clock agrees. Answers the clock in
   * force.
   */
  readonly ended: (end: SessionEnd, sessionId: string) => Promise<SessionClock>;
  /**
   * `core.together.playNow` in music, for the session `sessionId` names: plays the song `trackId`
   * now for everyone, from its start. Answers the clock in force.
   */
  readonly playNow: (trackId: string, sessionId: string) => Promise<SessionClock>;
}

/** One entry of a session as the player plays it: its key, and its song unless it is hidden. */
export interface SessionSong<T extends Track = Track> {
  /** The entry's id, or for the song a session started on `playingKey`'s. */
  readonly key: string;
  /** Null when this person may not play it, or while its details load. */
  readonly track: T | null;
}

/**
 * What a player knows of a session's queue: nothing yet, as while its pages first load; a whole
 * listing with no entries; or entries, from a whole listing. Only an empty whole listing says the
 * session has nothing to move on to.
 */
export type QueueListing = "loading" | "empty" | "listed";

/** The person's music session, as the player follows it. */
export interface SessionFollow<T extends Track = Track> {
  readonly sessionId: string;
  /** The host's player moves the session on at the end of each song. */
  readonly hosting: boolean;
  readonly mayControl: boolean;
  readonly clock: SessionClock;
  readonly playing: SessionSong<T>;
  /** The queue entry the playing song came from, or null for the song the session started on. */
  readonly entryId: string | null;
  /**
   * The playing song's length, as the core knows it, even when this person may not play it, or
   * null when it knows none.
   */
  readonly lengthMs: number | null;
  /** What plays next, in order, as far as it was read. */
  readonly queued: ReadonlyArray<SessionSong<T>>;
  /** Whether anything is queued, as far as the queue is listed. */
  readonly listing: QueueListing;
}

/** Time as the session sees it: the device's clocks and one-shot timers. */
export interface SessionTimers {
  /** The device's wall clock, which the person or the network may set at any moment. */
  readonly now: () => number;
  /**
   * A clock that only runs forward at a steady pace, from an arbitrary start, which nothing sets:
   * the server's time is estimated on it, so a wall clock set meanwhile moves nothing.
   */
  readonly monotonic: () => number;
  /** Calls `callback` once after `ms`; returns the function that cancels it. */
  readonly after: (ms: number, callback: () => void) => () => void;
}

/** The wall clock, `performance.now()`, and `setTimeout`. */
export const systemTimers: SessionTimers = {
  now: Date.now,
  monotonic: () => performance.now(),
  after: (ms, callback) => {
    const timer = setTimeout(callback, ms);

    return () => {
      clearTimeout(timer);
    };
  },
};

/**
 * Runs the follower's effects. The default runs them on the global runtime; a test runs them on a
 * runtime with a test clock, as it moves time on for the engine and the session too.
 */
export interface SessionRunner {
  readonly runFork: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
  readonly runPromiseExit: <A, E>(effect: Effect.Effect<A, E>) => Promise<Exit.Exit<A, E>>;
}

const globalRunner: SessionRunner = {
  runFork: (effect) => Effect.runFork(effect),
  runPromiseExit: (effect) => Effect.runPromiseExit(effect),
};

/**
 * The server's time, as a client estimates it from heartbeats on its monotonic clock
 * (`SessionPresence`).
 */
export interface ServerTime {
  /** The server's time now, or null until a heartbeat answered. */
  readonly now: () => EpochMillis | null;
  /** Calls `listener` after each heartbeat answer, which corrects `now`; returns the unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void;
}

/** What a `SessionPlayback` works with. */
export interface SessionPlaybackOptions {
  readonly controller: PlaybackController;
  readonly commands: SessionCommands;
  readonly serverTime: ServerTime;
  /** Says why a call failed, for the screen. */
  readonly describe: (cause: unknown) => string;
  readonly timers?: SessionTimers;
  readonly runner?: SessionRunner;
}

/** The key of the entry a session plays: its queue entry's id, or one for the song it started on. */
export const playingKey = (sessionId: string, entryId: string | null): string =>
  entryId ?? `start:${sessionId}`;

/**
 * How long after a song's end on the session's clock the host's player says it ended when its
 * engine has not: a song hidden from the host, or a player the browser held back or that stalled.
 * An engine that plays the song in step says so at its end, well inside this.
 */
const FALLBACK_MS = 1_000;

/** How long a host's end the core refused, or that did not reach it, waits before it is tried again. */
const RETRY_MS = 2_000;

/** What a member hears who may not move the session, in old music's words. */
export const NO_CONTROL = "The host controls playback in this Jam";

/** A session call the core refused or that did not reach it; `message` says why, for the screen. */
export class SessionCallFailed extends Data.TaggedError("SessionCallFailed")<{
  readonly message: string;
}> {}

/** What the screen shows of the follower: how it follows, how far off it is, and any hold. */
export interface SessionPlaybackState {
  /** The follower's state, or null while none follows, as while the song loads. */
  readonly follower: FollowerState | null;
}

const IDLE: SessionPlaybackState = { follower: null };

/** The host's fallback at a song's end on its way: the wait for the end, or before a retry. */
interface EndStep {
  readonly kind: "end" | "retry";
  readonly cancel: () => void;
}

/** The follower running for one playing entry and one load of it. */
interface Running {
  readonly key: string;
  readonly load: number;
  fiber: Fiber.Fiber<void, unknown> | null;
  /** The follower, once it sampled the server's clock and started. */
  follower: Follower<SessionCallFailed> | null;
}

/**
 * Keeps a person present in their music session, and waiting for one, with a heartbeat every
 * `HEARTBEAT_MS` on any screen, and estimates the server's time from the answers on the device's
 * monotonic clock, so a wall clock set while a song plays moves nothing (ADR 0017).
 */
export class SessionPresence implements ServerTime {
  readonly #heartbeat: () => Promise<{ readonly serverTime: number }>;
  readonly #timers: SessionTimers;
  readonly #listeners = new Set<() => void>();
  #samples: ReadonlyArray<ClockSample> = [];
  #beating: string | null = null;
  #stop: (() => void) | null = null;

  constructor(
    heartbeat: () => Promise<{ readonly serverTime: number }>,
    timers: SessionTimers = systemTimers,
  ) {
    this.#heartbeat = heartbeat;
    this.#timers = timers;
  }

  /** Sends heartbeats for `sessionId` while it is set, or stops with null. */
  keep(sessionId: string | null): void {
    if (sessionId === this.#beating) return;

    this.#stop?.();
    this.#stop = null;
    this.#beating = sessionId;

    if (sessionId === null) return;

    const beat = (): void => {
      if (this.#beating !== sessionId) return;

      this.#beat();
      this.#stop = this.#timers.after(HEARTBEAT_MS, beat);
    };

    beat();
  }

  /** The server's time now, as heartbeats estimate it, or null until one answered. */
  now = (): EpochMillis | null => {
    const offset = estimateClockOffset(this.#samples);

    return offset === undefined ? null : toServerTime(this.#timers.monotonic(), offset);
  };

  /** Calls `listener` after each heartbeat answer; returns the unsubscribe. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };

  #beat(): void {
    const sentAt = this.#timers.monotonic();

    this.#heartbeat().then(
      ({ serverTime }) => {
        const sample: ClockSample = {
          sentAt,
          serverTime: EpochMillis.make(Math.round(serverTime)),
          receivedAt: this.#timers.monotonic(),
        };

        this.#samples = [...this.#samples, sample].slice(-CLOCK_SAMPLING.kept);

        for (const listener of this.#listeners) listener();

        return undefined;
      },
      () => undefined,
    );
  }
}

/**
 * Plays the person's music session through `controller` (module documentation). Feed it the
 * session with `update` as it changes, and route the player's play, pause, seek, and skips to it
 * while a session plays.
 */
export class SessionPlayback<T extends Track = Track> {
  readonly #controller: PlaybackController;
  readonly #commands: SessionCommands;
  readonly #serverTime: ServerTime;
  readonly #describe: (cause: unknown) => string;
  readonly #timers: SessionTimers;
  readonly #runner: SessionRunner;
  readonly #listeners = new Set<() => void>();
  #view: SessionFollow<T> | null = null;
  #running: Running | null = null;
  /** The stall hold a follower left, which the next follower of the same session takes over. */
  #hold: Hold | null = null;
  #heldIn: string | null = null;
  #end: EndStep | null = null;
  /** The host's end on its way, as the clock revision it was made under. */
  #movingOn: number | null = null;
  /** As the host, the engine's end of the playing entry `key` is heard until `stop`. */
  #endHeard: { readonly key: string; readonly stop: () => void } | null = null;
  #snapshot: SessionPlaybackState = IDLE;
  #unsubscribe: (() => void) | null = null;

  constructor({
    controller,
    commands,
    serverTime,
    describe,
    timers = systemTimers,
    runner = globalRunner,
  }: SessionPlaybackOptions) {
    this.#controller = controller;
    this.#commands = commands;
    this.#serverTime = serverTime;
    this.#describe = describe;
    this.#timers = timers;
    this.#runner = runner;
  }

  /** The follower's port to the session `sessionId`: each move it makes names that session. */
  #portTo(sessionId: string): SessionPort<SessionCallFailed> {
    const commands = this.#commands;

    const failed = (cause: unknown): SessionCallFailed =>
      new SessionCallFailed({ message: this.#describe(cause) });

    return {
      heartbeat: Effect.tryPromise({ try: () => commands.heartbeat(), catch: failed }),
      control: (move) =>
        Effect.tryPromise({ try: () => commands.control(move, sessionId), catch: failed }),
    };
  }

  /** The follower's state now. Stable between changes, for `useSyncExternalStore`. */
  getSnapshot = (): SessionPlaybackState => this.#snapshot;

  /** Calls `listener` after every change of the follower's state; returns the unsubscribe. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };

  /**
   * Starts watching what the engine plays and the server's time; returns the function that stops
   * all of it. Each heartbeat answer plans the host's fallback at the end again, on the corrected
   * time.
   */
  start(): () => void {
    this.#unsubscribe?.();

    const stopEngine = this.#controller.subscribe(() => {
      this.#reconcile();
    });

    const stopTime = this.#serverTime.subscribe(() => {
      if (this.#end?.kind !== "retry") this.#planEnd();
    });

    this.#unsubscribe = () => {
      stopEngine();
      stopTime();
    };

    return () => {
      this.update(null);
      this.#unsubscribe?.();
      this.#unsubscribe = null;
    };
  }

  /**
   * Follows `view`, the person's music session as it is now, or goes back to their own queue with
   * null. A new clock reaches the running follower, which applies only a newer one.
   */
  update(view: SessionFollow<T> | null, started = false): void {
    const before = this.#view;

    this.#view = view;

    if (view === null) {
      this.#stopFollower();
      this.#cancelEnd();
      this.#listenForEnd();
      this.#hold = null;

      if (before !== null) this.#controller.followSession(null);

      return;
    }

    if (before?.sessionId !== view.sessionId) {
      this.#stopFollower();
      this.#movingOn = null;
      this.#controller.followSession(
        { startAt: (itemId) => this.#startAt(itemId), controls: this.#controls },
        started,
      );
    }

    this.#controller.sync(queueOf(view));
    this.#reconcile();
    this.#listenForEnd();

    const running = this.#running?.follower ?? null;

    if (running !== null) {
      this.#runner.runFork(running.allow(view.mayControl));
      this.#runner.runFork(running.apply(view.clock));
    }

    this.#planEnd();
  }

  /**
   * Plays or pauses the session for everyone, as a member who may control. A member who may not
   * only starts their own player when the browser held it back. Resolves with why the session
   * refused, for the screen, or null. It is the person's choice, so a phone's press made before it
   * applies to nothing (`PlaybackController.sessionChoice`), as outside a session.
   */
  async togglePlay(): Promise<string | null> {
    const view = this.#view;

    if (view === null) return null;

    this.#controller.sessionChoice();

    const key = this.#running?.key;
    const state = this.#snapshot.follower;

    if (!view.mayControl) {
      // The browser held this player back, or something outside paused it, as a call does: a tap
      // starts it, which moves only this player, and it follows the clock again once it plays.
      if (this.#heldHere() && key !== undefined) {
        await this.#controller
          .followerPlayer(key)
          .play()
          .catch(() => undefined);

        return null;
      }

      return NO_CONTROL;
    }

    const playing = state?.follow === "blocked" ? false : view.clock.status === "playing";

    return this.#move(playing ? { kind: "pause" } : { kind: "play" });
  }

  /**
   * Plays the song `trackId` now for everyone in the session `sessionId`, the one the person chose
   * it in, from its start, playing, as a member who may control. The core does it in one write
   * bound to that session, which it refuses once the person is no longer in it, so nothing it
   * answers late plays in a session that replaced it. Resolves with why the session refused, for
   * the screen, or null.
   */
  async playNow(trackId: string, sessionId: string): Promise<string | null> {
    if (this.#view?.mayControl !== true) return NO_CONTROL;

    this.#controller.sessionChoice();

    try {
      await this.#commands.playNow(trackId, sessionId);

      return null;
    } catch (cause) {
      return this.#describe(cause);
    }
  }

  /** Seeks the session for everyone, as a member who may control. */
  seek(positionMs: number): Promise<string | null> {
    if (this.#view?.mayControl !== true) {
      return Promise.resolve(NO_CONTROL);
    }

    return this.#move({ kind: "seek", positionMs: Math.max(0, Math.round(positionMs)) });
  }

  /** Moves the session on to what is queued next, as a member who may control. */
  next(): Promise<string | null> {
    return this.#skip(undefined);
  }

  /**
   * Starts the song again, as a member who may control: a session keeps no songs it played, so
   * there is no song before to go back to, as old music's jam queue had.
   */
  previous(): Promise<string | null> {
    return this.seek(0);
  }

  /**
   * Plays the queued entry `key` now for everyone, as a member who may control. It picks a song, so
   * it is the person's choice, as a jump outside a session is (`PlaybackController.sessionChoice`).
   */
  jump(key: string): Promise<string | null> {
    if (this.#view?.mayControl === true) this.#controller.sessionChoice();

    return this.#skip(key);
  }

  /**
   * Whether this player sits out a session that plays: the browser held it back, or something
   * outside it paused it while the person may not control the session.
   */
  #heldHere(): boolean {
    const follow = this.#snapshot.follower?.follow;

    return (
      this.#view?.clock.status === "playing" && (follow === "blocked" || follow === "detached")
    );
  }

  /** The system's media controls, which move the session as the player's own controls do. */
  readonly #controls: MediaSessionHandlers = {
    play: () => {
      if (this.#view?.clock.status !== "playing" || this.#heldHere()) void this.togglePlay();
    },
    pause: () => {
      if (this.#view?.clock.status === "playing") void this.togglePlay();
    },
    next: () => {
      void this.next();
    },
    previous: () => {
      void this.previous();
    },
    seekTo: (positionMs) => {
      void this.seek(positionMs);
    },
  };

  /**
   * A viewer's move: through the follower while one runs, which moves the player at once and
   * corrects it once the core answers; straight to the core while the song loads.
   */
  async #move(move: ViewerMove): Promise<string | null> {
    const view = this.#view;
    const follower = this.#running?.follower ?? null;

    if (view === null) return null;

    if (follower !== null) {
      const exit = await this.#runner.runPromiseExit(follower.move(move));

      if (Exit.isSuccess(exit)) return null;

      return Option.match(Exit.findErrorOption(exit), {
        onNone: () => "The session could not take that",
        onSome: (failure) => failure.message,
      });
    }

    const op: SessionOp =
      move.kind === "seek"
        ? { kind: "seek", positionMs: move.positionMs, revision: view.clock.revision }
        : move;

    return this.#send(op, view.sessionId);
  }

  /** Skips to `key`, or to what is queued first, against the clock the viewer saw. */
  #skip(key: string | undefined): Promise<string | null> {
    const view = this.#view;

    if (view === null) return Promise.resolve(null);

    if (!view.mayControl) {
      return Promise.resolve(NO_CONTROL);
    }

    // A named entry may be one just added, which the view shows only once the queue answers; the
    // core refuses one no longer queued, as it refuses a skip sent while the queue loads when
    // nothing is queued.
    if (key === undefined && view.listing === "empty") return Promise.resolve(null);

    const op: SessionOp =
      key === undefined
        ? { kind: "next", revision: view.clock.revision }
        : { kind: "next", revision: view.clock.revision, entryId: key };

    return this.#send(op, view.sessionId);
  }

  async #send(op: SessionOp, sessionId: string): Promise<string | null> {
    try {
      await this.#commands.control(op, sessionId);

      return null;
    } catch (cause) {
      return this.#describe(cause);
    }
  }

  #startAt(itemId: string): SessionStart {
    const view = this.#view;

    if (view?.playing.key !== itemId) return { positionMs: 0, playing: false };

    // Until a heartbeat answered, the device's time; the follower corrects it once it samples.
    const serverNow = this.#serverTime.now() ?? EpochMillis.make(Math.max(0, this.#timers.now()));

    return {
      positionMs: positionAt(view.clock, serverNow),
      playing: view.clock.status === "playing",
    };
  }

  /**
   * Runs one follower for the session's playing entry once the engine plays it, and keeps it while
   * the engine moves on from it to the preloaded entry by itself, which the session has yet to
   * confirm. A new playing entry, a new load of it, or the engine losing it stops the follower;
   * the stall hold it left goes on to the next one.
   */
  #reconcile(): void {
    const view = this.#view;
    const ready = this.#controller.getSnapshot().ready;
    const running = this.#running;

    const keep =
      view !== null &&
      running !== null &&
      ready !== null &&
      running.key === view.playing.key &&
      running.load === ready.load;

    if (keep) return;

    this.#stopFollower();

    if (view === null || ready === null || ready.itemId !== view.playing.key) return;

    this.#startFollower(view, ready.itemId, ready.load);
  }

  #startFollower(view: SessionFollow<T>, key: string, load: number): void {
    if (this.#heldIn !== view.sessionId) this.#hold = null;
    this.#heldIn = view.sessionId;

    const durationMs = (): number | null => {
      const latest = this.#view;
      const track = latest?.playing.key === key ? latest.playing.track : null;

      return track === null || !(track.durationMs > 0) ? null : track.durationMs;
    };

    const player = this.#controller.followerPlayer(key);
    const port = this.#portTo(view.sessionId);
    const resumeHold = this.#hold;
    const latestView = (): SessionFollow<T> => this.#view ?? view;

    const took = (state: FollowerState): void => {
      this.#hold = state.holding;
      this.#publish({ follower: state });
    };

    const running: Running = { key, load, follower: null, fiber: null };

    this.#running = running;

    running.fiber = this.#runner.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          const started = latestView();

          const following = yield* run({
            player,
            port,
            clock: started.clock,
            durationMs,
            controls: started.mayControl,
            pausesForStalls: started.hosting,
            resumeHold,
          });

          running.follower = following;

          // The session may have moved while the follower sampled the server's clock.
          const current = latestView();

          yield* following.allow(current.mayControl);
          yield* following.apply(current.clock);
          yield* Stream.runForEach(following.state, (state) => Effect.sync(() => took(state)));
        }),
      ),
    );
  }

  #stopFollower(): void {
    const running = this.#running;

    if (running === null) return;

    this.#running = null;

    if (running.fiber !== null) this.#runner.runFork(Fiber.interrupt(running.fiber));

    this.#publish(IDLE);
  }

  /**
   * As the host, hears the engine's end of the session's playing entry, as old music's player
   * moved its jam on at the end of the host's song: the engine says the entry finished, by itself
   * at its end or by moving on to the preloaded entry without a gap, and the host's player tells
   * the core (`#sayEnded`), which decides. Nobody else's engine moves the session on.
   */
  #listenForEnd(): void {
    const view = this.#view;
    const key = view?.hosting === true ? view.playing.key : null;

    if (this.#endHeard?.key === key) return;

    this.#endHeard?.stop();
    this.#endHeard = null;

    if (key === null) return;

    const stop = this.#controller.followerPlayer(key).subscribe((event) => {
      if (event === "ended") this.#engineEnded(key);
    });

    this.#endHeard = { key, stop };
  }

  #engineEnded(key: string): void {
    const view = this.#view;
    const lengthMs = view?.lengthMs ?? null;

    // With no known length, the core has no end on its clock to agree with; someone skips it.
    if (
      view?.hosting !== true ||
      view.playing.key !== key ||
      lengthMs === null ||
      !(lengthMs > 0)
    ) {
      return;
    }

    void this.#sayEnded(view);
  }

  /**
   * As the host, the fallback for an engine that never says the session's song ended: a song
   * hidden from the host, a player the browser held back, or one that stalled. It says the song
   * ended `FALLBACK_MS` after its end on the session's clock, as the server's time is estimated on
   * the device's monotonic clock (`ServerTime`), and the core still decides. A session paused past
   * the end, as when someone paused it before it moved on, says so at once.
   *
   * Nothing is planned until a heartbeat answered, each answer plans again, and a wait that runs
   * out only plans again, so it says so once the corrected time is past the end.
   */
  #planEnd(): void {
    this.#cancelEnd();

    const view = this.#view;
    const lengthMs = view?.lengthMs ?? null;

    // With no known length, the core has no end on its clock to agree with; someone skips it.
    if (view === null || !view.hosting || lengthMs === null || !(lengthMs > 0)) return;

    const { clock } = view;

    if (clock.status === "paused") {
      if (clock.positionAtAnchorMs >= lengthMs) void this.#sayEnded(view);

      return;
    }

    const serverNow = this.#serverTime.now();

    if (serverNow === null) return;

    const endServerTime =
      clock.anchorServerTime + (lengthMs - clock.positionAtAnchorMs) / clock.playbackRate;

    const wait = endServerTime - serverNow + FALLBACK_MS;

    if (wait <= 0) {
      void this.#sayEnded(view);

      return;
    }

    this.#end = {
      kind: "end",
      cancel: this.#timers.after(wait, () => {
        this.#end = null;
        this.#planEnd();
      }),
    };
  }

  #cancelEnd(): void {
    this.#end?.cancel();
    this.#end = null;
  }

  /**
   * Tells the core, as the host, that the playing entry of `decided` finished, against the clock it
   * played under; the core moves the session on once its own clock agrees, deciding on its queue
   * as it is then (`core.together.ended`). Said once per clock: a newer clock says it again. One
   * the core refused, or that did not reach it, is tried again after `RETRY_MS` against the newest
   * view, if that has ended by then.
   */
  async #sayEnded(decided: SessionFollow<T>): Promise<void> {
    const view = this.#view;

    const unchanged =
      view !== null &&
      view.hosting &&
      view.sessionId === decided.sessionId &&
      view.playing.key === decided.playing.key &&
      view.clock.revision === decided.clock.revision;

    if (!unchanged || this.#movingOn === view.clock.revision) return;

    const { revision } = view.clock;

    this.#movingOn = revision;

    try {
      await this.#commands.ended({ entryId: view.entryId, revision }, view.sessionId);
    } catch {
      if (this.#movingOn !== revision) return;

      this.#movingOn = null;
      this.#cancelEnd();
      this.#end = {
        kind: "retry",
        cancel: this.#timers.after(RETRY_MS, () => {
          this.#end = null;
          this.#planEnd();
        }),
      };
    }
  }

  #publish(state: SessionPlaybackState): void {
    if (state === this.#snapshot) return;

    this.#snapshot = state;

    for (const listener of this.#listeners) listener();
  }
}

/**
 * The session as the controller plays it: its playing entry first, then what is queued, up to the
 * first entry whose song it does not have yet, so the engine never preloads a song that does not
 * play next. A hidden entry ends it the same way, and it is whole only once the queue is listed.
 */
const queueOf = <T extends Track>(view: SessionFollow<T>): QueueState => {
  const songs = [view.playing, ...view.queued];
  const known = songs.findIndex((song) => song.track === null);

  const entries: Array<QueueEntry> = (known === -1 ? songs : songs.slice(0, known)).flatMap(
    (song) =>
      song.track === null ? [] : [{ itemId: song.key, autoplay: false, track: song.track }],
  );

  return {
    entries,
    complete: known === -1 && view.listing !== "loading",
    current: view.playing.key,
    shuffle: false,
    repeat: "off",
    autoplay: false,
  };
};

/** What the listener's own playback holds when they start a group session from it. */
export interface StartFrom {
  readonly trackId: string;
  /** Where the song stands now, read as late as possible. */
  readonly positionNow: () => number;
  readonly playing: boolean;
  /** The songs their queue plays after it, in order. */
  readonly upcoming: ReadonlyArray<string>;
}

/** The core's calls that start a music session. */
export interface StartCommands {
  /** `core.together.create` on the song; answers the new session and its join link. */
  readonly create: (
    trackId: string,
  ) => Promise<{ readonly sessionId: string; readonly link: string }>;
  readonly control: SessionControl;
  /**
   * `core.together.addItems` of `trackIds` at the end of the session `sessionId`, which the core
   * refuses once the person is no longer in it: answers how many of them it took, from the first.
   */
  readonly addItems: (sessionId: string, trackIds: ReadonlyArray<string>) => Promise<number>;
}

/** A started session: its join link, and the queue filling behind it. */
export interface Started {
  readonly link: string;
  /**
   * Settles once the songs queued after the first are in the session's queue, with how many it
   * took; rejects at the first refusal, as once the session ended or the person left it, and
   * sends nothing more.
   */
  readonly queued: Promise<number>;
}

/** The most songs a session queues; the core refuses more. */
const SESSION_QUEUE_MAX = 500;

/**
 * Starts a music session on the song the listener plays, where it stands, playing if it played,
 * as old music's jams shared the host's player and queue (ADR 0017). Resolves once the session
 * stands there; the songs queued after it then join its queue in order, as many a call as the core
 * takes, up to the session's limit. Every call names the session `create` made, so once it ended
 * or the person left it, the core refuses the next one, and the fill stops for good rather than
 * land in a session that replaced it.
 */
export const startSession = async (from: StartFrom, commands: StartCommands): Promise<Started> => {
  const { sessionId, link } = await commands.create(from.trackId);

  // A new session's clock starts paused at 0, at revision 0. It plays first and seeks after, so
  // the seek, sent with the song's position read just before, anchors where the song is.
  const played = from.playing ? await commands.control({ kind: "play" }, sessionId) : null;
  const positionMs = Math.max(0, Math.round(from.positionNow()));

  if (positionMs > 0) {
    await commands.control(
      { kind: "seek", positionMs, revision: played?.revision ?? 0 },
      sessionId,
    );
  }

  const fill = async (rest: ReadonlyArray<string>, done: number): Promise<number> => {
    if (rest.length === 0) return done;

    const taken = await commands.addItems(sessionId, rest);

    return taken === 0 ? done : fill(rest.slice(taken), done + taken);
  };

  return { link, queued: fill(from.upcoming.slice(0, SESSION_QUEUE_MAX), 0) };
};
