import { CommandFailure, commandError, Internal, Unauthenticated } from "@media/contracts/errors";
import { ProtocolError, TransportError } from "@media/sdk/effect";
import { Effect, Option, Redacted, Result, Schema } from "effect";

import { ConfigFileError } from "../cli-errors";
import { nonEmpty, normalizeUrl, ServerUrl } from "../config";
import { readTextFile } from "../files";
import type { Invocation } from "../invocation";
import { positionalText, readSecret, stringFlag, textOutcome, usage } from "../invocation";
import type { CoreShortcut } from "./command";
import { coreShortcut } from "./command";

interface HostKey {
  readonly url: string;
  readonly adminKey: Redacted.Redacted;
}

const isServerUrl = Schema.is(ServerUrl);

const MISSING =
  "reset-password needs the core's admin key from the server host: pass --env-file with CONVEX_SELF_HOSTED_URL and CONVEX_SELF_HOSTED_ADMIN_KEY, or set MEDIA_CORE_URL and MEDIA_CORE_ADMIN_KEY";

const envFileValues = (text: string): ReadonlyMap<string, string> =>
  new Map(
    text.split("\n").flatMap((line) => {
      const separator = line.indexOf("=");

      return separator > 0
        ? [[line.slice(0, separator).trim(), line.slice(separator + 1).trim()] as const]
        : [];
    }),
  );

const hostKey = Effect.fn("Core.hostKey")(
  function* (invocation: Invocation) {
    const fromFile = yield* Option.match(stringFlag(invocation.tokens, "env-file"), {
      onNone: () => Effect.succeedNone,
      onSome: (path) =>
        Effect.tryPromise({
          try: () => readTextFile(path),
          catch: (cause) => new ConfigFileError({ path, message: `Could not read ${path}`, cause }),
        }).pipe(
          Effect.flatMap((text) =>
            text === null
              ? Effect.fail(
                  new ConfigFileError({ path, message: `No file at ${path}`, cause: null }),
                )
              : Effect.succeedSome(envFileValues(text)),
          ),
        ),
    });

    const [url, adminKey] = Option.isSome(fromFile)
      ? [
          Option.fromNullishOr(fromFile.value.get("CONVEX_SELF_HOSTED_URL")),
          Option.fromNullishOr(fromFile.value.get("CONVEX_SELF_HOSTED_ADMIN_KEY")),
        ]
      : [yield* nonEmpty("MEDIA_CORE_URL"), yield* nonEmpty("MEDIA_CORE_ADMIN_KEY")];

    if (Option.isNone(url) || Option.isNone(adminKey) || adminKey.value.length === 0) {
      return yield* usage(invocation, MISSING);
    }

    const normalized = normalizeUrl(url.value);

    if (!isServerUrl(normalized)) {
      return yield* usage(invocation, `The core's URL is not an http(s) URL: "${url.value}"`);
    }

    const key: HostKey = { url: normalized, adminKey: Redacted.make(adminKey.value) };

    return key;
  },
  Effect.catchTag("ConfigError", (cause) =>
    Effect.fail(
      new ConfigFileError({
        path: "environment",
        message: "Could not read the environment",
        cause,
      }),
    ),
  ),
);

const FunctionAnswer = Schema.Union([
  Schema.Struct({ status: Schema.Literal("success"), value: Schema.Json }),
  Schema.Struct({
    status: Schema.Literal("error"),
    errorMessage: Schema.String,
    errorData: Schema.optionalKey(Schema.Json),
  }),
]);

const decodeAnswer = Schema.decodeUnknownResult(Schema.fromJsonString(FunctionAnswer));

const decodeFailure = Schema.decodeUnknownOption(CommandFailure);

const decodeReset = Schema.decodeUnknownEffect(Schema.Struct({ username: Schema.String }));

const RESET = "core/accounts/host:resetPassword";

const runInternal = Effect.fn("Core.runInternal")(function* (
  key: HostKey,
  path: string,
  args: Schema.JsonObject,
) {
  const response = yield* Effect.tryPromise({
    try: async (signal) => {
      const answer = await fetch(`${key.url}/api/function`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Convex ${Redacted.value(key.adminKey)}`,
        },
        body: JSON.stringify({ path, args, format: "json" }),
        signal,
      });

      return { status: answer.status, body: await answer.text() };
    },
    catch: (cause) =>
      new TransportError({
        operation: path,
        message: `Transport failed during ${path}: could not reach the core at ${key.url}`,
        cause,
      }),
  });

  if (response.status === 401 || response.status === 403) {
    return yield* new Unauthenticated({ message: "The core refused this admin key" });
  }

  const answer = decodeAnswer(response.body);

  if (Result.isFailure(answer)) {
    return yield* new ProtocolError({
      operation: path,
      message: `Protocol error in ${path}: the core answered HTTP ${String(response.status)}`,
      cause: answer.failure,
    });
  }

  if (answer.success.status === "success") return answer.success.value;

  return yield* Option.match(decodeFailure(answer.success.errorData), {
    onNone: () => Effect.fail(new Internal({ message: `The server failed while running ${path}` })),
    onSome: (failure) => Effect.fail(commandError(failure)),
  });
});

const resetPassword = coreShortcut("admin", "reset-password", {
  usage: "[<username>] [--env-file <path>]",
  summary:
    "On the server host, set a new password for a user, the owner when none is named, and end their sessions, API keys, and links; the password comes from stdin or MEDIA_ARG_PASSWORD",
  options: { "env-file": { type: "string" } },
  positionals: true,
  run: (invocation) =>
    Effect.gen(function* () {
      const key = yield* hostKey(invocation);
      const username = positionalText(invocation.tokens);
      const password = yield* readSecret(invocation, "MEDIA_ARG_PASSWORD", "new password");

      const answer = yield* runInternal(key, RESET, {
        ...Option.match(username, { onNone: () => ({}), onSome: (name) => ({ username: name }) }),
        password: Redacted.value(password),
      });

      const reset = yield* decodeReset(answer).pipe(
        Effect.mapError(
          (cause) =>
            new ProtocolError({
              operation: RESET,
              message: `Protocol error in ${RESET}: unexpected answer`,
              cause,
            }),
        ),
      );

      return textOutcome(
        { username: reset.username },
        `Set a new password for ${reset.username}. Their sessions, API keys, and links have ended.`,
      );
    }),
});

/** The commands of the `admin` group that run on the server host. */
export const hostCommands: ReadonlyArray<CoreShortcut> = [resetPassword];
