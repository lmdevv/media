/**
 * The media service's view of Convex: the `media:*` functions, called with the shared service
 * secret. Convex owns all product state; this module only moves data in and out.
 */
import { JobId, LibraryId, type TrackId } from "@music/commands/ids";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import {
  Cause,
  Context,
  Effect,
  Layer,
  Option,
  Queue,
  Redacted,
  Schedule,
  Schema,
  Stream,
} from "effect";

import { MediaConfig } from "./media-config.ts";

/** A Convex call failed or returned data the service does not understand. */
class BackendError extends Schema.TaggedError<BackendError>()("BackendError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Convex call failed: ${this.operation}`;
  }
}

const PendingJob = Schema.Struct({ jobId: JobId, kind: Schema.Literal("scan") });

/** A job waiting for a worker. */
export interface PendingJob extends Schema.Schema.Type<typeof PendingJob> {}

const LibraryFolder = Schema.Struct({ id: LibraryId, path: Schema.String });

/** A library and the folder it reads. */
export interface LibraryFolder extends Schema.Schema.Type<typeof LibraryFolder> {}

const ClaimedJob = Schema.Struct({
  jobId: JobId,
  kind: Schema.Literal("scan"),
  library: Schema.Struct({ id: LibraryId, path: Schema.String, name: Schema.String }),
});

/** A job this worker holds the lease on. */
interface ClaimedJob extends Schema.Schema.Type<typeof ClaimedJob> {}

const Fingerprint = Schema.Struct({
  path: Schema.String,
  size: Schema.Finite,
  mtimeMs: Schema.Finite,
  missing: Schema.Boolean,
  /** The folder artwork the last scan saw beside the file (see `ScannedTrack.folderArt`). */
  folderArt: Schema.optional(Schema.String),
  /** Length and tags, for telling a moved file from a new one (see `moved-files.ts`). */
  durationMs: Schema.optional(Schema.Finite),
  title: Schema.optional(Schema.String),
  artist: Schema.optional(Schema.String),
  album: Schema.optional(Schema.String),
});

/** What Convex knows about one file, for skipping unchanged files. */
export interface Fingerprint extends Schema.Schema.Type<typeof Fingerprint> {}

const FingerprintPage = Schema.Struct({
  files: Schema.Array(Fingerprint),
  cursor: Schema.String,
  done: Schema.Boolean,
});

const ArtHashPage = Schema.Struct({
  hashes: Schema.Array(Schema.String),
  cursor: Schema.String,
  done: Schema.Boolean,
});

/** The artwork hashes one page of a table uses, and the cursor for the next page. */
export interface ArtHashPage extends Schema.Schema.Type<typeof ArtHashPage> {}

/** The tables whose rows refer to stored artwork by hash. */
export type ArtworkTable = "tracks" | "albums" | "artists";

const TrackSource = Schema.Struct({
  path: Schema.String,
  libraryPath: Schema.String,
  codec: Schema.String,
  lossless: Schema.Boolean,
  size: Schema.Finite,
  mtimeMs: Schema.Finite,
  durationMs: Schema.Finite,
});

/** Where a track's file lives, for streaming. `path` is relative to `libraryPath`. */
export interface TrackSource extends Schema.Schema.Type<typeof TrackSource> {}

const ReportResult = Schema.Struct({ cancelled: Schema.Boolean });

const MoveResult = Schema.Struct({ moved: Schema.Finite });

/** Tags read from one file, in the shape `media:upsertTracks` accepts. */
export interface ScannedTrack {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly title: string;
  readonly artist: string;
  readonly albumArtist?: string | undefined;
  readonly album: string;
  readonly trackNumber?: number | undefined;
  readonly discNumber?: number | undefined;
  readonly year?: number | undefined;
  readonly genre?: string | undefined;
  readonly durationMs: number;
  readonly codec: string;
  readonly lossless: boolean;
  readonly bitrate?: number | undefined;
  readonly sampleRate?: number | undefined;
  readonly bitDepth?: number | undefined;
  readonly artHash?: string | undefined;
  /**
   * The folder artwork file beside the file, as `path:size:mtime` (see `folder-art.ts`), whether
   * or not the file has a picture of its own. A later scan reads the file again when it changes.
   */
  readonly folderArt?: string | undefined;
}

