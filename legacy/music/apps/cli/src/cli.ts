/**
 * The `music` entry point: resolves argv to a registry or built-in command, runs it, prints the
 * result, and turns every failure into stderr output and an exit code.
 */
import type { ParseArgsOptionsConfig } from "node:util";

import { DeviceId, JobId } from "@music/commands/ids";
import { Job } from "@music/commands/models";
import { commands } from "@music/commands/registry";
import { Cause, Data, Duration, Effect, Option, Predicate, Redacted, Result, Schema } from "effect";

import packageJson from "../package.json" with { type: "json" };
import type { Api } from "./api";
import { connect, invoke, signIn, validateArgs } from "./api";
import type { RegistryEntry } from "./catalog";
import {
  builtins,
  catalog,
  commandHelp,
  groupHelp,
  groupWords,
  markdownReference,
  registryEntries,
  rootHelp,
} from "./catalog";
import type { Environment } from "./config";
import {
  cleartextError,
  clearAll,
  environment,
  loadCredentials,
  normalizeServer,
  saveCredentials,
  saveSession,
  sendsKeyInCleartext,
  ServerUrl,
} from "./config";
import type { CliError } from "./errors";
import { ConfigFileError, ExitCode, exitCodeOf, reportOf, UsageError } from "./errors";
import { escapeControlCharacters } from "./escape";
import type { ParsedTokens } from "./flags";
import { buildArgs, optionsFor, tokenize } from "./flags";
import { Input } from "./input";
import { waitForJob } from "./jobs";
import { Output } from "./output";
import { renderResult } from "./render";
import { now, play } from "./shortcuts";

const version = packageJson.version;

/** Where argv leads. */
type Route = Data.TaggedEnum<{
  Root: {};
  Version: {};
  Group: { readonly group: string };
  Registry: { readonly entry: RegistryEntry; readonly rest: ReadonlyArray<string> };
  Builtin: { readonly name: string; readonly rest: ReadonlyArray<string> };
}>;

const Route = Data.taggedEnum<Route>();

const leadingGlobals = new Set(["--json", "--help", "-h", "--version"]);

const builtinNames = new Set(builtins.map((builtin) => builtin.name));

const topWords = [
  ...builtinNames,
  ...groupWords,
  ...registryEntries.flatMap((entry) => (entry.path.includes(" ") ? [] : [entry.path])),
];

/** Suggests commands that extend the typed word or that the word extends: `playlist` → `playlists`. */
const suggest = (word: string): string => {
  const close = topWords
    .filter((candidate) => candidate.startsWith(word) || word.startsWith(candidate))
    .slice(0, 3);

  return close.length > 0 ? `; did you mean ${close.join(", ")}?` : "; run music --help";
};

/** Resolves the command path, keeping leading global flags for the command's own parser. */
const resolve = (argv: ReadonlyArray<string>): Result.Result<Route, UsageError> => {
  const firstWord = argv.findIndex((token) => !leadingGlobals.has(token));
  const globals = firstWord === -1 ? argv : argv.slice(0, firstWord);

  const words = argv.slice(globals.length);
  const [head, sub, ...after] = words;

  if (head === undefined) {
    return Result.succeed(argv.includes("--version") ? Route.Version() : Route.Root());
  }

  if (head === "help") return resolve([...words.slice(1), "--help"]);

  if (builtinNames.has(head)) {
    return Result.succeed(Route.Builtin({ name: head, rest: [...globals, ...words.slice(1)] }));
  }

  const single = registryEntries.find((entry) => entry.path === head);

  if (single !== undefined) {
    return Result.succeed(Route.Registry({ entry: single, rest: [...globals, ...words.slice(1)] }));
  }

  if (!groupWords.has(head)) {
    return Result.fail(
      new UsageError({ message: `Unknown command "${head}"${suggest(head)}`, command: null }),
    );
  }

  if (sub === undefined || sub.startsWith("-")) return Result.succeed(Route.Group({ group: head }));

  const entry = registryEntries.find((candidate) => candidate.path === `${head} ${sub}`);

  if (entry === undefined) {
    return Result.fail(
      new UsageError({
        message: `Unknown command "${head} ${sub}"; run music ${head} --help`,
        command: head,
      }),
    );
  }

  return Result.succeed(Route.Registry({ entry, rest: [...globals, ...after] }));
};

const readEnvironment: Effect.Effect<Environment, ConfigFileError> = environment.pipe(
  Effect.mapError(
    (cause) =>
      new ConfigFileError({
        path: "environment",
        message: "Could not read the environment",
        cause,
      }),
  ),
);

