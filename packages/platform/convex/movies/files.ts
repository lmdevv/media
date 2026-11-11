import type { PaginationOptions, PaginationResult } from "convex/server";
import { v } from "convex/values";

import { register } from "../../commands/movies/files";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import type { Caller } from "../core/auth/caller";
import { foldersOf, isInside } from "../core/folders";
import { fail } from "../core/lib/errors";
import { pageRows } from "../core/lib/paginate";
import { serverQuery } from "../core/lib/serverFacing";
import { reachOf, requireItems } from "../core/permissions/grants";
import type { ItemGate } from "../core/permissions/grants";
import { registerWithArtworkTickets } from "./artwork";
import { DOCUMENT_BYTES } from "./fit";
import { titleFacts } from "./items";
import { presentVersion } from "./present";
import { EPISODE_GET, TITLE_GET, callBudget, plus, readsOf, settleRead, times } from "./reads";
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

/** Most files one page holds. */
const FILES_PAGE_MAX = 100;

/** Most files the unmatched filter lists of each title, as old movies listed. */
const FILES_PER_UNMATCHED_TITLE = 50;

/** Most unmatched titles one page holds, each with its files. */
const UNMATCHED_PAGE_MAX = 20;

/** Index ranges a page's first read takes at most: the rest of its start key, the keys between, its end key. */
const SPAN_RANGES = 3;

const FILE_DOC: Reads = readsOf(0, 1, DOCUMENT_BYTES.mediaFiles);

const TITLE_DOC: Reads = readsOf(0, 1, DOCUMENT_BYTES.titles);

/** What a file row reads past the file: its title and its episode, each at its bound (`fit.ts`). */
const FILE_EXTRAS: Reads = plus(TITLE_GET, EPISODE_GET);

/** What an unmatched title's row reads past the title: one query of its files, each with its episode. */
const TITLE_EXTRAS: Reads = plus(
  readsOf(1, 0, 0),
  times(plus(FILE_DOC, EPISODE_GET), FILES_PER_UNMATCHED_TITLE),
);

/** How many rows of `cost` fit what is left of `budget`, at least 1 and at most `max`. */
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

/** Whether the gate lists a title: it is not being purged, and `can()` admits it. */
const listed = (gate: ItemGate, title: Doc<"titles"> | null): title is Doc<"titles"> =>
  title !== null && title.purging !== true && gate.admits(titleFacts(title));

/**
 * Where a page of one filter starts or ends: just after a file (by its path, unique in its
 * library), a missing file (by when it went missing, then its path), or an unmatched title (by its
 * sort key, then its tie, unique per title). Each names one exact row whatever was added or
 * removed since, so a page reloaded to its end never shows a row twice or skips one.
 */
type Position =
  | { readonly filter: "all"; readonly path: string }
  | { readonly filter: "missing"; readonly since: number; readonly path: string }
  | { readonly filter: "unmatched"; readonly sortKey: string; readonly tie: string };

type PositionOf<F extends Filter> = Extract<Position, { readonly filter: F }>;

/**
 * A position as text: the filter, then its fields, the free text last so it may hold a colon. A
 * tie is a UUID and a time a whole number, neither with a colon.
 */
const cursorOf = (position: Position): string => {
  if (position.filter === "all") return `all:${position.path}`;

  return position.filter === "missing"
    ? `missing:${position.since}:${position.path}`
    : `unmatched:${position.tie}:${position.sortKey}`;
};

const parsedPosition = (cursor: string): Position | null => {
  const [filter = "", first = "", ...rest] = cursor.split(":");

  if (filter === "all") return { filter, path: [first, ...rest].join(":") };

  if (rest.length === 0) return null;

  const second = rest.join(":");

  if (filter === "unmatched" && first !== "") return { filter, tie: first, sortKey: second };

  const since = Number(first);

  return filter === "missing" && first !== "" && Number.isSafeInteger(since)
    ? { filter, since, path: second }
    : null;
};

const isPositionOf = <F extends Filter>(filter: F, position: Position): position is PositionOf<F> =>
  position.filter === filter;

