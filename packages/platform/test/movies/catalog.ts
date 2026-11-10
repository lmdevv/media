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
import type { ScannedItem } from "./scanned";

// SAFETY: a type predicate, not checked by the compiler. A Convex id is an opaque string, and the
// stack answered this one through a `v.id(...)` validator, which checks it again whenever a test
// sends it back.
const isId =
  <Table extends "jobs" | "titles" | "episodes" | "mediaFiles" | "people">(_table: Table) =>
  (value: unknown): value is Id<Table> =>
    Schema.is(Schema.String)(value);

export const JobId = Schema.declare(isId("jobs"));

const TitleId = Schema.declare(isId("titles"));

const EpisodeId = Schema.declare(isId("episodes"));

const FileId = Schema.declare(isId("mediaFiles"));

export const PersonId = Schema.declare(isId("people"));

export const Lease = Schema.Struct({ jobId: JobId, attempt: Schema.Finite });

export type Lease = typeof Lease.Type;

export const answer = <Value extends Schema.Top>(value: Value) =>
  Schema.Union([
    Schema.Struct({ outcome: Schema.Literal("held"), value }),
    Schema.Struct({ outcome: Schema.Literals(["canceled", "lost"]) }),
  ]);

const Claim = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("claimed"),
    lease: Lease,
    payload: Schema.Struct({ kind: Schema.String }),
  }),
  Schema.Struct({ outcome: Schema.Literal("idle") }),
]);

export const Landed = answer(
  Schema.Struct({
    files: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        fileId: FileId,
        titleId: TitleId,
        episodeId: Schema.NullOr(EpisodeId),
      }),
    ),
    done: Schema.Finite,
  }),
);

const Known = answer(
  Schema.Struct({
    files: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        sizeBytes: Schema.Finite,
        mtimeMs: Schema.Finite,
        missing: Schema.Boolean,
        sidecarDigest: Schema.NullOr(Schema.String),
      }),
    ),
    continueCursor: Schema.String,
    isDone: Schema.Boolean,
  }),
);

const Marked = answer(Schema.Struct({ marked: Schema.Finite, done: Schema.Finite }));

export const Totals = Schema.Struct({
  titles: Schema.Finite,
  episodes: Schema.Finite,
  files: Schema.Finite,
});

export type Totals = typeof Totals.Type;

const RowsPage = Schema.Struct({
  counted: Totals,
  continueCursor: Schema.String,
  isDone: Schema.Boolean,
});

type MoviesKind = "movies.scan" | "movies.metadata" | "movies.person" | "movies.trickplay";

/** A movies library on a new empty folder, made by `admin`, and the scan its creation queued. */
export const moviesLibrary = async (
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
    kind: "movies",
    folders: [...roots],
  });

  return { libraryId, scanJobId, roots };
};

/**
 * Claims job `jobId` of `kind` as the stack's media server, with a lease of `leaseMs`. Another
 * job of the kind it claims first it fails for good at once, which frees its slot, so a leftover
 * of an earlier test never blocks it.
 */
