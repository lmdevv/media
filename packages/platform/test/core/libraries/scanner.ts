import { Schema } from "effect";

import type { ContentDomain } from "../../../commands/scopes";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { scanKindOf } from "../../../convex/core/jobs/kinds";
import { movieFile } from "../../movies/scanned";
import { runServer } from "../../service";
import type { CoreStack } from "../../stack-env";
import { eventually, retrying } from "../jobs/driver";
import { walk } from "./files";
import { claimOwnFolders } from "./ownership";
import type { ScannedFile } from "./files";

// SAFETY: a type predicate, not checked by the compiler. A Convex id is an opaque string, and the
// stack answered this one as an id of `table`; the backend's `v.id` validators check it again
// whenever a test sends it back.
const isIdOf =
  <Table extends "jobs" | "libraries">(_table: Table) =>
  (value: unknown): value is Id<Table> =>
    Schema.is(Schema.String)(value);

const JobId = Schema.declare(isIdOf("jobs"));

const LibraryId = Schema.declare(isIdOf("libraries"));

const Lease = Schema.Struct({ jobId: JobId, attempt: Schema.Finite });

export type ScanLease = typeof Lease.Type;

const Claim = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("claimed"),
    lease: Lease,
    payload: Schema.Struct({ kind: Schema.String, libraryId: LibraryId }),
  }),
  Schema.Struct({ outcome: Schema.Literal("idle") }),
]);

const answer = <Value extends Schema.Top>(value: Value) =>
  Schema.Union([
    Schema.Struct({ outcome: Schema.Literal("held"), value }),
    Schema.Struct({ outcome: Schema.Literals(["canceled", "lost"]) }),
  ]);

const File = Schema.Struct({ path: Schema.String, size: Schema.Finite, mtime: Schema.Finite });

const MovieFile = Schema.Struct({
  path: Schema.String,
  sizeBytes: Schema.Finite,
  mtimeMs: Schema.Finite,
  missing: Schema.Boolean,
});

const Target = answer(
  Schema.Struct({ libraryId: LibraryId, folders: Schema.Array(Schema.String) }),
);

const pageOf = <Row extends Schema.Top>(row: Row) =>
  answer(
    Schema.Struct({
      files: Schema.Array(row),
      continueCursor: Schema.String,
      isDone: Schema.Boolean,
    }),
  );

const Upserted = answer(Schema.Struct({ inserted: Schema.Finite }));

const Landed = answer(
  Schema.Struct({
    files: Schema.Array(Schema.Struct({ path: Schema.String })),
    done: Schema.Finite,
  }),
);

const Missing = answer(Schema.Struct({ removed: Schema.Finite }));

const Marked = answer(Schema.Struct({ marked: Schema.Finite, done: Schema.Finite }));

const Finished = Schema.Struct({ outcome: Schema.String });

const LEASE_MS = 30_000;

/** Paths one `missing` call takes, and files one music `upsert` takes. */
const BATCH = 500;

const probe = api.core.libraryProbe;

const movies = api.movies.scanner;

/** A file the library knows; `missing` only for movies, which keep a missing file's row. */
export interface KnownFile extends ScannedFile {
  readonly missing: boolean;
}

type Held<Value> =
  | { readonly outcome: "held"; readonly value: Value }
  | { readonly outcome: "canceled" | "lost" };

const mapHeld = <From, To>(held: Held<From>, map: (value: From) => To): Held<To> =>
  held.outcome === "held" ? { outcome: "held", value: map(held.value) } : held;

/**
 * Writes `files` as movies, sending again what a call's budget left unwritten, and counts every
 * file it wrote as inserted.
 */
const moviesUpsert = async (
  stack: CoreStack,
  lease: ScanLease,
  files: ReadonlyArray<ScannedFile>,
  inserted = 0,
): Promise<Held<{ readonly inserted: number }>> => {
  if (files.length === 0) return { outcome: "held", value: { inserted } };

  const landed = await retrying(() =>
    runServer(
      stack,
      movies.upsert,
      { lease, items: files.map((file) => movieFile(file.path, file.size, file.mtime)) },
      Landed,
    ),
  );

  if (landed.outcome !== "held") return landed;

  return moviesUpsert(stack, lease, files.slice(landed.value.done), inserted + landed.value.done);
};

