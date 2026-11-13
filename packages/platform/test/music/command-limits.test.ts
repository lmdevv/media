import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import { logMark, usageSince } from "../admin";
import type { CallUsage } from "../admin";
import { member, sharedAdmin } from "../devices";
import { share, shareThroughEveryGroup } from "../probe";
import { unique } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";
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
    (call) => call.reads < READS_MAX && call.bytes < READ_BYTES_MAX && call.writes < WRITES_MAX,
  );

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
});