export const claimJob = async (
  stack: CoreStack,
  kind: MoviesKind,
  jobId: Id<"jobs">,
  leaseMs = 60_000,
  deadline = Date.now() + 120_000,
): Promise<Lease> => {
  const claim = await retrying(() =>
    runServer(
      stack,
      api.core.jobs.worker.claim,
      { kinds: [kind], workerId: `movies-${jobId}`, leaseMs },
      Claim,
    ),
  );

  if (claim.outcome === "claimed" && claim.lease.jobId === jobId) {
    // A scan claims its folders before any write, as the server's does.
    if (kind === "movies.scan") await claimOwnFolders(stack, "movies", claim.lease);

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

  return claimJob(stack, kind, jobId, leaseMs, deadline);
};

/** Cancels every queued job of `kind`, such as the thumbnails a large scan queued. */
export const cancelQueued = async (stack: CoreStack, kind: MoviesKind): Promise<void> => {
  const { more } = await runFunction(
    stack,
    internal.movies.probe.cancelQueued,
    { kind },
    Schema.Struct({ more: Schema.Boolean }),
  );

  if (more) await cancelQueued(stack, kind);
};

/** Writes `items` under the scan lease. */
export const upsert = (stack: CoreStack, lease: Lease, items: ReadonlyArray<ScannedItem>) =>
  retrying(() => runServer(stack, api.movies.scanner.upsert, { lease, items: [...items] }, Landed));

/** Marks `paths` missing under the scan lease. */
export const markMissing = (stack: CoreStack, lease: Lease, paths: ReadonlyArray<string>) =>
  retrying(() =>
    runServer(stack, api.movies.scanner.missing, { lease, paths: [...paths] }, Marked),
  );

/** Every file the library knows inside its folders, page by page. */
export const knownFiles = async (
  stack: CoreStack,
  lease: Lease,
  cursor: string | null = null,
  seen: ReadonlyArray<(typeof Known.Type & { outcome: "held" })["value"]["files"][number]> = [],
): Promise<typeof seen> => {
  const page = await runServer(stack, api.movies.scanner.known, { lease, cursor }, Known);

  if (page.outcome !== "held") throw new Error(`known answered ${page.outcome}`);

  const next = [...seen, ...page.value.files];

  return page.value.isDone ? next : knownFiles(stack, lease, page.value.continueCursor, next);
};

/** A library's totals as its counters hold them. */
export const totalsOf = (stack: CoreStack, libraryId: Id<"libraries">): Promise<Totals> =>
  runFunction(stack, internal.movies.probe.totals, { libraryId }, Totals);

/** A library's rows counted one by one, for comparing with its counters. */
export const rowsOf = async (
  stack: CoreStack,
  libraryId: Id<"libraries">,
  cursor: string | null = null,
  sum: Totals = { titles: 0, episodes: 0, files: 0 },
): Promise<Totals> => {
  const page = await runFunction(
    stack,
    internal.movies.probe.rows,
    { libraryId, cursor },
    RowsPage,
  );

  const next = {
    titles: sum.titles + page.counted.titles,
    episodes: sum.episodes + page.counted.episodes,
    files: sum.files + page.counted.files,
  };

  return page.isDone ? next : rowsOf(stack, libraryId, page.continueCursor, next);
};

/** Whether any title or file of the library is left. */
export const hasRows = (stack: CoreStack, libraryId: Id<"libraries">): Promise<boolean> =>
  runFunction(stack, internal.movies.probe.hasRows, { libraryId }, Schema.Boolean);

/** Whether any shard of the library's episode or file totals is left. */
export const hasTotals = (stack: CoreStack, libraryId: Id<"libraries">): Promise<boolean> =>
  runFunction(stack, internal.movies.probe.hasTotals, { libraryId }, Schema.Boolean);

/** Ends a held job as succeeded, which frees its slot for the next test's claim. */
export const finishJob = (stack: CoreStack, lease: Lease) =>
  retrying(() =>
    runServer(
      stack,
      api.core.jobs.worker.finish,
      { lease, end: { outcome: "succeeded" } },
      Schema.Struct({ outcome: Schema.String }),
    ),
  );

/** The most files or paths one scanner call takes as arguments. */
const SCANNER_BATCH = 500;

const chunks = <Item>(items: ReadonlyArray<Item>): ReadonlyArray<ReadonlyArray<Item>> =>
  Array.from({ length: Math.ceil(items.length / SCANNER_BATCH) }, (_, n) =>
    items.slice(n * SCANNER_BATCH, (n + 1) * SCANNER_BATCH),
  );

/**
 * Sends `items` as the server does: up to 500 a call, and what a call's budget left unwritten
 * again, until every item is written. Answers how many items each call wrote.
 */
export const upsertAll = async (
  stack: CoreStack,
  lease: Lease,
  items: ReadonlyArray<ScannedItem>,
  written: ReadonlyArray<number> = [],
): Promise<ReadonlyArray<number>> => {
  const [batch] = chunks(items);

  if (batch === undefined) return written;

  const landed = await upsert(stack, lease, batch);

  if (landed.outcome !== "held") throw new Error(`upsert answered ${landed.outcome}`);

  if (landed.value.done < 1) throw new Error("an upsert wrote nothing");

  return upsertAll(stack, lease, items.slice(landed.value.done), [...written, landed.value.done]);
};

/** `upsertAll` for paths a scan did not find. Answers how many paths each call got through. */
export const markMissingAll = async (
  stack: CoreStack,
  lease: Lease,
  paths: ReadonlyArray<string>,
  done: ReadonlyArray<number> = [],
): Promise<ReadonlyArray<number>> => {
  const [batch] = chunks(paths);

  if (batch === undefined) return done;

  const marked = await markMissing(stack, lease, batch);

  if (marked.outcome !== "held") throw new Error(`missing answered ${marked.outcome}`);

  if (marked.value.done < 1) throw new Error("a missing call got through nothing");

  return markMissingAll(stack, lease, paths.slice(marked.value.done), [...done, marked.value.done]);
};

const TitleState = Schema.NullOr(
  Schema.Struct({
    purging: Schema.Boolean,
    episodes: Schema.Finite,
    seasons: Schema.Finite,
    genres: Schema.Finite,
    seasonsHoldEpisodes: Schema.Boolean,
  }),
);

/** A title's state after a purge, or null once it is gone. */
export const titleStateOf = (stack: CoreStack, titleId: Id<"titles">) =>
  runFunction(stack, internal.movies.probe.titleState, { titleId }, TitleState);

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

const PurgeNext = Schema.Struct({ cursor: Schema.NullOr(Schema.String), more: Schema.Boolean });

/** Runs one page of a purge stage, scheduling nothing, and answers where the stage goes next. */
export const purgePage = (
  stack: CoreStack,
  libraryId: Id<"libraries">,
  stage: "files" | "titles",
  cursor: string | null,
  ranges?: number,
) =>
  runFunction(
    stack,
    internal.movies.probe.purgePage,
    ranges === undefined ? { libraryId, stage, cursor } : { libraryId, stage, cursor, ranges },
    PurgeNext,
  );

/** Runs a purge stage page by page to its end. */
export const purgeStage = async (
  stack: CoreStack,
  libraryId: Id<"libraries">,
  stage: "files" | "titles",
  cursor: string | null = null,
): Promise<void> => {
  const next = await purgePage(stack, libraryId, stage, cursor);

  if (next.more) await purgeStage(stack, libraryId, stage, next.cursor);
};

const Applied = answer(Schema.Struct({ done: Schema.Finite, applied: Schema.Boolean }));

/** What a metadata job's writes came to: episodes written per call, and whether it still applied. */
export interface MetadataRun {
  readonly written: ReadonlyArray<number>;
  readonly applied: boolean;
}

/**
 * Writes a title's metadata and every episode as the server does: sends again what a call's
 * budget left, and stops the job at the first call that answers it is no longer current.
 */
export const applyMetadataAll = async (
  stack: CoreStack,
  lease: Lease,
  titleId: Id<"titles">,
  title: ScannedItem["title"],
  episodes: ReadonlyArray<NonNullable<ScannedItem["episode"]>>,
  written: ReadonlyArray<number> = [],
): Promise<MetadataRun> => {
  const answered = await runServer(
    stack,
    api.movies.metadata.applyMetadata,
    { lease, titleId, title, episodes: [...episodes] },
    Applied,
  );

  if (answered.outcome !== "held") throw new Error(`applyMetadata answered ${answered.outcome}`);

  const { done, applied } = answered.value;

  if (!applied) return { written, applied: false };

  const next = [...written, done];

  if (done >= episodes.length) return { written: next, applied: true };

  if (done < 1) throw new Error("applyMetadata wrote no episode");

  return applyMetadataAll(stack, lease, titleId, title, episodes.slice(done), next);
};

/** Asks for an admin's match of a title, as the movies command will. */
export const askMatch = (stack: CoreStack, titleId: Id<"titles">, providerId: string) =>
  runFunction(stack, internal.movies.probe.askMatch, { titleId, providerId }, JobId);

/** Asks for a refresh of a title's metadata, as the movies command will. */
export const askRefresh = (stack: CoreStack, titleId: Id<"titles">) =>
  runFunction(stack, internal.movies.probe.askRefresh, { titleId }, JobId);
