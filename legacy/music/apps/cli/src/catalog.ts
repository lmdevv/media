/**
 * The command tree: registry commands mapped to CLI paths, the built-in commands, help text, and
 * the machine-readable catalog behind `music commands`.
 */
import type { Capability } from "@music/commands/permissions";
import { capabilityLabel } from "@music/commands/permissions";
import type { CommandGroup } from "@music/commands/command";
import { commands, isCommandName } from "@music/commands/registry";
import type { CommandName } from "@music/commands/registry";
import { Schema, SchemaAST } from "effect";

import type { FlagSet, FlagSpec } from "./flags";
import { deriveFlags, FlagType, flagTypeLabel, flagUsage } from "./flags";

/** A registry command as the CLI exposes it. */
export interface RegistryEntry {
  readonly name: CommandName;
  /** The words after `music`: `playlists create`. */
  readonly path: string;
  readonly flags: FlagSet;
}

/** Every registry command in registry order. */
export const registryEntries: ReadonlyArray<RegistryEntry> = Object.keys(commands)
  .filter(isCommandName)
  .map((name) => ({
    name,
    path: name.split(".").join(" "),
    flags: deriveFlags(commands[name].args),
  }));

/** The first word of every multi-word command: `playlists`, `albums`, ... */
export const groupWords: ReadonlySet<string> = new Set(
  registryEntries.flatMap((entry) => {
    const [first, second] = entry.path.split(" ");

    return second === undefined || first === undefined ? [] : [first];
  }),
);

/** Commands implemented by the CLI itself on top of the registry. */
export interface Builtin {
  readonly name: string;
  readonly synopsis: string;
  readonly summary: string;
  readonly section: "Shortcuts" | "Account";
}

export const builtins: ReadonlyArray<Builtin> = [
  {
    name: "play",
    synopsis: "play <query> [--device <id>]",
    summary: "Search and play the best match: an album, an artist's top songs, or songs",
    section: "Shortcuts",
  },
  {
    name: "now",
    synopsis: "now",
    summary: "Show what is playing (playback.state)",
    section: "Shortcuts",
  },
  { name: "pause", synopsis: "pause", summary: "Pause playback", section: "Shortcuts" },
  { name: "resume", synopsis: "resume", summary: "Resume playback", section: "Shortcuts" },
  { name: "next", synopsis: "next", summary: "Skip to the next song", section: "Shortcuts" },
  {
    name: "previous",
    synopsis: "previous",
    summary: "Go back to the previous song",
    section: "Shortcuts",
  },
  {
    name: "login",
    synopsis: "login --server <url> [--key-stdin] [--insecure]",
    summary:
      "Verify an API key (piped with --key-stdin, MUSIC_API_KEY, or asked for) and store it with the server URL",
    section: "Account",
  },
  {
    name: "logout",
    synopsis: "logout",
    summary: "Forget the stored key and session",
    section: "Account",
  },
  {
    name: "whoami",
    synopsis: "whoami",
    summary: "Show the signed-in user (account.me)",
    section: "Account",
  },
  {
    name: "commands",
    synopsis: "commands [--json]",
    summary: "List every command; --json adds argument JSON Schemas",
    section: "Account",
  },
];

const positionalUsage = (spec: FlagSpec): string =>
  FlagType.$match(spec.type, {
    List: () => `<${spec.flag}...>`,
    Choice: ({ choices }) => `<${choices.join("|")}>`,
    Text: () => `<${spec.flag}>`,
    Number: () => `<${spec.flag}>`,
    Boolean: () => `<${spec.flag}>`,
    Json: () => `<${spec.flag}>`,
  });

/** Required flags read as-is, optional ones in brackets, and boolean pairs in parentheses. */
const synopsisPart = (spec: FlagSpec): string => {
  if (!spec.required) return `[${flagUsage(spec)}]`;

  return FlagType.$is("Boolean")(spec.type) ? `(${flagUsage(spec)})` : flagUsage(spec);
};

/** `music playlists get <playlist-id>`, `music playlists create --name <text> [...]` */
const synopsis = (entry: RegistryEntry): string => {
  const { flags, positional } = entry.flags;

  const parts = flags.map((spec) =>
    spec === positional ? positionalUsage(spec) : synopsisPart(spec),
  );

  const wait = commands[entry.name].job ? ["[--wait [--timeout <seconds>]]"] : [];

  return ["music", entry.path, ...parts, ...wait].join(" ");
};

