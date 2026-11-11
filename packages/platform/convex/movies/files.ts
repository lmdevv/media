import type { PaginationOptions, PaginationResult } from "convex/server";
import { v } from "convex/values";

import { register } from "../../commands/movies/files";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import type { Caller } from "../core/auth/caller";
import { foldersOf, isInside } from "../core/folders";
import { fail } from "../core/lib/errors";
import { paginateAtMost } from "../core/lib/paginate";
import { serverQuery } from "../core/lib/serverFacing";
import { reachOf, requireItems } from "../core/permissions/grants";
import type { ItemGate } from "../core/permissions/grants";
import { registerWithArtworkTickets } from "./artwork";
import { DOCUMENT_BYTES } from "./fit";
import { titleFacts } from "./items";
import { presentVersion } from "./present";
import { EPISODE_GET, TITLE_GET, callBudget, plus, readsOf, times } from "./reads";
import type { ReadBudget, Reads } from "./reads";
import { problemsOf } from "./totals";
import { externalSubtitle, probe } from "./validators";

/**
 * What the server needs to stream a file: its path, its library's folders now, what ffprobe saw
 * in it, and the subtitle files beside it. Null for an id that names no file, and for a file that
 * is missing, whose title is gone or being purged, whose library is gone, or that no folder of its
 * library holds now (a removed folder's purge has yet to reach it). So `missing` is always false;
 * it stays for the shape old movies answered.
 */
export const resolveFile = serverQuery({
  args: { fileId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      fileId: v.id("mediaFiles"),
      libraryId: v.id("libraries"),
      path: v.string(),
      roots: v.array(v.string()),
      probe,
      externalSubtitles: v.array(externalSubtitle),
      missing: v.boolean(),
    }),
  ),
  handler: async (ctx, { fileId }) => {
    const id = ctx.db.normalizeId("mediaFiles", fileId);
    const file = id === null ? null : await ctx.db.get(id);

    if (file === null || file.missing) return null;

    const [title, library] = await Promise.all([
      ctx.db.get(file.titleId),
      ctx.db.get(file.libraryId),
    ]);

    if (title === null || title.purging === true || library === null) return null;

    const roots = await foldersOf(ctx.db, library._id);

    if (!roots.some((root) => isInside(file.path, root))) return null;

    return {
      fileId: file._id,
      libraryId: library._id,
      path: file.path,
      roots: [...roots],
      probe: file.probe,
      externalSubtitles: file.externalSubtitles,
      missing: file.missing,
    };
  },
});

/** Most files one page of a library's files holds, as old movies' file list paged. */
const FILES_PAGE_MAX = 100;

/** Most files the unmatched filter lists of each title, as old movies listed. */
const FILES_PER_UNMATCHED_TITLE = 50;

/** Most unmatched titles one page holds, each with its files, as old movies paged. */
const UNMATCHED_PAGE_MAX = 20;

/** Reading one file of the list: the file, its title, and its episode, each at its bound. */
const FILE_ROW: Reads = plus(
  readsOf(0, 1, DOCUMENT_BYTES.mediaFiles),
  plus(TITLE_GET, EPISODE_GET),
);

/**
 * Reading one unmatched title of the list: the title, one query of its files, and each file with
 * its episode.
 */
const UNMATCHED_ROW: Reads = plus(
  plus(readsOf(0, 1, DOCUMENT_BYTES.titles), readsOf(1, 0, 0)),
  times(plus(readsOf(0, 1, DOCUMENT_BYTES.mediaFiles), EPISODE_GET), FILES_PER_UNMATCHED_TITLE),
);

/** How many rows of `cost` each fit what is left of `budget`, at least 1 and at most `max`. */
const rowsAffordable = (budget: ReadBudget, cost: Reads, max: number): number => {
  const left = budget.left();

  return Math.max(
    1,
    Math.min(
      max,
      Math.floor(left.ranges / Math.max(cost.ranges, 1)),
      Math.floor(left.documents / Math.max(cost.documents, 1)),
      Math.floor(left.bytes / Math.max(cost.bytes, 1)),
    ),
  );
};

/** The movies library `libraryId` when the caller may edit it; refuses as `requireItems` does. */
const editableLibrary = async (
  db: DatabaseReader,
  caller: Caller,
  libraryId: Id<"libraries">,
): Promise<ItemGate> => {
  const gate = await requireItems({ db }, caller, "edit", libraryId);

  return gate.library.kind === "movies" ? gate : fail("not_found", "No such library");
};

type Filter = "all" | "missing" | "unmatched";

const presentFile = (
  file: Doc<"mediaFiles">,
  title: Doc<"titles">,
  episode: Doc<"episodes"> | null,
) => ({
  id: file._id,
  path: file.path,
  version: presentVersion(file, null),
  missing: file.missing,
  missingSince: file.missing ? (file.missingSince ?? null) : null,
  title: {
    id: title._id,
    kind: title.kind,
    name: title.overrides?.name ?? title.name,
    year: title.overrides?.year ?? title.year,
    poster: title.artwork.poster,
    matchStatus: title.matchStatus,
  },
  episode:
    episode === null
      ? null
      : {
          id: episode._id,
          seasonNumber: episode.seasonNumber,
          episodeNumber: episode.episodeNumber,
        },
});

