import { join } from "node:path";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { runFunction } from "../admin";
import { member } from "../devices";
import { seedLibrary, sessionOf, show } from "../probe";
import { runServer, runServerAs } from "../service";
import { refusal } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";
import type { CoreStack } from "../stack-env";
import {
  JobId,
  PersonId,
  answer,
  applyMetadataAll,
  askMatch,
  askRefresh,
  claimJob,
  finishJob,
  moviesLibrary,
  titleStateOf,
  upsert,
} from "./catalog";
import type { Lease } from "./catalog";
import { episodeFile, movieFile, scannedTitle } from "./scanned";

const stack = coreStackFromEnvFile();

const Done = answer(Schema.Null);

const Applied = answer(Schema.Struct({ done: Schema.Finite, applied: Schema.Boolean }));

const Credits = answer(
  Schema.Struct({
    written: Schema.Boolean,
    people: Schema.Array(
      Schema.Struct({
        personId: PersonId,
        tmdbId: Schema.NullOr(Schema.String),
        needsDetails: Schema.Boolean,
      }),
    ),
  }),
);

const Target = Schema.Struct({ name: Schema.String, year: Schema.NullOr(Schema.Finite) });

const PersonTarget = Schema.Struct({ name: Schema.String });

const manifestOf = (version: string) => ({
  version,
  intervalMs: 10_000,
  tileWidth: 320,
  tileHeight: 180,
  columns: 10,
  rows: 10,
  thumbnailCount: 6,
  sheetCount: 1,
});

const Versions = Schema.Array(
  Schema.Struct({ fileId: Schema.String, version: Schema.NullOr(Schema.String) }),
);

const enqueue = (core: CoreStack, payload: Parameters<typeof enqueueArgs>[0]) =>
  runFunction(core, internal.movies.probe.enqueueJob, { payload }, JobId);

const enqueueArgs = (
  payload:
    | {
        kind: "movies.metadata";
        titleId: Id<"titles">;
        match: { provider: "tmdb"; providerId: string } | null;
        revision: number;
        generation: number;
      }
    | { kind: "movies.person"; personId: Id<"people">; revision: number },
) => payload;

const credit = (name: string, tmdb: string, order: number) => ({
  person: { name, externalIds: { tmdb, imdb: null, tvdb: null }, profile: null },
  kind: "actor" as const,
  role: null,
  order,
});

const stale = { outcome: "held", value: { done: 0, applied: false } } as const;

const scannedTitleOf = async (label: string, kind: "movie" | "show") => {
  if (stack === undefined) throw new Error("no stack");

  const admin = await member(stack, label, "admin");
  const { scanJobId, roots } = await moviesLibrary(admin, label);
  const scan = await claimJob(stack, "movies.scan", scanJobId);
  const name = kind === "show" ? "Pioneer Won" : "Sintle";

  const item =
    kind === "show"
      ? episodeFile(join(roots[0] ?? "", "1.mkv"), scannedTitle("show", "nfo:s", name), 1, 1)
      : movieFile(join(roots[0] ?? "", "a.mkv"), 1, 1, scannedTitle("movie", "nfo:m", name));

  const landed = await upsert(stack, scan, [item]);

  await finishJob(stack, scan);

  if (landed.outcome !== "held") throw new Error(`upsert answered ${landed.outcome}`);

  const titleId = landed.value.files[0]?.titleId;

  if (titleId === undefined) throw new Error("no title landed");

  return titleId;
};

const nameOf = async (titleId: Id<"titles">) => {
  if (stack === undefined) throw new Error("no stack");

  return (
    await runServer(stack, api.movies.metadata.metadataTarget, { titleId, cursor: null }, Target)
  ).name;
};

const Links = Schema.Struct({
  credited: Schema.Array(Schema.String),
  collections: Schema.Array(
    Schema.Struct({
      sourceKey: Schema.NullOr(Schema.String),
      name: Schema.String,
      source: Schema.String,
    }),
  ),
});

/** What the writers stored for a title: its credited people and its collections, read back. */
const linksOf = async (titleId: Id<"titles">) => {
  if (stack === undefined) throw new Error("no stack");

  return runFunction(stack, internal.movies.probe.titleLinks, { titleId }, Links);
};

