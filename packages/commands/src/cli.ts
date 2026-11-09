import type { CheckedCommand, Refusal, WireField } from "./check.ts";
import type { Domain } from "./command.ts";

/**
 * The first word after `media` for every generated command. `admin` holds the admin-scoped
 * commands (ADR 0021), `auth` the rest of the core's, and each content domain its own; a content
 * domain's commands declare only that domain's scopes, so none is admin-scoped.
 */
export const cliGroups = ["auth", "admin", "movies", "music"] as const;

/** A generated command's group word. */
export type CliGroup = (typeof cliGroups)[number];

const DOMAIN_GROUPS = {
  core: "auth",
  movies: "movies",
  music: "music",
} as const satisfies { readonly [D in Domain]: CliGroup };

const kebab = (segment: string): string =>
  segment.replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);

/**
 * A command's words after `media`: its group, then its module's last segment and its function,
 * in kebab case. `core.accounts.users.setRole` is `admin users set-role`,
 * `core.auth.sessions.endAll` is `auth sessions end-all`, and `movies.titles.list` is
 * `movies titles list`. Middle module segments drop out.
 */
export const cliPath = (
  command: Pick<CheckedCommand, "name" | "domain" | "scope">,
): readonly [CliGroup, string, string] => {
  const [module = "", fn = ""] = command.name.split(".").slice(-2);

  return [
    command.scope === "admin" ? "admin" : DOMAIN_GROUPS[command.domain],
    kebab(module),
    kebab(fn),
  ];
};

/** An argument that never travels on the command line, and the variable that supplies it. */
export interface Secret {
  readonly field: string;
  /** `MEDIA_ARG_` and the field in upper snake case: `newPassword` is `MEDIA_ARG_NEW_PASSWORD`. */
  readonly variable: string;
  /** The field also takes null, which reveals nothing, so `--json` may clear it. */
  readonly clearable?: true;
  /** The command runs without it: when the variable does not give it, it is left out. */
  readonly optional?: true;
}

const isNullableString = (wire: WireField["wire"]): boolean =>
  wire.kind === "union" &&
  wire.members.length === 2 &&
  wire.members.some((member) => member.kind === "string") &&
  wire.members.some((member) => member.kind === "null");

/** A name that ends like a credential: a password, a token, or a secret. */
const CREDENTIAL = /(?:password|token|secret)$/iu;

/**
 * Arguments named for what they carry rather than for being secret: an invite, reset, or unlock
 * code, a shared device's code (`dv_`), and a group-session link (`mt_`). A user code is the short
 * code a person reads off a device, which redeems nothing, so it is not one of them.
 */
const SECRET_NAMES: ReadonlySet<string> = new Set(["code", "device", "link"]);

/**
 * The arguments a flag would leak into shell history and the process list: every string field
 * named like a credential, and the codes and links in `SECRET_NAMES`.
 */
export const secretsOf = (args: ReadonlyArray<WireField>): ReadonlyArray<Secret> =>
  args.flatMap((field) => {
    if (!CREDENTIAL.test(field.name) && !SECRET_NAMES.has(field.name)) return [];

    const variable = `MEDIA_ARG_${kebab(field.name).replaceAll("-", "_").toUpperCase()}`;

    const clearable = isNullableString(field.wire);

    if (field.wire.kind !== "string" && !clearable) return [];

    const optional = field.optional ? ({ optional: true } as const) : undefined;
    const clears = clearable ? ({ clearable: true } as const) : undefined;

    return [Object.assign({ field: field.name, variable }, optional, clears) satisfies Secret];
  });

/** A Convex paginated query takes `paginationOpts`; the CLI gives it `--limit` and `--cursor`. */
export const isPaginated = (args: ReadonlyArray<WireField>): boolean =>
  args.some((field) => field.name === "paginationOpts");

/** Refuses two commands on one CLI path. */
export const cliRefusals = (commands: ReadonlyArray<CheckedCommand>): ReadonlyArray<Refusal> => {
  const placed = commands.map((command) => ({
    name: command.name,
    path: cliPath(command).join(" "),
  }));

  return placed.flatMap(({ name, path }): ReadonlyArray<Refusal> =>
    placed.flatMap((other): ReadonlyArray<Refusal> =>
      other.name !== name && other.path === path
        ? [{ reason: "cli-clash", name, other: other.name, path }]
        : [],
    ),
  );
};
