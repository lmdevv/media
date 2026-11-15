import { Result } from "effect";

import type { EngineEvent, EngineKind, EngineSource, PlayerEngine } from "../engine";
import type { MediaSessionHandlers } from "../media-session";
import { PlaybackController } from "../playback-controller";
import type {
  ControllerEnvironment,
  MusicCommands,
  QueueEntry,
  QueueState,
  ResumePoint,
} from "../playback-controller";
import { SourceUnreachable, ticketSources } from "../source-resolver";
import type { PlayStart, SourceResolver } from "../source-resolver";

/*
 * The playback controller over a fake engine that answers at once, a recording core, and gates
 * that hold its calls, for the controller's own tests and Connect's.
 */

const SIX_HOURS = 6 * 60 * 60 * 1000;

export const BASE = "http://media.test";

export const NOT_DOWNLOADED = "This song isn’t downloaded";

/** Where the device's copy of `trackId` is. */
export const copyUrl = (trackId: string): string => `file:///copies/${trackId}`;

export const entry = (id: string, itemId: string, durationMs = 200_000): QueueEntry => ({
  itemId,
  autoplay: false,
  track: {
    id,
    title: `Song ${id}`,
    artist: "Artist",
    album: "Album",
    artUrl: null,
    durationMs,
    codec: "AAC",
    lossless: false,
  },
});

/** A queue whose listing is whole unless `fields` says its pages are still loading. */
export const queueOf = (
  entries: ReadonlyArray<QueueEntry>,
  current: string | null,
  fields: Partial<QueueState> = {},
): QueueState => ({
  entries,
  complete: true,
  current,
  shuffle: false,
  repeat: "off",
  autoplay: false,
  ...fields,
});

interface Load {
  readonly kind: EngineKind;
  readonly url: string;
  readonly startMs: number;
}

interface EngineRecord {
  readonly created: Array<EngineKind>;
  readonly loads: Array<Load>;
  readonly preloads: Array<EngineSource | null>;
  readonly seeks: Array<number>;
  /** Every stream the engine started, by a load or by moving on to its preload, in order. */
  readonly played: Array<string>;
  plays: number;
  /** Times the output was primed inside a tap. */
  unlocks: number;
  /** Loads still to come that the server refuses, as an expired ticket. */
  refuse: number;
  /** Sources that fail to decode, as a damaged copy on the device. */
  readonly broken: Set<string>;
}

type FakeEngine = PlayerEngine & {
  readonly emit: (event: EngineEvent) => void;
  /** Plays the current source to its end: moves on to the preload, as both engines do, or ends. */
  readonly finish: () => void;
};

/**
 * An engine that plays at once: it answers each call with the events a real one would send, and
 * keeps a preload across loads of other sources, as both real engines do.
 */