/** Puts the title in the collection `key` named `name` under `lease`. */
const collectAs = (lease: Lease, titleId: Id<"titles">, key: string, name: string) => {
  if (stack === undefined) throw new Error("no stack");

  return runServer(
    stack,
    api.movies.metadata.applyCollection,
    {
      lease,
      titleId,
      collection: { sourceKey: key, name, overview: null, poster: null, backdrop: null },
      hash: key,
    },
    Done,
  );
};

const creditAs = (lease: Lease, titleId: Id<"titles">, hash: string) => {
  if (stack === undefined) throw new Error("no stack");

  return runServer(
    stack,
    api.movies.metadata.applyCredits,
    { lease, titleId, episodeId: null, credits: [credit(`Cast ${hash}`, hash, 0)], hash },
    Credits,
  );
};

describe.skipIf(stack === undefined)("movies writers", { timeout: 180_000 }, () => {
  it("write metadata, credits, people, and a collection under their jobs' leases", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "writers-admin", "admin");
    const { scanJobId, roots } = await moviesLibrary(admin, "Written");
    const scan = await claimJob(stack, "movies.scan", scanJobId);
    const path = join(roots[0] ?? "", "Sintel.mkv");

    const landed = await upsert(stack, scan, [
      movieFile(path, 1, 1, scannedTitle("movie", "tmdb:45745", "Sintel", null)),
    ]);

    if (landed.outcome !== "held") throw new Error(`upsert answered ${landed.outcome}`);

    const titleId = landed.value.files[0]?.titleId;

    if (titleId === undefined) throw new Error("no title landed");

    const scanned = await runServer(
      stack,
      api.movies.metadata.applyCredits,
      { lease: scan, titleId, episodeId: null, credits: [credit("Halina", "1", 0)], hash: "a" },
      Credits,
    );

    expect(scanned).toMatchObject({ outcome: "held", value: { written: true } });
    expect(
      await runServer(
        stack,
        api.movies.metadata.applyCredits,
        { lease: scan, titleId, episodeId: null, credits: [], hash: "a" },
        Credits,
      ),
    ).toEqual({ outcome: "held", value: { written: false, people: [] } });

    await finishJob(stack, scan);

    const jobId = await enqueue(
      stack,
      enqueueArgs({ kind: "movies.metadata", titleId, match: null, revision: 1, generation: 0 }),
    );

    const lease = await claimJob(stack, "movies.metadata", jobId);

    expect(
      await refusal(
        runServerAs(
          stack,
          admin.signedIn,
          api.movies.metadata.metadataTarget,
          { titleId, cursor: null },
          Target,
        ),
      ),
    ).toBe("forbidden");
    expect(
      await runServer(stack, api.movies.metadata.metadataTarget, { titleId, cursor: null }, Target),
    ).toEqual({ name: "Sintel", year: null });
    expect(
      await runServer(
        stack,
        api.movies.metadata.applyMetadata,
        {
          lease,
          titleId,
          title: { ...scannedTitle("movie", "tmdb:45745", "Sintel", 13), year: 2010 },
          episodes: [],
        },
        Applied,
      ),
    ).toEqual({ outcome: "held", value: { done: 0, applied: true } });
    expect(
      await runServer(stack, api.movies.metadata.metadataTarget, { titleId, cursor: null }, Target),
    ).toEqual({ name: "Sintel", year: 2010 });

    const refreshed = await runServer(
      stack,
      api.movies.metadata.applyCredits,
      { lease, titleId, episodeId: null, credits: [credit("Thom", "2", 0)], hash: "b" },
      Credits,
    );

    if (refreshed.outcome !== "held") throw new Error(`credits answered ${refreshed.outcome}`);

    expect(refreshed.value.written).toBe(false);

    const personId = refreshed.value.people[0]?.personId;

    if (personId === undefined) throw new Error("no person credited");

    expect(
      await runServer(
        stack,
        api.movies.metadata.applyCollection,
        {
          lease,
          titleId,
          collection: {
            sourceKey: "tmdb:9",
            name: "Blender films",
            overview: null,
            poster: null,
            backdrop: null,
          },
          hash: "c",
        },
        Done,
      ),
    ).toEqual({ outcome: "held", value: null });

    const details = {
      name: "Halina Reijn",
      externalIds: { tmdb: "1", imdb: null, tvdb: null },
      profile: null,
      biography: "An actor.",
      birthDate: null,
      deathDate: null,
      birthPlace: null,
      knownFor: null,
    };

    expect(
      await runServer(stack, api.movies.people.applyPerson, { lease, personId, details }, Done),
    ).toEqual({ outcome: "held", value: null });

    await finishJob(stack, lease);

    const personJob = await enqueue(
      stack,
      enqueueArgs({ kind: "movies.person", personId, revision: 1 }),
    );

    const personLease = await claimJob(stack, "movies.person", personJob);

    expect(
      await runServer(stack, api.movies.people.personTarget, { personId }, PersonTarget),
    ).toEqual({ name: "Halina Reijn" });
    await expect(
      runServer(
        stack,
        api.movies.metadata.applyMetadata,
        { lease: personLease, titleId, title: scannedTitle("movie", "x", "x"), episodes: [] },
        Applied,
      ),
    ).rejects.toThrow(/movies\.person/u);
    await finishJob(stack, personLease);

    expect(
      await runServer(
        stack,
        api.movies.people.applyPerson,
        { lease: personLease, personId, details },
        Done,
      ),
    ).toEqual({ outcome: "lost" });
  });

  it("queue scrub thumbnails for a new video file and record them under its job", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "trickplay-admin", "admin");
    const { scanJobId, roots } = await moviesLibrary(admin, "Thumbnails");
    const scan = await claimJob(stack, "movies.scan", scanJobId);
    const path = join(roots[0] ?? "", "Sintel.mkv");

    const landed = await upsert(stack, scan, [
      movieFile(path, 5, 5, scannedTitle("movie", "tmdb:45745", "Sintel"), true),
    ]);

    if (landed.outcome !== "held") throw new Error(`upsert answered ${landed.outcome}`);

    const fileId = landed.value.files[0]?.fileId;

    if (fileId === undefined) throw new Error("no file landed");

    await finishJob(stack, scan);

    const Trickplay = Schema.Struct({
      trickplay: Schema.Struct({ status: Schema.Literal("pending"), jobId: JobId }),
    });

    const pending = await runFunction(
      stack,
      internal.movies.probe.fileState,
      { fileId },
      Trickplay,
    );

    const lease = await claimJob(stack, "movies.trickplay", pending.trickplay.jobId);

    const manifest = {
      version: "v1",
      intervalMs: 10_000,
      tileWidth: 320,
      tileHeight: 180,
      columns: 10,
      rows: 10,
      thumbnailCount: 6,
      sheetCount: 1,
    };

    expect(
      await runServer(
        stack,
        api.movies.trickplay.recordTrickplay,
        { lease, fileId, sizeBytes: 5, mtimeMs: 5, manifest },
        Done,
      ),
    ).toEqual({ outcome: "held", value: null });
    expect(
      await runServer(
        stack,
        api.movies.trickplay.trickplayVersions,
        { fileIds: [fileId, "not-an-id"] },
        Versions,
      ),
    ).toEqual([
      { fileId, version: "v1" },
      { fileId: "not-an-id", version: null },
    ]);
    await finishJob(stack, lease);
  });

  it("list a show's episodes for a metadata job page by page, past any one page", async () => {
    if (stack === undefined) return;
    const owner = await sessionOf((await member(stack, "target-owner")).signedIn);

    const long = await seedLibrary(stack, owner, {
      name: "Long running",
      kind: "movies",
      items: [show("Daily show", null, 1001)],
    });

    const titleId = long.itemIds[0];

    if (titleId === undefined) throw new Error("seeded no show");

    const Page = Schema.Struct({
      episodes: Schema.Array(Schema.Struct({ episodeId: Schema.String })),
      continueCursor: Schema.String,
      isDone: Schema.Boolean,
    });

    const pages = async (
      cursor: string | null = null,
      seen: ReadonlyArray<number> = [],
      ids: ReadonlyArray<string> = [],
    ): Promise<{ readonly sizes: ReadonlyArray<number>; readonly ids: ReadonlyArray<string> }> => {
      const page = await runServer(
        stack,
        api.movies.metadata.metadataTarget,
        { titleId, cursor },
        Page,
      );

      const sizes = [...seen, page.episodes.length];
      const all = [...ids, ...page.episodes.map((one) => one.episodeId)];

      return page.isDone ? { sizes, ids: all } : pages(page.continueCursor, sizes, all);
    };

    const listed = await pages();

    expect(listed.sizes[0]).toBe(1000);
    expect(new Set(listed.ids).size).toBe(1001);
    expect(listed.ids).toHaveLength(1001);
  });

  it("queue thumbnails for a file's new contents while the job for its old ones still runs", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "trickplay-change", "admin");
    const { scanJobId, roots } = await moviesLibrary(admin, "Changed file");
    const scan = await claimJob(stack, "movies.scan", scanJobId, 600_000);
    const path = join(roots[0] ?? "", "Sintel.mkv");
    const title = scannedTitle("movie", "tmdb:45745", "Sintel");

    const landed = await upsert(stack, scan, [movieFile(path, 5, 5, title, true)]);

    if (landed.outcome !== "held") throw new Error(`upsert answered ${landed.outcome}`);

    const fileId = landed.value.files[0]?.fileId;

    if (fileId === undefined) throw new Error("no file landed");

    const State = Schema.Struct({
      trickplay: Schema.NullOr(
        Schema.Struct({ status: Schema.String, jobId: Schema.optionalKey(JobId) }),
      ),
    });

    const stateOf = async () =>
      (await runFunction(stack, internal.movies.probe.fileState, { fileId }, State)).trickplay;

    const JobStatus = Schema.NullOr(Schema.Struct({ status: Schema.String }));

    const statusOf = async (jobId: Id<"jobs">) =>
      (await runFunction(stack, internal.core.jobs.admin.get, { jobId }, JobStatus))?.status;

    const firstJob = (await stateOf())?.jobId;

    if (firstJob === undefined) throw new Error("the scan queued no thumbnails");

    const first = await claimJob(stack, "movies.trickplay", firstJob, 600_000);

    const record = (lease: Lease, size: number, version: string) =>
      runServer(
        stack,
        api.movies.trickplay.recordTrickplay,
        { lease, fileId, sizeBytes: size, mtimeMs: size, manifest: manifestOf(version) },
        Done,
      );

    // The old job records, then the file changes before that job finishes.
    await record(first, 5, "v1");

    expect(await stateOf()).toMatchObject({ status: "ready" });

    await upsert(stack, scan, [movieFile(path, 6, 6, title, true)]);

    const pending = await stateOf();
    const secondJob = pending?.jobId;

    expect(pending?.status).toBe("pending");
    expect(secondJob).toBeDefined();
    expect(secondJob).not.toBe(firstJob);

    if (secondJob === undefined) throw new Error("no job for the new contents");

    // The old job's late result, for contents the file no longer has, changes nothing.
    await record(first, 5, "v1-late");
    await finishJob(stack, first);
    await finishJob(stack, scan);

    expect(await stateOf()).toMatchObject({ status: "pending", jobId: secondJob });
    expect(await statusOf(secondJob)).toBe("queued");

    const second = await claimJob(stack, "movies.trickplay", secondJob, 600_000);

    await record(second, 6, "v2");
    await finishJob(stack, second);

    expect(
      await runServer(
        stack,
        api.movies.trickplay.trickplayVersions,
        { fileIds: [fileId] },
        Versions,
      ),
    ).toEqual([{ fileId, version: "v2" }]);
  });

  describe("a title's match generation", () => {
    it("write every episode of a manual match on a show, across continuation calls", async () => {
      if (stack === undefined) return;
      const titleId = await scannedTitleOf("match-big", "show");
      const lease = await claimJob(stack, "movies.metadata", await askMatch(stack, titleId, "1"));

      const episodes = Array.from({ length: 500 }, (_, n) => {
        const { episode } = episodeFile("/unused", scannedTitle("show", "x", "x"), 1, n + 2);

        if (episode === null) throw new Error("an episode file has an episode");

        return episode;
      });

      const run = await applyMetadataAll(
        stack,
        lease,
        titleId,
        {
          ...scannedTitle("show", "tmdb:1", "Pioneer One"),
          genres: Array.from({ length: 256 }, (_, n) => `Genre ${n}`),
        },
        episodes,
      );

      expect(run.applied).toBe(true);
      expect(run.written.length).toBeGreaterThan(1);
      expect(await titleStateOf(stack, titleId)).toMatchObject({ episodes: 501 });
      expect(await creditAs(lease, titleId, "after")).toMatchObject({
        value: { written: true },
      });
      await finishJob(stack, lease);
      expect(await nameOf(titleId)).toBe("Pioneer One");
      expect((await linksOf(titleId)).credited).toEqual(["Cast after"]);
    });

    it("land a manual match's credits and collection written after its metadata", async () => {
      if (stack === undefined) return;
      const titleId = await scannedTitleOf("match-credits", "movie");
      const lease = await claimJob(stack, "movies.metadata", await askMatch(stack, titleId, "2"));

      expect(
        await applyMetadataAll(
          stack,
          lease,
          titleId,
          scannedTitle("movie", "tmdb:2", "Sintel"),
          [],
        ),
      ).toEqual({ written: [0], applied: true });
      expect(await creditAs(lease, titleId, "manual")).toMatchObject({
        outcome: "held",
        value: { written: true },
      });
      expect(await collectAs(lease, titleId, "tmdb:c2", "Blender")).toEqual({
        outcome: "held",
        value: null,
      });
      await finishJob(stack, lease);

      // The answer alone is the same for a dropped write, so read back what was stored.
      expect(await linksOf(titleId)).toEqual({
        credited: ["Cast manual"],
        collections: [{ sourceKey: "tmdb:c2", name: "Blender", source: "metadata" }],
      });
    });

    it("drop a refresh asked for before an admin's match, so it never overwrites that match", async () => {
      if (stack === undefined) return;
      const titleId = await scannedTitleOf("match-race", "movie");
      const refresh = await claimJob(stack, "movies.metadata", await askRefresh(stack, titleId));

      expect(await nameOf(titleId)).toBe("Sintle");

      const match = await claimJob(stack, "movies.metadata", await askMatch(stack, titleId, "3"));

      expect(
        await applyMetadataAll(
          stack,
          match,
          titleId,
          scannedTitle("movie", "tmdb:3", "Sintel"),
          [],
        ),
      ).toMatchObject({ applied: true });
      await creditAs(match, titleId, "match");
      await collectAs(match, titleId, "tmdb:c3", "Right set");
      await finishJob(stack, match);

      const matched = {
        credited: ["Cast match"],
        collections: [{ sourceKey: "tmdb:c3", name: "Right set", source: "metadata" }],
      };

      expect(await linksOf(titleId)).toEqual(matched);

      const late = await runServer(
        stack,
        api.movies.metadata.applyMetadata,
        {
          lease: refresh,
          titleId,
          title: scannedTitle("movie", "nfo:m", "Wrong film"),
          episodes: [],
        },
        Applied,
      );

      expect(late).toEqual(stale);
      expect(await creditAs(refresh, titleId, "stale")).toEqual({
        outcome: "held",
        value: { written: false, people: [] },
      });
      await collectAs(refresh, titleId, "tmdb:wrong", "Wrong set");
      await finishJob(stack, refresh);
      expect(await nameOf(titleId)).toBe("Sintel");
      expect(await linksOf(titleId)).toEqual(matched);

      const later = await claimJob(stack, "movies.metadata", await askRefresh(stack, titleId));

      expect(
        await applyMetadataAll(
          stack,
          later,
          titleId,
          scannedTitle("movie", "tmdb:3", "Sintel 2010"),
          [],
        ),
      ).toMatchObject({ applied: true });
      await finishJob(stack, later);
      expect(await nameOf(titleId)).toBe("Sintel 2010");
    });

    it("let a second manual match supersede the first, whose late writes are dropped", async () => {
      if (stack === undefined) return;
      const titleId = await scannedTitleOf("match-twice", "movie");
      const first = await claimJob(stack, "movies.metadata", await askMatch(stack, titleId, "4"));
      const second = await claimJob(stack, "movies.metadata", await askMatch(stack, titleId, "5"));

      const apply = (lease: Lease, name: string) =>
        runServer(
          stack,
          api.movies.metadata.applyMetadata,
          { lease, titleId, title: scannedTitle("movie", "tmdb:x", name), episodes: [] },
          Applied,
        );

      expect(await apply(first, "First match")).toEqual(stale);
      expect(await apply(second, "Second match")).toEqual({
        outcome: "held",
        value: { done: 0, applied: true },
      });
      expect(await apply(first, "First match, late")).toEqual(stale);
      expect(await creditAs(second, titleId, "second")).toMatchObject({ value: { written: true } });
      await collectAs(second, titleId, "tmdb:c5", "Second set");
      expect(await creditAs(first, titleId, "first")).toMatchObject({ value: { written: false } });
      await collectAs(first, titleId, "tmdb:c4", "First set");
      await finishJob(stack, first);
      await finishJob(stack, second);
      expect(await nameOf(titleId)).toBe("Second match");
      expect(await linksOf(titleId)).toEqual({
        credited: ["Cast second"],
        collections: [{ sourceKey: "tmdb:c5", name: "Second set", source: "metadata" }],
      });
    });
  });
});
