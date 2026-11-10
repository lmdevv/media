import type { UserId } from "@media/contracts/ids";
import { Conflict, Forbidden, InvalidArgs, NotFound } from "@media/contracts/errors";
import type { MigrationSource } from "@media/contracts/models/jobs";
import type {
  ImportConnection,
  ImportPlanArgs,
  ImportReport,
  ImportSourceUser,
  ImportUserMapping,
  MigrationConnectArgs,
  MigrationCredentials,
  MigrationSourceFailure,
  PathMapping,
} from "@media/contracts/models/migration";
import type { CatalogFile, LocalProgress } from "@media/contracts/models/migration-service";
import { IMPORT_PLAN_MAX, serverFunctions } from "@media/contracts/server-functions";
import type { ImportId } from "@media/contracts/models/migration";
import type { JobId } from "@media/contracts/ids";
import type { CallError } from "@media/sdk/effect";
import { EpochMillis } from "@media/contracts/units";
import {
  Clock,
  Context,
  Crypto,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  type Redacted,
  Ref,
} from "effect";
import type { HttpClient } from "effect/http";

import * as CoreSession from "../core/core-session.ts";
import * as LibraryScanner from "../library/library-scanner.ts";
import * as MediaConfig from "../media-config.ts";
import { sealCredentials } from "./credentials.ts";
import {
  computePlan,
  credentialsBinding,
  inferMappings,
  isSourceFailure,
  sourceFailure,
} from "./migrations.ts";
import type { PlanReads } from "./migrations.ts";
import { normalizePath, toLocalPath } from "./paths.ts";
import { reportBody } from "./planner.ts";
import type { ExistingLibrary, MigrationPlan, ResolvedUser } from "./planner.ts";
import { openSource, SOURCE_ERROR_TAGS } from "./sources.ts";
import type { SourceSession } from "./source-plugin.ts";

const CONNECTION_TTL = Duration.hours(1);

/** A run the core started, or the one of the same server already queued or running. */
interface ImportStarted {
  readonly status: "queued";
  readonly importId: ImportId;
  readonly jobId: JobId;
  readonly created: boolean;
}

interface DryRun {
  readonly usersKey: string;
  readonly users: ReadonlyArray<ResolvedUser<UserId>>;
  readonly libraries: MigrationPlan<UserId>["libraries"];
}

interface Connection {
  readonly connectionId: string;
  readonly requester: UserId;
  readonly source: MigrationSource;
  readonly url: string;
  readonly credentials: MigrationCredentials;
  readonly session: SourceSession;
  readonly mappings: ReadonlyArray<PathMapping>;
  readonly view: ImportConnection;
  readonly expiresAt: number;
  readonly dryRun: Option.Option<DryRun>;
}

/**
 * The importer's flow on the core: connect to a source, preview the import, and start it. Each
 * takes the core user asking, whom the core checks may import. Source failures are values, for the
 * "Couldn't connect" screen.
 */
export interface Interface {
  readonly connect: (
    args: MigrationConnectArgs,
    requester: UserId,
  ) => Effect.Effect<ImportConnection | MigrationSourceFailure, CallError>;
  readonly dryRun: (
    args: ImportPlanArgs,
    requester: UserId,
  ) => Effect.Effect<ImportReport | MigrationSourceFailure, CallError>;
  readonly startImport: (
    args: ImportPlanArgs,
    requester: UserId,
  ) => Effect.Effect<ImportStarted | MigrationSourceFailure, CallError>;
}

/** The importer's flow on the core. */
export class Service extends Context.Service<Service, Interface>()("@media/server/CoreImports") {}

const sameName = (left: string, right: string): boolean =>
  left.trim().toLowerCase() === right.trim().toLowerCase();

/** The core user a source user's history goes to by default: the one with the same name. */
export const suggestUser = (
  user: { readonly name: string },
  targets: ReadonlyArray<{ readonly userId: UserId; readonly username: string }>,
): ImportSourceUser["suggestion"] => {
  const found = targets.find((target) => sameName(target.username, user.name));

  return found === undefined
    ? { kind: "invite" }
    : { kind: "user", userId: found.userId, matchedBy: "name" };
};

/** Each source user's core user: the admin's choice when given, otherwise the suggestion. */
export const resolveImportUsers = (
  users: ReadonlyArray<ImportSourceUser>,
  overrides: ReadonlyArray<ImportUserMapping>,
): ReadonlyArray<ResolvedUser<UserId>> =>
  users.map((user): ResolvedUser<UserId> => {
    const chosen = overrides.find((mapping) => mapping.sourceUserId === user.sourceUserId);
    const base = { sourceUserId: user.sourceUserId, name: user.name, history: user.history };

    if (chosen !== undefined) {
      return chosen.userId === null
        ? { ...base, person: null, action: "skip" }
        : { ...base, person: chosen.userId, action: "import" };
    }

    return user.suggestion.kind === "user"
      ? { ...base, person: user.suggestion.userId, action: "import" }
      : { ...base, person: null, action: "invite" };
  });

