import type { PlaybackController, PlayingHere, StartAt } from "./playback-controller";

/**
 * Report at least this often while the page is open: Connect counts a device that has not reported
 * for 30 seconds as offline (ADR 0018), and old music's player reported every 15 seconds while it
 * played. Every change reports at once besides.
 */
export const HEARTBEAT_MS = 10_000;

/** Clock samples kept; the one with the shortest round trip estimates the server's clock. */
const CLOCK_SAMPLES = 8;

/** An item as Connect names it: a music song or album, or another domain's item. */
export interface ConnectItem {
  readonly domain: string;
  readonly ref: { readonly type: string; readonly id: string };
}

/** Play or pause at a position in server time: `positionMs` held at `at`. */
interface Anchored {
  readonly playing: boolean;
  readonly positionMs: number;
  readonly at: number;
}

/**
 * What a controller asks of this device (ADR 0018): play or pause `item` while it plays here, play
 * an item from a position, or play nothing.
 */
export type ConnectAsk =
  | ({ readonly kind: "transport"; readonly item: ConnectItem } & Anchored)
  | ({
      readonly kind: "load";
      readonly item: ConnectItem;
      readonly loadRevision: number;
    } & Anchored)
  | { readonly kind: "stop"; readonly at: number };

/** A request `core.connect.player.requested` shows: the newest one this device has not applied. */
export interface ConnectRequest {
  readonly revision: number;
  readonly ask: ConnectAsk;
}

/** What this device reports it plays: a song, whether it plays, and where. */
export interface ReportedSong {
  readonly trackId: string;
  readonly playing: boolean;
  readonly positionMs: number;
}

/** The core calls the device side of Connect sends. Each rejects with the SDK's tagged errors. */
export interface ConnectCommands {
  /** `core.connect.player.report`: answers the server time the report landed at. */
  readonly report: (song: ReportedSong | null, applied: number) => Promise<number>;
  /** An album's songs in order, every page of `music.albums.tracks`. */
  readonly albumTracks: (albumId: string) => Promise<ReadonlyArray<string>>;
}

/** Time as the device side of Connect sees it. */
export interface ConnectClock {
  /** Milliseconds since the Unix epoch on this device. */
  readonly now: () => number;
  /** Calls `callback` every `ms`. Returns the function that stops it. */
  readonly every: (ms: number, callback: () => void) => () => void;
}

/** The interval timer and `Date.now`. */
export const systemConnectClock: ConnectClock = {
  now: Date.now,
  every: (ms, callback) => {
    const timer = setInterval(callback, ms);

    return () => {
      clearInterval(timer);
    };
  },
};

/** Where `anchored` stands at server time `now`: on from `at` while it plays, held while paused. */
export const positionAt = (anchored: Anchored, now: number): number =>
  anchored.playing ? anchored.positionMs + Math.max(0, now - anchored.at) : anchored.positionMs;

interface ClockSample {
  readonly roundTripMs: number;
  readonly offsetMs: number;
}

/**
 * The server's clock as seen from this device, from the server times reports answer: each report's
 * offset assumes it landed halfway through its round trip, and the shortest recent round trip
 * wins, since it bounds the error tightest.
 */
export class ServerClock {
  readonly #now: () => number;
  #samples: ReadonlyArray<ClockSample> = [];

  constructor(now: () => number) {
    this.#now = now;
  }

  /** Records a call sent at `sentAt` and answered at `answeredAt` with server time `serverAt`. */
  sample(sentAt: number, answeredAt: number, serverAt: number): void {
    const roundTripMs = Math.max(0, answeredAt - sentAt);
    const sample = { roundTripMs, offsetMs: serverAt - (sentAt + roundTripMs / 2) };

    this.#samples = [...this.#samples, sample].slice(-CLOCK_SAMPLES);
  }

  /** The server's time now; this device's own until a report answers. */
  now(): number {
    const best = this.#samples.reduce<ClockSample | null>(
      (held, sample) => (held === null || sample.roundTripMs < held.roundTripMs ? sample : held),
      null,
    );

    return this.#now() + (best?.offsetMs ?? 0);
  }
}