const pad = (rows: ReadonlyArray<readonly [string, string]>): ReadonlyArray<string> => {
  const width = Math.max(0, ...rows.map(([left]) => left.length));

  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`);
};

const globalFlagLines = pad([
  ["--json", "Print the result as JSON on stdout; errors as JSON on stderr"],
  ["-h, --help", "Show help for any command"],
  ["--version", "Print the version"],
]);

const exitCodeLine = "Exit codes: 0 ok, 1 command failed, 2 usage error, 3 auth error.";

const builtinRows = (section: Builtin["section"]): ReadonlyArray<readonly [string, string]> =>
  builtins.flatMap((builtin) =>
    builtin.section === section ? [[builtin.synopsis, builtin.summary] as const] : [],
  );

/** `music --help`. */
export const rootHelp = (version: string): string =>
  [
    `music ${version}: the [music] command line. Everything the app can do, for people and agents.`,
    "",
    "Usage: music <command> [flags]",
    "",
    "Shortcuts",
    ...pad(builtinRows("Shortcuts")),
    "",
    "Account",
    ...pad(builtinRows("Account")),
    "",
    "Commands",
    ...pad(registryEntries.map((entry) => [entry.path, commands[entry.name].summary] as const)),
    "",
    "Global flags",
    ...globalFlagLines,
    "",
    exitCodeLine,
    "Run music <command> --help for its flags, or music commands --json for every argument schema.",
  ].join("\n");

/** `music playlists --help`. */
export const groupHelp = (group: string): string =>
  [
    `Usage: music ${group} <command> [flags]`,
    "",
    ...pad(
      registryEntries.flatMap((entry) =>
        entry.path.startsWith(`${group} `)
          ? [[entry.path, commands[entry.name].summary] as const]
          : [],
      ),
    ),
    "",
    `Run music ${group} <command> --help for its flags.`,
  ].join("\n");

const flagNote = (spec: FlagSpec): string => {
  const parts = [spec.required ? "required" : "optional"];

  if (FlagType.$is("List")(spec.type)) parts.push("repeat the flag or separate values with commas");

  return parts.join("; ");
};

/** `music playlists create --help`. */
export const commandHelp = (entry: RegistryEntry): string => {
  const command = commands[entry.name];
  const { flags, positional } = entry.flags;

  const flagRows = flags.map((spec) => [flagUsage(spec), flagNote(spec)] as const);

  const jobRows = command.job
    ? ([
        ["--wait", "Wait for the job to finish, printing progress to stderr"],
        ["--timeout <seconds>", "Give up waiting after this long (default 3600)"],
      ] as const)
    : [];

  return [
    `Usage: ${synopsis(entry)}`,
    "",
    command.summary,
    "",
    `Registry command ${entry.name} (${command.kind}, ${capabilityLabel(command.access)}).`,
    ...(positional === null
      ? []
      : [`The ${positionalUsage(positional)} argument fills --${positional.flag}.`]),
    "",
    "Flags",
    ...pad([
      ...flagRows,
      ...jobRows,
      ["--args <json>", "Arguments as one JSON object; flags override its fields"],
      ["--json", "Print the result as JSON"],
    ]),
    "",
    exitCodeLine,
  ].join("\n");
};

/** One entry of `music commands --json`. A type alias so it stays assignable to JSON. */
export type CatalogEntry = {
  readonly name: CommandName;
  readonly command: string;
  readonly synopsis: string;
  readonly group: CommandGroup;
  readonly kind: "query" | "mutation";
  readonly access: Capability;
  readonly job: boolean;
  readonly summary: string;
  readonly positional: string | null;
  readonly flags: ReadonlyArray<{
    readonly flag: string;
    readonly field: string;
    readonly type: string;
    readonly required: boolean;
  }>;
  /** JSON Schema (draft 2020-12) of the wire arguments; `--args` accepts a matching object. */
  readonly args: Schema.Json;
};

/** JSON Schema generation only emits JSON values; a mismatch is a defect. */
const toJson = Schema.decodeUnknownSync(Schema.Json);

const dialect = "https://json-schema.org/draft/2020-12/schema";

/**
 * The wire arguments as JSON Schema. Effect describes an empty struct as "anything but null";
 * agents read it better as an object with no properties, which is what the CLI sends.
 */
const argsJsonSchema = (args: Schema.Top): Schema.Json => {
  const ast = SchemaAST.toEncoded(args.ast);

  if (
    SchemaAST.isObjects(ast) &&
    ast.propertySignatures.length === 0 &&
    ast.indexSignatures.length === 0
  ) {
    return { $schema: dialect, type: "object", properties: {} };
  }

  const document = Schema.toJsonSchemaDocument(args);

  return toJson(
    Object.keys(document.definitions).length === 0
      ? { $schema: dialect, ...document.schema }
      : { $schema: dialect, ...document.schema, $defs: document.definitions },
  );
};

/** Every registry command with its flags and argument JSON Schema. */
export const catalog = (): ReadonlyArray<CatalogEntry> =>
  registryEntries.map((entry) => {
    const command = commands[entry.name];

    return {
      name: entry.name,
      command: `music ${entry.path}`,
      synopsis: synopsis(entry),
      group: command.group,
      kind: command.kind,
      access: command.access,
      job: command.job,
      summary: command.summary,
      positional: entry.flags.positional === null ? null : `--${entry.flags.positional.flag}`,
      flags: entry.flags.flags.map((spec) => ({
        flag: `--${spec.flag}`,
        field: spec.key,
        type: flagTypeLabel(spec),
        required: spec.required,
      })),
      args: argsJsonSchema(command.args),
    };
  });

/** Who may run a command, as the skill reference marks it; commands for anyone are unmarked. */
const ACCESS_NOTES: Readonly<Record<Capability, string | null>> = {
  user: null,
  keys: "not guests",
  admin: "admin",
  owner: "owner",
};

/** The command reference section of the agent skill, generated from the registry. */
export const markdownReference = (): string => {
  const groups = new Map<CommandGroup, Array<RegistryEntry>>();

  for (const entry of registryEntries) {
    const group = commands[entry.name].group;
    const members = groups.get(group) ?? [];

    members.push(entry);
    groups.set(group, members);
  }

  const sections = [...groups].map(([group, entries]) =>
    [
      `### ${group}`,
      "",
      ...entries.map((entry) => {
        const command = commands[entry.name];

        const notes = [
          ACCESS_NOTES[command.access],
          command.job ? "job: add `--wait`" : null,
        ].filter((note) => note !== null);

        return `- \`${synopsis(entry)}\`: ${command.summary}.${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`;
      }),
    ].join("\n"),
  );

  return [
    "<!-- Generated from the command registry by `pnpm --filter @music/cli skill:reference`. Do not edit by hand. -->",
    "",
    ...sections.flatMap((section) => [section, ""]),
  ]
    .join("\n")
    .trimEnd();
};
