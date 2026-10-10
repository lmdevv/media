# Upstream

- **Source:** https://github.com/timmo001/oxlint-rules
- **Commit:** `8b05faeb848a581245cbd5fb1a3f109fcaede49f` (vendored 2026-10-10)
- **License:** Apache-2.0, see `LICENSE`

## Copied files

- `src/effect/index.ts` to `effect/index.ts`
- `src/effect/rules/*.ts` without the `*.test.ts` files to `effect/rules/`
- `src/shared/{ast,effect,scope}.ts` to `shared/`

## Deviations

- `index.ts` is new. It re-exports `effect/index.ts` so Oxlint loads one entry point.
- `shared/scope.ts` re-exports `resolveVariable` from `../../anti-slop/shared/scope.ts` instead of
  upstream's `vendor/anti-slop` submodule. Both are anti-slop commit
  `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`, and the files are identical.
- Tests are not vendored; they depend on Bun and `oxlint/plugins-dev`.
- The npm package is not installed because it pins Oxlint 1.86.0.
