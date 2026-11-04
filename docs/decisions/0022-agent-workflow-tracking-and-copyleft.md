# 0022. Keep movies' agent workflow, one Linear team, and a merged copyleft list

- Status: Accepted, 2026-11-03
- Decisions: D11, D42, D43

## Context

Agents write most of the code in both repos, so the agent workflow sets throughput, the first
priority (ADR 0002).

- Movies configures pstack in `.agents/pstack-models.md`, gets Codex review on every PR, runs
  Claude's `/code-review` locally before a PR opens or merges, verifies
  user-facing changes with the `verify-movies` skill, and gives each worktree its own stack through
  `scripts/dev-stack.sh`.
- Music has a `verify-music` skill and a demo library of its own (`docs/demo-music.md` in music).
- Each repo keeps a list of copyleft projects that may be read and never copied. Movies lists
  Jellyfin (GPL-2.0), Silo (AGPL-3.0), Kyoo (GPL-3.0), Wholphin (GPL), and Streamyfin (MPL-2.0).
  Music lists Navidrome (GPL-3.0) and Immich (AGPL-3.0).
- Movies and music each have a Linear project.

## Decision

- **Agent workflow.** Movies' setup carries over.
  - pstack is configured in `.agents/pstack-models.md`.
  - Codex reviews every PR on GitHub, and the agent iterates on its findings. The local
    `/code-review` that `CLAUDE.md` requires stays.
  - One `verify-media` skill replaces `verify-movies` and `verify-music`.
  - One demo library image holds demo movies and demo music.
  - One set of seeded people serves both domains.
  - Movies' per-worktree `scripts/dev-stack.sh` stays.
- **Copyleft.** The read-only list is the union of both repos' lists, plus Nextcloud (AGPL) and
  Audiobookshelf (GPL-3.0).
- **Linear.** One team with three projects: Platform, Movies, and Music.
  - The ADRs and the architecture overview live as documents on the Platform project.
  - Platform has one milestone per phase.
  - Issues are filed only from a list the owner approves.
- **Backlog proposals** for that list:
  - scrobbling to Last.fm and ListenBrainz,
  - Trakt,
  - Jellyfin and Plex importers for music,
  - a Navidrome importer,
  - Spotify playlist import,
  - Sonos,
  - DLNA,
  - Discord presence,
  - Home Assistant,
  - tight same-room multiroom audio,
  - a public relay that passes TLS straight through,
  - push notifications for approvals.

## Consequences

- Screenshots and recordings for any PR, in either domain, come from the same demo library and
  the same seeded people.
- Copyleft code from any listed project may be read for ideas and edge cases. It is never copied,
  ported, or translated into this repo.
- The ADRs in this folder also exist as Linear documents on the Platform project.
- No Linear issue exists for a backlog item until the owner approves it.

## Alternatives rejected

- Keeping `verify-movies` and `verify-music` side by side. One skill and one demo image replace
  them.
- Filing every backlog item as an issue now. The owner approves the list first.

## Edge cases settled

- Music's copyleft list joins movies' list. Nothing leaves either list.
- Nextcloud and Audiobookshelf are read-only references even though neither repo listed them
  before.
- A backlog proposal is not an approved issue.
