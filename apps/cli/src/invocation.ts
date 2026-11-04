import type { ParseArgsOptionsConfig } from "node:util";

import type { AnyCommand } from "@media/contracts/command";
import type { ProfileId } from "@media/contracts/ids";
import { ProfileId as ProfileIdSchema } from "@media/contracts/ids";
import { Milliseconds } from "@media/contracts/units";
import { ProtocolError } from "@media/sdk/effect";
import { Config, Data, Duration, Effect, Option, Predicate, Redacted, Schema } from "effect";
import type { Scope } from "effect";

import type { CliError } from "./cli-errors";
import { ConfigFileError, UsageError } from "./cli-errors";
import type { Environment, Target } from "./config";
import { readStdin } from "./files";
import type { ParsedTokens } from "./flags";
import type { Output } from "./output";
import { renderResult } from "./render";

/** How results print. */
export type Format = "json" | "table";

/** One run of one command. */
export interface Invocation {
  /** The words that named the command, such as `rooms pause`, for usage errors. */
  readonly path: string;
  readonly tokens: ParsedTokens;
  readonly env: Environment;
  readonly target: Target;
  readonly format: Format;
}

/** What a command produced. */
export type Outcome = Data.TaggedEnum<{
  /** A result printed when the command finishes: its JSON value and how people read it. */
  Result: { readonly json: Schema.Json; readonly human: string };
  /** Nothing more to print: the command printed its output line by line as it ran. */
  Printed: {};
}>;

/** Constructors and matchers for `Outcome`. */
export const Outcome = Data.taggedEnum<Outcome>();

/** A command the CLI implements itself. */
export interface ShortcutCommand {
  readonly path: string;
  /** Flags beyond the global ones. */
  readonly options: ParseArgsOptionsConfig;
  /** Whether positional words are accepted. */
  readonly positionals: boolean;
  readonly run: (invocation: Invocation) => Effect.Effect<Outcome, CliError, Output | Scope.Scope>;
}

/** The value of a string flag, if given. */
export const stringFlag = (tokens: ParsedTokens, name: string): Option.Option<string> => {
  const value = tokens.values[name];

  return Predicate.isString(value) && value.trim().length > 0
    ? Option.some(value.trim())
    : Option.none();
};

/** Whether a boolean flag was given. */
export const booleanFlag = (tokens: ParsedTokens, name: string): boolean =>
  tokens.values[name] === true;

/** The positional words joined, if any. */
export const positionalText = (tokens: ParsedTokens): Option.Option<string> => {
  const text = tokens.positionals.join(" ").trim();

  return text.length > 0 ? Option.some(text) : Option.none();
};

/** Fails with a usage error naming the command. */
export const usage = (invocation: Invocation, message: string): UsageError =>
  new UsageError({ message, command: invocation.path });

/** The positional words, or a usage error naming what is missing. */
export const requirePositional = (
  invocation: Invocation,
  what: string,
): Effect.Effect<string, UsageError> =>
  Effect.fromOption(positionalText(invocation.tokens)).pipe(
    Effect.mapError(() => usage(invocation, `${invocation.path} needs ${what}`)),
  );

/**
 * A secret from the environment variable `variable` or, when stdin is piped, from stdin. `what`
 * names the secret in messages, such as `password`.
 *
 * @returns The secret, or a usage error when the variable is set but blank, stdin is a terminal,
 * or the piped secret is empty. A blank variable never falls through to stdin: an inherited pipe
 * that never closes would wait forever.
 */
export const readSecret = Effect.fn("Cli.readSecret")(function* (
  invocation: Invocation,
  variable: string,
  what: string,
) {
  const fromEnv = yield* Config.option(Config.Redacted(variable)).pipe(
    Effect.orElseSucceed(() => Option.none<Redacted.Redacted>()),
  );

  // Effect's environment provider reads an empty variable as unset; process.env tells them apart.
  const blank = Option.match(fromEnv, {
    onSome: (secret) => Redacted.value(secret).trim().length === 0,
    onNone: () => process.env[variable] === "",
  });

  if (blank) {
    return yield* usage(invocation, `${variable} is set but empty; unset it or set the ${what}`);
  }

  if (Option.isSome(fromEnv)) return fromEnv.value;

  if (process.stdin.isTTY) {
    return yield* usage(invocation, `Pipe the ${what} on stdin or set ${variable}`);
  }

  const text = yield* Effect.tryPromise({
    try: readStdin,
    catch: (cause) =>
      new ConfigFileError({ path: "stdin", message: "Could not read stdin", cause }),
  });

  const secret = text.trim();

  if (secret.length === 0) return yield* usage(invocation, `The ${what} on stdin is empty`);

  return Redacted.make(secret);
});

