import { setTimeout as sleep } from "node:timers/promises";

import { getFunctionName } from "convex/server";
import type { FunctionArgs, FunctionReference } from "convex/server";
import { Schema } from "effect";

import type { CoreStack } from "./stack-env";

const FunctionResponse = Schema.Union([
  Schema.Struct({ status: Schema.Literal("success"), value: Schema.Unknown }),
  Schema.Struct({ status: Schema.Literal("error"), errorMessage: Schema.String }),
]);

const decodeResponse = Schema.decodeUnknownSync(FunctionResponse);

type AdminCallable = FunctionReference<"query" | "mutation", "public" | "internal">;

export const runFunction = async <
  Callable extends AdminCallable,
  Result extends Schema.ConstraintDecoder<unknown>,
>(
  stack: CoreStack,
  callable: Callable,
  args: FunctionArgs<Callable>,
  result: Result,
): Promise<Result["Type"]> => {
  const path = getFunctionName(callable);

  const response = await fetch(`${stack.url}/api/function`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Convex ${stack.adminKey}` },
    body: JSON.stringify({ path, args, format: "json" }),
  });

  const body = await response.text();

  if (!response.ok && response.status !== 560) {
    throw new Error(`${path} answered HTTP ${response.status}: ${body}`);
  }

  const decoded = decodeResponse(JSON.parse(body));

  if (decoded.status === "error") throw new Error(`${path} failed: ${decoded.errorMessage}`);

  return Schema.decodeUnknownSync(result)(decoded.value);
};

const FunctionLog = Schema.Struct({
  newCursor: Schema.Finite,
  entries: Schema.Array(
    Schema.Struct({
      kind: Schema.String,
      identifier: Schema.optionalKey(Schema.String),
      executionTimestamp: Schema.optionalKey(Schema.Finite),
      cachedResult: Schema.optionalKey(Schema.Boolean),
      usageStats: Schema.optionalKey(Schema.Struct({ databaseReadDocuments: Schema.Finite })),
    }),
  ),
});

const decodeLog = Schema.decodeUnknownSync(FunctionLog);

const logSince = async (stack: CoreStack, cursor: number): Promise<typeof FunctionLog.Type> => {
  const response = await fetch(`${stack.url}/api/stream_function_logs?cursor=${cursor}`, {
    headers: { Authorization: `Convex ${stack.adminKey}` },
  });

  const body = await response.text();

  if (!response.ok) throw new Error(`The function log answered HTTP ${response.status}: ${body}`);

  return decodeLog(JSON.parse(body));
};

/** A point in the function log: calls that start after it show up in `readsSince`. */
export interface LogMark {
  readonly cursor: number;
  readonly at: number;
}

export const logMark = async (stack: CoreStack): Promise<LogMark> => ({
  cursor: (await logSince(stack, 0)).newCursor,
  at: Date.now(),
});

/**
 * The documents read by each call of `callable` that started after `mark` and was not served
 * from the query cache. A call logged late from before the mark does not count, and neither does
 * a cached result, which reads nothing.
 */
export const readsSince = async (
  stack: CoreStack,
  mark: LogMark,
  callable: AdminCallable,
  calls: number,
  attempts = 40,
): Promise<ReadonlyArray<number>> => {
  const identifier = getFunctionName(callable);

  const reads = (await logSince(stack, mark.cursor)).entries.flatMap((entry) =>
    entry.kind === "Completion" &&
    entry.identifier === identifier &&
    entry.cachedResult !== true &&
    entry.executionTimestamp !== undefined &&
    entry.executionTimestamp * 1000 >= mark.at &&
    entry.usageStats !== undefined
      ? [entry.usageStats.databaseReadDocuments]
      : [],
  );

  if (reads.length >= calls) return reads;

  if (attempts <= 0) throw new Error(`Only ${reads.length} of ${calls} ${identifier} calls logged`);

  await sleep(250);

  return readsSince(stack, mark, callable, calls, attempts - 1);
};
