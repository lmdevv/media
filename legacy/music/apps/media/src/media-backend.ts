/**
 * The media service's view of Convex: the `media:*` functions, called with the shared service
 * secret. Convex owns all product state; this module only moves data in and out.
 */
import type { FolderChain } from "@music/commands/folder-ids";
import { JobId, LibraryId, type TrackId } from "@music/commands/ids";
import type { LookupOutcome } from "@music/commands/lyric-lookups";
import type { LocalLyricSet, LrclibLyricSet } from "@music/commands/lyrics";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import {
  type Array as Arr,
  Cause,
  Context,
  Effect,
  Layer,
  Option,
  Queue,
  Redacted,
  Schema,
  Stream,
} from "effect";

import { cappedBackoff } from "./backoff.ts";
import { MediaConfig } from "./media-config.ts";

/** A Convex call failed or returned data the service does not understand. */
export class BackendError extends Schema.TaggedError<BackendError>()("BackendError", {
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

const LibraryFolder = Schema.Struct({
  id: LibraryId,
  path: Schema.String,
  /** Whether its folder is claimed, with identities (`media:claimRoot`), so its songs stream. */
  claimed: Schema.Boolean,
  /** The boot its claim's identities were read in (`Files.readBootId`); null without one. */
  bootId: Schema.NullOr(Schema.String),
});

/** A library, the folder it reads, and whether that folder is claimed. */
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
  /** The lyric files the last scan read beside the file (see `ScannedLyrics`). */
  lyricsFiles: Schema.optional(Schema.String),
  /** The lyrics reader that read them; absent before scans read lyrics. */
  lyricsReader: Schema.optional(Schema.Finite),
  /** The size of the lyric sets Convex keeps for the file, as JSON; absent when it has none. */
  lyricsBytes: Schema.optional(Schema.Finite),
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

const RootClaim = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true) }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);

/** Whether Convex accepted a library's real folder, and why not. */
export type RootClaim = Schema.Schema.Type<typeof RootClaim>;

/**
 * The artwork a batch stopped using somewhere. Convex versions before it was reported send none,
 * so their art is left to the full collection at startup.
 */
const Released = Schema.optional(Schema.Array(Schema.String));

const BatchResult = Schema.Struct({ released: Released });

const MoveResult = Schema.Struct({ moved: Schema.Finite, released: Released });

const ArtInUse = Schema.Struct({ inUse: Schema.Array(Schema.String) });

/** What a batch of moves did: how many tracks moved, and the artwork it stopped using. */
export interface MoveOutcome {
  readonly moved: number;
  readonly released: ReadonlyArray<string>;
}

