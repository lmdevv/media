import type { CheckedCommand, Refusal, WireField } from "./check.ts";
import type { Domain } from "./command.ts";

/**
 * The first word after `media` for every generated command. `admin` holds every admin-scoped
 * command of every domain (ADR 0021), `auth` the rest of the core's, and each product domain its
 * own.
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
 * A command's words after `media`: its group, the domain again for a product domain's admin
 * command, then its module's last segment and its function, in kebab case.
 * `core.accounts.users.setRole` is `admin users set-role`, `core.auth.sessions.endAll` is
 * `auth sessions end-all`, and an admin-scoped `music.scans.start` would be
 * `admin music scans start`. Middle module segments drop out.
 */
export const cliPath = (
  command: Pick<CheckedCommand, "name" | "domain" | "scope">,
): readonly [CliGroup, ...Array<string>] => {
  const [module = "", fn = ""] = command.name.split(".").slice(-2);
  const admin = command.scope === "admin";
  const domainWord = admin && command.domain !== "core" ? [command.domain] : [];

  return [admin ? "admin" : DOMAIN_GROUPS[command.domain], ...domainWord, kebab(module), kebab(fn)];
};

/** An argument that never travels on the command line, and the variable that supplies it. */
export interface Secret {
  readonly field: string;
  /** `MEDIA_ARG_` and the field in upper snake case: `newPassword` is `MEDIA_ARG_NEW_PASSWORD`. */
  readonly variable: string;
}

const SECRET = /password$/iu;

/**
 * The arguments a flag would leak into shell history and the process list: every string field
 * whose name ends in `password`.
 */
export const secretsOf = (args: ReadonlyArray<WireField>): ReadonlyArray<Secret> =>
  args.flatMap((field) =>
    SECRET.test(field.name) && field.wire.kind === "string"
      ? [
          {
            field: field.name,
            variable: `MEDIA_ARG_${kebab(field.name).replaceAll("-", "_").toUpperCase()}`,
          },
        ]
      : [],
  );

/** A Convex paginated query takes `paginationOpts`; the CLI gives it `--limit` and `--cursor`. */
export const isPaginated = (args: ReadonlyArray<WireField>): boolean =>
  args.some((field) => field.name === "paginationOpts");

/**
 * Refuses two commands on one CLI path, and a path that starts another, which would make one
 * command's words a group of the other's.
 */
export const cliRefusals = (commands: ReadonlyArray<CheckedCommand>): ReadonlyArray<Refusal> => {
  const placed = commands.map((command) => ({
    name: command.name,
    path: cliPath(command).join(" "),
  }));

  return placed.flatMap(({ name, path }): ReadonlyArray<Refusal> =>
    placed.flatMap((other): ReadonlyArray<Refusal> =>
      other.name !== name && (other.path === path || other.path.startsWith(`${path} `))
        ? [{ reason: "cli-clash", name, other: other.name, path }]
        : [],
    ),
  );
};
