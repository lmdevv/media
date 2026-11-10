import { v } from "convex/values";
import type { Infer } from "convex/values";

import { register } from "../../commands/movies/imports";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../_generated/server";
import { importOfJob, startImport } from "../core/imports";
import { leaseAnswer, withJobLease } from "../core/jobs/held";
import type { LeaseAnswer } from "../core/jobs/held";
import { importSource } from "../core/jobs/kinds";
import type { ImportKind, PayloadOf } from "../core/jobs/kinds";
import { lease } from "../core/jobs/model";
import type { Lease } from "../core/jobs/model";
import type { JobCtx } from "../core/jobs/store";
import type { Caller } from "../core/auth/caller";
import { FOLDERS_MAX } from "../core/folders";
import { fail } from "../core/lib/errors";
import { paginate, paginateAtMost } from "../core/lib/paginate";
import { serverMutation, serverQuery } from "../core/lib/serverFacing";
import { SERVER, can, principalOf } from "../core/permissions/policy";
import { hasLibraries } from "../core/scans";
import { BOUNDS, IMPORT_BOUNDS, idsWithin } from "./bounds";
import { budgetFor, work } from "./budget";
import type { Work } from "./budget";
import { overridesCost, writeOverrides } from "./catalog";
import { DOCUMENT_BYTES } from "./fit";
import { askForRefresh } from "./matching";
import { CALL_READS } from "./reads";
import {
  externalIds,
  importCheckpoint,
  importPlan,
  importedCounts,
  metadataOverrides,
  nullable,
  titleKind,
} from "./validators";
import { findProgress, nextWatchGeneration, writeProgress } from "./viewing";
import {
  insertCollection,
  insertCollectionItem,
  insertImportPlan,
  insertListEntry,
  patchCollection,
  patchImportPlan,
  patchProgress,
  patchTitle,
} from "./write";

const IMPORT_KINDS = ["movies.import.jellyfin", "movies.import.plex"] as const;

/**
 * Members one collection's rows are read with: its imported members and the ones its titles'
 * metadata added, which share it only when a source key names a metadata collection.
 */
const MEMBERS_READ = 2 * IMPORT_BOUNDS.members;

/** Files one catalog page reads, with their titles and episodes: at most 9.6 MiB at their bounds. */
const CATALOG_PAGE = 100;

const TARGETS_PAGE = 500;

const LIBRARIES_PAGE = 50;

const PROGRESS_PAGE = 1000;

/** Runs one `movies.imports.list` page reads, each with its job and its plan at their bounds. */
const RUNS_PAGE_MAX = 20;

/** A user row, which holds a name, its keys, and generation counters. */
const USER_BYTES = 4 * 1024;

type Checkpoint = Infer<typeof importCheckpoint>;

type Counts = Infer<typeof importedCounts>;

const NOTHING_IMPORTED: Counts = {
  watched: 0,
  inProgress: 0,
  favorites: 0,
  collections: 0,
  overrides: 0,
  keptLocal: 0,
  unmatched: 0,
};

const PHASES: ReadonlyArray<Checkpoint["phase"]> = [
  "watchState",
  "collections",
  "overrides",
  "done",
];

const sameCheckpoint = (left: Checkpoint, right: Checkpoint): boolean =>
  left.phase === right.phase && left.unit === right.unit && left.cursor === right.cursor;

const isLater = (next: Checkpoint, current: Checkpoint): boolean => {
  const order = [PHASES.indexOf(next.phase), next.unit, next.cursor];
  const before = [PHASES.indexOf(current.phase), current.unit, current.cursor];
  const differs = order.findIndex((value, index) => value !== before[index]);

  return differs !== -1 && (order[differs] ?? 0) > (before[differs] ?? 0);
};

/**
 * Where a write leaves the checkpoint: at `continueAt`, where the server's next items start, once it
 * wrote every item it was sent, so moving past an empty user or phase takes no call of its own;
 * otherwise where it got to.
 */
const landing = (reached: Checkpoint, wroteAll: boolean, continueAt: Checkpoint | undefined) => {
  if (!wroteAll || continueAt === undefined) return reached;

  if (
    !isCheckpoint(continueAt) ||
    !(isLater(continueAt, reached) || sameCheckpoint(continueAt, reached))
  ) {
    return fail("invalid_args", "An import's checkpoint only moves forward");
  }

  return continueAt;
};

const isCheckpoint = (checkpoint: Checkpoint): boolean =>
  Number.isSafeInteger(checkpoint.unit) &&
  checkpoint.unit >= 0 &&
  Number.isSafeInteger(checkpoint.cursor) &&
  checkpoint.cursor >= 0;

/**
 * One step's worst case: the index ranges it reads and the documents it writes (`budget.ts`), and
 * the bytes its reads may return at the bounds their writers keep (`reads.ts`).
 */
interface Cost {
  readonly work: Work;
  readonly bytes: number;
}

const costOf = (ranges: number, writes: number, bytes: number): Cost => ({
  work: work(ranges, writes),
  bytes,
});

