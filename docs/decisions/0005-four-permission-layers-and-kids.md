# 0005. Check access in four layers and make kids restricted users

- Status: Accepted, 2026-11-03. Amended 2026-11-04 with the first role and the `admin` scope.
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
- `account` is the first credential scope. It lets a session manage its user's own credentials,
  so a key without it cannot make a key or approve a device that outlives it (ADR 0004).

## Roles and the admin scope as built (amended 2026-11-04)

The accounts build (ADR 0003) needed the platform role and a way to gate admin commands before
the rest of this ADR lands.

- `users.role` is `owner`, `admin`, or `member`. `packages/commands/src/scopes.ts` lists the roles
  once, and the generator emits the `role` and `assignableRole` validators that the schema and the
  command arguments use. `guest` arrives with guest links (ADR 0007).
- `admin` is the second credential scope. `roleScopes` in `convex/core/sessions.ts` gives the
  owner and admins `account` and `admin`, and members `account`. `heldScopes` cuts every session
  down to its user's role on each call. A demotion ends every session and key of the person, and
  so every invite and reset link they made, for good (ADR 0003).
- An admin command declares the `admin` scope, so the generated function refuses a session
  without it. Rules about the target account live in one pure function, `manages` in
  `convex/core/accounts/users.ts`: an admin acts on someone else who is not the owner.
- The permissions build replaces `roleScopes` and `heldScopes`, adds the domain scopes, and folds
  `manages` into `can(principal, action, resource)`. A change that takes away the right to make
  invites or reset links must still end the person's sessions. The links check the maker's
  current role and session generation, and only the generation remembers that the right was lost
  in between.
