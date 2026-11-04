# @music/cli

`music`, the [music] command line. Every command in `@music/commands/registry` becomes a
subcommand at runtime (`playlists.create` → `music playlists create`), with flags derived from the
command's argument schema. Agents use it through [`skills/music/SKILL.md`](../../skills/music/SKILL.md).

```sh
pnpm --filter @music/cli build            # bundle to dist/music.js
printf %s "$KEY" | node dist/music.js login --server http://127.0.0.1:3210 --key-stdin
node dist/music.js playlists list
node dist/music.js commands --json        # every command with its argument JSON Schema
```

## Layout

| File               | Role                                                                  |
| ------------------ | --------------------------------------------------------------------- |
| `src/main.ts`      | Process entry point                                                   |
| `src/cli.ts`       | Routing, built-in commands, output, and exit codes                    |
| `src/flags.ts`     | Flags derived from argument schemas; argv → wire arguments            |
| `src/catalog.ts`   | Help text, `music commands --json`, and the skill's command reference |
| `src/api.ts`       | API-key sign-in, token cache, and typed server calls                  |
| `src/config.ts`    | `$XDG_CONFIG_HOME/music/` config and session files                    |
| `src/input.ts`     | Reading the API key from stdin or a hidden prompt                     |
| `src/jobs.ts`      | `--wait` polling for job commands                                     |
| `src/shortcuts.ts` | `play`, `now`, and the transport shortcuts                            |
| `src/render.ts`    | Tables and key-value output                                           |

Argument parsing uses `node:util.parseArgs`: Effect 4.0.2's `effect/cli` is marked
`@stability unstable`, and the repo's lint rejects unstable APIs. `src/files.ts` owns `node:fs` for
the same reason (`FileSystem` is unstable too), and `src/terminal.ts` owns stdin.

## Tests

`pnpm test` runs the unit and in-process tests. The end-to-end suite runs the bundled binary
against a real backend:

```sh
scripts/dev-backend.sh cli 3610
MUSIC_E2E_SERVER=http://127.0.0.1:3610 \
MUSIC_E2E_MEDIA_SECRET=$(cd packages/backend && pnpm exec convex env get MEDIA_SERVICE_SECRET) \
pnpm exec vitest run apps/cli/src/e2e.test.ts
```

`MUSIC_E2E_MEDIA_SECRET` is optional; with it, a fake media service completes a scan so the suite
also covers `--wait`, `play`, `now`, and likes. CI runs it with both on a fresh backend through
`scripts/backend-e2e.sh cli`, and fails if any test skips.

After changing the registry, run `pnpm --filter @music/cli skill:reference` to regenerate the
skill's command reference; a test fails while it is stale.
