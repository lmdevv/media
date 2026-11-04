# Convex functions

Plain TypeScript with `v` validators; no Effect here. Each public function authorizes first with
`authorize(ctx, scope)` from `lib/viewer.ts`. Profile, PIN, library, and rating checks go through
`lib/access.ts`; results are built by `lib/present.ts` against the validators in
`lib/validators.ts`, which mirror `@media/contracts`. `lib/bounds.ts` enforces the contracts'
length and range bounds that validators cannot express, and holds the constants shared with
contracts; `lib/roots.ts` keeps library folders apart.

| Module                                                 | Role                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------- |
| `auth.ts`                                              | Convex Auth: `password`, `apikey`, and `device` providers            |
| `authParams.ts`                                        | Parses password sign-in params with `v` validators                   |
| `setup.ts`                                             | First-run status; `ensureServiceKey` for `scripts/configure.ts`      |
| `account.ts`                                           | The viewer and its scopes                                            |
| `users.ts`, `invites.ts`                               | Accounts, roles, library grants, invites                             |
| `apiKeys.ts`, `deviceAuth.ts`, `sessions.ts`           | Credentials and signed-in sessions                                   |
| `profiles.ts`                                          | Profiles, PINs, and per-session unlock                               |
| `titles.ts`, `libraries.ts`, `history.ts`, `myList.ts` | Browsing and watch state                                             |
| `playback.ts`                                          | Playback sessions, tokens, progress, next episode                    |
| `rooms.ts`                                             | Watch rooms and host controls                                        |
| `jobs.ts`, `metadata.ts`, `backups.ts`, `migration.ts` | Admin and background jobs                                            |
| `mediaService.ts`                                      | Everything the media service calls (scope `media-service`)           |
| `maintenance.ts`, `crons.ts`                           | Presence, expiry, lease, idle-session sweeps, nightly backup, purges |

## Tests

- `pnpm test` runs `test/registry.test.ts`: every registry command against its function's
  validators, plus the shared constants and token vectors. No backend needed.
- `pnpm --filter @media/backend test:stack` runs `test/stack.test.ts` against the worktree's
  stack from `scripts/dev-stack.sh up`. It reads the URL and the media service's credentials from
  the `.env.local` files that script writes, or from `CONVEX_SELF_HOSTED_URL`,
  `MEDIA_SERVICE_API_KEY`, and `PLAYBACK_TOKEN_SECRET`. Without `MEDIA_STACK_TESTS=1` (which the
  `test:stack` script sets) the suite is skipped, so running Vitest directly skips it too.
