# Lar

Lar is an MIT-licensed, self-hosted media platform: movies, TV, and music streamed from the
user's own folders, with one server

Read before planning: `docs/architecture.md`, `docs/decisions/` (ADRs), and `docs/development.md`
for the dev stack, stack suites, and CI.

## Rules

- **Copyleft code is read-only.** Jellyfin, Silo, Kyoo, Wholphin, Streamyfin, Navidrome, Immich,
  Nextcloud, and Audiobookshelf may be read for ideas; never copy, port, or translate their code.
- **TypeScript:** load the `coding-standards` skill first. This file wins where they conflict.
- **Effect 4:** read `LLMS.md` in `.repos/effect-smol` before writing Effect code. If missing:
  `git clone --depth 1 --branch effect@4.0.3 https://github.com/Effect-TS/effect .repos/effect-smol`
  (match the version pinned in `pnpm-workspace.yaml`). Never import from or edit it.
- **Convex functions are plain TypeScript** with `v` validators. Effect lives in the media
  service, contracts, SDK, and CLI.
- **Never weaken a lint rule or add a suppression to pass checks.** Fix the code or report it.
  Casts other than `as const` need a `// SAFETY:` comment.
- **No module mocks.** Test through real seams.
- **Comments and docs say what the code does now**, not what came before;
  `scripts/check-history.sh` enforces it.

## Web UI

- **Route loaders wait only for the data that decides a page's layout.** They start the rest with
  `void query.preload(args)`, and the SDK keeps both live for the page.
- **Loaders never preload the signed-in session** (`core.auth.sessions.current`). The signed-in
  shell owns that query and its failure screen.

## Commits and PRs

- Format: `type(scope): summary`, imperative and lowercase. Types: `feat`, `fix`, `chore`, `docs`,
  `test`, `refactor`, `migrate`, `update`, `perf`, `build`, `ci`. Optional bullet body for why.
- Add a `Refs:` trailer for known PRs and issues, then `Co-authored-by` trailers for the model
  and tool that contributed (`noreply@anthropic.com` / `noreply@openai.com`). Keep them through
  rebases and squashes.
- PR descriptions lead with the problem and resulting behavior, then validation. Re-check the
  title and description against the final diff before merging.
