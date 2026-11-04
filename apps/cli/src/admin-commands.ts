import { commands } from "@media/contracts/commands";
import { NotFound } from "@media/contracts/errors";
import type { JobId } from "@media/contracts/ids";
import { ProfileId } from "@media/contracts/ids";
import type { Job } from "@media/contracts/models/jobs";
import { MigrationSource } from "@media/contracts/models/jobs";
import type { MigrationSourceFailure } from "@media/contracts/models/migration";
import { Effect, Option, Schema, Struct } from "effect";

import { MigrationSourceError } from "./cli-errors";
import { waitOptions } from "./flags";
import type { Invocation, ShortcutCommand } from "./invocation";
import {
  booleanFlag,
  encodeResult,
  positionalText,
  readSecret,
  requirePositional,
  resultOutcome,
  stringFlag,
  textOutcome,
  timeoutFlag,
  usage,
} from "./invocation";
import { progressLine, waitForJobs } from "./jobs";
import type { Connection } from "./session";
import { connect } from "./session";

const encodeJob = Schema.encodeSync(Schema.toCodecJson(commands["jobs.get"].result));

const followJobs = Effect.fn("Admin.followJobs")(function* (
  invocation: Invocation,
  connection: Connection,
  jobIds: ReadonlyArray<JobId>,
) {
  if (!booleanFlag(invocation.tokens, "wait")) return [];
  const timeout = yield* timeoutFlag(invocation);

  return yield* waitForJobs(connection.client, jobIds, { progress: true, timeout });
});

const jobsOutcome = (base: Schema.JsonObject, jobs: ReadonlyArray<Job>, queued: string) =>
  textOutcome(
    jobs.length === 0 ? base : Struct.assign(base, { jobs: jobs.map((job) => encodeJob(job)) }),
    jobs.length === 0 ? queued : jobs.map(progressLine).join("\n"),
  );

const scan: ShortcutCommand = {
  path: "scan",
  options: { mode: { type: "string" }, ...waitOptions },
  positionals: true,
  run: (invocation) =>
    Effect.gen(function* () {
      const mode = stringFlag(invocation.tokens, "mode");

      if (Option.isSome(mode) && mode.value !== "quick" && mode.value !== "full") {
        return yield* usage(invocation, "--mode must be quick or full");
      }

      const connection = yield* connect(invocation.env, invocation.target, "required");

      const libraries = yield* connection.withSession(
        connection.client.query("libraries.listDetails", {}),
      );

      const wanted = positionalText(invocation.tokens);

      const chosen = Option.match(wanted, {
        onNone: () => libraries,
        onSome: (name) =>
          libraries.filter(
            (library) => library.id === name || library.name.toLowerCase() === name.toLowerCase(),
          ),
      });

      if (chosen.length === 0) {
        return yield* new NotFound({
          message: Option.match(wanted, {
            onNone: () => "There are no libraries to scan",
            onSome: (name) => `No library "${name}"; see media libraries list-details`,
          }),
        });
      }

      const queued = yield* Effect.forEach(chosen, (library) =>
        connection.withSession(
          connection.client.mutate("libraries.scan", {
            libraryId: library.id,
            ...Option.match(mode, {
              onNone: () => ({}),
              onSome: (value) => ({
                mode: value === "quick" ? ("quick" as const) : ("full" as const),
              }),
            }),
          }),
        ),
      );

      const jobs = yield* followJobs(
        invocation,
        connection,
        queued.map((job) => job.jobId),
      );

      return jobsOutcome(
        { jobIds: queued.map((job) => job.jobId) },
        jobs,
        `Queued ${String(queued.length)} scan${queued.length === 1 ? "" : "s"}: ${queued.map((job) => job.jobId).join(", ")}`,
      );
    }),
};

const parsePairs = (invocation: Invocation, flag: string, expected: string) =>
  Effect.forEach(
    Option.getOrElse(stringFlag(invocation.tokens, flag), () => "")
      .split(",")
      .map((pair) => pair.trim())
      .filter((pair) => pair.length > 0),
    (pair) => {
      const separator = pair.indexOf("=");
      const left = pair.slice(0, separator);
      const right = pair.slice(separator + 1);

      return separator <= 0 || right.length === 0
        ? Effect.fail(usage(invocation, `--${flag} expects ${expected}, got "${pair}"`))
        : Effect.succeed({ left, right });
    },
  );

const parseMappings = (invocation: Invocation) =>
  parsePairs(invocation, "map", "<source-user-id>=<profile-id> or <source-user-id>=skip").pipe(
    Effect.map((pairs) =>
      pairs.map(({ left, right }) => ({
        sourceUserId: left,
        profileId: right === "skip" ? null : ProfileId.make(right),
      })),
    ),
  );

const parsePathMappings = (invocation: Invocation) =>
  parsePairs(invocation, "path-map", "<source-folder>=<local-folder>").pipe(
    Effect.flatMap((pairs) =>
      pairs.some(({ right }) => !right.startsWith("/"))
        ? Effect.fail(usage(invocation, "--path-map needs absolute local folders"))
        : Effect.succeed(pairs.map(({ left, right }) => ({ from: left, to: right }))),
    ),
  );

