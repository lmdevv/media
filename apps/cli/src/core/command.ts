import type { ParseArgsOptionsConfig } from "node:util";

import type { Platform } from "@media/sdk/effect";
import { ProtocolError } from "@media/sdk/effect";
import { Config, Effect, Match, Option, Redacted, Schema } from "effect";

import type { CatalogEntry } from "../catalog";
import {
  argsJsonSchema,
  exitCodeLine,
  flagNote,
  pad,
  positionalUsage,
  synopsisPart,
} from "../catalog";
import type { ConfigFileError, UsageError } from "../cli-errors";
import type { FlagSet, WireArgs } from "../flags";
import { buildArgs, deriveFlags, flagTypeLabel, flagUsage, withoutFields } from "../flags";
import type { Invocation, ShortcutCommand } from "../invocation";
import { readSecret, stringFlag, usage } from "../invocation";

/**
 * The groups the generator places commands in, in help order (`cliGroups` in
 * `packages/commands`). A group can have no commands yet.
 */
export const coreGroups = ["auth", "admin", "movies", "music"] as const;

/** A generated command's group word. */
export type CoreGroup = (typeof coreGroups)[number];

/** An argument that never travels on the command line, and the variable that supplies it. */
interface Secret {
  readonly field: string;
  readonly variable: string;
}

type Kind = "query" | "mutation" | "action";

/** What the generator writes for one command. */
interface Spec<Args, Result> {
  readonly name: string;
  readonly path: readonly [CoreGroup, ...Array<string>];
  readonly kind: Kind;
  readonly scope: string;
  readonly refusesKeys: boolean;
  readonly summary: string;
  readonly secrets: ReadonlyArray<Secret>;
  /** `paginationOpts` comes from `--limit` and `--cursor`. */
  readonly paginated: boolean;
  readonly args: Schema.Codec<Args, WireArgs>;
  readonly result: Schema.Codec<Result, unknown>;
  /**
   * The SDK method that runs it. Inference unifies `Args` and `Result` across `args`, `result`,
   * and this method, so schemas that disagree with the SDK's fail to compile here.
   */
  readonly method: (
    platform: Platform.Interface,
  ) => (args: Args) => Effect.Effect<Result, Platform.PlatformError>;
}

/** A hand-written command in a core group, with its help line. */
export interface CoreShortcut extends ShortcutCommand {
  readonly group: CoreGroup;
  /** What follows the command's words in its synopsis, such as `[--server <convex-url>]`. */
  readonly usage: string;
  readonly summary: string;
}

/** The hand-written command at `media <group> <words>`. */
export const coreShortcut = (
  group: CoreGroup,
  words: string,
  command: Omit<CoreShortcut, "group" | "path">,
): CoreShortcut => ({ ...command, group, path: `${group} ${words}` });

/** A hand-written command's synopsis, after `media`. */
export const shortcutSynopsis = (command: CoreShortcut): string =>
  command.usage.length === 0 ? command.path : `${command.path} ${command.usage}`;

/** A call ready to run, its arguments already decoded. */
type Call = (platform: Platform.Interface) => Effect.Effect<Schema.Json, Platform.PlatformError>;

/** A generated command as the router, help, and `media commands` see it. */
export interface CoreCommand {
  /** The command list's name, such as `core.accounts.users.list`, which `media call` takes. */
  readonly name: string;
  /** The words after `media`, such as `admin users list`. */
  readonly path: string;
  readonly group: CoreGroup;
  readonly kind: Kind;
  readonly scope: string;
  readonly refusesKeys: boolean;
  readonly summary: string;
  readonly secrets: ReadonlyArray<Secret>;
  readonly paginated: boolean;
  readonly args: Schema.Top;
  readonly result: Schema.Top;
  /** Decodes wire arguments, failing with the schema's issue, into the call that runs them. */
  readonly prepare: (wire: WireArgs) => Effect.Effect<Call, Schema.SchemaError>;
}

