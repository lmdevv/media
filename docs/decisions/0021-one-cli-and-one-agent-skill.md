# 0021. Ship one `media` CLI and one agent skill with a reference per domain

- Status: Accepted, 2026-11-03
- Decisions: D41

## Context

Movies publishes the `movies` CLI as `@lmdevv/movies` on npm, with JSON output and an agent skill
in `apps/cli/skills/movies/SKILL.md`. Agents use the CLI and the skill, and there is no MCP server.
Music has its own CLI in `apps/cli`. Two CLIs mean two installs, two sign-ins, and two skills
for an agent to load.

## Decision

- One CLI binary, `media`, with a command group per domain:
  - `media movies …`,
  - `media music …`,
  - `media admin …`.
- One agent skill, with one reference file per domain that the agent loads on demand.
- `@lmdevv/movies` on npm is deprecated with a pointer to the new package.

## Consequences

- An agent signs in once and reaches both domains.
- The skill stays small. An agent working on music loads the music reference and not the movies
  one.
- The CLI's commands come from the command list (ADR 0009), so each domain's group and reference
  file follow from its commands.
- `media admin reset-password <user>` lives in the admin group (ADR 0003).
- Anyone who installed `@lmdevv/movies` sees the deprecation pointer on their next install.

## Alternatives rejected

- One CLI per product, as today.
- One skill file that holds every domain's reference. Each domain's reference loads on demand.
- An MCP server. Agents use the CLI and the skill.

## Edge cases settled

- `@lmdevv/movies` is deprecated, not unpublished.
- Admin commands live under `media admin`, not under a domain.
