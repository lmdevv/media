import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { ConnectPlayer } from "./connect-player";
import type { ConnectAsk, ConnectCommands, ReportedSong } from "./connect-player";
import type { QueueState } from "./playback-controller";
import { listingOf, queueStateOf } from "./queue-listing";
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

/**
 * What happens around a reconnect: the core's queue moves on, its state or one of its listing's
 * two pages reaches this device as the core holds it then, in any order, as subscriptions that
 * retry or reconnect deliver them, the pages fail and start over, a queue write answers, or
 * another device loads a song here.
 */
type ReconnectEvent =
  | {
      readonly kind: "load";
      /** Of the song the core's queue plays now, as a move asks, when the listener may play it. */
      readonly current: boolean;
      readonly playing: boolean;
      readonly positionMs: number;
    }
  | { readonly kind: "state" }
  | { readonly kind: "page"; readonly index: number }
  /** The pages fail and load again: the last whole listing stays until each page is in again. */
  | { readonly kind: "restart" }
  /** Another entry of the queue plays. */
  | { readonly kind: "jump" }
  /** An entry of a new song joins at the end and plays, as autoplay's do. */
  | { readonly kind: "advance" }
  /** The entry that plays moves to the top, from the second page onto the first. */
  | { readonly kind: "top" }
  /** The listener may no longer play the song of the entry that plays; the revision stays. */
  | { readonly kind: "revoke" }
  | { readonly kind: "write" };

const reconnectEvents = fc.array(
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
    { weight: 3, arbitrary: fc.constant({ kind: "state" } as const) },
    {
      weight: 4,
      arbitrary: fc.record({
        kind: fc.constant("page" as const),
        index: fc.integer({ min: 0, max: 1 }),
      }),
    },
    { weight: 1, arbitrary: fc.constant({ kind: "restart" } as const) },
    { weight: 1, arbitrary: fc.constant({ kind: "jump" } as const) },
    { weight: 2, arbitrary: fc.constant({ kind: "advance" } as const) },
    { weight: 1, arbitrary: fc.constant({ kind: "top" } as const) },
    { weight: 1, arbitrary: fc.constant({ kind: "revoke" } as const) },
    { weight: 2, arbitrary: fc.constant({ kind: "write" } as const) },
  ),
  { maxLength: 16 },
);

/** The queue the core holds at one revision. */
interface RevisedQueue {
  readonly entries: ReadonlyArray<QueuedSong>;
  readonly current: string | null;
}

/** Entries at these first positions make the listing's first page, and the rest its second. */
const FIRST_PAGE = 2;

/** A page of the listing as this device last heard it. */
interface PageRead {
  readonly rows: ReadonlyArray<QueuedSong>;
  readonly revision: number;
  /** The entries the core left out of its listing as it read the page. */
  readonly hidden: ReadonlySet<string>;
}

/** The queue the core holds now, and the entries whose songs the listener may not play. */
interface ReconnectCore {
  revision: number;
  queue: RevisedQueue;
  hidden: ReadonlySet<string>;
}

/** What reached this device of the queue so far, and the queue it was last shown from it. */
interface Heard {
  state: { readonly current: string | null; readonly revision: number } | null;
  /** Each page since the pages last started over, or null until it arrives again. */
  pages: ReadonlyArray<PageRead | null>;
  /** The pages the last time all of them were in. */
  last: ReadonlyArray<PageRead> | null;
  view: QueueState | null;
}

/**
 * Plays `script` on a device that just opened, whose queue's state and two listing pages each
 * reach it on their own, then lets every write answer and everything reach it as the core holds
 * it. Checks that the queue is replaced only while this device was shown another song playing,
 * or none, or a listing whole at the revision of the state it was shown that leaves the entry
 * playing out as the core read it, and that every request settles.
 */
