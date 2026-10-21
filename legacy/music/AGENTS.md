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
  in `.agents/skills/coding-standards/`, copied from `dmmulroy/.dotfiles` at `574e1f2`; Dillon has
  since removed it, so don't `skills update` it. Where any skill conflicts with this file, this file
  wins: no lint suppressions or disabled rules, even where a skill shows them.
- **No MCP server.** Agents use the CLI and `skills/music/SKILL.md`.
- **Never commit secret values.** `.env.example` lists configuration names only.
- **Never weaken a lint rule, add a cast, or add a suppression to pass checks.** Fix the code or
  report the finding. Casts other than `as const` need a `// SAFETY:` comment.
- **No module mocks.** Test through real seams.

## Layout

| Path                | Role                                                       |
| ------------------- | ---------------------------------------------------------- |
| `apps/web`          | Vite + React + TanStack Router client app                  |
| `apps/media`        | Node + Hono + Effect media service                         |
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
pnpm install         # also patches tsc and Oxlint with Effect diagnostics, installs lefthook
scripts/dev-backend.sh [name] [port]  # self-hosted Convex in Docker, deployed and configured
pnpm dev             # web on :3001, media service, and Convex dev
pnpm typecheck       # tsc 7 with the Effect language service
pnpm lint            # Oxlint, type-aware, anti-slop and Effect rules
pnpm fmt:check       # Oxfmt
pnpm test            # Vitest
pnpm test:e2e        # Playwright
pnpm knip            # unused files, exports, and dependencies
scripts/stack-e2e.sh # build the image and run the real-stack E2E suite against it
```

`typecheck`, `lint`, `fmt:check`, and `test` run in the lefthook pre-commit hook and in CI. All
four must pass before every commit.

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
- Repeat runs: `pnpm --filter web exec playwright test --repeat-each=20`, `pnpm test --repeats=20`.
- Project skills in `.agents/skills/`, pinned in `skills-lock.json`: `before-and-after` attaches UI
  captures to a PR with `.agents/skills/before-and-after/scripts/format.mjs` and Vercel's
  `agent-browser` CLI (`npm i -g agent-browser && agent-browser install`), plus `react-doctor`,
  `react-best-practices`, and `diagnosing-bugs`. They're all model-invoked.
- `main` requires the `check` and `stack-e2e` CI jobs. PRs matching the `paths` in
  `.github/workflows/image.yml` also run the `Image` workflow; check it too. Never merge with admin
  bypass.
- Every PR gets CodeRabbit (`.coderabbit.yaml`), Codex automatic review, and Claude's
  `/code-review`. Don't add a project skill named `code-review`; it shadows Claude's.
- Cloud environments: none yet. Pin the Claude one in `.claude/settings.json`
  (`remote.defaultEnvironmentId`) and write the Codex ID here for `codex cloud exec --env`. Docker
  suites run in Claude cloud only.

## pstack

[pstack](https://github.com/cursor/plugins/tree/main/pstack) is Lauren Tan's skill stack. Start
rigorous work with `poteto-mode`. Where a pstack skill conflicts with this file, this file wins.

- Claude Code: `.claude/settings.json` enables `pstack@cursor-plugins`. Skills are `/pstack:<name>`.
  Model roles are in `.claude/rules/pstack-models.md`, which Claude Code loads on its own.
- Codex: install once per machine with `codex plugin marketplace add cursor/plugins` and
  `codex plugin add pstack@cursor-plugins`. Skills are `$pstack:<name>`. Before you follow a pstack
  skill, read `.agents/pstack/codex.md`. Model roles are in `.agents/pstack/codex-models.md`.
- Model agreement: each tool writes code with its session model and runs judgment roles at high
  effort. Every review panel pairs Opus with GPT-6.1-Sol by calling the other tool's CLI, as
  `.agents/pstack/cross-tool.md` describes. Change both model files together.

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
