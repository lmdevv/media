import { Cause, Data, Effect, Logger, Option, Predicate, References, Result } from "effect";
import type { Scope } from "effect";

import packageJson from "../package.json" with { type: "json" };
import type { CliError } from "./cli-errors";
import { ExitCode, exitCodeOf, reportOf, UsageError } from "./cli-errors";
import { connect, resolveTarget } from "./config";
import type { ParsedTokens } from "./flags";
import { describeIssue, globalOptions, kebabCase, optionsFor, tokenize } from "./flags";
import type { Format, Invocation, ShortcutCommand } from "./invocation";
import { booleanFlag, Outcome, stringFlag } from "./invocation";
import { Output } from "./output";
import type { Interface as OutputInterface } from "./output";
import { renderResult } from "./render";
import { diagnosticsCommands, formatLogLine } from "./diagnostics-commands";
import type { CoreCommand } from "./core/command";
import {
  commandHelp,
  exitCodeLine,
  flagsOf,
  pad,
  pageOptions,
  shortcutHelp,
  shortcutSynopsis,
  wireArgsOf,
} from "./core/command";
import {
  coreCatalog,
  coreCommandNamed,
  CoreEntry,
  groupsHelp,
  isCoreGroup,
  prefixHelp,
  resolveCore,
} from "./core/routes";
import { coreGroups } from "./generated/groups";

const version = packageJson.version;

/** The media server's troubleshooting commands, at the top level beside the groups. */
const troubleshooting: ReadonlyMap<string, ShortcutCommand> = new Map(
  diagnosticsCommands.map((command) => [command.path, command]),
);

type Route = Data.TaggedEnum<{
  Root: {};
  Version: {};
  Shortcut: { readonly command: ShortcutCommand; readonly rest: ReadonlyArray<string> };
  Call: { readonly rest: ReadonlyArray<string> };
  Commands: { readonly rest: ReadonlyArray<string> };
  Core: { readonly entry: CoreEntry; readonly rest: ReadonlyArray<string> };
  CoreHelp: { readonly help: string };
}>;

const Route = Data.taggedEnum<Route>();

const booleanGlobals = new Set(["--human", "--verbose", "--help", "-h", "--version"]);

const valueGlobals = new Set(["--profile", "--format"]);

const splitLeadingGlobals = (argv: ReadonlyArray<string>) => {
  let index = 0;

  while (index < argv.length) {
    const token = argv[index] ?? "";

    if (booleanGlobals.has(token)) index += 1;
    else if (valueGlobals.has(token)) index += 2;
    else if ([...valueGlobals].some((flag) => token.startsWith(`${flag}=`))) index += 1;
    else break;
  }

  return { globals: argv.slice(0, index), words: argv.slice(index) };
};

const word = (text: string): string => kebabCase(text).toLowerCase();

const topWords = [...coreGroups, "logs", "diagnostics", "commands", "call", "help"];

/**
 * The old movies server's top-level words that the port renamed, and the command that does their
 * job now. Words that only moved under a group, such as `titles list`, are found by `movedTo`.
 */
const RENAMED: ReadonlyMap<string, string> = new Map([
  ["login", "auth login"],
  ["logout", "auth logout"],
  ["whoami", "auth sessions current"],
  ["keys", "auth api-keys"],
  ["search", "movies titles search"],
  ["play", "movies stream"],
  ["progress", "movies titles get"],
  ["continue", "movies history continue-watching"],
  ["scan", "auth libraries scan"],
  ["backup", "admin backups run"],
]);

/** Where an old top-level command lives now: under a group, or renamed. */
const movedTo = (path: ReadonlyArray<string>): Option.Option<string> =>
  Option.orElse(Option.fromNullishOr(RENAMED.get(path[0] ?? "")), () =>
    Option.firstSomeOf(
      (["movies", "auth", "admin"] as const).map((group) => {
        const words = [group, ...path];

        return Option.isSome(resolveCore(words)) || Option.isSome(prefixHelp(words))
          ? Option.some(words.join(" "))
          : Option.none();
      }),
    ),
  );

const unknownCommand = (typed: string, path: ReadonlyArray<string>): UsageError =>
  Option.match(movedTo(path), {
    onSome: (moved) =>
      new UsageError({
        message: `Unknown command "${typed}"; it moved: run media ${moved}`,
        command: moved.split(" ")[0] ?? null,
      }),
    onNone: () => {
      const [head = ""] = path;

      const close = topWords
        .filter((candidate) => candidate.startsWith(head) || head.startsWith(candidate))
        .slice(0, 3);

      return new UsageError({
        message: `Unknown command "${typed}"${close.length > 0 ? `; did you mean ${close.join(", ")}?` : ""}`,
        command: null,
      });
    },
  });

