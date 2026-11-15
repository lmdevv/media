import { createPlatform } from "@media/sdk/promise";
import * as FakeConvex from "@media/sdk/testing/fake-convex";
import { Reply } from "@media/sdk/testing/fake-convex";
import { pagedStore } from "@media/ui/lib/pages";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { ConnectPlayer } from "./connect-player";
import type { ConnectCommands } from "./connect-player";
import { listedPage, listingOf, queueStateOf } from "./queue-listing";
import type { ListedPage, ListingPage, QueueInfo, QueueListing } from "./queue-listing";
import { entry, names, settle, setup } from "./testing/controller-harness";

const info = (current: string | null, revision: number): QueueInfo => ({
  current,
  shuffle: false,
  repeat: "off",
  autoplay: false,
  revision,
});

/** A queue entry as a listing names it: the song and the entry's own id. */
interface Listed {
  readonly trackId: string;
  readonly itemId: string;
}

const listed = (trackId: string, itemId: string): Listed => ({ trackId, itemId });

const toEntry = (row: Listed) => entry(row.trackId, row.itemId);

const page = (revision: number, ...rows: ReadonlyArray<Listed>): ListedPage<Listed> => ({
  rows,
  revision,
});

/** Whether `listing` is the whole listing of a queue state at `revision`. */
const wholeAt = (listing: QueueListing<Listed>, revision: number): boolean =>
  queueStateOf(info("2", revision), listing, toEntry).complete;

describe("the queue's listing", () => {
  const a = listed("a", "1");
  const b = listed("b", "2");

  it("is whole only with every page in at the revision of the state it goes with", () => {
    expect(wholeAt(listingOf([page(4, a), page(4, b)], true), 4)).toBe(true);
    // A retrying page keeps its last answer, read before the queue moved on.
    expect(wholeAt(listingOf([page(3, a), page(3, b)], true), 4)).toBe(false);
    // Pages read at different revisions can leave an entry out between them.
    expect(wholeAt(listingOf([page(4, a), page(3)], true), 4)).toBe(false);
    // The last whole listing, kept while the pages load again.
    expect(wholeAt(listingOf([page(4, a), page(4, b)], false), 4)).toBe(false);
  });

  it("keeps the rows in page order whatever their revisions", () => {
    expect(listingOf([page(1, a), page(2, b)], true)).toEqual({ rows: [a, b], revision: null });
  });

  it("holds a page as one row, the same object until the page changes", () => {
    let state:
      | { readonly status: "loading" }
      | {
          readonly status: "success";
          readonly data: ListingPage<Listed>;
        } = { status: "loading" };

    const watched = listedPage<Listed>({
      subscribe: () => () => undefined,
      getSnapshot: () => state,
    });

    expect(watched.getSnapshot()).toEqual({ status: "loading" });

    state = {
      status: "success",
      data: { page: [a, b], isDone: true, continueCursor: "end", revision: 7 },
    };

    const first = watched.getSnapshot();

    expect(first).toEqual({
      status: "success",
      data: {
        page: [{ rows: [a, b], revision: 7 }],
        isDone: true,
        continueCursor: "end",
        revision: 7,
      },
    });
    expect(watched.getSnapshot()).toBe(first);
  });
});

/** A `music.queue.list` row as the core answers it. */
const row = (trackId: string, itemId: string) => ({
  itemId,
  autoplay: false,
  track: {
    id: trackId,
    title: `Song ${trackId}`,
    artist: "Artist",
    artistId: "artist",
    album: "Album",
    albumId: "album",
    trackNumber: null,
    discNumber: null,
    durationMs: 200_000,
    codec: "AAC",
    lossless: false,
    bitrate: null,
    sampleRate: null,
    bitDepth: null,
    artUrl: null,
    liked: false,
  },
});

/** Resolves once `ready` holds, checking every 10 ms; fails once `deadline` passes. */
const until = async (ready: () => boolean, deadline = Date.now() + 10_000): Promise<void> => {
  if (ready()) return;

  if (Date.now() > deadline) throw new Error("Timed out waiting");
  await new Promise((resolve) => {
    setTimeout(resolve, 10);
  });
  await until(ready, deadline);
};

