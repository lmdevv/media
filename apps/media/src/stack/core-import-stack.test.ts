import { join } from "node:path";

import { UserId } from "@media/contracts/ids";
import { failureLine } from "@media/contracts/migration-plan";
import type {
  ImportConnection,
  ImportId,
  ImportReport,
  ImportUserMapping,
  MigrationConnectArgs,
  MigrationCredentials,
} from "@media/contracts/models/migration";
import { serverFunctions } from "@media/contracts/server-functions";
import type { Platform } from "@media/sdk/effect";
import { Brand, Context, Effect, Exit, Layer, Option, Predicate, Redacted, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as CoreSession from "../core/core-session.ts";
import { sealCredentials } from "../migration/credentials.ts";
import { credentialsBinding } from "../migration/migrations.ts";
import type { JellyfinServer } from "../migration/testing/jellyfin-docker.ts";
import {
  jellyfinImageAvailable,
  runOnNode,
  startJellyfin,
} from "../migration/testing/jellyfin-docker.ts";
import { FIXTURE_API_KEY, startJellyfinFixture } from "../migration/testing/jellyfin-fixture.ts";
import { FIXTURE_PLEX_TOKEN, startPlexFixture } from "../migration/testing/plex-fixture.ts";
import type { RecordedServer } from "../migration/testing/recorded-server.ts";
import { linkFolder, makeWorkDir, removeDir } from "../testing/core-host.ts";
import {
  core,
  eventually,
  issueServiceKey,
  personIn,
  startCoreServer,
} from "../testing/core-stack.ts";
import type { CoreServer, Person } from "../testing/core-stack.ts";
import { ffmpegAvailable, generateFixtureLibrary } from "../testing/fixture-library.ts";

const withDocker = process.env["MEDIA_JELLYFIN_DOCKER"] === "1" && (await jellyfinImageAvailable());

const RENAMED = "Big Buck Fixture (Director's Cut)";

const timings: Record<string, number> = {};

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

interface Someone extends Person {
  readonly userId: UserId;
}

const someone = async (
  scope: Scope.Scope,
  role: "admin" | "member",
  name: string,
): Promise<Someone> => {
  const person = await personIn(scope, role, name);
  const current = await run(person.platform.core.auth.sessions.current());

  return { ...person, userId: UserId.make(current.userId) };
};

const token = (value: string): MigrationCredentials => ({
  kind: "token",
  token: Redacted.make(value),
});

const mappingsOf = (
  connection: ImportConnection,
  byName: Readonly<Record<string, Someone | null>>,
): ReadonlyArray<ImportUserMapping> =>
  connection.users.map((user) => ({
    sourceUserId: user.sourceUserId,
    userId: byName[user.name]?.userId ?? null,
  }));

const stateOf = async (who: Someone) => {
  const page = { paginationOpts: { numItems: 100, cursor: null } };

  const [history, resume, myList] = await Promise.all([
    run(who.platform.movies.history.list(page)),
    run(who.platform.movies.history.continueWatching()),
    run(who.platform.movies.myList.list(page)),
  ]);

  return {
    watched: history.page
      .filter((entry) => entry.progress.watched)
      .map((entry) => entry.episode?.name ?? entry.title.name)
      .toSorted(),
    resume: resume
      .filter((row) => row.reason === "resume")
      .map((row) => [row.title.name, row.progress?.positionMs ?? 0] as const),
    myList: myList.page.map((title) => title.name).toSorted(),
  };
};

describe.skipIf(core === undefined || !(await ffmpegAvailable()))(
  "the Jellyfin and Plex importer on the core",
  { timeout: 300_000 },
  () => {
    let scope: Scope.Closeable;
    let workDir = "";
    let workspace = "";
    let server: CoreServer;
    let serviceKey: Redacted.Redacted;
    let admin: Someone;
    let aiko: Someone;
    let jellyfin: RecordedServer;
    let plex: RecordedServer;
    let docker: JellyfinServer | undefined;

    const connect = async (args: MigrationConnectArgs, by: Someone = admin) => {
      const result = await run(server.imports.connect(args, by.userId));

      if (result.status !== "connected") throw new Error(result.message);

      return result;
    };

    const dryRun = async (
      connection: ImportConnection,
      users: ReadonlyArray<ImportUserMapping>,
    ): Promise<ImportReport> => {
      const result = await run(
        server.imports.dryRun({ connectionId: connection.connectionId, users }, admin.userId),
      );

      if (result.status !== "ready") throw new Error(result.message);

      return result;
    };

    const start = async (connection: ImportConnection, users: ReadonlyArray<ImportUserMapping>) => {
      const result = await run(
        server.imports.startImport({ connectionId: connection.connectionId, users }, admin.userId),
      );

      if (result.status !== "queued") throw new Error(result.message);

      return result;
    };

    const finished = (importId: ImportId) =>
      eventually(
        `import ${importId} to finish`,
        async () => {
          const found = await run(
            admin.platform.movies.imports.get({
              importId: Brand.nominal<Platform.Id<"imports">>()(importId),
            }),
          );

          const { status } = found.job;

          return status === "succeeded" || status === "failed" || status === "canceled"
            ? Option.some(found)
            : Option.none();
        },
        180_000,
      );

    beforeAll(async () => {
      scope = await run(Scope.make());
      workDir = await makeWorkDir("media-core-import-");
      workspace = join(workDir, "library");

      if (withDocker) {
        const begin = performance.now();

        docker = await runOnNode(scope, startJellyfin(workspace));
        timings["dockerSetupMs"] = Math.round(performance.now() - begin);
      } else {
        await generateFixtureLibrary(workspace);
      }

      [admin, aiko] = await Promise.all([
        someone(scope, "admin", "importer"),
        someone(scope, "member", "aiko"),
      ]);

      serviceKey = await issueServiceKey();

      server = await startCoreServer(scope, {
        serviceKey,
        libraryRoot: workspace,
        workDir: join(workDir, "server"),
      });

      jellyfin = await startJellyfinFixture();
      plex = await startPlexFixture();
    }, 300_000);

    afterAll(async () => {
      const listed = await run(
        admin.platform.core.libraries.list({ paginationOpts: { numItems: 200, cursor: null } }),
      );

      await Promise.all(
        listed.page.map(async (library) => {
          const detail = await run(
            admin.platform.core.libraries.get({ libraryId: library.libraryId }),
          );

          if (detail.folders?.some((folder) => folder.startsWith(workspace)) === true) {
            await run(
              admin.platform.core.libraries
                .remove({ libraryId: library.libraryId })
                .pipe(Effect.ignore),
            );
          }
        }),
      );

      await jellyfin.close();
      await plex.close();
      await run(Scope.close(scope, Exit.void));
      await removeDir(workDir);
      process.stderr.write(`core import stack timings ${JSON.stringify(timings)}\n`);
    }, 120_000);

    it("plans a library on a mapped link the scanner accepts, and none outside the approved folder", async () => {
      const alias = join(workDir, "alias");
      const outside = await makeWorkDir("media-core-import-outside-");

      await linkFolder(join(workspace, "movies"), alias);

      const connection = await connect({
        source: "jellyfin",
        url: jellyfin.url,
        credentials: token(FIXTURE_API_KEY),
        pathMappings: [
          { from: "/media/movies", to: alias },
          { from: "/media/shows", to: outside },
        ],
      });

      const report = await dryRun(connection, mappingsOf(connection, { admin: null, bob: null }));

      expect(report.libraries.map((library) => [library.name, library.roots])).toEqual(
        expect.arrayContaining([
          [expect.any(String), [alias]],
          [expect.any(String), []],
        ]),
      );
      expect(report.summary.librariesToAdd).toBe(1);
      await removeDir(outside);
    });

    it("imports a Jellyfin server's progress, history, and list onto the mapped core users", async () => {
      const begin = performance.now();

      const [first, second] = await Promise.all([
        someone(scope, "member", "first"),
        someone(scope, "member", "second"),
      ]);

      const connection = await connect({
        source: "jellyfin",
        url: jellyfin.url,
        credentials: token(FIXTURE_API_KEY),
      });

      expect(connection.users.map((user) => user.name).toSorted()).toEqual(["admin", "bob"]);
      expect(connection.pathMappings.toSorted((a, b) => a.from.localeCompare(b.from))).toEqual([
        { from: "/media/movies", to: join(workspace, "movies"), inferred: true },
        { from: "/media/shows", to: join(workspace, "shows"), inferred: true },
      ]);

      const users = mappingsOf(connection, { admin: first, bob: second });

      const early = await run(
        server.imports
          .startImport({ connectionId: connection.connectionId, users }, admin.userId)
          .pipe(Effect.flip),
      );

      expect(Predicate.isTagged(early, "Conflict")).toBe(true);

      const report = await dryRun(connection, users);

      expect(report.summary).toMatchObject({
        usersMapped: 2,
        librariesToAdd: 2,
        librariesExisting: 0,
        itemsUnmatched: 0,
        watched: 2,
        inProgress: 1,
        favorites: 1,
        collections: 1,
        overrides: 1,
        conflicts: 0,
      });
      expect(report.summary.itemsAwaitingScan).toBeGreaterThan(0);

      const [one, two] = await Promise.all([start(connection, users), start(connection, users)]);

      expect([one.created, two.created].filter(Boolean)).toHaveLength(1);
      expect(two.importId).toBe(one.importId);
      expect(two.jobId).toBe(one.jobId);

      const done = await finished(one.importId);

      expect(done.job.status, done.job.error ?? "").toBe("succeeded");
      expect(done).toMatchObject({
        phase: "done",
        users: 2,
        imported: {
          librariesAdded: 2,
          watched: report.summary.watched,
          inProgress: report.summary.inProgress,
          favorites: report.summary.favorites,
          collections: 1,
          overrides: 1,
          keptLocal: 0,
        },
      });

      expect(await stateOf(first)).toEqual({
        watched: [RENAMED],
        resume: [["Remux Fixture", 6000]],
        myList: ["Fixture Show"],
      });
      expect((await stateOf(second)).watched).toHaveLength(1);
      timings["jellyfinImportMs"] = Math.round(performance.now() - begin);
    });

    it("skips a source user mapped to no one", async () => {
      const only = await someone(scope, "member", "only");

      const connection = await connect({
        source: "jellyfin",
        url: jellyfin.url,
        credentials: token(FIXTURE_API_KEY),
      });

      const users = mappingsOf(connection, { admin: null, bob: only });
      const report = await dryRun(connection, users);

      expect(
        report.users
          .map((user) => [user.name, user.action])
          .toSorted(([left = ""], [right = ""]) => left.localeCompare(right)),
      ).toEqual([
        ["admin", "skip"],
        ["bob", "import"],
      ]);

      const started = await start(connection, users);
      const done = await finished(started.importId);

      expect(done).toMatchObject({ users: 1, job: { status: "succeeded" } });

      const state = await stateOf(only);

      expect(state.watched).not.toContain(RENAMED);
      expect(state.myList).toEqual([]);
    });

    it("says why a source could not be used, and fails a run whose key the source refuses", async () => {
      const refused = await run(
        server.imports.connect(
          { source: "jellyfin", url: jellyfin.url, credentials: token("wrong") },
          admin.userId,
        ),
      );

      if (refused.status !== "failed") throw new Error("A wrong key connected");

      expect(failureLine(refused, "jellyfin")).toEqual({
        field: "token",
        message: "Jellyfin didn’t accept this API key.",
      });

      const connection = await connect({
        source: "jellyfin",
        url: jellyfin.url,
        credentials: token(FIXTURE_API_KEY),
      });

      const other = Context.get(
        await run(
          Layer.buildWithScope(
            CoreSession.layer({ convexUrl: core?.url ?? "", apiKey: await issueServiceKey() }),
            scope,
          ),
        ),
        CoreSession.Service,
      );

      const importId = await run(
        Effect.gen(function* () {
          const started = yield* other.call(serverFunctions.importStart, {
            requestedBy: admin.userId,
            source: "jellyfin",
            serverId: `revoked-${connection.connectionId}`,
            serverName: connection.serverName,
            plan: {
              sourceUrl: jellyfin.url,
              credentials: sealCredentials(
                serviceKey,
                token("revoked"),
                credentialsBinding(`revoked-${connection.connectionId}`, jellyfin.url),
              ),
              users: [],
              pathMappings: [],
              libraries: [],
            },
          });

          return started.importId;
        }),
      );

      const done = await finished(importId);

      expect(done.job).toMatchObject({
        status: "failed",
        error: failureLine({ status: "failed", reason: "auth_failed", message: "" }, "jellyfin")
          .message,
      });
    });

    it("refuses a member at every step", async () => {
      const connected = await run(
        server.imports
          .connect(
            { source: "jellyfin", url: jellyfin.url, credentials: token(FIXTURE_API_KEY) },
            aiko.userId,
          )
          .pipe(Effect.flip),
      );

      expect(Predicate.isTagged(connected, "Forbidden")).toBe(true);

      const listed = await run(
        aiko.platform.movies.imports
          .list({ paginationOpts: { numItems: 10, cursor: null } })
          .pipe(Effect.flip),
      );

      expect(Predicate.isTagged(listed, "Forbidden")).toBe(true);
    });

    it("imports a Plex owner's history through a path mapping", async () => {
      const plexUser = await someone(scope, "member", "plex");

      const connection = await connect({
        source: "plex",
        url: plex.url,
        credentials: token(FIXTURE_PLEX_TOKEN),
        pathMappings: [{ from: "/data", to: workspace }],
      });

      const report = await dryRun(connection, mappingsOf(connection, { Admin: plexUser }));

      expect(report.summary.itemsByPath).toBeGreaterThan(0);
      expect(report.unmatchedSamples.map((sample) => sample.reason)).toContain("path_unmapped");

      const started = await start(connection, mappingsOf(connection, { Admin: plexUser }));
      const done = await finished(started.importId);

      expect(done.job.status, done.job.error ?? "").toBe("succeeded");
      expect(done.imported.watched).toBeGreaterThan(0);
      expect((await stateOf(plexUser)).watched.length).toBeGreaterThan(0);
    });

    it("reports files a path mapping puts outside every library and writes nothing for them", async () => {
      const outside = await someone(scope, "member", "outside");

      const connection = await connect({
        source: "jellyfin",
        url: jellyfin.url,
        credentials: token(FIXTURE_API_KEY),
        pathMappings: [{ from: "/media", to: join(workDir, "elsewhere") }],
      });

      const users = mappingsOf(connection, { admin: outside, bob: null });
      const report = await dryRun(connection, users);

      expect(report.summary.itemsByPath).toBe(0);
      expect(report.summary.librariesToAdd).toBe(0);
      expect(report.unmatchedSamples.length).toBeGreaterThan(0);
      expect(report.unmatchedSamples.every((sample) => sample.reason === "not_in_catalog")).toBe(
        true,
      );

      const started = await start(connection, users);
      const done = await finished(started.importId);

      expect(done.job.status, done.job.error ?? "").toBe("succeeded");
      expect(done.imported.unmatched).toBe(report.summary.itemsUnmatched);
      expect(
        report.unmatchedSamples.some((sample) => sample.name.startsWith("Remux Fixture")),
      ).toBe(true);
      expect((await stateOf(outside)).resume).toEqual([]);
    });

    it.skipIf(!withDocker)("imports from a real Jellyfin in Docker", async () => {
      const real = docker;

      if (real === undefined) throw new Error("Jellyfin did not start");

      const begin = performance.now();
      const target = await someone(scope, "member", "docker");

      const connection = await connect({
        source: "jellyfin",
        url: real.url,
        credentials: {
          kind: "password",
          username: "admin",
          password: Redacted.make(real.passwords.admin),
        },
      });

      const users = mappingsOf(connection, { admin: target });
      const report = await dryRun(connection, users);

      expect(report.summary).toMatchObject({ librariesExisting: 2, itemsUnmatched: 0 });

      const started = await start(connection, users);
      const done = await finished(started.importId);

      expect(done.job.status, done.job.error ?? "").toBe("succeeded");
      expect(await stateOf(target)).toMatchObject({
        watched: [RENAMED],
        resume: [["Remux Fixture", 6000]],
        myList: ["Fixture Show"],
      });
      timings["dockerImportMs"] = Math.round(performance.now() - begin);
    });
  },
);
