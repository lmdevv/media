import { join } from "node:path";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { DOCUMENT_BYTES } from "../../convex/movies/fit";
import { runFunction } from "../admin";
import { eventually } from "../core/jobs/driver";
import { member } from "../devices";
import { runServer } from "../service";
import { coreStackFromEnvFile } from "../stack-env";
import type { CoreStack } from "../stack-env";
import {
  Landed,
  Reprobed,
  claimJob,
  finishJob,
  knownFiles,
  markMissing,
  moviesLibrary,
  rowsOf,
  titleStateOf,
  totalsOf,
  upsert,
} from "./catalog";
import { episodeFile, movieFile, scannedTitle } from "./scanned";
import type { ScannedItem } from "./scanned";

const stack = coreStackFromEnvFile();

const FileRecord = Schema.Struct({
  bytes: Schema.Finite,
  probe: Schema.String,
  probeRevision: Schema.NullOr(Schema.Finite),
  hdr: Schema.Boolean,
  rest: Schema.String,
});

/** File `fileId` as stored: its size, its probe fields, and the rest of it as JSON text. */
const recordOf = (core: CoreStack, fileId: Id<"mediaFiles">) =>
  runFunction(core, internal.movies.probe.fileRecord, { fileId }, FileRecord);

/**
 * A chapter a second long, the `n`th, its title padded by `extra` characters; titles number from
 * 1000, so each costs the same until 9000.
 */
const chapterAt = (n: number, extra = 0) => ({
  startMs: n * 1000,
  endMs: (n + 1) * 1000,
  title: `Chapter ${String(n + 1000)}${"x".repeat(extra)}`,
});

/** `count` chapters, the last padded by `extra` characters. */
const chaptersOf = (count: number, extra = 0) =>
  Array.from({ length: count }, (_, n) => chapterAt(n, n === count - 1 ? extra : 0));

/**
 * A subtitle file beside the film, the `n`th, its name padded by `extra` characters; they number
 * from 1000, so each costs the same until 9000.
 */
const subtitleAt = (n: number, extra = 0) => ({
  fileName: `Bounded Editions (2026).${String(n + 1000)}${"x".repeat(extra)}.en.srt`,
  codec: "subrip",
  language: "eng",
  title: `English subtitles, restored theatrical release, part ${String(n + 1000)}`,
  forced: false,
});

/** `count` subtitle files, the last name padded by `extra` characters. */
const subtitlesOf = (count: number, extra = 0) =>
  Array.from({ length: count }, (_, n) => subtitleAt(n, n === count - 1 ? extra : 0));