const followAcrossReconnects = async (script: ReadonlyArray<ReconnectEvent>): Promise<void> => {
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

  const core: ReconnectCore = {
    revision: 1,
    queue: {
      entries: [
        { trackId: "s1", itemId: "i1" },
        { trackId: "s2", itemId: "i2" },
        { trackId: "s3", itemId: "i3" },
      ],
      current: "i1",
    },
    hidden: new Set(),
  };

  const history = new Map<number, RevisedQueue>([[core.revision, core.queue]]);

  const heard: Heard = { state: null, pages: [null, null], last: null, view: null };

  const counts = { requests: 0, loads: 0, songs: 3, writes: 0, checked: 0 };

  const moveOn = (queue: RevisedQueue): void => {
    core.revision += 1;
    core.queue = queue;
    history.set(core.revision, queue);
  };

  const readPage = (index: number): PageRead => {
    const range =
      index === 0 ? core.queue.entries.slice(0, FIRST_PAGE) : core.queue.entries.slice(FIRST_PAGE);

    return {
      rows: range.filter((queued) => !core.hidden.has(queued.itemId)),
      revision: core.revision,
      hidden: core.hidden,
    };
  };

  /** The queue as the player provider hands it to the controller, from what reached it so far. */
  const show = (): void => {
    const reads = heard.pages.flatMap((read) => (read === null ? [] : [read]));
    const whole = reads.length === heard.pages.length ? reads : null;

    if (whole !== null) heard.last = whole;
    const pages = whole ?? heard.last;

    if (heard.state === null || pages === null) return;

    const view = queueStateOf(
      {
        current: heard.state.current,
        shuffle: false,
        repeat: "off",
        autoplay: false,
        revision: heard.state.revision,
      },
      listingOf(pages, whole !== null),
      (queued: QueuedSong) => entry(queued.trackId, queued.itemId),
    );

    heard.view = view;
    run.controller.sync(view);
  };

  /** The song each queue write the controller sent plays, in order. */
  const written = (): ReadonlyArray<string> =>
    names(run.sent).flatMap((name) => {
      const songs = /^play:(?<songs>[^,]+),0$/u.exec(name)?.groups?.songs;

      return songs === undefined ? [] : [songs];
    });

  /**
   * Each write went out while the queue this device was shown said another song plays, or none,
   * or left the entry playing out of a listing whose every page the core read at the revision of
   * the state shown, as it left out an entry whose song the listener may not play.
   */
  const checkWrites = (): void => {
    const sent = written();

    for (const song of sent.slice(counts.checked)) {
      const { view, state } = heard;

      expect(view).not.toBeNull();
      expect(state).not.toBeNull();

      if (view === null || state === null) return;
      const playing = view.entries.find((queued) => queued.itemId === view.current);

      if (view.current === null || playing !== undefined) {
        expect(playing?.track.id).not.toBe(song);
      } else {
        const position =
          history
            .get(state.revision)
            ?.entries.findIndex((queued) => queued.itemId === view.current) ?? -1;

        expect(heard.pages.map((read) => read?.revision)).toEqual([state.revision, state.revision]);
        expect(position).toBeGreaterThanOrEqual(0);
        expect(heard.pages[position < FIRST_PAGE ? 0 : 1]?.hidden.has(view.current)).toBe(true);
      }
    }

    counts.checked = sent.length;
  };

  /** The oldest queue write answers, and the core holds that queue from then. */
  const answerWrite = (): boolean => {
    const song = written()[counts.writes];

    if (song === undefined) return false;
    counts.writes += 1;
    const itemId = `w${counts.writes}`;

    moveOn({ entries: [{ trackId: song, itemId }], current: itemId });
    run.answer.current = itemId;
    run.gates.play.release("play");

    return true;
  };

  const apply = async (event: ReconnectEvent): Promise<void> => {
    const { queue } = core;
    const playing = queue.entries.find((queued) => queued.itemId === queue.current);

    switch (event.kind) {
      case "load": {
        counts.requests += 1;
        counts.loads += 1;

        // The core loads only a song the listener may play.
        const trackId =
          event.current && playing !== undefined && !core.hidden.has(playing.itemId)
            ? playing.trackId
            : `x${counts.loads}`;

        connect.take({
          revision: counts.requests,
          ask: {
            kind: "load",
            item: track(trackId),
            playing: event.playing,
            positionMs: event.positionMs,
            at: run.clock.now,
            loadRevision: counts.loads,
          },
        });
        break;
      }

      case "state": {
        heard.state = { current: queue.current, revision: core.revision };
        show();
        break;
      }

      case "page": {
        heard.pages = heard.pages.map((read, index) =>
          index === event.index ? readPage(index) : read,
        );
        show();
        break;
      }

      case "restart": {
        heard.pages = [null, null];
        show();
        break;
      }

      case "jump": {
        const other = queue.entries.find((queued) => queued.itemId !== queue.current);

        if (other !== undefined) moveOn({ ...queue, current: other.itemId });
        break;
      }

      case "advance": {
        counts.songs += 1;
        const added = { trackId: `s${counts.songs}`, itemId: `i${counts.songs}` };

        moveOn({ entries: [...queue.entries, added], current: added.itemId });
        break;
      }

      case "top": {
        if (playing !== undefined) {
          moveOn({
            ...queue,
            entries: [playing, ...queue.entries.filter((queued) => queued !== playing)],
          });
        }

        break;
      }

      case "revoke": {
        if (queue.current !== null) core.hidden = new Set([...core.hidden, queue.current]);
        break;
      }

      case "write": {
        answerWrite();
        break;
      }
    }

    await settle();
    checkWrites();
  };

  const applyAll = async (remaining: ReadonlyArray<ReconnectEvent>): Promise<void> => {
    const [event, ...rest] = remaining;

    if (event === undefined) return;
    await apply(event);
    await applyAll(rest);
  };

  /** Every write answers, then the state and every page reach this device, until nothing waits. */
  const drain = async (): Promise<void> => {
    const answered = answerWrite();

    heard.state = { current: core.queue.current, revision: core.revision };
    heard.pages = heard.pages.map((_, index) => readPage(index));
    show();
    await settle();
    checkWrites();

    if (answered || written().length > counts.writes) await drain();
  };

  await applyAll(script);
  await drain();

  if (counts.requests > 0) expect(applied.at(-1)).toBe(counts.requests);

  await expectEngineAsMeant(run);
  stopConnect();
  run.stop();
};

