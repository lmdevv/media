import { v } from "convex/values";

import { leaseAnswer } from "../core/jobs/held";
import { lease } from "../core/jobs/model";
import type { Lease } from "../core/jobs/model";
import type { JobCtx } from "../core/jobs/store";
import { paginate } from "../core/lib/paginate";
import { serverMutation } from "../core/lib/serverFacing";
import { withScanLease } from "../core/scans";
import type { HeldScan } from "../core/scans";
import { pathFits } from "../movies/bounds";
import { cost, meterFrom } from "./budget";
import { catalogBatch } from "./catalog";
import type { CatalogBatch } from "./catalog";
import { DOCUMENT_BYTES } from "./fit";
import { knownTrack, scannedLyrics, scannedTrack } from "./validators";
import { musicStore } from "./write";

/**
 * The most files, moves, or paths one call takes as arguments. How many of them it writes is the
 * call's budget's to decide (`budget.ts`): it writes the leading ones whose worst case fits and
 * answers how many (`done`), and the server sends the rest again (ADR 0024).
 */
const BATCH_MAX = 500;

/**
 * A scanner call's own work, charged before its first item: the lease check, the library, its
 * folders and claims, its item count, and its totals at the end (`MusicStore.moveTotals`).
 */
const FIXED_COST = cost(30, 12, 64 * 1024, 4 * 1024);

/**
 * Tracks one `known` call reads: as many as 12 MiB holds at the track bound, so a page of tracks
 * with long names never reads past Convex's 16 MiB.
 */
const KNOWN_PAGE = Math.floor((12 * 1024 * 1024) / DOCUMENT_BYTES.tracks);

const checkBatch = (count: number): void => {
  if (count > BATCH_MAX) throw new Error(`A batch holds at most ${BATCH_MAX} files; got ${count}`);
};

/** Answers what a scanner write's batch settled: the tracks it put on and took off the disk. */
const scanWrite = <Value>(
  ctx: JobCtx,
  held: Lease,
  write: (
    batch: CatalogBatch,
    scan: HeldScan,
  ) => Promise<(released: ReadonlyArray<string>) => Value>,
) =>
  withScanLease(ctx, "music", held, async (scan) => {
    const batch = catalogBatch(musicStore(ctx.db, meterFrom(FIXED_COST)), scan.library._id);
    const answer = await write(batch, scan);
    const settled = await batch.finish();

    return { ...settled, value: answer(settled.value) };
  });

/**
 * A page of the tracks the library lists inside its folders now, missing ones included, from
 * `cursor`, with what a scan compares to skip unchanged files and find moved and missing ones.
 * Fingerprints come back as stored: a file without folder artwork has null, and one over 1,024
 * characters is kept as `uniqueWithin` makes it (`fit.ts`), so the server compares its own
 * through the same bound.
 * `from` and `to` bound the page to paths from `from` up to `to`, so the server can read ranges of
 * a large library side by side, as old music's `fingerprints` did. Rows of a removed folder are
 * the purge's to delete.
 */
export const known = serverMutation({
  args: {
    lease,
    cursor: v.union(v.string(), v.null()),
    from: v.optional(v.string()),
    to: v.optional(v.string()),
  },
  returns: leaseAnswer(
    v.object({ files: v.array(knownTrack), continueCursor: v.string(), isDone: v.boolean() }),
  ),
  handler: (ctx, { lease: held, cursor, from, to }) =>
    withScanLease(ctx, "music", held, async (scan) => {
      const found = await paginate(
        ctx.db,
        {
          table: "tracks",
          index: "by_library_path",
          range: (q) => {
            const library = q.eq("libraryId", scan.library._id);
            const lower = from === undefined ? library : library.gte("path", from);

            return to === undefined ? lower : lower.lt("path", to);
          },
        },
        { numItems: KNOWN_PAGE, cursor },
      );

      return {
        value: {
          files: found.page
            .filter((track) => scan.keeps(track.path))
            .map((track) => ({
              path: track.path,
              size: track.size,
              mtimeMs: track.mtimeMs,
              missing: track.missing,
              folderArt: track.folderArt,
              lyricsFiles: track.lyricsFiles,
              lyricsReader: track.lyricsReader,
              lyricsBytes: track.lyricsBytes,
              durationMs: track.durationMs,
              title: track.title,
              artist: track.artistName,
              album: track.albumTitle,
            })),
          continueCursor: found.continueCursor,
          isDone: found.isDone,
        },
        added: 0,
        removed: 0,
      };
    }),
});

