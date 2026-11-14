import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import { inOrder } from "../../convex/core/lib/inOrder";
import type { Id } from "../../convex/_generated/dataModel";
import { member } from "../devices";
import type { Member } from "../devices";
import { sessionOf, share } from "../probe";
import { refusal, signInAs, unique } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";
import type { CoreStack } from "../stack-env";
import { claimScan, finishScan, markMissing, musicLibrary, trackIdsAt, upsert } from "./catalog";
import { musicTrack } from "./scanned";
import { allPages, at, musicShelf, onAlbum, trackAt } from "./shelf";

const stack = coreStackFromEnvFile();

const SONGS = Array.from({ length: 12 }, (_, n) =>
  onAlbum(`Queue Album ${n % 3}`, `Song ${String(n).padStart(2, "0")}`),
);

type Entry = { readonly itemId: Id<"playQueueEntries">; readonly title: string };

const entriesOf = async (who: Member): Promise<ReadonlyArray<Entry>> =>
  (
    await allPages((cursor) =>
      who.signedIn.client.query(api.music.queue.list, { paginationOpts: { numItems: 5, cursor } }),
    )
  ).rows.map((entry) => ({ itemId: entry.itemId, title: entry.track.title }));

const titlesOf = async (who: Member): Promise<ReadonlyArray<string>> =>
  (await entriesOf(who)).map((entry) => entry.title);

/** The same person signed in a second time: another session of theirs. */
const secondSession = async (core: CoreStack, who: Member): Promise<Member> => ({
  ...(await sessionOf(await signInAs(core, who.person))),
  person: who.person,
});