const session = Effect.fn("Cli.session")(function* () {
  const env = yield* readEnvironment;
  const credentials = yield* loadCredentials(env);

  return yield* connect(credentials, env.paths);
});

const printJson = (value: Schema.Json): Effect.Effect<void, never, Output> =>
  Effect.gen(function* () {
    const output = yield* Output;

    yield* output.out(JSON.stringify(value, null, 2));
  });

const isTrue = (tokens: ParsedTokens, name: string): boolean => tokens.values[name] === true;

const stringFlag = (tokens: ParsedTokens, name: string): Option.Option<string> => {
  const value = tokens.values[name];

  return Predicate.isString(value) ? Option.some(value) : Option.none();
};

const commonOptions: ParseArgsOptionsConfig = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

const decodeJobId = Schema.decodeUnknownOption(Schema.Struct({ jobId: JobId }));

const decodeTimeout = (
  raw: string,
  usage: string,
): Effect.Effect<Duration.Duration, UsageError> => {
  const seconds = Number(raw);

  return Number.isFinite(seconds) && seconds > 0
    ? Effect.succeed(Duration.seconds(seconds))
    : Effect.fail(
        new UsageError({ message: `--timeout expects seconds, got "${raw}"`, command: usage }),
      );
};

const encodeJob = Schema.encodeSync(Job);

const runRegistry = Effect.fn("Cli.runRegistry")(function* (
  entry: RegistryEntry,
  rest: ReadonlyArray<string>,
) {
  const output = yield* Output;
  const command = commands[entry.name];

  const jobOptions: ParseArgsOptionsConfig = command.job
    ? { wait: { type: "boolean" }, timeout: { type: "string" } }
    : {};

  const tokens = yield* tokenize(optionsFor(entry.flags, jobOptions), rest, entry.path);

  if (isTrue(tokens, "help")) return yield* output.out(commandHelp(entry));

  const json = isTrue(tokens, "json");
  const args = yield* Effect.fromResult(buildArgs(entry.flags, tokens, entry.path));

  const timeout = yield* Option.match(stringFlag(tokens, "timeout"), {
    onNone: () => Effect.succeed(Duration.hours(1)),
    onSome: (raw) => decodeTimeout(raw, entry.path),
  });

  // Validate before connecting so a bad command line fails fast, offline, with exit code 2.
  yield* Effect.fromResult(validateArgs(entry.name, args, entry.path));

  const api = yield* session();
  const result = yield* invoke(api, entry.name, args, entry.path);
  const jobId = decodeJobId(result);

  if (!isTrue(tokens, "wait") || Option.isNone(jobId)) {
    return yield* json ? printJson(result) : output.out(renderResult(command.result, result));
  }

  const job = yield* waitForJob(api, jobId.value.jobId, { quiet: json, timeout });

  if (json) return yield* printJson({ result, job: encodeJob(job) });

  yield* output.out(renderResult(command.result, result));

  return yield* output.out(renderResult(Job, encodeJob(job)));
});

const nonBlank = (key: Redacted.Redacted): Option.Option<Redacted.Redacted> => {
  const trimmed = Redacted.value(key).trim();

  return trimmed.length > 0 ? Option.some(Redacted.make(trimmed)) : Option.none();
};

const missingKey = (message: string): UsageError => new UsageError({ message, command: "login" });

/**
 * The key `music login` verifies, from the first source given: `--key-stdin`, `--key`,
 * `MUSIC_API_KEY`, or a prompt when a person is at the terminal. `--key` lands in shell history
 * and the process list, so the others are what the docs recommend.
 */
const loginKey = Effect.fn("Cli.loginKey")(function* (tokens: ParsedTokens, env: Environment) {
  const input = yield* Input;
  const flag = stringFlag(tokens, "key");

  if (isTrue(tokens, "key-stdin")) {
    if (Option.isSome(flag)) return yield* missingKey("Use --key or --key-stdin, not both");

    // Nothing is piped when stdin is the terminal: reading it to its end would echo the key and
    // wait for Ctrl-D, so ask with the hidden prompt instead.
    const piped = nonBlank(
      yield* (yield* input.interactive) ? input.promptSecret("API key: ") : input.readAll,
    );

    if (Option.isNone(piped)) return yield* missingKey("--key-stdin read no key from stdin");

    return piped.value;
  }

  if (Option.isSome(flag)) {
    const typed = nonBlank(Redacted.make(flag.value));

    if (Option.isNone(typed)) return yield* missingKey("--key is empty");

    return typed.value;
  }

  // Already trimmed, and absent when blank.
  if (Option.isSome(env.key)) return env.key.value;

  if (!(yield* input.interactive)) {
    return yield* missingKey(
      "login needs an API key: pipe it to --key-stdin, or set MUSIC_API_KEY",
    );
  }

  const typed = nonBlank(yield* input.promptSecret("API key: "));

  if (Option.isNone(typed)) return yield* missingKey("No API key entered");

  return typed.value;
});

