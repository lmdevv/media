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

The web apps share one focus policy, `packages/ui/src/lib/focus-policy.ts`:

- **Shortcuts are global.** They yield only to text fields, open menus and dialogs, and the keys a
  focused control uses itself: Enter on any control, Space on a checkbox, switch, or radio, arrows
  on a slider. Space on a focused button plays or pauses; it does not press the button.
- **A pointer click leaves nothing focused.** Text fields and sliders keep the focus a click gives
  them.
- **Focus returns to an overlay's opener only after a keyboard open.** Build overlays on the
  shared wrappers, which apply `useKeyboardFocusReturn`.
- **Focus rings stay.** `:focus-visible` shows them after keyboard use; never remove or hide them.

## Commits and PRs

- Format: `type(scope): summary`, imperative and lowercase. Types: `feat`, `fix`, `chore`, `docs`,
  `test`, `refactor`, `migrate`, `update`, `perf`, `build`, `ci`. Optional bullet body for why.
- Add a `Refs:` trailer for known PRs and issues, then `Co-authored-by` trailers for the model
  and tool that contributed (`noreply@anthropic.com` / `noreply@openai.com`). Keep them through
  rebases and squashes.
- PR descriptions lead with the problem and resulting behavior, then validation. Re-check the
  title and description against the final diff before merging.