/** The report of `plan` as the core shows it, each source user with their core user. */
export const coreReportOf = (
  plan: MigrationPlan<UserId>,
  context: Parameters<typeof reportBody<UserId>>[1],
): ImportReport => ({
  ...reportBody(plan, context),
  users: context.users.map((user) => ({
    sourceUserId: user.sourceUserId,
    name: user.name,
    userId: user.person,
    action: user.action,
  })),
});

interface Paged {
  readonly continueCursor: string;
  readonly isDone: boolean;
}

/** Every item of a paged core read, page by page, `items` taking each page's. */
const allPages = <Page extends Paged, Item>(
  read: (cursor: string | null) => Effect.Effect<Page, CallError>,
  items: (page: Page) => ReadonlyArray<Item>,
): Effect.Effect<ReadonlyArray<Item>, CallError> =>
  Effect.gen(function* () {
    const found: Array<Item> = [];
    let cursor: string | null = null;

    for (;;) {
      const page: Page = yield* read(cursor);

      found.push(...items(page));

      if (page.isDone) return found;

      cursor = page.continueCursor;
    }
  });

/** The core's catalog as a plan reads it. */
export const coreReads = (session: CoreSession.Interface): PlanReads<UserId> => ({
  libraries: allPages(
    (cursor) => session.call(serverFunctions.importLibraries, { cursor }),
    (page) =>
      page.libraries.map((library): ExistingLibrary => ({
        id: library.libraryId,
        roots: library.folders,
      })),
  ),
  catalog: allPages(
    (cursor) => session.call(serverFunctions.importCatalog, { cursor }),
    (page): ReadonlyArray<CatalogFile> => page.files,
  ),
  localProgress: (userId) =>
    allPages(
      (cursor) => session.call(serverFunctions.importProgress, { userId, cursor }),
      (page): ReadonlyArray<LocalProgress> => page.rows,
    ),
});

/**
 * Who sees a library the import adds, as indexes into the plan's mapped users: everyone, or the
 * mapped users the source let see it (none when it did not say, so owners and admins alone).
 */
const accessOf = (
  library: MigrationPlan<UserId>["libraries"][number],
  mapped: ReadonlyArray<{ readonly sourceUserId: string }>,
) =>
  library.access.kind === "everyone"
    ? { kind: "everyone" as const }
    : {
        kind: "users" as const,
        users: library.access.sourceUserIds.flatMap((sourceUserId) => {
          const index = mapped.findIndex((user) => user.sourceUserId === sourceUserId);

          return index === -1 ? [] : [index];
        }),
      };

/**
 * Refuses, before anything is written, a plan the core would refuse to start: more users, path
 * mappings, libraries, or library folders than one import holds (ADR 0012).
 */
const withinBounds = (
  users: ReadonlyArray<ResolvedUser<UserId>>,
  mappings: ReadonlyArray<PathMapping>,
  libraries: MigrationPlan<UserId>["libraries"],
): Effect.Effect<void, InvalidArgs> => {
  const counts = [
    [
      users.filter((user) => user.action === "import").length,
      IMPORT_PLAN_MAX.users,
      "mapped users",
    ],
    [mappings.length, IMPORT_PLAN_MAX.pathMappings, "path mappings"],
    [
      libraries.filter((library) => library.roots.length > 0).length,
      IMPORT_PLAN_MAX.libraries,
      "libraries",
    ],
    [
      libraries.flatMap((library) => library.roots).length,
      IMPORT_PLAN_MAX.libraryRoots,
      "library folders",
    ],
  ] as const;

  const over = counts.find(([count, max]) => count > max);

  return over === undefined
    ? Effect.void
    : Effect.fail(
        new InvalidArgs({
          message: `One import holds at most ${String(over[1])} ${over[2]}; this one has ${String(over[0])}`,
        }),
      );
};

/**
 * The local folders of `session`'s libraries an import may add a library on: the ones the scanner
 * itself accepts (`LibraryScanner.openRoot`), which resolves each folder and every approved root
 * to its real path, so a mapped link that leads inside an approved root counts and a folder outside
 * every one does not.
 */
