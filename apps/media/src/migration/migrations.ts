import type { JobId, ProfileId, UserId } from "@media/contracts/ids";
import type { Viewer } from "@media/contracts/models/account";
import type {
  MigrationConnectArgs,
  MigrationConnection,
  MigrationCredentials,
  MigrationPlanArgs,
  MigrationReport,
  PathMapping,
  SourceUser as ContractSourceUser,
  UserMapping,
} from "@media/contracts/models/migration";
import type { MigrationSource } from "@media/contracts/models/jobs";
import { MigrationSourceFailure } from "@media/contracts/models/migration";
import type {
  CatalogFile,
  LocalProgress,
  MigrationTarget,
} from "@media/contracts/models/migration-service";
import { Conflict, Internal, NotFound } from "@media/contracts/errors";
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
  Ref,
  Schema,
} from "effect";
import type { HttpClient } from "effect/http";

import * as MediaConfig from "../media-config.ts";
import { sealCredentials } from "./credentials.ts";
import * as MigrationBackend from "./migration-backend.ts";
import { mappingCandidates, normalizePath, toLocalPath } from "./paths.ts";
import {
  type ExistingLibrary,
  type MigrationPlan,
  planMigration,
  reportOf,
  type ResolvedUser,
} from "./planner.ts";
import { openSource, SOURCE_ERROR_TAGS } from "./sources.ts";
import type { SourceError, SourceSession } from "./source-plugin.ts";
import { failureReasonOf } from "./source-plugin.ts";

const CONNECTION_TTL = Duration.hours(1);

interface DryRun {
  readonly usersKey: string;
  readonly users: ReadonlyArray<ResolvedUser<ProfileId>>;
  readonly plan: MigrationPlan<ProfileId>;
  readonly report: MigrationReport;
}

interface Connection {
  readonly connectionId: string;
  readonly owner: UserId;
  readonly source: MigrationSource;
  readonly url: string;
  readonly credentials: MigrationCredentials;
  readonly session: SourceSession;
  readonly mappings: ReadonlyArray<PathMapping>;
  readonly view: MigrationConnection;
  readonly expiresAt: number;
  readonly dryRun: Option.Option<DryRun>;
}

/** The flow's operations. Source failures are values, for the "Couldn't connect" screen. */
export interface Interface {
  readonly connect: (
    args: MigrationConnectArgs,
    viewer: Viewer,
  ) => Effect.Effect<MigrationConnection | MigrationSourceFailure, CallError>;
  readonly dryRun: (
    args: MigrationPlanArgs,
    viewer: Viewer,
  ) => Effect.Effect<MigrationReport | MigrationSourceFailure, CallError>;
  readonly startImport: (
    args: MigrationPlanArgs,
    viewer: Viewer,
  ) => Effect.Effect<
    { readonly status: "queued"; readonly jobId: JobId } | MigrationSourceFailure,
    CallError
  >;
}

/** The migration flow. */
export class Service extends Context.Service<Service, Interface>()("@media/server/Migrations") {}

/** A source failure as the "Couldn't connect" screen shows it. */
export const sourceFailure = (error: SourceError): MigrationSourceFailure => ({
  status: "failed",
  reason: failureReasonOf(error),
  message: error.message,
});

/** Whether a connect, dry run, or import answered a source failure. */
export const isSourceFailure = Schema.is(MigrationSourceFailure);

const sameText = (left: string | null, right: string | null): boolean =>
  left !== null && right !== null && left.trim().toLowerCase() === right.trim().toLowerCase();

/** The profile a source user's history goes to by default: same email, then same name. */
export const suggestProfile = (
  user: { readonly name: string; readonly email: string | null },
  targets: ReadonlyArray<MigrationTarget>,
): ContractSourceUser["suggestion"] => {
  const byEmail = targets.find((target) => sameText(target.email, user.email));
  const byName = targets.find((target) => sameText(target.name, user.name));

  const byProfile = targets.find((target) =>
    target.profiles.some((profile) => sameText(profile.name, user.name)),
  );

  const [matchedBy, account] =
    byEmail === undefined
      ? byName === undefined
        ? (["name", byProfile] as const)
        : (["name", byName] as const)
      : (["email", byEmail] as const);

  if (account === undefined) return { kind: "invite" };

  const profile =
    account.profiles.find((candidate) => sameText(candidate.name, user.name)) ??
    account.profiles[0];

  return profile === undefined
    ? { kind: "invite" }
    : { kind: "profile", userId: account.userId, profileId: profile.profileId, matchedBy };
};

/** Each source user's profile: the admin's choice when given, otherwise the suggestion. */
export const resolveUsers = (
  users: ReadonlyArray<ContractSourceUser>,
  overrides: ReadonlyArray<UserMapping>,
): ReadonlyArray<ResolvedUser<ProfileId>> =>
  users.map((user): ResolvedUser<ProfileId> => {
    const chosen = overrides.find((mapping) => mapping.sourceUserId === user.sourceUserId);
    const base = { sourceUserId: user.sourceUserId, name: user.name, history: user.history };

    if (chosen !== undefined) {
      return chosen.profileId === null
        ? { ...base, person: null, action: "skip" }
        : { ...base, person: chosen.profileId, action: "import" };
    }

    return user.suggestion.kind === "profile"
      ? { ...base, person: user.suggestion.profileId, action: "import" }
      : { ...base, person: null, action: "invite" };
  });

