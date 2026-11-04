# legacy/music

The old [music] code, imported with its history from `lmdevv/music`, which is archived. It stays
runnable until the music port onto the [media] core lands, then it is deleted. The root `CLAUDE.md`
holds the shared rules for copyleft, coding standards, secrets, lint, mocks, commits, PRs, review,
pstack, and design, including the `[music]` Paper file. This file adds only what the old music code
needs, and wins where the two differ for code under `legacy/music`.

## Rules

- **Nested workspace.** Run every command below from `legacy/music`, after its own `pnpm install`.
  Root checks and the root hook skip this folder. Paths in root rules, such as `packages/ui`,
  resolve inside this folder when you work here.
- **Effect runs in Convex here.** This folder's `pnpm-workspace.yaml` pins `effect` 4.0.3, the
  version root pins, and some Convex functions use Effect. Follow the surrounding code, not root's
  plain-TypeScript Convex rule.
- **pstack model choices live in the root `.agents/pstack-models.md`.** This folder's
  `.claude/rules/pstack-models.md` and `.agents/pstack/` are left over from the old repo.
- **No MCP server.** Agents use the CLI and `skills/music/SKILL.md`.

## Layout

| Path                | Role                                                       |
| ------------------- | ---------------------------------------------------------- |
| `apps/web`          | Vite + React + TanStack Router client app                  |
| `apps/media`        | Node + Hono + Effect media service                         |
| `apps/mobile`       | Expo + Expo Router + Uniwind iOS app                       |
| `apps/cli`          | CLI generated from the command registry                    |
| `packages/backend`  | Convex functions, schema, and auth                         |
| `packages/commands` | Every user action as an Effect Schema                      |
| `packages/sdk`      | Typed client shared by all clients                         |
| `packages/player`   | `PlayerEngine`: MSE gapless engine and HTML audio fallback |
| `packages/ui`       | shadcn components restyled through Paper tokens            |
| `packages/config`   | Shared strict `tsconfig`                                   |
| `skills/music`      | Agent skill for the CLI                                    |
| `deploy/docker`     | Multi-arch image with Convex, Caddy, and s6                |
| `nix/`              | NixOS module (runs the image; native units are planned)    |

Ownership: Convex is the only source of truth for product state. The media service is the only
process that touches files, and it never decides access. Convex never calls the media service; the
media service subscribes to the `jobs` table.

## Commands

```sh
nix develop          # Node 24, pnpm, ffmpeg, Caddy
pnpm install         # also patches tsc and Oxlint with Effect diagnostics
scripts/dev-backend.sh [name] [port]  # self-hosted Convex in Docker, deployed and configured
pnpm dev             # web on :3001, media service, and Convex dev
pnpm typecheck       # tsc 7 with the Effect language service
pnpm lint            # Oxlint, type-aware, anti-slop and Effect rules
pnpm fmt:check       # Oxfmt
pnpm test            # Vitest
pnpm test:e2e        # Playwright
pnpm knip            # unused files, exports, and dependencies
scripts/stack-e2e.sh # build the image and run the real-stack E2E suite against it
scripts/ios-mac.sh build-sim <udid>  # build the iOS dev client on a Mac over ssh (apps/mobile/README.md)
```

`typecheck`, `lint`, `fmt:check`, and `test` run in the root CI's `legacy/music checks` job, not in
a pre-commit hook. Run all four before every commit to legacy/music.

Use `scripts/dev-backend.sh` for a local self-hosted Convex; pick a different name and port per
worktree. Commit the regenerated `convex/_generated/`.

## Verify and review

- Ports: web dev on 3001, Playwright on `E2E_PORT` (3002), Convex on 3210 and 3211, media service
  on 4100, stack image on `PORT` (8090). `scripts/dev-backend.sh <name> <port>` moves a worktree's
  backend off the defaults.
- `pnpm test:e2e` needs a backend first: `WEB_PORT=3002 scripts/dev-backend.sh web 3510`. See
  `apps/web/e2e/README.md`.
- `scripts/stack-e2e.sh` needs Docker. `MUSIC_VIDEO=1` records video; results land in
  `apps/web/test-results/stack`. On NixOS, set `CHROMIUM_PATH=$(which chromium)`.
- Repeat runs: `pnpm --filter web exec playwright test --repeat-each=20`. For Vitest, use root's
  fresh-process loop, not `--repeats`; this folder pins the same `@effect/vitest` 4.0.3.
- Project skills in `.agents/skills/`, pinned in `skills-lock.json`: `react-doctor`,
  `react-best-practices`, and `diagnosing-bugs`. They're all model-invoked. `verify-music` is this
  repo's own: it runs disposable servers built from the checkout and from main, drives the web app,
  the CLI, and the iOS app on a simulator, and publishes the evidence to a PR. Its servers share
  one set of demo data: the demo library image (`docs/demo-music.md`) and four seeded people with
  their playlists and likes. Use that data, never your own music, in screenshots and recordings.
- Prove a user-facing change with `verify-music` before you open its PR. A PR that changes what a
  user sees carries before and after screenshots of each changed screen, at desktop and phone size
  on the web, and a short video of the changed flow, published with `evidence publish`. When a PR
  changes nothing a user sees, say so under its verification notes instead.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
