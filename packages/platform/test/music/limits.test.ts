import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import { logMark, usageSince } from "../admin";
import type { CallUsage } from "../admin";
import { member } from "../devices";
import { coreStackFromEnvFile } from "../stack-env";
import {
  claimScan,
  finishScan,
  markMissingAll,
  musicLibrary,
  rowsOf,
  totalsOf,
  upsertAll,
} from "./catalog";
import { musicTrack, plainLyrics } from "./scanned";

const stack = coreStackFromEnvFile();

/** Convex's per-call limits (ADR 0013). */
const READS_MAX = 32_000;

const WRITES_MAX = 16_000;

const READ_BYTES_MAX = 16 * 1024 * 1024;

const inside = (calls: ReadonlyArray<CallUsage>): boolean =>
  calls.every(
    (call) => call.reads < READS_MAX && call.writes < WRITES_MAX && call.bytes < READ_BYTES_MAX,
  );

/** About 200 KB of plain lyrics, different for each track and round. */
const verse = (n: number, round: number) => plainLyrics(`${round}:${n} `.repeat(30_000));

/** `count` characters of a 3-byte character, the longest a name's characters can be. */
const wide = (count: number, n: number): string => `${n}`.padEnd(count, "語");

describe.skipIf(stack === undefined)("music scanner limits", { timeout: 300_000 }, () => {
  it("write 500 singles, each its own album and artist at the longest names, inside each call's limits", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "singles-admin", "admin");
    const { libraryId, scanJobId, roots } = await musicLibrary(admin, "Singles");
    const [root] = roots;

    if (root === undefined) throw new Error("one folder");

    const tracks = Array.from({ length: 500 }, (_, n) =>
      musicTrack(`${root}/${n}/${wide(200, n)}.flac`, 1000, 1, {
        title: wide(600, n),
        artist: wide(600, n),
        album: wide(600, n),
        genre: wide(200, n),
        artHash: `${n}`.padStart(64, "0"),
        folderArt: wide(1200, n),
        lyricsFiles: wide(1200, n),
      }),
    );

    const lease = await claimScan(stack, scanJobId);
    const mark = await logMark(stack);
    const written = await upsertAll(stack, lease, tracks);
    const usage = await usageSince(stack, mark, api.music.scanner.upsert, written.length);

    expect(written.reduce((sum, call) => sum + call.done, 0)).toBe(500);
    expect(written.every((call) => call.done > 0)).toBe(true);
    expect(inside(usage.filter((call) => call.committed))).toBe(true);
    expect(await totalsOf(stack, libraryId)).toMatchObject({
      tracks: 500,
      albums: 500,
      artists: 500,
    });

    const missingMark = await logMark(stack);

    const marked = await markMissingAll(
      stack,
      lease,
      tracks.map((track) => track.path),
    );

    const missingUsage = await usageSince(
      stack,
      missingMark,
      api.music.scanner.missing,
      marked.length,
    );

    expect(inside(missingUsage.filter((call) => call.committed))).toBe(true);
    expect(await totalsOf(stack, libraryId)).toMatchObject({ tracks: 0, albums: 0, artists: 0 });
    expect((await rowsOf(stack, libraryId)).rows).toBe(500);

    await finishScan(stack, lease);
  });

  it("rewrite tracks with large lyrics, reading and writing each call's bytes inside the limit", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "lyrics-limits", "admin");
    const { scanJobId, roots } = await musicLibrary(admin, "Long lyrics");
    const [root] = roots;

    if (root === undefined) throw new Error("one folder");

    const tracks = (round: number) =>
      Array.from({ length: 24 }, (_, n) =>
        musicTrack(`${root}/Album/${n}.flac`, 1000 + round, round, { lyrics: [verse(n, round)] }),
      );

    const lease = await claimScan(stack, scanJobId);

    await upsertAll(stack, lease, tracks(1));

    const mark = await logMark(stack);
    const written = await upsertAll(stack, lease, tracks(2));
    const usage = await usageSince(stack, mark, api.music.scanner.upsert, written.length);

    expect(written.reduce((sum, call) => sum + call.done, 0)).toBe(24);
    expect(inside(usage.filter((call) => call.committed))).toBe(true);

    await finishScan(stack, lease);
  });
});