const instantEngine = (kind: EngineKind, record: EngineRecord): FakeEngine => {
  const listeners = new Set<(event: EngineEvent) => void>();
  let paused = true;
  let positionMs = 0;
  let current: EngineSource | null = null;
  let queued: EngineSource | null = null;

  const emit = (event: EngineEvent): void => {
    if (event.type === "time") positionMs = event.positionMs;

    if (event.type === "playing") paused = false;
    else if (event.type === "paused" || event.type === "ended") paused = true;

    for (const listener of listeners) listener(event);
  };

  record.created.push(kind);

  return {
    emit,
    finish: () => {
      const next = queued;

      if (next === null) {
        emit({ type: "ended" });

        return;
      }

      current = next;
      queued = null;
      positionMs = 0;
      record.played.push(next.url);
      emit({ type: "advanced", key: next.key });
    },
    samplePlayback: () => ({ positionMs, playing: !paused }),
    load: async (source, startMs, autoplay) => {
      record.loads.push({ kind, url: source.url, startMs });
      record.played.push(source.url);
      current = source;

      if (queued?.url === source.url) queued = null;
      positionMs = startMs;

      if (record.refuse > 0) {
        record.refuse -= 1;
        emit({ type: "error", reason: "expired", message: "expired" });

        return;
      }

      if (record.broken.has(source.url)) {
        emit({ type: "error", reason: "decode", message: "Cannot decode" });

        return;
      }

      emit({ type: autoplay ? "playing" : "paused" });
    },
    preload: (source) => {
      record.preloads.push(source);
      queued = source;
    },
    play: async () => {
      if (current === null) return;
      record.plays += 1;
      emit({ type: "playing" });
    },
    pause: () => {
      emit({ type: "paused" });
    },
    seek: (target) => {
      record.seeks.push(target);
      emit({ type: "time", positionMs: target });
    },
    setVolume: () => {},
    unlock: () => {
      record.unlocks += 1;
    },
    unload: () => {
      paused = true;
      positionMs = 0;
      current = null;
      queued = null;
    },
    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
};

interface Sent {
  readonly name: "play" | "jump" | "report" | "start";
  readonly args: ReadonlyArray<unknown>;
}

interface HeldCall {
  readonly id: string;
  readonly release: () => void;
  readonly fail: (error: Error) => void;
}

/** Holds the calls through it while `holding` is set, until the test settles each one by id. */
class Gate {
  holding = false;
  readonly #held: Array<HeldCall> = [];

  /** Resolves at once, or once the test settles the call when the gate holds. */
  pass(id: string): Promise<void> {
    if (!this.holding) return Promise.resolve();

    return new Promise((resolve, reject) => {
      this.#held.push({ id, release: resolve, fail: reject });
    });
  }

  release(id: string): void {
    this.#take(id).release();
  }

  fail(id: string, message: string): void {
    this.#take(id).fail(new Error(message));
  }

  #take(id: string): HeldCall {
    const at = this.#held.findIndex((call) => call.id === id);
    const [call] = at === -1 ? [] : this.#held.splice(at, 1);

    if (call === undefined) throw new Error(`No call for ${id} is held`);

    return call;
  }
}

/** Waits a macrotask turn, so every awaited call inside the controller settles first. */
/** What the system media controls (headset, lock screen, media keys) call while started. */
interface SystemControls {
  handlers: MediaSessionHandlers | null;
  /** How many times the controller called `NowPlayingControls.commanded`. */
  commanded: number;
}

export const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

