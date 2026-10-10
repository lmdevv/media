# [music]

MIT-licensed, agent-first, self-hosted music platform. It streams the user's own on-disk library
from one install: a container image or a NixOS package. The product name is `[music]`, brackets
included; the repo and packages use `music`.

- Plan: [Linear project](https://linear.app/adsfsd/project/music-8c860e163f25). It holds the
  overview, stack, architecture, and design summary.
- MVP: server, web app, and CLI with an agent skill. Native apps are V1.

## Rules

- **GPL and AGPL code is read-only.** Navidrome (GPL-3.0) and Immich (AGPL-3.0) may be read for
  ideas and edge cases. Never copy, port, or translate their code into this repo. Effect, OpenCode,
  and Pi are MIT and safe to reference.
- **Load the `coding-standards` skill** before writing, reviewing, or refactoring TypeScript. It is
  in `.agents/skills/coding-standards/`.
- **No MCP server.** Agents use the CLI and `skills/music/SKILL.md`.
- **Never commit secret values.** `.env.example` lists configuration names only.
- **Never weaken a lint rule, add a cast, or add a suppression to pass checks.** Fix the code or
  report the finding. Casts other than `as const` need a `// SAFETY:` comment.
- **No module mocks.** Test through real seams.

## Layout

| Path                | Role                                                   | Milestone |
| ------------------- | ------------------------------------------------------ | --------- |
| `apps/web`          | Vite + React + TanStack Router client app              | 4         |
| `apps/media`        | Node + Hono + Effect media service                     | 3         |
| `apps/cli`          | Effect CLI generated from the command registry         | 6         |
| `packages/backend`  | Convex functions, schema, and auth                     | 2         |
| `packages/commands` | Every user action as an Effect Schema                  | 2         |
| `packages/sdk`      | Typed client shared by all clients                     | 2 to 6    |
| `packages/player`   | `PlayerEngine`, MSE gapless engine, Web Audio fallback | 4         |
| `packages/ui`       | shadcn components restyled through Paper tokens        | 4         |
| `packages/config`   | Shared strict `tsconfig`                               | done      |
| `skills/music`      | Agent skill for the CLI                                | 6         |
| `deploy/docker`     | Multi-arch image with Caddy and s6                     | 7         |
| `nix/`              | NixOS module and the packaged Convex binary            | 7         |

Ownership: Convex is the only source of truth for product state. The media service is the only
process that touches files, and it never decides access. Convex never calls the media service; the
media service subscribes to the `jobs` table.

## Commands

```sh
nix develop          # Node 24, pnpm, ffmpeg, Caddy
pnpm install         # also patches tsc and Oxlint with Effect diagnostics, installs lefthook
pnpm dev             # web on :3001 and Convex dev
pnpm typecheck       # tsc 7 with the Effect language service
pnpm lint            # Oxlint, type-aware, anti-slop and Effect rules
pnpm fmt:check       # Oxfmt
pnpm test            # Vitest
pnpm test:e2e        # Playwright
pnpm knip            # unused files, exports, and dependencies
```

`typecheck`, `lint`, `fmt:check`, and `test` run in the lefthook pre-commit hook and in CI. All
four must pass before every commit.

For local Convex without an account: `CONVEX_AGENT_MODE=anonymous pnpm exec convex dev` in
`packages/backend`. Commit the regenerated `convex/_generated/`.

## Design

Build UI from the Paper file `[music]` (ID `01M4KQQQ46CWH4S1JGX96NPA0T`) through the Paper MCP.
Paper Desktop must be running.

- Paper is the source of truth. Read structure with `get_tree_summary` and `get_jsx`, exact values
  with `get_computed_styles`, and the target with `get_screenshot`. Never read colors or sizes from
  screenshots.
- Tokens live in `packages/ui/src/styles/globals.css` under their Paper names. Re-export them with
  `get_tokens` in `tailwind` format when the design changes. Dark mode maps each `--color-dark-*`
  token onto its light role inside `.dark`.
- Use tokens for every color, size, and font. No raw values in components.
- Light mode follows Apple Music (red accent); dark mode follows Spotify (green accent, rounded
  panels on black). Phone layouts feel native to iOS.
- Follow the design handoff note in the owner's vault (`projects/music/music Design.md`): flows,
  artboard map, decisions, and open questions. If code must differ from Paper, flag it instead of
  drifting.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
