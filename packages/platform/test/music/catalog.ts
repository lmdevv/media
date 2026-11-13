import { setTimeout as sleep } from "node:timers/promises";

import { Schema } from "effect";

import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { runFunction } from "../admin";
import { retrying } from "../core/jobs/driver";
import { makeTree } from "../core/libraries/files";
import { claimOwnFolders } from "../core/libraries/ownership";
import type { Member } from "../devices";
import { runServer } from "../service";
import type { CoreStack } from "../stack-env";
import type { ScannedLyrics, ScannedTrack } from "./scanned";

// SAFETY: a type predicate, not checked by the compiler. A Convex id is an opaque string, and the
// stack answered this one through a `v.id(...)` validator, which checks it again whenever a test
// sends it back.
const isId =
  <Table extends "jobs" | "tracks" | "albums" | "artists" | "localLyrics">(_table: Table) =>
  (value: unknown): value is Id<Table> =>
    Schema.is(Schema.String)(value);

const JobId = Schema.declare(isId("jobs"));

const TrackId = Schema.declare(isId("tracks"));

const AlbumId = Schema.declare(isId("albums"));

const ArtistId = Schema.declare(isId("artists"));

const LyricsId = Schema.declare(isId("localLyrics"));

export const Lease = Schema.Struct({ jobId: JobId, attempt: Schema.Finite });

export type Lease = typeof Lease.Type;

const answer = <Value extends Schema.Top>(value: Value) =>
  Schema.Union([
    Schema.Struct({ outcome: Schema.Literal("held"), value }),
    Schema.Struct({ outcome: Schema.Literals(["canceled", "lost"]) }),
  ]);

const Claim = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("claimed"), lease: Lease }),
  Schema.Struct({ outcome: Schema.Literal("idle") }),
]);

const Released = Schema.Array(Schema.String);

export const Written = answer(Schema.Struct({ done: Schema.Finite, released: Released }));

const Moved = answer(
  Schema.Struct({ done: Schema.Finite, moved: Schema.Finite, released: Released }),
);

const Marked = answer(
  Schema.Struct({ done: Schema.Finite, marked: Schema.Finite, released: Released }),
);

export const Saved = answer(Schema.Struct({ done: Schema.Finite, saved: Schema.Finite }));

const KnownFile = Schema.Struct({
  path: Schema.String,
  size: Schema.Finite,
  mtimeMs: Schema.Finite,
  missing: Schema.Boolean,
  folderArt: Schema.NullOr(Schema.String),
  lyricsFiles: Schema.String,
  lyricsReader: Schema.Finite,
  lyricsBytes: Schema.NullOr(Schema.Finite),
  durationMs: Schema.Finite,
  title: Schema.String,
  artist: Schema.String,
  album: Schema.String,
});

export type KnownFile = typeof KnownFile.Type;

const Known = answer(
  Schema.Struct({
    files: Schema.Array(KnownFile),
    continueCursor: Schema.String,
    isDone: Schema.Boolean,
  }),
);

export const Totals = Schema.Struct({
  tracks: Schema.Finite,
  albums: Schema.Finite,
  artists: Schema.Finite,
  durationMs: Schema.Finite,
});

export type Totals = typeof Totals.Type;

const RowsPage = Schema.Struct({
  rows: Schema.Finite,
  present: Schema.Finite,
  durationMs: Schema.Finite,
  albumIds: Schema.Array(AlbumId),
  artistIds: Schema.Array(ArtistId),
  continueCursor: Schema.String,
  isDone: Schema.Boolean,
});

const TrackState = Schema.NullOr(
  Schema.Struct({
    path: Schema.String,
    albumId: AlbumId,
    artistId: ArtistId,
    missing: Schema.Boolean,
    explicit: Schema.Boolean,
    artHash: Schema.NullOr(Schema.String),
    lyricsBytes: Schema.NullOr(Schema.Finite),
    lyricsHash: Schema.NullOr(Schema.String),
  }),
);

/** A music library on new empty folders, made by `admin`, and the scan its creation queued. */
export const musicLibrary = async (
  admin: Member,
  name: string,
  folders = 1,
): Promise<{
  readonly libraryId: Id<"libraries">;
  readonly scanJobId: Id<"jobs">;
  readonly roots: ReadonlyArray<string>;
}> => {
  const roots = await Promise.all(Array.from({ length: folders }, async () => makeTree([])));

  const { libraryId, scanJobId } = await admin.signedIn.client.mutation(api.core.libraries.create, {
    name,
    kind: "music",
    folders: [...roots],
  });

  return { libraryId, scanJobId, roots };
};

