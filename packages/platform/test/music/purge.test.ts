import { describe, expect, it } from "vitest";

import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { logMark, usageSince } from "../admin";
import { eventually } from "../core/jobs/driver";
import { member } from "../devices";
import { coreStackFromEnvFile } from "../stack-env";
import type { CoreStack } from "../stack-env";
import {
  catalogRowsOf,
  claimScan,
  finishScan,
  hasTotals,
  leftOf,
  musicLibrary,
  purgePage,
  rowsOf,
  setFoldersQuietly,
  totalsOf,
  trackIdsAt,
  upsertAll,
} from "./catalog";
import { musicTrack, plainLyrics } from "./scanned";
import type { ScannedTrack } from "./scanned";

const stack = coreStackFromEnvFile();

/** Convex's per-call limits (ADR 0013). */
const READS_MAX = 32_000;

const WRITES_MAX = 16_000;

const tracksOf = (
  root: string,
  artist: string,
  album: string,
  count: number,
  lyrics = false,
): ReadonlyArray<ScannedTrack> =>
  Array.from({ length: count }, (_, n) =>
    musicTrack(`${root}/${artist}/${album}/${n}.flac`, 1000, 1, {
      artist,
      album,
      durationMs: 1000 + n,
      lyrics: lyrics ? [plainLyrics(`Line ${n}`)] : [],
    }),
  );

const exact = async (core: CoreStack, libraryId: Id<"libraries">): Promise<boolean> => {
  const [rows, totals] = await Promise.all([rowsOf(core, libraryId), totalsOf(core, libraryId)]);

  return (
    rows.tracks === totals.tracks &&
    rows.albums === totals.albums &&
    rows.artists === totals.artists &&
    rows.durationMs === totals.durationMs
  );
};

const idsOf = async (
  core: CoreStack,
  libraryId: Id<"libraries">,
  tracks: ReadonlyArray<ScannedTrack>,
): Promise<ReadonlyArray<Id<"tracks">>> =>
  (
    await trackIdsAt(
      core,
      libraryId,
      tracks.map((track) => track.path),
    )
  ).flatMap((id) => (id === null ? [] : [id]));

describe.skipIf(stack === undefined)("music purge", { timeout: 240_000 }, () => {
  it("purge a removed folder's tracks and lyrics, and the albums and artists they leave", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "folder-purge", "admin");
    const { libraryId, scanJobId, roots } = await musicLibrary(admin, "Two folders", 2);
    const [kept, dropped] = roots;

    if (kept === undefined || dropped === undefined) throw new Error("two folders");

    const keptTracks = [
      ...tracksOf(kept, "Kept", "Stays", 5),
      ...tracksOf(kept, "Shared", "Split", 2),
    ];

    const droppedTracks = [
      ...tracksOf(dropped, "Gone", "Leaves", 4, true),
      ...tracksOf(dropped, "Shared", "Split", 2),
    ];

    const lease = await claimScan(stack, scanJobId);

    await upsertAll(stack, lease, [...keptTracks, ...droppedTracks]);
    await finishScan(stack, lease);

    const droppedIds = await idsOf(stack, libraryId, droppedTracks);

    expect(await leftOf(stack, droppedIds)).toEqual({ tracks: 6, lyrics: 4 });
    expect(await totalsOf(stack, libraryId)).toMatchObject({ tracks: 13, albums: 3, artists: 3 });

    await admin.signedIn.client.mutation(api.core.libraries.setFolders, {
      libraryId,
      folders: [kept],
    });

    await eventually("the dropped folder's tracks to leave", async () =>
      (await leftOf(stack, droppedIds)).tracks === 0 ? true : null,
    );

    expect(await leftOf(stack, droppedIds)).toEqual({ tracks: 0, lyrics: 0 });
    expect(await exact(stack, libraryId)).toBe(true);
    expect(await totalsOf(stack, libraryId)).toMatchObject({ tracks: 7, albums: 2, artists: 2 });
    expect(await catalogRowsOf(stack, libraryId)).toEqual({ albums: 2, artists: 2 });
  });

  it("purge a removed library in pages, then its albums, artists, and totals", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "library-purge", "admin");
    const { libraryId, scanJobId, roots } = await musicLibrary(admin, "Removed");
    const [root] = roots;

    if (root === undefined) throw new Error("one folder");

    const tracks = Array.from({ length: 40 }, (_, n) =>
      tracksOf(root, `Artist ${n % 20}`, `Album ${n}`, 20, n % 4 === 0),
    ).flat();

    const lease = await claimScan(stack, scanJobId);

    await upsertAll(stack, lease, tracks);
    await finishScan(stack, lease);

    const ids = await idsOf(stack, libraryId, tracks);

    expect(ids).toHaveLength(800);
    expect(await totalsOf(stack, libraryId)).toMatchObject({
      tracks: 800,
      albums: 40,
      artists: 20,
    });

    const mark = await logMark(stack);

    await admin.signedIn.client.mutation(api.core.libraries.remove, { libraryId });

    await eventually("the purge to finish", async () =>
      (await hasTotals(stack, libraryId)) ? null : true,
    );

    expect(await leftOf(stack, ids)).toEqual({ tracks: 0, lyrics: 0 });
    expect(await catalogRowsOf(stack, libraryId)).toEqual({ albums: 0, artists: 0 });

    const pages = await usageSince(stack, mark, internal.music.purge.tracks, 3);
    const committed = pages.filter((call) => call.committed);

    expect(committed.length).toBeGreaterThanOrEqual(3);
    expect(committed.every((call) => call.reads < READS_MAX && call.writes < WRITES_MAX)).toBe(
      true,
    );
  });

  it("stop a purge page on its budget, go on from the same page, and stay exact", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "budget-purge", "admin");
    const { libraryId, scanJobId, roots } = await musicLibrary(admin, "Budget", 2);
    const [kept, dropped] = roots;

    if (kept === undefined || dropped === undefined) throw new Error("two folders");

    const lease = await claimScan(stack, scanJobId);

    await upsertAll(stack, lease, [
      ...tracksOf(kept, "Stays", "Stays", 3),
      ...Array.from({ length: 6 }, (_, n) =>
        tracksOf(dropped, "Goes", `Goes ${n}`, 10, true),
      ).flat(),
    ]);
    await finishScan(stack, lease);
    await setFoldersQuietly(stack, libraryId, [kept]);

    const pageAll = async (
      cursor: string | null,
      calls = 0,
    ): Promise<{ readonly calls: number; readonly exactEach: boolean }> => {
      const next = await purgePage(stack, libraryId, "tracks", cursor, 80);
      const exactNow = await exact(stack, libraryId);

      if (!exactNow) return { calls: calls + 1, exactEach: false };

      return next.more ? pageAll(next.cursor, calls + 1) : { calls: calls + 1, exactEach: true };
    };

    const walked = await pageAll(null);

    expect(walked.exactEach).toBe(true);
    expect(walked.calls).toBeGreaterThan(1);
    expect(await totalsOf(stack, libraryId)).toMatchObject({ tracks: 3, albums: 1, artists: 1 });
    expect(await catalogRowsOf(stack, libraryId)).toEqual({ albums: 1, artists: 1 });
  });
});
