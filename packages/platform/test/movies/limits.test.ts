import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import { logMark, usageSince } from "../admin";
import { member } from "../devices";
import { failureOf } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";
import {
  UPSERT_BATCH,
  cancelQueued,
  claimJob,
  finishJob,
  moviesLibrary,
  totalsOf,
  upsert,
} from "./catalog";
import { episodeFile, movieFile, scannedTitle } from "./scanned";
import type { ScannedItem } from "./scanned";

const stack = coreStackFromEnvFile();

/** Convex's per-call limits (ADR 0013). */
const READS_MAX = 32_000;

const WRITES_MAX = 16_000;

/** The most genres a title may carry. */
const GENRES_MAX = 20;

const genres = (prefix: string, count = GENRES_MAX): Array<string> =>
  Array.from({ length: count }, (_, n) => `${prefix} ${n}`);

describe.skipIf(stack === undefined)("movies scanner limits", { timeout: 300_000 }, () => {
  it("keep the worst full batch, of new, rewritten, and moved titles and episodes, inside one call's limits", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "limits-admin", "admin");
    const { libraryId, scanJobId, roots } = await moviesLibrary(admin, "Full batch");
    const root = roots[0] ?? "";
    const lease = await claimJob(stack, "movies.scan", scanJobId);
    const paths = Array.from({ length: UPSERT_BATCH }, (_, n) => join(root, `${n}.mkv`));

    const movies = (prefix: string, size: number): ReadonlyArray<ScannedItem> =>
      paths.map((path, n) =>
        movieFile(
          path,
          size,
          size,
          { ...scannedTitle("movie", `m:${n}`, `Movie ${n}`), genres: genres(prefix) },
          true,
        ),
      );

    const shows = (prefix: string, episode: number, size: number): ReadonlyArray<ScannedItem> =>
      paths.map((path, n) =>
        episodeFile(
          path,
          { ...scannedTitle("show", `s:${n}`, `Show ${n}`), genres: genres(prefix) },
          episode,
          episode,
          true,
          size,
        ),
      );

    const mark = await logMark(stack);

    // New titles, each with every genre; then each rewritten with every genre replaced and the
    // file changed; then each file moved to a new show's episode, leaving its old title behind;
    // then each show rewritten with every genre replaced, its file moved to another episode,
    // and its thumbnails queued again: the worst file the batch size is measured on.
    expect(await upsert(stack, lease, movies("first", 1))).toMatchObject({ outcome: "held" });
    expect(await upsert(stack, lease, movies("second", 2))).toMatchObject({ outcome: "held" });
    expect(await upsert(stack, lease, shows("show", 1, 3))).toMatchObject({ outcome: "held" });
    expect(await upsert(stack, lease, shows("other", 2, 4))).toMatchObject({ outcome: "held" });

    const usage = await usageSince(stack, mark, api.movies.scanner.upsert, 4);
    const committed = usage.filter((call) => call.committed);

    expect(committed.length).toBeGreaterThanOrEqual(4);
    expect(Math.max(...committed.map((call) => call.reads))).toBeLessThan(READS_MAX);
    expect(Math.max(...committed.map((call) => call.writes))).toBeLessThan(WRITES_MAX);
    expect(await totalsOf(stack, libraryId)).toEqual({
      titles: 2 * UPSERT_BATCH,
      episodes: 2 * UPSERT_BATCH,
      files: UPSERT_BATCH,
    });

    const tooMany = [
      movieFile(join(root, "many.mkv"), 1, 1, {
        ...scannedTitle("movie", "many", "Many genres"),
        genres: genres("many", 40),
      }),
    ];

    const refused = await failureOf(upsert(stack, lease, tooMany));

    expect(refused.code).toBe("invalid_args");
    expect(refused.message).toMatch(/at most 20 genres/u);

    const overBatch = Array.from({ length: UPSERT_BATCH + 1 }, (_, n) =>
      movieFile(join(root, `over-${n}.mkv`)),
    );

    await expect(upsert(stack, lease, overBatch)).rejects.toThrow(/at most 80/u);
    await finishJob(stack, lease);
    await cancelQueued(stack, "movies.trickplay");
  });
});
