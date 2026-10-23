/**
 * Actions (F26–F28, G18): every registry command a person may run by hand, grouped and searched
 * as the iOS screens show them, plus the pieces of the generated form that need no React Native.
 * The commands, fields, and outcomes themselves come from `@music/commands/forms`, which the web
 * command menu shares.
 */
import type { CommandGroup } from "@music/commands/command";
import { rawArgs } from "@music/commands/forms";
import type { CommandOutcome, FieldSpec, FormValues, offeredCommands } from "@music/commands/forms";
import { JobId, PlaylistId } from "@music/commands/ids";
import type { Job, Library } from "@music/commands/models";
import { commands } from "@music/commands/registry";
import type { MutationName } from "@music/commands/registry";
import { foldSearchText } from "@music/commands/search-text";
import { Match, Option, Schema } from "effect";

import { countOf } from "./format";

const grouped = new Intl.NumberFormat("en-US");

/** One command the Actions list offers, with its form fields. */
export type Action = ReturnType<typeof offeredCommands>[number];

/** The headings Actions groups commands under, in display order. */
const SECTIONS = ["Listening", "Playlists", "Account", "Administration"] as const;

/** A heading on the Actions list. */
type Section = (typeof SECTIONS)[number];

const SECTION_OF = {
  playback: "Listening",
  queue: "Listening",
  devices: "Listening",
  downloads: "Listening",
  likes: "Listening",
  jams: "Listening",
  library: "Listening",
  search: "Listening",
  playlists: "Playlists",
  account: "Account",
  keys: "Account",
  libraries: "Administration",
  jobs: "Administration",
  people: "Administration",
  server: "Administration",
} as const satisfies Record<CommandGroup, Section>;

/**
 * A command's short title on a phone: its summary up to the first colon, semicolon, or
 * parenthesis, where the registry starts explaining CLI flags. `Add songs to the queue: --next …`
 * reads `Add songs to the queue`; the whole summary stays on the command's own page.
 */