describe("a device following its queue through the SDK", () => {
  it("never replaces the queue from a whole listing a retrying page kept while the queue moved on", async () => {
    const run = setup();

    const commands: ConnectCommands = {
      report: async () => run.clock.now,
      albumTracks: async () => [],
    };

    const connect = new ConnectPlayer(run.controller, commands, {
      now: () => run.clock.now,
      every: () => () => undefined,
    });

    const core = {
      info: { current: "1", count: 2, shuffle: false, repeat: "off", autoplay: false, revision: 1 },
      page: {
        page: [row("a", "1"), row("b", "2")],
        isDone: true,
        continueCursor: "end",
        revision: 1,
      },
      /** Whether the listing's polls fail as a lost connection does. */
      dropping: false,
      drops: 0,
    };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* FakeConvex.make;

          yield* fake.handle("music/queue:get", () =>
            Effect.succeed(Reply.Success({ value: core.info })),
          );
          yield* fake.handle("music/queue:list", () => {
            if (!core.dropping) return Effect.succeed(Reply.Success({ value: core.page }));
            core.drops += 1;

            return Effect.succeed(Reply.Drop());
          });

          const platform = createPlatform({
            url: fake.url,
            signInUrl: fake.signInUrl,
            connection: "http",
          });

          yield* Effect.promise(async () => {
            const queueInfo = platform.music.queue.get.watch();

            const pages = pagedStore((span) =>
              listedPage(
                platform.music.queue.list.watch({ paginationOpts: { numItems: 200, ...span } }),
              ),
            );

            /** The queue as the player provider hands it to the controller on every change. */
            const shown = () => {
              const state = queueInfo.getSnapshot();
              const paged = pages.getSnapshot();

              if (state.status !== "success" || paged.status !== "ready") return null;

              return queueStateOf(
                state.data,
                listingOf(paged.rows, paged.next.kind === "done"),
                (queued) => entry(queued.track.id, queued.itemId),
              );
            };

            let latest = shown();

            const sync = (): void => {
              const queue = shown();

              if (queue === null) return;
              latest = queue;
              run.controller.sync(queue);
            };

            const stopInfo = queueInfo.subscribe(sync);
            const stopPages = pages.subscribe(sync);
            const stopConnect = connect.start();

            try {
              await until(() => latest?.complete === true);

              // The queue moves on to a new entry of song b while the listing's next poll is lost:
              // the SDK retries it, keeping the page's last answer meanwhile.
              core.info = { ...core.info, current: "new-b", count: 3, revision: 2 };
              core.page = {
                ...core.page,
                page: [row("a", "1"), row("b", "2"), row("b", "new-b")],
                revision: 2,
              };
              core.dropping = true;

              await until(() => latest?.current === "new-b" && core.drops > 0);

              expect(pages.getSnapshot()).toMatchObject({
                status: "ready",
                next: { kind: "done" },
              });

              // Another device moves playback here: a load of the song the queue plays now.
              connect.take({
                revision: 1,
                ask: {
                  kind: "load",
                  item: { domain: "music", ref: { type: "track", id: "b" } },
                  loadRevision: 1,
                  playing: true,
                  positionMs: 30_000,
                  at: run.clock.now,
                },
              });
              await settle();

              expect(names(run.sent).filter((name) => name.startsWith("play:"))).toEqual([]);
              expect(latest).toMatchObject({ current: "new-b", complete: false });
              expect(run.controller.playingHere()).toBeNull();

              core.dropping = false;
              await until(() => latest?.complete === true);
              await settle();

              expect(run.controller.playingHere()).toMatchObject({
                trackId: "b",
                itemId: "new-b",
                playing: true,
              });
              expect(names(run.sent).filter((name) => name.startsWith("play:"))).toEqual([]);
            } finally {
              stopConnect();
              stopPages();
              stopInfo();
              run.stop();
              await platform.dispose();
            }
          });
        }),
      ),
    );
  }, 30_000);
});
