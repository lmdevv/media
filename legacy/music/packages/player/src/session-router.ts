import type { DeviceId, TrackId } from "@music/commands/ids";
import type { OfflinePlay, PlaybackState } from "@music/commands/models";
import type { CommandArgs, CommandResult, MutationName } from "@music/commands/registry";
import { isSessionMutation } from "@music/commands/session-commands";
import type { SessionMutation } from "@music/commands/session-commands";
import type { MusicClient } from "@music/sdk/client";
import { ConvexError } from "convex/values";
import { Result } from "effect";

import {
  emptyLocal,
  localView,
  offlineResume,
  refusalFailure,
  seedLocal,
  stepLocal,
} from "./local-session";
import type {
  LocalContext,
  LocalDevice,
  LocalRefusal,
  LocalSessionState,
  PlayableTrack,
} from "./local-session";

/** Whether session commands go to the server, or to this device's own session while offline. */
export type SessionMode = "server" | "local";

/** What the controller and the player's actions send commands through. */
export interface SessionPort {
  /** Where session commands go right now. */
  readonly mode: () => SessionMode;
  /**
   * Runs a mutation. Session commands (`playback.*` and `queue.*`) go where `mode` says; every
   * other command goes to the server. Rejects the way `MusicClient.run` does, with an expected
   * failure the player shows.
   */
  readonly run: MusicClient["run"];
}

/** A session that always runs on the server: the web's, and any device without downloads. */
export const serverSession = (client: Pick<MusicClient, "run">): SessionPort => ({
  mode: () => "server",
  run: client.run,
});

/**
 * How long a session command may go unanswered before this device carries on with its own
 * session. A connection that died without the socket noticing shows up this way.
 */
export const ACK_DEADLINE_MS = 4000;

const PLAYS_PER_RECONCILE = 200;

const RETRY_FIRST_MS = 1000;

const RETRY_LONGEST_MS = 30_000;

const doNothing = (): void => {};

/** Whether the server's connection is up, from the host's Convex client. */
export interface ConnectionSignal {
  readonly connected: () => boolean;
  /** Calls `listener` when the connection goes up or down. Returns the unsubscribe function. */
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * Where a device keeps its own session and the server's last snapshot across launches (the
 * downloads database on a phone). Writes may fail: the router carries on from memory and writes
 * again at its next change.
 */
export interface SessionStore {
  readonly load: () => Promise<StoredSessions>;
  /** Saves this device's own session, or clears it (null) once the server took it back. */
  readonly saveLocal: (state: LocalSessionState | null) => Promise<void>;
  /** Saves the server's latest snapshot, for a launch without a connection. May coalesce writes. */
  readonly saveServer: (state: PlaybackState) => Promise<void>;
}

/** What a `SessionStore` holds, each parsed when read back. */
export interface StoredSessions {
  /** This device's own session, when it played one and has not handed it back yet. */
  readonly local: LocalSessionState | null;
  readonly server: PlaybackState | null;
}

/** Time as the router sees it: the device clock and one-shot timers. */
export interface RouterClock {
  readonly now: () => number;
  /** Calls `callback` once after `ms`. Returns the function that cancels it. */
  readonly after: (ms: number, callback: () => void) => () => void;
}

/** The wall clock and `setTimeout`. */
export const systemClock: RouterClock = {
  now: Date.now,
  after: (ms, callback) => {
    const timer = setTimeout(callback, ms);

    return () => {
      clearTimeout(timer);
    };
  },
};

/** What the router shows the player. Replaced, never mutated. */
export interface RouterSnapshot {
  readonly mode: SessionMode;
  /** The session the engine follows; undefined until the server or the store answers. */
  readonly state: PlaybackState | undefined;
  /** This device's own session is being handed back; the player keeps showing it meanwhile. */
  readonly reconciling: boolean;
}

/** What a `SessionRouter` is built from. */
export interface SessionRouterDeps {
  readonly client: MusicClient;
  readonly connection: ConnectionSignal;
  readonly store: SessionStore;
  /** This device: where its own session plays. */
  readonly device: LocalDevice;
  /** A song this device can play without the server (it holds a copy), or null. */
  readonly playable: (trackId: TrackId) => PlayableTrack | null;
  readonly clock: RouterClock;
  /** Uniform in `[0, 1)`, for shuffling. */
  readonly random: () => number;
  /** Overrides `ACK_DEADLINE_MS`. */
  readonly ackDeadlineMs?: number;
  /**
   * Whether this device's user is in a Jam. The session may then be the host's, which a command
   * started here never takes over. Defaults to no Jam.
   */
  readonly inJam?: () => boolean;
}

