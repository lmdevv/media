import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { ConnectPlayer } from "./connect-player";
import type { ConnectAsk, ConnectCommands, ReportedSong } from "./connect-player";
import type { QueueState } from "./playback-controller";
import { entry, names, queueOf, settle, setup } from "./testing/controller-harness";

type Run = ReturnType<typeof setup>;

const track = (id: string) => ({ domain: "music", ref: { type: "track", id } }) as const;

/**
 * Once everything settled, the engine plays exactly when the controller says this device plays,
 * and the controller means it: a skip made on another device carries this device's play or pause
 * to the next song, as old music's active device followed the queue.
 */
const expectEngineAsMeant = async (run: Run): Promise<void> => {
  const here = run.controller.playingHere();
  const sounding = run.engine().samplePlayback().playing;

  expect(sounding).toBe(here?.playing ?? false);

  if (here === null) return;
  const skipped = [entry(here.trackId, here.itemId), entry("elsewhere", "elsewhere-item")];

  run.controller.sync(queueOf(skipped, here.itemId));
  run.controller.sync(queueOf(skipped, "elsewhere-item"));
  await settle();

  expect(run.controller.playingHere()).toMatchObject({ trackId: "elsewhere", playing: sounding });
  expect(run.engine().samplePlayback().playing).toBe(sounding);
};

/**
 * What happens next: a request, an answer the device waits on, a tap here, or the core's
 * subscription showing a queue written before the write answers, as Convex can. A queue write
 * that answers may bring the new queue at once, as the core's subscription soon does.
 */
type Event =
  | { readonly kind: "album" }
  | { readonly kind: "again"; readonly playing: boolean; readonly positionMs: number }
  | { readonly kind: "transport"; readonly playing: boolean }
  | { readonly kind: "stop" }
  | { readonly kind: "songs"; readonly fails: boolean }
  | { readonly kind: "arrive" }
  | { readonly kind: "write"; readonly synced: boolean }
  | { readonly kind: "toggle" };