/**
 * Claims the music scan `jobId` as the stack's media server, with a lease of `leaseMs`, and claims
 * its folders, as the server does before any write. Another music scan it claims first it fails
 * for good at once, which frees its slot, so a leftover of an earlier test never blocks it.
 */
export const claimScan = async (
  stack: CoreStack,
  jobId: Id<"jobs">,
  leaseMs = 60_000,
  deadline = Date.now() + 120_000,
): Promise<Lease> => {
  const claim = await retrying(() =>
    runServer(
      stack,
      api.core.jobs.worker.claim,
      { kinds: ["music.scan"], workerId: `music-${jobId}`, leaseMs },
      Claim,
    ),
  );

  if (claim.outcome === "claimed" && claim.lease.jobId === jobId) {
    await claimOwnFolders(stack, "music", claim.lease);

    return claim.lease;
  }

  if (Date.now() > deadline) throw new Error(`Timed out waiting for a claim of ${jobId}`);

  if (claim.outcome === "claimed") {
    await retrying(() =>
      runServer(
        stack,
        api.core.jobs.worker.finish,
        {
          lease: claim.lease,
          end: { outcome: "failed", error: "left by another test", retry: false },
        },
        Schema.Struct({ outcome: Schema.String }),
      ),
    );
  } else {
    await sleep(250);
  }

  return claimScan(stack, jobId, leaseMs, deadline);
};

/** Ends a held scan as succeeded, which frees its slot for the next test's claim. */
export const finishScan = (stack: CoreStack, lease: Lease) =>
  retrying(() =>
    runServer(
      stack,
      api.core.jobs.worker.finish,
      { lease, end: { outcome: "succeeded" } },
      Schema.Struct({ outcome: Schema.String }),
    ),
  );

/** Writes up to 500 scanned files under the scan lease. */
export const upsert = (stack: CoreStack, lease: Lease, tracks: ReadonlyArray<ScannedTrack>) =>
  retrying(() =>
    runServer(stack, api.music.scanner.upsert, { lease, tracks: [...tracks] }, Written),
  );

/** Marks up to 500 paths missing under the scan lease. */
export const markMissing = (stack: CoreStack, lease: Lease, paths: ReadonlyArray<string>) =>
  retrying(() => runServer(stack, api.music.scanner.missing, { lease, paths: [...paths] }, Marked));

/** The most files, moves, or paths one scanner call takes as arguments. */
const SCANNER_BATCH = 500;

/**
 * Sends `items` as the server does: up to 500 a call, and what a call's budget left again, until
 * every item went through. Answers how many items each call got through, and every released hash.
 */
const sendAll = async <Item, Value extends { readonly done: number }>(
  items: ReadonlyArray<Item>,
  send: (
    batch: ReadonlyArray<Item>,
  ) => Promise<{ readonly outcome: string; readonly value?: Value }>,
  done: ReadonlyArray<Value> = [],
): Promise<ReadonlyArray<Value>> => {
  const batch = items.slice(0, SCANNER_BATCH);

  if (batch.length === 0) return done;

  const sent = await send(batch);

  if (sent.outcome !== "held" || sent.value === undefined) {
    throw new Error(`a scanner call answered ${sent.outcome}`);
  }

  if (sent.value.done < 1) throw new Error("a scanner call got through nothing");

  return sendAll(items.slice(sent.value.done), send, [...done, sent.value]);
};

/** `upsert` for any number of files, as the server sends them. */
export const upsertAll = (stack: CoreStack, lease: Lease, tracks: ReadonlyArray<ScannedTrack>) =>
  sendAll(tracks, (batch) => upsert(stack, lease, batch));

/** `lyrics` for any number of files whose audio did not change, as the server sends them. */
export const saveLyricsAll = (
  stack: CoreStack,
  lease: Lease,
  files: ReadonlyArray<ScannedLyrics>,
) =>
  sendAll(files, (batch) =>
    retrying(() =>
      runServer(stack, api.music.scanner.lyrics, { lease, tracks: [...batch] }, Saved),
    ),
  );

/** `markMissing` for any number of paths, as the server sends them. */
export const markMissingAll = (stack: CoreStack, lease: Lease, paths: ReadonlyArray<string>) =>
  sendAll(paths, (batch) => markMissing(stack, lease, batch));

/** Moves of any number of files, as the server sends them. */
export const moveAll = (
  stack: CoreStack,
  lease: Lease,
  moves: ReadonlyArray<{ readonly from: string; readonly track: ScannedTrack }>,
) =>
  sendAll(moves, (batch) =>
    retrying(() => runServer(stack, api.music.scanner.move, { lease, moves: [...batch] }, Moved)),
  );

