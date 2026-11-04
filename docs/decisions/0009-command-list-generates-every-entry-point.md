# 0009. Declare each action once and generate its Convex function and clients

- Status: Accepted, 2026-11-03. Amended 2026-11-04 with the generator's layout.
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
- Crons and functions that only other Convex functions call stay plain internal Convex functions.
- Calls the server makes, such as scanner callbacks and job claims, are public Convex functions that
  check the `media-service` scope of the server's API-key session (ADR 0010). An internal function
  cannot be called from outside Convex, so these cannot be internal. They are not commands.

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
- Internal functions and server-only functions never appear in the SDK, the CLI, or the command
  menu.
- Commands live in a domain group, such as `music.playlists`, which is the light seam for later
  products (ADR 0002).

## Layout (amended 2026-11-04)

The first generator settled how declarations, outputs, and checks fit together.

- A declaration lives in `packages/commands/src/<domain>.ts`, such as
  `query("core.server.info", { summary, scope, args, result })`. The name is the domain, the
  module path, and the function, so `core.server.info` is the Convex function `core/server:info`.
- `pnpm --filter @media/commands generate` refuses a declaration with no scope, an unknown scope
  or kind, `v.any()`, an optional result, a summary that is not one line, or a name that is
  duplicated, malformed, or a reserved word. It names every refusal and writes nothing.
- Each output is a folder the generator owns. It deletes a generated file that no command writes
  anymore. A file it did not write stops it, and it deletes nothing it did not write.
  - `packages/platform/commands/` holds one contract per Convex module, with the module's
    validators, a `Handlers` type, and `register`. It also holds the caller scopes and
    `refs.ts`.
  - `apps/cli/skills/media/references/<domain>.md` is the skill's reference for each domain.
- The Convex module at the command's path, such as `packages/platform/convex/core/server.ts`, is
  hand-written and calls its contract's `register`. A module can hold commands, internal
  functions, and server-facing functions side by side.
- A missing, extra, or mistyped handler fails `tsc`. `refs.ts` checks each command's `api`
  reference, so a missing module or a stale `convex/_generated` also fails `tsc`.
- Lint bans the public `query`, `mutation`, and `action` builders in `packages/platform/convex/`,
  so every public function goes through a contract's `register` and its scope check. The
  server-facing functions get their own guarded builder when the server moves onto the core.
- The scopes are `public`, `signed-in`, and the credential scopes in
  `packages/commands/src/scopes.ts`, which start with `account` (ADR 0004). A scoped command's
  handler receives the caller from the sign-in interface in `convex/core/auth/caller.ts`:
  `requireCaller` for a query or mutation and `requireActionCaller` for an action, which has no
  `db`. Every handler's `ctx` lacks `auth`, so a handler can learn its caller only from that
  argument.
- `pnpm --filter @media/commands check` runs in the pre-commit hook and in CI's `check` job on
  every change. It fails on a stale, missing, or leftover output in any package.
- `generate` also runs `convex codegen` when the worktree has a dev stack. A command in a new module
  needs one more run after its module is written, and `refs.ts` fails `tsc` until then.
- The SDK, CLI, and command-menu outputs each add one target: a folder and the function that
  writes it.

Rejected for this layout:

- Generated Convex modules at the command's path that call hand-written `*.handlers.ts` files. A
  module could not hold internal or server-facing functions, and finding generated files among
  hand-written ones needs a marker scan.
- A drift test that runs only through the package graph, with `@media/commands` depending on
  every package it writes into. Every declaration edit would typecheck the old CLI and its
  dependencies, and the check would run only where the graph routes it.