/** Marks `paths` missing, sending again what a call's budget left, and counts the newly marked. */
const moviesMissing = async (
  stack: CoreStack,
  lease: ScanLease,
  paths: ReadonlyArray<string>,
  removed = 0,
): Promise<Held<{ readonly removed: number }>> => {
  if (paths.length === 0) return { outcome: "held", value: { removed } };

  const marked = await retrying(() =>
    runServer(stack, movies.missing, { lease, paths: [...paths] }, Marked),
  );

  if (marked.outcome !== "held") return marked;

  return moviesMissing(stack, lease, paths.slice(marked.value.done), removed + marked.value.marked);
};

/**
 * The scanner's calls, each retried on a refusal that committed nothing, as the server's pool will.
 * Music writes the probe's rows; movies writes each file as a movie titled by its path. Movies'
 * `upsert` counts every file it wrote as inserted, and its `missing` counts the files it newly
 * marked missing as removed, since movies keeps their rows.
 */
export const scanCalls = (stack: CoreStack, workerId: string) => ({
  claim: (kind: ContentDomain) =>
    retrying(() =>
      runServer(
        stack,
        api.core.jobs.worker.claim,
        { kinds: [scanKindOf(kind)], workerId, leaseMs: LEASE_MS },
        Claim,
      ),
    ),
  target: (lease: ScanLease, kind: ContentDomain) =>
    retrying(() => runServer(stack, api.core.scans.target, { lease, kind }, Target)),
  claimOwn: (lease: ScanLease, kind: ContentDomain) => claimOwnFolders(stack, kind, lease),
  known: async (
    lease: ScanLease,
    kind: ContentDomain,
    cursor: string | null,
  ): Promise<
    Held<{
      readonly files: ReadonlyArray<KnownFile>;
      readonly continueCursor: string;
      readonly isDone: boolean;
    }>
  > =>
    kind === "music"
      ? mapHeld(
          await retrying(() => runServer(stack, probe.known, { lease, cursor }, pageOf(File))),
          (page) => ({ ...page, files: page.files.map((file) => ({ ...file, missing: false })) }),
        )
      : mapHeld(
          await retrying(() =>
            runServer(stack, movies.known, { lease, cursor }, pageOf(MovieFile)),
          ),
          (page) => ({
            ...page,
            files: page.files.map((file) => ({
              path: file.path,
              size: file.sizeBytes,
              mtime: file.mtimeMs,
              missing: file.missing,
            })),
          }),
        ),
  upsert: async (
    lease: ScanLease,
    kind: ContentDomain,
    files: ReadonlyArray<ScannedFile>,
  ): Promise<Held<{ readonly inserted: number }>> =>
    kind === "music"
      ? retrying(() => runServer(stack, probe.upsert, { lease, files: [...files] }, Upserted))
      : moviesUpsert(stack, lease, files),
  missing: async (
    lease: ScanLease,
    kind: ContentDomain,
    paths: ReadonlyArray<string>,
  ): Promise<Held<{ readonly removed: number }>> =>
    kind === "music"
      ? retrying(() => runServer(stack, probe.missing, { lease, paths: [...paths] }, Missing))
      : moviesMissing(stack, lease, paths),
  finish: (lease: ScanLease) =>
    retrying(() =>
      runServer(
        stack,
        api.core.jobs.worker.finish,
        { lease, end: { outcome: "succeeded" } },
        Finished,
      ),
    ),
});

const batches = <Item>(
  items: ReadonlyArray<Item>,
  size = BATCH,
): ReadonlyArray<ReadonlyArray<Item>> =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, n) =>
    items.slice(n * size, (n + 1) * size),
  );

/** What one scan attempt did. */
export interface ScanRun {
  readonly libraryId: Id<"libraries">;
  readonly jobId: Id<"jobs">;
  readonly outcome: "succeeded" | "canceled" | "lost";
  readonly found: number;
  readonly inserted: number;
  readonly removed: number;
}

type Calls = ReturnType<typeof scanCalls>;