const positionOf = <F extends Filter>(
  filter: F,
  cursor: string | null | undefined,
): PositionOf<F> | null => {
  if (cursor === undefined || cursor === null || cursor === "") return null;

  const position = parsedPosition(cursor);

  return position !== null && isPositionOf(filter, position)
    ? position
    : fail("invalid_args", "This page cursor did not come from this list");
};

/**
 * Up to `count` rows in index order after `start` and through `end`, either open, over at most
 * `SPAN_RANGES` ranges: the rest of the start's first key, the first keys between, and the end's
 * first key. `within` reads rows of one first key after and through second keys, `between` rows
 * whose first key lies strictly between two, each bound open when null. It reads only forward.
 */
const readSpan = async <Key, Row>(
  span: {
    readonly within: (
      key: Key,
      after: string | null,
      through: string | null,
      count: number,
    ) => Promise<ReadonlyArray<Row>>;
    readonly between: (
      after: Key | null,
      before: Key | null,
      count: number,
    ) => Promise<ReadonlyArray<Row>>;
  },
  start: { readonly key: Key; readonly second: string } | null,
  end: { readonly key: Key; readonly second: string } | null,
  count: number,
): Promise<ReadonlyArray<Row>> => {
  if (start !== null && end !== null && start.key === end.key) {
    return span.within(start.key, start.second, end.second, count);
  }

  const first = start === null ? [] : await span.within(start.key, start.second, null, count);

  const middle =
    first.length >= count
      ? []
      : await span.between(start?.key ?? null, end?.key ?? null, count - first.length);

  const before = [...first, ...middle];

  const last =
    end === null || before.length >= count
      ? []
      : await span.within(end.key, null, end.second, count - before.length);

  return [...before, ...last];
};

/** Up to `count` of the library's files by path after `start` and through `end`, either open. */
const filesByPath = (
  db: DatabaseReader,
  libraryId: Id<"libraries">,
  start: PositionOf<"all"> | null,
  end: PositionOf<"all"> | null,
  count: number,
): Promise<ReadonlyArray<Doc<"mediaFiles">>> =>
  db
    .query("mediaFiles")
    .withIndex("by_library_path", (q) => {
      const library = q.eq("libraryId", libraryId);
      const after = start === null ? library : library.gt("path", start.path);

      return end === null ? after : after.lte("path", end.path);
    })
    .take(count);

/**
 * Up to `count` of the library's missing files, oldest missing first, after `start` and through
 * `end`. Every missing file has `missingSince`: the one write that marks a file missing sets both.
 */
const missingFiles = (
  db: DatabaseReader,
  libraryId: Id<"libraries">,
  start: PositionOf<"missing"> | null,
  end: PositionOf<"missing"> | null,
  count: number,
): Promise<ReadonlyArray<Doc<"mediaFiles">>> =>
  readSpan(
    {
      within: (since: number, after, through, take) =>
        db
          .query("mediaFiles")
          .withIndex("by_library_missing", (q) => {
            const at = q.eq("libraryId", libraryId).eq("missing", true).eq("missingSince", since);
            const from = after === null ? at : at.gt("path", after);

            return through === null ? from : from.lte("path", through);
          })
          .take(take),
      between: (after, before, take) =>
        db
          .query("mediaFiles")
          .withIndex("by_library_missing", (q) => {
            const missing = q.eq("libraryId", libraryId).eq("missing", true);

            const from =
              after === null ? missing.gte("missingSince", 0) : missing.gt("missingSince", after);

            return before === null ? from : from.lt("missingSince", before);
          })
          .take(take),
    },
    start === null ? null : { key: start.since, second: start.path },
    end === null ? null : { key: end.since, second: end.path },
    count,
  );

