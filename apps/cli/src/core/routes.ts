import { Data, Option } from "effect";

import { pad } from "../catalog";
import { generatedCommands } from "../generated/commands";
import { authCommands } from "./auth-commands";
import type { CoreCatalogEntry, CoreCommand, CoreGroup, CoreShortcut } from "./command";
import { coreGroups } from "../generated/groups";
import { catalogEntry, shortcutSynopsis } from "./command";
import { hostCommands } from "./host";

/** A command in a core group: generated from the command list, or written by hand. */
export type CoreEntry = Data.TaggedEnum<{
  Generated: { readonly command: CoreCommand };
  HandWritten: { readonly command: CoreShortcut };
}>;

/** Constructors and matchers for `CoreEntry`. */
export const CoreEntry = Data.taggedEnum<CoreEntry>();

/** Every command in the core groups, hand-written first. */
export const coreEntries: ReadonlyArray<CoreEntry> = [
  ...[...authCommands, ...hostCommands].map((command) => CoreEntry.HandWritten({ command })),
  ...generatedCommands.map((command) => CoreEntry.Generated({ command })),
];

const pathOf = (entry: CoreEntry): string => entry.command.path;

const groupOf = (entry: CoreEntry): CoreGroup => entry.command.group;

const table: ReadonlyMap<string, CoreEntry> = new Map(
  coreEntries.map((entry) => [pathOf(entry), entry] as const),
);

/** Whether `word` names a core group, such as `admin`. */
export const isCoreGroup = (word: string): word is CoreGroup =>
  coreGroups.some((group) => group === word);

const LONGEST_PATH = Math.max(...coreEntries.map((entry) => pathOf(entry).split(" ").length));

/**
 * The core command the leading words name, trying the longest path first, and how many words it
 * took. `words` are already kebab case and lower case.
 */
export const resolveCore = (
  words: ReadonlyArray<string>,
): Option.Option<{ readonly entry: CoreEntry; readonly taken: number }> => {
  const leading = words.slice(0, LONGEST_PATH);

  return Option.firstSomeOf(
    leading.map((_, index) => {
      const taken = leading.length - index;

      return Option.map(
        Option.fromNullishOr(table.get(leading.slice(0, taken).join(" "))),
        (entry) => ({ entry, taken }),
      );
    }),
  );
};

/** The generated command named `name`, for `media call`. */
export const coreCommandNamed = (name: string): Option.Option<CoreCommand> =>
  Option.fromNullishOr(generatedCommands.find((command) => command.name === name));

const SUMMARIES = {
  auth: "Sign in to the core server, and manage your sessions, API keys, device sign-ins, and account",
  admin:
    "Manage the core's users, invites, reset links, groups, and restrictions; reset a password on the server host",
  movies: "Movies and shows",
  music: "Music",
} as const satisfies { readonly [Group in CoreGroup]: string };

const EMPTY = {
  auth: "None yet",
  admin: "None yet",
  movies: "None yet; until the movies port, use the movies server's commands below",
  music: "None yet; they arrive with the music port",
} as const satisfies { readonly [Group in CoreGroup]: string };

const inGroup = (group: CoreGroup): ReadonlyArray<CoreEntry> =>
  coreEntries.filter((entry) => groupOf(entry) === group);

const groupSummary = (group: CoreGroup): string =>
  inGroup(group).length === 0 ? `${SUMMARIES[group]}. ${EMPTY[group]}` : SUMMARIES[group];

/** The Groups section of `media --help`. */
export const groupsHelp = (): ReadonlyArray<string> => [
  "Groups (media <group> --help lists a group)",
  ...pad(coreGroups.map((group) => [group, groupSummary(group)] as const)),
];

const helpRow = (entry: CoreEntry): readonly [string, string] =>
  CoreEntry.$match(entry, {
    HandWritten: ({ command }) => [`media ${shortcutSynopsis(command)}`, command.summary] as const,
    Generated: ({ command }) => [`media ${command.path}`, command.summary] as const,
  });

/**
 * `media admin --help`, or `media admin users --help` for the commands under those words. Empty
 * when no command starts with them.
 */
export const prefixHelp = (words: ReadonlyArray<string>): Option.Option<string> => {
  const [group] = words;
  const prefix = words.join(" ");

  const entries = coreEntries.filter((entry) => `${pathOf(entry)} `.startsWith(`${prefix} `));

  if (group !== undefined && isCoreGroup(group) && entries.length === 0 && words.length === 1) {
    return Option.some(`media ${group}. ${groupSummary(group)}.`);
  }

  return entries.length === 0
    ? Option.none()
    : Option.some(
        [
          `Usage: media ${prefix} <command> [flags]`,
          "",
          ...pad(entries.map(helpRow)),
          "",
          `Run media ${prefix} <command> --help for its flags.`,
        ].join("\n"),
      );
};

/** The core commands' `media commands` entries. */
export const coreCatalog = (): ReadonlyArray<CoreCatalogEntry> =>
  coreEntries.map((entry) =>
    CoreEntry.$match(entry, {
      Generated: ({ command }) => catalogEntry(command),
      HandWritten: ({ command }): CoreCatalogEntry => ({
        name: command.path,
        command: `media ${command.path}`,
        synopsis: `media ${shortcutSynopsis(command)}`,
        group: command.group,
        kind: "shortcut",
        scope: "varies",
        job: false,
        summary: command.summary,
        positional: null,
        flags: Object.entries(command.options).map(([flag, option]) => ({
          flag: `--${flag}`,
          field: flag,
          type: option.type === "boolean" ? "boolean" : "text",
          required: false,
        })),
        args: { type: "object" },
        secrets: [],
      }),
    }),
  );