const login = Effect.fn("Cli.login")(function* (tokens: ParsedTokens, json: boolean) {
  const output = yield* Output;
  const env = yield* readEnvironment;

  const server = Option.orElse(
    Option.map(stringFlag(tokens, "server"), normalizeServer),
    () => env.server,
  );

  if (Option.isNone(server)) {
    return yield* new UsageError({ message: "login needs --server <url>", command: "login" });
  }

  if (Result.isFailure(Schema.decodeResult(ServerUrl)(server.value))) {
    return yield* new UsageError({
      message: `--server must be an http(s) URL such as https://music.example.com/convex; got "${server.value}"`,
      command: "login",
    });
  }

  // Checked before asking for the key, so nobody types a key that would then go out in cleartext.
  if (!isTrue(tokens, "insecure") && !env.insecure && sendsKeyInCleartext(server.value)) {
    return yield* cleartextError(server.value, "--insecure", "login");
  }

  const key = yield* loginKey(tokens, env);
  const credentials = { server: server.value, key };
  const fresh = yield* signIn(credentials);

  // Reaching here with a cleartext server means the user allowed it; remember that they did.
  yield* saveCredentials(env.paths, credentials, sendsKeyInCleartext(credentials.server));
  yield* saveSession(env.paths, fresh);

  const api = yield* connect(credentials, env.paths);
  const user = yield* api.read("account.me", {});

  if (json) return yield* printJson({ server: credentials.server, user });

  yield* output.out(
    `Logged in to ${escapeControlCharacters(credentials.server)} as ${escapeControlCharacters(user.email)} (${user.role}).`,
  );

  return yield* output.err(`Saved to ${env.paths.config}.`);
});

const logout = Effect.fn("Cli.logout")(function* (json: boolean) {
  const output = yield* Output;
  const env = yield* readEnvironment;

  yield* clearAll(env.paths);

  if (Option.isSome(env.key)) {
    yield* output.err("MUSIC_API_KEY is still set in the environment and will keep working.");
  }

  yield* json ? printJson({ ok: true }) : output.out("Logged out.");
});

const runAccountMe = (api: Api, json: boolean): Effect.Effect<void, CliError, Output> =>
  Effect.gen(function* () {
    const output = yield* Output;
    const user = yield* api.read("account.me", {});

    yield* json ? printJson(user) : output.out(renderResult(commands["account.me"].result, user));
  });

const transport = (
  name: "playback.pause" | "playback.resume" | "playback.next" | "playback.previous",
  done: string,
  json: boolean,
): Effect.Effect<void, CliError, Output> =>
  Effect.gen(function* () {
    const api = yield* session();
    const output = yield* Output;

    yield* api.run(name, {});
    yield* json ? printJson({ ok: true }) : output.out(done);
  });

const builtinOptions = (name: string): ParseArgsOptionsConfig => {
  switch (name) {
    case "login":
      return {
        ...commonOptions,
        server: { type: "string" },
        key: { type: "string" },
        "key-stdin": { type: "boolean" },
        insecure: { type: "boolean" },
      };
    case "commands":
      return { ...commonOptions, markdown: { type: "boolean" } };
    case "play":
      return { ...commonOptions, device: { type: "string" } };
    default:
      return commonOptions;
  }
};

const builtinHelp = (name: string): string => {
  const builtin = builtins.find((candidate) => candidate.name === name);

  return builtin === undefined
    ? rootHelp(version)
    : [`Usage: music ${builtin.synopsis} [--json]`, "", builtin.summary].join("\n");
};

const songCount = (count: number): string => `${String(count)} song${count === 1 ? "" : "s"}`;

type BuiltinHandler = (
  tokens: ParsedTokens,
  json: boolean,
) => Effect.Effect<void, CliError, Output | Input>;

const playQuery = (tokens: ParsedTokens, json: boolean): Effect.Effect<void, CliError, Output> =>
  Effect.gen(function* () {
    const output = yield* Output;
    const query = tokens.positionals.join(" ").trim();

    if (query.length === 0) {
      return yield* new UsageError({ message: "play needs a search query", command: "play" });
    }

    const device = Option.map(stringFlag(tokens, "device"), (raw) => DeviceId.make(raw));
    const api = yield* session();
    const played = yield* play(api, query, Option.getOrNull(device));

    return yield* json
      ? printJson(played)
      : output.out(
          `Playing ${escapeControlCharacters(played.title)} (${songCount(played.trackIds.length)}).`,
        );
  });

