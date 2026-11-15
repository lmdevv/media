import type { PlaybackController, PlayingHere } from "./playback-controller";

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

/**
 * A load whose start waits on the network: its songs, or the new queue. A controller that plays,
 * pauses, or seeks the device meanwhile asks for the same load again under a newer revision, which
 * the load then starts with.
 */
interface PendingLoad {
  readonly loadRevision: number;
  /** The newest ask for this load. */
  readonly ask: LoadAsk;
  /** The revision that asked it, which the load settles once it starts. */
  readonly revision: number;
}

const reportKey = (here: PlayingHere | null, status: string, seeks: number, applied: number) =>
  here === null
    ? `none|${applied}`
    : `${here.itemId}|${here.trackId}|${here.playing}|${status}|${seeks}|${applied}`;

/**
 * This device as a Connect player (ADR 0018): it reports what the controller plays, on every change
 * and every {@link HEARTBEAT_MS}, and applies the requests other devices make of it through the
 * controller's own rules.
 *
 * Every request is tagged with its revision, and an answer that arrives for it after a newer
 * request, or after the listener acted here, is dropped, as the controller drops a stale load.
 * A `transport` applies only while the song it names plays here. A `load` this device already
 * started only plays, pauses, or seeks what it plays. A `stop` lets go of the song, as when playback
 * moves to another device. Whatever happens to a request, this device then reports it applied, so
 * the core settles it.
 */
export class ConnectPlayer {
  readonly #controller: PlaybackController;
  readonly #commands: ConnectCommands;
  readonly #clock: ConnectClock;
  readonly #server: ServerClock;
  /** The newest revision this device handled: applied, or found moot. */
  #applied = 0;
  /** The newest revision `take` was given. */
  #seen = 0;
  /** The request being applied, while its answer may still be outstanding. */
  #handling: number | null = null;
  /** The revision of the newest load started here; a request that names it only steers. */
  #startedLoad = 0;
  /** The load starting here, while its songs or its queue are still on the way. */
  #pendingLoad: PendingLoad | null = null;
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

  /** Reports now, then on each change and heartbeat. Returns the function that stops it. */
  start(): () => void {
    this.#stop?.();
    const unsubscribe = this.#controller.subscribe(this.#changed);

    const stopBeats = this.#clock.every(HEARTBEAT_MS, () => {
      this.#report();
    });

    const stop = (): void => {
      unsubscribe();
      stopBeats();
      this.#handling = null;
      this.#pendingLoad = null;

      if (this.#stop === stop) this.#stop = null;
    };

    this.#stop = stop;
    this.#report();

    return stop;
  }

  /** Takes the request the core shows now, or null when none waits. */
  take(request: ConnectRequest | null): void {
    if (request === null || !this.started) return;

    this.#seen = Math.max(this.#seen, request.revision);

    if (request.revision <= this.#applied || request.revision === this.#handling) return;

    this.#handling = request.revision;
    const pending = this.#pendingLoad;
    const { ask } = request;

    // The load starting here, asked again with a newer play, pause, or position: it starts with it.
    if (pending !== null && ask.kind === "load" && ask.loadRevision === pending.loadRevision) {
      this.#pendingLoad = { ...pending, ask, revision: request.revision };

      return;
    }

    this.#pendingLoad = null;
    void this.#apply(request);
  }

  /**
   * The listener changed what plays here, or whether it plays, so every request seen so far is moot
   * (ADR 0018): one still being applied is dropped, and this device reports them applied.
   */
  supersede(): void {
    this.#handling = null;
    this.#pendingLoad = null;
    this.settle(this.#seen);
  }

  /** Counts `revision` handled, as a move made here whose load this device already plays. */
  settle(revision: number): void {
    this.#seen = Math.max(this.#seen, revision);

    if (revision <= this.#applied) return;

    this.#applied = revision;
    this.#report();
  }

  async #apply({ revision, ask }: ConnectRequest): Promise<void> {
    let settled: number | null = revision;

    try {
      switch (ask.kind) {
        case "stop": {
          this.#controller.release();
          break;
        }

        case "transport": {
          if (this.#plays(ask.item)) {
            this.#controller.steer(ask.playing, positionAt(ask, this.serverNow()));
          }

          break;
        }

        case "load": {
          settled = await this.#load(revision, ask);
          break;
        }
      }
    } catch {
      // A load whose songs failed changed nothing here; its newest ask is still settled, as the
      // device tried it, unless another request replaced it meanwhile.
      const pending = this.#pendingLoad;

      this.#pendingLoad = null;
      settled =
        ask.kind !== "load"
          ? revision
          : pending?.loadRevision === ask.loadRevision
            ? pending.revision
            : null;
    }

    if (settled === null || this.#handling !== settled) return;
    this.#handling = null;
    this.settle(settled);
  }

  /** Whether `item` is the song loaded here. */
  #plays(item: ConnectItem): boolean {
    const here = this.#controller.playingHere();

    return here !== null && isSong(item) && item.ref.id === here.trackId;
  }

  /**
   * Starts the load `ask` names, or steers the one it already started, and answers the revision
   * that settles it: the newest ask for this load, or null when another request or the listener
   * replaced it while it started.
   */
  async #load(revision: number, ask: LoadAsk): Promise<number | null> {
    if (ask.loadRevision <= this.#startedLoad) {
      this.#controller.steer(ask.playing, positionAt(ask, this.serverNow()));

      return revision;
    }

    this.#startedLoad = ask.loadRevision;
    const { item } = ask;
    const song = isSong(item);

    if (item.domain !== "music" || (!song && item.ref.type !== "album")) return revision;

    if (
      song &&
      this.#controller.playCurrentAt(item.ref.id, positionAt(ask, this.serverNow()), ask.playing)
    ) {
      return revision;
    }

    this.#pendingLoad = { loadRevision: ask.loadRevision, ask, revision };
    const trackIds = song ? [item.ref.id] : await this.#commands.albumTracks(item.ref.id);
    const fetched = this.#startingLoad();

    if (fetched?.loadRevision !== ask.loadRevision) return null;

    await this.#controller.playTracks(trackIds, 0, {
      positionMs: positionAt(fetched.ask, this.serverNow()),
      playing: fetched.ask.playing,
    });

    const latest = this.#startingLoad();

    if (latest?.loadRevision !== ask.loadRevision) return null;
    this.#pendingLoad = null;

    // A play, pause, or seek asked while the new queue was written lands on the song it started.
    if (latest.ask !== fetched.ask) {
      this.#controller.steer(latest.ask.playing, positionAt(latest.ask, this.serverNow()));
    }

    return latest.revision;
  }

  /** The load starting here as it stands now, which a request that arrived during an await changed. */
  #startingLoad(): PendingLoad | null {
    return this.#pendingLoad;
  }

  #changed = (): void => {
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