/** A session command sent to the server and not answered yet. */
interface Outstanding {
  /**
   * Runs the command on this device's session instead: the session after it, and the function
   * that answers the caller from here, with the command's result or its refusal.
   */
  readonly runHere: (
    state: LocalSessionState,
    context: LocalContext,
  ) => { readonly state: LocalSessionState; readonly ran: boolean; readonly answer: () => void };
  /** The command plays songs on this device, so the session may be this device's to take. */
  readonly playsHere: boolean;
}

/**
 * Routes session commands to the server while it answers, and to this device's own session while
 * it doesn't. The session moves onto the device when the connection drops while the device plays
 * it, or when a command goes unanswered past the deadline and this device plays it, nothing does,
 * or the command plays songs here outside a Jam; never while it listens along to someone's Jam.
 * When the connection is back it hands the session back with `devices.reconcile`: the plays for
 * history, then the queue, which the server adopts while it still names this device active or the
 * device still plays.
 */
export class SessionRouter implements SessionPort {
  readonly #client: MusicClient;
  readonly #connection: ConnectionSignal;
  readonly #store: SessionStore;
  readonly #device: LocalDevice;
  readonly #playable: (trackId: TrackId) => PlayableTrack | null;
  readonly #clock: RouterClock;
  readonly #random: () => number;
  readonly #ackDeadlineMs: number;
  readonly #inJam: () => boolean;
  readonly #listeners = new Set<() => void>();
  readonly #outstanding = new Set<Outstanding>();

  #local: LocalSessionState | null = null;
  #server: PlaybackState | null = null;
  #offers = 0;
  #revision = 0;
  #reconciling = false;
  #stopped = false;
  #retryMs = RETRY_FIRST_MS;
  #cancelRetry: (() => void) | null = null;
  #stored: Promise<StoredSessions | null> | null = null;
  #storedTaken = false;
  #snapshot: RouterSnapshot = { mode: "server", state: undefined, reconciling: false };

  constructor(deps: SessionRouterDeps) {
    this.#client = deps.client;
    this.#connection = deps.connection;
    this.#store = deps.store;
    this.#device = deps.device;
    this.#playable = deps.playable;
    this.#clock = deps.clock;
    this.#random = deps.random;
    this.#ackDeadlineMs = deps.ackDeadlineMs ?? ACK_DEADLINE_MS;
    this.#inJam = deps.inJam ?? (() => false);
  }

