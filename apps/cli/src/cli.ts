import { commands } from "@media/contracts/commands";
import type { CommandName } from "@media/contracts/commands";
import { JobId } from "@media/contracts/ids";
import { Cause, Data, Effect, Logger, Option, Predicate, References, Result, Schema } from "effect";
import type { Scope } from "effect";

import packageJson from "../package.json" with { type: "json" };
import { accountCommands } from "./account-commands";
import { adminCommands } from "./admin-commands";
import type { RegistryEntry } from "./catalog";
import {
  catalog,
  commandHelp,
  entryNamed,
  exitCodeLine,
  groupHelp,
  groupWords,
  markdownReference,
  rootHelp,
  shortcutHelp,
  shortcuts,
  visibleRegistryEntries,
} from "./catalog";
import type { CliError } from "./cli-errors";
import { ConfigFileError, ExitCode, exitCodeOf, reportOf, UsageError } from "./cli-errors";
import { environment, loadConfig, resolveTarget } from "./config";
import type { ParsedTokens, WireArgs } from "./flags";
import {
  buildArgs,
  describeIssue,
  globalOptions,
  kebabCase,
  optionsFor,
  tokenize,
  waitOptions,
} from "./flags";
import type { Format, Invocation, ShortcutCommand } from "./invocation";
import {
  booleanFlag,
  encodeResult,
  Outcome,
  resultOutcome,
  stringFlag,
  textOutcome,
  timeoutFlag,
} from "./invocation";
import { waitForJob } from "./jobs";
import { Output } from "./output";
import type { Interface as OutputInterface } from "./output";
import { renderResult } from "./render";
import { roomCommands } from "./room-commands";
import { diagnosticsCommands, formatLogLine } from "./diagnostics-commands";
import type { CoreCommand, CoreShortcut } from "./core/command";
import {
  commandHelp as coreCommandHelp,
  flagsOf,
  pageOptions,
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
import { connectCore } from "./core/session";
import { coreGroups } from "./generated/groups";
import { connect, deviceIdFor } from "./session";
import { watchCommands } from "./watch-commands";

const version = packageJson.version;

const shortcutCommands: ReadonlyMap<string, ShortcutCommand> = new Map(
  [
    ...accountCommands,
    ...watchCommands,
    ...roomCommands,
    ...adminCommands,
    ...diagnosticsCommands,
  ].map((command) => [command.path, command]),
);

type Route = Data.TaggedEnum<{
  Root: {};
  Version: {};
  Group: { readonly group: string };
  Registry: { readonly entry: RegistryEntry; readonly rest: ReadonlyArray<string> };
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

const topWords = [
  ...coreGroups,
  ...groupWords,
  ...shortcuts.flatMap((shortcut) => (shortcut.path.includes(" ") ? [] : [shortcut.path])),
];

const suggest = (typed: string): string => {
  const close = topWords
    .filter((candidate) => candidate.startsWith(typed) || typed.startsWith(candidate))
    .slice(0, 3);

  return close.length > 0 ? `; did you mean ${close.join(", ")}?` : "; run media --help";
};

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
  const twoWords = sub === undefined ? undefined : shortcutCommands.get(`${head} ${sub}`);

  if (twoWords !== undefined)
    return Result.succeed(Route.Shortcut({ command: twoWords, rest: restAfter(2) }));
  const oneWord = shortcutCommands.get(head);

  if (oneWord !== undefined)
    return Result.succeed(Route.Shortcut({ command: oneWord, rest: restAfter(1) }));

  if (!groupWords.has(head)) {
    return Result.fail(
      new UsageError({ message: `Unknown command "${rawHead}"${suggest(head)}`, command: null }),
    );
  }

  if (sub === undefined) return Result.succeed(Route.Group({ group: head }));
  const entry = visibleRegistryEntries.find((candidate) => candidate.path === `${head} ${sub}`);

  if (entry === undefined) {
    return Result.fail(
      new UsageError({
        message: `Unknown command "${head} ${sub}"; run media ${head} --help`,
        command: head,
      }),
    );
  }

  return Result.succeed(Route.Registry({ entry, rest: restAfter(2) }));
};

const resolveInGroup = (
  group: string,
  words: ReadonlyArray<string>,
  restAfter: (count: number) => ReadonlyArray<string>,
): Result.Result<Route, UsageError> => {
  const end = words.findIndex((token) => token.startsWith("-"));
  const path = (end === -1 ? words : words.slice(0, end)).map(word);

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

  if (table) return Effect.succeed("table");

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

const prepare = Effect.fn("Cli.prepare")(
  function* (path: string, tokens: ParsedTokens) {
    const env = yield* environment;
    const config = yield* loadConfig(env.configPath);
    const target = resolveTarget(config, env, stringFlag(tokens, "profile"));
    const format = yield* formatOf(tokens, path);
    const invocation: Invocation = { path, tokens, env, target, format };

    return invocation;
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

const decodeJobId = Schema.decodeUnknownOption(Schema.Struct({ jobId: JobId }));

const runNamed = Effect.fn("Cli.runNamed")(function* (
  invocation: Invocation,
  name: CommandName,
  entry: RegistryEntry,
  wire: WireArgs,
) {
  const command = commands[name];

  const args = yield* Schema.decodeEffect(command.args)(wire, { errors: "all" }).pipe(
    Effect.mapError(
      (error) =>
        new UsageError({
          message: describeIssue(entry.flags, error.issue),
          command: invocation.path,
        }),
    ),
  );

  const connection = yield* connect(
    invocation.env,
    invocation.target,
    command.scope === "public" ? "optional" : "required",
  );

  const result = yield* connection.withSession(connection.client.run(name, args));
  const json = yield* encodeResult(name, command, result);
  const jobId = decodeJobId(json);

  if (!booleanFlag(invocation.tokens, "wait") || Option.isNone(jobId)) {
    return resultOutcome(command, json);
  }

  const job = yield* waitForJob(connection.client, jobId.value.jobId, {
    progress: true,
    timeout: yield* timeoutFlag(invocation),
  });

  const jobJson = yield* encodeResult("jobs.get", commands["jobs.get"], job);

  return textOutcome(
    { result: json, job: jobJson },
    [renderResult(command.result, json), renderResult(commands["jobs.get"].result, jobJson)].join(
      "\n",
    ),
  );
});

const runRegistry = Effect.fn("Cli.runRegistry")(function* (
  entry: RegistryEntry,
  rest: ReadonlyArray<string>,
) {
  const output = yield* Output;

  const tokens = yield* tokenize(
    optionsFor(entry.flags, entry.job ? waitOptions : {}),
    rest,
    entry.path,
  );

  if (booleanFlag(tokens, "help")) return yield* output.out(commandHelp(entry));
  const invocation = yield* prepare(entry.path, tokens);

  const defaults: WireArgs = {
    deviceId: deviceIdFor(invocation.target),
    ...Option.match(
      Option.flatMap(invocation.target.stored, (profile) =>
        Option.fromNullishOr(profile.viewingProfileId),
      ),
      { onNone: () => ({}), onSome: (profileId) => ({ profileId }) },
    ),
  };

  const wire = yield* Effect.fromResult(buildArgs(entry.flags, tokens, entry.path, defaults));
  const outcome = yield* runNamed(invocation, entry.name, entry, wire).pipe(verbosity(invocation));

  return yield* print(invocation.format, outcome);
});

const rootText = (): string => rootHelp(version, groupsHelp());

const runShortcut = Effect.fn("Cli.runShortcut")(function* (
  command: ShortcutCommand,
  rest: ReadonlyArray<string>,
  help: () => string,
) {
  const output = yield* Output;
  const tokens = yield* tokenize({ ...globalOptions, ...command.options }, rest, command.path);

  if (booleanFlag(tokens, "help")) return yield* output.out(help());

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

const oldShortcutHelp = (command: ShortcutCommand) => (): string => {
  const shortcut = shortcuts.find((candidate) => candidate.path === command.path);

  return shortcut === undefined ? rootText() : shortcutHelp(shortcut);
};

const coreShortcutHelp = (command: CoreShortcut) => (): string =>
  [`Usage: media ${shortcutSynopsis(command)}`, "", `${command.summary}.`, "", exitCodeLine].join(
    "\n",
  );

const runGenerated = Effect.fn("Cli.runGenerated")(function* (
  command: CoreCommand,
  rest: ReadonlyArray<string>,
) {
  const output = yield* Output;
  const flags = flagsOf(command);

  const tokens = yield* tokenize(
    optionsFor(flags, command.paginated ? pageOptions : {}),
    rest,
    command.path,
  );

  if (booleanFlag(tokens, "help")) return yield* output.out(coreCommandHelp(command));
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
    const connection = yield* connectCore(
      invocation,
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
    HandWritten: ({ command }) => runShortcut(command, rest, coreShortcutHelp(command)),
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

  const entry = entryNamed(name);

  if (entry !== undefined) return yield* runRegistry(entry, [...globals, ...after]);

  const generated = coreCommandNamed(name);

  if (Option.isNone(generated)) {
    return yield* new UsageError({
      message: `Unknown registry command "${name}"; run media commands`,
      command: "call",
    });
  }

  return yield* runGenerated(generated.value, [...globals, ...after]);
});

const runCommands = Effect.fn("Cli.runCommands")(function* (rest: ReadonlyArray<string>) {
  const output = yield* Output;

  const tokens = yield* tokenize(
    { ...globalOptions, markdown: { type: "boolean" } },
    rest,
    "commands",
  );

  if (booleanFlag(tokens, "markdown")) return yield* output.out(markdownReference());
  const format = yield* formatOf(tokens, "commands");

  return yield* output.out(
    format === "json" ? JSON.stringify([...catalog(), ...coreCatalog()], null, 2) : rootText(),
  );
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
      Group: ({ group }) => output.out(groupHelp(group)),
      Registry: ({ entry, rest }) => runRegistry(entry, rest),
      Shortcut: ({ command, rest }) => runShortcut(command, rest, oldShortcutHelp(command)),
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