export const scannableFolders = Effect.fnUntraced(function* (
  session: SourceSession,
  mappings: ReadonlyArray<PathMapping>,
  roots: ReadonlyArray<string>,
) {
  const scanner = yield* LibraryScanner.Service;

  const folders = [
    ...new Set(
      session.libraries
        .filter((library) => library.kind !== "other")
        .flatMap((library) => library.paths)
        .flatMap((path) => {
          const local = toLocalPath(path, mappings, roots);

          return local === null ? [] : [local];
        }),
    ),
  ];

  const accepted = yield* Effect.forEach(folders, (folder) =>
    scanner.openRoot(folder).pipe(
      Effect.as([folder]),
      Effect.orElseSucceed(() => []),
    ),
  );

  return new Set(accepted.flat());
});

const usersKeyOf = (users: ReadonlyArray<ResolvedUser<UserId>>): string =>
  JSON.stringify(users.map((user) => [user.sourceUserId, user.person]));

const make = (sealKey: Redacted.Redacted) =>
  Effect.gen(function* () {
    const config = yield* MediaConfig.Service;
    const core = yield* CoreSession.Service;
    const scanner = yield* LibraryScanner.Service;
    const fs = yield* FileSystem.FileSystem;
    const crypto = yield* Crypto.Crypto;
    const context = yield* Effect.context<HttpClient.HttpClient>();
    const connections = yield* Ref.make<ReadonlyMap<string, Connection>>(new Map());
    const reads = coreReads(core);

    const newConnectionId = crypto.randomBytes(18).pipe(
      Effect.map((bytes) => Buffer.from(bytes).toString("base64url")),
      Effect.orDie,
    );

    const requireImporter = (requester: UserId) =>
      core.call(serverFunctions.importAllowed, { userId: requester }).pipe(
        Effect.filterOrFail(
          (allowed) => allowed,
          () =>
            new Forbidden({
              message: "Only an owner or an admin can import from Jellyfin or Plex",
            }),
        ),
        Effect.asVoid,
      );

    const connectionOf = Effect.fnUntraced(function* (connectionId: string, requester: UserId) {
      const now = yield* Clock.currentTimeMillis;

      const live = yield* Ref.updateAndGet(
        connections,
        (all) => new Map([...all].filter(([, entry]) => entry.expiresAt > now)),
      );

      const found = live.get(connectionId);

      if (found === undefined || found.requester !== requester || found.expiresAt <= now) {
        return yield* new NotFound({
          message: "Import connection expired or unknown; connect to the server again",
        });
      }

      return found;
    });

    const connect = Effect.fn("CoreImports.connect")(function* (
      args: MigrationConnectArgs,
      requester: UserId,
    ) {
      yield* requireImporter(requester);

      const url = args.url.replace(/\/+$/u, "");

      const opened = yield* openSource(args.source, { url, credentials: args.credentials }).pipe(
        Effect.provide(context),
        Effect.map((session) => ({ session })),
        Effect.catchTag(SOURCE_ERROR_TAGS, (error) => Effect.succeed(sourceFailure(error))),
      );

      if (isSourceFailure(opened)) return opened;

      const { session } = opened;

      const given = (args.pathMappings ?? []).map((mapping) => ({
        from: normalizePath(mapping.from),
        to: normalizePath(mapping.to),
      }));

      const folders = session.libraries
        .filter((library) => library.kind !== "other")
        .flatMap((library) => library.paths);

      const inferred = yield* inferMappings(folders, given, config.libraryRoots).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      );

      const mappings = [...given, ...inferred];

      const targets = yield* allPages(
        (cursor) => core.call(serverFunctions.importTargets, { cursor }),
        (page) => page.users,
      );

      const now = yield* Clock.currentTimeMillis;
      const expiresAt = now + Duration.toMillis(CONNECTION_TTL);
      const connectionId = yield* newConnectionId;

      const view: ImportConnection = {
        status: "connected",
        connectionId,
        source: args.source,
        serverName: session.server.name,
        version: session.server.version,
        users: session.users.map((user) => ({
          sourceUserId: user.userId,
          name: user.name,
          email: user.email,
          isAdmin: user.isAdmin,
          suggestion: suggestUser(user, targets),
          history: user.history,
        })),
        libraries: session.libraries.map((library) => ({
          sourceLibraryId: library.libraryId,
          name: library.name,
          kind: library.kind,
          folders: library.paths.map((sourcePath) => ({
            sourcePath,
            localPath: toLocalPath(sourcePath, mappings, config.libraryRoots),
          })),
        })),
        pathMappings: [
          ...given.map((mapping) => ({ from: mapping.from, to: mapping.to, inferred: false })),
          ...inferred.map((mapping) => ({ from: mapping.from, to: mapping.to, inferred: true })),
        ],
        expiresAt: EpochMillis.make(expiresAt),
      };

      yield* Ref.update(connections, (all) => {
        const live = new Map([...all].filter(([, entry]) => entry.expiresAt > now));

        live.set(connectionId, {
          connectionId,
          requester,
          source: args.source,
          url,
          credentials: args.credentials,
          session,
          mappings,
          view,
          expiresAt,
          dryRun: Option.none(),
        });

        return live;
      });

      yield* Effect.logInfo("CoreImports.connected").pipe(
        Effect.annotateLogs({
          source: args.source,
          users: view.users.length,
          libraries: view.libraries.length,
          inferredMappings: inferred.length,
        }),
      );

      return view;
    });

    const dryRun = Effect.fn("CoreImports.dryRun")(function* (
      args: ImportPlanArgs,
      requester: UserId,
    ) {
      yield* requireImporter(requester);

      const connection = yield* connectionOf(args.connectionId, requester);
      const users = resolveImportUsers(connection.view.users, args.users ?? []);

      const scannable = yield* scannableFolders(
        connection.session,
        connection.mappings,
        config.libraryRoots,
      ).pipe(Effect.provideService(LibraryScanner.Service, scanner));

      const computed = yield* computePlan(connection.session, reads, {
        source: connection.source,
        users,
        mappings: connection.mappings,
        roots: config.libraryRoots,
        withLocalProgress: true,
        addable: (folder) => scannable.has(folder),
      }).pipe(
        Effect.map((plan) => ({ plan })),
        Effect.catchTag(SOURCE_ERROR_TAGS, (error) => Effect.succeed(sourceFailure(error))),
      );

      if (isSourceFailure(computed)) return computed;

      yield* withinBounds(users, connection.mappings, computed.plan.libraries);

      const now = yield* Clock.currentTimeMillis;

      // A connection that expired or was dropped while the plan was computed stays gone.
      yield* Ref.update(connections, (all) =>
        all.has(connection.connectionId)
          ? new Map(all).set(connection.connectionId, {
              ...connection,
              dryRun: Option.some({
                usersKey: usersKeyOf(users),
                users,
                libraries: computed.plan.libraries,
              }),
            })
          : all,
      );

      return coreReportOf(computed.plan, {
        connectionId: connection.connectionId,
        source: connection.source,
        serverName: connection.view.serverName,
        createdAt: now,
        users,
      });
    });

    const startImport = Effect.fn("CoreImports.startImport")(function* (
      args: ImportPlanArgs,
      requester: UserId,
    ) {
      yield* requireImporter(requester);

      const connection = yield* connectionOf(args.connectionId, requester);
      const users = resolveImportUsers(connection.view.users, args.users ?? []);
      const usersKey = usersKeyOf(users);

      const ready = Option.filter(connection.dryRun, (run) => run.usersKey === usersKey);

      if (Option.isNone(ready)) {
        return yield* new Conflict({
          message: "Run a dry run of this connection with the same user mappings before importing",
        });
      }

      const serverId = connection.session.server.serverId;

      const mapped = ready.value.users.flatMap((user) =>
        user.action === "import" && user.person !== null
          ? [{ sourceUserId: user.sourceUserId, userId: user.person, history: user.history }]
          : [],
      );

      yield* withinBounds(ready.value.users, connection.mappings, ready.value.libraries);

      const started = yield* core.call(serverFunctions.importStart, {
        requestedBy: requester,
        source: connection.source,
        serverId,
        serverName: connection.view.serverName,
        plan: {
          sourceUrl: connection.url,
          credentials: sealCredentials(
            sealKey,
            connection.credentials,
            credentialsBinding(serverId, connection.url),
          ),
          users: mapped,
          pathMappings: connection.mappings,
          libraries: ready.value.libraries.flatMap((library) =>
            library.roots.length === 0
              ? []
              : [{ name: library.name, roots: library.roots, access: accessOf(library, mapped) }],
          ),
        },
      });

      return { status: "queued" as const, ...started };
    });

    return Service.of({ connect, dryRun, startImport });
  });

/**
 * The importer's flow on the core, sealing source credentials under `sealKey`, the server's own
 * key, so neither the core nor a backup can open them.
 */
export const layer = (
  sealKey: Redacted.Redacted,
): Layer.Layer<
  Service,
  never,
  | MediaConfig.Service
  | CoreSession.Service
  | LibraryScanner.Service
  | FileSystem.FileSystem
  | Crypto.Crypto
  | HttpClient.HttpClient
> => Layer.effect(Service, make(sealKey));
