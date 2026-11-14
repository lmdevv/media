import { describe, expect, it } from "vitest";

import type { EngineEvent, EngineKind, EngineSource, PlayerEngine } from "./engine";
import { PlaybackController } from "./playback-controller";
import type {
  ControllerEnvironment,
  MusicCommands,
  QueueEntry,
  QueueState,
  ResumePoint,
} from "./playback-controller";
import { ticketSources } from "./source-resolver";
import type { PlayStart } from "./source-resolver";

const SIX_HOURS = 6 * 60 * 60 * 1000;

const BASE = "http://media.test";

const entry = (id: string, itemId: string, durationMs = 200_000): QueueEntry => ({
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

const queueOf = (
  entries: ReadonlyArray<QueueEntry>,
  current: string | null,
  fields: Partial<QueueState> = {},
): QueueState => ({
  entries,
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
  plays: number;
  /** Loads still to come that the server refuses, as an expired ticket. */
  refuse: number;
}

type FakeEngine = PlayerEngine & { readonly emit: (event: EngineEvent) => void };

/** An engine that plays at once: it answers each call with the events a real one would send. */
const instantEngine = (kind: EngineKind, record: EngineRecord): FakeEngine => {
  const listeners = new Set<(event: EngineEvent) => void>();
  let paused = true;
  let positionMs = 0;

  const emit = (event: EngineEvent): void => {
    if (event.type === "time") positionMs = event.positionMs;

    if (event.type === "playing") paused = false;
    else if (event.type === "paused" || event.type === "ended") paused = true;

    for (const listener of listeners) listener(event);
  };

  record.created.push(kind);

  return {
    emit,
    samplePlayback: () => ({ positionMs, playing: !paused }),
    load: async (source, startMs, autoplay) => {
      record.loads.push({ kind, url: source.url, startMs });
      positionMs = startMs;

      if (record.refuse > 0) {
        record.refuse -= 1;
        emit({ type: "error", reason: "expired", message: "expired" });

        return;
      }

      emit({ type: autoplay ? "playing" : "paused" });
    },
    preload: (source) => {
      record.preloads.push(source);
    },
    play: async () => {
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
    unload: () => {
      paused = true;
      positionMs = 0;
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

/** Waits a macrotask turn, so every awaited call inside the controller settles first. */
const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

const setup = (
  options: {
    readonly gapless?: boolean;
    readonly mse?: boolean;
    readonly ticketMs?: number;
    readonly resume?: ResumePoint | null;
    readonly playCurrent?: string;
  } = {},
) => {
  const record: EngineRecord = {
    created: [],
    loads: [],
    preloads: [],
    seeks: [],
    plays: 0,
    refuse: 0,
  };

  const engines: Array<FakeEngine> = [];
  const sent: Array<Sent> = [];
  const clock = { now: 1_000_000, monotonic: 0 };
  const saved: Array<ResumePoint | null> = [];
  let starts = 0;

  const start = async (trackId: string): Promise<PlayStart> => {
    starts += 1;
    sent.push({ name: "start", args: [trackId] });

    return {
      playbackId: `p${starts}`,
      startedAt: 5,
      ticket: `t${starts}`,
      expiresAt: 5 + (options.ticketMs ?? SIX_HOURS),
    };
  };

  const commands: MusicCommands = {
    play: async (trackIds, index) => {
      sent.push({ name: "play", args: [trackIds, index] });

      return { current: options.playCurrent ?? "new" };
    },
    jump: async (itemId) => {
      sent.push({ name: "jump", args: [itemId] });
    },
    report: async (trackId, playbackId) => {
      sent.push({ name: "report", args: [trackId, playbackId] });
    },
  };

  const env: ControllerEnvironment = {
    canPlay: () => true,
    now: () => clock.now,
    monotonicNow: () => clock.monotonic,
    settings: { quality: "lossless", volume: 1, gapless: options.gapless ?? true },
    saveQuality: () => {},
    saveVolume: () => {},
    nowPlaying: { setHandlers: () => {}, show: () => {} },
    resume: {
      load: () => options.resume ?? null,
      save: (point) => {
        saved.push(point);
      },
    },
  };

  const controller = new PlaybackController(
    commands,
    ticketSources(start, { now: () => clock.now, baseUrl: BASE }),
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

  return { controller, record, sent, clock, saved, stop, engine };
};

const names = (sent: ReadonlyArray<Sent>): ReadonlyArray<string> =>
  sent.map((call) => `${call.name}:${call.args.join(",")}`);

const one = entry("a", "1");

const two = entry("b", "2");

const three = entry("c", "3");

describe("PlaybackController", () => {
  it("plays a new queue with a ticket for its song, and records the play once", async () => {
    const { controller, record, sent } = setup({ playCurrent: "1" });

    await controller.playTracks(["a", "b"], 0);
    controller.sync(queueOf([one, two], "1"));
    await settle();

    expect(record.loads.map((load) => load.url)).toStrictEqual([
      `${BASE}/media/music/stream/a?ticket=t1&p=original`,
    ]);
    expect(controller.getSnapshot().engineStatus).toBe("playing");
    expect(names(sent)).toStrictEqual(["play:a,b,0", "start:a", "report:a,p1"]);
  });

  it("moves to the next entry at once and keeps it while the core confirms", async () => {
    const { controller, record, sent } = setup({ playCurrent: "1" });

    await controller.playTracks(["a", "b"], 0);
    controller.sync(queueOf([one, two], "1"));
    await settle();
    await controller.next();
    await settle();

    expect(controller.getSnapshot().current).toBe("2");
    expect(record.loads.at(-1)?.url).toContain("/stream/b?");
    expect(names(sent)).toContain("jump:2");

    controller.sync(queueOf([one, two], "1"));
    await settle();

    expect(controller.getSnapshot().current).toBe("2");
    expect(record.loads).toHaveLength(2);

    controller.sync(queueOf([one, two], "2"));
    await settle();

    expect(controller.getSnapshot().current).toBe("2");
    expect(record.loads).toHaveLength(2);
  });

  it("follows a move made elsewhere: loads it while playing, shows it while paused", async () => {
    const playing = setup({ playCurrent: "1" });

    await playing.controller.playTracks(["a", "b"], 0);
    playing.controller.sync(queueOf([one, two], "1"));
    await settle();
    playing.controller.sync(queueOf([one, two], "2"));
    await settle();

    expect(playing.record.loads.at(-1)?.url).toContain("/stream/b?");
    expect(playing.controller.getSnapshot().engineStatus).toBe("playing");

    const paused = setup();

    paused.controller.sync(queueOf([one, two], "1"));
    paused.controller.sync(queueOf([one, two], "2"));
    await settle();

    expect(paused.controller.getSnapshot().current).toBe("2");
    expect(paused.record.loads).toHaveLength(0);
  });

  it("starts the paused song where this browser left it", async () => {
    const { controller, record } = setup({ resume: { itemId: "1", positionMs: 42_000 } });

    controller.sync(queueOf([one, two], "1"));

    expect(controller.positionMs()).toBe(42_000);

    await controller.togglePlay();
    await settle();

    expect(record.loads.at(-1)?.startMs).toBe(42_000);
  });

  it("goes back within the first seconds and starts the song again after", async () => {
    const { controller, record, clock, engine } = setup({ playCurrent: "2" });

    await controller.playTracks(["a", "b"], 1);
    controller.sync(queueOf([one, two], "2"));
    await settle();

    engine().emit({ type: "time", positionMs: 10_000 });
    clock.monotonic += 1;
    await controller.previous();

    expect(record.seeks.at(-1)).toBe(0);
    expect(controller.getSnapshot().current).toBe("2");

    engine().emit({ type: "time", positionMs: 1000 });
    await controller.previous();
    await settle();

    expect(controller.getSnapshot().current).toBe("1");
  });

  it("plays the song again with a new start when repeat is one", async () => {
    const { controller, sent, engine } = setup({ playCurrent: "1" });

    await controller.playTracks(["a"], 0);
    controller.sync(queueOf([one], "1", { repeat: "one" }));
    await settle();
    engine().emit({ type: "ended" });
    await settle();

    expect(names(sent).filter((call) => call.startsWith("report"))).toStrictEqual([
      "report:a,p1",
      "report:a,p2",
    ]);
  });

  it("stops at the start of the last song when the queue runs out", async () => {
    const { controller, engine, saved } = setup({ playCurrent: "1" });

    await controller.playTracks(["a"], 0);
    controller.sync(queueOf([one], "1"));
    await settle();
    engine().emit({ type: "ended" });
    await settle();

    expect(controller.getSnapshot().engineStatus).toBe("paused");
    expect(controller.positionMs()).toBe(0);
    expect(saved.at(-1)).toBeNull();
  });

  it("asks for a fresh ticket once after a refusal, then shows the error", async () => {
    const { controller, record } = setup({ playCurrent: "1" });

    record.refuse = 2;
    await controller.playTracks(["a"], 0);
    controller.sync(queueOf([one], "1"));
    await settle();

    expect(record.loads.map((load) => load.url)).toStrictEqual([
      `${BASE}/media/music/stream/a?ticket=t1&p=original`,
      `${BASE}/media/music/stream/a?ticket=t2&p=original`,
    ]);

    expect(controller.getSnapshot()).toMatchObject({
      engineStatus: "error",
      error: "The media server refused this song's stream",
    });
  });

  it("renews a ticket before it expires when playback resumes", async () => {
    const { controller, record, clock } = setup({ playCurrent: "1", ticketMs: 60_000 });

    await controller.playTracks(["a"], 0);
    controller.sync(queueOf([one], "1"));
    await settle();
    await controller.togglePlay();
    clock.now += 31_000;
    await controller.togglePlay();
    await settle();

    expect(record.loads.map((load) => load.url.match(/ticket=(\w+)/u)?.[1])).toStrictEqual([
      "t1",
      "t2",
    ]);
  });

  it("plays through the gapless engine, and through HTML audio with gapless off", () => {
    expect(setup({ mse: true }).record.created).toStrictEqual(["mse"]);
    expect(setup({ mse: true, gapless: false }).record.created).toStrictEqual(["html"]);
  });

  it("loads the following song ahead and moves the core along when the engine advances", async () => {
    const { controller, record, sent, engine } = setup({ mse: true, playCurrent: "1" });

    await controller.playTracks(["a", "b", "c"], 0);
    controller.sync(queueOf([one, two, three], "1"));
    await settle();
    engine().emit({ type: "time", positionMs: 190_000 });
    await settle();

    expect(record.preloads.at(-1)?.url).toContain("/stream/b?");

    engine().emit({ type: "advanced", key: record.preloads.at(-1)?.key ?? "" });
    await settle();

    expect(controller.getSnapshot().current).toBe("2");
    expect(names(sent).slice(-2)).toStrictEqual(["report:b,p2", "jump:2"]);
  });

  it("empties the player with the queue", async () => {
    const { controller, record } = setup({ playCurrent: "1" });

    await controller.playTracks(["a"], 0);
    controller.sync(queueOf([one], "1"));
    await settle();
    controller.sync(queueOf([], null));

    expect(controller.getSnapshot()).toMatchObject({ current: null, engineStatus: "idle" });
    expect(record.loads).toHaveLength(1);
  });
});
