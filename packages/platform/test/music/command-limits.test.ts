import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { inOrder } from "../../convex/core/lib/inOrder";
import { logMark, usageSince } from "../admin";
import type { CallUsage } from "../admin";
import { member, sharedAdmin } from "../devices";
import type { Member } from "../devices";
import { seedLibraries, share, shareThroughEveryGroup } from "../probe";
import type { MusicLibrary } from "../probe";
import { unique } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";
import type { CoreStack } from "../stack-env";
import { claimScan, finishScan, musicLibrary, upsertAll } from "./catalog";
import { musicTrack } from "./scanned";
import { allPages, at, musicShelf, onAlbum } from "./shelf";

const stack = coreStackFromEnvFile();

/** Convex's per-call limits (ADR 0013). */
const READS_MAX = 32_000;

const READ_BYTES_MAX = 16 * 1024 * 1024;

const WRITES_MAX = 16_000;

/** The most documents one access-checked list page reads (`PAGE_ROWS_MAX`, ADR 0005). */
const PAGE_READS_MAX = 1000;

const withinLimits = (usage: ReadonlyArray<CallUsage>): boolean =>
  usage.length > 0 &&
  usage.every(
    (call) =>
      call.committed &&
      call.reads < READS_MAX &&
      call.bytes < READ_BYTES_MAX &&
      call.writes < WRITES_MAX,
  );

/** Libraries a wide reach spreads its songs over: more than one call decides at once. */
const WIDE_LIBRARIES = 120;

/** Songs each wide library holds, so 59 of them hold 2,000 distinct songs. */
const WIDE_SONGS = 34;

/** Libraries one seed call makes: each song costs the seed a few index ranges. */
const SEEDED_AT_ONCE = 10;

/** The songs a queue or playlist takes at most in one command. */
const SONGS_IN_MAX = 2000;

/** Moves that halve the gap after one entry to just above what a key can split. */
const NARROWING_MOVES = 19;

const pad = (n: number): string => String(n).padStart(4, "0");

/** A person in sixteen groups who sees many libraries directly and through each group. */
interface WideReach {
  readonly viewer: Member;
  /** Every song: the n-th from library n mod 120, so any 120 in a row span every library. */
  readonly songs: ReadonlyArray<Id<"tracks">>;
  /** The n-th song of library `library`, for inputs over fewer libraries. */
  readonly songOf: (library: number, n: number) => Id<"tracks">;
  /** What every song's title starts with. */
  readonly prefix: string;
}

const wideReaches = new Map<string, Promise<WideReach>>();

const makeWideReach = async (core: CoreStack): Promise<WideReach> => {
  const admin = await sharedAdmin(core);

  const [manager, viewer] = await Promise.all([
    member(core, "wide-manager"),
    member(core, "wide-viewer"),
  ]);

  // `! ` sorts before letters, digits, and `!a`, so these songs come first in every title order.
  const prefix = `! wide ${unique()}`;

  const wanted = Array.from({ length: WIDE_LIBRARIES }, (_, library): MusicLibrary => ({
    name: `${prefix} ${pad(library)}`,
    kind: "music",
    items: Array.from({ length: WIDE_SONGS }, (_song, n) =>
      onAlbum(`${prefix} ${pad(library)}`, `${prefix} ${pad(library)} ${pad(n)}`),
    ),
  }));

  const libraries = (
    await inOrder(
      Array.from({ length: WIDE_LIBRARIES / SEEDED_AT_ONCE }, (_, n) => n),
      async (n) =>
        seedLibraries(core, manager, wanted.slice(n * SEEDED_AT_ONCE, (n + 1) * SEEDED_AT_ONCE)),
    )
  ).flat();

  await shareThroughEveryGroup(
    admin,
    manager,
    viewer,
    libraries.map((library) => library.libraryId),
  );

  await viewer.signedIn.client.mutation(api.music.queue.autoplay, { on: false });

  const songOf = (library: number, n: number): Id<"tracks"> =>
    at(at(libraries, library).itemIds, n);

  return {
    viewer,
    songs: Array.from({ length: WIDE_LIBRARIES * WIDE_SONGS }, (_, n) =>
      songOf(n % WIDE_LIBRARIES, Math.floor(n / WIDE_LIBRARIES)),
    ),
    songOf,
    prefix,
  };
};

/** One wide reach per stack, which the tests below share. */
const wideReach = (core: CoreStack): Promise<WideReach> => {
  const made = wideReaches.get(core.url) ?? makeWideReach(core);

  wideReaches.set(core.url, made);

  return made;
};