export const setup = (
  options: {
    readonly gapless?: boolean;
    readonly mse?: boolean;
    readonly ticketMs?: number;
    readonly resume?: ResumePoint | null;
    readonly playCurrent?: string;
    readonly baseUrl?: string;
    /** Songs the device holds a copy of, which play from it before any stream. */
    readonly copies?: ReadonlyArray<string>;
    /** Songs whose copy on the device fails to decode. */
    readonly broken?: ReadonlyArray<string>;
    /** The server can't be asked: a song without a copy is unreachable. */
    readonly offline?: boolean;
  } = {},
) => {
  const record: EngineRecord = {
    created: [],
    loads: [],
    preloads: [],
    seeks: [],
    played: [],
    plays: 0,
    unlocks: 0,
    refuse: 0,
    broken: new Set((options.broken ?? []).map(copyUrl)),
  };

  /**
   * Hold `music.queue.play` (keyed `play`), `music.tracks.get`, `music.play.start`,
   * `music.queue.jump` and `music.play.report`, keyed by their id.
   */
  const gates = {
    play: new Gate(),
    track: new Gate(),
    start: new Gate(),
    jump: new Gate(),
    report: new Gate(),
  };

  const engines: Array<FakeEngine> = [];
  const sent: Array<Sent> = [];
  const clock = { now: 1_000_000, monotonic: 0 };
  const saved: Array<ResumePoint | null> = [];
  const systemControls: SystemControls = { handlers: null, commanded: 0 };
  let starts = 0;

  const start = async (trackId: string): Promise<PlayStart> => {
    starts += 1;
    const number = starts;
    sent.push({ name: "start", args: [trackId] });
    await gates.start.pass(trackId);

    return {
      playbackId: `p${number}`,
      startedAt: 5,
      ticket: `t${number}`,
      expiresAt: 5 + (options.ticketMs ?? SIX_HOURS),
    };
  };

  /** The songs `music.tracks.get` was asked for, in order. */
  const lookups: Array<string> = [];

  /** The entry `music.queue.play` answers, read as each call answers, so a test can change it. */
  const answer = { current: options.playCurrent ?? "new" };

  const commands: MusicCommands = {
    play: async (trackIds, index) => {
      sent.push({ name: "play", args: [trackIds, index] });
      await gates.play.pass("play");

      return { current: answer.current };
    },
    track: async (trackId) => {
      lookups.push(trackId);
      await gates.track.pass(trackId);

      return entry(trackId, trackId).track;
    },
    jump: async (itemId) => {
      sent.push({ name: "jump", args: [itemId] });
      await gates.jump.pass(itemId);
    },
    report: async (trackId, playbackId) => {
      sent.push({ name: "report", args: [trackId, playbackId] });
      await gates.report.pass(trackId);
    },
  };

  const env: ControllerEnvironment = {
    canPlay: () => true,
    now: () => clock.now,
    monotonicNow: () => clock.monotonic,
    settings: { quality: "lossless", volume: 1, gapless: options.gapless ?? true },
    saveQuality: () => {},
    saveVolume: () => {},
    nowPlaying: {
      setHandlers: (handlers) => {
        systemControls.handlers = handlers;
      },
      show: () => {},
      commanded: () => {
        systemControls.commanded += 1;
      },
    },
    resume: {
      load: () => options.resume ?? null,
      save: (point) => {
        saved.push(point);
      },
    },
  };

  const copies = new Set(options.copies ?? []);
  /** Set once the device stops waiting for the server: a ticket that answers later counts as none. */
  const device = { away: false };
  /** The copies the player stopped playing, by URL, in order. */
  const discarded: Array<string> = [];
  const streams = ticketSources(start, { now: () => clock.now, baseUrl: options.baseUrl ?? BASE });

  /** A device's resolver: its copy of a song first, else a stream, else nothing while offline. */
  const sources: SourceResolver = {
    resolve: async (track, profile, reach) => {
      if (copies.has(track.id)) {
        return Result.succeed({
          origin: "local",
          profile: "aac-320",
          renewAt: Number.MAX_SAFE_INTEGER,
          playbackId: `local-${track.id}`,
          source: {
            key: `${track.id}:local`,
            url: copyUrl(track.id),
            durationMs: track.durationMs,
            finished: true,
          },
        });
      }

      if (options.offline === true) {
        return Result.fail(new SourceUnreachable({ message: NOT_DOWNLOADED }));
      }

      const streamed = await streams.resolve(track, profile, reach);

      return device.away
        ? Result.fail(new SourceUnreachable({ message: NOT_DOWNLOADED }))
        : streamed;
    },
    discard: (trackId, url) => {
      discarded.push(url);

      if (url === copyUrl(trackId)) copies.delete(trackId);
    },
  };

  const controller = new PlaybackController(
    commands,
    sources,
    {
      mse: options.mse === true ? { flac: true, changeType: true } : null,
      create: (kind) => {
        const engine = instantEngine(kind, record);

        engines.push(engine);

        return engine;
      },
    },
    env,
  );

  const stop = controller.start();
  const engine = (): FakeEngine => engines.at(-1) ?? instantEngine("html", record);

  return {
    controller,
    record,
    sent,
    lookups,
    clock,
    saved,
    stop,
    engine,
    gates,
    answer,
    discarded,
    device,
    systemControls,
  };
};

export const names = (sent: ReadonlyArray<Sent>): ReadonlyArray<string> =>
  sent.map((call) => `${call.name}:${call.args.join(",")}`);