const isMigrationSource = Schema.is(MigrationSource);

const importCredentials = (invocation: Invocation) =>
  Option.match(stringFlag(invocation.tokens, "user"), {
    onNone: () =>
      readSecret(invocation, "MEDIA_IMPORT_TOKEN", "source server's token").pipe(
        Effect.map((token) => ({ kind: "token" as const, token })),
      ),
    onSome: (username) =>
      readSecret(invocation, "MEDIA_IMPORT_PASSWORD", "source server's password").pipe(
        Effect.map((password) => ({ kind: "password" as const, username, password })),
      ),
  });

const isReady = <Ready extends { readonly status: "connected" | "ready" | "queued" }>(
  result: Ready | MigrationSourceFailure,
): result is Ready => result.status !== "failed";

const sourceReady = <Ready extends { readonly status: "connected" | "ready" | "queued" }>(
  result: Ready | MigrationSourceFailure,
): Effect.Effect<Ready, MigrationSourceError> =>
  isReady(result)
    ? Effect.succeed(result)
    : Effect.fail(new MigrationSourceError({ reason: result.reason, message: result.message }));

const migrate: ShortcutCommand = {
  path: "import",
  options: {
    url: { type: "string" },
    user: { type: "string" },
    map: { type: "string" },
    "path-map": { type: "string" },
    "dry-run": { type: "boolean" },
    ...waitOptions,
  },
  positionals: true,
  run: (invocation) =>
    Effect.gen(function* () {
      const source = yield* requirePositional(invocation, "jellyfin or plex");

      if (!isMigrationSource(source))
        return yield* usage(invocation, "import needs jellyfin or plex");
      const url = stringFlag(invocation.tokens, "url");

      if (Option.isNone(url))
        return yield* usage(invocation, "import needs --url <source server URL>");

      if (source === "plex" && Option.isSome(stringFlag(invocation.tokens, "user"))) {
        return yield* usage(invocation, "Plex signs in with a token; drop --user");
      }

      const users = yield* parseMappings(invocation);
      const pathMappings = yield* parsePathMappings(invocation);
      const credentials = yield* importCredentials(invocation);
      const connection = yield* connect(invocation.env, invocation.target, "required");

      const connectArgs =
        pathMappings.length === 0
          ? { source, url: url.value, credentials }
          : { source, url: url.value, credentials, pathMappings };

      const connected = yield* connection
        .withSession(connection.client.media("migration.connect", connectArgs))
        .pipe(Effect.flatMap(sourceReady));

      const plan =
        users.length === 0
          ? { connectionId: connected.connectionId }
          : { connectionId: connected.connectionId, users };

      const report = yield* connection
        .withSession(connection.client.media("migration.dryRun", plan))
        .pipe(Effect.flatMap(sourceReady));

      if (booleanFlag(invocation.tokens, "dry-run")) {
        return resultOutcome(
          commands["migration.dryRun"],
          yield* encodeResult("migration.dryRun", commands["migration.dryRun"], report),
        );
      }

      const queued = yield* connection
        .withSession(connection.client.media("migration.import", plan))
        .pipe(Effect.flatMap(sourceReady));

      const jobs = yield* followJobs(invocation, connection, [queued.jobId]);

      return jobsOutcome({ jobId: queued.jobId }, jobs, `Queued migration job ${queued.jobId}`);
    }),
};

const backup: ShortcutCommand = {
  path: "backup",
  options: waitOptions,
  positionals: false,
  run: (invocation) =>
    Effect.gen(function* () {
      const connection = yield* connect(invocation.env, invocation.target, "required");
      const queued = yield* connection.withSession(connection.client.mutate("backups.run", {}));
      const jobs = yield* followJobs(invocation, connection, [queued.jobId]);

      return jobsOutcome({ jobId: queued.jobId }, jobs, `Queued backup job ${queued.jobId}`);
    }),
};

const restore: ShortcutCommand = {
  path: "restore",
  options: {},
  positionals: true,
  run: (invocation) =>
    Effect.gen(function* () {
      const wanted = yield* requirePositional(invocation, "a backup file name or ID");
      const connection = yield* connect(invocation.env, invocation.target, "required");
      const backups = yield* connection.withSession(connection.client.query("backups.list", {}));
      const name = wanted.split("/").at(-1) ?? wanted;

      const found = backups.find(
        (candidate) => candidate.id === wanted || candidate.fileName === name,
      );

      if (found === undefined) {
        return yield* new NotFound({ message: `No backup "${wanted}"; see media backups list` });
      }

      yield* connection.withSession(
        connection.client.media("backups.restore", { backupId: found.id }),
      );

      return textOutcome(
        { ok: true, backupId: found.id, fileName: found.fileName },
        `Restored ${found.fileName}. Every session signs in again.`,
      );
    }),
};

/** The administration shortcuts. */
export const adminCommands: ReadonlyArray<ShortcutCommand> = [scan, migrate, backup, restore];