/** Up to `count` of the library's unmatched titles by sort key after `start` and through `end`. */
const unmatchedTitles = (
  db: DatabaseReader,
  libraryId: Id<"libraries">,
  start: PositionOf<"unmatched"> | null,
  end: PositionOf<"unmatched"> | null,
  count: number,
): Promise<ReadonlyArray<Doc<"titles">>> =>
  readSpan(
    {
      within: (sortKey: string, after, through, take) =>
        db
          .query("titles")
          .withIndex("by_library_status", (q) => {
            const at = q
              .eq("libraryId", libraryId)
              .eq("matchStatus", "unmatched")
              .eq("sortKey", sortKey);

            const from = after === null ? at : at.gt("tie", after);

            return through === null ? from : from.lte("tie", through);
          })
          .take(take),
      between: (after, before, take) =>
        db
          .query("titles")
          .withIndex("by_library_status", (q) => {
            const unmatched = q.eq("libraryId", libraryId).eq("matchStatus", "unmatched");
            const from = after === null ? unmatched : unmatched.gt("sortKey", after);

            return before === null ? from : from.lt("sortKey", before);
          })
          .take(take),
    },
    start === null ? null : { key: start.sortKey, second: start.tie },
    end === null ? null : { key: end.sortKey, second: end.tie },
    count,
  );

/**
 * One page of `rows` read in order from `start` through `end` (`rows + 1` read, to tell whether
 * more follow), as Convex pages: a page pinned to an end that now holds more than `rows` asks the
 * client to split it at the last row it holds, and an open page continues after its last row.
 */
const pageOf = <Row, Shown>(
  found: ReadonlyArray<Row>,
  rows: number,
  options: PaginationOptions,
  positionAfter: (row: Row) => string,
  shown: ReadonlyArray<Shown>,
): PaginationResult<Shown> => {
  const window = found.slice(0, rows);
  const last = window.at(-1);
  const endCursor = options.endCursor ?? null;

  if (endCursor !== null) {
    return found.length > rows && last !== undefined
      ? {
          page: [...shown],
          isDone: false,
          continueCursor: endCursor,
          splitCursor: positionAfter(last),
          pageStatus: "SplitRequired",
        }
      : { page: [...shown], isDone: false, continueCursor: endCursor };
  }

  return {
    page: [...shown],
    isDone: found.length <= rows,
    continueCursor: last === undefined ? (options.cursor ?? "") : positionAfter(last),
  };
};

/** Files as list rows, each with its title and episode, the titles read once each. */
const presentFiles = async (
  db: DatabaseReader,
  gate: ItemGate,
  budget: ReadBudget,
  files: ReadonlyArray<Doc<"mediaFiles">>,
): Promise<ReadonlyArray<LibraryFile>> => {
  const reserved = times(FILE_EXTRAS, files.length);

  budget.take(reserved);

  const titleIds = [...new Set(files.map((file) => file.titleId))];
  const titles = new Map(titleIds.map((id) => [id, db.get(id)] as const));

  const read = await Promise.all(
    files.map(async (file) => ({
      file,
      title: await (titles.get(file.titleId) ?? null),
      episode: file.episodeId === null ? null : await db.get(file.episodeId),
    })),
  );

  const uniqueTitles = await Promise.all(titles.values());

  settleRead(budget, readsOf(reserved.ranges, reserved.documents, reserved.bytes), [
    ...uniqueTitles,
    ...read.map((row) => row.episode),
  ]);

  return read.flatMap(({ file, title, episode }) =>
    listed(gate, title) ? [presentFile(file, title, episode)] : [],
  );
};

/** The files of `filter` (`all` by path, or `missing` oldest first) a page at a time. */
const filePage = async (
  db: DatabaseReader,
  gate: ItemGate,
  budget: ReadBudget,
  filter: "all" | "missing",
  options: PaginationOptions,
): Promise<PaginationResult<LibraryFile>> => {
  const libraryId = gate.library._id;

  // The lookahead row and the ranges first, then as many rows as what is left affords.
  budget.take(plus(readsOf(SPAN_RANGES, 0, 0), FILE_DOC));

  const rows = rowsAffordable(
    budget,
    plus(FILE_DOC, FILE_EXTRAS),
    Math.min(FILES_PAGE_MAX, pageRows(options.numItems)),
  );

  const reserved = times(FILE_DOC, rows);

  budget.take(reserved);

  const found =
    filter === "all"
      ? await filesByPath(
          db,
          libraryId,
          positionOf("all", options.cursor),
          positionOf("all", options.endCursor),
          rows + 1,
        )
      : await missingFiles(
          db,
          libraryId,
          positionOf("missing", options.cursor),
          positionOf("missing", options.endCursor),
          rows + 1,
        );

  settleRead(budget, plus(reserved, FILE_DOC), found);

  const after = (file: Doc<"mediaFiles">): string =>
    cursorOf(
      filter === "all"
        ? { filter, path: file.path }
        : { filter, since: file.missingSince ?? 0, path: file.path },
    );

  return pageOf(
    found,
    rows,
    options,
    after,
    await presentFiles(db, gate, budget, found.slice(0, rows)),
  );
};

