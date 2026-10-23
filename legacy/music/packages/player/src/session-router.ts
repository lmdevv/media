/**
 * Where the player's commands go. The playback session normally lives on the server; a device
 * that loses the server mid-song carries on with a session of its own (`local-session.ts`) and
 * hands it back when the server answers again. The controller and the player's actions send every
 * command through a `SessionPort` and never learn which one runs.
 */
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

/**
 * Offline plays sent per `devices.reconcile`. Well under the server's check of a user's latest
 * 500 plays, so a batch sent again after its answer was lost is still recognised, even with plays
 * from other devices in between.
 */
const PLAYS_PER_RECONCILE = 200;

/** The first wait before a failed hand-back is tried again; it doubles up to the longest. */
const RETRY_FIRST_MS = 1000;

const RETRY_LONGEST_MS = 30_000;

/** Stands in for a callback until the real one is set. */
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
  /** In the order they were sent, which is the order the session takes them in. */
  readonly #outstanding = new Set<Outstanding>();

  /** This device's own session; null while the session runs on the server. */
  #local: LocalSessionState | null = null;
  #server: PlaybackState | null = null;
  /** Counts server snapshots, so a hand-back can tell one arrived after it was sent. */
  #offers = 0;
  /** Counts changes to the local session other than a hand-back's, so one can tell it moved. */
  #revision = 0;
  #reconciling = false;
  /**
   * `start`'s stop ran. The client may outlive this device's account (signing out keeps the
   * connection), so nothing more is sent or stored for it: no hand-back, retry, or store write.
   */
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

    // Even with the socket up: a server that answers takes the session straight back.
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

  /**
   * Sends a session command to the server. If the session moves here before the server answers,
   * the command runs here, in the order it was sent, and the server's late answer is ignored: the
   * server still runs it, and the hand-back that follows it replaces what it did.
   */
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

        // The server still gets a report it was sent, and counts its play there.
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
    // Handles a rejection too, so one the caller no longer waits for is never left unhandled.
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

    // `here` comes first: when the session moved here as the server answered, the command ran
    // here, and that is the answer.
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

    // The same failure the server sends, so the player shows it like any refused command.
    if (Result.isFailure(stepped)) {
      const { code, message } = refusalFailure(stepped.failure);

      throw new ConvexError({ code, message });
    }

    this.#change(stepped.success.state);

    return stepped.success.result;
  }

  /**
   * Moves the session onto this device, from the session the player shows, with every command
   * still out with the server run here first, in the order sent; each caller is answered from
   * here, a refusal included. On a dropped connection (`needed` null) only while this device plays
   * the session; for a command past its deadline also while nothing plays it or when the command
   * plays songs here outside a Jam (another device may still be named), and only when that
   * command runs here, or it keeps waiting for the server. Returns whether the session moved.
   */
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

  /**
   * Takes up the session this device stored and did not hand back, once, paused: nothing plays
   * at launch. When a session already moved here since launch, it keeps that one and adds the
   * stored plays before its own, so none is lost.
   */
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
      // An unreadable store holds nothing to resume.
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

  /**
   * Hands this device's own session back, one hand-back at a time and only while connected. A
   * session stored at an earlier launch goes back with it. A failure is tried again later.
   */
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

  /**
   * Sends the plays a batch at a time, dropping each once the server has it, and the session with
   * the last batch. Again while the session changed meanwhile; otherwise the session runs on the
   * server from the answer on, with no await between the check and the switch.
   */
  async #handBack(): Promise<void> {
    const local = this.#local;

    if (local === null || this.#stopped) return;
    const revision = this.#revision;
    const offers = this.#offers;
    const plays = local.plays.slice(0, PLAYS_PER_RECONCILE);
    const last = plays.length === local.plays.length;

    const { adopted } = await this.#client.run("devices.reconcile", {
      deviceId: this.#device.id,
      plays,
      resume: last ? offlineResume(local, this.#clock.now()) : null,
    });

    this.#dropHandedBack(plays);

    if (last && revision === this.#revision) {
      this.#finishHandBack(adopted, local, offers);

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

  /**
   * The session runs on the server again. When the server kept its own, that shows now. When it
   * took this device's back, its snapshot shows once one arrived after the hand-back with this
   * device playing the same song; until then the player keeps showing the session it plays, so
   * the engine sees no change.
   */
  #finishHandBack(adopted: boolean, handed: LocalSessionState, offersAtSend: number): void {
    const server = this.#server;

    const shows =
      server !== null &&
      (!adopted ||
        (this.#offers > offersAtSend &&
          server.activeDevice?.id === this.#device.id &&
          server.queue[server.index]?.id === handed.items[handed.index]?.track.id));

    this.#local = null;
    this.#clearStored();
    this.#publish(shows ? server : this.#snapshot.state);
  }

  /**
   * Clears the stored session once the server took it back. A clear that fails is tried again:
   * a stored session left behind would be handed back again at the next launch. A session that
   * moved here meanwhile writes over the row itself.
   */
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

  /** A store write that failed leaves the last good row; the next change writes again. */
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

/**
 * Whether a command plays songs on `device`, which may take the session over from another device
 * that last played it. Moving playback here doesn't: the session would come over paused, at the
 * other device's last report, while that device may still be playing.
 */
const playsOn = <Name extends SessionMutation>(
  name: Name,
  args: CommandArgs<Name>,
  device: DeviceId,
): boolean => name === "playback.play" && "deviceId" in args && args.deviceId === device;

const isPlayReport = (name: SessionMutation): name is "playback.report" =>
  name === "playback.report";
