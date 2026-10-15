/**
 * An in-memory `MediaBackend` that follows the `media:*` Convex contract closely enough for
 * scans, streams, and the job worker to run without a deployment: fingerprints come from earlier
 * upserts, claims and reports are guarded by worker and status, and scan requests collapse into a
 * library's pending or running job. `MemoryMediaBackendControl` adds libraries and inspects state.
 *
 * It keeps tracks only: albums and artists, whose artwork Convex takes from their tracks, list no
 * artwork of their own, so a batch releases a track's old art only.
 */
import { chainsOverlap, type FolderChain, fsPathsOverlap } from "@music/commands/folder-ids";
import { JobId, LibraryId, TrackId } from "@music/commands/ids";
import { compareText } from "@music/commands/text-order";
import { Context, Effect, Layer, Option, Stream, SubscriptionRef } from "effect";

import {
  type FingerprintPage,
  type JobOutcome,
  type JobProgress,
  type LibraryFolder,
  MediaBackend,
  type MoveOutcome,
  type PathRange,
  type PendingJob,
  type ArtHashPage,
  type RootClaim,
  type ArtworkTable,
  type ScannedTrack,
  type TrackMove,
  type TrackSource,
} from "../media-backend.ts";

/** A stored track and its generated ID. */
interface MemoryTrack {
  readonly id: TrackId;
  readonly libraryId: LibraryId;
  readonly scanned: ScannedTrack;
  readonly missing: boolean;
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
  readonly jobs: Effect.Effect<ReadonlyArray<MemoryJob>>;
  /** Libraries whose folders are claimed. */
  readonly claimed: Effect.Effect<ReadonlyArray<LibraryId>>;
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
        nextId: 1,
      });

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

      const upsertTracks = Effect.fn("MemoryMediaBackend.upsertTracks")(function* (
        libraryId: LibraryId,
        scanned: ReadonlyArray<ScannedTrack>,
      ) {
        const released: Array<string> = [];

        for (const track of scanned) {
          const existing = yield* trackAt(libraryId, track.path);
          const id = existing?.id ?? TrackId.make(yield* allocate("track"));
          const previous = existing?.scanned.artHash;

          if (previous !== undefined && previous !== track.artHash) released.push(previous);
          yield* store({ id, libraryId, scanned: track, missing: false });
        }

        return released;
      });

      const markMissing = Effect.fn("MemoryMediaBackend.markMissing")(function* (
        libraryId: LibraryId,
        paths: ReadonlyArray<string>,
      ) {
        const gone = new Set(paths);

        yield* SubscriptionRef.update(state, (current) => ({
          ...current,
          tracks: current.tracks.map((track) =>
            track.libraryId === libraryId && gone.has(track.scanned.path)
              ? { ...track, missing: true }
              : track,
          ),
        }));

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
              if (from !== track.path) yield* markMissing(libraryId, [from]);
              released.push(...(yield* upsertTracks(libraryId, [track])));
            } else {
              const previous = source.scanned.artHash;

              if (previous !== undefined && previous !== track.artHash) released.push(previous);
              yield* store({ id: source.id, libraryId, scanned: track, missing: false });
              moved += 1;
            }
          }

          const outcome: MoveOutcome = { moved, released };

          return outcome;
        }),

        markMissing,

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
        jobs: SubscriptionRef.get(state).pipe(Effect.map((current) => current.jobs)),
        claimed: SubscriptionRef.get(state).pipe(
          Effect.map((current) => Array.from(current.roots.keys())),
        ),
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
