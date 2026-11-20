# Development

Working on Lar from a checkout: the per-worktree stack, the test suites that need it, the checks
for deploy and sandbox changes, and how CI is laid out. `AGENTS.md` has the rules and the daily
commands.

## The worktree stack

`scripts/dev-stack.sh up` starts the core's self-hosted Convex backend in Docker, deploys and
configures it, creates the media service's service principal and key, runs the media service's
sign-in boundary alone in a second container, and writes the `.env.local` files. `env` prints the
stack's settings, `down` stops it, and `destroy` removes it. Commit the regenerated
`convex/_generated/`.

Ports, the data volume, and the temporary output directory derive from the worktree name. A
backend published on other ports is recreated on `up`, keeping its data. From the base port:

| Offset | Service                                                    |
| ------ | ---------------------------------------------------------- |
| +0     | media service                                              |
| +1     | movies web                                                 |
| +2     | the core's Convex API                                      |
| +3     | its HTTP actions                                           |
| +4     | account client                                             |
| +5     | sign-in boundary, which every stack suite signs in through |
| +6     | music web                                                  |

The stack's backend lifts Convex's 4 MiB/s write limit (`MAX_BYTES_WRITTEN_PER_SECOND`) so
back-to-back test seeds never meet `TooManyWrites`. The image and the NixOS module keep the
default, so product code that writes in bulk must still pace or retry as ADR 0012 says.

## Stack suites

With the stack up:

- `pnpm --filter <pkg> test:stack` for `@media/platform`, `@media/sdk`, `@lmdevv/media`, and
  `@media/server`.
- `pnpm --filter @media/web-movies exec playwright test`. Each app's Playwright uses `E2E_PORT`,
  else the stack's port for that app (`MOVIES_PORT`, `MUSIC_PORT`, `ACCOUNT_PORT`), else 3011 or 3012. `E2E_GROUP=<group>` runs one of the groups CI runs in separate jobs, each on its own
  stack; the groups are in `apps/web/movies/playwright.config.ts`.
- Migration suites: `docker pull` the `jellyfin/jellyfin:12.2@sha256:…` reference in
  `.github/workflows/ci.yml` and set `MEDIA_JELLYFIN_DOCKER=1`. Without the image the media suite
  skips the real-Jellyfin case silently, but the web migration spec starts Jellyfin anyway,
  pulling the image or failing.

Repeat runs: `playwright test --repeat-each=20`, and for Vitest, fresh processes that stop at the
first failure: `(for run in $(seq 20); do pnpm test <paths> || exit; done)`. Don't use Vitest's
`--repeats`: `@effect/vitest` 4.0.3 counts each repeat as a finished test and closes a
`layer(...)` early, which fails with missing files or `ECONNREFUSED`, not a product bug.

## Checks for specific changes

- **A new media service setting** goes in `deploy/image/rootfs/app/bin/init`, `deploy/compose`
  (`compose.yaml`, `.env.example`), the root `.env.example`, `nix/module.nix`, and both READMEs.
  `scripts/check-deploy.sh` names what is missing.
- **The packaged stack:** `scripts/stack-e2e.sh` builds the image and smoke-tests it.
  `scripts/nixos-module-e2e.sh` does the same for the NixOS module on a NixOS host, and
  `nix build .#checks.x86_64-linux.vm -L` boots the module in a NixOS VM (needs KVM).
- **Convex argv:** after a change to `nix/convex-entry.sh`, the module's Convex container, or
  `deploy/image/argv-secret.c`, run `scripts/check-convex-argv.sh`. It checks that the instance
  secret appears on no command line.
- **Sandbox:** after a change to the media service's file or process handling, its dependencies,
  or the module's sandbox, run `scripts/check-sandbox.sh`. It runs the media tests under the
  module's system call filter in a `systemd-run --user` unit that kills on any denied call. Copy
  test files with `testing/byte-copies.ts`: `copyFile` calls `fchown`.

## CI

The pre-commit hook and pull request CI run typecheck, lint, and test only over the packages a
diff affects and their dependents, and everything when a root config file changes;
`scripts/changed-packages.sh` prints that set. CI on `main` runs everything.

- `check`, then the unit tests in two jobs, one per Vitest project in `vitest.config.ts`: the
  media service's playback tests, which take most of the time, and the rest.
- Stack jobs as matrices: the backend one runs the platform's files in four shards and the other
  packages beside them, and the web one runs each Playwright group.
- The sandbox job and the Nix job.

On a PR, the `changed workspaces` job skips each stack job, the sandbox job, and the Nix job when
the diff does not reach the workspaces they test. `CI passed` fails when any job fails or is
cancelled, and `main` requires it. A new push to a PR cancels its older run. PRs matching the
`paths` in `.github/workflows/image.yml` also run its `build and smoke-test`, which `main` does
not require, so check it yourself before merging.