/**
 * What happens next to a song playing here whose engine says so late: another device asks it to
 * play or pause, or scrubs it as it last saw it; the listener taps here; or the engine's event
 * for a play or pause it already did arrives.
 */
type Turn =
  | { readonly kind: "remote"; readonly playing: boolean; readonly offMs: number }
  | { readonly kind: "scrub"; readonly offMs: number }
  | { readonly kind: "toggle" }
  | { readonly kind: "answer" };

const turns = fc.array(
  fc.oneof(
    {
      weight: 3,
      arbitrary: fc.record({
        kind: fc.constant("remote" as const),
        playing: fc.boolean(),
        offMs: fc.constantFrom(0, 100, 5000),
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({
        kind: fc.constant("scrub" as const),
        offMs: fc.constantFrom(0, 5000),
      }),
    },
    { weight: 1, arbitrary: fc.constant({ kind: "toggle" } as const) },
    { weight: 2, arbitrary: fc.constant({ kind: "answer" } as const) },
  ),
  { minLength: 1, maxLength: 12 },
);

/**
 * Plays a song here on a held engine, then `script`. Every report must say what the engine does as
 * it is sent, so a controller that sees a request settled never sees the state that request
 * replaced.
 */
const reportAsHeard = async (script: ReadonlyArray<Turn>): Promise<void> => {
  const run = setup({ playCurrent: "1", heldPlayState: true });
  const reported: Array<{ readonly song: ReportedSong | null; readonly sounding: boolean }> = [];

  const commands: ConnectCommands = {
    report: async (song) => {
      reported.push({ song, sounding: run.engine().samplePlayback().playing });

      return run.clock.now;
    },
    albumTracks: async () => [],
  };

  const connect = new ConnectPlayer(run.controller, commands, {
    now: () => run.clock.now,
    every: () => () => undefined,
  });

  await run.controller.playTracks(["a", "b"], 0);
  run.controller.sync(queueOf([entry("a", "1"), entry("b", "2")], "1"));
  await settle();
  run.engine().answer();
  const stopConnect = connect.start();
  let revision = 0;

  const play = async (turn: Turn): Promise<void> => {
    const here = run.controller.playingHere();

    if (turn.kind === "answer") run.engine().answer();
    else if (turn.kind === "toggle") await run.controller.togglePlay();
    else if (here !== null) {
      revision += 1;
      connect.take({
        revision,
        ask: {
          kind: "transport",
          item: track(here.trackId),
          playing:
            turn.kind === "remote" ? turn.playing : (reported.at(-1)?.song?.playing ?? false),
          positionMs: here.positionMs + turn.offMs,
          at: run.clock.now,
        },
      });
    }

    await settle();
  };

  const playAll = async ([turn, ...rest]: ReadonlyArray<Turn>): Promise<void> => {
    if (turn === undefined) return;
    await play(turn);
    await playAll(rest);
  };

  try {
    await playAll(script);
    run.engine().answer();
    await settle();

    expect(reported.map(({ song }) => song?.playing ?? false)).toEqual(
      reported.map(({ sounding }) => sounding),
    );
    await expectEngineAsMeant(run);
  } finally {
    stopConnect();
    run.stop();
  }
};

describe("ConnectPlayer under any order of requests, answers, and the listener's actions", () => {
  it("reports what the engine does at once, under any order of remote plays and pauses, taps, and engine events still on their way", async () => {
    await fc.assert(fc.asyncProperty(turns, reportAsHeard), { numRuns: 200 });
  }, 60_000);

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

  it("replaces the queue on a song load only once a whole listing of the queue's own revision leaves its entry out, whatever order the state and pages arrive in around a reconnect", async () => {
    await fc.assert(fc.asyncProperty(reconnectEvents, followAcrossReconnects), { numRuns: 250 });
  }, 60_000);
});
