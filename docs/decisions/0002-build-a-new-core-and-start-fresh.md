# 0002. Build a new platform core and start from a fresh install

- Status: Accepted, 2026-11-03
- Decisions: D01, D02, D03, D04, D05, D06, D07

## Context

[movies] and [music] solve the same platform problems twice. Each has its own accounts, sessions,
invites, API keys, libraries, jobs, signed media URLs, and deploy. Where they overlap, they differ.
Movies has device-code sign-in, scoped API keys, a service role, HMAC playback tokens, a release
workflow, a published npm CLI, and hardened systemd units. Music has admin reset links, jam guests,
a command registry, a single-origin all-in-one image, signed URLs with cacheable art, a device
registry, and Connect-style remote state.

Same-name Convex tables have different shapes. Jobs end as `succeeded` in movies and `done` in
music. `playbackSessions` is per stream in movies and per user remote state in music. `migrations`
holds import jobs in movies and data-migration cursors in music. Same-name functions have different
contracts, such as `setup.status`, `apiKeys.redeem`, and `maintenance.releaseExpiredLeases`.
Importing both Convex exports into one deployment would likely fail on table-number clashes.

Only the owner runs either product.

## Decision

- **One product.** One server, one deployment, one Convex database, and one auth system serve
  separately branded clients per product, like a consumer Nextcloud suite. Only movies and music
  are in scope.
- **A light seam for later products.** Drive, notes, photos, podcasts, and books are later
  products. The core keeps a `kind` on libraries, job kinds, and command groups for them, and
  nothing more. There is no generic machinery, no writable storage, and no WebDAV.
- **No domain toggles.** Every domain is always on.
- **A fresh install.** There is no upgrade path from movies v0.2.x or music v0.3.x. The new install
  runs on the same read-only media mounts and rescans them in full. Nothing is carried over from
  the old databases.
- **Build order.** Import both histories into one repo, write a new platform core, then port movies
  and then music onto it. Delete old code as each port lands. Old code stays runnable in the repo
  until its port lands, because agents port better from running code.
- **Freeze.** Both repos freeze until there is one repo. Linear issues wait until after the merge.
- **Priorities.** First agent and developer throughput, then NAS footprint, then CI and pre-commit
  time, then client performance.
- **Tie-breaks.** Each area where the repos differ is decided on its merits and recorded as an ADR
  in this folder.

## Consequences

- The work runs in the phase order in `docs/architecture.md`. Each port deletes the code it
  replaces in the same phase.
- The repo holds old and new code side by side between phase 3 and phase 5. Checks must cover both
  without one blocking the other.
- The owner re-creates users, progress, likes, playlists, and manual metadata fixes after the fresh
  install.
- A later product adds a library `kind`, its job kinds, and a command group. It does not get a
  plugin system.
- When two ADRs pull against each other, the priority order decides.

## Alternatives rejected

- An upgrade path from movies v0.2.x or music v0.3.x. Only the owner uses the products, so a
  migration would serve no one else.
- Importing both Convex exports into one deployment. It likely fails on table-number clashes.
- Per-domain switches. A domain with no libraries already runs no workers, so a switch saves
  nothing.
- Generic storage machinery, writable storage, and WebDAV. No product in scope needs them.

## Edge cases settled

- A domain with no libraries runs no workers, and its crons do no work.
- Profiles, progress, likes, playlists, and manual metadata fixes are all dropped by the fresh
  install.
- Media mounts stay read-only through the switch. The new install reads the same files.
- Linear issues are not filed during the freeze.