/** A page holds files of whole titles, so it may hold more or fewer files than asked. */
const unmatchedPage = async (
  db: DatabaseReader,
  gate: ItemGate,
  budget: ReadBudget,
  options: PaginationOptions,
): Promise<PaginationResult<LibraryFile>> => {
  budget.take(plus(readsOf(SPAN_RANGES, 0, 0), TITLE_DOC));

  const rows = rowsAffordable(
    budget,
    plus(TITLE_DOC, TITLE_EXTRAS),
    Math.min(UNMATCHED_PAGE_MAX, pageRows(options.numItems)),
  );

  const reserved = times(TITLE_DOC, rows);

  budget.take(reserved);

  const found = await unmatchedTitles(
    db,
    gate.library._id,
    positionOf("unmatched", options.cursor),
    positionOf("unmatched", options.endCursor),
    rows + 1,
  );

  settleRead(budget, plus(reserved, TITLE_DOC), found);

  const shown = found.slice(0, rows).filter((title) => listed(gate, title));
  const extras = times(TITLE_EXTRAS, shown.length);

  budget.take(extras);

  const groups = await Promise.all(
    shown.map(async (title) => {
      const files = await db
        .query("mediaFiles")
        .withIndex("by_title", (q) => q.eq("titleId", title._id))
        .take(FILES_PER_UNMATCHED_TITLE);

      const episodes = await Promise.all(
        files.map(async (file) => (file.episodeId === null ? null : db.get(file.episodeId))),
      );

      return { title, files, episodes };
    }),
  );

  settleRead(
    budget,
    readsOf(extras.ranges, extras.documents, extras.bytes),
    groups.flatMap(({ files, episodes }) => [...files, ...episodes]),
  );

  return pageOf(
    found,
    rows,
    options,
    (title) => cursorOf({ filter: "unmatched", sortKey: title.sortKey, tie: title.tie }),
    groups.flatMap(({ title, files, episodes }) =>
      files.map((file, index) => presentFile(file, title, episodes[index] ?? null)),
    ),
  );
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

  return filter === "unmatched"
    ? unmatchedPage(db, gate, budget, args.paginationOpts)
    : filePage(db, gate, budget, filter, args.paginationOpts);
};

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
 * Whether `caller` sees every title of a library they may edit. Restrictions hide titles by their
 * facts, so the library's counters would count titles the list hides from them.
 */
const seesEveryTitle = (caller: Caller): boolean => caller.restrictions === null;

/**
 * A library's files for the people who may edit it (`can()` with `edit` on the library, which
 * takes `movies:edit`): every file by path, the missing ones by when they went missing, or the
 * unmatched titles' files, and the totals of each, from counters (D28). The totals count every
 * title, so an editor whose restrictions hide some gets none, and no missing date: counting only
 * what they see would read every missing file and unmatched title, which no call's reads bound.
 */
export const { list, summary } = registerWithArtworkTickets(register, {
  list: async (ctx, args, caller) => listFiles(ctx.db, caller, args),
  summary: async (ctx, { libraryId }, caller) => {
    const gate = await editableLibrary(ctx.db, caller, libraryId);

    if (!seesEveryTitle(caller)) return { missing: null, missingSince: null, unmatched: null };

    const [problems, since] = await Promise.all([
      problemsOf(ctx.db, gate.library._id),
      missingSince(ctx.db, gate.library._id),
    ]);

    return { missing: problems.missing, missingSince: since, unmatched: problems.unmatched };
  },
});
