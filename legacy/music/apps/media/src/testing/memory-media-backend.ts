/**
 * An in-memory `MediaBackend` that follows the `media:*` Convex contract closely enough for
 * scans, streams, and the job worker to run without a deployment: fingerprints come from earlier
 * upserts, claims and reports are guarded by worker and status, and scan requests collapse into a
 * library's pending or running job. `MemoryMediaBackendControl` adds libraries and inspects state,
 * including the catalog writes each call made. Lyrics lookups are queued by tests and move from
 * state to state by the rules Convex runs (`@music/commands/lyric-lookups`): the queue lists ten
 * at most, most urgent first, and hides while LRCLIB is paused. What Convex schedules (a retry
 * coming due, the end of a pause) waits until a test runs it with `runScheduled`.
 *
 * It keeps tracks only: albums and artists, whose artwork Convex takes from their tracks, list no
 * artwork of their own, so a batch releases a track's old art only.
 */
import { chainsOverlap, type FolderChain, fsPathsOverlap } from "@music/commands/folder-ids";
import { JobId, LibraryId, TrackId } from "@music/commands/ids";
import {
  LYRIC_QUEUE_SIZE,
  answered,
  expiredLease,
  leased,
  pauseEnd,
  queueOrder,
  retried,
  type LookupPriority,
  type LookupState,
} from "@music/commands/lyric-lookups";
import { compareText } from "@music/commands/text-order";
import { Clock, Context, Effect, Layer, Option, Stream, SubscriptionRef } from "effect";

import {
  BackendError,
  type FingerprintPage,
  type JobOutcome,
  type JobProgress,
  type LibraryFolder,
  type LookupAnswer,
  LookupId,
  type LookupQuery,
  MediaBackend,
  type MoveOutcome,
  type PathRange,
  type PendingJob,
  type ArtHashPage,
  type RootClaim,
  type ArtworkTable,
  type ScannedLyrics,
  type ScannedTrack,
  type TrackMove,
  type TrackSource,
} from "../media-backend.ts";

/** A scanned file as stored, with no lyrics reader on tracks stored before scans read lyrics. */
interface StoredFile extends Omit<ScannedTrack, "lyricsReader"> {
  readonly lyricsReader?: number | undefined;
}

/** A stored track and its generated ID. */
interface MemoryTrack {
  readonly id: TrackId;
  readonly libraryId: LibraryId;
  readonly scanned: StoredFile;
  readonly missing: boolean;
}

/** One call that wrote tracks, and the paths it wrote, in the order they came. */
interface MemoryWrite {
  readonly operation: "upsertTracks" | "moveTracks" | "saveLocalLyrics" | "markMissing";
  readonly paths: ReadonlyArray<string>;
}

/** A stored job. */
export interface MemoryJob {
  readonly id: JobId;
  readonly libraryId: LibraryId;
  readonly status: "pending" | "running" | "done" | "failed" | "cancelled";
  readonly workerId: string | undefined;
  readonly progress: JobProgress;
  readonly outcome: JobOutcome | undefined;
}

/** A lyrics lookup and where it is. */
export interface MemoryLookup {
  readonly id: LookupId;
  readonly query: LookupQuery;
  readonly state: LookupState;
  /** The last answer saved for it. */
  readonly answer: LookupAnswer | undefined;
}

/** Work Convex schedules for later: a lookup's retry, or the end of the LRCLIB pause. */
type Scheduled =
  | { readonly kind: "retry"; readonly lookupId: LookupId }
  | { readonly kind: "endPause" };

/** What a claim stores: the folder's identities (`@music/commands/folder-ids`) and their boot. */
interface Claim {
  readonly rootIds: FolderChain;
  readonly fsPath: string | null;
  readonly bootId: string | null;
}

/**
 * Whether two claims are the same folder, or one is inside the other, by either identity; only
 * identities read in the same boot are compared, as `media:claimRoot` does.
 */