const showNow = (json: boolean): Effect.Effect<void, CliError, Output> =>
  Effect.gen(function* () {
    const output = yield* Output;
    const api = yield* session();
    const current = yield* now(api);

    return yield* json ? printJson(current.state) : output.out(current.text);
  });

const listCommands = (tokens: ParsedTokens, json: boolean): Effect.Effect<void, never, Output> =>
  Effect.gen(function* () {
    const output = yield* Output;

    if (isTrue(tokens, "markdown")) return yield* output.out(markdownReference());

    return yield* json ? printJson(catalog()) : output.out(rootHelp(version));
  });

const builtinHandlers: ReadonlyMap<string, BuiltinHandler> = new Map<string, BuiltinHandler>([
  ["login", (tokens, json) => login(tokens, json)],
  ["logout", (_tokens, json) => logout(json)],
  ["whoami", (_tokens, json) => Effect.flatMap(session(), (api) => runAccountMe(api, json))],
  ["commands", listCommands],
  ["play", playQuery],
  ["now", (_tokens, json) => showNow(json)],
  ["pause", (_tokens, json) => transport("playback.pause", "Paused.", json)],
  ["resume", (_tokens, json) => transport("playback.resume", "Playing.", json)],
  ["next", (_tokens, json) => transport("playback.next", "Skipped to the next song.", json)],
  [
    "previous",
    (_tokens, json) => transport("playback.previous", "Back to the previous song.", json),
  ],
]);

const runBuiltin = Effect.fn("Cli.runBuiltin")(function* (
  name: string,
  rest: ReadonlyArray<string>,
) {
  const output = yield* Output;
  const tokens = yield* tokenize(builtinOptions(name), rest, name);
  const json = isTrue(tokens, "json");

  if (isTrue(tokens, "help")) return yield* output.out(builtinHelp(name));

  if (name !== "play" && tokens.positionals.length > 0) {
    return yield* new UsageError({
      message: `Unexpected argument "${tokens.positionals.join(" ")}"`,
      command: name,
    });
  }

  const handler = builtinHandlers.get(name);

  if (handler === undefined) {
    return yield* new UsageError({ message: `Unknown command "${name}"`, command: null });
  }

  return yield* handler(tokens, json);
});

const program = (argv: ReadonlyArray<string>): Effect.Effect<void, CliError, Output | Input> =>
  Effect.gen(function* () {
    const output = yield* Output;
    const route = yield* Effect.fromResult(resolve(argv));

    yield* Route.$match(route, {
      Root: () => output.out(rootHelp(version)),
      Version: () => output.out(version),
      Group: ({ group }) => output.out(groupHelp(group)),
      Registry: ({ entry, rest }) => runRegistry(entry, rest),
      Builtin: ({ name, rest }) => runBuiltin(name, rest),
    });
  });

/**
 * An error message as stderr lines. Messages can quote the server, file tags, or the command line:
 * every control character is written out, and lines after the first are indented, so no message
 * can pass a line of its own off as the CLI's. JSON output keeps the message as it was; `Output`
 * escapes what a terminal would act on there.
 */
const messageLines = (message: string): string =>
  message.split("\n").map(escapeControlCharacters).join("\n  ");

const reportError = (error: CliError, json: boolean): Effect.Effect<void, never, Output> =>
  Effect.gen(function* () {
    const output = yield* Output;
    const report = reportOf(error);

    if (json) {
      yield* output.err(JSON.stringify({ error: report }));
    } else {
      yield* output.err(`music: ${messageLines(report.message)}`);
    }

    if (!json && Predicate.isTagged(error, "UsageError")) {
      yield* output.err(
        error.command === null ? "Run music --help." : `Run music ${error.command} --help.`,
      );
    }
  });

/** Runs one invocation and returns the process exit code. Never fails. */
export const runCli = (
  argv: ReadonlyArray<string>,
): Effect.Effect<ExitCode, never, Output | Input> => {
  const json = argv.includes("--json");

  return program(argv).pipe(
    Effect.as(ExitCode.ok),
    Effect.catch((error) => Effect.as(reportError(error, json), exitCodeOf(error))),
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        const output = yield* Output;
        const message = `Internal error: ${Cause.pretty(cause)}`;

        yield* json
          ? output.err(JSON.stringify({ error: { code: "internal", message } }))
          : output.err(`music: ${messageLines(message)}`);

        return ExitCode.failed;
      }),
    ),
  );
};
