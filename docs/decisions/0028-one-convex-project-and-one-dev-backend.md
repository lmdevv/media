# 0028. One Convex project, and one backend in each dev stack

- Status: Accepted, 2026-11-12. Supersedes ADR 0023.
- Decisions: D04, D14, D22, D49

## Context

ADR 0023 ran the core in its own Convex project, `packages/platform`, while old movies kept
`packages/backend` until the movies port. Each worktree's dev stack ran both backends: old movies'
API on base and its HTTP actions on base + 1, and the core's on base + 4 and base + 5.

Movies now runs on the core. Its catalog and functions are in `packages/platform/convex/movies/`,
the server, the movies web client, and the image use only the core (ADR 0027), and the iOS app
and the CLI followed. Nothing calls old movies' backend, its SDK client, or the old command
registry, so `p4-movies-delete` deletes them.

## Decision

- `packages/platform` is the one Convex project. Core code stays in `convex/core/`, movies in
  `convex/movies/`, and music moves into `convex/music/` when it ports (ADR 0008). The package
  keeps its name: renaming it to `packages/backend` changes no behavior (ADR 0023).
- `scripts/dev-stack.sh up` runs one Convex backend, the core's, on the ports it already had:
  its API on base + 4 and its HTTP actions on base + 5. Every other port keeps its number: the
  media service on base + 2, the movies web dev server on base + 3, the account client on
  base + 6, and the sign-in boundary on base + 7. Base and base + 1 stay unused.
- A stack made by the old script comes up on `up` without a `destroy`: `up` removes the old movies
  container, `movies-convex-<name>`, and reuses the core's container and volume. `down` removes the
  old container too, and `destroy` removes its volume with the core's.
- The media service's own HTTP commands (`libraries.folders`, `metadata.searchCandidates`,
  `backups.restore`, `imports.*`, and `diagnostics.*`) are declared in
  `@media/contracts/media-commands`. The command list in `packages/commands` declares every Convex
  function (ADR 0009). `PlaybackTokenInvalid`, which the byte routes answer for a refused ticket,
  lives in `@media/contracts/media-playback`.

## Consequences

- Each dev stack idles one Convex backend lighter, and a cold `up` deploys one project.
- Ports in `AGENTS.md`, `scripts/dev-stack.sh env`, the clients' `.env.local` files, and the stack
  suites do not move, so no client, test, or skill changes with this ADR.
- The server's unit tests sign their own HMAC test tokens (`apps/media/src/testing/test-tokens.ts`);
  production byte routes take only core tickets (ADR 0011). The byte routes' grant interface,
  which both implement, is `apps/media/src/playback/playback-grants.ts`.
- Old movies stays readable in history for parity checks, as
  `git show 76c804ce:packages/backend/...` from the last commit before the deletion.

## Alternatives rejected

- Moving the core to base and base + 1. It would free two port numbers but move every port that
  clients, suites, the verify skill, and existing `.env.local` files already use, and an old stack's
  core container would need new published ports and origins on its next `up`.