/** What a plan reads of the catalog it imports into: old movies' or the core's. */
export interface PlanReads<Person extends string> {
  readonly libraries: Effect.Effect<ReadonlyArray<ExistingLibrary>, CallError>;
  /** Every catalog file, read page by page. */
  readonly catalog: Effect.Effect<ReadonlyArray<CatalogFile>, CallError>;
  readonly localProgress: (
    person: Person,
  ) => Effect.Effect<ReadonlyArray<LocalProgress>, CallError>;
}

/** What `computePlan` plans for. */
export interface PlanTarget<Person extends string> {
  readonly source: MigrationSource;
  readonly users: ReadonlyArray<ResolvedUser<Person>>;
  readonly mappings: ReadonlyArray<PathMapping>;
  readonly roots: ReadonlyArray<string>;
  /** Read each imported person's progress, for a dry run's conflicts. */
  readonly withLocalProgress: boolean;
  readonly addsLibraries: boolean;
}

/** The plan a dry run computes, from the source and the catalog as they are now. */
export const computePlan = Effect.fnUntraced(function* <Person extends string>(
  session: SourceSession,
  reads: PlanReads<Person>,
  target: PlanTarget<Person>,
) {
  const { users } = target;
  const imported = users.filter((user) => user.action === "import");

  const people = [
    ...new Set(imported.flatMap((user) => (user.person === null ? [] : [user.person]))),
  ];

  const stateOf = (user: ResolvedUser<Person>) => {
    const sourceUser = session.users.find((candidate) => candidate.userId === user.sourceUserId);

    return sourceUser === undefined
      ? Effect.succeed([user.sourceUserId, []] as const)
      : session
          .userStates(sourceUser)
          .pipe(Effect.map((found) => [user.sourceUserId, found] as const));
  };

  // The source and the catalog answer independently, so their reads overlap; each still asks
  // one thing at a time, as a small server can take.
  const [source, catalogReads] = yield* Effect.all(
    [
      Effect.all({
        items: session.items,
        collections: session.collections,
        states: Effect.forEach(imported, stateOf),
      }),
      Effect.all({
        existingLibraries: reads.libraries,
        catalog: reads.catalog,
        localProgress: target.withLocalProgress
          ? Effect.forEach(people, (person) =>
              reads.localProgress(person).pipe(Effect.map((rows) => [person, rows] as const)),
            )
          : Effect.succeed([]),
      }),
    ],
    { concurrency: 2 },
  );

  const { items, collections } = source;
  const { existingLibraries, catalog } = catalogReads;
  const states = new Map(source.states);
  const localProgress = new Map(catalogReads.localProgress);

  return planMigration({
    source: target.source,
    server: session.server,
    libraries: session.libraries,
    items,
    collections,
    users,
    states,
    mappings: target.mappings,
    roots: target.roots,
    existingLibraries,
    addsLibraries: target.addsLibraries,
    catalog,
    localProgress,
  });
});

/** Old movies' catalog as a plan reads it, through the migration backend. */
export const backendReads = (backend: MigrationBackend.Interface): PlanReads<ProfileId> => ({
  libraries: backend.libraries,
  catalog: backend.catalog,
  localProgress: backend.localProgress,
});

/**
 * Local folders under `roots` for each source folder no mapping in `given` or root covers: the
 * first candidate (`mappingCandidates`) that is a directory on this host.
 */
export const inferMappings = Effect.fnUntraced(function* (
  folders: ReadonlyArray<string>,
  given: ReadonlyArray<PathMapping>,
  roots: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const inferred: Array<PathMapping> = [];

  for (const folder of folders) {
    if (toLocalPath(folder, [...given, ...inferred], roots) !== null) continue;

    for (const candidate of mappingCandidates(folder, roots)) {
      const isDirectory = yield* fs.stat(candidate).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.orElseSucceed(() => false),
      );

      if (isDirectory) {
        inferred.push({ from: normalizePath(folder), to: candidate });
        break;
      }
    }
  }

  return inferred;
});

/** The binding sealed credentials carry, so they open only for the plan they were sealed for. */
export const credentialsBinding = (serverId: string, sourceUrl: string): string =>
  `${serverId}\n${sourceUrl}`;

