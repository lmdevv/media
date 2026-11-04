# 0023. Run the core in its own Convex deployment until the movies port

- Status: Accepted, 2026-11-04
- Decisions: D04, D14, D22

## Context

Phase 3 builds the core while the old movies code still runs, because agents port better from
running code (ADR 0002). The core and old movies both use Convex Auth v1 (ADR 0004). Convex Auth
reads and writes seven tables with fixed names: `users`, `authSessions`, `authAccounts`,
`authRefreshTokens`, `authVerificationCodes`, `authVerifiers`, and `authRateLimits`. It also calls
its own mutation by the fixed path `auth:store`. So one deployment holds one Convex Auth setup, with
one `users` table.

Old movies defines `users` and `authSessions` with its own fields: an email, a `service` role, a
restricted-session grant, and the PIN profiles a session unlocked. The core needs a username, the
roles owner, admin, member, and guest, and the session cutoffs of ADR 0004, and it has no profiles
(ADR 0003). Two throwaway prototypes tried the two ways to run the core next to old movies.
Appendix A of `docs/architecture.md` has their branches, commits, and evidence.

## Decision

- The core is its own Convex project, `packages/platform`, with its own deployment. Core code lives
  in `packages/platform/convex/core/`, and core tests in `packages/platform/test/core/`.
- Old movies keeps `packages/backend` and its deployment, unchanged, until the movies port.
- The movies port moves movies into `packages/platform/convex/movies/` and deletes
  `packages/backend`. The music port moves music into `packages/platform/convex/music/` and deletes
  `legacy/music`. After the movies port there is one Convex project and one deployment, with each
  domain as a folder in one schema (ADR 0008).
- Until the movies port, `scripts/dev-stack.sh` runs a second Convex backend for the core. Its API
  is on base + 4 and its HTTP actions on base + 5, and `scripts/dev-stack.sh env` prints both.

## Consequences

- The core defines `users`, `authSessions`, and the other Convex Auth tables in the core shape from
  its first auth PR. No core table carries a field that only old movies reads.
- No phase 3 PR edits old movies' schema, `auth.ts`, `crons.ts`, or `http.ts`. Old movies' backend
  stack suite runs unchanged through phase 3.
- Core tables use their final names. `jobs`, `libraries`, `invites`, `apiKeys`, and `deviceCodes`
  exist in both projects and never meet.
- Core function paths start with `core/` from the start, so the movies port moves no core code.
- Each worktree's dev stack runs one more Convex backend. It idles at about 46 MiB, adds about
  2 seconds to a cold `scripts/dev-stack.sh up`, and its `convex deploy` takes about 0.9 seconds.
- Until the movies port, server code that talks to the core, such as core tickets, jobs, and
  libraries, needs the core deployment's URL next to the movies deployment's URL. The movies port
  leaves the server with one Convex URL.
- A new workspace package needs entries in `knip.json`, `vitest.config.ts`, `.oxfmtrc.json`,
  `oxlint.config.ts`, `scripts/changed-packages.sh` and its test, and CI's stack job. This PR adds
  them for `packages/platform`.
- Phase 3 plans that name `packages/backend/convex/core/` or `packages/backend/test/core/` mean
  `packages/platform/convex/core/` and `packages/platform/test/core/`.

## Alternatives rejected

- The core in the movies deployment, with one core `users` and `authSessions` definition that old
  movies is adapted to read (prototype A). The strict core shape caused 40 type errors in 12 old
  movies backend files. To keep old movies running, the core tables had to keep four movies-only
  fields, and the core's `username` had to become optional. Because both share one `users` table,
  a user that the core's username provider created got a working movies session without movies'
  invite check, so every sign-up rule would have to hold in both codebases. Seven core tables clash
  with movies tables by name, so each later phase 3 PR would add more compatibility code, and the
  movies port would have to delete all of it.
- Renaming `packages/platform` to `packages/backend` after the movies port. The rename changes no
  behavior and only rewrites paths in scripts, CI, and docs.

## Edge cases settled

- A core session token does not work on old movies. Each deployment has its own signing keys, and
  prototype B showed old movies refusing a core token.
- `scripts/dev-stack.sh down` and `destroy` stop or remove both backends, and `destroy` also
  removes both data volumes.
- CI's stack job runs the core's suite (`pnpm --filter @media/platform test:stack`) on the same
  stack as old movies' suites.