/** One generated command; `generated/commands.ts` calls it once per command. */
export const coreCommand = <Args, Result>(spec: Spec<Args, Result>): CoreCommand => {
  const encoded = (result: Result): Effect.Effect<Schema.Json, ProtocolError> =>
    Schema.encodeUnknownEffect(Schema.toCodecJson(spec.result))(result).pipe(
      Effect.mapError(
        (cause) =>
          new ProtocolError({
            operation: spec.name,
            message: `Protocol error in ${spec.name}: the result could not be printed as JSON`,
            cause,
          }),
      ),
    );

  return {
    name: spec.name,
    path: spec.path.join(" "),
    group: spec.path[0],
    kind: spec.kind,
    scope: spec.scope,
    refusesKeys: spec.refusesKeys,
    summary: spec.summary,
    secrets: spec.secrets,
    paginated: spec.paginated,
    args: spec.args,
    result: spec.result,
    prepare: (wire) =>
      Effect.map(
        Schema.decodeEffect(spec.args)(wire, { errors: "all" }),
        (args): Call =>
          (platform) =>
            spec.method(platform)(args).pipe(Effect.flatMap(encoded)),
      ),
  };
};

const DEFAULT_LIMIT = 100;

/** The flags a paginated command takes in place of `--pagination-opts`. */
export const pageOptions: ParseArgsOptionsConfig = {
  limit: { type: "string" },
  cursor: { type: "string" },
};

/** The command's flags: its arguments without its secrets and, when paginated, its page options. */
export const flagsOf = (command: CoreCommand): FlagSet =>
  withoutFields(
    deriveFlags(command.args),
    new Set([
      ...command.secrets.map((secret) => secret.field),
      ...(command.paginated ? ["paginationOpts"] : []),
    ]),
  );

const limitOf = (invocation: Invocation): Effect.Effect<number, UsageError> =>
  Option.match(stringFlag(invocation.tokens, "limit"), {
    onNone: () => Effect.succeed(DEFAULT_LIMIT),
    onSome: (raw) => {
      const limit = Number(raw);

      return Number.isInteger(limit) && limit > 0
        ? Effect.succeed(limit)
        : Effect.fail(usage(invocation, `--limit expects a positive integer, got "${raw}"`));
    },
  });

/**
 * A secret from its variable, or from piped stdin when it is the command's only one: two
 * secrets cannot share stdin.
 */
const secretOf = (
  invocation: Invocation,
  secret: Secret,
  only: boolean,
): Effect.Effect<Redacted.Redacted, UsageError | ConfigFileError> =>
  only
    ? readSecret(invocation, secret.variable, secret.field)
    : Config.Redacted(secret.variable).pipe(
        Effect.mapError(() => usage(invocation, `Set ${secret.variable} to the ${secret.field}`)),
        Effect.filterOrFail(
          (value) => Redacted.value(value).trim().length > 0,
          () => usage(invocation, `${secret.variable} is set but empty`),
        ),
      );

/**
 * The wire arguments of an invocation: flags and `--json` as for any command, then the page from
 * `--limit` and `--cursor` unless `--json` gave one, then each secret from its variable or stdin.
 * A secret inside `--json` is refused: it would sit in shell history like a flag.
 */
export const wireArgsOf = Effect.fn("Core.wireArgs")(function* (
  command: CoreCommand,
  invocation: Invocation,
) {
  const flags = flagsOf(command);
  const given = yield* Effect.fromResult(buildArgs(flags, invocation.tokens, command.path, {}));

  const leaked = command.secrets.find((secret) => given[secret.field] !== undefined);

  if (leaked !== undefined) {
    return yield* usage(
      invocation,
      `Pass ${leaked.field} in ${leaked.variable}${command.secrets.length === 1 ? " or on stdin" : ""}, never on the command line`,
    );
  }

  const page: WireArgs =
    command.paginated && given["paginationOpts"] === undefined
      ? {
          paginationOpts: {
            numItems: yield* limitOf(invocation),
            cursor: Option.getOrNull(stringFlag(invocation.tokens, "cursor")),
          },
        }
      : {};

  const secrets = yield* Effect.forEach(command.secrets, (secret) =>
    Effect.map(
      secretOf(invocation, secret, command.secrets.length === 1),
      (value) => [secret.field, Redacted.value(value)] as const,
    ),
  );

  const wire: WireArgs = Object.fromEntries([
    ...Object.entries(given),
    ...Object.entries(page),
    ...secrets,
  ]);

  return wire;
});

