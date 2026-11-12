# 0021. Ship one `media` CLI and one agent skill with a reference per domain

- Status: Accepted, 2026-11-03. Amended 2026-11-04 with the CLI shell, 2026-11-11 with one
  config and the movies commands, and 2026-11-11 with the refusal fence.
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
  admin-scoped command goes under `media admin` and the core's other commands under
  `media auth`. A content domain's commands declare only that domain's scopes (ADR 0005), so they
  all go under its own group. The module's last segment and the function follow, in kebab case:
  `core.accounts.users.setRole` is `media admin users set-role`. The generator refuses two
  commands on one path before writing anything.
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

## One config and the movies commands (amended 2026-11-11)

The movies port (p4-movies-cli, D53, D62) folded the CLI onto the core, which the image and the
NixOS module now run alone (ADR 0027).

- **One config.** `apps/cli/src/config.ts` is the CLI's only config module. A profile is one file,
  `$XDG_CONFIG_HOME/media/sessions/<profile>.json` (mode 0600), holding the core's URL, the media
  server's URL when it is not the core's address without `/convex`, and the session. The profile
  is `--profile`, else `MEDIA_PROFILE`, else `default`; there is no stored default profile.
  `media auth login` is the only sign-in, and `media login`, `logout`, `whoami`, and
  `$XDG_CONFIG_HOME/movies/config.json` are gone, with `MEDIA_CONVEX_URL` and `MEDIA_API_KEY`.
- **The media server.** `MEDIA_SERVER_URL`, else the profile's stored URL (`auth login
  --media-url`), else the core's address without `/convex`. Sign-ins go to
  `MEDIA_CORE_SIGN_IN_URL`, else the boundary on that media server, so a NixOS host whose core is
  on its own port still signs in through the server. `media logs` and `media diagnostics` call
  the media server's routes with the core session's token, through the SDK's `MediaRoutes`.
- **The movies commands.** Every old top-level movies word is gone. The generated `media movies`
  group replaces the registry words (`media titles list` is `media movies titles list`), and
  the generated core groups replace the account and admin ones. One hand-written movies command
  remains: `media movies stream <title>`, the old `media play`, rebuilt on `movies.play.start` and
  the media server's negotiation, with `--open` launching mpv. An old word exits with a usage
  error naming where it moved. `media call` and `media commands` list only generated and
  hand-written commands.
- **The skill.** `SKILL.md` routes to the generated `references/movies.md` and `references/core.md`
  only, and documents the hand-written commands itself. The hand-maintained `movies.md` and its
  `skill:reference` script are gone.

- **Group sessions.** The old `rooms` words map to the generated `media auth together`
  commands: `create`, `join`, `leave`, `status` (`together get`), and `play`, `pause`, `seek`,
  and `next` (`together control`). The next-episode countdown (`rooms countdown` and
  `rooms cancel-countdown`) has no core command; it returns with p6-together-movies.
- **Refusals (D51).** One rule covers every call the CLI makes as the session. When the core or
  the media server refuses the session (`Unauthenticated`, HTTP 401), the platform client
  refreshes once at once. A refused refresh clears the stored session, and the CLI reports
  `not_logged_in`, naming `media auth login`. Platform calls run under it inside the client; the
  media server's routes (`media logs`, `media diagnostics`) and the web clients' media server
  calls (`createMediaServer` with the platform `session`) run under the same rule through
  `session.refreshOnRefusal`.
- **The refusal fence.** A refusal can arrive after the session it answered was renewed, so the
  rule is fenced on the token the call actually carried, and it never sends a call again. The
  session stamps every token it hands out with the session it belongs to (the token's subject) and
  a generation, which moves on whenever the held session changes, in this tab or another (D52),
  and whenever a refusal's refresh keeps it. Each connection reports what a call carried:
  - the HTTP connection sets and records the token as each request leaves, with mutations sent one
    at a time in call order and each mutation's token read as it leaves;
  - a WebSocket client authenticates its connection, not each call, and Convex reports no
    confirmation of a renewed token. So a call or a subscription result carried the token held
    when it went out only if the connection held that one token, with no fetch out, until it was
    answered, and the server had answered that token source (`setAuth`'s `onChange`): until it
    has, the client can still hand out a query's result from before, such as a refusal computed
    while signed out. Otherwise its token is unsettled, and a refusal of it touches nothing. A
    sign-in returns only once the server has answered the new source, up to 10 seconds, so the
    next call runs as the new session.

  On a refusal, decided from the session held now with no lock held across a network wait:
  - an unsettled token, another person's session, no session, or a call sent signed out: the
    failure comes back, and nothing refreshes or ends;
  - the same session at an older generation, renewed since: the failure comes back and nothing
    refreshes or ends; the connection takes the renewed token, so the next call carries it;
  - the same session at the current generation: one refresh per generation, which every refusal of
    that generation awaits and nothing else does, even when it keeps the token because the server
    was unreachable. A refused refresh signs out only while that generation is held.

  The HTTP connection no longer sends a call again after a rejected token, so D51 is the only
  budget. A subscription refused with a renewed or unsettled token subscribes again through the
  normal path, which sends and records the token held then; a refusal of that subscription is
  judged by its own token, so a server that keeps refusing the current token gets one refresh and
  then the stream ends. Three such restarts without a result between end it too. Forbidden and
  network failures never touch the session. The WebSocket client renews once after it takes a new
  token source, as it does at sign-in, so catching it up costs one ordinary refresh.

Old words with no replacement on the core, left out under D62 until the backlog brings them back:
`profiles use` (one person per session now), `keys list`, the room countdown above, `import` (the
importer page lives in the movies client, D57), `restore`, and `--wait` on queued jobs.