export const actionTitle = (summary: string): string =>
  summary.split(/[:;]| \(/u)[0]?.trim() ?? summary;

/** Whether every word of `query` appears in `text`, ignoring case and accents. */
export const matchesQuery = (text: string, query: string): boolean => {
  const haystack = foldSearchText(text);

  return foldSearchText(query)
    .split(/\s+/u)
    .every((token) => haystack.includes(token));
};

/** One heading of the Actions list and the commands under it. */
export interface ActionSection {
  readonly section: Section;
  readonly actions: ReadonlyArray<Action>;
}

/**
 * The offered commands that match `query`, under their headings in display order. A command
 * matches when every word of the query appears in its summary, its name (`libraries.scan`), its
 * group, or its heading. Headings with no match are left out, so no match at all is an empty list.
 */
export const actionSections = (
  offered: ReadonlyArray<Action>,
  query: string,
): ReadonlyArray<ActionSection> => {
  const matching = offered.filter((action) => {
    const command = commands[action.name];

    return matchesQuery(
      `${command.summary} ${action.name} ${command.group} ${SECTION_OF[command.group]}`,
      query,
    );
  });

  return SECTIONS.flatMap((section) => {
    const actions = matching.filter(
      (action) => SECTION_OF[commands[action.name].group] === section,
    );

    return actions.length === 0 ? [] : [{ section, actions }];
  });
};

/** `a`, `a and b`, `a, b, and c`. */
const listOf = (words: ReadonlyArray<string>): string =>
  words.length <= 2
    ? words.join(" and ")
    : `${words.slice(0, -1).join(", ")}, and ${words.at(-1) ?? ""}`;

/** What the form says when Run is pressed with required fields still empty. */
export const missingMessage = (missing: ReadonlyArray<FieldSpec>): string =>
  `${listOf(missing.map((field) => field.label))} ${missing.length === 1 ? "is" : "are"} required.`;

/** A choice as a chip says it: `off` → `Off`. */
export const choiceLabel = (option: string): string =>
  option.charAt(0).toUpperCase() + option.slice(1);

/** The libraries a library command can act on: the ones you manage, whose folder you can see. */
export const scannableLibraries = (libraries: ReadonlyArray<Library>): ReadonlyArray<Library> =>
  libraries.filter((library) => library.manageable && library.path !== null);

/**
 * A form's starting values: required switches start off, and Rescan picks the only library when
 * there is one, since there is nothing to choose.
 */
export const formDefaults = (
  name: MutationName,
  fields: ReadonlyArray<FieldSpec>,
  libraries: ReadonlyArray<Library> | undefined,
): FormValues => {
  const values: Record<string, FormValues[string]> = {};

  for (const field of fields) {
    if (field.field.kind === "boolean" && !field.optional) values[field.name] = false;
  }

  const only = scannableLibraries(libraries ?? []);

  if (name === "libraries.scan" && only.length === 1 && only[0] !== undefined)
    values["libraryId"] = only[0].id;

  return values;
};

/** The IDs an ID field holds: none, one, or a list. */
export const selectedIds = (value: FormValues[string]): ReadonlyArray<string> =>
  value === undefined || value === true || value === false ? [] : [value].flat();

/**
 * The field's value after tapping option `id`. A list adds or drops it. A single choice takes it;
 * tapping the chosen one again clears an optional field and keeps a required one.
 */
export const toggleOption = (
  spec: FieldSpec,
  value: FormValues[string],
  id: string,
): FormValues[string] => {
  const chosen = selectedIds(value);

  if (spec.field.kind === "ids")
    return chosen.includes(id) ? chosen.filter((each) => each !== id) : [...chosen, id];

  if (chosen.includes(id)) return spec.optional ? undefined : value;

  return id;
};

const STATUS_LINES = {
  pending: () => "Scan queued · Waiting for scanner",
  running: (job) =>
    job.total === null
      ? `Running · ${countOf(job.done, "file")}`
      : `Running · ${grouped.format(job.done)} of ${countOf(job.total, "file")}`,
  done: (job) => (job.message === null ? "Done" : `Done · ${job.message}`),
  failed: (job) => (job.error === null ? "Failed" : `Failed · ${job.error}`),
  cancelled: () => "Cancelled",
} as const satisfies Record<Job["status"], (job: Job) => string>;

/** A job's status as its row says it: `Running · 804 of 1,248 files`. */
export const jobLine = (job: Job): string => STATUS_LINES[job.status](job);

/**
 * The form after one field changes. Picking another playlist clears the entries chosen from the
 * one before, which the server would refuse.
 */
export const editField = (
  fields: ReadonlyArray<FieldSpec>,
  values: FormValues,
  name: string,
  value: FormValues[string],
): FormValues => {
  const cleared =
    name === "playlistId" && value !== values[name]
      ? fields.filter(
          (spec) =>
            (spec.field.kind === "id" || spec.field.kind === "ids") &&
            spec.field.entity === "playlistItem",
        )
      : [];

  return {
    ...values,
    [name]: value,
    ...Object.fromEntries(cleared.map((spec) => [spec.name, undefined])),
  };
};

/**
 * Wire arguments from the form. Number fields take a decimal comma too, since the decimal pad
 * shows one in locales that write `0,5`.
 */
export const formArgs = (fields: ReadonlyArray<FieldSpec>, values: FormValues) =>
  rawArgs(
    fields,
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => {
        const number = fields.some((spec) => spec.name === key && spec.field.kind === "number");

        const text =
          value !== undefined && value !== true && value !== false && !Array.isArray(value);

        return [key, number && text ? String(value).replace(",", ".") : value];
      }),
    ),
  );

/** What the result screen shows, from its route parameters. Secrets never travel here. */
const ResultRoute = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("job"), jobId: JobId }),
  Schema.Struct({ kind: Schema.Literal("key") }),
  Schema.Struct({ kind: Schema.Literal("invite") }),
  Schema.Struct({ kind: Schema.Literal("reset") }),
  Schema.Struct({ kind: Schema.Literal("playlist"), playlistId: PlaylistId }),
  Schema.Struct({ kind: Schema.Literal("none") }),
]);

/** A command's outcome as the result screen receives it. */
export type ResultRoute = typeof ResultRoute.Type;

const decodeResultRoute = Schema.decodeUnknownOption(ResultRoute);

/**
 * The secret an outcome shows once: a new API key, an invite code, or a reset token. It goes
 * through the secret slot, never the route.
 */
export const outcomeSecret = (outcome: CommandOutcome): string | null =>
  Match.value(outcome).pipe(
    Match.when({ kind: "key" }, ({ key }) => key),
    Match.when({ kind: "invite" }, ({ code }) => code),
    Match.when({ kind: "reset" }, ({ token }) => token),
    Match.orElse(() => null),
  );

/**
 * The route parameters for a command's outcome, without its secret: route parameters can end up
 * in navigation state and logs.
 */
export const resultParams = (outcome: CommandOutcome): ResultRoute =>
  outcome.kind === "key" || outcome.kind === "invite" || outcome.kind === "reset"
    ? { kind: outcome.kind }
    : outcome;

/** Route parameters as Expo Router hands them over. */
type RouteParams = Readonly<Record<string, string | ReadonlyArray<string>>>;

/** Reads the result screen's route parameters; null when they don't describe an outcome. */
export const parseResultRoute = (params: RouteParams): ResultRoute | null =>
  Option.getOrNull(decodeResultRoute(params));
