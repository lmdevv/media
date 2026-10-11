/**
 * Turns a registry command's `args` schema into command-line flags and turns parsed flags back
 * into wire arguments. Flags are derived from the schema AST at runtime, so a field added to the
 * registry shows up in the CLI without touching this package.
 */
import type { ParseArgsOptionDescriptor, ParseArgsOptionsConfig } from "node:util";
import { parseArgs } from "node:util";

import { Data, Effect, Predicate, Result, Schema, SchemaAST, SchemaIssue } from "effect";

import { UsageError } from "./errors";

/** The value a flag accepts. `Json` covers schema fields no simpler flag type can express. */
export type FlagType = Data.TaggedEnum<{
  Text: {};
  Number: { readonly integer: boolean };
  Boolean: {};
  Choice: { readonly choices: ReadonlyArray<string> };
  List: { readonly item: FlagType };
  Json: {};
}>;

export const FlagType = Data.taggedEnum<FlagType>();

/** One flag derived from one field of a command's `args` struct. */
export interface FlagSpec {
  /** The schema field, such as `trackIds`. */
  readonly key: string;
  /** The flag name without dashes, such as `track-ids`. */
  readonly flag: string;
  readonly type: FlagType;
  readonly required: boolean;
}

/** The flags of a command plus the field, if any, that may be given as positional arguments. */
export interface FlagSet {
  readonly flags: ReadonlyArray<FlagSpec>;
  readonly positional: FlagSpec | null;
}

/** Wire arguments: the encoded side of a command's `args` schema. */
export type WireArgs = Schema.JsonObject;

const intRepresentation = "effect/schema/isInt";

const hasIntCheck = (checks: ReadonlyArray<SchemaAST.Check<never>> | undefined): boolean =>
  checks?.some((check) =>
    Predicate.isTagged(check, "Filter")
      ? check.annotations?.representation?.id === intRepresentation
      : hasIntCheck(check.checks),
  ) ?? false;

const stringLiteral = (ast: SchemaAST.AST): string | null =>
  SchemaAST.isLiteral(ast) && Predicate.isString(ast.literal) ? ast.literal : null;

const choicesOf = (members: ReadonlyArray<SchemaAST.AST>): ReadonlyArray<string> | null => {
  const choices = members.map(stringLiteral);

  return choices.every(Predicate.isNotNull) && choices.length > 0 ? choices : null;
};

const flagTypeOf = (ast: SchemaAST.AST): FlagType => {
  if (SchemaAST.isString(ast)) return FlagType.Text();

  if (SchemaAST.isNumber(ast)) return FlagType.Number({ integer: hasIntCheck(ast.checks) });

  if (SchemaAST.isBoolean(ast)) return FlagType.Boolean();

  const literal = stringLiteral(ast);

  if (literal !== null) return FlagType.Choice({ choices: [literal] });

  if (SchemaAST.isUnion(ast)) {
    const members = ast.types.filter((member) => !SchemaAST.isNull(member));
    const choices = choicesOf(members);

    if (choices !== null) return FlagType.Choice({ choices });

    const [only] = members;

    // `NullOr(X)` takes X on the command line; null is only reachable through `--args`.
    if (members.length === 1 && only !== undefined) return flagTypeOf(only);
  }

  if (SchemaAST.isArrays(ast) && ast.elements.length === 0) {
    const [item] = ast.rest;

    if (item !== undefined && ast.rest.length === 1) {
      const itemType = flagTypeOf(item);

      if (FlagType.$is("Text")(itemType) || FlagType.$is("Number")(itemType)) {
        return FlagType.List({ item: itemType });
      }

      if (FlagType.$is("Choice")(itemType)) return FlagType.List({ item: itemType });
    }
  }

  return FlagType.Json();
};

/** `trackIds` → `track-ids`. */
export const kebabCase = (key: string): string =>
  key.replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);

/** Derives one flag per field of an `args` struct schema. */
export const deriveFlags = (args: Schema.Top): FlagSet => {
  const ast = SchemaAST.toEncoded(args.ast);

  if (!SchemaAST.isObjects(ast)) return { flags: [], positional: null };

  const flags = ast.propertySignatures.map((property): FlagSpec => ({
    key: String(property.name),
    flag: kebabCase(String(property.name)),
    type: flagTypeOf(property.type),
    required: !SchemaAST.isOptional(property.type),
  }));

  const positionalCandidates = flags.filter(
    (spec) =>
      spec.required && !FlagType.$is("Boolean")(spec.type) && !FlagType.$is("Json")(spec.type),
  );

  const [positional] = positionalCandidates;

  return {
    flags,
    positional: positionalCandidates.length === 1 && positional !== undefined ? positional : null,
  };
};

/** Fields named `fooId` or `fooIds` hold opaque IDs from earlier results. */
const isIdField = (key: string): boolean => /Ids?$/u.test(key);