/** The ids of `who`'s queue entries, in play order. */
const queued = async (who: Member): Promise<ReadonlyArray<Id<"playQueueEntries">>> =>
  (
    await allPages((cursor) =>
      who.signedIn.client.query(api.music.queue.list, {
        paginationOpts: { numItems: 200, cursor },
      }),
    )
  ).rows.map((entry) => entry.itemId);

/**
 * Moves the last `NARROWING_MOVES` entries one at a time to just after the first, each halving
 * the gap after it, and answers the queue's order afterwards.
 */
const narrowAfterFirst = async (
  who: Member,
  entries: ReadonlyArray<Id<"playQueueEntries">>,
): Promise<ReadonlyArray<Id<"playQueueEntries">>> => {
  const first = at(entries, 0);
  const moved = entries.slice(-NARROWING_MOVES).toReversed();

  await inOrder(moved, async (itemId) =>
    who.signedIn.client.mutation(api.music.queue.move, { itemId, afterItemId: first }),
  );

  return [first, ...moved.toReversed(), ...entries.slice(1, -NARROWING_MOVES)];
};

/**
 * Adds `trackIds` to `who`'s queue as a client does: each call takes what it can, and the songs it
 * leaves go again right after the last entry it added. Answers every entry added and the calls.
 */
const queueAll = async (
  who: Member,
  trackIds: ReadonlyArray<Id<"tracks">>,
  next: boolean,
  after: Id<"playQueueEntries"> | null = null,
  added: ReadonlyArray<Id<"playQueueEntries">> = [],
  calls = 0,
): Promise<{ readonly itemIds: ReadonlyArray<Id<"playQueueEntries">>; readonly calls: number }> => {
  const { itemIds, rest } = await who.signedIn.client.mutation(
    api.music.queue.add,
    after === null
      ? { trackIds: [...trackIds], next }
      : { trackIds: [...trackIds], next, afterItemId: after },
  );

  const all = [...added, ...itemIds];

  return rest.length === 0
    ? { itemIds: all, calls: calls + 1 }
    : queueAll(who, rest, next, all.at(-1) ?? after, all, calls + 1);
};

/** Adds `trackIds` to a playlist, sending what each call leaves again; answers the calls. */
const addAll = async (
  who: Member,
  playlistId: Id<"playlists">,
  trackIds: ReadonlyArray<Id<"tracks">>,
  calls = 0,
): Promise<number> => {
  if (trackIds.length === 0) return calls;

  const { rest } = await who.signedIn.client.mutation(api.music.playlists.addTracks, {
    playlistId,
    trackIds: [...trackIds],
  });

  return addAll(who, playlistId, rest, calls + 1);
};

/** The ids of a playlist's entries, in order. */
const listed = async (
  who: Member,
  playlistId: Id<"playlists">,
): Promise<ReadonlyArray<Id<"playlistItems">>> =>
  (
    await allPages((cursor) =>
      who.signedIn.client.query(api.music.playlists.items, {
        playlistId,
        paginationOpts: { numItems: 200, cursor },
      }),
    )
  ).rows.map((entry) => entry.itemId);