type LibraryFile = ReturnType<typeof presentFile>;

/**
 * `files` as list rows, each with its title and episode, read once each. A file whose title is
 * gone or being purged is left out, as every read leaves it, and so is one the gate hides.
 */
const presentFiles = async (
  db: DatabaseReader,
  gate: ItemGate,
  files: ReadonlyArray<Doc<"mediaFiles">>,
): Promise<ReadonlyArray<LibraryFile>> => {
  const titleIds = [...new Set(files.map((file) => file.titleId))];
  const titles = new Map(titleIds.map((id) => [id, db.get(id)] as const));

  const rows = await Promise.all(
    files.map(async (file) => {
      const [title, episode] = await Promise.all([
        titles.get(file.titleId) ?? null,
        file.episodeId === null ? null : db.get(file.episodeId),
      ]);

      return title === null || title.purging === true || !gate.admits(titleFacts(title))
        ? null
        : presentFile(file, title, episode);
    }),
  );

  return rows.filter((row) => row !== null);
};

const filePage = (
  db: DatabaseReader,
  libraryId: Id<"libraries">,
  filter: "all" | "missing",
  paginationOpts: PaginationOptions,
  rows: number,
): Promise<PaginationResult<Doc<"mediaFiles">>> =>
  filter === "missing"
    ? paginateAtMost(
        db,
        {
          table: "mediaFiles",
          index: "by_library_missing",
          range: (q) => q.eq("libraryId", libraryId).eq("missing", true),
        },
        paginationOpts,
        rows,
      )
    : paginateAtMost(
        db,
        {
          table: "mediaFiles",
          index: "by_library_path",
          range: (q) => q.eq("libraryId", libraryId),
        },
        paginationOpts,
        rows,
      );

/**
 * A page of the library's unmatched titles, each with up to 50 of its files, as old movies listed
 * them: a page holds files of whole titles, so it may hold more or fewer files than asked.
 */
const unmatchedPage = async (
  db: DatabaseReader,
  gate: ItemGate,
  paginationOpts: PaginationOptions,
  titles: number,
): Promise<PaginationResult<LibraryFile>> => {
  const page = await paginateAtMost(
    db,
    {
      table: "titles",
      index: "by_library_status",
      range: (q) => q.eq("libraryId", gate.library._id).eq("matchStatus", "unmatched"),
    },
    paginationOpts,
    titles,
  );

  const listed = page.page.filter(
    (title) => title.purging !== true && gate.admits(titleFacts(title)),
  );

  const rows = await Promise.all(
    listed.map(async (title) => {
      const files = await db
        .query("mediaFiles")
        .withIndex("by_title", (q) => q.eq("titleId", title._id))
        .take(FILES_PER_UNMATCHED_TITLE);

      const episodes = await Promise.all(
        files.map(async (file) => (file.episodeId === null ? null : db.get(file.episodeId))),
      );

      return files.map((file, index) => presentFile(file, title, episodes[index] ?? null));
    }),
  );

  return { ...page, page: rows.flat() };
};

const listFiles = async (
  db: DatabaseReader,
  caller: Caller,
  args: {
    readonly libraryId: Id<"libraries">;
    readonly filter?: Filter | undefined;
    readonly paginationOpts: PaginationOptions;
  },
): Promise<PaginationResult<LibraryFile>> => {
  const [gate, reach] = await Promise.all([
    editableLibrary(db, caller, args.libraryId),
    reachOf(db, caller),
  ]);

  const budget = callBudget(reach);
  const filter = args.filter ?? "all";

  if (filter === "unmatched") {
    return unmatchedPage(
      db,
      gate,
      args.paginationOpts,
      rowsAffordable(budget, UNMATCHED_ROW, UNMATCHED_PAGE_MAX),
    );
  }

  const page = await filePage(
    db,
    gate.library._id,
    filter,
    args.paginationOpts,
    rowsAffordable(budget, FILE_ROW, FILES_PAGE_MAX),
  );

  return { ...page, page: [...(await presentFiles(db, gate, page.page))] };
};

/** When the library's file missing longest went missing, or null when none is. */
const missingSince = async (
  db: DatabaseReader,
  libraryId: Id<"libraries">,
): Promise<number | null> => {
  const oldest = await db
    .query("mediaFiles")
    .withIndex("by_library_missing", (q) =>
      q.eq("libraryId", libraryId).eq("missing", true).gte("missingSince", 0),
    )
    .first();

  return oldest?.missingSince ?? null;
};

/**
 * A library's files for the people who may edit it (`can()` with `edit` on the library, which
 * takes `movies:edit`): every file by path, the missing ones by when they went missing, or the
 * unmatched titles' files, and the totals of each, from counters (D28).
 */
export const { list, summary } = registerWithArtworkTickets(register, {
  list: async (ctx, args, caller) => listFiles(ctx.db, caller, args),
  summary: async (ctx, { libraryId }, caller) => {
    const gate = await editableLibrary(ctx.db, caller, libraryId);

    const [problems, since] = await Promise.all([
      problemsOf(ctx.db, gate.library._id),
      missingSince(ctx.db, gate.library._id),
    ]);

    return { missing: problems.missing, missingSince: since, unmatched: problems.unmatched };
  },
});
