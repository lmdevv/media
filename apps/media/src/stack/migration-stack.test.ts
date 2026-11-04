import type { JobId, LibraryId, ProfileId } from "@media/contracts/ids";
import type {
  MigrationConnection,
  MigrationCredentials,
  MigrationReport,
  UserMapping,
} from "@media/contracts/models/migration";
import type { ConvexTransport, Movies } from "@media/sdk/effect";
import { Effect, Exit, Option, Predicate, Redacted, Schema, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { JellyfinServer } from "../migration/testing/jellyfin-docker.ts";
import {
  jellyfinImageAvailable,
  runOnNode,
  startJellyfin,
} from "../migration/testing/jellyfin-docker.ts";
import { FIXTURE_API_KEY, startJellyfinFixture } from "../migration/testing/jellyfin-fixture.ts";
import { FIXTURE_PLEX_TOKEN, startPlexFixture } from "../migration/testing/plex-fixture.ts";
import type { RecordedServer } from "../migration/testing/recorded-server.ts";
import { ffmpegAvailable, generateFixtureLibrary } from "../testing/fixture-library.ts";
import {
  client,
  finished,
  openSession,
  OWNER_EMAILS,
  runIn,
  signInOwner,
  STACK_PASSWORD,
  type StackSession,
} from "../testing/stack-owner.ts";
import type { MediaProcess } from "../testing/stack-processes.ts";
import {
  buildServiceAndCli,
  findMediaStack,
  makeTempDir,
  removeDir,
  runMovies,
  startMedia,
  waitForBody,
} from "../testing/stack-processes.ts";

const stack = findMediaStack();

const hasFfmpeg = await ffmpegAvailable();

const withDocker = process.env["MEDIA_JELLYFIN_DOCKER"] === "1" && (await jellyfinImageAvailable());

const id = Math.random().toString(36).slice(2, 8);

const convexUrl = stack?.convexUrl ?? "";

const mediaUrl = stack?.mediaUrl ?? "";

const timings: Record<string, number> = {};

const RENAMED = "Big Buck Fixture (Director's Cut)";

let scope: Scope.Closeable;

let owner: StackSession;

let media: MediaProcess;

let workspace = "";

let jellyfinFixture: RecordedServer;

let plexFixture: RecordedServer;

let docker: JellyfinServer | undefined;

let profiles: Record<"admin" | "bob" | "plex" | "docker", ProfileId>;

const asOwner = <A, E>(
  effect: Effect.Effect<A, E, Movies.Services | ConvexTransport.ConvexTransport>,
): Promise<A> => runIn(owner, effect);

const HealthBackend = Schema.fromJsonString(Schema.Struct({ backend: Schema.String }));

const startService = async (): Promise<void> => {
  media = startMedia({
    ...stack?.mediaEnv,
    LIBRARY_ROOTS: workspace,
    HARDWARE_ACCELERATION: "none",
    LIBRARY_RECONCILE_MINUTES: "600",
  });

  await waitForBody(
    `${mediaUrl}/api/health`,
    (text) =>
      Schema.decodeOption(HealthBackend)(text).pipe(
        Option.filter((health) => health.backend === "connected"),
        Option.getOrUndefined,
      ),
    30_000,
  );
};

const token = (value: string): MigrationCredentials => ({
  kind: "token",
  token: Redacted.make(value),
});

const connect = (source: "jellyfin" | "plex", url: string, credentials: MigrationCredentials) =>
  asOwner(
    Effect.flatMap(client, (movies) =>
      movies.media("migration.connect", { source, url, credentials }),
    ),
  ).then((result): MigrationConnection => {
    expect(result.status, JSON.stringify(result)).toBe("connected");

    if (result.status !== "connected") throw new Error(result.message);

    return result;
  });

const mappingsOf = (
  connection: MigrationConnection,
  byName: Readonly<Record<string, ProfileId>>,
): ReadonlyArray<UserMapping> =>
  connection.users.map((user) => ({
    sourceUserId: user.sourceUserId,
    profileId: byName[user.name] ?? null,
  }));

const dryRun = (connectionId: string, users: ReadonlyArray<UserMapping>) =>
  asOwner(
    Effect.flatMap(client, (movies) => movies.media("migration.dryRun", { connectionId, users })),
  ).then((result): MigrationReport => {
    if (result.status !== "ready") throw new Error(result.message);

    return result;
  });

const importAndWait = async (connectionId: string, users: ReadonlyArray<UserMapping>) => {
  const queued = await asOwner(
    Effect.flatMap(client, (movies) => movies.media("migration.import", { connectionId, users })),
  );

  if (queued.status !== "queued") throw new Error(queued.message);

  return asOwner(finished(queued.jobId, "180 seconds"));
};

const runOf = async (jobId: JobId) => {
  const runs = await asOwner(
    Effect.flatMap(client, (movies) => movies.query("migration.status", {})),
  );

  const run = runs.find((candidate) => candidate.job.id === jobId);

  if (run === undefined) throw new Error(`No migration run for ${jobId}`);

  return run;
};

const stateOf = (profileId: ProfileId) =>
  asOwner(
    Effect.flatMap(client, (movies) =>
      Effect.all({
        history: movies.query("history.list", { profileId, cursor: null, limit: 100 }),
        resume: movies.query("history.continueWatching", { profileId }),
        myList: movies.query("myList.list", { profileId }),
        collections: movies.query("collections.list", { profileId }),
      }),
    ),
  );

const summaryOf = async (profileId: ProfileId) => {
  const state = await stateOf(profileId);

  return {
    watched: state.history.items
      .filter((entry) => entry.progress.watched)
      .map((entry) => entry.episode?.name ?? entry.title.name)
      .toSorted(),
    resume: state.resume
      .filter((row) => row.reason === "resume")
      .map((row) => [row.title.name, row.progress?.positionMs ?? 0] as const),
    myList: state.myList.map((title) => title.name).toSorted(),
    box: state.collections
      .filter((collection) => collection.name === "Fixture Box" && collection.titles.length > 0)
      .map((collection) => collection.titles.map((title) => title.name).toSorted()),
  };
};

const ownLibraries = async (): Promise<ReadonlyArray<LibraryId>> => {
  const all = await asOwner(
    Effect.flatMap(client, (movies) => movies.query("libraries.listDetails", {})),
  );

  return all
    .filter((library) => library.roots.some((root) => root.startsWith(workspace)))
    .map((library) => library.id);
};

describe.skipIf(stack === undefined || !hasFfmpeg)(
  "migration against a real stack",
  { timeout: 240_000 },
  () => {
    beforeAll(async () => {
      buildServiceAndCli();
      workspace = await makeTempDir("movies-migration-stack-");
      scope = Scope.makeUnsafe();

      if (withDocker) {
        const begin = performance.now();

        docker = await runOnNode(scope, startJellyfin(workspace));
        timings["dockerSetupMs"] = Math.round(performance.now() - begin);
      } else {
        await generateFixtureLibrary(workspace);
      }

      owner = await Effect.runPromise(openSession(convexUrl, mediaUrl, scope));
      await asOwner(signInOwner);

      profiles = await asOwner(
        Effect.flatMap(client, (movies) => {
          const create = (name: string) =>
            movies
              .mutate("profiles.create", { name: `${name} ${id}`, avatar: "red", kids: false })
              .pipe(Effect.map((profile) => profile.id));

          return Effect.all({
            admin: create("admin"),
            bob: create("bob"),
            plex: create("plex"),
            docker: create("docker"),
          });
        }),
      );

      jellyfinFixture = await startJellyfinFixture();
      plexFixture = await startPlexFixture();
      await startService();
    }, 300_000);

    afterAll(async () => {
      const libraries = await ownLibraries().catch(() => []);

      await asOwner(
        Effect.flatMap(client, (movies) =>
          Effect.all([
            Effect.forEach(libraries, (libraryId) =>
              movies.mutate("libraries.remove", { libraryId }).pipe(Effect.ignore),
            ),
            Effect.forEach(Object.values(profiles), (profileId) =>
              movies.mutate("profiles.remove", { profileId }).pipe(Effect.ignore),
            ),
          ]),
        ),
      ).catch(() => undefined);

      await media.stop("SIGTERM");
      await jellyfinFixture.close();
      await plexFixture.close();
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await removeDir(workspace);
      process.stderr.write(`migration stack timings ${JSON.stringify(timings)}\n`);
    }, 120_000);

    it("connects to Jellyfin, previews the import, and imports it in place", async () => {
      const begin = performance.now();
      const credentials = token(FIXTURE_API_KEY);
      const connection = await connect("jellyfin", jellyfinFixture.url, credentials);

      expect(connection.users.map((user) => user.name).toSorted()).toEqual(["admin", "bob"]);

      expect(connection.pathMappings.toSorted((a, b) => a.from.localeCompare(b.from))).toEqual([
        { from: "/media/movies", to: `${workspace}/movies`, inferred: true },
        { from: "/media/shows", to: `${workspace}/shows`, inferred: true },
      ]);
      expect(
        connection.libraries
          .filter((library) => library.kind !== "other")
          .flatMap((library) => library.folders)
          .toSorted((a, b) => a.sourcePath.localeCompare(b.sourcePath)),
      ).toEqual([
        { sourcePath: "/media/movies", localPath: `${workspace}/movies` },
        { sourcePath: "/media/shows", localPath: `${workspace}/shows` },
      ]);

      const users = mappingsOf(connection, { admin: profiles.admin, bob: profiles.bob });

      const refused = await asOwner(
        Effect.flatMap(client, (movies) =>
          movies.media("migration.import", { connectionId: connection.connectionId, users }),
        ).pipe(Effect.flip),
      );

      expect(Predicate.isTagged(refused, "Conflict")).toBe(true);

      const report = await dryRun(connection.connectionId, users);

      expect(report.summary).toMatchObject({
        usersMapped: 2,
        librariesToAdd: 2,
        librariesExisting: 0,
        watched: 2,
        inProgress: 1,
        favorites: 1,
        collections: 1,
        overrides: 1,
        conflicts: 0,
      });
      expect(report.summary.itemsAwaitingScan).toBeGreaterThan(0);
      expect(report.libraries.flatMap((library) => library.roots).toSorted()).toEqual([
        `${workspace}/movies`,
        `${workspace}/shows`,
      ]);

      const job = await importAndWait(connection.connectionId, users);

      expect(job.status, job.error ?? "").toBe("succeeded");

      const run = await runOf(job.id);

      expect(run.phase).toBe("done");
      expect(run.imported).toMatchObject({
        librariesAdded: 2,
        watched: report.summary.watched,
        inProgress: report.summary.inProgress,
        playCounts: report.summary.playCounts,
        favorites: report.summary.favorites,
        collections: 1,
        overrides: 1,
        keptLocal: 0,
      });
      expect(await ownLibraries()).toHaveLength(2);

      expect(await summaryOf(profiles.admin)).toEqual({
        watched: [RENAMED],
        resume: [["Remux Fixture", 6000]],
        myList: ["Fixture Show"],
        box: [[RENAMED, "Remux Fixture"]],
      });
      expect((await summaryOf(profiles.bob)).watched).toEqual(["Pilot (Local)"]);
      timings["jellyfinImportMs"] = Math.round(performance.now() - begin);
    });

    it("says why a source could not be used", async () => {
      const refusedToken = await asOwner(
        Effect.flatMap(client, (movies) =>
          movies.media("migration.connect", {
            source: "jellyfin",
            url: jellyfinFixture.url,
            credentials: token("wrong"),
          }),
        ),
      );

      expect(refusedToken).toMatchObject({ status: "failed", reason: "auth_failed" });

      const unreachable = await asOwner(
        Effect.flatMap(client, (movies) =>
          movies.media("migration.connect", {
            source: "plex",
            url: "http://127.0.0.1:1",
            credentials: token(FIXTURE_PLEX_TOKEN),
          }),
        ),
      );

      expect(unreachable).toMatchObject({ status: "failed", reason: "unreachable" });
    });

    it("imports the same server again through the media CLI without duplicates", async () => {
      const before = await summaryOf(profiles.admin);
      const home = await makeTempDir("movies-migration-cli-");
      const env = { XDG_CONFIG_HOME: home, HOME: home, MEDIA_IMPORT_TOKEN: FIXTURE_API_KEY };

      try {
        const login = async (email: string) =>
          (
            await runMovies(
              [
                "login",
                "--server",
                convexUrl,
                "--media-url",
                mediaUrl,
                "--email",
                email,
                "--password",
              ],
              env,
              STACK_PASSWORD,
            )
          ).code === 0;

        expect((await login(OWNER_EMAILS[0])) || (await login(OWNER_EMAILS[1]))).toBe(true);

        const connection = await connect("jellyfin", jellyfinFixture.url, token(FIXTURE_API_KEY));
        const byName = new Map(connection.users.map((user) => [user.name, user.sourceUserId]));

        const maps = [
          "--map",
          `${byName.get("admin") ?? ""}=${profiles.admin},${byName.get("bob") ?? ""}=${profiles.bob}`,
        ];

        const preview = await runMovies(
          ["import", "jellyfin", "--url", jellyfinFixture.url, ...maps, "--dry-run"],
          env,
        );

        expect(preview.code, preview.stderr).toBe(0);

        const previewed = Schema.decodeSync(
          Schema.fromJsonString(
            Schema.Struct({
              summary: Schema.Struct({ librariesExisting: Schema.Int, itemsByPath: Schema.Int }),
            }),
          ),
        )(preview.stdout);

        expect(previewed.summary.librariesExisting).toBe(2);
        expect(previewed.summary.itemsByPath).toBeGreaterThan(0);

        const imported = await runMovies(
          ["import", "jellyfin", "--url", jellyfinFixture.url, ...maps, "--wait"],
          env,
        );

        expect(imported.code, imported.stderr).toBe(0);
        expect(imported.stdout).toContain("succeeded");
        expect(await summaryOf(profiles.admin)).toEqual(before);
        expect(await ownLibraries()).toHaveLength(2);

        const refused = await runMovies(
          ["import", "jellyfin", "--url", jellyfinFixture.url, "--dry-run"],
          { ...env, MEDIA_IMPORT_TOKEN: "wrong" },
        );

        expect(refused.code).toBe(11);
        expect(refused.stderr).toContain("source_auth_failed");
      } finally {
        await removeDir(home);
      }
    });

    it("imports a Plex owner's history through a path mapping", async () => {
      const connection = await asOwner(
        Effect.flatMap(client, (movies) =>
          movies.media("migration.connect", {
            source: "plex",
            url: plexFixture.url,
            credentials: token(FIXTURE_PLEX_TOKEN),
            pathMappings: [{ from: "/data", to: workspace }],
          }),
        ),
      );

      if (connection.status !== "connected") throw new Error(connection.message);

      const users = mappingsOf(connection, { Admin: profiles.plex });
      const report = await dryRun(connection.connectionId, users);

      expect(report.summary.librariesExisting).toBe(2);
      expect(report.summary.itemsByPath).toBeGreaterThan(0);
      expect(report.unmatchedSamples.map((sample) => sample.reason)).toContain("path_unmapped");

      const job = await importAndWait(connection.connectionId, users);

      expect(job.status, job.error ?? "").toBe("succeeded");

      const run = await runOf(job.id);

      expect(run.imported.watched).toBeGreaterThan(0);
      expect((await summaryOf(profiles.plex)).watched.length).toBeGreaterThan(0);
    });

    it.skipIf(!withDocker)("imports from a real Jellyfin in Docker", async () => {
      const server = docker;

      if (server === undefined) throw new Error("Jellyfin did not start");

      const begin = performance.now();

      const connection = await connect("jellyfin", server.url, {
        kind: "password",
        username: "admin",
        password: Redacted.make(server.passwords.admin),
      });

      const users = mappingsOf(connection, { admin: profiles.docker });
      const report = await dryRun(connection.connectionId, users);

      expect(report.summary.librariesExisting).toBe(2);
      expect(report.summary.itemsUnmatched).toBe(0);

      const job = await importAndWait(connection.connectionId, users);

      expect(job.status, job.error ?? "").toBe("succeeded");

      const imported = await summaryOf(profiles.docker);

      expect(imported).toMatchObject({
        watched: [RENAMED],
        resume: [["Remux Fixture", 6000]],
        myList: ["Fixture Show"],
      });
      expect(imported.box).toContainEqual([RENAMED, "Remux Fixture"]);
      timings["dockerImportMs"] = Math.round(performance.now() - begin);
    });
  },
);
