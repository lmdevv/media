import { getFunctionName } from "convex/server";
import type { FunctionArgs, FunctionReference, WithoutSystemFields } from "convex/server";
import { ConvexError } from "convex/values";
import type { Value } from "convex/values";
import { Option, Schema } from "effect";

import type { Doc, Id, TableNames } from "../convex/_generated/dataModel";
import type { CoreStack } from "./stack-env";

const FunctionResponse = Schema.Union([
  Schema.Struct({ status: Schema.Literal("success"), value: Schema.Unknown }),
  Schema.Struct({
    status: Schema.Literal("error"),
    errorMessage: Schema.String,
    errorData: Schema.optionalKey(Schema.Struct({ code: Schema.String, message: Schema.String })),
  }),
]);

const decodeResponse = Schema.decodeUnknownSync(FunctionResponse);

type AdminCallable = FunctionReference<"query" | "mutation" | "action", "public" | "internal">;

const decodeRefusalCode = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ code: Schema.String })),
);

/**
 * A call the backend refused before or instead of committing it, such as a conflict that outlasted
 * its retries (`OptimisticConcurrencyControlFailure`) or the write-rate limit (`TooManyWrites`).
 */
export class FunctionRefused extends Error {
  readonly code: string | null;

  constructor(path: string, status: number, body: string) {
    super(`${path} answered HTTP ${status}: ${body}`);
    this.code = Option.getOrNull(decodeRefusalCode(body))?.code ?? null;
  }
}

/**
 * Sends one function call over HTTP with `authorization` and decodes its result: the admin key
 * (`Convex <key>`) through `/api/function`, which reaches internal functions too, or a session's
 * `Bearer <token>` (or none) through `/api/run`, as a client reaches public ones. A refusal the
 * function failed with comes back as the `ConvexError` a client gets, so `refusal` reads its code;
 * a refusal before or instead of committing comes back as `FunctionRefused`.
 */
export const callFunction = async <
  Callable extends AdminCallable,
  Result extends Schema.ConstraintDecoder<unknown>,
>(
  url: string,
  authorization: string,
  callable: Callable,
  args: FunctionArgs<Callable>,
  result: Result,
): Promise<Result["Type"]> => {
  const path = getFunctionName(callable);
  const admin = authorization.startsWith("Convex ");

  const response = await fetch(
    admin ? `${url}/api/function` : `${url}/api/run/${path.replace(":", "/")}`,
    {
      method: "POST",
      headers: new Headers(
        authorization === ""
          ? { "Content-Type": "application/json" }
          : { "Content-Type": "application/json", Authorization: authorization },
      ),
      body: JSON.stringify(admin ? { path, args, format: "json" } : { args, format: "json" }),
    },
  );

  const body = await response.text();

  if (!response.ok && response.status !== 560) {
    throw new FunctionRefused(path, response.status, body);
  }

  const decoded = decodeResponse(JSON.parse(body));

  if (decoded.status === "error") {
    if (decoded.errorData !== undefined) throw new ConvexError(decoded.errorData);

    throw new Error(`${path} failed: ${decoded.errorMessage}`);
  }

  return Schema.decodeUnknownSync(result)(decoded.value);
};

/**
 * Runs one of the backend's own dashboard mutations with the admin key, as someone editing a
 * document by hand in the dashboard does: a change no function of the deployment makes.
 */
const runDashboardMutation = async (stack: CoreStack, path: string, args: Value): Promise<void> => {
  const response = await fetch(`${stack.url}/api/mutation`, {
    method: "POST",
    headers: new Headers({
      "Content-Type": "application/json",
      Authorization: `Convex ${stack.adminKey}`,
    }),
    body: JSON.stringify({ path, args, format: "json" }),
  });

  const body = await response.text();

  if (!response.ok) throw new FunctionRefused(path, response.status, body);

  const decoded = decodeResponse(JSON.parse(body));

  if (decoded.status === "error") throw new Error(`${path} failed: ${decoded.errorMessage}`);
};

/** Sets `fields` on the documents `ids` of `table` by hand, as the dashboard does. */
export const patchByHand = <Table extends TableNames>(
  stack: CoreStack,
  table: Table,
  ids: ReadonlyArray<Id<Table>>,
  fields: Partial<WithoutSystemFields<Doc<Table>>>,
): Promise<void> =>
  runDashboardMutation(stack, "_system/frontend/patchDocumentsFields", {
    table,
    ids: [...ids],
    fields,
  });

/** Inserts `documents` into `table` by hand, as the dashboard does. */
export const insertByHand = <Table extends TableNames>(
  stack: CoreStack,
  table: Table,
  documents: ReadonlyArray<WithoutSystemFields<Doc<Table>>>,
): Promise<void> =>
  runDashboardMutation(stack, "_system/frontend/addDocument", {
    table,
    documents: [...documents],
  });

/** Runs a function with the deployment's admin key and decodes its result, as `callFunction`. */
export const runFunction = <
  Callable extends AdminCallable,
  Result extends Schema.ConstraintDecoder<unknown>,
>(
  stack: CoreStack,
  callable: Callable,
  args: FunctionArgs<Callable>,
  result: Result,
): Promise<Result["Type"]> =>
  callFunction(stack.url, `Convex ${stack.adminKey}`, callable, args, result);

const FunctionLog = Schema.Struct({
  newCursor: Schema.Finite,
  entries: Schema.Array(
    Schema.Struct({
      kind: Schema.String,
      identifier: Schema.optionalKey(Schema.String),
      executionTimestamp: Schema.optionalKey(Schema.Finite),
      cachedResult: Schema.optionalKey(Schema.Boolean),
      error: Schema.optionalKey(Schema.NullOr(Schema.String)),
      willRetry: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
      userExecutionTime: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
      usageStats: Schema.optionalKey(
        Schema.Struct({
          databaseReadDocuments: Schema.Finite,
          databaseReadBytes: Schema.optionalKey(Schema.Finite),
          databaseWriteDocuments: Schema.Finite,
          databaseWriteBytes: Schema.optionalKey(Schema.Finite),
        }),
      ),
    }),
  ),
});

