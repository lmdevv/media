import { join } from "node:path";

import type { Platform } from "@media/sdk/effect";
import { Effect, Exit, Option, Schema, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeWorkDir, removeDir, touchFile } from "../testing/core-host.ts";
import {
  core,
  eventually,
  issueServiceKey,
  personIn,
  runHost,
  startCoreServer,
} from "../testing/core-stack.ts";
import type { Person } from "../testing/core-stack.ts";
import { ffmpegAvailable, generateFixtureLibrary } from "../testing/fixture-library.ts";
import type { FixtureLibrary } from "../testing/fixture-library.ts";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

const ScanEnd = Schema.Struct({ status: Schema.String, message: Schema.NullOr(Schema.String) });

const Files = Schema.Array(Schema.Struct({ fileId: Schema.String, path: Schema.String }));

let scope: Scope.Closeable;

let workDir = "";

let admin: Person;

let fixtures: FixtureLibrary;

let libraryId: Option.Option<Platform.Id<"libraries">> = Option.none();

const library = (): Platform.Id<"libraries"> =>
  Option.getOrThrowWith(libraryId, () => new Error("The fixture library was not created"));

/** Asks for an incremental scan as the library's admin and waits until a scan it asked for ends. */
const scanNow = async (): Promise<typeof ScanEnd.Type> => {
  const queued = await run(
    admin.platform.core.libraries.scan({ libraryId: library(), mode: "incremental" }),
  );

  const job = await eventually(
    "the scan to end",
    async () => {
      const found = await runHost("core/jobs/admin:get", { jobId: queued.jobId }, ScanEnd);

      return found.status === "succeeded" || found.status === "failed"
        ? Option.some(found)
        : Option.none();
    },
    120_000,
  );

  return queued.created ? job : scanNow();
};

/** Every title of the library with its files, as its admin reads them. */
const titles = async () => {
  const page = await run(
    admin.platform.movies.titles.list({
      paginationOpts: { numItems: 50, cursor: null },
      libraryId: library(),
    }),
  );

  return Promise.all(
    page.page.map((title) => run(admin.platform.movies.titles.get({ titleId: title.id }))),
  );
};

/** The title that holds file `fileId` now. */
const titleHolding = async (fileId: string) => {
  const found = (await titles()).find((title) => title.files.some((file) => file.id === fileId));

  if (found === undefined) throw new Error(`No title holds ${fileId}`);

  return found;
};

/** The file at `relativePath` in the fixture library's movies folder. */
const fileAt = async (relativePath: string): Promise<string> => {
  const files = await runHost("movies/probe:files", { libraryId: library() }, Files);
  const found = files.find((file) => file.path === join(fixtures.moviesRoot, relativePath));

  if (found === undefined) throw new Error(`${relativePath} is not in the catalog`);

  return found.fileId;
};

describe.skipIf(core === undefined || !(await ffmpegAvailable()))(
  "a scan of files an older server probed",
  () => {
    beforeAll(async () => {
      scope = await run(Scope.make());
      workDir = await makeWorkDir("media-core-reprobe-");
      fixtures = await generateFixtureLibrary(join(workDir, "library"));
      admin = await personIn(scope, "admin", "reprobe");

      await startCoreServer(scope, {
        serviceKey: await issueServiceKey(),
        libraryRoot: join(workDir, "library"),
        workDir: join(workDir, "server"),
      });

      const created = await run(
        admin.platform.core.libraries.create({
          name: "Older probes",
          kind: "movies",
          folders: [fixtures.moviesRoot],
        }),
      );

      libraryId = Option.some(created.libraryId);
      await eventually(
        "the first scan writes the fixture titles",
        async () => ((await titles()).length >= 3 ? Option.some(true) : Option.none()),
        150_000,
      );
    }, 240_000);

    afterAll(async () => {
      if (Option.isSome(libraryId)) {
        await run(
          admin.platform.core.libraries.remove({ libraryId: libraryId.value }).pipe(Effect.ignore),
        );
      }

      await run(Scope.close(scope, Exit.void));
      await removeDir(workDir);
    }, 60_000);

    it("probes unchanged files again without matching them, and matches a changed one again", async () => {
      // Matching runs with no metadata provider here, so it can only key a title by name and
      // year: the keys below are what a match through TMDB gave these files on an older server.
      const legacy = await fileAt(fixtures.directMovie);
      const older = await fileAt(fixtures.hdrMovie);
      const changed = await fileAt(fixtures.messyMovie);
      const legacyTitle = await titleHolding(legacy);
      const started = await run(admin.platform.movies.play.start({ titleId: legacyTitle.id }));

      await run(
        admin.platform.movies.play.report({
          fileId: started.file.id,
          positionMs: 60_000,
          event: "tick",
          playbackId: started.playbackId,
          startedAt: started.startedAt,
        }),
      );

      const aging = [
        { fileId: legacy, matchKey: "movie:tmdb:4242", name: "Matched Elsewhere" },
        { fileId: older, matchKey: "movie:tmdb:4243", name: "Matched Older", probeRevision: 1 },
        { fileId: changed, matchKey: "movie:tmdb:4244", name: "Matched Then Edited" },
      ];

      await Promise.all(aging.map((aged) => runHost("movies/probe:ageFile", aged, Schema.Null)));

      const before = await Promise.all([legacy, older, changed].map(titleHolding));

      expect(before.map((title) => title.files[0]?.probe.video[0]?.fieldOrder)).toEqual([
        undefined,
        undefined,
        undefined,
      ]);

      // The edited file's bytes change: it is a new file to the scan, matched again.
      await touchFile(join(fixtures.moviesRoot, fixtures.messyMovie), new Date(2001, 1, 1));

      expect(await scanNow()).toMatchObject({ status: "succeeded" });

      const after = await Promise.all([legacy, older, changed].map(titleHolding));

      for (const [index, kept] of after.slice(0, 2).entries()) {
        const was = before[index];

        expect(kept.id).toBe(was?.id);
        expect(kept.name).toBe(was?.name);
        expect(kept.addedAt).toBe(was?.addedAt);
        expect(kept.files.map((file) => file.id)).toEqual(was?.files.map((file) => file.id));
        expect(kept.files[0]?.probe.video[0]?.fieldOrder).toBe("progressive");
      }

      expect(after[0]?.progress?.positionMs).toBe(60_000);
      expect(after[2]?.id).not.toBe(before[2]?.id);
      expect(after[2]?.name).not.toBe("Matched Then Edited");
      expect(after[2]?.files[0]?.probe.video[0]?.fieldOrder).toBe("progressive");
    }, 240_000);
  },
);
