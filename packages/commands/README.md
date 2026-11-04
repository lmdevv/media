# @media/commands

The command list: every user, client, or agent action, declared once (ADR 0009). The generator
writes each command's Convex registration and the agent skill's reference from it.

To add a command:

1. Declare it in `src/<domain>.ts`, such as `query("core.server.info", { ... })`. The name maps to
   the Convex function `core/server:info`.
2. Run `pnpm --filter @media/commands generate`.
3. Write its handler in the Convex module the name maps to, such as
   `packages/platform/convex/core/server.ts`, by passing it to that module's `register` from
   `packages/platform/commands/`. `tsc` names a missing or mistyped handler.
4. For a new module, run `generate` again with the dev stack up (`scripts/dev-stack.sh up`), so it
   refreshes `packages/platform/convex/_generated`.

Never edit `packages/platform/commands/` or `apps/cli/skills/media/references/`, and keep other
files out of them. The generator owns both, and `pnpm --filter @media/commands check` fails the
commit when they drift from the list.