const decodeLog = Schema.decodeUnknownSync(FunctionLog);

type LogEntry = (typeof FunctionLog.Type)["entries"][number];

/** The backend keeps the latest 1,000 log entries; one read returns at most that many. */
const LOG_BUFFER_ENTRIES = 1000;

const logSince = async (
  stack: CoreStack,
  cursor: number,
): Promise<{ readonly body: string; readonly page: typeof FunctionLog.Type }> => {
  const response = await fetch(`${stack.url}/api/stream_function_logs?cursor=${cursor}`, {
    headers: { Authorization: `Convex ${stack.adminKey}` },
  });

  const body = await response.text();

  if (!response.ok) throw new Error(`The function log answered HTTP ${response.status}: ${body}`);

  return { body, page: decodeLog(JSON.parse(body)) };
};

export interface LogMark {
  readonly cursor: number;
  readonly at: number;
}

export const logMark = async (stack: CoreStack): Promise<LogMark> => ({
  cursor: (await logSince(stack, 0)).page.newCursor,
  at: Date.now(),
});

export interface CallUsage {
  readonly reads: number;
  /** The bytes the attempt read, as the backend logged them; 0 when it logged none. */
  readonly bytes: number;
  readonly writes: number;
  /** The bytes the attempt wrote, as the backend logged them; 0 when it logged none. */
  readonly writeBytes: number;
  /**
   * How long the attempt's own code ran, in seconds, which Convex's 1 s limit bounds, as the
   * backend logged it; 0 when it logged none. Time in the database is not part of it.
   */
  readonly seconds: number;
  /**
   * False for an attempt that failed, including one Convex retried after a conflict or the
   * write-rate limit; its writes rolled back.
   */
  readonly committed: boolean;
}

export interface LogFollower {
  /**
   * Reads the entries logged since the last read. When none are new it waits for the next one,
   * which the lease-release cron logs every 10 seconds.
   *
   * @throws Error when the backend's buffer dropped entries since the last read.
   */
  readonly catchUp: () => Promise<void>;
  /**
   * The usage of each attempt of `callable` read so far that started after the mark and was not
   * served from the query cache, which reads nothing.
   */
  readonly usage: (callable: AdminCallable) => ReadonlyArray<CallUsage>;
  /** Every page read so far as the backend answered it, every field of every entry included. */
  readonly text: () => string;
}

/** Follows the function log from `mark`. Read it often enough that 1,000 entries never pile up. */
export const followLog = (stack: CoreStack, mark: LogMark): LogFollower => {
  const entries: Array<LogEntry> = [];
  const bodies: Array<string> = [];
  let cursor = mark.cursor;

  return {
    catchUp: async () => {
      const { body, page } = await logSince(stack, cursor);

      if (page.entries.length >= LOG_BUFFER_ENTRIES) {
        throw new Error("The function log dropped entries; read it more often");
      }

      entries.push(...page.entries);
      bodies.push(body);
      cursor = page.newCursor;
    },
    text: () => bodies.join("\n"),
    usage: (callable) => {
      const identifier = getFunctionName(callable);

      return entries.flatMap((entry) =>
        entry.kind === "Completion" &&
        entry.identifier === identifier &&
        entry.cachedResult !== true &&
        entry.executionTimestamp !== undefined &&
        entry.executionTimestamp * 1000 >= mark.at &&
        entry.usageStats !== undefined
          ? [
              {
                reads: entry.usageStats.databaseReadDocuments,
                bytes: entry.usageStats.databaseReadBytes ?? 0,
                writes: entry.usageStats.databaseWriteDocuments,
                writeBytes: entry.usageStats.databaseWriteBytes ?? 0,
                seconds: entry.userExecutionTime ?? 0,
                committed: (entry.error ?? null) === null && !(entry.willRetry ?? false),
              },
            ]
          : [],
      );
    },
  };
};

/**
 * The usage of each attempt of `callable` that started after `mark`, once at least `calls` of them
 * committed.
 */
export const usageSince = async (
  stack: CoreStack,
  mark: LogMark,
  callable: AdminCallable,
  calls: number,
  timeoutMs = 30_000,
): Promise<ReadonlyArray<CallUsage>> => {
  const log = followLog(stack, mark);
  const deadline = Date.now() + timeoutMs;

  const logged = async (): Promise<ReadonlyArray<CallUsage>> => {
    const usage = log.usage(callable);
    const committed = usage.filter((call) => call.committed).length;

    if (committed >= calls) return usage;

    if (Date.now() > deadline) {
      throw new Error(`Only ${committed} of ${calls} ${getFunctionName(callable)} calls logged`);
    }

    await log.catchUp();

    return logged();
  };

  return logged();
};

/**
 * Everything logged after `mark` as the backend answered it, read once a committed call to `last`
 * that started after the mark has been logged. Make `last` the final call of what the test reads.
 */
export const logTextSince = async (
  stack: CoreStack,
  mark: LogMark,
  last: AdminCallable,
  timeoutMs = 30_000,
): Promise<string> => {
  const log = followLog(stack, mark);
  const deadline = Date.now() + timeoutMs;

  const read = async (): Promise<string> => {
    if (log.usage(last).some((call) => call.committed)) return log.text();

    if (Date.now() > deadline) throw new Error(`No ${getFunctionName(last)} call was logged`);

    await log.catchUp();

    return read();
  };

  return read();
};