/** Every file the library knows inside its folders, page by page. */
export const knownFiles = async (
  stack: CoreStack,
  lease: Lease,
  cursor: string | null = null,
  seen: ReadonlyArray<KnownFile> = [],
): Promise<ReadonlyArray<KnownFile>> => {
  const page = await runServer(stack, api.music.scanner.known, { lease, cursor }, Known);

  if (page.outcome !== "held") throw new Error(`known answered ${page.outcome}`);

  const next = [...seen, ...page.value.files];

  return page.value.isDone ? next : knownFiles(stack, lease, page.value.continueCursor, next);
};

/** A library's totals as its counters hold them. */
export const totalsOf = (stack: CoreStack, libraryId: Id<"libraries">): Promise<Totals> =>
  runFunction(stack, internal.music.probe.counted, { libraryId }, Totals);

/**
 * A library's totals recounted from its track rows one page at a time: tracks on disk, the albums
 * and artists they file under, and their length; and how many track rows it has in all.
 */
export const rowsOf = async (
  stack: CoreStack,
  libraryId: Id<"libraries">,
): Promise<Totals & { readonly rows: number }> => {
  const albums = new Set<string>();
  const artists = new Set<string>();

  const walk = async (
    cursor: string | null,
    sum: { readonly rows: number; readonly tracks: number; readonly durationMs: number },
  ): Promise<typeof sum> => {
    const page = await runFunction(
      stack,
      internal.music.probe.rows,
      { libraryId, cursor },
      RowsPage,
    );

    for (const id of page.albumIds) albums.add(id);

    for (const id of page.artistIds) artists.add(id);

    const next = {
      rows: sum.rows + page.rows,
      tracks: sum.tracks + page.present,
      durationMs: sum.durationMs + page.durationMs,
    };

    return page.isDone ? next : walk(page.continueCursor, next);
  };

  const counted = await walk(null, { rows: 0, tracks: 0, durationMs: 0 });

  return { ...counted, albums: albums.size, artists: artists.size };
};

/** How many album and artist rows a library holds. */
export const catalogRowsOf = (stack: CoreStack, libraryId: Id<"libraries">) =>
  runFunction(
    stack,
    internal.music.probe.catalogRows,
    { libraryId },
    Schema.Struct({ albums: Schema.Finite, artists: Schema.Finite }),
  );

/** Whether any shard of the library's track, album, artist, or duration totals is left. */
export const hasTotals = (stack: CoreStack, libraryId: Id<"libraries">): Promise<boolean> =>
  runFunction(stack, internal.music.probe.hasTotals, { libraryId }, Schema.Boolean);

/** A track as a test checks it, or null once it is gone. */
export const trackState = (stack: CoreStack, trackId: Id<"tracks">) =>
  runFunction(stack, internal.music.probe.track, { trackId }, TrackState);

/** A library's track ids at `paths`, null where it has none. */
export const trackIdsAt = (
  stack: CoreStack,
  libraryId: Id<"libraries">,
  paths: ReadonlyArray<string>,
) =>
  runFunction(
    stack,
    internal.music.probe.trackIdsAt,
    { libraryId, paths: [...paths] },
    Schema.Array(Schema.NullOr(TrackId)),
  );

/** How many of `trackIds` still have a track row and a lyrics row. */
export const leftOf = (stack: CoreStack, trackIds: ReadonlyArray<Id<"tracks">>) =>
  runFunction(
    stack,
    internal.music.probe.leftOf,
    { trackIds: [...trackIds] },
    Schema.Struct({ tracks: Schema.Finite, lyrics: Schema.Finite }),
  );

/** A track's lyrics rows, up to 8, each its id and its sets. */
export const lyricRowsOf = (stack: CoreStack, trackId: Id<"tracks">) =>
  runFunction(
    stack,
    internal.music.probe.lyricRows,
    { trackId },
    Schema.Array(Schema.Struct({ id: LyricsId, sets: Schema.Unknown })),
  );

/** Runs one page of a music purge stage and schedules nothing. */
export const purgePage = (
  stack: CoreStack,
  libraryId: Id<"libraries">,
  stage: "tracks" | "rest",
  cursor: string | null,
  ranges?: number,
) =>
  runFunction(
    stack,
    internal.music.probe.purgePage,
    ranges === undefined ? { libraryId, stage, cursor } : { libraryId, stage, cursor, ranges },
    Schema.Struct({ cursor: Schema.NullOr(Schema.String), more: Schema.Boolean }),
  );

/** Makes `folders` the library's folders without scheduling its purge. */
export const setFoldersQuietly = (
  stack: CoreStack,
  libraryId: Id<"libraries">,
  folders: ReadonlyArray<string>,
) =>
  runFunction(
    stack,
    internal.movies.probe.setFolders,
    { libraryId, folders: [...folders] },
    Schema.Null,
  );