/** A file found at `track.path` that is the known track at `from`, moved or renamed. */
export interface TrackMove {
  readonly from: string;
  readonly track: ScannedTrack;
}

/** Progress of a running job. */
export interface JobProgress {
  readonly done: number;
  readonly total?: number | undefined;
  readonly message?: string | undefined;
}

/** How a job ended. */
export type JobOutcome =
  | { readonly status: "done"; readonly message: string }
  | { readonly status: "failed"; readonly error: string };

/** One page of fingerprints and the cursor for the next. */
export interface FingerprintPage extends Schema.Schema.Type<typeof FingerprintPage> {}

type Secret = { secret: string };

const functions = {
  pendingJobs: makeFunctionReference<"query", Secret, unknown>("media:pendingJobs"),
  libraries: makeFunctionReference<"query", Secret, unknown>("media:libraries"),
  claimJob: makeFunctionReference<
    "mutation",
    Secret & { jobId: string; workerId: string },
    unknown
  >("media:claimJob"),
  reportJob: makeFunctionReference<
    "mutation",
    Secret & {
      jobId: string;
      workerId: string;
      done: number;
      total?: number | undefined;
      message?: string | undefined;
    },
    unknown
  >("media:reportJob"),
  finishJob: makeFunctionReference<
    "mutation",
    Secret & {
      jobId: string;
      workerId: string;
      status: "done" | "failed";
      message?: string;
      error?: string;
    },
    unknown
  >("media:finishJob"),
  fingerprints: makeFunctionReference<
    "query",
    Secret & { libraryId: string; cursor: string | null },
    unknown
  >("media:fingerprints"),
  upsertTracks: makeFunctionReference<
    "mutation",
    Secret & { libraryId: string; tracks: ReadonlyArray<ScannedTrack> },
    unknown
  >("media:upsertTracks"),
  moveTracks: makeFunctionReference<
    "mutation",
    Secret & { libraryId: string; moves: ReadonlyArray<TrackMove> },
    unknown
  >("media:moveTracks"),
  markMissing: makeFunctionReference<
    "mutation",
    Secret & { libraryId: string; paths: ReadonlyArray<string> },
    unknown
  >("media:markMissing"),
  trackSource: makeFunctionReference<"query", Secret & { trackId: string }, unknown>(
    "media:trackSource",
  ),
  artHashes: makeFunctionReference<
    "query",
    Secret & { table: ArtworkTable; cursor: string | null },
    unknown
  >("media:artHashes"),
  requestScan: makeFunctionReference<"mutation", Secret & { libraryId: string }, unknown>(
    "media:requestScan",
  ),
};

/** Convex operations the media service uses. */
export interface Interface {
  /** Pending jobs, re-emitted whenever the set changes. */
  readonly pendingJobs: Stream.Stream<ReadonlyArray<PendingJob>, BackendError>;
  /** All library folders, re-emitted whenever libraries change. */
  readonly libraries: Stream.Stream<ReadonlyArray<LibraryFolder>, BackendError>;
  /** Claims a job; `None` when another worker got it first or it is gone. */
  readonly claimJob: (
    jobId: JobId,
    workerId: string,
  ) => Effect.Effect<Option.Option<ClaimedJob>, BackendError>;
  /** Reports progress and renews the lease. Returns true when the job was cancelled. */
  readonly reportJob: (
    jobId: JobId,
    workerId: string,
    progress: JobProgress,
  ) => Effect.Effect<boolean, BackendError>;
  readonly finishJob: (
    jobId: JobId,
    workerId: string,
    outcome: JobOutcome,
  ) => Effect.Effect<void, BackendError>;
  readonly fingerprints: (
    libraryId: LibraryId,
    cursor: string | null,
  ) => Effect.Effect<FingerprintPage, BackendError>;
  /** Upserts at most 100 scanned files. */
  readonly upsertTracks: (
    libraryId: LibraryId,
    tracks: ReadonlyArray<ScannedTrack>,
  ) => Effect.Effect<void, BackendError>;
  /**
   * Moves at most 100 known tracks to the paths their files were found at, keeping their IDs. A
   * move whose source is gone or whose new path is taken is stored as a new file instead.
   * Returns how many tracks moved.
   */
  readonly moveTracks: (
    libraryId: LibraryId,
    moves: ReadonlyArray<TrackMove>,
  ) => Effect.Effect<number, BackendError>;
  readonly markMissing: (
    libraryId: LibraryId,
    paths: ReadonlyArray<string>,
  ) => Effect.Effect<void, BackendError>;
  /** The artwork hashes one page of `table` uses; start from a `null` cursor until `done`. */
  readonly artHashes: (
    table: ArtworkTable,
    cursor: string | null,
  ) => Effect.Effect<ArtHashPage, BackendError>;
  /** Resolves a track to its file; `None` when the track is unknown or missing. */
  readonly trackSource: (
    trackId: TrackId,
  ) => Effect.Effect<Option.Option<TrackSource>, BackendError>;
  /** Enqueues a scan unless one is already pending or running. */
  readonly requestScan: (libraryId: LibraryId) => Effect.Effect<void, BackendError>;
  /** Succeeds when Convex answers an authenticated query. */
  readonly ping: Effect.Effect<void, BackendError>;
}

