# 0009. Declare each action once and generate its Convex function and clients

- Status: Accepted, 2026-11-03. Amended 2026-11-04 with the generator's layout, and again on
  2026-11-04 with `refusesKeys` and with the SDK target. Amended 2026-11-09 with the movies
  commands.
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

## Refusing API keys (amended 2026-11-04)

- A declaration can set `refusesKeys: true`. The generated function then passes the caller
  through `refuseKeys` in `convex/core/auth/caller.ts`, which refuses an API-key session with
  `forbidden` even when the key holds the scope. The skill reference prints "API keys: refused".
- `check` refuses `refusesKeys` on a `public` command, which has no session to refuse.
- A command sets it when it makes something that would outlive a leaked key's revocation: a key,
  a device sign-in, a user, a link, a role change, a handover, or a new username or password
  (ADR 0004). `core.auth.apiKeys.create` and `core.auth.deviceCodes.approve` moved their
  hand-written checks onto it.
- The sign-ins that make or reset an account (`setup`, `invite`, `reset`) are Convex Auth
  providers, not commands, like the other sign-ins (ADR 0004). The generator writes nothing for
  them.

## The SDK target (amended 2026-11-04)

The SDK target settled how one declaration becomes a method in `/effect`, `/promise`, and `/react`.

- **What the generator writes.** `sdkTarget` owns `packages/sdk/src/platform/generated/` and writes
  one file, `commands.ts`. For each command it holds a private declaration with the Convex
  function's path and Effect schemas for its arguments and result, rendered from the same parsed
  validators as the platform contract. It exports two trees nested by name, `effectMethods` and
  `promiseMethods`. Each leaf carries the command's summary, kind, scope, and `refusesKeys` as
  JSDoc, so the method's hover shows them.
- **One method per command, one call path.** Each tree takes a builder from
  `packages/sdk/src/platform/`, and every leaf is `method.query(...)`, `method.mutation(...)`, or
  `method.action(...)`. The builders are hand-written, so call policy has one owner: arguments are
  encoded before they leave (`InvalidArgs`), results are decoded (`ProtocolError`), and queries get
  `watch`. The generated file holds no policy.
- **Value mapping.** `v.number()` is `Schema.Finite`, so a non-finite answer is a protocol error.
  `v.id("t")` is a string branded `Id<t>`, so an ID from one result passes into another command's
  arguments and an ID of the wrong table does not type-check. `v.int64()` is `Schema.BigInt` and
  `v.bytes()` is an `ArrayBuffer`. An optional field is an absent key. Arguments must encode to a
  JSON object, so a command that takes an `int64` or `bytes` argument fails the SDK's `tsc` until
  the transport carries Convex values. No command takes one today.
- **Errors.** Calls fail with `PlatformError`, the contracts' tagged errors without
  `StaleRevision`, plus `TransportError` and `ProtocolError`. The platform never sends
  `stale_revision`, so the client turns one into `ProtocolError`. A session without the command's
  scope gets `Forbidden`. An ended session gets `Unauthenticated`.
- **Sign-in.** The platform client reuses the session engine in `auth.ts`
  (`Auth.makeEngine`): refresh, stalls, reconnects, and sign-out. A command that comes back
  `Unauthenticated` asks for one forced refresh, so a session ended elsewhere reads signed out at
  once (D51, ADR 0021). The engine signs in with a
  provider and its params. `Auth` keeps its movies credentials and public interface over it. The
  platform client sends `password` with `{ username, password }`, `apiKey` with `{ key }`, and
  polls `deviceCode` with `{ deviceCode }`, which answers `pending` or `denied` until a session
  approves the code (ADR 0004). The account sign-ins are credentials too: `setup` with
  `{ username, password }`, `invite` with `{ code, username, password }`, and `reset` with
  `{ code, password }` (ADR 0003).
- **Beside the movies client.** The platform client opens its own connection and session, so an
  app or the CLI can hold both clients until movies moves onto the platform. Phase 4 deletes the
  movies client (`movies.ts`, `movies-client.ts`, `device-login.ts`, `QueryWatch.make`,
  `MoviesProvider` and its hooks, `createMovies`), the movies credentials in `auth.ts`, and the
  SDK's use of `@media/contracts/commands`. Movies commands then appear as
  `platform.movies.*` from the same generator.
- **One sign-in on the web.** Clients that store their session under one key share it.
  `createPlatform` and `PlatformProvider` default to `media.session`, so every web client on one
  origin shares one sign-in (ADR 0020).

Rejected for the SDK target:

- One generated data tree, with each entry point's methods derived by a recursive mapped type and
  a runtime walk. The walk's result needs an unchecked assertion, which lint refuses, and the walk
  types its leaves with `object` or `unknown`, which lint also refuses. Two generated trees cost a
  few bytes per command and need no assertion.
- Emitting `v` validators into the SDK and checking values with a hand-written walk over them. It
  parses by hand where the SDK parses with Effect Schema, and the CLI needs schemas to read flags.
- Methods keyed by name, such as `client.query("core.server.info", args)`. The caller picks the
  kind, and no method has its own hover.
- A copy of `Auth` for the platform. Every refresh fix would land twice.

## The movies commands (amended 2026-11-09)

The movies port declares old movies' actions as the `movies` domain, so the core serves them and
the same generator run writes every entry point.

- **Where they live.** The declarations are in `packages/commands/src/movies.ts`, beside
  `core.ts`, each with a `movies:read`, `movies:play`, or `movies:edit` scope (`domain-scope` in
  `check.ts` refuses anything else). Their handlers are in `packages/platform/convex/movies/`.
  `people.ts` and `metadata.ts` hold commands beside the server functions the scanner and
  metadata jobs call, as the layout above allows.
- **What one run writes.** One `pnpm --filter @media/commands generate` writes a contract per
  movies module under `packages/platform/commands/movies/`, `platform.movies.*` in the SDK's
  `/effect`, `/promise`, and `/react` entry points, the `media movies` group of the CLI, and
  `apps/cli/skills/media/references/movies.md`. A second run writes nothing.
- **What came over.** Home rows, the title list with its filters, genres, search, similar
  titles, a title with its seasons, episodes, versions, and credits, the next episode, a person
  and people search, collections, the caller's list, continue watching and history, marking
  watched, starting playback, progress reports online and offline, and metadata match, refresh,
  and edits. Profiles, rooms, playback sessions, the active-playback list, and token renewal do
  not: a person replaces a profile (ADR 0003), group sessions replace rooms (ADR 0017), and a new
  start replaces renewal (ADR 0011). Searching TMDB for match candidates runs on the server, not
  in Convex, and moves with the server's adapters.
- **Old words beside the new.** `media movies ...` reaches the core. The old movies server's
  words stay at the top level of `media` (`media search`, `media play`) until the CLI folds onto
  the core, and the skill names a reference for each.
- **One paginated query per call.** Convex runs one paginated query in each function, so a list
  that crosses rows of several index ranges, such as the title list across libraries, pages one
  range per call and carries which range it is in inside its cursor (ADR 0005).