describe.skipIf(stack === undefined)("music command limits", { timeout: 300_000 }, () => {
  it("pages songs whose titles all tie, each exactly once, a bounded page a call", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "ties-admin", "admin");
    const aiko = await member(stack, "ties-aiko");
    const { libraryId, scanJobId, roots } = await musicLibrary(admin, `Ties ${unique()}`);
    const root = at(roots, 0);
    const lease = await claimScan(stack, scanJobId);

    await upsertAll(
      stack,
      lease,
      Array.from({ length: 300 }, (_, n) =>
        musicTrack(`${root}/Same/Same/${n}.flac`, 1000, 1, { title: "Same" }),
      ),
    );
    await finishScan(stack, lease);
    await share(admin, libraryId, { kind: "user", userId: aiko.userId }, "view");

    const mark = await logMark(stack);

    const { rows, calls } = await allPages((cursor) =>
      aiko.signedIn.client.query(api.music.tracks.list, {
        paginationOpts: { numItems: 200, cursor },
      }),
    );

    const same = rows.filter((track) => track.title === "Same" && track.album === "Same");

    expect(same).toHaveLength(300);
    expect(new Set(same.map((track) => track.id)).size).toBe(300);

    const usage = await usageSince(stack, mark, api.music.tracks.list, calls);

    expect(usage.every((call) => call.reads <= PAGE_READS_MAX)).toBe(true);
  });

  it("decides a list for a person in sixteen groups within a page's reads", async () => {
    if (stack === undefined) return;
    const admin = await sharedAdmin(stack);
    const viewer = await member(stack, "groups-viewer");

    const shelf = await musicShelf(
      stack,
      [],
      Array.from({ length: 60 }, (_, n) => onAlbum(`Groups ${n % 6}`, `Grouped ${n}`)),
    );

    await shareThroughEveryGroup(admin, shelf.manager, viewer, [shelf.library.libraryId]);

    const mark = await logMark(stack);

    const { rows, calls } = await allPages((cursor) =>
      viewer.signedIn.client.query(api.music.tracks.list, {
        paginationOpts: { numItems: 200, cursor },
      }),
    );

    const ours = new Set<string>(shelf.library.itemIds);

    expect(rows.filter((track) => ours.has(track.id))).toHaveLength(60);

    const usage = await usageSince(stack, mark, api.music.tracks.list, calls);

    expect(usage.every((call) => call.reads <= PAGE_READS_MAX)).toBe(true);
  });

  it("takes 2,000 songs into the queue and a playlist in one call within Convex's limits", async () => {
    if (stack === undefined) return;
    const aiko = await member(stack, "limits-aiko");

    const shelf = await musicShelf(
      stack,
      [aiko],
      Array.from({ length: 100 }, (_, n) => onAlbum(`Limits ${n % 10}`, `Limit ${n}`)),
    );

    const many = Array.from({ length: 2000 }, (_, n) => at(shelf.library.itemIds, n % 100));
    const mark = await logMark(stack);

    // As old music's `playOrder`: a list longer than the queue keeps 1,000 songs from the chosen one.
    await aiko.signedIn.client.mutation(api.music.queue.play, { trackIds: many, index: 0 });

    expect((await aiko.signedIn.client.query(api.music.queue.get, {})).count).toBe(1000);

    const { playlistId } = await aiko.signedIn.client.mutation(api.music.playlists.create, {
      name: "Two thousand",
      trackIds: many,
    });

    expect(
      (await aiko.signedIn.client.query(api.music.playlists.get, { playlistId })).trackCount,
    ).toBe(2000);
    expect(withinLimits(await usageSince(stack, mark, api.music.queue.play, 1))).toBe(true);
    expect(withinLimits(await usageSince(stack, mark, api.music.playlists.create, 1))).toBe(true);
  });
  it("adds next to a 999-entry queue whose gap closed, for a person in sixteen groups with 2,000 songs from 59 libraries", async () => {
    if (stack === undefined) return;
    const { viewer, songOf } = await wideReach(stack);
    const client = viewer.signedIn.client;

    // The queue's own songs come from one library: playing takes every song it is given or none.
    await client.mutation(api.music.queue.play, {
      trackIds: Array.from({ length: 999 }, (_, n) => songOf(0, n % WIDE_SONGS)),
    });

    const order = await narrowAfterFirst(viewer, await queued(viewer));

    const input = Array.from({ length: SONGS_IN_MAX }, (_, n) =>
      songOf(n % 59, Math.floor(n / 59)),
    );

    const mark = await logMark(stack);

    // The queue holds 1,000 entries, so one song joins, and the 999 entries renumber around it.
    const { itemIds, calls } = await queueAll(viewer, input, true);

    expect(itemIds).toHaveLength(1);
    expect(await queued(viewer)).toEqual([at(order, 0), ...itemIds, ...order.slice(1)]);
    expect((await client.query(api.music.queue.get, {})).count).toBe(1000);
    expect(withinLimits(await usageSince(stack, mark, api.music.queue.add, calls))).toBe(true);
  });

  it("renumbers a queue whose gap closed, then takes songs from 120 libraries a call at a time", async () => {
    if (stack === undefined) return;
    const { viewer, songs, songOf } = await wideReach(stack);
    const client = viewer.signedIn.client;

    await client.mutation(api.music.queue.play, {
      trackIds: Array.from({ length: 500 }, (_, n) => songOf(1, n % WIDE_SONGS)),
    });

    const order = await narrowAfterFirst(viewer, await queued(viewer));
    const input = songs.slice(0, SONGS_IN_MAX);
    const mark = await logMark(stack);
    const { itemIds, calls } = await queueAll(viewer, input, true);

    // 500 songs fill the queue; deciding 120 libraries for each of seventeen grants costs more
    // than one call can spend beside them, so the call leaves the rest for the next.
    expect(calls).toBeGreaterThan(1);
    expect(itemIds).toHaveLength(500);
    expect(await queued(viewer)).toEqual([at(order, 0), ...itemIds, ...order.slice(1)]);

    const added = await allPages((cursor) =>
      client.query(api.music.queue.list, { paginationOpts: { numItems: 200, cursor } }),
    );

    expect(added.rows.slice(1, 501).map((entry) => entry.track.id)).toEqual(input.slice(0, 500));
    expect(withinLimits(await usageSince(stack, mark, api.music.queue.add, calls))).toBe(true);
  });

  it("adds 2,000 songs from 120 libraries to a playlist a call at a time, and renumbers it whole on a move", async () => {
    if (stack === undefined) return;
    const { viewer, songs } = await wideReach(stack);
    const client = viewer.signedIn.client;
    const input = songs.slice(0, SONGS_IN_MAX);
    const mark = await logMark(stack);

    const { playlistId, rest } = await client.mutation(api.music.playlists.create, {
      name: "Wide",
      trackIds: [...input],
    });

    const calls = await addAll(viewer, playlistId, rest);

    expect(rest.length).toBeGreaterThan(0);
    expect((await client.query(api.music.playlists.get, { playlistId })).trackCount).toBe(2000);

    const entries = await listed(viewer, playlistId);

    const tracks = await allPages((cursor) =>
      client.query(api.music.playlists.items, {
        playlistId,
        paginationOpts: { numItems: 200, cursor },
      }),
    );

    expect(tracks.rows.map((entry) => entry.track?.id)).toEqual(input);

    // Twenty moves after the first entry halve the gap after it past what a key can split; the
    // twenty-first renumbers all 2,000 entries.
    const first = at(entries, 0);
    const moved = entries.slice(-21).toReversed();

    await inOrder(moved, async (itemId) =>
      client.mutation(api.music.playlists.moveItem, { playlistId, itemId, afterItemId: first }),
    );

    expect(await listed(viewer, playlistId)).toEqual([
      first,
      ...moved.toReversed(),
      ...entries.slice(1, -21),
    ]);
    expect(withinLimits(await usageSince(stack, mark, api.music.playlists.create, 1))).toBe(true);
    expect(withinLimits(await usageSince(stack, mark, api.music.playlists.addTracks, calls))).toBe(
      true,
    );
    expect(withinLimits(await usageSince(stack, mark, api.music.playlists.moveItem, 21))).toBe(
      true,
    );
  });

  it("pages songs exactly once in order for a person who sees more libraries than a page merges", async () => {
    if (stack === undefined) return;
    const { viewer, songs, prefix } = await wideReach(stack);
    const mark = await logMark(stack);

    // These songs sort first, so the household-wide index reaches them within the first pages
    // however many songs other tests left: read until every one came, then one page more.
    const ourPages = async (
      cursor: string | null = null,
      rows: ReadonlyArray<{ readonly id: string; readonly title: string }> = [],
      calls = 0,
    ): Promise<{
      readonly rows: typeof rows;
      readonly after: typeof rows;
      readonly calls: number;
    }> => {
      const page = await viewer.signedIn.client.query(api.music.tracks.list, {
        paginationOpts: { numItems: 200, cursor },
      });

      const seen = [...rows, ...page.page.filter((track) => track.title.startsWith(prefix))];

      if (seen.length < songs.length && !page.isDone) {
        return ourPages(page.continueCursor, seen, calls + 1);
      }

      const next = page.isDone
        ? { page: [] }
        : await viewer.signedIn.client.query(api.music.tracks.list, {
            paginationOpts: { numItems: 200, cursor: page.continueCursor },
          });

      return {
        rows: seen,
        after: next.page.filter((track) => track.title.startsWith(prefix)),
        calls: calls + (page.isDone ? 1 : 2),
      };
    };

    const { rows: ours, after, calls } = await ourPages();
    const titles = ours.map((track) => track.title.toLowerCase());

    expect(ours).toHaveLength(songs.length);
    expect(after).toEqual([]);
    expect(new Set(ours.map((track) => track.id)).size).toBe(songs.length);
    expect(titles).toEqual(titles.toSorted());
    expect(withinLimits(await usageSince(stack, mark, api.music.tracks.list, calls))).toBe(true);
  });
});
