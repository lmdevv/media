import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Restrictions } from "../../commands/access";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { logMark, usageSince } from "../admin";
import { member } from "../devices";
import type { Member } from "../devices";
import { share } from "../probe";
import { refusal } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";
import {
  applyMetadataAll,
  cancelQueued,
  claimJob,
  finishJob,
  markMissing,
  moviesLibrary,
  purgeStage,
  setFoldersQuietly,
  upsert,
  upsertAll,
} from "./catalog";
import { episodeFile, movieFile, scannedTitle } from "./scanned";

const stack = coreStackFromEnvFile();

type Filter = "all" | "missing" | "unmatched";

type FilePage = Awaited<ReturnType<typeof listPage>>;

type LibraryFile = FilePage["page"][number];

const listPage = (
  who: Member,
  libraryId: Id<"libraries">,
  filter: Filter,
  numItems: number,
  cursor: string | null,
  endCursor?: string,
) =>
  who.signedIn.client.query(api.movies.files.list, {
    libraryId,
    filter,
    paginationOpts:
      endCursor === undefined ? { numItems, cursor } : { numItems, cursor, endCursor },
  });

/**
 * The rows of the page from `cursor` pinned to end at `endCursor`, split as the server asks, the
 * way a reactive client reloads a page after the page below it loaded.
 */
const pinnedRows = async (
  who: Member,
  libraryId: Id<"libraries">,
  filter: Filter,
  cursor: string | null,
  endCursor: string,
): Promise<ReadonlyArray<LibraryFile>> => {
  const page = await listPage(who, libraryId, filter, 10, cursor, endCursor);

  if (page.pageStatus !== "SplitRequired") return page.page;

  const split = page.splitCursor;

  if (split === null || split === undefined) throw new Error("A split page names no split");

  return [
    ...(await pinnedRows(who, libraryId, filter, cursor, split)),
    ...(await pinnedRows(who, libraryId, filter, split, endCursor)),
  ];
};

const pad = (n: number): string => String(n).padStart(3, "0");

const NONE: Restrictions = {
  maxMovieAge: null,
  hideUnrated: false,
  hideExplicitMusic: false,
  libraries: null,
};

const allFiles = async (
  who: Member,
  libraryId: Id<"libraries">,
  filter: Filter,
  numItems: number,
  cursor: string | null = null,
  seen: ReadonlyArray<ReadonlyArray<LibraryFile>> = [],
): Promise<ReadonlyArray<ReadonlyArray<LibraryFile>>> => {
  const page = await listPage(who, libraryId, filter, numItems, cursor);
  const pages = [...seen, page.page];

  return page.isDone
    ? pages
    : allFiles(who, libraryId, filter, numItems, page.continueCursor, pages);
};

const pathsOf = (pages: ReadonlyArray<ReadonlyArray<LibraryFile>>): ReadonlyArray<string> =>
  pages.flat().map((file) => file.path);

const summaryOf = (who: Member, libraryId: Id<"libraries">) =>
  who.signedIn.client.query(api.movies.files.summary, { libraryId });

/** Convex's per-call limits (ADR 0013). */
const READS_MAX = 32_000;

const BYTES_MAX = 16 * 1024 * 1024;