describe.skipIf(stack === undefined)("movies scanner callbacks", { timeout: 180_000 }, () => {
  it("write titles, episodes, and files, keep missing files' rows, and count all three", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "scanner-admin", "admin");
    const { libraryId, scanJobId, roots } = await moviesLibrary(admin, "Scanned");
    const root = roots[0] ?? "";
    const lease = await claimJob(stack, "movies.scan", scanJobId);
    const show = scannedTitle("show", "tmdb:1", "Pioneer One", 13);

    const items = [
      movieFile(join(root, "Sintel.mkv"), 10, 1, scannedTitle("movie", "tmdb:2", "Sintel", 13)),
      movieFile(join(root, "Tears.mkv"), 20, 1, scannedTitle("movie", "tmdb:3", "Tears", null)),
      episodeFile(join(root, "Pioneer", "s01e01.mkv"), show, 1, 1),
      episodeFile(join(root, "Pioneer", "s01e02.mkv"), show, 1, 2),
      episodeFile(join(root, "Pioneer", "s01e03.mkv"), show, 1, 3),
    ];

    const landed = await upsert(stack, lease, items);

    if (landed.outcome !== "held") throw new Error(`upsert answered ${landed.outcome}`);

    expect(landed.value.files).toHaveLength(5);
    expect(new Set(landed.value.files.map((file) => file.titleId)).size).toBe(3);

    const counted = { titles: 3, episodes: 3, files: 5 };

    expect(await totalsOf(stack, libraryId)).toEqual(counted);
    expect(await rowsOf(stack, libraryId)).toEqual(counted);
    expect((await admin.signedIn.client.query(api.core.libraries.get, { libraryId })).items).toBe(
      3,
    );

    expect(await upsert(stack, lease, items)).toMatchObject({ outcome: "held" });
    expect(await totalsOf(stack, libraryId)).toEqual(counted);

    const gone = join(root, "Pioneer", "s01e03.mkv");

    expect(await markMissing(stack, lease, [gone, gone])).toEqual({
      outcome: "held",
      value: { marked: 1, done: 2 },
    });
    expect(await markMissing(stack, lease, [gone])).toEqual({
      outcome: "held",
      value: { marked: 0, done: 1 },
    });

    const known = await knownFiles(stack, lease);

    expect(known.filter((file) => file.missing).map((file) => file.path)).toEqual([gone]);
    expect(await totalsOf(stack, libraryId)).toEqual(counted);

    await upsert(stack, lease, [episodeFile(gone, show, 1, 3)]);

    expect((await knownFiles(stack, lease)).some((file) => file.missing)).toBe(false);
    expect(await rowsOf(stack, libraryId)).toEqual(counted);
    await finishJob(stack, lease);
  });

  it("write a probe read again and its revision, and nothing else of the file, its title, or its history", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "scanner-reprobed", "admin");
    const { scanJobId, roots } = await moviesLibrary(admin, "Reprobed");
    const path = join(roots[0] ?? "", "Matched Elsewhere (2004).mkv");
    const lease = await claimJob(stack, "movies.scan", scanJobId);
    const matched = scannedTitle("movie", "tmdb:4242", "Matched Elsewhere");
    const film = movieFile(path, 10, 1, matched, true);
    const landed = await upsert(stack, lease, [film]);

    if (landed.outcome !== "held") throw new Error(`upsert answered ${landed.outcome}`);
    const [file] = landed.value.files;
    const [stream] = film.file.probe.video;

    if (file === undefined || stream === undefined) throw new Error("no file with video landed");

    // Older readers stored no revision; the helper's files carry revision 1.
    expect((await knownFiles(stack, lease)).map((known) => known.probeRevision)).toEqual([1]);

    const started = await admin.signedIn.client.mutation(api.movies.play.start, {
      titleId: file.titleId,
    });

    await admin.signedIn.client.mutation(api.movies.play.report, {
      fileId: started.file.id,
      positionMs: 60_000,
      event: "tick",
      playbackId: started.playbackId,
      startedAt: started.startedAt,
    });

    const before = await admin.signedIn.client.query(api.movies.titles.get, {
      titleId: file.titleId,
    });

    const probe = {
      ...film.file.probe,
      video: [{ ...stream, frameRate: 25, fieldOrder: "tff" as const }],
    };

    // The second is the same file found with another size: changed since, so left alone.
    const reprobed = await runServer(
      stack,
      api.movies.scanner.reprobed,
      {
        lease,
        files: [
          { path, sizeBytes: 10, mtimeMs: 1, probe, probeRevision: 2 },
          { path, sizeBytes: 11, mtimeMs: 1, probe, probeRevision: 3 },
        ],
      },
      Reprobed,
    );

    expect(reprobed).toEqual({ outcome: "held", value: { written: 1, done: 2, unfit: [] } });
    expect((await knownFiles(stack, lease)).map((known) => known.probeRevision)).toEqual([2]);

    const after = await admin.signedIn.client.query(api.movies.titles.get, {
      titleId: file.titleId,
    });

    const [beforeFile] = before.files;

    expect(after.files).toEqual(beforeFile === undefined ? [] : [{ ...beforeFile, probe }]);
    expect({ ...after, files: [] }).toEqual({ ...before, files: [] });
    expect(after.progress?.positionMs).toBe(60_000);
    await finishJob(stack, lease);
  });

  it("make room for a larger probe read again out of the probe alone, a few bytes under the bound", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "scanner-reprobed-bound", "admin");
    const { scanJobId, roots } = await moviesLibrary(admin, "Reprobed Bound");
    const path = join(roots[0] ?? "", "Bounded Editions (2026).mkv");
    const lease = await claimJob(stack, "movies.scan", scanJobId);
    const base = movieFile(path, 10, 1, scannedTitle("movie", "tmdb:4300", "Bounded"), true);
    const [stream] = base.file.probe.video;

    if (stream === undefined) throw new Error("the helper's file has no video");

    // An edition name and subtitle titles a shared fitter could shorten, beside a long chapter list.
    const filmWith = (chapters: ReturnType<typeof chapterAt>[]): ScannedItem => ({
      ...base,
      file: {
        ...base.file,
        versionName:
          "Restored theatrical release with reconstructed original audio and alternate opening titles",
        externalSubtitles: [subtitleAt(1), subtitleAt(2)],
        probe: { ...base.file.probe, chapters },
      },
    });

    const stored = async (chapters: ReturnType<typeof chapterAt>[]) => {
      const landed = await upsert(stack, lease, [filmWith(chapters)]);

      if (landed.outcome !== "held") throw new Error(`upsert answered ${landed.outcome}`);
      const [file] = landed.value.files;

      if (file === undefined) throw new Error("no file landed");

      return { fileId: file.fileId, ...(await recordOf(stack, file.fileId)) };
    };

    // Each chapter costs the same; the last is padded to land 10 bytes under the bound.
    const one = await stored(chaptersOf(100));
    const each = (await stored(chaptersOf(101))).bytes - one.bytes;
    const room = DOCUMENT_BYTES.mediaFiles - 10 - one.bytes;
    const count = 100 + Math.floor(room / each);
    const before = await stored(chaptersOf(count, room % each));

    expect(before.bytes).toBe(DOCUMENT_BYTES.mediaFiles - 10);

    const probe = {
      ...filmWith(chaptersOf(count, room % each)).file.probe,
      video: [{ ...stream, fieldOrder: "tff" as const }],
    };

    const reprobed = await runServer(
      stack,
      api.movies.scanner.reprobed,
      { lease, files: [{ path, sizeBytes: 10, mtimeMs: 1, probe, probeRevision: 2 }] },
      Reprobed,
    );

    expect(reprobed).toEqual({ outcome: "held", value: { written: 1, done: 1, unfit: [] } });

    const after = await recordOf(stack, before.fileId);

    expect(after.bytes).toBeLessThanOrEqual(DOCUMENT_BYTES.mediaFiles);
    expect(after.rest).toBe(before.rest);
    expect(after.probeRevision).toBe(2);
    expect(after.probe).toContain('"fieldOrder":"tff"');
    await finishJob(stack, lease);
  });

  it("keep a file's old probe and revision when a probe read again cannot fit beside its row", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "scanner-reprobed-unfit", "admin");
    const { scanJobId, roots } = await moviesLibrary(admin, "Reprobed Unfit");
    const path = join(roots[0] ?? "", "Bounded Editions (2026).mkv");
    const lease = await claimJob(stack, "movies.scan", scanJobId);
    const base = movieFile(path, 10, 1, scannedTitle("movie", "tmdb:4301", "Bounded"), true);
    const [stream] = base.file.probe.video;

    if (stream === undefined) throw new Error("the helper's file has no video");

    // Subtitle files fill the row, which a probe can only make room in by losing its video.
    const stored = async (list: ReturnType<typeof subtitleAt>[]) => {
      const landed = await upsert(stack, lease, [
        { ...base, file: { ...base.file, externalSubtitles: list } },
      ]);

      if (landed.outcome !== "held") throw new Error(`upsert answered ${landed.outcome}`);
      const [file] = landed.value.files;

      if (file === undefined) throw new Error("no file landed");

      return { fileId: file.fileId, ...(await recordOf(stack, file.fileId)) };
    };

    const one = await stored(subtitlesOf(60));
    const each = (await stored(subtitlesOf(61))).bytes - one.bytes;
    const room = DOCUMENT_BYTES.mediaFiles - 10 - one.bytes;
    const before = await stored(subtitlesOf(60 + Math.floor(room / each), room % each));

    expect(before.bytes).toBe(DOCUMENT_BYTES.mediaFiles - 10);

    const probe = { ...base.file.probe, video: [{ ...stream, fieldOrder: "tff" as const }] };

    const reprobed = await runServer(
      stack,
      api.movies.scanner.reprobed,
      { lease, files: [{ path, sizeBytes: 10, mtimeMs: 1, probe, probeRevision: 2 }] },
      Reprobed,
    );

    expect(reprobed).toEqual({ outcome: "held", value: { written: 0, done: 1, unfit: [path] } });

    const { fileId, ...was } = before;

    expect(await recordOf(stack, fileId)).toEqual(was);
    expect((await knownFiles(stack, lease)).map((known) => known.probeRevision)).toEqual([1]);
    await finishJob(stack, lease);
  });

  it("refuse a batch over 500 files or paths, and a path outside the folders", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "scanner-bounds", "admin");
    const { libraryId, scanJobId, roots } = await moviesLibrary(admin, "Bounded");
    const root = roots[0] ?? "";
    const lease = await claimJob(stack, "movies.scan", scanJobId);

    const many = Array.from({ length: 501 }, (_, n) => movieFile(join(root, `${n}.mkv`)));

    await expect(upsert(stack, lease, many)).rejects.toThrow(/at most 500/u);
    await expect(upsert(stack, lease, [movieFile("/elsewhere/a.mkv")])).rejects.toThrow(
      /not a path inside/u,
    );
    await expect(
      markMissing(
        stack,
        lease,
        many.map((item) => item.file.path),
      ),
    ).rejects.toThrow(/at most 500/u);
    expect(await totalsOf(stack, libraryId)).toEqual({ titles: 0, episodes: 0, files: 0 });
    await finishJob(stack, lease);
  });

  it("write nothing for a canceled scan or for a lease the cron released", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "scanner-stale", "admin");
    const first = await moviesLibrary(admin, "Canceled");
    const lease = await claimJob(stack, "movies.scan", first.scanJobId);

    await runFunction(
      stack,
      internal.core.jobs.admin.cancel,
      { jobId: lease.jobId },
      Schema.Struct({ outcome: Schema.String }),
    );

    expect(await upsert(stack, lease, [movieFile(join(first.roots[0] ?? "", "a.mkv"))])).toEqual({
      outcome: "canceled",
    });
    expect(await totalsOf(stack, first.libraryId)).toEqual({ titles: 0, episodes: 0, files: 0 });

    const second = await moviesLibrary(admin, "Lapsed");
    const short = await claimJob(stack, "movies.scan", second.scanJobId, 5000);

    await eventually(
      "the cron to release the lapsed lease",
      async () => {
        const job = await admin.signedIn.client.query(api.core.libraries.get, {
          libraryId: second.libraryId,
        });

        return job.scan?.status === "queued" ? true : null;
      },
      60_000,
    );

    expect(
      await runServer(
        stack,
        api.movies.scanner.upsert,
        { lease: short, items: [movieFile(join(second.roots[0] ?? "", "a.mkv"))] },
        Landed,
      ),
    ).toEqual({ outcome: "lost" });
    expect(await totalsOf(stack, second.libraryId)).toEqual({ titles: 0, episodes: 0, files: 0 });
  });

  it("keep every genre an NFO names, and write a batch whatever one file's genre count", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "scanner-genres", "admin");
    const { scanJobId, roots } = await moviesLibrary(admin, "Genres");
    const root = roots[0] ?? "";
    const lease = await claimJob(stack, "movies.scan", scanJobId);

    const titled = (name: string, count: number) =>
      movieFile(join(root, `${name}.mkv`), 1, 1, {
        ...scannedTitle("movie", `nfo:${name}`, name),
        genres: Array.from({ length: count }, (_, n) => `Genre ${n}`),
      });

    const landed = await upsert(stack, lease, [
      titled("Plain", 2),
      titled("Twenty-one", 21),
      titled("Hundred", 100),
      titled("Too many", 300),
    ]);

    await finishJob(stack, lease);

    if (landed.outcome !== "held") throw new Error(`upsert answered ${landed.outcome}`);

    expect(landed.value.done).toBe(4);
    expect(
      await Promise.all(
        landed.value.files.map(async (file) => (await titleStateOf(stack, file.titleId))?.genres),
      ),
    ).toEqual([2, 21, 100, 256]);
  });
});