/**
 * Parses a media position: seconds (`90`, `12.5`) or `h:mm:ss` / `m:ss`. Returns none when the
 * text is neither, or names a position too large to be a finite number of milliseconds.
 */
export const parsePosition = (text: string): Option.Option<Milliseconds> => {
  const parts = text.trim().split(":");

  if (parts.length > 3 || parts.some((part) => !/^\d+(\.\d+)?$/u.test(part))) return Option.none();
  const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0);

  return Milliseconds.makeOption(Math.round(seconds * 1000));
};

/** A `--position`-style flag as milliseconds, or a usage error. */
export const positionFlag = (
  invocation: Invocation,
  name: string,
): Effect.Effect<Option.Option<Milliseconds>, UsageError> =>
  Option.match(stringFlag(invocation.tokens, name), {
    onNone: () => Effect.succeedNone,
    onSome: (raw) =>
      Option.match(parsePosition(raw), {
        onNone: () =>
          Effect.fail(usage(invocation, `--${name} expects seconds or h:mm:ss, got "${raw}"`)),
        onSome: Effect.succeedSome,
      }),
  });

/** `--timeout <seconds>` for `--wait`, one hour by default. */
export const timeoutFlag = (invocation: Invocation): Effect.Effect<Duration.Duration, UsageError> =>
  Option.match(stringFlag(invocation.tokens, "timeout"), {
    onNone: () => Effect.succeed(Duration.hours(1)),
    onSome: (raw) => {
      const seconds = Number(raw);

      return Number.isFinite(seconds) && seconds > 0
        ? Effect.succeed(Duration.seconds(seconds))
        : Effect.fail(usage(invocation, `--timeout expects seconds, got "${raw}"`));
    },
  });

/** The viewing profile, if any: `--profile-id`, else the stored default. */
export const viewingProfileIfAny = (
  invocation: Invocation,
  stored: Option.Option<ProfileId>,
): Option.Option<ProfileId> =>
  Option.orElse(
    Option.map(stringFlag(invocation.tokens, "profile-id"), (value) => ProfileIdSchema.make(value)),
    () => stored,
  );

/** The viewing profile: `--profile-id`, else the stored default, else a usage error. */
export const viewingProfile = (
  invocation: Invocation,
  stored: Option.Option<ProfileId>,
): Effect.Effect<ProfileId, UsageError> =>
  Effect.fromOption(viewingProfileIfAny(invocation, stored)).pipe(
    Effect.mapError(() =>
      usage(
        invocation,
        "No viewing profile: pass --profile-id or run media profiles use <profile>",
      ),
    ),
  );

/** Encodes a decoded command result as JSON with the command's result schema. */
export const encodeResult = <Command extends AnyCommand>(
  name: string,
  command: Command,
  result: Command["result"]["Type"],
): Effect.Effect<Schema.Json, CliError> =>
  Schema.encodeUnknownEffect(Schema.toCodecJson(command.result))(result).pipe(
    Effect.mapError(
      (cause) =>
        new ProtocolError({
          operation: name,
          message: `Protocol error in ${name}: the result could not be printed as JSON`,
          cause,
        }),
    ),
  );

/** An outcome printed with the command's result schema in table mode. */
export const resultOutcome = (command: AnyCommand, json: Schema.Json): Outcome =>
  Outcome.Result({ json, human: renderResult(command.result, json) });

/** An outcome whose human form is a line of text. */
export const textOutcome = (json: Schema.Json, human: string): Outcome =>
  Outcome.Result({ json, human });