/** Paths from `from` (inclusive) up to `to` (exclusive), in code point order; open when absent. */
export interface PathRange {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

/** The lyrics read for one file, in the shape `media:saveLocalLyrics` accepts. */
export interface ScannedLyrics {
  readonly path: string;
  /**
   * The lyric files beside the file that were read, as `lyricsFilesKey` writes them; empty when
   * it has none. A later scan reads the file's lyrics again when it changes.
   */
  readonly lyricsFiles: string;
  /** `LYRICS_READER_VERSION` of the reader that read them. */
  readonly lyricsReader: number;
  /** The file's own lyric sets, from its lyric files and its tags. */
  readonly lyrics: ReadonlyArray<LocalLyricSet>;
}

/** Tags and lyrics read from one file, in the shape `media:upsertTracks` accepts. */
export interface ScannedTrack extends ScannedLyrics {
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

/** Identifies one LRCLIB lookup (`lyricLookups`). */
export const LookupId = Schema.String.pipe(Schema.brand("LookupId"));

export type LookupId = typeof LookupId.Type;

const LookupQuery = Schema.Struct({
  artist: Schema.String,
  title: Schema.String,
  album: Schema.String,
  /** The song's length in whole seconds. */
  durationS: Schema.Finite,
});

/** The tags LRCLIB is asked with. */
export interface LookupQuery extends Schema.Schema.Type<typeof LookupQuery> {}

const QueuedLookup = Schema.Struct({ lookupId: LookupId, query: LookupQuery });

/** A lookup waiting for the worker, or claimed by it. */
export interface QueuedLookup extends Schema.Schema.Type<typeof QueuedLookup> {}

/** What one try learned (`LookupOutcome`), as `media:saveLookup` takes it: with found lyrics. */
export type LookupAnswer =
  | (Extract<LookupOutcome, { readonly kind: "found" }> & {
      readonly sets: Arr.NonEmptyReadonlyArray<LrclibLyricSet>;
    })
  | Exclude<LookupOutcome, { readonly kind: "found" }>;

const SaveResult = Schema.Struct({ saved: Schema.Boolean });

/** One page of fingerprints and the cursor for the next. */
export interface FingerprintPage extends Schema.Schema.Type<typeof FingerprintPage> {}

type Secret = { secret: string };

const functions = {
  pendingJobs: makeFunctionReference<"query", Secret, unknown>("media:pendingJobs"),
  libraries: makeFunctionReference<"query", Secret, unknown>("media:libraries"),
  claimRoot: makeFunctionReference<
    "mutation",
    Secret & {
      libraryId: string;
      realPath: string;
      rootIds: ReadonlyArray<string>;
      fsPath: string | null;
      bootId: string | null;
    },
    unknown
  >("media:claimRoot"),
  refuseRoot: makeFunctionReference<"mutation", Secret & { libraryId: string }, unknown>(
    "media:refuseRoot",
  ),
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
    Secret & {
      libraryId: string;
      cursor: string | null;
      from?: string | undefined;
      to?: string | undefined;
    },
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
  saveLocalLyrics: makeFunctionReference<
    "mutation",
    Secret & { libraryId: string; tracks: ReadonlyArray<ScannedLyrics> },
    unknown
  >("media:saveLocalLyrics"),
  trackSource: makeFunctionReference<"query", Secret & { trackId: string }, unknown>(
    "media:trackSource",
  ),
  artHashes: makeFunctionReference<
    "query",
    Secret & { table: ArtworkTable; cursor: string | null },
    unknown
  >("media:artHashes"),
  artInUse: makeFunctionReference<"query", Secret & { hashes: ReadonlyArray<string> }, unknown>(
    "media:artInUse",
  ),
  requestScan: makeFunctionReference<"mutation", Secret & { libraryId: string }, unknown>(
    "media:requestScan",
  ),
  lyricQueue: makeFunctionReference<"query", Secret, unknown>("media:lyricQueue"),
  claimLookup: makeFunctionReference<
    "mutation",
    Secret & { lookupId: string; workerId: string },
    unknown
  >("media:claimLookup"),
  saveLookup: makeFunctionReference<
    "mutation",
    Secret & { lookupId: string; workerId: string; answer: LookupAnswer },
    unknown
  >("media:saveLookup"),
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
  /**
   * Claims the real folder a library's path resolves to before it is scanned, with the folder's
   * identity and its parents' (`FolderChain`). Refused when it is, is inside, or holds another
   * library's folder by path or by identity; the error names no other folder. A refusal drops
   * the library's earlier claim, so it stops streaming.
   */
  readonly claimRoot: (
    libraryId: LibraryId,
    realPath: string,
    rootIds: FolderChain,
    /** Where the folder is on its file system (`mounts.ts`); null without a mount table. */
    fsPath: string | null,
    /** The boot those identities belong to (`Files.readBootId`). */
    bootId: string | null,
  ) => Effect.Effect<RootClaim, BackendError>;
  /**
   * Drops a library's claim after the service refused its folder itself (outside `MUSIC_ROOTS`,
   * or a system folder), so it stops streaming.
   */
  readonly refuseRoot: (libraryId: LibraryId) => Effect.Effect<void, BackendError>;
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
  /** One page of the library's known files in `range`; start from a `null` cursor until `done`. */
  readonly fingerprints: (
    libraryId: LibraryId,
    cursor: string | null,
    range?: PathRange,
  ) => Effect.Effect<FingerprintPage, BackendError>;
  /** Upserts at most 100 scanned files. Returns the artwork the batch stopped using somewhere. */
  readonly upsertTracks: (
    libraryId: LibraryId,
    tracks: ReadonlyArray<ScannedTrack>,
  ) => Effect.Effect<ReadonlyArray<string>, BackendError>;
  /**
   * Moves at most 100 known tracks to the paths their files were found at, keeping their IDs. A
   * move whose source is gone or whose new path is taken is stored as a new file instead.
   * Returns how many tracks moved and the artwork the batch stopped using somewhere.
   */
  readonly moveTracks: (
    libraryId: LibraryId,
    moves: ReadonlyArray<TrackMove>,
  ) => Effect.Effect<MoveOutcome, BackendError>;
  /**
   * Saves the lyrics of at most 100 known files whose audio did not change, leaving their tags
   * and artwork as they are.
   */
  readonly saveLocalLyrics: (
    libraryId: LibraryId,
    tracks: ReadonlyArray<ScannedLyrics>,
  ) => Effect.Effect<void, BackendError>;
  /** Marks files missing. Returns the artwork the batch stopped using somewhere. */
  readonly markMissing: (
    libraryId: LibraryId,
    paths: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string>, BackendError>;
  /** The artwork hashes one page of `table` uses; start from a `null` cursor until `done`. */
  readonly artHashes: (
    table: ArtworkTable,
    cursor: string | null,
  ) => Effect.Effect<ArtHashPage, BackendError>;
  /** Which of at most 200 artwork hashes a track, album, or artist still uses. */
  readonly artInUse: (
    hashes: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlySet<string>, BackendError>;
  /** Resolves a track to its file; `None` when the track is unknown or missing. */
  readonly trackSource: (
    trackId: TrackId,
  ) => Effect.Effect<Option.Option<TrackSource>, BackendError>;
  /** Enqueues a scan unless one is already pending or running. */
  readonly requestScan: (libraryId: LibraryId) => Effect.Effect<void, BackendError>;
  /**
   * The LRCLIB lookups waiting to be asked, most urgent first, re-emitted whenever they change.
   * Empty while remote lyrics are off.
   */
  readonly lyricQueue: Stream.Stream<ReadonlyArray<QueuedLookup>, BackendError>;
  /** Claims a lookup with a 60 second lease; `None` when it is no longer queued. */
  readonly claimLookup: (
    lookupId: LookupId,
    workerId: string,
  ) => Effect.Effect<Option.Option<QueuedLookup>, BackendError>;
  /**
   * Saves what LRCLIB answered for a lookup the worker holds. Returns false when the lease ran
   * out first, so the answer was dropped.
   */
  readonly saveLookup: (
    lookupId: LookupId,
    workerId: string,
    answer: LookupAnswer,
  ) => Effect.Effect<boolean, BackendError>;
  /** Succeeds when Convex answers an authenticated query. */
  readonly ping: Effect.Effect<void, BackendError>;
}

/** Access to the `media:*` Convex functions. */
export class MediaBackend extends Context.Service<MediaBackend, Interface>()(
  "@music/media/MediaBackend",
) {}

const CALL_TIMEOUT = "30 seconds";

/** Backoff for restarting a dropped subscription: exponential from one second, capped at 30. */
export const resubscribeSchedule = cappedBackoff("1 second", "30 seconds");

const decodeClaim = Schema.decodeUnknownEffect(Schema.NullOr(ClaimedJob));

const decodeReport = Schema.decodeUnknownEffect(ReportResult);

const decodeRootClaim = Schema.decodeUnknownEffect(RootClaim);

const decodeMove = Schema.decodeUnknownEffect(MoveResult);

const decodeBatch = Schema.decodeUnknownEffect(BatchResult);

const decodeArtInUse = Schema.decodeUnknownEffect(ArtInUse);

const decodeFingerprints = Schema.decodeUnknownEffect(FingerprintPage);

const decodeTrackSource = Schema.decodeUnknownEffect(Schema.NullOr(TrackSource));

const decodeArtHashes = Schema.decodeUnknownEffect(ArtHashPage);

const decodeClaimedLookup = Schema.decodeUnknownEffect(Schema.NullOr(QueuedLookup));

const decodeSave = Schema.decodeUnknownEffect(SaveResult);

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
    lyricQueue: subscribe("lyricQueue", functions.lyricQueue, Schema.Array(QueuedLookup)),

    claimLookup: Effect.fn("MediaBackend.claimLookup")(function* (
      lookupId: LookupId,
      workerId: string,
    ) {
      const result = yield* call("claimLookup", () =>
        client.mutation(functions.claimLookup, { secret: secret(), lookupId, workerId }),
      );

      const claimed = yield* decodeClaimedLookup(result).pipe(
        Effect.mapError(decodeFailure("claimLookup")),
      );

      return Option.fromNullOr(claimed);
    }),

    saveLookup: Effect.fn("MediaBackend.saveLookup")(function* (
      lookupId: LookupId,
      workerId: string,
      answer: LookupAnswer,
    ) {
      const result = yield* call("saveLookup", () =>
        client.mutation(functions.saveLookup, { secret: secret(), lookupId, workerId, answer }),
      );

      const { saved } = yield* decodeSave(result).pipe(
        Effect.mapError(decodeFailure("saveLookup")),
      );

      return saved;
    }),

    claimJob: Effect.fn("MediaBackend.claimJob")(function* (jobId: JobId, workerId: string) {
      const result = yield* call("claimJob", () =>
        client.mutation(functions.claimJob, { secret: secret(), jobId, workerId }),
      );

      const claimed = yield* decodeClaim(result).pipe(Effect.mapError(decodeFailure("claimJob")));

      return Option.fromNullOr(claimed);
    }),

    claimRoot: Effect.fn("MediaBackend.claimRoot")(function* (
      libraryId: LibraryId,
      realPath: string,
      rootIds: FolderChain,
      fsPath: string | null,
      bootId: string | null,
    ) {
      const result = yield* call("claimRoot", () =>
        client.mutation(functions.claimRoot, {
          secret: secret(),
          libraryId,
          realPath,
          rootIds,
          fsPath,
          bootId,
        }),
      );

      return yield* decodeRootClaim(result).pipe(Effect.mapError(decodeFailure("claimRoot")));
    }),

    refuseRoot: Effect.fn("MediaBackend.refuseRoot")(function* (libraryId: LibraryId) {
      yield* call("refuseRoot", () =>
        client.mutation(functions.refuseRoot, { secret: secret(), libraryId }),
      );
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
      range: PathRange = {},
    ) {
      const result = yield* call("fingerprints", () =>
        client.query(functions.fingerprints, {
          secret: secret(),
          libraryId,
          cursor,
          from: range.from,
          to: range.to,
        }),
      );

      return yield* decodeFingerprints(result).pipe(Effect.mapError(decodeFailure("fingerprints")));
    }),

    upsertTracks: Effect.fn("MediaBackend.upsertTracks")(function* (
      libraryId: LibraryId,
      tracks: ReadonlyArray<ScannedTrack>,
    ) {
      const result = yield* call("upsertTracks", () =>
        client.mutation(functions.upsertTracks, { secret: secret(), libraryId, tracks }),
      );

      const { released } = yield* decodeBatch(result).pipe(
        Effect.mapError(decodeFailure("upsertTracks")),
      );

      return released ?? [];
    }),

    moveTracks: Effect.fn("MediaBackend.moveTracks")(function* (
      libraryId: LibraryId,
      moves: ReadonlyArray<TrackMove>,
    ) {
      const result = yield* call("moveTracks", () =>
        client.mutation(functions.moveTracks, { secret: secret(), libraryId, moves }),
      );

      const { moved, released } = yield* decodeMove(result).pipe(
        Effect.mapError(decodeFailure("moveTracks")),
      );

      const outcome: MoveOutcome = { moved, released: released ?? [] };

      return outcome;
    }),

    markMissing: Effect.fn("MediaBackend.markMissing")(function* (
      libraryId: LibraryId,
      paths: ReadonlyArray<string>,
    ) {
      const result = yield* call("markMissing", () =>
        client.mutation(functions.markMissing, { secret: secret(), libraryId, paths }),
      );

      const { released } = yield* decodeBatch(result).pipe(
        Effect.mapError(decodeFailure("markMissing")),
      );

      return released ?? [];
    }),

    saveLocalLyrics: Effect.fn("MediaBackend.saveLocalLyrics")(function* (
      libraryId: LibraryId,
      tracks: ReadonlyArray<ScannedLyrics>,
    ) {
      yield* call("saveLocalLyrics", () =>
        client.mutation(functions.saveLocalLyrics, { secret: secret(), libraryId, tracks }),
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

    artInUse: Effect.fn("MediaBackend.artInUse")(function* (hashes: ReadonlyArray<string>) {
      const result = yield* call("artInUse", () =>
        client.query(functions.artInUse, { secret: secret(), hashes }),
      );

      const { inUse } = yield* decodeArtInUse(result).pipe(
        Effect.mapError(decodeFailure("artInUse")),
      );

      return new Set(inUse);
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