/** The leading words before the first flag, as typed. */
const leadingWords = (words: ReadonlyArray<string>): ReadonlyArray<string> => {
  const end = words.findIndex((token) => token.startsWith("-"));

  return end === -1 ? words : words.slice(0, end);
};

/** The leading words before the first flag, in kebab case. */
const pathOf = (words: ReadonlyArray<string>): ReadonlyArray<string> =>
  leadingWords(words).map(word);

const resolve = (argv: ReadonlyArray<string>): Result.Result<Route, UsageError> => {
  const { globals, words } = splitLeadingGlobals(argv);
  const [rawHead, rawSub] = words;

  if (rawHead === undefined) {
    return Result.succeed(globals.includes("--version") ? Route.Version() : Route.Root());
  }

  if (rawHead === "help") return resolve([...words.slice(1), "--help"]);
  const head = word(rawHead);
  const sub = rawSub === undefined || rawSub.startsWith("-") ? undefined : word(rawSub);
  const restAfter = (count: number) => [...globals, ...words.slice(count)];

  if (head === "call") return Result.succeed(Route.Call({ rest: restAfter(1) }));

  if (head === "commands") return Result.succeed(Route.Commands({ rest: restAfter(1) }));

  if (isCoreGroup(head)) return resolveInGroup(head, words, restAfter);
  const twoWords = sub === undefined ? undefined : troubleshooting.get(`${head} ${sub}`);

  if (twoWords !== undefined)
    return Result.succeed(Route.Shortcut({ command: twoWords, rest: restAfter(2) }));
  const oneWord = troubleshooting.get(head);

  if (oneWord !== undefined)
    return Result.succeed(Route.Shortcut({ command: oneWord, rest: restAfter(1) }));

  if (head === "diagnostics") {
    return sub === undefined
      ? Result.succeed(Route.CoreHelp({ help: diagnosticsHelp() }))
      : Result.fail(
          new UsageError({
            message: `Unknown command "${leadingWords(words).join(" ")}"`,
            command: "diagnostics",
          }),
        );
  }

  const typed = leadingWords(words);

  return Result.fail(
    typed.length === 0
      ? new UsageError({ message: `Unknown command "${rawHead}"`, command: null })
      : unknownCommand(typed.join(" "), pathOf(words)),
  );
};

const resolveInGroup = (
  group: string,
  words: ReadonlyArray<string>,
  restAfter: (count: number) => ReadonlyArray<string>,
): Result.Result<Route, UsageError> => {
  const path = pathOf(words);

  return Option.match(resolveCore(path), {
    onSome: ({ entry, taken }) => Result.succeed(Route.Core({ entry, rest: restAfter(taken) })),
    onNone: () =>
      Option.match(prefixHelp(path), {
        onSome: (help) => Result.succeed(Route.CoreHelp({ help })),
        onNone: () =>
          Result.fail(
            new UsageError({
              message: `Unknown command "${path.join(" ")}"; run media ${group} --help`,
              command: group,
            }),
          ),
      }),
  });
};

const formatOf = (tokens: ParsedTokens, command: string): Effect.Effect<Format, UsageError> => {
  const table =
    booleanFlag(tokens, "human") || Option.contains(stringFlag(tokens, "format"), "table");

  if (booleanFlag(tokens, "json")) {
    return table
      ? Effect.fail(
          new UsageError({
            message: "--json asks for JSON and --human or --format table for tables: pass one",
            command,
          }),
        )
      : Effect.succeed("json");
  }

  if (table) {
    return Option.contains(stringFlag(tokens, "format"), "json")
      ? Effect.fail(
          new UsageError({
            message: "--json or --format json asks for JSON and --human for tables: pass one",
            command,
          }),
        )
      : Effect.succeed("table");
  }

  return Option.match(stringFlag(tokens, "format"), {
    onNone: () => Effect.succeed<Format>("json"),
    onSome: (format) =>
      format === "json" || format === "table"
        ? Effect.succeed<Format>(format)
        : Effect.fail(
            new UsageError({ message: `--format must be json or table, got "${format}"`, command }),
          ),
  });
};

const rawFormat = (argv: ReadonlyArray<string>): Format =>
  argv.includes("--human") ||
  argv.includes("--format=table") ||
  argv.join(" ").includes("--format table")
    ? "table"
    : "json";

