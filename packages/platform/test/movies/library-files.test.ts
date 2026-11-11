import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { logMark, usageSince } from "../admin";
import { member } from "../devices";
import type { Member } from "../devices";
import { share } from "../probe";
import { refusal } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";
import {
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
) =>
  who.signedIn.client.query(api.movies.files.list, {
    libraryId,
    filter,
    paginationOpts: { numItems, cursor },
  });

/** Every page of a library's files under `filter`, from the first, `numItems` asked per page. */
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

    // Every file once, by path, however small the pages.
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

    // A rescan that matches a title, and a file that returns, move the totals at once.
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

    // Only people who may edit the library see its files, as old movies' admin screens required.
    expect(await refusal(summaryOf(viewer, libraryId))).toBe("forbidden");
    expect(await refusal(listPage(viewer, libraryId, "all", 10, null))).toBe("forbidden");
    expect(await refusal(summaryOf(outsider, libraryId))).toBe("not_found");
    expect(await refusal(listPage(outsider, libraryId, "missing", 10, null))).toBe("not_found");
    expect(await summaryOf(admin, libraryId)).toMatchObject({ missing: 1, unmatched: 3 });

    // The purge of a removed folder takes its missing file and its titles out of the totals.
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
});