const make = Effect.gen(function* () {
  const config = yield* MediaConfig.Service;
  const backend = yield* MigrationBackend.Service;
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const context = yield* Effect.context<HttpClient.HttpClient>();
  const connections = yield* Ref.make<ReadonlyMap<string, Connection>>(new Map());

  const newConnectionId = crypto.randomBytes(18).pipe(
    Effect.map((bytes) => Buffer.from(bytes).toString("base64url")),
    Effect.orDie,
  );

  const connectionOf = Effect.fnUntraced(function* (connectionId: string, viewer: Viewer) {
    const now = yield* Clock.currentTimeMillis;
    const all = yield* Ref.get(connections);
    const found = all.get(connectionId);

    if (found === undefined || found.owner !== viewer.user.id || found.expiresAt <= now) {
      return yield* new NotFound({
        message: "Migration connection expired or unknown; connect to the server again",
      });
    }

    return found;
  });

  const connect = Effect.fn("Migrations.connect")(function* (
    args: MigrationConnectArgs,
    viewer: Viewer,
  ) {
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
    const targets = yield* backend.targets;
    const now = yield* Clock.currentTimeMillis;
    const expiresAt = now + Duration.toMillis(CONNECTION_TTL);
    const connectionId = yield* newConnectionId;

    const view: MigrationConnection = {
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
        suggestion: suggestProfile(user, targets),
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
        owner: viewer.user.id,
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

    yield* Effect.logInfo("Migration.connected").pipe(
      Effect.annotateLogs({
        source: args.source,
        users: view.users.length,
        libraries: view.libraries.length,
        inferredMappings: inferred.length,
      }),
    );

    return view;
  });

  const plan = Effect.fnUntraced(function* (connection: Connection, args: MigrationPlanArgs) {
    const users = resolveUsers(connection.view.users, args.users ?? []);
    const usersKey = JSON.stringify(users.map((user) => [user.sourceUserId, user.person]));

    const computed = yield* computePlan(connection.session, backendReads(backend), {
      source: connection.source,
      users,
      mappings: connection.mappings,
      roots: config.libraryRoots,
      withLocalProgress: true,
      addsLibraries: true,
    }).pipe(
      Effect.map((computedPlan) => ({ computedPlan })),
      Effect.catchTag(SOURCE_ERROR_TAGS, (error) => Effect.succeed(sourceFailure(error))),
    );

    if (isSourceFailure(computed)) return computed;

    const now = yield* Clock.currentTimeMillis;

    const report = reportOf(computed.computedPlan, {
      connectionId: connection.connectionId,
      source: connection.source,
      serverName: connection.view.serverName,
      createdAt: now,
      users,
    });

    const dryRun: DryRun = { usersKey, users, plan: computed.computedPlan, report };

    yield* Ref.update(connections, (all) => {
      const next = new Map(all);
      next.set(connection.connectionId, { ...connection, dryRun: Option.some(dryRun) });

      return next;
    });

    return dryRun;
  });

  const dryRun = Effect.fn("Migrations.dryRun")(function* (
    args: MigrationPlanArgs,
    viewer: Viewer,
  ) {
    const connection = yield* connectionOf(args.connectionId, viewer);
    const result = yield* plan(connection, args);

    return isSourceFailure(result) ? result : result.report;
  });

  const startImport = Effect.fn("Migrations.startImport")(function* (
    args: MigrationPlanArgs,
    viewer: Viewer,
  ) {
    const connection = yield* connectionOf(args.connectionId, viewer);
    const users = resolveUsers(connection.view.users, args.users ?? []);
    const usersKey = JSON.stringify(users.map((user) => [user.sourceUserId, user.person]));

    const previous = Option.filter(connection.dryRun, (run) => run.usersKey === usersKey);

    if (Option.isNone(previous)) {
      return yield* new Conflict({
        message: "Run a dry run of this connection with the same user mappings before importing",
      });
    }

    const ready = previous.value;

    if (Option.isNone(config.mediaServiceApiKey)) {
      return yield* new Internal({
        message: "Migration needs MEDIA_SERVICE_API_KEY to keep the source credentials for the job",
      });
    }

    const serverId = connection.session.server.serverId;

    const jobId = yield* backend.start({
      requestedBy: viewer.user.id,
      source: connection.source,
      serverName: connection.view.serverName,
      plan: {
        sourceUrl: connection.url,
        serverId,
        credentials: sealCredentials(
          config.mediaServiceApiKey.value,
          connection.credentials,
          credentialsBinding(serverId, connection.url),
        ),
        users: ready.users.flatMap((user) =>
          user.action === "import" && user.person !== null
            ? [
                {
                  sourceUserId: user.sourceUserId,
                  profileId: user.person,
                  history: user.history,
                },
              ]
            : [],
        ),
        libraries: ready.plan.libraries.flatMap((library) =>
          library.roots.length === 0
            ? []
            : [
                {
                  name: library.name,
                  kind: library.kind,
                  roots: library.roots,
                  access: library.access,
                },
              ],
        ),
        pathMappings: connection.mappings,
      },
    });

    return { status: "queued" as const, jobId };
  });

  return Service.of({ connect, dryRun, startImport });
});

/** The flow over the backend, configuration, disk, and the HTTP client. */
export const layer: Layer.Layer<
  Service,
  never,
  | MediaConfig.Service
  | MigrationBackend.Service
  | FileSystem.FileSystem
  | Crypto.Crypto
  | HttpClient.HttpClient
> = Layer.effect(Service, make);