describe.skipIf(stack === undefined)("music queue", { timeout: 240_000 }, () => {
  it("plays, adds next and last, moves, removes, jumps, and clears, as old music's queue did", async () => {
    if (stack === undefined) return;
    const aiko = await member(stack, "aiko");
    const shelf = await musicShelf(stack, [aiko], SONGS);
    const client = aiko.signedIn.client;

    await client.mutation(api.music.queue.autoplay, { on: false });

    const { current } = await client.mutation(api.music.queue.play, {
      trackIds: [trackAt(shelf, 0), trackAt(shelf, 1), trackAt(shelf, 2)],
      index: 1,
    });

    expect(await titlesOf(aiko)).toEqual(["Song 00", "Song 01", "Song 02"]);
    expect(await client.query(api.music.queue.get, {})).toEqual({
      current,
      count: 3,
      shuffle: false,
      repeat: "off",
      autoplay: false,
    });

    await client.mutation(api.music.queue.add, { trackIds: [trackAt(shelf, 3)], next: true });
    await client.mutation(api.music.queue.add, {
      trackIds: [trackAt(shelf, 4), trackAt(shelf, 5)],
    });

    expect(await titlesOf(aiko)).toEqual([
      "Song 00",
      "Song 01",
      "Song 03",
      "Song 02",
      "Song 04",
      "Song 05",
    ]);

    const entries = await entriesOf(aiko);
    const first = at(entries, 0).itemId;
    const third = at(entries, 2).itemId;
    const sixth = at(entries, 5).itemId;

    await client.mutation(api.music.queue.move, { itemId: sixth });
    await client.mutation(api.music.queue.move, { itemId: first, afterItemId: third });

    expect(await titlesOf(aiko)).toEqual([
      "Song 05",
      "Song 01",
      "Song 03",
      "Song 00",
      "Song 02",
      "Song 04",
    ]);

    // Removing the entry playing moves playback to the one after it.
    await client.mutation(api.music.queue.remove, { itemId: current });

    expect((await client.query(api.music.queue.get, {})).current).toBe(third);
    expect(await refusal(client.mutation(api.music.queue.jump, { itemId: current }))).toBe(
      "not_found",
    );

    await client.mutation(api.music.queue.jump, { itemId: first });
    await client.mutation(api.music.queue.clear, {});

    expect(await titlesOf(aiko)).toEqual(["Song 05", "Song 03", "Song 00"]);
    expect((await client.query(api.music.queue.get, {})).count).toBe(3);
  });

  it("plays next after the current song, renumbering when the gap after it closes", async () => {
    if (stack === undefined) return;
    const aiko = await member(stack, "aiko");
    const shelf = await musicShelf(stack, [aiko], SONGS);
    const client = aiko.signedIn.client;

    await client.mutation(api.music.queue.autoplay, { on: false });

    const { current } = await client.mutation(api.music.queue.play, {
      trackIds: [trackAt(shelf, 0), trackAt(shelf, 1), trackAt(shelf, 2)],
    });

    // The song playing moves between the other two, so its key is no longer a whole step.
    await client.mutation(api.music.queue.move, {
      itemId: current,
      afterItemId: at(await entriesOf(aiko), 1).itemId,
    });

    // Each song played next goes right after the current one: thirty halve the gap after it past
    // what a key can split, so the queue renumbers on the way.
    await inOrder(
      Array.from({ length: 30 }, (_, n) => n),
      async (n) =>
        client.mutation(api.music.queue.add, {
          trackIds: [trackAt(shelf, 3 + (n % 9))],
          next: true,
        }),
    );

    const titles = await titlesOf(aiko);

    const added = Array.from(
      { length: 30 },
      (_, n) => `Song ${String(3 + ((29 - n) % 9)).padStart(2, "0")}`,
    );

    expect(titles).toEqual(["Song 01", "Song 00", ...added, "Song 02"]);
    expect((await client.query(api.music.queue.get, {})).current).toBe(current);
  });

  it("shuffles behind the current song and restores the order when shuffle turns off", async () => {
    if (stack === undefined) return;
    const aiko = await member(stack, "aiko");
    const shelf = await musicShelf(stack, [aiko], SONGS);
    const client = aiko.signedIn.client;
    const listed = SONGS.map((song) => song.name);

    await client.mutation(api.music.queue.autoplay, { on: false });
    await client.mutation(api.music.queue.play, { trackIds: [...shelf.library.itemIds], index: 4 });
    await client.mutation(api.music.queue.shuffle, { on: true });

    const shuffled = await titlesOf(aiko);

    expect(shuffled[0]).toBe("Song 04");
    expect(shuffled.toSorted()).toEqual(listed);

    await client.mutation(api.music.queue.add, { trackIds: [trackAt(shelf, 0)], next: true });
    await client.mutation(api.music.queue.shuffle, { on: false });

    const restored = await titlesOf(aiko);

    expect(restored).toEqual([...listed.slice(0, 5), "Song 00", ...listed.slice(5)]);
    expect((await client.query(api.music.queue.get, {})).shuffle).toBe(false);
  });

  it("keeps every entry exactly once when two sessions add, move, and remove at once", async () => {
    if (stack === undefined) return;
    const aiko = await member(stack, "aiko");
    const other = await secondSession(stack, aiko);
    const shelf = await musicShelf(stack, [aiko], SONGS);

    await aiko.signedIn.client.mutation(api.music.queue.autoplay, { on: false });
    await aiko.signedIn.client.mutation(api.music.queue.play, {
      trackIds: [trackAt(shelf, 0), trackAt(shelf, 1)],
    });

    const sessions = [aiko, other];

    const added = await Promise.all(
      Array.from({ length: 10 }, async (_, n) => {
        const who = at(sessions, n % 2);

        const { itemIds } = await who.signedIn.client.mutation(api.music.queue.add, {
          trackIds: [trackAt(shelf, 2 + n)],
          next: n % 3 === 0,
        });

        return itemIds;
      }),
    );

    const addedIds = added.flat();
    const before = await entriesOf(aiko);

    expect(before).toHaveLength(12);
    expect(new Set(before.map((entry) => entry.itemId)).size).toBe(12);

    const removing = addedIds.slice(0, 3);
    const moving = addedIds.slice(3, 8);

    await Promise.all([
      ...removing.map(async (itemId, n) =>
        at(sessions, n % 2).signedIn.client.mutation(api.music.queue.remove, { itemId }),
      ),
      ...moving.map(async (itemId, n) =>
        at(sessions, (n + 1) % 2).signedIn.client.mutation(api.music.queue.move, {
          itemId,
          afterItemId: at(addedIds, 9),
        }),
      ),
    ]);

    const [seenByOne, seenByOther] = await Promise.all([entriesOf(aiko), entriesOf(other)]);
    const ids = seenByOne.map((entry) => entry.itemId);

    expect(seenByOther).toEqual(seenByOne);
    expect(ids).toHaveLength(9);
    expect(new Set(ids).size).toBe(9);
    expect(ids.filter((id) => removing.includes(id))).toEqual([]);
    expect((await aiko.signedIn.client.query(api.music.queue.get, {})).count).toBe(9);
  });

  it("refuses songs the person may not play, and tops the queue up when autoplay is on", async () => {
    if (stack === undefined) return;
    const [aiko, sam] = await Promise.all([member(stack, "aiko"), member(stack, "sam")]);
    const shelf = await musicShelf(stack, [aiko], SONGS);

    expect(
      await refusal(
        sam.signedIn.client.mutation(api.music.queue.play, { trackIds: [trackAt(shelf, 0)] }),
      ),
    ).toBe("not_found");

    await aiko.signedIn.client.mutation(api.music.queue.autoplay, { on: true });
    await aiko.signedIn.client.mutation(api.music.queue.play, { trackIds: [trackAt(shelf, 0)] });

    const queue = await aiko.signedIn.client.query(api.music.queue.list, {
      paginationOpts: { numItems: 50, cursor: null },
    });

    expect(queue.page.length).toBeGreaterThan(1);
    expect(queue.page.slice(1).every((entry) => entry.autoplay)).toBe(true);
    expect(new Set(queue.page.map((entry) => entry.track.id)).size).toBe(queue.page.length);

    await aiko.signedIn.client.mutation(api.music.queue.autoplay, { on: false });

    expect(await titlesOf(aiko)).toEqual(["Song 00"]);
  });

  it("tops the queue up on the last call of an add sent in several, though its songs are all missing", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "queue-missing-admin", "admin");
    const aiko = await member(stack, "aiko-queue-missing");
    const { libraryId, scanJobId, roots } = await musicLibrary(admin, `Queue missing ${unique()}`);

    await share(admin, libraryId, { kind: "user", userId: aiko.userId }, "view");

    const lease = await claimScan(stack, scanJobId);

    const files = Array.from({ length: 6 }, (_, n) =>
      musicTrack(`${at(roots, 0)}/Album/song ${n}`),
    );

    expect(await upsert(stack, lease, files)).toMatchObject({ value: { done: 6 } });
    expect(await markMissing(stack, lease, [at(files, 1).path])).toMatchObject({
      value: { marked: 1 },
    });

    const found = await trackIdsAt(
      stack,
      libraryId,
      files.map((file) => file.path),
    );

    const ids = found.flatMap((id) => (id === null ? [] : [id]));

    expect(ids).toHaveLength(6);

    const client = aiko.signedIn.client;

    // Repeat holds autoplay back, so the queue ends at its one song as an earlier call left it.
    await client.mutation(api.music.queue.repeat, { mode: "one" });
    await client.mutation(api.music.queue.autoplay, { on: true });

    const { current } = await client.mutation(api.music.queue.play, { trackIds: [at(ids, 0)] });

    await client.mutation(api.music.queue.repeat, { mode: "off" });

    expect(await titlesOf(aiko)).toEqual(["song 0"]);
    expect(await refusal(client.mutation(api.music.queue.add, { trackIds: [at(ids, 1)] }))).toBe(
      "not_found",
    );

    // The last call of a continued add names the entry an earlier call added; its song is missing.
    expect(
      await client.mutation(api.music.queue.add, { trackIds: [at(ids, 1)], afterItemId: current }),
    ).toEqual({ itemIds: [], rest: [] });

    const queue = await client.query(api.music.queue.list, {
      paginationOpts: { numItems: 50, cursor: null },
    });

    expect(queue.page.length).toBeGreaterThan(1);
    expect(queue.page.slice(1).every((entry) => entry.autoplay)).toBe(true);
    expect(queue.page.map((entry) => entry.track.id)).not.toContain(at(ids, 1));

    await finishScan(stack, lease);
  });
});