const events = fc.array(
  fc.oneof(
    { weight: 2, arbitrary: fc.constant({ kind: "album" } as const) },
    {
      weight: 2,
      arbitrary: fc.record({
        kind: fc.constant("again" as const),
        playing: fc.boolean(),
        positionMs: fc.integer({ min: 0, max: 100_000 }),
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({ kind: fc.constant("transport" as const), playing: fc.boolean() }),
    },
    { weight: 1, arbitrary: fc.constant({ kind: "stop" } as const) },
    {
      weight: 3,
      arbitrary: fc.record({ kind: fc.constant("songs" as const), fails: fc.boolean() }),
    },
    { weight: 2, arbitrary: fc.constant({ kind: "arrive" } as const) },
    {
      weight: 3,
      arbitrary: fc.record({ kind: fc.constant("write" as const), synced: fc.boolean() }),
    },
    { weight: 2, arbitrary: fc.constant({ kind: "toggle" } as const) },
  ),
  { maxLength: 16 },
);

/** Every run starts as the device plays an album from a queue it holds, so a tap here acts. */
const playingAlbum: ReadonlyArray<Event> = [
  { kind: "album" },
  { kind: "songs", fails: false },
  { kind: "write", synced: true },
];

interface HeldAlbum {
  readonly albumId: string;
  readonly answer: () => void;
  readonly fail: () => void;
}

const songsOf = (albumId: string): ReadonlyArray<string> => [`${albumId}-1`, `${albumId}-2`];

/**
 * A device whose album lookups and queue writes wait, in order, until an event answers them, as
 * the core answers one client's calls in the order it sent them.
 */
const device = () => {
  const run = setup();
  const applied: Array<number> = [];
  const held: Array<HeldAlbum> = [];

  const commands: ConnectCommands = {
    report: async (_song: ReportedSong | null, revision) => {
      applied.push(revision);

      return run.clock.now;
    },
    albumTracks: (albumId) =>
      new Promise((resolve, reject) => {
        held.push({
          albumId,
          answer: () => {
            resolve(songsOf(albumId));
          },
          fail: () => {
            reject(new Error("The album's songs failed"));
          },
        });
      }),
  };

  const connect = new ConnectPlayer(run.controller, commands, {
    now: () => run.clock.now,
    every: () => () => undefined,
  });

  const stopConnect = connect.start();

  run.gates.play.holding = true;

  return { ...run, connect, applied, held, stopConnect };
};

/** The album each queue write the controller sent replaced the queue with, in order. */
const writtenAlbums = (sent: Run["sent"]): ReadonlyArray<string> =>
  names(sent).flatMap((name) => {
    const albumId = /^play:(?<albumId>al\d+)-1,/u.exec(name)?.groups?.albumId;

    return albumId === undefined ? [] : [albumId];
  });

/** What the device should end doing, as far as the events decide it. */
type Ending =
  | { readonly kind: "load"; readonly albumId: string; readonly playing: boolean }
  | { readonly kind: "stop" }
  | { readonly kind: "paused" }
  | { readonly kind: "open" };

/** What the events decided so far, as ADR 0018's table reads them. */
interface Model {
  revision: number;
  /** Queue writes the core took, in the order they were sent. */
  commits: number;
  /** Queue writes that answered. */
  writes: number;
  newest: { readonly loadRevision: number; readonly albumId: string } | null;
  /** The album load still starting here. */
  starting: string | null;
  /** The queue the core holds after the last write it took. */
  core: { readonly albumId: string; readonly itemId: string } | null;
  /** The albums whose queue the device should write, in order. */
  readonly expected: Array<string>;
  readonly failed: Set<string>;
  ending: Ending;
}

/**
 * Plays `script` on a device that plays an album from a queue it holds, lets every lookup and
 * write answer, and checks how the device ended against what the events decided.
 */
const playAlbums = async (script: ReadonlyArray<Event>): Promise<void> => {
  const run = device();

  const model: Model = {
    revision: 0,
    commits: 0,
    writes: 0,
    newest: null,
    starting: null,
    core: null,
    expected: [],
    failed: new Set(),
    ending: { kind: "open" },
  };

  /** The device's queue subscription delivers the queue the core holds now. */
  const syncCore = (): void => {
    const { core } = model;

    if (core === null) return;
    const [first = "", second = ""] = songsOf(core.albumId);

    run.controller.sync(
      queueOf([entry(first, core.itemId), entry(second, `${core.itemId}b`)], core.itemId),
    );
  };

  const take = (ask: ConnectAsk): void => {
    model.revision += 1;
    run.connect.take({ revision: model.revision, ask });
  };

  const answerSongs = (fails: boolean): void => {
    const album = run.held.shift();

    if (album === undefined) return;

    if (fails) {
      model.failed.add(album.albumId);

      if (model.starting === album.albumId) model.starting = null;
      album.fail();

      return;
    }

    if (model.starting === album.albumId) model.expected.push(album.albumId);
    album.answer();
  };

  /** The core takes the oldest queue write it has not taken yet, and holds that queue from then. */
  const commit = (): boolean => {
    const albumId = writtenAlbums(run.sent)[model.commits];

    if (albumId === undefined) return false;
    model.commits += 1;
    model.core = { albumId, itemId: `q${model.commits}` };

    return true;
  };

  const answerWrite = (): boolean => {
    const albumId = writtenAlbums(run.sent)[model.writes];

    if (albumId === undefined) return false;

    if (model.commits === model.writes) commit();
    model.writes += 1;
    run.answer.current = `q${model.writes}`;

    if (model.starting === albumId) model.starting = null;
    run.gates.play.release("play");

    return true;
  };

  const apply = async (event: Event): Promise<void> => {
    switch (event.kind) {
      case "album": {
        const albumId = `al${model.revision + 1}`;

        model.newest = { loadRevision: model.revision + 1, albumId };
        model.starting = albumId;
        model.ending = { kind: "load", albumId, playing: true };
        take({
          kind: "load",
          item: { domain: "music", ref: { type: "album", id: albumId } },
          playing: true,
          positionMs: 0,
          at: run.clock.now,
          loadRevision: model.revision + 1,
        });
        break;
      }

      case "again": {
        if (model.newest === null) break;

        if (model.ending.kind === "load" && model.ending.albumId === model.newest.albumId) {
          model.ending = { ...model.ending, playing: event.playing };
        } else model.ending = { kind: "open" };

        take({
          kind: "load",
          item: { domain: "music", ref: { type: "album", id: model.newest.albumId } },
          playing: event.playing,
          positionMs: event.positionMs,
          at: run.clock.now,
          loadRevision: model.newest.loadRevision,
        });
        break;
      }

      case "transport": {
        model.starting = null;
        model.ending = { kind: "open" };
        take({
          kind: "transport",
          item: track(run.controller.playingHere()?.trackId ?? "none"),
          playing: event.playing,
          positionMs: 0,
          at: run.clock.now,
        });
        break;
      }

      case "stop": {
        model.starting = null;
        model.ending = { kind: "stop" };
        take({ kind: "stop", at: run.clock.now });
        break;
      }

      case "songs": {
        answerSongs(event.fails);
        break;
      }

      case "arrive": {
        if (commit()) syncCore();
        break;
      }

      case "write": {
        if (answerWrite() && event.synced) {
          await settle();
          syncCore();
        }

        break;
      }

      case "toggle": {
        const before = run.controller.playingHere()?.playing === true;

        model.starting = null;
        run.connect.supersede();
        await run.controller.togglePlay();
        const after = run.controller.playingHere()?.playing === true;

        model.ending = before && !after ? { kind: "paused" } : { kind: "open" };
        break;
      }
    }

    await settle();
  };

  const applyAll = async (remaining: ReadonlyArray<Event>): Promise<void> => {
    const [event, ...rest] = remaining;

    if (event === undefined) return;
    await apply(event);
    await applyAll(rest);
  };

  const drain = async (): Promise<void> => {
    if (run.held.length > 0) answerSongs(false);
    else if (!answerWrite()) return;
    await settle();
    await drain();
  };

  await applyAll([...playingAlbum, ...script]);
  await drain();
  const here = run.controller.playingHere();

  expect(writtenAlbums(run.sent)).toStrictEqual(model.expected);
  expect(run.applied).toStrictEqual(run.applied.toSorted((left, right) => left - right));
  expect(run.applied.at(-1) ?? 0).toBe(model.revision);

  if (model.ending.kind === "stop") expect(here).toBeNull();

  if (model.ending.kind === "paused") expect(here?.playing ?? false).toBe(false);

  if (model.ending.kind === "load" && !model.failed.has(model.ending.albumId)) {
    expect(here).toMatchObject({
      trackId: `${model.ending.albumId}-1`,
      playing: model.ending.playing,
    });
  }

  await expectEngineAsMeant(run);
  run.stopConnect();
  run.stop();
};

const loadsAndAnswers = fc.array(
  fc.oneof(
    fc.constant({ kind: "album" } as const),
    fc.record({
      kind: fc.constant("again" as const),
      playing: fc.boolean(),
      positionMs: fc.integer({ min: 0, max: 100_000 }),
    }),
    fc.record({ kind: fc.constant("songs" as const), fails: fc.boolean() }),
    fc.constant({ kind: "arrive" } as const),
    fc.record({ kind: fc.constant("write" as const), synced: fc.boolean() }),
  ),
  { maxLength: 6 },
);

/**
 * What may happen while an album's queue write waits: a newer ask for that load, the new queue
 * reaching this device before the write answers, as Convex can show it, or a tap here.
 */
const whileWritten = fc.array(
  fc.oneof(
    fc.record({
      kind: fc.constant("again" as const),
      playing: fc.boolean(),
      positionMs: fc.integer({ min: 0, max: 100_000 }),
    }),
    fc.constant({ kind: "arrive" } as const),
    fc.constant({ kind: "toggle" } as const),
  ),
  { maxLength: 6 },
);

/**
 * What happens next around a load of a song, which waits until the queue this device holds says
 * which entry plays: a request, the queue's listing, the core's queue changing, a write that
 * answers, a tap here, or this device coming back after it went quiet.
 */
type SongEvent =
  | {
      readonly kind: "load";
      /** Of the song the core's queue plays now, as a move asks, when the listener may play it. */
      readonly current: boolean;
      readonly playing: boolean;
      readonly positionMs: number;
    }
  | { readonly kind: "again"; readonly playing: boolean; readonly positionMs: number }
  /**
   * The core's queue reaches this device: every page in, or pages still loading without the entry
   * that plays.
   */
  | { readonly kind: "listing"; readonly whole: boolean }
  /** The listener may no longer play the song of the entry that plays: the listing leaves it out. */
  | { readonly kind: "revoke" }
  | { readonly kind: "write"; readonly synced: boolean }
  | { readonly kind: "transport"; readonly playing: boolean }
  | { readonly kind: "stop" }
  | { readonly kind: "toggle" }
  /** This device reports again after 30 seconds of silence: the core settles every request. */
  | { readonly kind: "away" };

const songEvents = fc.array(
  fc.oneof(
    {
      weight: 3,
      arbitrary: fc.record({
        kind: fc.constant("load" as const),
        current: fc.boolean(),
        playing: fc.boolean(),
        positionMs: fc.integer({ min: 0, max: 100_000 }),
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({
        kind: fc.constant("again" as const),
        playing: fc.boolean(),
        positionMs: fc.integer({ min: 0, max: 100_000 }),
      }),
    },
    {
      weight: 3,
      arbitrary: fc.record({ kind: fc.constant("listing" as const), whole: fc.boolean() }),
    },
    { weight: 1, arbitrary: fc.constant({ kind: "revoke" } as const) },
    {
      weight: 2,
      arbitrary: fc.record({ kind: fc.constant("write" as const), synced: fc.boolean() }),
    },
    {
      weight: 1,
      arbitrary: fc.record({ kind: fc.constant("transport" as const), playing: fc.boolean() }),
    },
    { weight: 1, arbitrary: fc.constant({ kind: "stop" } as const) },
    { weight: 1, arbitrary: fc.constant({ kind: "toggle" } as const) },
    { weight: 1, arbitrary: fc.constant({ kind: "away" } as const) },
  ),
  { maxLength: 14 },
);

interface QueuedSong {
  readonly trackId: string;
  readonly itemId: string;
}

/** The queue the core holds. */
interface CoreQueue {
  readonly entries: ReadonlyArray<QueuedSong>;
  readonly current: string | null;
  /** The listener may no longer play the current entry's song, so the listing leaves it out. */
  readonly hidden: boolean;
}

interface SongModel {
  revision: number;
  /** The newest revision the core settled by itself, as for a device that went quiet. */
  coreSettled: number;
  newest: { readonly loadRevision: number; readonly trackId: string } | null;
  core: CoreQueue;
  /** The queue this device was last shown. */
  view: QueueState | null;
  /** Queue writes that answered. */
  writes: number;
  checkedWrites: number;
  checkedReports: number;
  /** The newest `applied` this device reported. */
  reportedMax: number;
}

/**
 * Plays `script` on a device that just opened, whose queue is still on its way, lets every write
 * answer and the queue's pages all come in, and checks that no start waited without end, that a
 * move never replaced the queue, and that nothing the core settled started later.
 */
const playSongs = async (script: ReadonlyArray<SongEvent>): Promise<void> => {
  const run = setup();
  const applied: Array<number> = [];

  const commands: ConnectCommands = {
    report: async (_song: ReportedSong | null, revision) => {
      applied.push(revision);

      return run.clock.now;
    },
    albumTracks: async () => [],
  };

  const connect = new ConnectPlayer(run.controller, commands, {
    now: () => run.clock.now,
    every: () => () => undefined,
  });

  const stopConnect = connect.start();

  run.gates.play.holding = true;

  const model: SongModel = {
    revision: 0,
    coreSettled: 0,
    newest: null,
    core: {
      entries: [
        { trackId: "s1", itemId: "i1" },
        { trackId: "s2", itemId: "i2" },
      ],
      current: "i1",
      hidden: false,
    },
    view: null,
    writes: 0,
    checkedWrites: 0,
    checkedReports: 0,
    reportedMax: 0,
  };

  /** The song each queue write the controller sent plays, in order. */
  const written = (): ReadonlyArray<string> =>
    names(run.sent).flatMap((name) => {
      const songs = /^play:(?<songs>[^,]+),0$/u.exec(name)?.groups?.songs;

      return songs === undefined ? [] : [songs];
    });

  /**
   * A move never replaces the queue: each write went out while the queue this device was shown
   * said another song plays, or none, or with every page in left the entry that plays out.
   */
  const checkWrites = (): void => {
    const sent = written();

    for (const song of sent.slice(model.checkedWrites)) {
      const { view } = model;

      expect(view).not.toBeNull();

      if (view === null) return;
      const playing = view.entries.find((queued) => queued.itemId === view.current);

      const decided =
        view.current === null ||
        (playing === undefined ? view.complete : playing.track.id !== song);

      expect(decided).toBe(true);
    }

    model.checkedWrites = sent.length;
  };

  /**
   * Nothing the core settled starts later: once the core settled requests by itself, this device
   * raises `applied` only past them, or by a tap here, which makes every request it saw moot.
   */
  const checkReports = (tapped: boolean): void => {
    for (const revision of applied.slice(model.checkedReports)) {
      if (!tapped && revision > model.reportedMax) {
        expect(revision).toBeGreaterThan(model.coreSettled);
      }

      model.reportedMax = Math.max(model.reportedMax, revision);
    }

    model.checkedReports = applied.length;
  };

  const take = (ask: ConnectAsk): void => {
    model.revision += 1;
    connect.take({ revision: model.revision, ask });
    checkWrites();
  };

  /** The core's queue reaches this device: whole, or with the entry that plays not in yet. */
  const show = (whole: boolean): void => {
    const { core } = model;

    const listed = core.entries.filter((queued) =>
      whole ? !(core.hidden && queued.itemId === core.current) : queued.itemId !== core.current,
    );

    const view = queueOf(
      listed.map((queued) => entry(queued.trackId, queued.itemId)),
      core.current,
      { complete: whole },
    );

    model.view = view;
    run.controller.sync(view);
    checkWrites();
  };

  /** The oldest queue write answers, and the core holds that queue from then. */
  const answerWrite = (): boolean => {
    const song = written()[model.writes];

    if (song === undefined) return false;
    model.writes += 1;
    const itemId = `w${model.writes}`;

    model.core = { entries: [{ trackId: song, itemId }], current: itemId, hidden: false };
    run.answer.current = itemId;
    run.gates.play.release("play");

    return true;
  };

  const apply = async (event: SongEvent): Promise<void> => {
    switch (event.kind) {
      case "load": {
        const { core } = model;
        const playing = core.entries.find((queued) => queued.itemId === core.current);
        const loadRevision = model.revision + 1;

        // The core loads only a song the listener may play.
        const trackId =
          event.current && playing !== undefined && !core.hidden
            ? playing.trackId
            : `x${loadRevision}`;

        model.newest = { loadRevision, trackId };
        take({
          kind: "load",
          item: track(trackId),
          playing: event.playing,
          positionMs: event.positionMs,
          at: run.clock.now,
          loadRevision,
        });
        break;
      }

      case "again": {
        if (model.newest === null) break;
        take({
          kind: "load",
          item: track(model.newest.trackId),
          playing: event.playing,
          positionMs: event.positionMs,
          at: run.clock.now,
          loadRevision: model.newest.loadRevision,
        });
        break;
      }

      case "listing": {
        show(event.whole);
        break;
      }

      case "revoke": {
        if (model.core.current !== null) model.core = { ...model.core, hidden: true };
        break;
      }

      case "write": {
        if (answerWrite() && event.synced) {
          await settle();
          show(true);
        }

        break;
      }

      case "transport": {
        take({
          kind: "transport",
          item: track(run.controller.playingHere()?.trackId ?? "none"),
          playing: event.playing,
          positionMs: 0,
          at: run.clock.now,
        });
        break;
      }

      case "stop": {
        take({ kind: "stop", at: run.clock.now });
        break;
      }

      case "toggle": {
        connect.supersede();
        await run.controller.togglePlay();
        await settle();
        checkWrites();
        checkReports(true);

        return;
      }

      case "away": {
        model.coreSettled = model.revision;
        connect.take(null);
        break;
      }
    }

    await settle();
    checkWrites();
    checkReports(false);
  };

  const applyAll = async (remaining: ReadonlyArray<SongEvent>): Promise<void> => {
    const [event, ...rest] = remaining;

    if (event === undefined) return;
    await apply(event);
    await applyAll(rest);
  };

  /** Every write answers, then every page of the queue comes in, until nothing waits. */
  const drain = async (): Promise<void> => {
    const answered = answerWrite();

    if (!answered) show(true);
    await settle();
    checkWrites();
    checkReports(false);

    if (answered || written().length > model.writes) await drain();
  };

  await applyAll(script);
  await drain();

  if (model.revision > model.coreSettled) expect(applied.at(-1)).toBe(model.revision);

  await expectEngineAsMeant(run);
  stopConnect();
  run.stop();
};

describe("ConnectPlayer under any order of requests, answers, and the listener's actions", () => {
  it("writes a queue only for the load still starting, settles every request, and ends as the newest asks", async () => {
    await fc.assert(fc.asyncProperty(events, playAlbums), { numRuns: 250 });
  }, 60_000);

  it("never plays once the listener paused here, whatever loads were still starting", async () => {
    await fc.assert(
      fc.asyncProperty(loadsAndAnswers, async (script) => {
        await playAlbums([...script, { kind: "toggle" }]);
      }),
      { numRuns: 200 },
    );
  }, 60_000);

  it("starts an album whose queue write waited as the newest ask or tap says, whenever its queue arrives", async () => {
    await fc.assert(
      fc.asyncProperty(whileWritten, async (window) => {
        await playAlbums([{ kind: "album" }, { kind: "songs", fails: false }, ...window]);
      }),
      { numRuns: 200 },
    );
  }, 60_000);

  it("ends a song load's wait on a whole listing, a newer request, a tap, or the core settling it, and never replaces the queue on a move", async () => {
    await fc.assert(fc.asyncProperty(songEvents, playSongs), { numRuns: 250 });
  }, 60_000);
});