  /** Where session commands go right now. */
  mode = (): SessionMode => (this.#local === null ? "server" : "local");

  /** The current snapshot. Stable between changes, for `useSyncExternalStore`. */
  getSnapshot = (): RouterSnapshot => this.#snapshot;

  /** Calls `listener` after every snapshot change. Returns the unsubscribe function. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };

  /**
   * Follows the connection, and picks up a session this device played offline and has not
   * handed back yet (the app closed meanwhile). Returns the function that stops it.
   */
  start(): () => void {
    const unsubscribe = this.#connection.subscribe(this.#onConnection);

    void this.#resumeStored();

    return () => {
      this.#stopped = true;
      unsubscribe();
      this.#cancelRetry?.();
      this.#cancelRetry = null;
    };
  }

  /**
   * A snapshot of the server's session. Shown while the session runs on the server; while this
   * device plays its own, it is out of date by definition and only kept.
   */
  offerServer(state: PlaybackState): void {
    this.#server = state;
    this.#offers += 1;

    if (this.#local !== null) return;
    this.#save(this.#store.saveServer(state));
    this.#publish(state);
  }

  /**
   * Starts this device's own session at a launch without the server: the one it played before,
   * else the server's session as it last saw it, else an empty one. Paused, since nothing plays
   * at launch.
   */
  async startLocal(): Promise<void> {
    if (this.mode() === "local") return;
    const stored = await this.#loadStored();

    this.#takeStored(stored);

    if (this.mode() === "local") return;
    const now = this.#clock.now();
    const server = this.#server ?? stored?.server ?? null;
    const session = server === null ? emptyLocal(now) : seedLocal(server, this.#device.id);

    this.#enterLocal({ ...session, playing: false, updatedAt: now });
  }

  /** Runs a mutation; see {@link SessionPort.run}. */
  run = <Name extends MutationName>(
    name: Name,
    args: CommandArgs<Name>,
  ): Promise<CommandResult<Name>> => {
    if (!isSessionMutation(name)) return this.#client.run(name, args);

    return this.#local === null ? this.#runOnServer(name, args) : this.#runHere(name, args);
  };

  async #runOnServer<Name extends SessionMutation>(
    name: Name,
    args: CommandArgs<Name>,
  ): Promise<CommandResult<Name>> {
    let answerHere: (outcome: Result.Result<CommandResult<Name>, LocalRefusal>) => void = doNothing;

    const here = new Promise<Result.Result<CommandResult<Name>, LocalRefusal>>((resolve) => {
      answerHere = resolve;
    });

    const command: Outstanding = {
      playsHere: playsOn(name, args, this.#device.id),
      runHere: (state, context) => {
        const stepped = stepLocal(name, state, args, context);

        if (Result.isFailure(stepped)) {
          return { state, ran: false, answer: () => answerHere(Result.fail(stepped.failure)) };
        }

        const { result } = stepped.success;

        const after = isPlayReport(name)
          ? { ...stepped.success.state, plays: state.plays }
          : stepped.success.state;

        return { state: after, ran: true, answer: () => answerHere(Result.succeed(result)) };
      },
    };

    this.#outstanding.add(command);

    try {
      return await this.#answer(command, this.#client.run(name, args), here);
    } finally {
      this.#outstanding.delete(command);
    }
  }

  async #answer<A>(
    command: Outstanding,
    sent: Promise<A>,
    here: Promise<Result.Result<A, LocalRefusal>>,
  ): Promise<A> {
    const answered = sent.then(
      () => "answered" as const,
      () => "answered" as const,
    );

    let cancel = doNothing;

    const late = new Promise<"late">((resolve) => {
      cancel = this.#clock.after(this.#ackDeadlineMs, () => {
        resolve("late");
      });
    });

    const first = await Promise.race([here, answered, late]);

    if (first === "late") this.#takeOver(command);
    const outcome = first === "late" ? await Promise.race([here, answered]) : first;

    cancel();

    if (outcome === "answered") return sent;

    if (Result.isSuccess(outcome)) return outcome.success;
    const { code, message } = refusalFailure(outcome.failure);

    throw new ConvexError({ code, message });
  }

