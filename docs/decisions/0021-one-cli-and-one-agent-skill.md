# 0021. Ship one `media` CLI and one agent skill with a reference per domain

- Status: Accepted, 2026-11-03. Amended 2026-11-04 with the CLI shell.
- Decisions: D41, D51, D53

## Context

Movies publishes the `movies` CLI as `@lmdevv/movies` on npm, with JSON output and an agent skill
in `apps/cli/skills/movies/SKILL.md`. Agents use the CLI and the skill, and there is no MCP server.
Music has its own CLI in `apps/cli`. Two CLIs mean two installs, two sign-ins, and two skills
for an agent to load.

## Decision

- One CLI binary, `media`, with a command group per domain:
  - `media movies …`,
  - `media music …`,
  - `media admin …`.
- One agent skill, with one reference file per domain that the agent loads on demand.
- `@lmdevv/movies` on npm is deprecated with a pointer to the new package.

## Consequences

- An agent signs in once and reaches both domains.
- The skill stays small. An agent working on music loads the music reference and not the movies
  one.
- The CLI's commands come from the command list (ADR 0009), so each domain's group and reference
  file follow from its commands.
- `media admin reset-password <user>` lives in the admin group (ADR 0003).
- Anyone who installed `@lmdevv/movies` sees the deprecation pointer on their next install.

## Alternatives rejected

- One CLI per product, as today.
- One skill file that holds every domain's reference. Each domain's reference loads on demand.
- An MCP server. Agents use the CLI and the skill.

## Edge cases settled

- `@lmdevv/movies` is deprecated, not unpublished.
- Admin commands live under `media admin`, not under a domain.

## The CLI shell (amended 2026-11-04)

The first build of the shell (p3-cli-shell, D53) settled how generated commands reach the CLI
while the old movies commands stay where they are.

- **Placement.** One rule in `packages/commands/src/cli.ts` places every command. An
  admin-scoped command goes under `media admin`, with its domain word when it is a product
  domain's (`admin music scans start`). The core's other commands go under `media auth`, and a
  product domain's under its own group. The module's last segment and the function follow, in
  kebab case: `core.accounts.users.setRole` is `media admin users set-role`. The generator
  refuses two commands on one path, or a path that starts another, before writing anything.
- **The CLI target.** The generator writes `apps/cli/src/generated/commands.ts`: each command's
  path, summary, scope, schemas, and the platform SDK method that runs it. `coreCommand` in
  `apps/cli/src/core/command.ts` holds the policy: flags, `--json`, help, `media commands`, and
  the call. Type inference ties each entry's schemas to its SDK method, so the two cannot
  disagree, and the SDK's public surface does not grow.
- **Secrets and pages.** An argument whose name ends in `password` never becomes a flag. It
  comes from `MEDIA_ARG_<FIELD>`, or from stdin when it is the command's only one, and `--json`
  that carries it is refused. A paginated query takes `--limit` (default 100) and `--cursor`.
- **Two servers until the movies port.** The old movies commands keep their top-level words,
  their config, and their `media login`. The core's URL and session live in one module,
  `apps/cli/src/core/session.ts`: one file per profile at
  `$XDG_CONFIG_HOME/media/sessions/<profile>.json` with the core's URL and the session, no API
  key. The profile name resolves as the old commands resolve theirs. `MEDIA_CORE_URL` and
  `MEDIA_CORE_API_KEY` override it for one run. The movies port folds this module into the one
  config.
- **Hand-written commands.** `media auth login` signs in through the SDK, by device code unless
  `--username` (password from stdin or `MEDIA_PASSWORD`) or `--api-key` (from stdin or
  `MEDIA_CORE_API_KEY`) is given. Until the account app exists, a signed-in session approves the
  code with `media auth device-codes approve`. `media auth logout` signs out. Who-am-I is the
  generated `media auth sessions current`.
- **Host recovery.** `media admin reset-password [<username>]` runs
  `core/accounts/host:resetPassword` over the admin API. The URL and the admin key come together
  from `--env-file` (the core's `CONVEX_SELF_HOSTED_URL` and `CONVEX_SELF_HOSTED_ADMIN_KEY`) or
  from `MEDIA_CORE_URL` and `MEDIA_CORE_ADMIN_KEY`, never from the environment's own
  `CONVEX_SELF_HOSTED_*`, which name the movies backend on today's installs. The image that runs
  the core gives `--env-file` its default path.
- **A session ended elsewhere (D51).** The platform client asks for one forced refresh when a
  command comes back `Unauthenticated`, and never repeats the call. A refused refresh signs the
  client out at once; the CLI then reports `not_logged_in`, naming `media auth login`. A renewed
  refresh keeps the session, because the refusal was the command's own, such as a wrong current
  password.
- **The skill.** `apps/cli/skills/media/SKILL.md` routes each task to one file. The generator owns
  `references/` (`core.md`, with each command's `media` line). The old movies skill body is
  `movies.md` beside it until the movies port generates `references/movies.md`.
  `apps/cli/skills/movies/` is gone.
- **npm.** The deprecation of `@lmdevv/movies` waits for the first [media] release, since it must
  point at a published package (D53).

Rejected for the shell:

- A `cli` field with hand-picked words on every declaration. Agents could not predict a path from
  a name, and every declaration would carry a second name.
- A public, type-erased command table and a `call` method on the SDK. ADR 0009 rejected a second,
  name-keyed way to call a command.
- The core session inside `movies/config.json`. The old module rewrites the whole file and would
  drop a field it does not know.
- Repeating a call after the refresh. The transport already repeats a call whose token Convex
  rejected, and a wrong password would spend a second sign-in try.
