# 0005. Check access in four layers and make kids restricted users

- Status: Accepted, 2026-11-03
- Decisions: D16, D17

## Context

Movies has roles (`owner`, `admin`, `member`, `service`) and scopes on API key and device sessions
(`read`, `play`, `account`, `manage`, `admin`, `media-service`). Its kids are profiles with a
maximum age rating, and PINs keep a kid inside one. Music has `owner`, `admin`, `member`, and
`guest` roles and no scopes. It shares a library through a visibility field (`shared`,
`restricted`, `private`) and a playlist through its own `playlistShares` table. Each resource kind
shares in its own way.

With profiles gone (ADR 0003), a kid is a user, and the merged product needs one place that
decides what each principal may see and do.

## Decision

Every access check passes four layers.

1. **Platform role.** `owner`, `admin`, `member`, or `guest`. Service accounts are a separate
   principal type, not a role.
2. **Credential scopes.** Every session and every API key carries scopes, such as `movies:read`,
   `music:play`, and `admin`.
3. **Grants.** One generic table holds every grant. A row names a principal or a group, a resource
   type, a resource id, and a level of `view`, `edit`, or `manage`. Grants cover libraries,
   playlists, and collections. Groups exist from the start.
4. **Content restrictions** on a user.

Admins manage accounts, not content. A private resource stays invisible to admins in the apps.

A kid is a normal user with a password and restrictions an admin sets:

- a maximum movie rating,
- hidden unrated content,
- the libraries they may use,
- a music explicit filter.

A kid cannot change their own restrictions. Admins are enough, so there is no guardian link.

## Consequences

- A new resource type, such as a later product's albums, needs a resource type in the grants table
  and no new table.
- Scopes carry the domain name, so a key can play music and not movies.
- An admin can reset a user's password but cannot open that user's private playlist in the apps.
- Kid rules live on the user. The lock rules for kids on shared devices are in ADR 0006.

## Alternatives rejected

- Kids profiles under a parent account. A kid is a user instead (ADR 0003).
- A guardian link between a kid and a parent. Admins already set restrictions.
- Admins who see all content. Admins manage accounts only.
- A sharing table per resource kind, such as music's `playlistShares`. One grants table replaces
  them.

## Edge cases settled

- A kid who signs in with their own password still cannot lift their own restrictions.
- Unrated content is hidden from a kid when the admin turns that restriction on.
- A grant to a group reaches every member of the group.
- A service account is its own principal type. It holds no platform role.