/** A request to play an item from a position. */
type LoadAsk = Extract<ConnectAsk, { readonly kind: "load" }>;

type Load =
  | {
      readonly phase: "starting";
      readonly loadRevision: number;
      /** This start of the load, so a step of an earlier start of it never acts for this one. */
      readonly run: number;
      /**
       * What its start waits on: the queue, to tell whether its song is the entry the queue plays,
       * or the network, for an album's songs or the new queue.
       */
      readonly waits: "queue" | "network";
      /** The newest ask for it, which it starts with. */
      readonly ask: LoadAsk;
      /** The revision of its newest ask, which settles once its start ends, played or not. */
      readonly revision: number;
    }
  | {
      readonly phase: "started";
      readonly loadRevision: number;
      /** The queue entry it started; a newer ask for it applies only while that entry plays here. */
      readonly itemId: string;
    };

type StartingLoad = Extract<Load, { readonly phase: "starting" }>;

type StepOutcome<A> = { readonly answered: true; readonly value: A } | { readonly answered: false };

/** Where a load stands as a `load` request for it arrives: ADR 0018's decision table. */
type Standing =
  /** Newer than every load this device handled. */
  | { readonly kind: "new" }
  | { readonly kind: "starting"; readonly load: StartingLoad }
  /** It started, and the queue entry it started still plays here. */
  | { readonly kind: "playing" }
  /**
   * A newer request or the listener replaced it, its start failed or played nothing, or what plays
   * here moved on from it.
   */
  | { readonly kind: "gone" };

const reportKey = (here: PlayingHere | null, status: string, seeks: number, applied: number) =>
  here === null
    ? `none|${applied}`
    : `${here.itemId}|${here.trackId}|${here.playing}|${status}|${seeks}|${applied}`;

/**
 * This device as a Connect player (ADR 0018): it reports what the controller plays, on every change
 * and every {@link HEARTBEAT_MS}, and applies the requests other devices make of it through the
 * controller's own rules.
 *
 * Every `load` request, and every step of a load's start, is checked against the load current
 * here when it would apply, not when it began. A `transport` applies only while the song it names
 * plays here. A `load` this device already started only plays, pauses, or seeks the queue entry it
 * started, while that entry plays here. A `stop` lets go of the song, as when playback moves to
 * another device. Whatever happens to a request, this device then reports it applied, so the core
 * settles it.
 */
export class ConnectPlayer {
  readonly #controller: PlaybackController;
  readonly #commands: ConnectCommands;
  readonly #clock: ConnectClock;
  readonly #server: ServerClock;
  /** The newest revision this device handled: applied, or found moot. */
  #applied = 0;
  /** The newest revision the core showed, while started or not, which a tap here makes moot. */
  #seen = 0;
  /** The request the core shows now, which this device takes once it starts. */
  #shown: ConnectRequest | null = null;
  /** The newest `loadRevision` among the load asks the core showed, while started or not. */
  #seenLoad = 0;
  /**
   * The newest `loadRevision` this device started, or found moot; a load ask at or below it starts
   * nothing. A load `stop` dropped while it started was not handled, so it starts again.
   */
  #handledLoad = 0;
  /** The newest load, while it is the one Connect asked for here. */
  #load: Load | null = null;
  #runs = 0;
  #reported: string | null = null;
  #stop: (() => void) | null = null;

  constructor(controller: PlaybackController, commands: ConnectCommands, clock: ConnectClock) {
    this.#controller = controller;
    this.#commands = commands;
    this.#clock = clock;
    this.#server = new ServerClock(clock.now);
  }

  /** The server's time now, as the latest reports' answers show it. */
  serverNow(): number {
    return this.#server.now();
  }

  /** Whether this device reports and applies requests now, between `start` and its stop. */
  get started(): boolean {
    return this.#stop !== null;
  }

