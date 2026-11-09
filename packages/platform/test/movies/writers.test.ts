import { join } from "node:path";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { runFunction } from "../admin";
import { member } from "../devices";
import { runServer, runServerAs } from "../service";
import { refusal } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";
import type { CoreStack } from "../stack-env";
import { JobId, PersonId, answer, claimJob, finishJob, moviesLibrary, upsert } from "./catalog";
import { movieFile, scannedTitle } from "./scanned";

const stack = coreStackFromEnvFile();

const Done = answer(Schema.Null);

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
      }
    | { kind: "movies.person"; personId: Id<"people"> },
) => payload;

const credit = (name: string, tmdb: string, order: number) => ({
  person: { name, externalIds: { tmdb, imdb: null, tvdb: null }, profile: null },
  kind: "actor" as const,
  role: null,
  order,
});

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
      enqueueArgs({ kind: "movies.metadata", titleId, match: null }),
    );

    const lease = await claimJob(stack, "movies.metadata", jobId);

    expect(
      await refusal(
        runServerAs(stack, admin.signedIn, api.movies.metadata.metadataTarget, { titleId }, Target),
      ),
    ).toBe("forbidden");
    expect(await runServer(stack, api.movies.metadata.metadataTarget, { titleId }, Target)).toEqual(
      { name: "Sintel", year: null },
    );
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
        Done,
      ),
    ).toEqual({ outcome: "held", value: null });
    expect(await runServer(stack, api.movies.metadata.metadataTarget, { titleId }, Target)).toEqual(
      { name: "Sintel", year: 2010 },
    );

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

    const personJob = await enqueue(stack, enqueueArgs({ kind: "movies.person", personId }));
    const personLease = await claimJob(stack, "movies.person", personJob);

    expect(
      await runServer(stack, api.movies.people.personTarget, { personId }, PersonTarget),
    ).toEqual({ name: "Halina Reijn" });
    await expect(
      runServer(
        stack,
        api.movies.metadata.applyMetadata,
        { lease: personLease, titleId, title: scannedTitle("movie", "x", "x"), episodes: [] },
        Done,
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
});