const prepare = Effect.fn("Cli.prepare")(function* (path: string, tokens: ParsedTokens) {
  const target = yield* resolveTarget(stringFlag(tokens, "profile"));
  const format = yield* formatOf(tokens, path);
  const invocation: Invocation = { path, tokens, target, format };

  return invocation;
});

const verbosity =
  (invocation: Invocation) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    booleanFlag(invocation.tokens, "verbose")
      ? Effect.provideService(effect, References.MinimumLogLevel, "Debug")
      : effect;

const print = (format: Format, outcome: Outcome): Effect.Effect<void, never, Output> =>
  Effect.flatMap(Output, (output) =>
    Outcome.$match(outcome, {
      Result: ({ json, human }) =>
        output.out(format === "json" ? JSON.stringify(json, null, 2) : human),
      Printed: () => Effect.void,
    }),
  );

/**
 * One row per troubleshooting command: its words with a required argument, and the first clause
 * of its summary. Each command's `--help` has the rest.
 */
const troubleshootingRows = (): ReadonlyArray<readonly [string, string]> =>
  diagnosticsCommands.map((command) => {
    const [first = ""] = command.usage.split(" ");
    const argument = first.startsWith("<") ? first : "[flags]";

    return [
      `media ${command.path} ${argument}`,
      command.summary.split(/[;:]/u)[0] ?? command.summary,
    ] as const;
  });

const diagnosticsHelp = (): string =>
  [
    "Usage: media diagnostics <command> [flags]",
    "",
    ...pad(troubleshootingRows().filter(([synopsis]) => synopsis.startsWith("media diagnostics"))),
  ].join("\n");

const rootText = (): string =>
  [
    `media ${version}: the [media] command line. Everything the apps can do, for people and agents.`,
    "",
    "Usage: media <group> <command> [flags]",
    "",
    ...groupsHelp(),
    "",
    "Troubleshooting the media server",
    ...pad(troubleshootingRows()),
    "",
    "Reference",
    ...pad([
      ["media commands", "List every command with its flags and argument JSON Schema"],
      [
        "media call <command-name> [--json <object>]",
        "Run any command by its name, such as movies.titles.list",
      ],
    ]),
    "",
    "Global flags",
    ...pad([
      ["--format json|table", "Output format; JSON (the default) for agents, tables for people"],
      ["--human", "Same as --format table"],
      ["--profile <name>", "Use another stored profile (or set MEDIA_PROFILE)"],
      ["--verbose", "Print debug logs on stderr too, not only warnings and errors"],
      ["-h, --help", "Show help for any command"],
      ["--version", "Print the version"],
    ]),
    "",
    exitCodeLine,
    'Output is JSON on stdout; errors are {"error":{"code","message"}} on stderr, with "requestId"',
    "when the media service answered: media logs --grep <request-id> finds its records.",
  ].join("\n");

const runShortcut = Effect.fn("Cli.runShortcut")(function* (
  command: ShortcutCommand,
  rest: ReadonlyArray<string>,
) {
  const output = yield* Output;
  const tokens = yield* tokenize({ ...globalOptions, ...command.options }, rest, command.path);

  if (booleanFlag(tokens, "help")) {
    return yield* output.out(shortcutHelp(shortcutSynopsis(command), command.summary));
  }

  if (!command.positionals && tokens.positionals.length > 0) {
    return yield* new UsageError({
      message: `Unexpected argument "${tokens.positionals.join(" ")}"`,
      command: command.path,
    });
  }

  const invocation = yield* prepare(command.path, tokens);

  return yield* print(
    invocation.format,
    yield* command.run(invocation).pipe(verbosity(invocation)),
  );
});

/**
 * A generated command's `--json` takes its arguments as an object. Given bare, at the end or
 * before another flag, it asks for JSON output, as it does for every other command.
 */
const bareJsonAsFormat = (rest: ReadonlyArray<string>): ReadonlyArray<string> =>
  rest.map((token, index) => {
    const next = rest[index + 1];

    return token === "--json" && (next === undefined || next.startsWith("-"))
      ? "--format=json"
      : token;
  });

