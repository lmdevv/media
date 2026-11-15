import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { ConnectPlayer } from "./connect-player";
import type { ConnectAsk, ConnectCommands, ReportedSong } from "./connect-player";
import { entry, names, queueOf, settle, setup } from "./testing/controller-harness";

/**
 * What happens next: a request, an answer the device waits on, or a tap here. A queue write that
 * answers may bring the new queue at once, as the core's subscription soon does.
 */
type Event =
  | { readonly kind: "album" }
  | { readonly kind: "again"; readonly playing: boolean; readonly positionMs: number }
  | { readonly kind: "transport"; readonly playing: boolean }
  | { readonly kind: "stop" }
  | { readonly kind: "songs"; readonly fails: boolean }
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
const writtenAlbums = (sent: ReturnType<typeof setup>["sent"]): ReadonlyArray<string> =>
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
  writes: number;
  newest: { readonly loadRevision: number; readonly albumId: string } | null;
  /** The album load still starting here. */
  starting: string | null;
  /** The queue the core holds after the last write that answered. */
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
const play = async (script: ReadonlyArray<Event>): Promise<void> => {
  const run = device();

  const model: Model = {
    revision: 0,
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

  const answerWrite = (): boolean => {
    if (writtenAlbums(run.sent).length <= model.writes) return false;
    const albumId = writtenAlbums(run.sent)[model.writes] ?? "";

    model.writes += 1;
    run.answer.current = `q${model.writes}`;
    model.core = { albumId, itemId: `q${model.writes}` };

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
          item: {
            domain: "music",
            ref: { type: "track", id: run.controller.playingHere()?.trackId ?? "none" },
          },
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
    fc.record({ kind: fc.constant("write" as const), synced: fc.boolean() }),
  ),
  { maxLength: 6 },
);

describe("ConnectPlayer under any order of requests, answers, and the listener's actions", () => {
  it("writes a queue only for the load still starting, settles every request, and ends as the newest asks", async () => {
    await fc.assert(fc.asyncProperty(events, play), { numRuns: 250 });
  }, 60_000);

  it("never plays once the listener paused here, whatever loads were still starting", async () => {
    await fc.assert(
      fc.asyncProperty(loadsAndAnswers, async (script) => {
        await play([...script, { kind: "toggle" }]);
      }),
      { numRuns: 200 },
    );
  }, 60_000);
});