/** How a flag reads in help: `--limit <int>`, `--playlist-id <id>`. */
export const flagUsage = (spec: FlagSpec): string =>
  FlagType.$match(spec.type, {
    Text: () => `--${spec.flag} <${isIdField(spec.key) ? "id" : "text"}>`,
    Number: ({ integer }) => `--${spec.flag} <${integer ? "int" : "number"}>`,
    Boolean: () => `--${spec.flag} | --no-${spec.flag}`,
    Choice: ({ choices }) => `--${spec.flag} <${choices.join("|")}>`,
    List: ({ item }) =>
      `--${spec.flag} <${isIdField(spec.key) && FlagType.$is("Text")(item) ? "id" : itemLabel(item)},...>`,
    Json: () => `--${spec.flag} <json>`,
  });

const itemLabel = (item: FlagType): string =>
  FlagType.$match(item, {
    Text: () => "text",
    Number: ({ integer }) => (integer ? "int" : "number"),
    Boolean: () => "bool",
    Choice: ({ choices }) => choices.join("|"),
    List: () => "list",
    Json: () => "json",
  });

/** A short type label for `music commands --json`. */
export const flagTypeLabel = (spec: FlagSpec): string =>
  FlagType.$match(spec.type, {
    Text: () => (isIdField(spec.key) ? "id" : "text"),
    Number: ({ integer }) => (integer ? "int" : "number"),
    Boolean: () => "boolean",
    Choice: ({ choices }) => choices.join(" | "),
    List: ({ item }) =>
      `list of ${isIdField(spec.key) && FlagType.$is("Text")(item) ? "id" : itemLabel(item)}`,
    Json: () => "json",
  });

/** `node:util.parseArgs` output for a dynamic option table. */
type ParsedValues = ReturnType<typeof parseArgs>["values"];

/** The tokens of one invocation after the command path. */
export interface ParsedTokens {
  readonly values: ParsedValues;
  readonly positionals: ReadonlyArray<string>;
}

const cleanParseMessage = (message: string): string => {
  const [first] = message.split(". To specify a positional argument");

  return first ?? message;
};

/** Tokenizes argv against an option table, failing with a usage error for unknown flags. */
export const tokenize = (
  options: ParseArgsOptionsConfig,
  argv: ReadonlyArray<string>,
  command: string,
): Effect.Effect<ParsedTokens, UsageError> =>
  Effect.try({
    try: () => {
      const parsed = parseArgs({
        args: [...argv],
        options,
        strict: true,
        allowPositionals: true,
        allowNegative: true,
      });

      return { values: parsed.values, positionals: parsed.positionals };
    },
    catch: (cause) =>
      new UsageError({
        message: cleanParseMessage(cause instanceof Error ? cause.message : String(cause)),
        command,
      }),
  });

/** The option table for a command's derived flags plus the common flags. */
export const optionsFor = (set: FlagSet, extra: ParseArgsOptionsConfig): ParseArgsOptionsConfig => {
  const options: ParseArgsOptionsConfig = {
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    args: { type: "string" },
    ...extra,
  };

  for (const spec of set.flags) options[spec.flag] = optionFor(spec.type);

  return options;
};

const stringOption: ParseArgsOptionDescriptor = { type: "string" };

const booleanOption: ParseArgsOptionDescriptor = { type: "boolean" };

const listOption: ParseArgsOptionDescriptor = { type: "string", multiple: true };

const optionFor = (type: FlagType): ParseArgsOptionDescriptor =>
  FlagType.$match(type, {
    Text: () => stringOption,
    Number: () => stringOption,
    Boolean: () => booleanOption,
    Choice: () => stringOption,
    List: () => listOption,
    Json: () => stringOption,
  });

const decodeJsonObject = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.JsonObject));

const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Json));

const convertScalar = (
  spec: FlagSpec,
  type: FlagType,
  raw: string,
  command: string,
): Result.Result<Schema.Json, UsageError> =>
  FlagType.$match(type, {
    Text: () => Result.succeed(raw),
    Number: ({ integer }) => {
      const value = Number(raw.trim());

      if (raw.trim().length === 0 || !Number.isFinite(value)) {
        return Result.fail(
          new UsageError({
            message: `--${spec.flag} expects ${integer ? "an integer" : "a number"}, got "${raw}"`,
            command,
          }),
        );
      }

      return Result.succeed(value);
    },
    Boolean: () => Result.succeed(raw === "true"),
    Choice: ({ choices }) =>
      choices.includes(raw)
        ? Result.succeed(raw)
        : Result.fail(
            new UsageError({
              message: `--${spec.flag} must be one of ${choices.join(", ")}; got "${raw}"`,
              command,
            }),
          ),
    List: () => Result.succeed(raw),
    Json: () =>
      Result.mapError(
        decodeJson(raw),
        () => new UsageError({ message: `--${spec.flag} expects JSON, got ${raw}`, command }),
      ),
  });

const convertList = (
  spec: FlagSpec,
  item: FlagType,
  raws: ReadonlyArray<string>,
  command: string,
): Result.Result<Schema.Json, UsageError> => {
  const parts = raws.flatMap((raw) =>
    raw
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );

  return Result.all(parts.map((part) => convertScalar(spec, item, part, command)));
};

