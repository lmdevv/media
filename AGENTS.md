# [media]

MIT-licensed, agent-first, self-hosted media platform. It streams the user's own folders or NAS
shares, and it is merging [movies] and [music] into one server, one Convex database, and one
account system with a branded client per product. `[media]`, brackets included, is the working
name until a later rebrand. The repo is `lmdevv/media`, the workspace scope is `@media/*`, settings
start with `MEDIA_`, the CLI binary is `media`, and the image is `ghcr.io/lmdevv/media`.

- Plan: `docs/architecture.md`, the ADRs in `docs/decisions/`, and the
  [Linear Platform project](https://linear.app/adsfsd/project/platform-c8c8792e24e6).
- MVP: media service, web app, SDK, and CLI with an agent skill. Native mobile and TV apps are V1.

## Rules

- **Copyleft code is read-only.** Jellyfin (GPL-2.0), Silo (AGPL-3.0), Kyoo (GPL-3.0), Wholphin
  (GPL), Streamyfin (MPL-2.0), Navidrome (GPL-3.0), Immich (AGPL-3.0), Nextcloud (AGPL-3.0), and
  Audiobookshelf (GPL-3.0) may be read for ideas and edge cases. Never copy, port, or translate
  their code into this repo. SyncLounge and stremio-core are MIT and may be reused with
  attribution. Effect, T3 Code, OpenCode, and Pi are MIT and safe to reference.
- **Load the `coding-standards` skill** before writing, reviewing, or refactoring TypeScript. It is
  in `.agents/skills/coding-standards/`, copied from `dmmulroy/.dotfiles` at `574e1f2`; Dillon has
  since removed it, so don't `skills update` it. Where any skill conflicts with this file, this file
  wins: no lint suppressions or disabled rules, even where a skill shows them.
- **Effect 4 reference.** `effect` is pinned in `pnpm-workspace.yaml`. Keep a read-only clone of
  the matching `Effect-TS/effect-smol` tag in `.repos/effect-smol` (gitignored) and read its
  `LLMS.md` before writing Effect code. Do not import from or edit it.
- **Convex functions stay plain TypeScript** with `v` validators. Effect lives in the media
  service, contracts, SDK, and CLI.
- **No MCP server.** Agents use the CLI and `apps/cli/skills/media/SKILL.md`, which loads one
  reference per domain on demand.
- **Never commit secret values.** `.env.example` lists configuration names only.
- **Never weaken a lint rule, add a cast, or add a suppression to pass checks.** Fix the code or
  report the finding. Casts other than `as const` need a `// SAFETY:` comment.
- **No module mocks.** Test through real seams.

## Layout

| Path                 | Role                                                                |
| -------------------- | ------------------------------------------------------------------- |
| `apps/web-movies`    | `@media/web-movies`: Vite + React + TanStack Router SPA, `/movies`  |
| `apps/media`         | `@media/server`: Effect HttpApi media service; serves the SPA       |
| `apps/cli`           | Effect CLI with JSON output; agent skill in `skills/media/`         |
| `apps/mobile`        | Expo + Expo Router + Uniwind iOS app over `@media/sdk/react`        |
| `packages/backend`   | Old movies' Convex schema, functions, and Convex Auth               |
| `packages/platform`  | The core's Convex project; movies and music port into it (ADR 0023) |
| `packages/contracts` | Effect Schema DTOs, errors, media HttpApi, plugin role interfaces   |
| `packages/sdk`       | Effect core with `/effect`, `/react`, `/promise` entry points       |
| `packages/ui`        | shadcn components restyled through Paper tokens                     |
| `packages/config`    | Shared strict `tsconfig`                                            |
| `deploy/image`       | All-in-one image: the core's Convex backend, media, and Caddy (s6)  |
| `deploy/compose`     | Docker Compose: the image plus optional sidecars                    |
| `nix/`               | NixOS module                                                        |
| `legacy/music`       | Old [music] code, runnable until the music port deletes it          |

Ownership: Convex owns accounts, profiles, grants, libraries, titles, files, jobs, watch history,
and playback sessions. Disk owns original media, which is read-only. The media service owns
per-device streams, ffmpeg processes, and temporary segments. Convex never calls the media
service; the media service signs in with a restricted credential and subscribes outward.

The SDK core has no Node filesystem or DOM imports. Media and backend modules must never reach
browser bundles.

## Commands

```sh
nix develop          # Node 24, pnpm, ffmpeg
scripts/dev-stack.sh up  # isolated Convex backend for this worktree
pnpm install         # also patches tsc and Oxlint with Effect diagnostics, installs lefthook
pnpm dev             # web on :3001 and Convex dev
pnpm typecheck       # tsc 7 with the Effect language service
pnpm lint            # Oxlint, type-aware, anti-slop and Effect rules
pnpm fmt:check       # Oxfmt
pnpm test            # Vitest
pnpm test:e2e        # Playwright
pnpm knip            # unused files, exports, and dependencies
scripts/check-deploy.sh  # installs pin one Convex backend and expose every media setting
```

`typecheck`, `lint`, `fmt:check`, `test`, `knip`, and `scripts/check-deploy.sh` run in the lefthook
pre-commit hook and in CI. All must pass before every commit. The hook and pull request CI run
typecheck, lint, and test only over the packages a diff affects and their dependents, and run
everything when a root config file changes; `scripts/changed-packages.sh` prints that set. CI on
`main` runs everything. A new media service setting goes in `deploy/image/rootfs/app/bin/init`,
`deploy/compose` (`compose.yaml`, `.env.example`), the root `.env.example`, `nix/module.nix`, and
both READMEs; `check-deploy.sh` names what is missing.

Each worktree gets its own stack: `scripts/dev-stack.sh up` starts two self-hosted Convex backends
in Docker, one for old movies and one for the core, deploys both, configures both backends' auth keys,
movies' playback token secret and media service credential, and writes the `.env.local` files. Ports, the data volume, and the temporary
output directory derive from the worktree name; `scripts/dev-stack.sh env` prints them, and
`down` / `destroy` stop or remove the stack. Commit the regenerated `convex/_generated/`.

`legacy/music` is a nested workspace outside the root one, with its own install, lockfile, and
checks. Root checks skip it. A commit that touches it runs its typecheck, lint, fmt:check, test,
and knip in the hook's `legacy` job, which needs its own install, and CI runs them in the
`legacy/music checks` job. Read `legacy/music/CLAUDE.md` before working there:

```sh
cd legacy/music && pnpm install
```

The Effect reference lives in `.repos/effect-smol`. Effect 4 stable releases are tagged in
`Effect-TS/effect`, so clone the tag matching the pinned version:
`git clone --depth 1 --branch effect@4.0.3 https://github.com/Effect-TS/effect .repos/effect-smol`.

## Contributing

### Commit messages

Use this structure for commit messages and PR titles:

```text
type(scope): summary
```

- Use `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `migrate`, `update`, `perf`, `build`, or `ci`
  for the type. Name the affected package or domain in the scope, such as `media`, `web`, or `sdk`.
- Write the summary in imperative present tense, lowercase, with no trailing period. Describe the
  concrete change, such as `fix(media): stop streams when playback ends`.
- Add an optional bullet body for substantial changes or notable impact. Explain why the change
  is needed, the resulting behavior, and any important risk, migration, or follow-up.
- Base the message on the staged diff. Replace vague messages such as `fix stuff` or `address
  review` with the actual change.
- Put relevant PR and issue references in a `Refs:` trailer, such as `Refs: #19, ADS-145`.
  Place it after any bullet body and before co-author trailers. Use known references only,
  deduplicate them, and omit the trailer when none apply. Preserve relevant references when
  rewording, rebasing, squashing, or merging commits.
- Every agent-created or agent-amended commit must include `Co-authored-by` trailers identifying
  the contributing model and coding tool. Read the actual identities from runtime context or
  configuration. Never silently omit attribution because a trailer was not supplied by the harness.
- Use `noreply@openai.com` for OpenAI models and Codex, and `noreply@anthropic.com` for Anthropic
  models and Claude Code. For other providers or tools, resolve their attribution address before
  committing. Do not invent model identities or addresses, and do not include thinking-level metadata.
- Deduplicate trailers and verify that attribution is present before every commit or amend.
  Preserve all contributing agents' trailers through rebases, squashes, and merges.

Example:

```text
docs(agents): define commit and pull request writing rules

- define commit titles and optional bodies so history explains each change.
- require PR descriptions and merge messages to match the final diff.

Co-authored-by: openai/gpt-6.1-sol <noreply@openai.com>
Co-authored-by: Codex <noreply@openai.com>
```

The example identities must be replaced with the model and tool that actually contributed.

### PR descriptions, rebases, and merges

- Write the PR description for a reviewer who has not read the conversation. Lead with the
  problem and resulting behavior. Include relevant validation results and material risks or
  migration steps. Keep simple changes to a short paragraph and validation notes.
- After scope changes or a rebase, and immediately before merging, compare the PR title and
  description with the final diff against the target branch. Rewrite stale or vague text, remove
  abandoned approaches, and update validation results. Report skipped or failing checks accurately.
- During a rebase, review the messages of commits that will remain in history. Reword vague or
  outdated messages and combine fixup commits where appropriate. Preserve valid co-author trailers.
- Before a squash or merge commit, explicitly review and improve its title and body using the
  same rules. Use the final PR title and description as the starting point, then remove review
  chatter and redundant commit lists. For a rebase merge, check each retained commit message.
- These writing checks supplement the verification and review requirements below.

## Verify and review

- Ports come from the worktree's stack: Convex API at base, auth at base + 1, media at base + 2, web
  at base + 3, the core's Convex API at base + 4, its HTTP actions at base + 5, and the account
  client at base + 6.
  `scripts/dev-stack.sh env` prints them. Playwright uses `E2E_PORT`, else the stack's
  web port, else 3011.
- Stack suites need Docker and `scripts/dev-stack.sh up`: `pnpm --filter <pkg> test:stack` for
  `@media/platform`, `@media/backend`, `@media/sdk`, `@lmdevv/movies`, and `@media/server`, then
  `pnpm --filter @media/web-movies exec playwright test`. For the migration suites, pull the pinned image
  (`docker pull` the `jellyfin/jellyfin:12.2@sha256:…` reference in `.github/workflows/ci.yml`)
  and set `MEDIA_JELLYFIN_DOCKER=1`; without the image the media suite skips the real-Jellyfin
  case silently, but the web migration spec starts Jellyfin anyway, pulling the image or failing.
- Repeat runs: `pnpm --filter @media/web-movies exec playwright test --repeat-each=20`, and for Vitest, fresh
  processes that stop at the first failure: `(for run in $(seq 20); do pnpm test <paths> || exit; done)`.
  Don't use Vitest's `--repeats`: `@effect/vitest` 4.0.3 counts each repeat as a finished test and
  closes a `layer(...)` early, which fails with missing files or `ECONNREFUSED`, not a product bug.
- Project skills in `.agents/skills/`, pinned in `skills-lock.json`: `react-doctor`,
  `react-best-practices`, and `diagnosing-bugs`. They're all model-invoked. `verify-media` is this
  repo's own: it runs disposable stacks built from the checkout and from main, each with movies and
  old music from `legacy/music`, drives both web apps, both CLIs, and the movies iOS app on a
  simulator, and publishes the evidence to a PR. Its stacks share one set of demo data: the demo
  library image (`docs/demo-library.md`) and four seeded people, the same in both apps, with their
  profiles, library access, watching, playlists, and likes. Use that data, never your own media,
  in screenshots and recordings.
- Prove a user-facing change with `verify-media` before you open its PR. A PR that changes what a
  user sees carries before and after screenshots of each changed screen, at desktop and phone size
  on the web, and a short video of the changed flow, published with `evidence publish`. When a PR
  changes nothing a user sees, say so under its verification notes instead.
- `scripts/stack-e2e.sh` builds the image and smoke-tests the packaged stack;
  `scripts/nixos-module-e2e.sh` does the same for the NixOS module on a NixOS host, and
  `nix build .#checks.x86_64-linux.vm -L` boots the module in a NixOS VM (needs KVM).
- `scripts/check-convex-argv.sh` runs the pinned Convex image as the NixOS module does and checks
  that the instance secret appears on no command line. Run it after a change to
  `nix/convex-entry.sh`, the module's Convex container, or `deploy/image/argv-secret.c`.
- `scripts/check-sandbox.sh` runs the media tests under the module's system call filter, on its
  Node and ffmpeg, in a `systemd-run --user` unit that kills on any denied call. Run it after a
  change to the media service's file or process handling, its dependencies, or the module's
  sandbox. Copy test files with `testing/byte-copies.ts`: `copyFile` calls `fchown`.
- CI runs `check`, `legacy/music checks`, both stack jobs, the sandbox job, and the Nix job. On a
  PR, the `changed workspaces` job skips each of the last five when the diff does not reach the
  workspaces it tests. PRs matching the `paths` in `.github/workflows/image.yml` also run its
  `build and smoke-test`. `main` has no branch protection, so check every one yourself before
  merging. Never merge with admin
  bypass.
- Run `/pstack:no-comments` on the diff before `/code-review` when a PR adds or changes comments,
  with or without `/pstack:poteto-mode`. Tell it to keep required `// SAFETY:` comments; its agent
  does not know this repo's rule.
- Every PR gets Codex automatic review on GitHub; address its findings before merging. Run
  Claude's `/code-review` locally before you open or merge one. Do not enable, request, or wait for
  CodeRabbit or Bugbot. Don't add a project skill named `code-review`; it shadows Claude's.
- Cloud environments: none yet. Pin the Claude one in `.claude/settings.json`
  (`remote.defaultEnvironmentId`) and write the Codex ID here for `codex cloud exec --env`. Docker
  suites run in Claude cloud only.

## Design

Build UI through the Paper MCP from the Paper file `[movies]` (ID `01M4PMRM5T60Q4P0YYZ8DY580D`) or
`[music]` (ID `01M4KQQQ46CWH4S1JGX96NPA0T`). Paper Desktop must be running.

- Paper is the source of truth. Read structure with `get_tree_summary` and `get_jsx`, exact values
  with `get_computed_styles`, and the target with `get_screenshot`. Never read colors or sizes from
  screenshots.
- Tokens live in `packages/ui/src/styles/globals.css` under their Paper names. Re-export them with
  `get_tokens` in `tailwind` format when the design changes. Dark maps each `--color-dark-*` token
  onto its light role inside `.dark`, and is the default theme in movies.
- Use tokens for every color, size, and font. No raw values in components.
- Movies: Netflix look on web, the Apple TV app look on iOS, Netflix red in both modes.
- Music: light follows Apple Music (red accent), dark follows Spotify (green accent, rounded panels
  on black). Phone layouts feel native to iOS.
- Content rules: no tips or filler copy, no CLI hints in the UI, no colored left stripes, and
  whitespace over bordered cards. One "Search ⌘K" field opens the command menu.
- Follow the design handoff notes in the owner's vault (`projects/movies/movies Design.md` and
  `projects/music/music Design.md`): flows, artboard map, decisions, and open questions. If code
  must differ from Paper, flag it instead of drifting.

## Pstack skills

Poteto's pstack is the Claude Code plugin `pstack@cursor-plugins`, enabled at project scope in
`.claude/settings.json`. Its commands take the `pstack:` prefix, such as `/pstack:poteto-mode`.
Do not copy its skills into `.agents/skills/`. Invoke `/pstack:poteto-mode` explicitly for a
substantial task; do not apply the whole workflow to every small edit or casual question.

Model choices live in `.agents/pstack-models.md`, not `~/.claude/rules/pstack-models.md` or
`~/.cursor/rules/pstack-models.mdc`. `/pstack:setup-pstack` writes there, and every pstack role
reads its line there.

This file takes precedence over pstack. Keep `coding-standards`, required `// SAFETY:` comments,
Codex automatic PR review, and Claude's local `/code-review`; do not request Bugbot or CodeRabbit.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