describe.skipIf(stack === undefined)("movies.files", { timeout: 600_000 }, () => {
  it("list a library's files by path, the missing ones, and the unmatched titles' files, with exact totals", async () => {
    if (stack === undefined) return;

    const admin = await member(stack, "files-admin", "admin");
    const editor = await member(stack, "files-editor");
    const viewer = await member(stack, "files-viewer");
    const outsider = await member(stack, "files-outsider");
    const { libraryId, scanJobId, roots } = await moviesLibrary(admin, "Files", 2);
    const [root = "", other = ""] = roots;

    await share(admin, libraryId, { kind: "user", userId: editor.userId }, "edit");
    await share(admin, libraryId, { kind: "user", userId: viewer.userId }, "view");

    const lease = await claimJob(stack, "movies.scan", scanJobId);
    const show = scannedTitle("show", "show:files", "Files Show");

    const matched = {
      ...scannedTitle("movie", "tmdb:603", "Matched Film"),
      externalIds: { tmdb: "603", imdb: null, tvdb: null },
      matchStatus: "matched" as const,
    };

    const [a, b, c, d, e1, e2] = [
      join(root, "a.mkv"),
      join(root, "b.mkv"),
      join(root, "c.mkv"),
      join(other, "d.mkv"),
      join(root, "Files Show", "s01e01.mkv"),
      join(root, "Files Show", "s01e02.mkv"),
    ];

    const landed = await upsert(stack, lease, [
      movieFile(a),
      movieFile(b),
      movieFile(c),
      movieFile(d, 1, 1, matched),
      episodeFile(e1, show, 1, 1, true),
      episodeFile(e2, show, 1, 2, true),
    ]);

    expect(landed.outcome).toBe("held");

    const before = Date.now();

    await markMissing(stack, lease, [b]);

    const empty = await summaryOf(editor, libraryId);

    expect(empty).toMatchObject({ missing: 1, unmatched: 4 });
    expect(empty.missingSince).toBeGreaterThanOrEqual(before - 60_000);

    const all = await allFiles(editor, libraryId, "all", 2);

    expect(all.every((page) => page.length <= 2)).toBe(true);
    expect(pathsOf(all)).toEqual([a, b, c, e1, e2, d].toSorted());

    const byPath = new Map(all.flat().map((file) => [file.path, file]));

    expect(byPath.get(d)?.title).toMatchObject({ name: "Matched Film", matchStatus: "matched" });
    expect(byPath.get(e2)).toMatchObject({
      missing: false,
      missingSince: null,
      episode: { seasonNumber: 1, episodeNumber: 2 },
      title: { kind: "show", name: "Files Show", matchStatus: "unmatched" },
      version: { height: 1080, videoCodec: "h264", sizeBytes: 1 },
    });
    expect(byPath.get(b)).toMatchObject({ missing: true, missingSince: empty.missingSince });

    expect(pathsOf(await allFiles(editor, libraryId, "missing", 1))).toEqual([b]);
    expect(pathsOf(await allFiles(editor, libraryId, "unmatched", 1)).toSorted()).toEqual(
      [a, b, c, e1, e2].toSorted(),
    );

    await upsert(stack, lease, [
      movieFile(a, 1, 1, {
        ...scannedTitle("movie", `file:${a}`, "a.mkv"),
        externalIds: { tmdb: "1", imdb: null, tvdb: null },
        matchStatus: "matched",
      }),
      movieFile(b),
    ]);

    expect(await summaryOf(editor, libraryId)).toEqual({
      missing: 0,
      missingSince: null,
      unmatched: 3,
    });

    await markMissing(stack, lease, [c]);
    await finishJob(stack, lease);

    const handMatched = byPath.get(c)?.title.id;

    if (handMatched === undefined) throw new Error("c.mkv has no title");

    const { jobId } = await editor.signedIn.client.mutation(api.movies.metadata.match, {
      titleId: handMatched,
      provider: "tmdb",
      providerId: "604",
    });

    const matching = await claimJob(stack, "movies.metadata", jobId);

    await applyMetadataAll(
      stack,
      matching,
      handMatched,
      {
        ...scannedTitle("movie", "tmdb:604", "Hand Matched"),
        externalIds: { tmdb: "604", imdb: null, tvdb: null },
        matchStatus: "matched",
      },
      [],
    );
    await finishJob(stack, matching);

    const afterMatch = (await allFiles(editor, libraryId, "all", 10)).flat();

    expect(afterMatch.find((file) => file.path === c)?.title).toMatchObject({
      name: "Hand Matched",
      matchStatus: "manual",
    });

    expect(await refusal(summaryOf(viewer, libraryId))).toBe("forbidden");
    expect(await refusal(listPage(viewer, libraryId, "all", 10, null))).toBe("forbidden");
    expect(await refusal(summaryOf(outsider, libraryId))).toBe("not_found");
    expect(await refusal(listPage(outsider, libraryId, "missing", 10, null))).toBe("not_found");
    expect(await summaryOf(admin, libraryId)).toMatchObject({ missing: 1, unmatched: 2 });

    await setFoldersQuietly(stack, libraryId, [other]);
    await purgeStage(stack, libraryId, "files");
    await purgeStage(stack, libraryId, "titles");

    expect(await summaryOf(editor, libraryId)).toEqual({
      missing: 0,
      missingSince: null,
      unmatched: 0,
    });
    expect(pathsOf(await allFiles(editor, libraryId, "all", 10))).toEqual([d]);

    await admin.signedIn.client.mutation(api.core.libraries.remove, { libraryId });
  });

  it("page a library of files and titles at their bounds in calls inside Convex's limits", async () => {
    if (stack === undefined) return;

    const admin = await member(stack, "files-bounds", "admin");
    const { libraryId, scanJobId, roots } = await moviesLibrary(admin, "Files at their bounds");
    const root = roots[0] ?? "";
    const lease = await claimJob(stack, "movies.scan", scanJobId, 600_000);

    // Paths near PATH_MAX and titles near their bound, each file its own unmatched title.
    const deep = join(
      root,
      ...Array.from({ length: 30 }, (_, level) => `${"d".repeat(120)}${level}`),
    );

    const items = Array.from({ length: 160 }, (_, n) =>
      movieFile(join(deep, `${String(n).padStart(4, "0")}.mkv`), 1, 1, {
        ...scannedTitle("movie", `bound:${n}`, `Bound ${n}`),
        overview: "o".repeat(60_000),
        genres: Array.from({ length: 256 }, (_unused, g) => `${"g".repeat(56)} ${g}`),
      }),
    );

    await upsertAll(stack, lease, items);
    await finishJob(stack, lease);
    await cancelQueued(stack, "movies.trickplay");

    const mark = await logMark(stack);
    const all = await allFiles(admin, libraryId, "all", 1000);
    const unmatched = await allFiles(admin, libraryId, "unmatched", 1000);

    const usage = await usageSince(
      stack,
      mark,
      api.movies.files.list,
      all.length + unmatched.length,
    );

    expect(pathsOf(all)).toEqual(items.map((item) => item.file.path));
    expect(new Set(pathsOf(unmatched)).size).toBe(items.length);
    expect(all.length).toBeGreaterThan(1);
    expect(
      usage.every((call) => !call.committed || (call.reads < READS_MAX && call.bytes < BYTES_MAX)),
    ).toBe(true);
    expect(await summaryOf(admin, libraryId)).toEqual({
      missing: 0,
      missingSince: null,
      unmatched: items.length,
    });

    await admin.signedIn.client.mutation(api.core.libraries.remove, { libraryId });
  });

  it("count and date nothing an editor's restrictions hide", async () => {
    if (stack === undefined) return;

    const admin = await member(stack, "files-hidden-admin", "admin");
    const editor = await member(stack, "files-hidden-editor");
    const { libraryId, scanJobId, roots } = await moviesLibrary(admin, "Files hidden");
    const path = join(roots[0] ?? "", "unrated.mkv");

    await share(admin, libraryId, { kind: "user", userId: editor.userId }, "edit");

    const lease = await claimJob(stack, "movies.scan", scanJobId);

    await upsert(stack, lease, [movieFile(path)]);
    await markMissing(stack, lease, [path]);
    await finishJob(stack, lease);

    expect(await summaryOf(editor, libraryId)).toMatchObject({ missing: 1, unmatched: 1 });

    await admin.signedIn.client.mutation(api.core.restrictions.set, {
      userId: editor.userId,
      restrictions: { ...NONE, hideUnrated: true },
    });

    expect(pathsOf(await allFiles(editor, libraryId, "all", 10))).toEqual([]);
    expect(await summaryOf(editor, libraryId)).toEqual({
      missing: null,
      missingSince: null,
      unmatched: null,
    });
    expect(await summaryOf(admin, libraryId)).toMatchObject({ missing: 1, unmatched: 1 });

    await admin.signedIn.client.mutation(api.core.libraries.remove, { libraryId });
  });
  it("split a pinned page that grew past one call's reads, never answering it empty", async () => {
    if (stack === undefined) return;

    const admin = await member(stack, "files-pinned", "admin");
    const { libraryId, scanJobId, roots } = await moviesLibrary(admin, "Files that grew");
    const root = roots[0] ?? "";
    const lease = await claimJob(stack, "movies.scan", scanJobId, 600_000);

    await upsertAll(
      stack,
      lease,
      Array.from({ length: 30 }, (_, n) =>
        movieFile(join(root, `m-${pad(n)}.mkv`), 1, 1, scannedTitle("movie", `m:${n}`, `M ${n}`)),
      ),
    );

    const all = await listPage(admin, libraryId, "all", 10, null);
    const unmatched = await listPage(admin, libraryId, "unmatched", 10, null);

    expect(all.page).toHaveLength(10);
    expect(unmatched.isDone).toBe(false);

    // Files and titles that sort inside both first pages, each title near its bound.
    const grown = Array.from({ length: 300 }, (_, n) =>
      movieFile(join(root, `b-${pad(n)}.mkv`), 1, 1, {
        ...scannedTitle("movie", `b:${n}`, `B ${pad(n)}`),
        overview: "o".repeat(60_000),
      }),
    );

    // A hundred at a time, so one call's arguments stay under the request size limit.
    await upsertAll(stack, lease, grown.slice(0, 100));
    await upsertAll(stack, lease, grown.slice(100, 200));
    await upsertAll(stack, lease, grown.slice(200));

    await finishJob(stack, lease);
    await cancelQueued(stack, "movies.trickplay");

    const mark = await logMark(stack);
    const pinned = await listPage(admin, libraryId, "all", 10, null, all.continueCursor);

    expect(pinned.pageStatus).toBe("SplitRequired");
    expect(pinned.page.length).toBeGreaterThan(0);

    const pinnedAll = await pinnedRows(admin, libraryId, "all", null, all.continueCursor);

    const pinnedUnmatched = await pinnedRows(
      admin,
      libraryId,
      "unmatched",
      null,
      unmatched.continueCursor,
    );

    expect(pathsOf([pinnedAll])).toEqual([
      ...grown.map((item) => item.file.path),
      ...pathsOf([all.page]),
    ]);
    expect(pathsOf([pinnedUnmatched])).toEqual(
      expect.arrayContaining(grown.map((item) => item.file.path)),
    );
    expect(new Set(pathsOf([pinnedUnmatched])).size).toBe(pinnedUnmatched.length);

    const usage = await usageSince(stack, mark, api.movies.files.list, 4);

    expect(usage.length).toBeGreaterThan(0);
    expect(
      usage.every((call) => call.committed && call.reads < READS_MAX && call.bytes < BYTES_MAX),
    ).toBe(true);

    // The library stays: removing it purges some 18 MB at once, and Convex's write rate limit
    // would then refuse the next test's writes.
  });
});
