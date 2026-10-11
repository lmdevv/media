/**
 * An in-memory `MediaBackend` that follows the `media:*` Convex contract closely enough for
 * scans, streams, and the job worker to run without a deployment: fingerprints come from earlier
 * upserts, claims and reports are guarded by worker and status, and scan requests collapse into a
 * library's pending or running job. `MemoryMediaBackendControl` adds libraries and inspects state.
 */
import { JobId, LibraryId, TrackId } from "@music/commands/ids";
import { Context, Effect, Layer, Option, Stream, SubscriptionRef } from "effect";

import {
  type FingerprintPage,
  type JobOutcome,
  type JobProgress,
  type LibraryFolder,
  MediaBackend,
  type PendingJob,
  type ScannedTrack,
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

interface State {
  readonly libraries: ReadonlyArray<LibraryFolder>;
  readonly tracks: ReadonlyArray<MemoryTrack>;
  readonly jobs: ReadonlyArray<MemoryJob>;
  readonly nextId: number;
}

/** Test controls over the in-memory backend. */
export interface ControlInterface {
  readonly addLibrary: (path: string) => Effect.Effect<LibraryId>;
  /** Enqueues a scan the way `libraries.create` and `libraries.scan` do. */
  readonly enqueueScan: (libraryId: LibraryId) => Effect.Effect<JobId>;
  readonly cancelJob: (jobId: JobId) => Effect.Effect<void>;
  readonly tracks: Effect.Effect<ReadonlyArray<MemoryTrack>>;
  readonly jobs: Effect.Effect<ReadonlyArray<MemoryJob>>;
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

      const backend = MediaBackend.of({
        pendingJobs: changes.pipe(
          Stream.map((current): ReadonlyArray<PendingJob> =>
            current.jobs
              .filter((job) => job.status === "pending")
              .map((job) => ({ jobId: job.id, kind: "scan" })),
          ),
        ),
        libraries: changes.pipe(Stream.map((current) => current.libraries)),

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
        ) {
          const current = yield* SubscriptionRef.get(state);
          const start = cursor === null ? 0 : Number(cursor);

          const files = current.tracks
            .filter((track) => track.libraryId === libraryId)
            .slice(start, start + PAGE)
            .map((track) => ({
              path: track.scanned.path,
              size: track.scanned.size,
              mtimeMs: track.scanned.mtimeMs,
              missing: track.missing,
            }));

          const page: FingerprintPage = {
            files,
            cursor: String(start + files.length),
            done: files.length < PAGE,
          };

          return page;
        }),

        upsertTracks: Effect.fn("MemoryMediaBackend.upsertTracks")(function* (
          libraryId: LibraryId,
          scanned: ReadonlyArray<ScannedTrack>,
        ) {
          for (const track of scanned) {
            const current = yield* SubscriptionRef.get(state);

            const existing = current.tracks.find(
              (candidate) =>
                candidate.libraryId === libraryId && candidate.scanned.path === track.path,
            );

            const id = existing?.id ?? TrackId.make(yield* allocate("track"));
            const stored: MemoryTrack = { id, libraryId, scanned: track, missing: false };

            yield* SubscriptionRef.update(state, (latest) => ({
              ...latest,
              tracks:
                existing === undefined
                  ? [...latest.tracks, stored]
                  : latest.tracks.map((candidate) => (candidate.id === id ? stored : candidate)),
            }));
          }
        }),

        markMissing: Effect.fn("MemoryMediaBackend.markMissing")(function* (
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