const synopsis = (command: CoreCommand): string => {
  const { flags, positional } = flagsOf(command);

  const parts = flags.map((spec) =>
    spec === positional ? positionalUsage(spec) : synopsisPart(spec),
  );

  const page = command.paginated ? ["[--limit <int>]", "[--cursor <text>]"] : [];

  return ["media", command.path, ...parts, ...page].join(" ");
};

const access = (command: CoreCommand): string =>
  [
    Match.value(command.scope).pipe(
      Match.when("public", () => "no sign-in needed"),
      Match.when("signed-in", () => "any session"),
      Match.orElse((scope) => `scope ${scope}`),
    ),
    ...(command.refusesKeys ? ["API keys refused"] : []),
  ].join(", ");

const secretLine = (command: CoreCommand): ReadonlyArray<string> =>
  command.secrets.length === 0
    ? []
    : [
        `${command.secrets
          .map((secret) => `The ${secret.field} comes from ${secret.variable}`)
          .join("; ")}${command.secrets.length === 1 ? ", or stdin when piped" : ""}.`,
      ];

/** `media admin users create --help`. */
export const commandHelp = (command: CoreCommand): string => {
  const { flags, positional } = flagsOf(command);

  return [
    `Usage: ${synopsis(command)}`,
    "",
    `${command.summary}.`,
    "",
    `Command ${command.name} (${command.kind}, ${access(command)}), on the core server.`,
    ...(positional === null
      ? []
      : [`The ${positionalUsage(positional)} argument fills --${positional.flag}.`]),
    ...secretLine(command),
    "",
    "Flags",
    ...pad([
      ...flags.map((spec) => [flagUsage(spec), flagNote(spec)] as const),
      ...(command.paginated
        ? ([
            ["--limit <int>", `How many to list (default ${String(DEFAULT_LIMIT)})`],
            ["--cursor <text>", "Where to continue: the continueCursor of the previous page"],
          ] as const)
        : []),
      ["--json <object>", "Arguments as one JSON object; flags override its fields"],
    ]),
    "",
    exitCodeLine,
  ].join("\n");
};

/** A generated command's `media commands` entry, with the variables its secrets come from. */
export type CoreCatalogEntry = Omit<CatalogEntry, "group" | "kind"> & {
  readonly group: CoreGroup;
  readonly kind: Kind | "shortcut";
  readonly secrets: ReadonlyArray<Secret>;
};

/** The command's `media commands` entry. */
export const catalogEntry = (command: CoreCommand): CoreCatalogEntry => {
  const { flags, positional } = flagsOf(command);

  return {
    name: command.name,
    command: `media ${command.path}`,
    synopsis: synopsis(command),
    group: command.group,
    kind: command.kind,
    scope: command.scope,
    job: false,
    summary: command.summary,
    positional: positional === null ? null : `--${positional.flag}`,
    flags: [
      ...flags.map((spec) => ({
        flag: `--${spec.flag}`,
        field: spec.key,
        type: flagTypeLabel(spec),
        required: spec.required,
      })),
      ...(command.paginated
        ? [
            { flag: "--limit", field: "paginationOpts.numItems", type: "int", required: false },
            { flag: "--cursor", field: "paginationOpts.cursor", type: "text", required: false },
          ]
        : []),
    ],
    args: argsJsonSchema(command.args),
    secrets: command.secrets,
  };
};