const claimsOverlap = (left: Claim, right: Claim): boolean =>
  left.bootId === right.bootId &&
  (chainsOverlap(left.rootIds, right.rootIds) ||
    (left.fsPath !== null && right.fsPath !== null && fsPathsOverlap(left.fsPath, right.fsPath)));

interface State {
  readonly libraries: ReadonlyArray<Omit<LibraryFolder, "claimed" | "bootId">>;
  /**
   * The identities of the folders libraries claimed, as `media:claimRoot` stores them. Compared
   * by identity only, so tests show the service reports identities that catch any overlap.
   */
  readonly roots: ReadonlyMap<LibraryId, Claim>;
  readonly tracks: ReadonlyArray<MemoryTrack>;
  readonly jobs: ReadonlyArray<MemoryJob>;
  readonly writes: ReadonlyArray<MemoryWrite>;
  readonly lookups: ReadonlyArray<MemoryLookup>;
  /** Saves dropped because the lease had moved on, oldest first. */
  readonly droppedSaves: ReadonlyArray<LookupId>;
  /** When the LRCLIB pause ends, while one is in force. */
  readonly pausedUntil: number | null;
  readonly scheduled: ReadonlyArray<Scheduled>;
  /** Claims still to fail, as when Convex is unreachable. */
  readonly failingClaims: number;
  readonly nextId: number;
}

/** Test controls over the in-memory backend. */
export interface ControlInterface {
  readonly addLibrary: (path: string) => Effect.Effect<LibraryId>;
  /** Deletes a library and its songs, as `libraries.delete` and the purge after it do. */
  readonly deleteLibrary: (libraryId: LibraryId) => Effect.Effect<void>;
  /** Enqueues a scan the way `libraries.create` and `libraries.scan` do. */
  readonly enqueueScan: (libraryId: LibraryId) => Effect.Effect<JobId>;
  readonly cancelJob: (jobId: JobId) => Effect.Effect<void>;
  readonly tracks: Effect.Effect<ReadonlyArray<MemoryTrack>>;
  /** Every call that wrote tracks, oldest first. */
  readonly writes: Effect.Effect<ReadonlyArray<MemoryWrite>>;
  /** Makes every track look as tracks stored before scans read lyrics do, with no reader. */
  readonly forgetLyricsReader: Effect.Effect<void>;
  readonly jobs: Effect.Effect<ReadonlyArray<MemoryJob>>;
  /** Libraries whose folders are claimed. */
  readonly claimed: Effect.Effect<ReadonlyArray<LibraryId>>;
  /** Queues a lyrics lookup, as `requestLyrics` does, at backfill priority unless told. */
  readonly queueLookup: (query: LookupQuery, priority?: LookupPriority) => Effect.Effect<LookupId>;
  /** Ends a lookup's lease, as the lease cron does. */
  readonly expireLease: (lookupId: LookupId) => Effect.Effect<void>;
  /** Runs everything scheduled so far as if its time had come. */
  readonly runScheduled: Effect.Effect<void>;
  /** Makes the next claim fail. */
  readonly failNextClaim: Effect.Effect<void>;
  readonly lookups: Effect.Effect<ReadonlyArray<MemoryLookup>>;
  readonly droppedSaves: Effect.Effect<ReadonlyArray<LookupId>>;
  readonly pausedUntil: Effect.Effect<number | null>;
}

/** Controls for `layerMemory`. */
export class MemoryMediaBackendControl extends Context.Service<
  MemoryMediaBackendControl,
  ControlInterface
>()("@music/media/MemoryMediaBackendControl") {}

const PAGE = 1000;