/**
 * Writes the leading files of up to 500 a scan found, in order, each with its album, artist, and
 * own lyrics, as many as the call's budget admits, and answers how many it got through (`done`).
 * A path sent twice in one batch is written twice, the last one winning. `released` lists the
 * artwork the batch stopped using somewhere, for the server to check with `music/art:inUse`.
 */
export const upsert = serverMutation({
  args: { lease, tracks: v.array(scannedTrack) },
  returns: leaseAnswer(v.object({ done: v.number(), released: v.array(v.string()) })),
  handler: (ctx, { lease: held, tracks }) =>
    scanWrite(ctx, held, async (batch, scan) => {
      checkBatch(tracks.length);
      scan.admit(tracks.map((track) => track.path));

      // A path over the filesystem's limit names no real file: it counts as done, writing nothing.
      const landed = await batch.each(tracks, async (track) =>
        pathFits(track.path) ? batch.upsert(track) : null,
      );

      return (released) => ({ done: landed.length, released: [...released] });
    }),
});

/**
 * Moves the tracks of up to 500 files a scan found at new paths, renamed or moved within the
 * library, keeping each track's id and so what points at it, as many as the call's budget admits.
 * A move whose old path has no track, or whose new path has one already, writes the file as
 * `upsert` does and marks the old path missing. Answers how many it got through and how many
 * moved.
 */
export const move = serverMutation({
  args: { lease, moves: v.array(v.object({ from: v.string(), track: scannedTrack })) },
  returns: leaseAnswer(
    v.object({ done: v.number(), moved: v.number(), released: v.array(v.string()) }),
  ),
  handler: (ctx, { lease: held, moves }) =>
    scanWrite(ctx, held, async (batch, scan) => {
      checkBatch(moves.length);
      scan.admit(moves.flatMap(({ from, track }) => [from, track.path]));

      const landed = await batch.each(moves, async ({ from, track }) =>
        pathFits(from) && pathFits(track.path) ? batch.move(from, track) : false,
      );

      return (released) => ({
        done: landed.length,
        moved: landed.filter(Boolean).length,
        released: [...released],
      });
    }),
});

/**
 * Marks the leading paths of up to 500 missing, as many as the call's budget admits, keeping their
 * rows, so likes and playlists keep pointing at them. Answers how many it got through and how
 * many were newly marked. Repeating a path is harmless.
 */
export const missing = serverMutation({
  args: { lease, paths: v.array(v.string()) },
  returns: leaseAnswer(
    v.object({ done: v.number(), marked: v.number(), released: v.array(v.string()) }),
  ),
  handler: (ctx, { lease: held, paths }) =>
    scanWrite(ctx, held, async (batch, scan) => {
      checkBatch(paths.length);

      const marked = await batch.each(scan.admit(paths), async (path) =>
        pathFits(path) ? batch.markMissing(path) : false,
      );

      return (released) => ({
        done: marked.length,
        marked: marked.filter(Boolean).length,
        released: [...released],
      });
    }),
});

/**
 * Saves the lyrics a scan read again for up to 500 files whose audio did not change, as old
 * music's `saveLocalLyrics` did: a lyric file beside one was added, edited, or removed, or a newer
 * reader reads its lyrics. Only the lyrics and their fingerprint change. A path with no track is
 * skipped. Answers how many it got through and how many it saved.
 */
export const lyrics = serverMutation({
  args: { lease, tracks: v.array(scannedLyrics) },
  returns: leaseAnswer(v.object({ done: v.number(), saved: v.number() })),
  handler: (ctx, { lease: held, tracks }) =>
    scanWrite(ctx, held, async (batch, scan) => {
      checkBatch(tracks.length);
      scan.admit(tracks.map((track) => track.path));

      const saved = await batch.each(tracks, async (track) =>
        pathFits(track.path) ? batch.saveLyrics(track) : false,
      );

      return () => ({ done: saved.length, saved: saved.filter(Boolean).length });
    }),
});
