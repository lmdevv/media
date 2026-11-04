# @media/commands

The command list: every user, client, or agent action, declared once (ADR 0009). The generator
writes each command's Convex registration, its SDK method, its CLI command, and the agent skill's
reference from it.

To add a command:

1. Declare it in `src/<domain>.ts`, such as `query("core.server.info", { ... })`. The name maps to
   the Convex function `core/server:info`.
2. Run `pnpm --filter @media/commands generate`.
3. Write its handler in the Convex module the name maps to, such as
   `packages/platform/convex/core/server.ts`, by passing it to that module's `register` from
   `packages/platform/commands/`. `tsc` names a missing or mistyped handler.
4. For a new module, run `generate` again with the dev stack up (`scripts/dev-stack.sh up`), so it
   refreshes `packages/platform/convex/_generated`.

The SDK method and the CLI command need no step of their own: `generate` writes them into
`packages/sdk/src/platform/generated/` and `apps/cli/src/generated/`, so
`platform.core.server.info()` and `media auth server info` exist after the first run. The CLI
path follows from the name and the scope (ADR 0021): admin-scoped commands go under
`media admin`, the core's others under `media auth`, then the module's last segment and the
function. `generate` refuses two commands on one path.

Never edit `packages/platform/commands/`, `packages/sdk/src/platform/generated/`,
`apps/cli/src/generated/`, or `apps/cli/skills/media/references/`, and keep other files out of
them. The generator owns all four, and `pnpm --filter @media/commands check` fails the commit
when they drift from the list.