/**
 * One call's allowance, charged with each step's worst case before it runs, as the movies writers
 * charge theirs (`budget.ts`), and with the bytes it may read against what one call may read
 * (`reads.ts`). A step that does not fit does not start, so the call commits what it did and says
 * how far it got. The first step always runs.
 */
interface Allowance {
  readonly take: (cost: Cost) => boolean;
}

const allowanceFor = (fixed: Cost): Allowance => {
  const budget = budgetFor(fixed.work);
  let bytes = fixed.bytes;
  let steps = 0;

  return {
    take: (cost) => {
      const fits = steps === 0 || bytes + cost.bytes <= CALL_READS.bytes;

      if (!fits || !budget.admits(cost.work)) return false;

      budget.spend(cost.work);
      bytes += cost.bytes;
      steps += 1;

      return true;
    },
  };
};

/**
 * What every lease-checked call costs before its items: the job and its kind's row through the
 * lease check, the import row, and the plan row at its bound.
 */
const FIXED_COST = costOf(20, 8, DOCUMENT_BYTES.importPlans + 16 * 1024);

const checkCount = (count: number, max: number, what: string): void => {
  if (count > max) fail("invalid_args", `Send at most ${max} ${what} per call`);
};

interface HeldImport {
  readonly started: Doc<"imports">;
  readonly row: Doc<"importPlans">;
}

/**
 * Runs `write` for the import whose job `held` leases, after the lease check (ADR 0012), in the
 * caller's mutation, so a canceled or replaced attempt writes nothing.
 *
 * @throws Error when the leased import has no plan row, which only `start` writes with its job.
 */
const withImport = <Value>(
  ctx: JobCtx,
  held: Lease,
  write: (found: HeldImport) => Promise<LeaseAnswer<Value>>,
): Promise<LeaseAnswer<Value>> =>
  withJobLease(ctx, IMPORT_KINDS, held, async (job) => {
    const started = await importOfJob(ctx.db, job.jobId);

    const row =
      started === null
        ? null
        : await ctx.db
            .query("importPlans")
            .withIndex("by_import", (q) => q.eq("importId", started._id))
            .unique();

    if (started === null || row === null)
      throw new Error(`The import job ${job.jobId} has no plan`);

    return write({ started, row });
  });

const held = <Value>(value: Value): LeaseAnswer<Value> => ({ outcome: "held", value });

const added = (counts: Counts, more: Partial<Counts>): Counts => ({
  watched: counts.watched + (more.watched ?? 0),
  inProgress: counts.inProgress + (more.inProgress ?? 0),
  favorites: counts.favorites + (more.favorites ?? 0),
  collections: counts.collections + (more.collections ?? 0),
  overrides: counts.overrides + (more.overrides ?? 0),
  keptLocal: counts.keptLocal + (more.keptLocal ?? 0),
  unmatched: more.unmatched ?? counts.unmatched,
});

const checkUnmatched = (unmatched: number): void => {
  if (!Number.isSafeInteger(unmatched) || unmatched < 0) {
    fail("invalid_args", "The unmatched count is a whole number, 0 or more");
  }
};

const isHousehold = (user: Doc<"users"> | null): boolean =>
  user !== null && user.kind === "person" && user.role !== "guest";

const catalogFile = v.object({
  fileId: v.id("mediaFiles"),
  libraryId: v.id("libraries"),
  path: v.string(),
  missing: v.boolean(),
  titleId: v.id("titles"),
  kind: titleKind,
  externalIds,
  episodeId: nullable(v.id("episodes")),
  seasonNumber: nullable(v.number()),
  episodeNumber: nullable(v.number()),
});

const cursorArgs = { cursor: nullable(v.string()) };

const pageEnd = { continueCursor: v.string(), isDone: v.boolean() };