const runGenerated = Effect.fn("Cli.runGenerated")(function* (
  command: CoreCommand,
  rest: ReadonlyArray<string>,
) {
  const output = yield* Output;
  const flags = flagsOf(command);

  const tokens = yield* tokenize(
    optionsFor(flags, command.paginated ? pageOptions : {}),
    bareJsonAsFormat(rest),
    command.path,
  );

  if (booleanFlag(tokens, "help")) return yield* output.out(commandHelp(command));
  const invocation = yield* prepare(command.path, tokens);
  const wire = yield* wireArgsOf(command, invocation);

  const call = yield* command
    .prepare(wire)
    .pipe(
      Effect.mapError(
        (error) =>
          new UsageError({ message: describeIssue(flags, error.issue), command: command.path }),
      ),
    );

  const outcome = yield* Effect.gen(function* () {
    const connection = yield* connect(
      invocation.target,
      command.scope === "public" ? "optional" : "required",
    );

    const json = yield* connection.signedIn(call(connection.platform));

    return Outcome.Result({ json, human: renderResult(command.result, json) });
  }).pipe(verbosity(invocation));

  return yield* print(invocation.format, outcome);
});

const runCore = (entry: CoreEntry, rest: ReadonlyArray<string>) =>
  CoreEntry.$match(entry, {
    Generated: ({ command }) => runGenerated(command, rest),
    HandWritten: ({ command }) => runShortcut(command, rest),
  });

const runCall = Effect.fn("Cli.runCall")(function* (rest: ReadonlyArray<string>) {
  const output = yield* Output;
  const { globals, words } = splitLeadingGlobals(rest);
  const [name, ...after] = words;

  if (name === undefined || name.startsWith("-")) {
    return yield* output.out(
      "Usage: media call <command-name> [--json <object>]\n\nRun media commands for every name.",
    );
  }

  const generated = coreCommandNamed(name);

  if (Option.isNone(generated)) {
    return yield* new UsageError({
      message: `Unknown command name "${name}"; run media commands`,
      command: "call",
    });
  }

  return yield* runGenerated(generated.value, [...globals, ...after]);
});

const runCommands = Effect.fn("Cli.runCommands")(function* (rest: ReadonlyArray<string>) {
  const output = yield* Output;
  const tokens = yield* tokenize(globalOptions, rest, "commands");
  const format = yield* formatOf(tokens, "commands");

  return yield* output.out(format === "json" ? JSON.stringify(coreCatalog(), null, 2) : rootText());
});

const program = (
  argv: ReadonlyArray<string>,
): Effect.Effect<void, CliError, Output | Scope.Scope> =>
  Effect.gen(function* () {
    const output = yield* Output;
    const route = yield* Effect.fromResult(resolve(argv));

    yield* Route.$match(route, {
      Root: () => output.out(rootText()),
      Version: () => output.out(version),
      Shortcut: ({ command, rest }) => runShortcut(command, rest),
      Call: ({ rest }) => runCall(rest),
      Commands: ({ rest }) => runCommands(rest),
      Core: ({ entry, rest }) => runCore(entry, rest),
      CoreHelp: ({ help }) => output.out(help),
    });
  });

const reportError = (error: CliError, format: Format): Effect.Effect<void, never, Output> =>
  Effect.gen(function* () {
    const output = yield* Output;
    const report = reportOf(error);

    if (format === "json") {
      yield* output.err(JSON.stringify({ error: report }));

      return;
    }

    yield* output.err(`media: ${report.message}`);

    if (report.requestId !== undefined) yield* output.err(`Request ID: ${report.requestId}`);

    if (Predicate.isTagged(error, "UsageError")) {
      yield* output.err(
        error.command === null ? "Run media --help." : `Run media ${error.command} --help.`,
      );
    }
  });

const stderrLogger = (output: OutputInterface, format: Format): Logger.Logger<unknown, void> =>
  Logger.map(Logger.formatJson, (line) =>
    Effect.runSync(output.err(format === "json" ? line : formatLogLine(line))),
  );

/**
 * Runs one invocation and returns the process exit code. Never fails. Logs go to stderr instead of
 * Effect's default console logger, one JSON record per line unless the output is for people:
 * warnings and worse, and debug records too with `--verbose`.
 */
export const runCli = (argv: ReadonlyArray<string>): Effect.Effect<number, never, Output> =>
  Effect.flatMap(Output, (output) => {
    const format = rawFormat(argv);

    return Effect.scoped(program(argv)).pipe(
      Effect.as<number>(ExitCode.ok),
      Effect.catch((error) => Effect.as(reportError(error, format), exitCodeOf(error))),
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const message = `Internal error: ${Cause.pretty(cause)}`;

          yield* format === "json"
            ? output.err(JSON.stringify({ error: { code: "internal", message } }))
            : output.err(`media: ${message}`);

          return ExitCode.failed;
        }),
      ),
      Effect.provideService(References.CurrentLoggers, new Set([stderrLogger(output, format)])),
      Effect.provideService(References.MinimumLogLevel, "Warn"),
    );
  });