const rawStrings = (value: ParsedValues[string]): ReadonlyArray<string> => {
  if (value === undefined) return [];

  if (Predicate.isString(value)) return [value];

  if (Predicate.isBoolean(value)) return [];

  return value.filter(Predicate.isString);
};

/** Converts one flag's parsed value, or `undefined` when the flag was not given. */
const convertFlag = (
  spec: FlagSpec,
  value: ParsedValues[string],
  command: string,
): Result.Result<Schema.Json | undefined, UsageError> => {
  if (value === undefined) return Result.succeed(undefined);

  if (FlagType.$is("Boolean")(spec.type)) {
    return Result.succeed(Predicate.isBoolean(value) ? value : true);
  }

  const raws = rawStrings(value);

  if (FlagType.$is("List")(spec.type)) return convertList(spec, spec.type.item, raws, command);

  const [raw] = raws;

  return raw === undefined
    ? Result.succeed(undefined)
    : convertScalar(spec, spec.type, raw, command);
};

const assignPositionals = (
  set: FlagSet,
  positionals: ReadonlyArray<string>,
  command: string,
): Result.Result<Readonly<Record<string, Schema.Json>>, UsageError> => {
  if (positionals.length === 0) return Result.succeed({});

  const spec = set.positional;

  if (spec === null) {
    return Result.fail(
      new UsageError({
        message: `Unexpected argument "${positionals.join(" ")}"; pass values with flags`,
        command,
      }),
    );
  }

  const converted = FlagType.$match(spec.type, {
    List: ({ item }) => convertList(spec, item, positionals, command),
    // Free text such as a search query may span several shell words.
    Text: () => Result.succeed<Schema.Json>(positionals.join(" ")),
    Number: () => single(spec, positionals, command),
    Choice: () => single(spec, positionals, command),
    Boolean: () => single(spec, positionals, command),
    Json: () => single(spec, positionals, command),
  });

  return Result.map(converted, (value) => ({ [spec.key]: value }));
};

const single = (
  spec: FlagSpec,
  positionals: ReadonlyArray<string>,
  command: string,
): Result.Result<Schema.Json, UsageError> => {
  const [raw] = positionals;

  if (raw === undefined || positionals.length > 1) {
    return Result.fail(
      new UsageError({ message: `Expected one value for --${spec.flag}`, command }),
    );
  }

  return convertScalar(spec, spec.type, raw, command);
};

/**
 * Builds wire arguments from parsed tokens: `--args` JSON first, then the positional value, then
 * explicit flags, each overriding the last.
 */
export const buildArgs = (
  set: FlagSet,
  tokens: ParsedTokens,
  command: string,
): Result.Result<WireArgs, UsageError> =>
  Result.gen(function* () {
    const raw = tokens.values["args"];

    const base: WireArgs = Predicate.isString(raw)
      ? yield* Result.mapError(
          decodeJsonObject(raw),
          () => new UsageError({ message: "--args expects a JSON object", command }),
        )
      : {};

    const fromPositionals = yield* assignPositionals(set, tokens.positionals, command);

    const fromFlags = yield* Result.all(
      set.flags.map((spec) =>
        Result.map(convertFlag(spec, tokens.values[spec.flag], command), (value) =>
          value === undefined ? [] : [[spec.key, value] as const],
        ),
      ),
    );

    const args: WireArgs = Object.fromEntries([
      ...Object.entries(base),
      ...Object.entries(fromPositionals),
      ...fromFlags.flat(),
    ]);

    for (const spec of set.flags) {
      if (spec.required && args[spec.key] === undefined) {
        const how = FlagType.$is("Boolean")(spec.type)
          ? `--${spec.flag} or --no-${spec.flag}`
          : `--${spec.flag}`;

        return yield* Result.fail(new UsageError({ message: `Missing ${how}`, command }));
      }
    }

    return args;
  });

const formatter = SchemaIssue.makeFormatterStandardSchemaV1();

const keyText = (segment: PropertyKey | { readonly key: PropertyKey }): string => {
  const key = Predicate.isObject(segment) ? segment.key : segment;

  return Predicate.isSymbol(key) ? (key.description ?? "symbol") : key.toString();
};

/**
 * Renders a schema failure with flag names instead of field paths:
 * `--name: Expected a value with a length of at least 1`.
 */
export const describeIssue = (set: FlagSet, issue: SchemaIssue.Issue): string =>
  formatter(issue)
    .issues.map(({ path, message }) => {
      const segments = (path ?? []).map(keyText);
      const [first, ...rest] = segments;
      const spec = set.flags.find((candidate) => candidate.key === first);

      const where =
        spec === undefined
          ? segments.length === 0
            ? "arguments"
            : segments.join(".")
          : `--${spec.flag}${rest.length > 0 ? `[${rest.join(".")}]` : ""}`;

      return `${where}: ${message}`;
    })
    .join("\n");