/** A page of the household, whose people source users map onto. */
export const targets = serverQuery({
  args: cursorArgs,
  returns: v.object({
    users: v.array(v.object({ userId: v.id("users"), username: v.string() })),
    ...pageEnd,
  }),
  handler: async (ctx, { cursor }) => {
    const page = await paginate(
      ctx.db,
      {
        table: "users",
        index: "by_kind_username_key",
        range: (q) => q.eq("kind", "person"),
      },
      { numItems: TARGETS_PAGE, cursor },
    );

    return {
      users: page.page.flatMap((user) =>
        user.kind === "person" && user.role !== "guest"
          ? [{ userId: user._id, username: user.username }]
          : [],
      ),
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/** A page of the movies libraries and their folders, which decide what an import can match. */
export const libraries = serverQuery({
  args: cursorArgs,
  returns: v.object({
    libraries: v.array(v.object({ libraryId: v.id("libraries"), folders: v.array(v.string()) })),
    ...pageEnd,
  }),
  handler: async (ctx, { cursor }) => {
    const page = await paginate(
      ctx.db,
      { table: "libraries", index: "by_kind", range: (q) => q.eq("kind", "movies") },
      { numItems: LIBRARIES_PAGE, cursor },
    );

    const found = await Promise.all(
      page.page.map(async (library) => ({
        libraryId: library._id,
        folders: (
          await ctx.db
            .query("libraryFolders")
            .withIndex("by_library_path", (q) => q.eq("libraryId", library._id))
            .take(FOLDERS_MAX)
        ).map((folder) => folder.path),
      })),
    );

    return { libraries: found, continueCursor: page.continueCursor, isDone: page.isDone };
  },
});

/**
 * A page of every movies file with what matching needs: its title's kind and provider ids and its
 * episode's numbers. Files whose title is gone or being purged are left out, so a page can come
 * back short.
 */
export const catalog = serverQuery({
  args: cursorArgs,
  returns: v.object({ files: v.array(catalogFile), ...pageEnd }),
  handler: async (ctx, { cursor }) => {
    const page = await paginate(
      ctx.db,
      { table: "mediaFiles", index: "by_creation_time" },
      { numItems: CATALOG_PAGE, cursor },
    );

    const titles = new Map<Id<"titles">, Promise<Doc<"titles"> | null>>();

    const titleOf = (titleId: Id<"titles">): Promise<Doc<"titles"> | null> => {
      const known = titles.get(titleId);

      if (known !== undefined) return known;

      const read = ctx.db.get(titleId);

      titles.set(titleId, read);

      return read;
    };

    const files = await Promise.all(
      page.page.map(async (file) => {
        const title = await titleOf(file.titleId);
        const episode = file.episodeId === null ? null : await ctx.db.get(file.episodeId);

        return title === null || title.purging === true
          ? []
          : [
              {
                fileId: file._id,
                libraryId: file.libraryId,
                path: file.path,
                missing: file.missing,
                titleId: title._id,
                kind: title.kind,
                externalIds: title.externalIds,
                episodeId: episode?._id ?? null,
                seasonNumber: episode?.seasonNumber ?? null,
                episodeNumber: episode?.episodeNumber ?? null,
              },
            ];
      }),
    );

    return { files: files.flat(), continueCursor: page.continueCursor, isDone: page.isDone };
  },
});

/** A page of one user's progress rows, for a dry run to compare with the source's. */
export const progress = serverQuery({
  args: { userId: v.id("users"), ...cursorArgs },
  returns: v.object({
    rows: v.array(
      v.object({
        titleId: v.id("titles"),
        episodeId: nullable(v.id("episodes")),
        watched: v.boolean(),
        positionMs: v.number(),
        lastPlayedAt: v.number(),
      }),
    ),
    ...pageEnd,
  }),
  handler: async (ctx, { userId, cursor }) => {
    const page = await paginate(
      ctx.db,
      {
        table: "watchProgress",
        index: "by_user_played",
        range: (q) => q.eq("userId", userId),
      },
      { numItems: PROGRESS_PAGE, cursor },
    );

    return {
      rows: page.page.map((row) => ({
        titleId: row.titleId,
        episodeId: row.episodeId,
        watched: row.watched,
        positionMs: row.positionMs,
        lastPlayedAt: row.lastPlayedAt,
      })),
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

type Plan = Infer<typeof importPlan>;

const within = (text: string, max: number, what: string): void => {
  if (text.length > max) fail("invalid_args", `${what} holds at most ${max} characters`);
};

const checkPlan = (serverId: string, serverName: string, plan: Plan): void => {
  if (serverId.length === 0) fail("invalid_args", "The source server's id is not blank");

  within(serverId, IMPORT_BOUNDS.sourceId, "A server id");
  within(serverName, IMPORT_BOUNDS.serverName, "A server name");
  within(plan.sourceUrl, IMPORT_BOUNDS.sourceUrl, "A server address");
  within(plan.credentials.nonce, IMPORT_BOUNDS.sealed, "The sealed credentials");
  within(plan.credentials.ciphertext, IMPORT_BOUNDS.sealed, "The sealed credentials");
  checkCount(plan.users.length, IMPORT_BOUNDS.users, "mapped users");
  checkCount(plan.pathMappings.length, IMPORT_BOUNDS.pathMappings, "path mappings");

  for (const user of plan.users) within(user.sourceUserId, IMPORT_BOUNDS.sourceId, "A user id");

  for (const mapping of plan.pathMappings) {
    within(mapping.from, IMPORT_BOUNDS.folder, "A folder");
    within(mapping.to, IMPORT_BOUNDS.folder, "A folder");
  }

  if (new Set(plan.users.map((user) => user.sourceUserId)).size !== plan.users.length) {
    fail("invalid_args", "Map each source user once");
  }
};

/**
 * Whether `user` may import from Jellyfin or Plex: an owner or an admin. An import points the
 * server at folders on its own disk through its path mappings, as a library's folders do, so it
 * takes the same right (ADR 0024).
 */
const mayImportAs = (user: Doc<"users"> | null): boolean =>
  user !== null && can(principalOf(user), "manageFolders", SERVER).allowed;

/** Whether `userId` may import, which the server's import flow asks before it connects. */
export const mayImport = serverQuery({
  args: { userId: v.id("users") },
  returns: v.boolean(),
  handler: async (ctx, { userId }) => mayImportAs(await ctx.db.get(userId)),
});

/**
 * Starts an import of one source server for `requestedBy`, an owner or an admin: the server's
 * import flow calls this once its dry run with the same users is done. While an import of the
 * same server is queued or running, this answers that one with `created: false` and writes
 * nothing, so a double-submitted import runs once. Each mapped user must be someone in the
 * household; a source user mapped to no one is absent from the plan and never imported.
 */
export const start = serverMutation({
  args: {
    requestedBy: v.id("users"),
    source: importSource,
    serverId: v.string(),
    serverName: v.string(),
    plan: importPlan,
  },
  returns: v.object({ importId: v.id("imports"), jobId: v.id("jobs"), created: v.boolean() }),
  handler: async (ctx, { requestedBy, source, serverId, serverName, plan }) => {
    if (!mayImportAs(await ctx.db.get(requestedBy))) {
      return fail("forbidden", "Only an owner or an admin can import from Jellyfin or Plex");
    }

    checkPlan(serverId, serverName, plan);

    const mapped = await Promise.all(plan.users.map(async (user) => ctx.db.get(user.userId)));

    if (!mapped.every(isHousehold)) {
      return fail(
        "invalid_args",
        "A mapped user is no longer in the household; run the dry run again",
      );
    }

    if (!(await hasLibraries(ctx.db, "movies"))) {
      return fail(
        "conflict",
        "Add a movies library first: an import matches into libraries and adds none",
      );
    }

    const payload: PayloadOf<ImportKind> =
      source === "jellyfin"
        ? { kind: "movies.import.jellyfin", source, serverId }
        : { kind: "movies.import.plex", source, serverId };

    const started = await startImport(ctx, payload, serverName);

    if (started.created) {
      await insertImportPlan(ctx.db, {
        importId: started.importId,
        requestedBy,
        plan,
        checkpoint: { phase: "watchState", unit: 0, cursor: 0 },
        imported: NOTHING_IMPORTED,
      });
    }

    return started;
  },
});

/** A held import's server, plan, checkpoint, and counts, so a worker resumes where the last stopped. */
export const state = serverMutation({
  args: { lease },
  returns: leaseAnswer(
    v.object({
      source: importSource,
      serverId: v.string(),
      serverName: v.string(),
      plan: importPlan,
      checkpoint: importCheckpoint,
      imported: importedCounts,
    }),
  ),
  handler: (ctx, { lease: leased }) =>
    withImport(ctx, leased, async ({ started, row }) =>
      held({
        source: started.source,
        serverId: started.serverId,
        serverName: started.serverName,
        plan: row.plan,
        checkpoint: row.checkpoint,
        imported: row.imported,
      }),
    ),
});

/**
 * Moves a held import's checkpoint from `at` to the later `to`, such as to the next user or phase,
 * and records how many source items matched nothing. A call whose `at` is not the stored
 * checkpoint, such as one sent again after it committed, moves nothing and answers the stored one.
 */
export const advance = serverMutation({
  args: { lease, at: importCheckpoint, to: importCheckpoint, unmatched: v.number() },
  returns: leaseAnswer(v.object({ at: importCheckpoint, imported: importedCounts })),
  handler: (ctx, { lease: leased, at, to, unmatched }) =>
    withImport(ctx, leased, async ({ row }) => {
      checkUnmatched(unmatched);

      if (!sameCheckpoint(row.checkpoint, at)) {
        return held({ at: row.checkpoint, imported: row.imported });
      }

      if (!isCheckpoint(to) || !isLater(to, at)) {
        return fail("invalid_args", "An import's checkpoint only moves forward");
      }

      const imported = added(row.imported, { unmatched });

      await patchImportPlan(ctx.db, row._id, { checkpoint: to, imported });

      return held({ at: to, imported });
    }),
});

/** What a write answers: how many items it got through, the checkpoint now, and the counts. */
const written = v.object({ done: v.number(), at: importCheckpoint, imported: importedCounts });

const watchItem = v.object({
  userId: v.id("users"),
  titleId: v.id("titles"),
  episodeId: nullable(v.id("episodes")),
  fileId: nullable(v.id("mediaFiles")),
  watched: v.boolean(),
  positionMs: v.number(),
  playCount: v.number(),
  lastPlayedAt: nullable(v.number()),
  favorite: v.boolean(),
});

type WatchItem = Infer<typeof watchItem>;

type WatchCounts = Pick<Counts, "watched" | "inProgress" | "favorites" | "keptLocal">;

const NO_CHANGE: WatchCounts = { watched: 0, inProgress: 0, favorites: 0, keptLocal: 0 };

/**
 * One watch item at worst: its user, title, episode, and file read; its progress row read twice
 * and written; its history generation read and written; its list entry read and written.
 */
const WATCH_COST = costOf(
  12,
  4,
  USER_BYTES +
    DOCUMENT_BYTES.titles +
    DOCUMENT_BYTES.episodes +
    DOCUMENT_BYTES.mediaFiles +
    4 * DOCUMENT_BYTES.small,
);

const millis = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

const checkWatchItem = (item: WatchItem): void => {
  const valid =
    millis(item.positionMs) &&
    millis(item.playCount) &&
    (item.lastPlayedAt === null || millis(item.lastPlayedAt));

  if (!valid) fail("invalid_args", "Positions, play counts, and play times are whole numbers");
};

/**
 * Imports one item's progress the way an offline report lands (`movies.play.reportOffline`): only
 * when the source played it more recently than the core did, or the core has no row, so an import
 * never moves a newer row back. Each write moves the user's history generation of the title, so a
 * whole-show mark asked for earlier writes nothing over it (`viewing.ts`). A watched mark only
 * gets set.
 */
const importProgress = async (
  ctx: Pick<MutationCtx, "db">,
  item: WatchItem,
  title: Doc<"titles">,
  file: Doc<"mediaFiles"> | null,
): Promise<WatchCounts> => {
  const played = item.watched || item.positionMs > 0 || item.playCount > 0;

  if (!played || (title.kind === "show" && item.episodeId === null)) return NO_CHANGE;

  const existing = await findProgress(ctx.db, item.userId, item.titleId, item.episodeId);

  const sourceNewer =
    existing === null || (item.lastPlayedAt !== null && existing.lastPlayedAt < item.lastPlayedAt);

  const wasWatched = existing?.watched === true;
  const watched = item.watched && !wasWatched ? 1 : 0;

  if (sourceNewer) {
    await writeProgress(ctx, {
      userId: item.userId,
      titleId: item.titleId,
      episodeId: item.episodeId,
      fileId: file?._id ?? null,
      positionMs: item.positionMs,
      durationMs: file?.probe.durationMs ?? existing?.durationMs ?? 0,
      watched: item.watched,
      playedAt: item.lastPlayedAt ?? existing?.lastPlayedAt ?? 0,
      origin: null,
    });

    await nextWatchGeneration(ctx, item.userId, item.titleId);

    const moved = item.positionMs > 0 && existing?.positionMs !== item.positionMs;

    return { ...NO_CHANGE, watched, inProgress: moved ? 1 : 0 };
  }

  if (watched === 1) {
    await patchProgress(ctx.db, existing._id, { watched: true, updatedAt: Date.now() });
    await nextWatchGeneration(ctx, item.userId, item.titleId);
  }

  const differs = existing.positionMs !== item.positionMs || existing.watched !== item.watched;

  return { ...NO_CHANGE, watched, keptLocal: differs ? 1 : 0 };
};

/** Adds a favorite movie or show to the user's list once. */
const importFavorite = async (ctx: Pick<MutationCtx, "db">, item: WatchItem): Promise<number> => {
  if (!item.favorite || item.episodeId !== null) return 0;

  const listed = await ctx.db
    .query("myList")
    .withIndex("by_user_title", (q) => q.eq("userId", item.userId).eq("titleId", item.titleId))
    .unique();

  if (listed !== null) return 0;

  await insertListEntry(ctx.db, {
    userId: item.userId,
    titleId: item.titleId,
    addedAt: item.lastPlayedAt ?? Date.now(),
  });

  return 1;
};

/**
 * Imports one watch item for its user. An item for a user the plan does not map, or one no longer
 * in the household, a title gone or being purged, or an episode of another title writes nothing.
 */
const importWatchItem = async (
  ctx: Pick<MutationCtx, "db">,
  mapped: ReadonlySet<string>,
  household: (userId: Id<"users">) => Promise<boolean>,
  item: WatchItem,
): Promise<WatchCounts> => {
  if (!mapped.has(item.userId) || !(await household(item.userId))) return NO_CHANGE;

  const [title, episode, found] = await Promise.all([
    ctx.db.get(item.titleId),
    item.episodeId === null ? null : ctx.db.get(item.episodeId),
    item.fileId === null ? null : ctx.db.get(item.fileId),
  ]);

  if (title === null || title.purging === true) return NO_CHANGE;

  if (item.episodeId !== null && episode?.titleId !== title._id) return NO_CHANGE;

  const file =
    found !== null && found.titleId === title._id && found.episodeId === item.episodeId
      ? found
      : null;

  const progressed = await importProgress(ctx, item, title, file);

  return { ...progressed, favorites: await importFavorite(ctx, item) };
};

/**
 * Writes the leading watch items of up to 500 for the held import, from the checkpoint `at`, as
 * many as the call's budget admits, and moves the checkpoint past them, or to `continueAt` once it
 * wrote them all, in the same mutation. Answers how many it wrote (`done`), the checkpoint now,
 * and the counts; a call whose `at` is not the stored checkpoint writes nothing and answers the
 * stored one. `unmatched` records how many source items matched nothing.
 */
export const writeWatchState = serverMutation({
  args: {
    lease,
    at: importCheckpoint,
    continueAt: v.optional(importCheckpoint),
    unmatched: v.number(),
    items: v.array(watchItem),
  },
  returns: leaseAnswer(written),
  handler: (ctx, { lease: leased, at, continueAt, unmatched, items }) =>
    withImport(ctx, leased, async ({ row }) => {
      checkCount(items.length, IMPORT_BOUNDS.items, "watch items");
      checkUnmatched(unmatched);
      items.forEach(checkWatchItem);

      if (!sameCheckpoint(row.checkpoint, at)) {
        return held({ done: 0, at: row.checkpoint, imported: row.imported });
      }

      if (at.phase !== "watchState") throw new Error(`Watch state was sent at ${at.phase}`);

      const mapped = new Set<string>(row.plan.users.map((user) => user.userId));
      const people = new Map<Id<"users">, Promise<boolean>>();

      const household = (userId: Id<"users">): Promise<boolean> => {
        const known = people.get(userId);

        if (known !== undefined) return known;

        const read = ctx.db.get(userId).then(isHousehold);

        people.set(userId, read);

        return read;
      };

      const allowance = allowanceFor(FIXED_COST);

      const writeFrom = async (
        index: number,
        done: ReadonlyArray<WatchCounts>,
      ): Promise<ReadonlyArray<WatchCounts>> => {
        const item = items[index];

        if (item === undefined || !allowance.take(WATCH_COST)) return done;

        const counts = await importWatchItem(ctx, mapped, household, item);

        return writeFrom(index + 1, [...done, counts]);
      };

      const wrote = await writeFrom(0, []);

      const sum = (pick: (counts: WatchCounts) => number) =>
        wrote.reduce((total, counts) => total + pick(counts), 0);

      const next = landing(
        { ...at, cursor: at.cursor + wrote.length },
        wrote.length === items.length,
        continueAt,
      );

      const imported = added(row.imported, {
        watched: sum((counts) => counts.watched),
        inProgress: sum((counts) => counts.inProgress),
        favorites: sum((counts) => counts.favorites),
        keptLocal: sum((counts) => counts.keptLocal),
        unmatched,
      });

      await patchImportPlan(ctx.db, row._id, { checkpoint: next, imported });

      return held({ done: wrote.length, at: next, imported });
    }),
});

const collectionImport = v.object({
  /** Stable across runs: the source, its server id, and the collection's id there. */
  sourceKey: v.string(),
  name: v.string(),
  sortName: nullable(v.string()),
  titleIds: v.array(v.id("titles")),
});

type CollectionImport = Infer<typeof collectionImport>;

/** One member at worst: its title read, and its row written. */
const MEMBER_COST = costOf(1, 1, DOCUMENT_BYTES.titles);

/** Finding a collection by its key and writing it. */
const COLLECTION_COST = costOf(3, 1, DOCUMENT_BYTES.collections);

/** Reading a collection's members, before any is deleted. */
const MEMBERS_COST = costOf(1, 0, MEMBERS_READ * DOCUMENT_BYTES.small);

/** Deleting `count` of its imported members. */
const deletesOf = (count: number): Cost => costOf(count, count, 0);

const collectionBy = (db: DatabaseReader, sourceKey: string) =>
  db
    .query("collections")
    .withIndex("by_source_key", (q) => q.eq("sourceKey", sourceKey))
    .unique();

const membersOf = (db: DatabaseReader, collectionId: Id<"collections">) =>
  db
    .query("collectionItems")
    .withIndex("by_collection_position", (q) => q.eq("collectionId", collectionId))
    .take(MEMBERS_READ);

/** The titles to import into `item`, in its order, without the ones its metadata already lists. */
const wantedTitles = (
  item: CollectionImport,
  members: ReadonlyArray<Doc<"collectionItems">>,
): ReadonlyArray<Id<"titles">> => {
  const kept = new Set(
    members.flatMap((member) => (member.source === "metadata" ? [member.titleId] : [])),
  );

  return [...new Set(item.titleIds)].filter((titleId) => !kept.has(titleId));
};

interface Reached {
  readonly members: number;
  readonly finished: boolean;
}

/**
 * Writes one collection from member `from` as far as `allowance` lets it. From its first member,
 * it writes the collection's name and replaces its imported members, keeping the ones its titles'
 * metadata added. A member whose title is gone or being purged is left out; each member keeps its
 * place in the source's order. Answers how far it got, `null` when the allowance had no room for
 * even the collection.
 */
const writeCollection = async (
  ctx: Pick<MutationCtx, "db">,
  allowance: Allowance,
  item: CollectionImport,
  from: number,
): Promise<Reached | null> => {
  if (!allowance.take(COLLECTION_COST)) return null;

  const name = item.name.trim() || "Collection";
  const sortKey = (item.sortName ?? name).trim().toLowerCase() || name.toLowerCase();
  const now = Date.now();
  const existing = await collectionBy(ctx.db, item.sourceKey);
  const restart = from === 0 || existing === null;

  const collectionId =
    existing?._id ??
    (await insertCollection(ctx.db, {
      name,
      sortKey,
      sourceKey: item.sourceKey,
      createdAt: now,
      updatedAt: now,
      overview: null,
      poster: null,
      backdrop: null,
    }));

  if (existing !== null && restart) {
    await patchCollection(ctx.db, existing, { name, sortKey, updatedAt: now });
  }

  if (!allowance.take(MEMBERS_COST)) return { members: restart ? 0 : from, finished: false };

  const members = await membersOf(ctx.db, collectionId);
  const imported = members.filter((member) => member.source !== "metadata");

  if (restart) {
    if (!allowance.take(deletesOf(imported.length))) return { members: 0, finished: false };

    await Promise.all(imported.map(async (member) => ctx.db.delete(member._id)));
  }

  const titles = wantedTitles(item, members);
  const first = restart ? 0 : from;

  const step = async (position: number): Promise<Reached> => {
    const titleId = titles[position];

    if (titleId === undefined) return { members: position, finished: true };

    if (!allowance.take(MEMBER_COST)) return { members: position, finished: false };

    const title = await ctx.db.get(titleId);

    if (title !== null && title.purging !== true) {
      await insertCollectionItem(ctx.db, { collectionId, titleId, position, source: "import" });
    }

    return step(position + 1);
  };

  return step(first);
};

/**
 * Writes up to 10 of the source's collections for the held import, from the checkpoint `at` (the
 * collection index in its cursor, the member index in its unit), as far as the call's budget
 * admits, and moves the checkpoint, or to `continueAt` once it finished them all, in the same
 * mutation. A long collection takes several calls. Answers how many collections it finished
 * (`done`), the checkpoint now, and the counts; a call whose `at` is not the stored checkpoint
 * writes nothing and answers the stored one.
 */
export const writeCollections = serverMutation({
  args: {
    lease,
    at: importCheckpoint,
    continueAt: v.optional(importCheckpoint),
    items: v.array(collectionImport),
  },
  returns: leaseAnswer(written),
  handler: (ctx, { lease: leased, at, continueAt, items }) =>
    withImport(ctx, leased, async ({ row }) => {
      checkCount(items.length, IMPORT_BOUNDS.collections, "collections");

      for (const item of items) {
        within(item.sourceKey, BOUNDS.sourceKey, "A collection's source key");
        checkCount(item.titleIds.length, IMPORT_BOUNDS.members, "members of a collection");
      }

      if (!sameCheckpoint(row.checkpoint, at)) {
        return held({ done: 0, at: row.checkpoint, imported: row.imported });
      }

      if (at.phase !== "collections") throw new Error(`Collections were sent at ${at.phase}`);

      const allowance = allowanceFor(FIXED_COST);

      const through = async (index: number, from: number): Promise<Checkpoint> => {
        const item = items[index];
        const here = { phase: "collections" as const, unit: from, cursor: at.cursor + index };

        if (item === undefined) return here;

        const reached = await writeCollection(ctx, allowance, item, from);

        if (reached === null) return here;

        return reached.finished ? through(index + 1, 0) : { ...here, unit: reached.members };
      };

      const reached = await through(0, at.unit);
      const done = reached.cursor - at.cursor;
      const next = landing(reached, done === items.length && reached.unit === 0, continueAt);
      const imported = added(row.imported, { collections: done });

      await patchImportPlan(ctx.db, row._id, { checkpoint: next, imported });

      return held({ done, at: next, imported });
    }),
});

const overrideImport = v.object({
  titleId: v.id("titles"),
  overrides: metadataOverrides,
  /** The source's provider ids, which fill ids the title lacks and never replace one. */
  externalIds: v.optional(externalIds),
});

type OverrideImport = Infer<typeof overrideImport>;

type Overrides = Infer<typeof metadataOverrides>;

/** The oldest minimum viewer age a rating may ask for (ADR 0005). */
const AGE_RATING_MAX = 21;

const keptOverrides = (overrides: Overrides): Overrides => {
  const { name, sortName, year, ageRating, ...rest } = overrides;
  const kept: Overrides = rest;

  if (name !== undefined && name.trim() !== "") kept.name = name;

  if (sortName !== undefined && sortName.trim() !== "") kept.sortName = sortName;

  if (year !== undefined && Number.isInteger(year)) kept.year = year;

  if (
    ageRating !== undefined &&
    Number.isInteger(ageRating) &&
    ageRating >= 0 &&
    ageRating <= AGE_RATING_MAX
  ) {
    kept.ageRating = ageRating;
  }

  return kept;
};

/** Reading a title before its edits are costed. */
const TITLE_READ = costOf(1, 0, DOCUMENT_BYTES.titles);

/** Filling a title's provider ids, and queuing a metadata refresh when nothing matched it yet. */
const IDS_COST = costOf(14, 7, DOCUMENT_BYTES.titles);

/**
 * Fills the provider ids `title` lacks from the source's, never replacing one, and asks for a
 * refresh of a title nothing matched yet, so it matches at once. Answers the title as stored.
 */
const importExternalIds = async (
  ctx: JobCtx,
  title: Doc<"titles">,
  ids: Infer<typeof externalIds>,
): Promise<Doc<"titles">> => {
  const merged = {
    tmdb: title.externalIds.tmdb ?? ids.tmdb,
    imdb: title.externalIds.imdb ?? ids.imdb,
    tvdb: title.externalIds.tvdb ?? ids.tvdb,
  };

  const gained =
    merged.tmdb !== title.externalIds.tmdb ||
    merged.imdb !== title.externalIds.imdb ||
    merged.tvdb !== title.externalIds.tvdb;

  if (!gained) return title;

  const updated = await patchTitle(ctx.db, title, { externalIds: merged, updatedAt: Date.now() });

  if (updated.matchStatus === "unmatched") await askForRefresh(ctx, updated);

  return updated;
};

/**
 * Imports one title's edits and provider ids. Edits already on the core win. Answers whether the
 * item carried edits, `null` when the allowance had no room for it.
 */
const importOverride = async (
  ctx: JobCtx,
  allowance: Allowance,
  item: OverrideImport,
): Promise<boolean | null> => {
  if (!allowance.take(TITLE_READ)) return null;

  const title = await ctx.db.get(item.titleId);
  const carried = Object.keys(item.overrides).length > 0;

  if (title === null || title.purging === true) return carried;

  if (
    !allowance.take({ work: overridesCost(title), bytes: 0 }) ||
    (item.externalIds !== undefined && !allowance.take(IDS_COST))
  ) {
    return null;
  }

  const current =
    item.externalIds === undefined
      ? title
      : await importExternalIds(
          ctx,
          title,
          idsWithin({ externalIds: item.externalIds }).externalIds,
        );

  const overrides = { ...keptOverrides(item.overrides), ...current.overrides };
  const before = Object.keys(current.overrides ?? {}).length;

  if (Object.keys(overrides).length !== before) await writeOverrides(ctx.db, current, overrides);

  return carried;
};

/**
 * Writes the leading title edits of up to 500 for the held import, from the checkpoint `at`, as
 * many as the call's budget admits, and moves the checkpoint past them, or to `continueAt` once it got
 * through them all, in the same mutation. Answers how many it got through (`done`), the checkpoint
 * now, and the counts; a call whose `at` is not the stored checkpoint writes nothing and answers
 * the stored one.
 */
export const writeEdits = serverMutation({
  args: {
    lease,
    at: importCheckpoint,
    continueAt: v.optional(importCheckpoint),
    items: v.array(overrideImport),
  },
  returns: leaseAnswer(written),
  handler: (ctx, { lease: leased, at, continueAt, items }) =>
    withImport(ctx, leased, async ({ row }) => {
      checkCount(items.length, IMPORT_BOUNDS.items, "titles");

      if (!sameCheckpoint(row.checkpoint, at)) {
        return held({ done: 0, at: row.checkpoint, imported: row.imported });
      }

      if (at.phase !== "overrides") throw new Error(`Title edits were sent at ${at.phase}`);

      const allowance = allowanceFor(FIXED_COST);

      const importFrom = async (
        index: number,
        done: ReadonlyArray<boolean>,
      ): Promise<ReadonlyArray<boolean>> => {
        const item = items[index];
        const result = item === undefined ? null : await importOverride(ctx, allowance, item);

        return result === null ? done : importFrom(index + 1, [...done, result]);
      };

      const carried = await importFrom(0, []);

      const next = landing(
        { ...at, cursor: at.cursor + carried.length },
        carried.length === items.length,
        continueAt,
      );

      const imported = added(row.imported, { overrides: carried.filter(Boolean).length });

      await patchImportPlan(ctx.db, row._id, { checkpoint: next, imported });

      return held({ done: carried.length, at: next, imported });
    }),
});

/** A job's error: a failed job's, or the one a queued retry keeps from its last attempt. */
const errorOf = (job: Doc<"jobs">): string | null => {
  if (job.status === "failed") return job.error;

  return job.status === "queued" ? job.lastError : null;
};

const jobView = (job: Doc<"jobs">) => ({
  jobId: job._id,
  status: job.status,
  done: job.work.done,
  total: job.work.mode === "reported" ? job.work.total : job.work.sealed ? job.work.appended : null,
  message: job.message,
  error: errorOf(job),
  finishedAt:
    job.status === "succeeded" || job.status === "failed" || job.status === "canceled"
      ? job.finishedAt
      : null,
});

/** The run an import row names, or null when its job or plan is gone. */
const runOf = async (db: DatabaseReader, started: Doc<"imports">) => {
  const [job, row] = await Promise.all([
    db.get(started.jobId),
    db
      .query("importPlans")
      .withIndex("by_import", (q) => q.eq("importId", started._id))
      .unique(),
  ]);

  return job === null || row === null
    ? null
    : {
        importId: started._id,
        source: started.source,
        serverName: started.serverName,
        createdAt: started._creationTime,
        phase: row.checkpoint.phase,
        users: row.plan.users.length,
        imported: row.imported,
        job: jobView(job),
      };
};

/**
 * Refuses everyone but an owner or an admin, who alone start imports: a run names the source
 * server and counts other people's history.
 */
const requireImporter = (caller: Caller): void => {
  if (!can(caller, "manageFolders", SERVER).allowed) {
    fail("forbidden", "Only an owner or an admin sees Jellyfin and Plex imports");
  }
};

/** The import commands. */
export const { list, get } = register({
  list: async (ctx, { paginationOpts }, caller) => {
    requireImporter(caller);

    const page = await paginateAtMost(
      ctx.db,
      { table: "imports", index: "by_creation_time", order: "desc" },
      paginationOpts,
      RUNS_PAGE_MAX,
    );

    const runs = await Promise.all(page.page.map(async (started) => runOf(ctx.db, started)));

    return { ...page, page: runs.flatMap((run) => (run === null ? [] : [run])) };
  },
  get: async (ctx, { importId }, caller) => {
    requireImporter(caller);

    const started = await ctx.db.get(importId);
    const run = started === null ? null : await runOf(ctx.db, started);

    return run ?? fail("not_found", "No such import");
  },
});
