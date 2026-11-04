# 0009. Declare each action once and generate its Convex function and clients

- Status: Accepted, 2026-11-03
- Decisions: D23

## Context

Both repos list user actions in one place, in different ways.

- Movies lists each action in `@movies/contracts/commands` with Effect Schema args and results. The
  Convex functions are written by hand with `v` validators, and
  `packages/backend/test/registry.test.ts` checks that the two sides describe the same wire
  values. The SDK, CLI, and command menu are generated from the list.
- Music's `packages/commands` holds a registry, and `packages/backend/convex/commands.ts` runs it
  through two string dispatchers that take `args: v.any()`. Convex never sees the real arguments,
  so it cannot validate them, and every action shares one function's logs and metrics.

## Decision

- Every user, client, or agent action is declared once in `packages/commands`. A declaration names
  the command, its kind, its required scope, a summary, and its args and result as `v` validators.
- A generator emits, for each command:
  - one real Convex function, such as `api.music.playlists.create`,
  - the SDK method,
  - the CLI command,
  - the command-menu entry,
  - the agent skill's reference.
- Convex runs no Effect runtime.
- Internal functions stay plain internal Convex functions. These are scanner callbacks, crons, and
  calls only the server makes. They are not commands.

## Consequences

- Each command gets Convex argument validation, its own logs, and its own metrics.
- Adding an action is one declaration plus its handler. The SDK, CLI, command menu, and skill
  reference follow from the generator, so they cannot drift from the backend.
- Convex functions stay plain TypeScript, as `CLAUDE.md` requires.

## Alternatives rejected

- Music's string dispatcher with `v.any()` args. It loses Convex argument validation and
  per-function logs and metrics.
- An Effect runtime inside Convex. Effect stays in the server, contracts, SDK, and CLI.

## Edge cases settled

- A command's required scope is part of its declaration (ADR 0005), so every generated entry point
  checks the same scope.
- An internal function never appears in the SDK, the CLI, or the command menu.
- Commands live in a domain group, such as `music.playlists`, which is the light seam for later
  products (ADR 0002).
