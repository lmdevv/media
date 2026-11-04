# 0008. Keep each domain as a folder in one Convex schema

- Status: Accepted, 2026-11-03
- Decisions: D22

## Context

The core, movies, and music share one Convex deployment (ADR 0002). Convex offers two ways to split
a deployment's code. Folders split the functions inside one schema. Components package tables and
functions behind their own boundary.

Convex components cannot read `ctx.auth`, cannot hold ids into other components, and are not
callable from the internet. Every domain function checks the caller (ADR 0004 and ADR 0005), and
domain tables point at core tables such as `users` and `libraries`.

## Decision

Domains are folders in one Convex schema:

- `convex/core` for identity, permissions, devices, jobs, libraries, settings, downloads, together,
  connect, and guests,
- `convex/movies`,
- `convex/music`.

Domains are not Convex components.

## Consequences

- A movies table can hold a `v.id("users")` or a `v.id("libraries")`, and a query can join across
  domains in one transaction.
- Function paths carry the domain, such as `api.music.playlists.create` (ADR 0009).
- Convex does not stop `convex/movies` from reading `convex/music` tables. The folder boundary is a
  convention, not an enforced one.
- Table names share one namespace, so today's clashing names (`users`, `jobs`, `libraries`, and
  others) resolve to one core table each.

## Alternatives rejected

- Convex components per domain. They cannot read `ctx.auth`, cannot hold ids into other
  components, and are not internet-callable.

## Edge cases settled

- A later product adds a folder, such as `convex/photos`, not a component.
- Scanner callbacks, crons, and server-only calls stay internal functions inside their domain's
  folder (ADR 0009).