/** Access to the `media:*` Convex functions. */
export class MediaBackend extends Context.Service<MediaBackend, Interface>()(
  "@music/media/MediaBackend",
) {}

const CALL_TIMEOUT = "30 seconds";

/** Backoff for restarting a dropped subscription: exponential from one second, capped at 30. */
export const resubscribeSchedule = Schedule.min([
  Schedule.exponential("1 second"),
  Schedule.spaced("30 seconds"),
]);

const decodeClaim = Schema.decodeUnknownEffect(Schema.NullOr(ClaimedJob));

const decodeReport = Schema.decodeUnknownEffect(ReportResult);

const decodeMove = Schema.decodeUnknownEffect(MoveResult);

const decodeFingerprints = Schema.decodeUnknownEffect(FingerprintPage);

const decodeTrackSource = Schema.decodeUnknownEffect(Schema.NullOr(TrackSource));

const decodeArtHashes = Schema.decodeUnknownEffect(ArtHashPage);

const call = <A>(operation: string, run: () => Promise<A>): Effect.Effect<A, BackendError> =>
  Effect.tryPromise({ try: run, catch: (cause) => new BackendError({ operation, cause }) }).pipe(
    Effect.timeoutOrElse({
      duration: CALL_TIMEOUT,
      orElse: () => Effect.fail(new BackendError({ operation, cause: new Error("timed out") })),
    }),
  );

const decodeFailure = (operation: string) => (cause: Schema.SchemaError) =>
  new BackendError({ operation, cause });

