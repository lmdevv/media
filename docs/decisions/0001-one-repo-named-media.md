# 0001. Merge both products into one repo named [media]

- Status: Accepted, 2026-11-03
- Decisions: D08, D09, D10

## Context

[movies] and [music] grew in two repos, `lmdevv/movies` and `lmdevv/music`. They now share one
server, one database, and one sign-in (ADR 0002), so they need one repo. The two codebases also
collide. Both claim port 8080, `/data`, `/media/*`, and `/invite/:code`, and both define Convex
tables named `users`, `authSessions`, `invites`, `apiKeys`, `libraries`, and `jobs` with different
shapes.

`lmdevv/movies` has 92 pull requests. `lmdevv/music` has 81 commits on `main`, and its commit
messages refer to its own pull requests as `#N`.

## Decision

- The working name is `[media]` until a later rebrand.
- The repo is `lmdevv/media`. It is `lmdevv/movies` renamed on GitHub, so its 92 pull requests stay
  native.
- Names follow the repo:
  - Workspace scope `@media/*`.
  - CLI binary `media`.
  - Image `ghcr.io/lmdevv/media`.
  - Environment prefix `MEDIA_`.
  - Movies' service package `@movies/media` becomes `@media/server`.
- Music's history is rewritten with `git-filter-repo` into `legacy/music/`.
  - Every `#N` in a music commit message becomes `lmdevv/music#N`, so the reference still links.
  - Each rewritten commit gets an `Original-commit: lmdevv/music@<sha>` trailer.
- After the import, `lmdevv/music` is archived on GitHub. It is never deleted.
- Locally, one codebase lives at `~/Projects/media`, synced with `lmdevv/media`.
  - The local music clone, empty `*-wt` folders, and other leftovers are removed only after the
    import is verified.
  - Merged remote branches are deleted. Unmerged ones get a look first.

## Consequences

- `git log -- legacy/music` shows music's full history with its original authors and dates, and
  each commit names the music commit it came from.
- Old music code stays in `legacy/music/` and stays runnable until its port lands (ADR 0002).
- Every package, setting, and binary is renamed once, in phase 2. Docs and scripts that say
  `movies` change with that rename.
- The `[media]` name is temporary. A rebrand later is another rename of the same kind.

## Alternatives rejected

- A new repo for the merged product. Movies' 92 pull requests would no longer be native to it.
- Deleting `lmdevv/music`. Rewritten references point at it, so it is archived instead.

## Edge cases settled

- A reference that already names a repo, such as `owner/repo#N`, is not rewritten again.
- Local folders are removed only after the import is verified. The import PR is not enough on its
  own.
- An unmerged remote branch is never deleted unread.