/** Provides `MediaBackend` and `MemoryMediaBackendControl` over one shared in-memory state. */
export const layerMemory: Layer.Layer<MediaBackend | MemoryMediaBackendControl> =
  Layer.effectContext(
    Effect.gen(function* () {
      const state = yield* SubscriptionRef.make<State>({
        libraries: [],
        roots: new Map(),
        tracks: [],
        jobs: [],
        writes: [],
        lookups: [],
        droppedSaves: [],
        pausedUntil: null,
        scheduled: [],
        failingClaims: 0,
        nextId: 1,
      });

      const record = (write: MemoryWrite): Effect.Effect<void> =>
        SubscriptionRef.update(state, (current) => ({
          ...current,
          writes: [...current.writes, write],
        }));

      const allocate = (prefix: string): Effect.Effect<string> =>
        SubscriptionRef.modify(state, (current) => [
          `${prefix}${current.nextId}`,
          { ...current, nextId: current.nextId + 1 },
        ]);

      const updateJob = (
        jobId: JobId,
        update: (job: MemoryJob) => MemoryJob,
      ): Effect.Effect<void> =>
        SubscriptionRef.update(state, (current) => ({
          ...current,
          jobs: current.jobs.map((job) => (job.id === jobId ? update(job) : job)),
        }));

      const findJob = (jobId: JobId): Effect.Effect<MemoryJob | undefined> =>
        SubscriptionRef.get(state).pipe(
          Effect.map((current) => current.jobs.find((job) => job.id === jobId)),
        );

      const enqueueScan = Effect.fn("MemoryMediaBackend.enqueueScan")(function* (
        libraryId: LibraryId,
      ) {
        const current = yield* SubscriptionRef.get(state);

        const active = current.jobs.find(
          (job) =>
            job.libraryId === libraryId && (job.status === "pending" || job.status === "running"),
        );

        if (active !== undefined) return active.id;
        const id = JobId.make(yield* allocate("job"));

        const job: MemoryJob = {
          id,
          libraryId,
          status: "pending",
          workerId: undefined,
          progress: { done: 0 },
          outcome: undefined,
        };

        yield* SubscriptionRef.update(state, (latest) => ({
          ...latest,
          jobs: [...latest.jobs, job],
        }));

        return id;
      });

      const changes = SubscriptionRef.changes(state);

      const updateLookup = (
        lookupId: LookupId,
        update: (lookup: MemoryLookup) => MemoryLookup,
      ): Effect.Effect<void> =>
        SubscriptionRef.update(state, (current) => ({
          ...current,
          lookups: current.lookups.map((lookup) =>
            lookup.id === lookupId ? update(lookup) : lookup,
          ),
        }));

      const trackAt = (
        libraryId: LibraryId,
        path: string,
      ): Effect.Effect<MemoryTrack | undefined> =>
        SubscriptionRef.get(state).pipe(
          Effect.map((current) =>
            current.tracks.find(
              (candidate) => candidate.libraryId === libraryId && candidate.scanned.path === path,
            ),
          ),
        );

      const store = (track: MemoryTrack): Effect.Effect<void> =>
        SubscriptionRef.update(state, (latest) => ({
          ...latest,
          tracks: latest.tracks.some((candidate) => candidate.id === track.id)
            ? latest.tracks.map((candidate) => (candidate.id === track.id ? track : candidate))
            : [...latest.tracks, track],
        }));

      const upsertOne = Effect.fn("MemoryMediaBackend.upsertOne")(function* (
        libraryId: LibraryId,
        track: ScannedTrack,
      ) {
        const existing = yield* trackAt(libraryId, track.path);
        const id = existing?.id ?? TrackId.make(yield* allocate("track"));
        const previous = existing?.scanned.artHash;

        yield* store({ id, libraryId, scanned: track, missing: false });

        return previous !== undefined && previous !== track.artHash ? [previous] : [];
      });

      const markOneMissing = (libraryId: LibraryId, path: string): Effect.Effect<void> =>
        SubscriptionRef.update(state, (current) => ({
          ...current,
          tracks: current.tracks.map((track) =>
            track.libraryId === libraryId && track.scanned.path === path
              ? { ...track, missing: true }
              : track,
          ),
        }));

      const upsertTracks = Effect.fn("MemoryMediaBackend.upsertTracks")(function* (
        libraryId: LibraryId,
        scanned: ReadonlyArray<ScannedTrack>,
      ) {
        const released: Array<string> = [];

        for (const track of scanned) released.push(...(yield* upsertOne(libraryId, track)));
        yield* record({ operation: "upsertTracks", paths: scanned.map((track) => track.path) });

        return released;
      });

      const markMissing = Effect.fn("MemoryMediaBackend.markMissing")(function* (
        libraryId: LibraryId,
        paths: ReadonlyArray<string>,
      ) {
        for (const path of paths) yield* markOneMissing(libraryId, path);
        yield* record({ operation: "markMissing", paths });

        // Missing tracks keep their art, so marking them releases none.
        const released: ReadonlyArray<string> = [];

        return released;
      });

      const backend = MediaBackend.of({
        pendingJobs: changes.pipe(
          Stream.map((current): ReadonlyArray<PendingJob> =>
            current.jobs
              .filter((job) => job.status === "pending")
              .map((job) => ({ jobId: job.id, kind: "scan" })),
          ),
        ),
        libraries: changes.pipe(
          Stream.map((current) =>
            current.libraries.map((library) => ({
              ...library,
              claimed: current.roots.has(library.id),
              bootId: current.roots.get(library.id)?.bootId ?? null,
            })),
          ),
        ),

        lyricQueue: changes.pipe(
          Stream.map((current) =>
            current.pausedUntil === null
              ? current.lookups
                  .flatMap((lookup) =>
                    lookup.state.status === "queued" ? [{ lookup, state: lookup.state }] : [],
                  )
                  .toSorted((left, right) => queueOrder(left.state, right.state))
                  .slice(0, LYRIC_QUEUE_SIZE)
                  .map(({ lookup }) => ({ lookupId: lookup.id, query: lookup.query }))
              : [],
          ),
          // A Convex subscription sends a query's result again only when it changed.
          Stream.changesWith(
            (left, right) =>
              left.length === right.length &&
              left.every((entry, position) => entry.lookupId === right[position]?.lookupId),
          ),
        ),

        claimLookup: Effect.fn("MemoryMediaBackend.claimLookup")(function* (
          lookupId: LookupId,
          workerId: string,
        ) {
          const now = yield* Clock.currentTimeMillis;

          const claimed = yield* SubscriptionRef.modify(state, (current) => {
            if (current.failingClaims > 0) {
              return [null, { ...current, failingClaims: current.failingClaims - 1 }];
            }

            const lookup = current.lookups.find((candidate) => candidate.id === lookupId);
            const paused = current.pausedUntil !== null && current.pausedUntil > now;

            if (lookup?.state.status !== "queued" || paused) return [Option.none(), current];
            const next = { ...lookup, state: leased(lookup.state, workerId, now) };

            return [
              Option.some({ lookupId, query: lookup.query }),
              {
                ...current,
                lookups: current.lookups.map((candidate) =>
                  candidate.id === lookupId ? next : candidate,
                ),
              },
            ];
          });

          if (claimed === null) {
            return yield* new BackendError({ operation: "claimLookup", cause: "unreachable" });
          }

          return claimed;
        }),

        saveLookup: Effect.fn("MemoryMediaBackend.saveLookup")(function* (
          lookupId: LookupId,
          workerId: string,
          answer: LookupAnswer,
        ) {
          const now = yield* Clock.currentTimeMillis;

          return yield* SubscriptionRef.modify(state, (current) => {
            const lookup = current.lookups.find((candidate) => candidate.id === lookupId);

            if (lookup?.state.status !== "leased" || lookup.state.workerId !== workerId) {
              return [false, { ...current, droppedSaves: [...current.droppedSaves, lookupId] }];
            }

            const next = { ...lookup, state: answered(lookup.state, answer, now), answer };

            const pausedUntil =
              answer.kind === "unavailable"
                ? pauseEnd(current.pausedUntil, now, answer.pauseMs)
                : current.pausedUntil;

            const scheduled: ReadonlyArray<Scheduled> = [
              ...current.scheduled,
              ...(next.state.status === "waiting" ? [{ kind: "retry", lookupId } as const] : []),
              ...(answer.kind === "unavailable" ? [{ kind: "endPause" } as const] : []),
            ];

            return [
              true,
              {
                ...current,
                pausedUntil,
                scheduled,
                lookups: current.lookups.map((candidate) =>
                  candidate.id === lookupId ? next : candidate,
                ),
              },
            ];
          });
        }),

        claimRoot: Effect.fn("MemoryMediaBackend.claimRoot")(function* (
          libraryId: LibraryId,
          _realPath: string,
          rootIds: FolderChain,
          fsPath: string | null,
          bootId: string | null,
        ) {
          return yield* SubscriptionRef.modify(state, (current): [RootClaim, State] => {
            const others = [...current.roots].filter(([other]) => other !== libraryId);

            const claim: Claim = { rootIds, fsPath, bootId };

            if (others.some(([, root]) => claimsOverlap(root, claim))) {
              return [
                { ok: false, error: "This folder overlaps another library" },
                { ...current, roots: new Map(others) },
              ];
            }

            return [{ ok: true }, { ...current, roots: new Map([...others, [libraryId, claim]]) }];
          });
        }),

        refuseRoot: Effect.fn("MemoryMediaBackend.refuseRoot")(function* (libraryId: LibraryId) {
          yield* SubscriptionRef.update(state, (current) => ({
            ...current,
            roots: new Map([...current.roots].filter(([id]) => id !== libraryId)),
          }));
        }),

        claimJob: Effect.fn("MemoryMediaBackend.claimJob")(function* (
          jobId: JobId,
          workerId: string,
        ) {
          const job = yield* findJob(jobId);

          if (job?.status !== "pending") return Option.none();
          const current = yield* SubscriptionRef.get(state);
          const library = current.libraries.find((candidate) => candidate.id === job.libraryId);

          if (library === undefined) return Option.none();
          yield* updateJob(jobId, (latest) => ({
            ...latest,
            status: "running",
            workerId,
            progress: { done: 0 },
          }));

          return Option.some({
            jobId,
            kind: "scan" as const,
            library: { ...library, name: library.path },
          });
        }),

        reportJob: Effect.fn("MemoryMediaBackend.reportJob")(function* (
          jobId: JobId,
          workerId: string,
          progress: JobProgress,
        ) {
          const job = yield* findJob(jobId);

          if (job?.status !== "running" || job.workerId !== workerId) return true;
          yield* updateJob(jobId, (latest) => ({ ...latest, progress }));

          return false;
        }),

        finishJob: Effect.fn("MemoryMediaBackend.finishJob")(function* (
          jobId: JobId,
          workerId: string,
          outcome: JobOutcome,
        ) {
          const job = yield* findJob(jobId);

          if (job?.status !== "running" || job.workerId !== workerId) return;
          yield* updateJob(jobId, (latest) => ({ ...latest, status: outcome.status, outcome }));
        }),

        fingerprints: Effect.fn("MemoryMediaBackend.fingerprints")(function* (
          libraryId: LibraryId,
          cursor: string | null,
          range: PathRange = {},
        ) {
          const current = yield* SubscriptionRef.get(state);
          const start = cursor === null ? 0 : Number(cursor);
          const { from, to } = range;

          const files = current.tracks
            .filter(
              ({ libraryId: library, scanned: { path } }) =>
                library === libraryId &&
                (from === undefined || compareText(path, from) >= 0) &&
                (to === undefined || compareText(path, to) < 0),
            )
            .toSorted((left, right) => compareText(left.scanned.path, right.scanned.path))
            .slice(start, start + PAGE)
            .map((track) => ({
              path: track.scanned.path,
              size: track.scanned.size,
              mtimeMs: track.scanned.mtimeMs,
              missing: track.missing,
              folderArt: track.scanned.folderArt,
              lyricsFiles: track.scanned.lyricsFiles,
              lyricsReader: track.scanned.lyricsReader,
              lyricsBytes:
                track.scanned.lyrics.length === 0
                  ? undefined
                  : new TextEncoder().encode(JSON.stringify(track.scanned.lyrics)).length,
              durationMs: track.scanned.durationMs,
              title: track.scanned.title,
              artist: track.scanned.artist,
              album: track.scanned.album,
            }));

          const page: FingerprintPage = {
            files,
            cursor: String(start + files.length),
            done: files.length < PAGE,
          };

          return page;
        }),

        upsertTracks,

        moveTracks: Effect.fn("MemoryMediaBackend.moveTracks")(function* (
          libraryId: LibraryId,
          moves: ReadonlyArray<TrackMove>,
        ) {
          let moved = 0;
          const released: Array<string> = [];

          for (const { from, track } of moves) {
            const source = yield* trackAt(libraryId, from);
            const occupied = yield* trackAt(libraryId, track.path);

            if (source === undefined || occupied !== undefined || from === track.path) {
              if (from !== track.path) yield* markOneMissing(libraryId, from);
              released.push(...(yield* upsertOne(libraryId, track)));
            } else {
              const previous = source.scanned.artHash;

              if (previous !== undefined && previous !== track.artHash) released.push(previous);
              yield* store({ id: source.id, libraryId, scanned: track, missing: false });
              moved += 1;
            }
          }

          yield* record({ operation: "moveTracks", paths: moves.map(({ track }) => track.path) });
          const outcome: MoveOutcome = { moved, released };

          return outcome;
        }),

        markMissing,

        saveLocalLyrics: Effect.fn("MemoryMediaBackend.saveLocalLyrics")(function* (
          libraryId: LibraryId,
          tracks: ReadonlyArray<ScannedLyrics>,
        ) {
          for (const lyrics of tracks) {
            const existing = yield* trackAt(libraryId, lyrics.path);

            if (existing !== undefined) {
              yield* store({ ...existing, scanned: { ...existing.scanned, ...lyrics } });
            }
          }

          yield* record({ operation: "saveLocalLyrics", paths: tracks.map((track) => track.path) });
        }),

        artHashes: Effect.fn("MemoryMediaBackend.artHashes")(function* (
          table: ArtworkTable,
          cursor: string | null,
        ) {
          const current = yield* SubscriptionRef.get(state);
          const start = cursor === null ? 0 : Number(cursor);
          const rows = table === "tracks" ? current.tracks.slice(start, start + PAGE) : [];

          const page: ArtHashPage = {
            hashes: [...new Set(rows.flatMap((track) => track.scanned.artHash ?? []))],
            cursor: String(start + rows.length),
            done: rows.length < PAGE,
          };

          return page;
        }),

        artInUse: Effect.fn("MemoryMediaBackend.artInUse")(function* (
          hashes: ReadonlyArray<string>,
        ) {
          const current = yield* SubscriptionRef.get(state);
          const used = new Set(current.tracks.flatMap((track) => track.scanned.artHash ?? []));

          return new Set(hashes.filter((hash) => used.has(hash)));
        }),

        trackSource: Effect.fn("MemoryMediaBackend.trackSource")(function* (trackId: TrackId) {
          const current = yield* SubscriptionRef.get(state);
          const track = current.tracks.find((candidate) => candidate.id === trackId);
          const library = current.libraries.find((candidate) => candidate.id === track?.libraryId);

          if (track === undefined || track.missing || library === undefined) return Option.none();

          const source: TrackSource = {
            path: track.scanned.path,
            libraryPath: library.path,
            codec: track.scanned.codec,
            lossless: track.scanned.lossless,
            size: track.scanned.size,
            mtimeMs: track.scanned.mtimeMs,
            durationMs: track.scanned.durationMs,
          };

          return Option.some(source);
        }),

        requestScan: Effect.fn("MemoryMediaBackend.requestScan")(function* (libraryId: LibraryId) {
          yield* enqueueScan(libraryId);
        }),

        ping: Effect.void,
      });

      const control = MemoryMediaBackendControl.of({
        addLibrary: Effect.fn("MemoryMediaBackend.addLibrary")(function* (path: string) {
          const id = LibraryId.make(yield* allocate("library"));

          yield* SubscriptionRef.update(state, (current) => ({
            ...current,
            libraries: [...current.libraries, { id, path }],
          }));

          return id;
        }),
        deleteLibrary: Effect.fn("MemoryMediaBackend.deleteLibrary")(function* (
          libraryId: LibraryId,
        ) {
          yield* SubscriptionRef.update(state, (current) => ({
            ...current,
            libraries: current.libraries.filter((library) => library.id !== libraryId),
            roots: new Map([...current.roots].filter(([id]) => id !== libraryId)),
            tracks: current.tracks.filter((track) => track.libraryId !== libraryId),
          }));
        }),
        enqueueScan,
        cancelJob: Effect.fn("MemoryMediaBackend.cancelJob")(function* (jobId: JobId) {
          yield* updateJob(jobId, (job) =>
            job.status === "pending" || job.status === "running"
              ? { ...job, status: "cancelled" }
              : job,
          );
        }),
        tracks: SubscriptionRef.get(state).pipe(Effect.map((current) => current.tracks)),
        writes: SubscriptionRef.get(state).pipe(Effect.map((current) => current.writes)),
        forgetLyricsReader: SubscriptionRef.update(state, (current) => ({
          ...current,
          tracks: current.tracks.map((track) => ({
            ...track,
            scanned: { ...track.scanned, lyricsReader: undefined },
          })),
        })),
        jobs: SubscriptionRef.get(state).pipe(Effect.map((current) => current.jobs)),
        claimed: SubscriptionRef.get(state).pipe(
          Effect.map((current) => Array.from(current.roots.keys())),
        ),
        queueLookup: Effect.fn("MemoryMediaBackend.queueLookup")(function* (
          query: LookupQuery,
          priority: LookupPriority = "backfill",
        ) {
          const id = LookupId.make(yield* allocate("lookup"));
          const now = yield* Clock.currentTimeMillis;

          const lookup: MemoryLookup = {
            id,
            query,
            state: { status: "queued", priority, requestedAt: now, attempts: 0 },
            answer: undefined,
          };

          yield* SubscriptionRef.update(state, (current) => ({
            ...current,
            lookups: [...current.lookups, lookup],
          }));

          return id;
        }),
        expireLease: Effect.fn("MemoryMediaBackend.expireLease")(function* (lookupId: LookupId) {
          const now = yield* Clock.currentTimeMillis;

          yield* updateLookup(lookupId, (lookup) =>
            lookup.state.status === "leased"
              ? { ...lookup, state: expiredLease(lookup.state, now) }
              : lookup,
          );
        }),
        runScheduled: SubscriptionRef.update(state, (current) => {
          const retries = new Set(
            current.scheduled.flatMap((work) => (work.kind === "retry" ? [work.lookupId] : [])),
          );

          return {
            ...current,
            scheduled: [],
            pausedUntil: current.scheduled.some((work) => work.kind === "endPause")
              ? null
              : current.pausedUntil,
            lookups: current.lookups.map((lookup) =>
              retries.has(lookup.id) && lookup.state.status === "waiting"
                ? { ...lookup, state: retried(lookup.state, lookup.state.retryAt) ?? lookup.state }
                : lookup,
            ),
          };
        }),
        failNextClaim: SubscriptionRef.update(state, (current) => ({
          ...current,
          failingClaims: current.failingClaims + 1,
        })),
        lookups: SubscriptionRef.get(state).pipe(Effect.map((current) => current.lookups)),
        droppedSaves: SubscriptionRef.get(state).pipe(
          Effect.map((current) => current.droppedSaves),
        ),
        pausedUntil: SubscriptionRef.get(state).pipe(Effect.map((current) => current.pausedUntil)),
      });

      return Context.make(MediaBackend, backend).pipe(
        Context.add(MemoryMediaBackendControl, control),
      );
    }),
  );

/** Reads the latest state of one job, for polling in tests. */
export const jobById = (jobs: ReadonlyArray<MemoryJob>, jobId: JobId): MemoryJob | undefined =>
  jobs.find((job) => job.id === jobId);

/** True once a job has stopped running. */
export const isSettled = (job: MemoryJob | undefined): boolean =>
  job !== undefined && job.status !== "pending" && job.status !== "running";