/** Builds `MediaBackend` on a `ConvexClient` that lives as long as the layer. */
const make = Effect.gen(function* () {
  const config = yield* MediaConfig;

  const client = yield* Effect.acquireRelease(
    Effect.sync(() => new ConvexClient(config.convexUrl, { logger: false })),
    (convex) => Effect.promise(() => convex.close()),
  );

  const secret = (): string => Redacted.value(config.serviceSecret);

  const subscribe = <A>(
    operation: string,
    reference: typeof functions.pendingJobs,
    schema: Schema.Decoder<A>,
  ): Stream.Stream<A, BackendError> =>
    Stream.callback<unknown, BackendError>(
      (queue) =>
        Effect.acquireRelease(
          Effect.sync(() =>
            client.onUpdate(
              reference,
              { secret: secret() },
              (value) => {
                Queue.offerUnsafe(queue, value);
              },
              (cause) => {
                Queue.failCauseUnsafe(queue, Cause.fail(new BackendError({ operation, cause })));
              },
            ),
          ),
          (unsubscribe) =>
            Effect.sync(() => {
              unsubscribe();
            }),
        ),
      { bufferSize: 1, strategy: "sliding" },
    ).pipe(
      Stream.mapEffect((value) =>
        Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(decodeFailure(operation))),
      ),
    );

  return MediaBackend.of({
    pendingJobs: subscribe("pendingJobs", functions.pendingJobs, Schema.Array(PendingJob)),
    libraries: subscribe("libraries", functions.libraries, Schema.Array(LibraryFolder)),

    claimJob: Effect.fn("MediaBackend.claimJob")(function* (jobId: JobId, workerId: string) {
      const result = yield* call("claimJob", () =>
        client.mutation(functions.claimJob, { secret: secret(), jobId, workerId }),
      );

      const claimed = yield* decodeClaim(result).pipe(Effect.mapError(decodeFailure("claimJob")));

      return Option.fromNullOr(claimed);
    }),

    reportJob: Effect.fn("MediaBackend.reportJob")(function* (
      jobId: JobId,
      workerId: string,
      progress: JobProgress,
    ) {
      const result = yield* call("reportJob", () =>
        client.mutation(functions.reportJob, { secret: secret(), jobId, workerId, ...progress }),
      );

      const { cancelled } = yield* decodeReport(result).pipe(
        Effect.mapError(decodeFailure("reportJob")),
      );

      return cancelled;
    }),

    finishJob: Effect.fn("MediaBackend.finishJob")(function* (
      jobId: JobId,
      workerId: string,
      outcome: JobOutcome,
    ) {
      yield* call("finishJob", () =>
        client.mutation(functions.finishJob, { secret: secret(), jobId, workerId, ...outcome }),
      );
    }),

    fingerprints: Effect.fn("MediaBackend.fingerprints")(function* (
      libraryId: LibraryId,
      cursor: string | null,
    ) {
      const result = yield* call("fingerprints", () =>
        client.query(functions.fingerprints, { secret: secret(), libraryId, cursor }),
      );

      return yield* decodeFingerprints(result).pipe(Effect.mapError(decodeFailure("fingerprints")));
    }),

    upsertTracks: Effect.fn("MediaBackend.upsertTracks")(function* (
      libraryId: LibraryId,
      tracks: ReadonlyArray<ScannedTrack>,
    ) {
      yield* call("upsertTracks", () =>
        client.mutation(functions.upsertTracks, { secret: secret(), libraryId, tracks }),
      );
    }),

    moveTracks: Effect.fn("MediaBackend.moveTracks")(function* (
      libraryId: LibraryId,
      moves: ReadonlyArray<TrackMove>,
    ) {
      const result = yield* call("moveTracks", () =>
        client.mutation(functions.moveTracks, { secret: secret(), libraryId, moves }),
      );

      const { moved } = yield* decodeMove(result).pipe(
        Effect.mapError(decodeFailure("moveTracks")),
      );

      return moved;
    }),

    markMissing: Effect.fn("MediaBackend.markMissing")(function* (
      libraryId: LibraryId,
      paths: ReadonlyArray<string>,
    ) {
      yield* call("markMissing", () =>
        client.mutation(functions.markMissing, { secret: secret(), libraryId, paths }),
      );
    }),

    artHashes: Effect.fn("MediaBackend.artHashes")(function* (
      table: ArtworkTable,
      cursor: string | null,
    ) {
      const result = yield* call("artHashes", () =>
        client.query(functions.artHashes, { secret: secret(), table, cursor }),
      );

      return yield* decodeArtHashes(result).pipe(Effect.mapError(decodeFailure("artHashes")));
    }),

    trackSource: Effect.fn("MediaBackend.trackSource")(function* (trackId: TrackId) {
      const result = yield* call("trackSource", () =>
        client.query(functions.trackSource, { secret: secret(), trackId }),
      );

      const source = yield* decodeTrackSource(result).pipe(
        Effect.mapError(decodeFailure("trackSource")),
      );

      return Option.fromNullOr(source);
    }),

    requestScan: Effect.fn("MediaBackend.requestScan")(function* (libraryId: LibraryId) {
      yield* call("requestScan", () =>
        client.mutation(functions.requestScan, { secret: secret(), libraryId }),
      );
    }),

    ping: call("ping", () => client.query(functions.libraries, { secret: secret() })).pipe(
      Effect.asVoid,
      Effect.withSpan("MediaBackend.ping"),
    ),
  });
});

/** `MediaBackend` over Convex, configured by `MediaConfig`. */
export const layer: Layer.Layer<MediaBackend, never, MediaConfig> = Layer.effect(
  MediaBackend,
  make,
);