const knownFiles = async (
  calls: Calls,
  lease: ScanLease,
  kind: ContentDomain,
  cursor: string | null = null,
  seen: ReadonlyArray<KnownFile> = [],
): Promise<ReadonlyArray<KnownFile> | null> => {
  const page = await calls.known(lease, kind, cursor);

  if (page.outcome !== "held") return null;

  const next = [...seen, ...page.value.files];

  return page.value.isDone ? next : knownFiles(calls, lease, kind, page.value.continueCursor, next);
};

const stopped = (outcome: "canceled" | "lost", found = 0) => ({
  outcome,
  found,
  inserted: 0,
  removed: 0,
});

const sendAll = async <Batch>(
  queue: ReadonlyArray<Batch>,
  send: (batch: Batch) => Promise<number | null>,
  sum = 0,
): Promise<number | null> => {
  const [first, ...rest] = queue;

  if (first === undefined) return sum;

  const count = await send(first);

  return count === null ? null : sendAll(rest, send, sum + count);
};

const scanClaimed = async (
  calls: Calls,
  kind: ContentDomain,
  lease: ScanLease,
): Promise<Omit<ScanRun, "jobId" | "libraryId">> => {
  const target = await calls.target(lease, kind);

  if (target.outcome !== "held") return stopped(target.outcome);

  const claimed = await calls.claimOwn(lease, kind);

  if (claimed !== "held") return stopped(claimed);

  const walked = (await Promise.all(target.value.folders.map(walk))).flat();
  const known = await knownFiles(calls, lease, kind);

  if (known === null) return stopped("canceled", walked.length);

  const before = new Map(known.map((file) => [file.path, file]));
  const onDisk = new Set(walked.map((file) => file.path));

  const changed = walked.filter((file) => {
    const old = before.get(file.path);

    return old === undefined || old.missing || old.size !== file.size || old.mtime !== file.mtime;
  });

  const gone = known
    .filter((file) => !file.missing && !onDisk.has(file.path))
    .map((file) => file.path);

  const inserted = await sendAll(batches(changed), async (batch) => {
    const written = await calls.upsert(lease, kind, batch);

    return written.outcome === "held" ? written.value.inserted : null;
  });

  const removed =
    inserted === null
      ? null
      : await sendAll(batches(gone), async (batch) => {
          const dropped = await calls.missing(lease, kind, batch);

          return dropped.outcome === "held" ? dropped.value.removed : null;
        });

  if (inserted === null || removed === null) return stopped("canceled", walked.length);

  const finished = await calls.finish(lease);

  return {
    outcome: finished.outcome === "settled" ? "succeeded" : "canceled",
    found: walked.length,
    inserted,
    removed,
  };
};

/**
 * Claims the scan of `libraryId` as the worker `calls` stands for, running any other library's
 * scan of the kind it claims first, and returns its lease.
 */
export const claimScanOf = (
  calls: Calls,
  kind: ContentDomain,
  libraryId: Id<"libraries">,
): Promise<ScanLease> =>
  eventually(
    `a claim of ${libraryId}'s scan`,
    async () => {
      const claim = await calls.claim(kind);

      if (claim.outcome === "idle") return null;

      if (claim.payload.libraryId === libraryId) return claim.lease;

      await scanClaimed(calls, kind, claim.lease);

      return null;
    },
    120_000,
  );

/**
 * Scans `libraryId` to its end as one worker: claims scans of its kind, running any other
 * library's scan it claims first, until its own has run.
 */
export const scanLibrary = async (
  stack: CoreStack,
  kind: ContentDomain,
  libraryId: Id<"libraries">,
  workerId = `scanner-${Math.random().toString(36).slice(2, 8)}`,
): Promise<ScanRun> => {
  const calls = scanCalls(stack, workerId);

  return eventually(
    `a scan of ${libraryId}`,
    async () => {
      const claim = await calls.claim(kind);

      if (claim.outcome === "idle") return null;

      const run = await scanClaimed(calls, kind, claim.lease);

      return claim.payload.libraryId === libraryId
        ? { ...run, libraryId, jobId: claim.lease.jobId }
        : null;
    },
    120_000,
  );
};