  async #runHere<Name extends SessionMutation>(
    name: Name,
    args: CommandArgs<Name>,
  ): Promise<CommandResult<Name>> {
    const local = this.#local;

    if (local === null) return this.#client.run(name, args);
    const stepped = stepLocal(name, local, args, this.#context());

    if (Result.isFailure(stepped)) {
      const { code, message } = refusalFailure(stepped.failure);

      throw new ConvexError({ code, message });
    }

    this.#change(stepped.success.state);

    return stepped.success.result;
  }

  #takeOver(needed: Outstanding | null): boolean {
    const shown = this.#snapshot.state;

    if (this.#local !== null || shown === undefined || shown.following) return false;
    const active = shown.activeDevice?.id ?? null;

    const claimed = needed?.playsHere === true && !this.#inJam();

    if (active !== this.#device.id && !claimed && (needed === null || active !== null))
      return false;
    const context = this.#context();
    let state = seedLocal(shown, this.#device.id);
    const answers: Array<() => void> = [];
    let neededRan = needed === null;

    for (const command of this.#outstanding) {
      const outcome = command.runHere(state, context);

      state = outcome.state;
      answers.push(outcome.answer);

      if (command === needed) neededRan = outcome.ran;
    }

    if (!neededRan) return false;
    this.#enterLocal(state);

    for (const answer of answers) answer();

    return true;
  }

  #onConnection = (): void => {
    if (this.#connection.connected()) void this.#reconcile();
    else this.#takeOver(null);
  };

  async #resumeStored(): Promise<void> {
    this.#takeStored(await this.#loadStored());
  }

  #takeStored(stored: StoredSessions | null): void {
    const previous = stored?.local ?? null;

    if (previous === null || this.#storedTaken) return;
    this.#storedTaken = true;
    const local = this.#local;

    if (local === null) {
      this.#enterLocal({ ...previous, playing: false, updatedAt: this.#clock.now() });

      return;
    }

    this.#change({ ...local, plays: [...previous.plays, ...local.plays] });
  }

  #loadStored(): Promise<StoredSessions | null> {
    this.#stored ??= this.#readStore();

    return this.#stored;
  }

  async #readStore(): Promise<StoredSessions | null> {
    try {
      return await this.#store.load();
    } catch {
      return null;
    }
  }

  #enterLocal(state: LocalSessionState): void {
    this.#change(state);

    if (this.#connection.connected()) void this.#reconcile();
  }

  #change(state: LocalSessionState): void {
    this.#revision += 1;
    this.#setLocal(state);
  }

  #setLocal(state: LocalSessionState): void {
    this.#local = state;
    this.#save(this.#store.saveLocal(state));
    this.#publish(localView(state, this.#device));
  }

  async #reconcile(): Promise<void> {
    if (
      this.#stopped ||
      this.#reconciling ||
      this.#local === null ||
      !this.#connection.connected()
    ) {
      return;
    }

    this.#cancelRetry?.();
    this.#cancelRetry = null;
    this.#reconciling = true;
    this.#publish(this.#snapshot.state);

    try {
      this.#takeStored(await this.#loadStored());
      await this.#handBack();
      this.#retryMs = RETRY_FIRST_MS;
    } catch {
      this.#retryLater();
    } finally {
      this.#reconciling = false;
      this.#publish(this.#snapshot.state);
    }
  }

  async #handBack(): Promise<void> {
    const local = this.#local;

    if (local === null || this.#stopped) return;
    const revision = this.#revision;
    const offers = this.#offers;
    const plays = local.plays.slice(0, PLAYS_PER_RECONCILE);
    const last = plays.length === local.plays.length;

    const { adopted, controlRevision } = await this.#client.run("devices.reconcile", {
      deviceId: this.#device.id,
      plays,
      resume: last ? offlineResume(local, this.#clock.now()) : null,
    });

    this.#dropHandedBack(plays);

    if (last && revision === this.#revision) {
      this.#finishHandBack(adopted, local, offers, controlRevision);

      return;
    }

    await this.#handBack();
  }

  #dropHandedBack(plays: ReadonlyArray<OfflinePlay>): void {
    const local = this.#local;
    const sent = new Set(plays);

    if (local === null || sent.size === 0) return;
    this.#setLocal({ ...local, plays: local.plays.filter((play) => !sent.has(play)) });
  }

  #finishHandBack(
    adopted: boolean,
    handed: LocalSessionState,
    offersAtSend: number,
    controlRevision: number | undefined,
  ): void {
    const server = this.#server;

    const shows =
      server !== null &&
      (!adopted ||
        (controlRevision !== undefined
          ? (server.control?.revision ?? -1) >= controlRevision
          : this.#offers > offersAtSend &&
            server.activeDevice?.id === this.#device.id &&
            server.queue[server.index]?.id === handed.items[handed.index]?.track.id));

    this.#local = null;
    this.#clearStored();
    this.#publish(shows ? server : this.#snapshot.state);
  }

  #clearStored(): void {
    if (this.#stopped) return;

    void this.#store.saveLocal(null).catch(() => {
      this.#clock.after(RETRY_FIRST_MS, () => {
        if (this.#local === null) this.#clearStored();
      });
    });
  }

  #retryLater(): void {
    if (this.#stopped) return;
    const delay = this.#retryMs;

    this.#retryMs = Math.min(delay * 2, RETRY_LONGEST_MS);

    this.#cancelRetry = this.#clock.after(delay, () => {
      this.#cancelRetry = null;
      void this.#reconcile();
    });
  }

  #context(): LocalContext {
    return {
      now: this.#clock.now(),
      device: this.#device,
      playable: this.#playable,
      random: this.#random,
    };
  }

  #save(write: Promise<void>): void {
    void write.catch(() => {});
  }

  #publish(state: PlaybackState | undefined): void {
    const next: RouterSnapshot = { mode: this.mode(), state, reconciling: this.#reconciling };
    const current = this.#snapshot;

    if (
      next.mode === current.mode &&
      next.state === current.state &&
      next.reconciling === current.reconciling
    ) {
      return;
    }

    this.#snapshot = next;

    for (const listener of this.#listeners) listener();
  }
}

const playsOn = <Name extends SessionMutation>(
  name: Name,
  args: CommandArgs<Name>,
  device: DeviceId,
): boolean => name === "playback.play" && "deviceId" in args && args.deviceId === device;

const isPlayReport = (name: SessionMutation): name is "playback.report" =>
  name === "playback.report";