  /**
   * Reports now, then on each change and heartbeat, and takes the request the core shows now.
   * Returns the function that stops it, which drops a load still starting without settling it, so
   * it starts again once this device starts again.
   */
  start(): () => void {
    this.#stop?.();
    const unsubscribe = this.#controller.subscribe(this.#changed);

    const stopBeats = this.#clock.every(HEARTBEAT_MS, () => {
      this.#report();
    });

    const stop = (): void => {
      unsubscribe();
      stopBeats();
      const load = this.#load;

      if (load?.phase === "starting") {
        this.#load = null;
        this.#handledLoad = load.loadRevision - 1;
      }

      if (this.#stop === stop) this.#stop = null;
    };

    this.#stop = stop;
    this.#report();
    // A request the core showed before this device started, as another tab of it led, applies now.
    this.take(this.#shown);

    return stop;
  }

  /**
   * Takes the request the core shows now, or null when none waits. While this device is not
   * started, it only notes the revision, which a tap here makes moot ({@link supersede}).
   */
  take(request: ConnectRequest | null): void {
    this.#shown = request;

    if (request === null) return;

    this.#seen = Math.max(this.#seen, request.revision);

    if (request.ask.kind === "load") {
      this.#seenLoad = Math.max(this.#seenLoad, request.ask.loadRevision);
    }

    const load = this.#load;
    const starting = load?.phase === "starting" ? load.revision : 0;

    if (!this.started || request.revision <= Math.max(this.#applied, starting)) return;
    const { revision, ask } = request;

    switch (ask.kind) {
      case "stop": {
        this.#load = null;
        this.#controller.release();
        this.#settle(revision);
        break;
      }

      case "transport": {
        // A newer request replaces a load still starting.
        if (this.#load?.phase === "starting") this.#load = null;

        if (this.#plays(ask.item)) {
          this.#controller.steer(ask.playing, positionAt(ask, this.serverNow()));
        }

        this.#settle(revision);
        break;
      }

      case "load": {
        this.#takeLoad(revision, ask);
        break;
      }
    }
  }

  /**
   * The listener changed what plays here, or whether it plays, so every request seen so far is moot
   * (ADR 0018): a load still starting is dropped, and this device reports them applied.
   */
  supersede(): void {
    if (this.#load?.phase === "starting") this.#load = null;
    this.#handledLoad = Math.max(this.#handledLoad, this.#seenLoad);
    this.#settle(this.#seen);
  }

  /** Where the load `loadRevision` stands now, right before a `load` request for it applies. */
  #standing(loadRevision: number): Standing {
    if (loadRevision > this.#handledLoad) return { kind: "new" };
    const load = this.#load;

    if (load?.loadRevision !== loadRevision) return { kind: "gone" };

    if (load.phase === "starting") return { kind: "starting", load };

    return this.#controller.playingHere()?.itemId === load.itemId
      ? { kind: "playing" }
      : { kind: "gone" };
  }

  /** `load` as it stands now, as a step of this start of it applies; null once dropped. */
  #starting(load: StartingLoad): StartingLoad | null {
    const current = this.#load;

    return current?.phase === "starting" && current.run === load.run ? current : null;
  }

  #takeLoad(revision: number, ask: LoadAsk): void {
    const standing = this.#standing(ask.loadRevision);

    switch (standing.kind) {
      case "new": {
        this.#handledLoad = ask.loadRevision;
        this.#runs += 1;

        const load: StartingLoad = {
          phase: "starting",
          loadRevision: ask.loadRevision,
          run: this.#runs,
          waits: "network",
          ask,
          revision,
        };

        this.#load = load;
        this.#start(load);
        break;
      }

      case "starting": {
        // A play, pause, or seek of the load starting here: it starts with this ask instead.
        this.#load = { ...standing.load, ask, revision };
        break;
      }

      case "playing": {
        this.#controller.steer(ask.playing, positionAt(ask, this.serverNow()));
        this.#settle(revision);
        break;
      }

      case "gone": {
        this.#settle(revision);
        break;
      }
    }
  }

  #start(load: StartingLoad): void {
    const { item } = load.ask;

    if (isSong(item)) {
      this.#startSong(load);

      return;
    }

    if (item.domain === "music" && item.ref.type === "album") {
      void this.#startAlbum(load, item.ref.id);

      return;
    }

    this.#load = null;
    this.#settle(load.revision);
  }

  /**
   * Starts a load of a song. The queue plays that song now when a move lands here, so this device
   * plays that entry from the position and keeps the queue; any other song replaces the queue.
   * Until the queue this device holds says which entry it plays, the load waits for it, so a move
   * never replaces the queue (`#changed` tries again).
   */
  #startSong(load: StartingLoad): void {
    const trackId = load.ask.item.ref.id;
    const current = this.#controller.queueCurrent();

    if (current.kind === "unknown") {
      this.#load = { ...load, waits: "queue" };

      return;
    }

    if (current.kind === "entry" && current.trackId === trackId) {
      this.#load = { phase: "started", loadRevision: load.loadRevision, itemId: current.itemId };
      this.#controller.playCurrentAt(
        trackId,
        positionAt(load.ask, this.serverNow()),
        load.ask.playing,
      );
      this.#settle(load.revision);

      return;
    }

    void this.#write(load, [trackId]);
  }

  async #startAlbum(load: StartingLoad, albumId: string): Promise<void> {
    const fetched = await this.#step(load, this.#commands.albumTracks(albumId));

    if (fetched === null) return;

    if (!fetched.outcome.answered) {
      this.#load = null;
      this.#settle(fetched.load.revision);

      return;
    }

    await this.#write(fetched.load, fetched.outcome.value);
  }

  async #write(load: StartingLoad, trackIds: ReadonlyArray<string>): Promise<void> {
    this.#load = { ...load, waits: "network" };

    const startAt = (): StartAt | null => {
      const now = this.#starting(load);

      return now === null
        ? null
        : { positionMs: positionAt(now.ask, this.serverNow()), playing: now.ask.playing };
    };

    const written = await this.#step(load, this.#controller.playTracksAt(trackIds, startAt));

    if (written === null) return;
    const itemId = written.outcome.answered ? written.outcome.value : null;

    this.#load =
      itemId === null ? null : { phase: "started", loadRevision: load.loadRevision, itemId };
    this.#settle(written.load.revision);
  }

  /**
   * Awaits one step of `load`'s start and answers its outcome, a failure included, with the load's
   * newest ask, or null once this start was dropped: a newer request or the listener's tap that
   * dropped it settles it, and a start `stop` dropped waits for the next `start`.
   */
  async #step<A>(
    load: StartingLoad,
    step: Promise<A>,
  ): Promise<{ readonly load: StartingLoad; readonly outcome: StepOutcome<A> } | null> {
    const outcome = await step.then(
      (value): StepOutcome<A> => ({ answered: true, value }),
      (): StepOutcome<A> => ({ answered: false }),
    );

    const now = this.#starting(load);

    return now === null ? null : { load: now, outcome };
  }

  #settle(revision: number): void {
    if (revision <= this.#applied) return;

    this.#applied = revision;
    this.#report();
  }

  /** Whether `item` is the song loaded here. */
  #plays(item: ConnectItem): boolean {
    const here = this.#controller.playingHere();

    return here !== null && isSong(item) && item.ref.id === here.trackId;
  }

  #changed = (): void => {
    const load = this.#load;

    if (load?.phase === "starting" && load.waits === "queue") this.#startSong(load);
    const here = this.#controller.playingHere();
    const { engineStatus, seeks } = this.#controller.getSnapshot();

    if (reportKey(here, engineStatus, seeks, this.#applied) !== this.#reported) this.#report();
  };

  #report(): void {
    if (!this.started) return;

    const here = this.#controller.playingHere();
    const { engineStatus, seeks } = this.#controller.getSnapshot();
    const applied = this.#applied;
    const sentAt = this.#clock.now();

    this.#reported = reportKey(here, engineStatus, seeks, applied);

    const song =
      here === null
        ? null
        : { trackId: here.trackId, playing: here.playing, positionMs: here.positionMs };

    void this.#send(song, applied, sentAt);
  }

  async #send(song: ReportedSong | null, applied: number, sentAt: number): Promise<void> {
    try {
      const serverAt = await this.#commands.report(song, applied);

      this.#server.sample(sentAt, this.#clock.now(), serverAt);
    } catch {
      // The next change or heartbeat reports again; a device that cannot report is offline to
      // controllers until one lands.
      this.#reported = null;
    }
  }
}

const isSong = (item: ConnectItem): boolean => item.domain === "music" && item.ref.type === "track";
