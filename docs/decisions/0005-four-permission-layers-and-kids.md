# 0005. Check access in four layers and make kids restricted users

- Status: Accepted, 2026-11-03. Amended 2026-11-04 with the first role and the `admin` scope,
  and again the same day with the permissions as built.
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

## Permissions as built (amended 2026-11-04)

The permissions build added the four layers to the core. The code is in
`packages/platform/convex/core/permissions/` and `convex/core/restrictions.ts`. The vocabulary is in
`packages/commands/src/scopes.ts` and `packages/commands/src/access.ts`, and the generator emits it.

### One pure decision

`can(principal, action, resource)` in `permissions/policy.ts` reads no database. Three tables
hold its rules, each typed by its list of actions, so a missing or extra row fails to compile.

| Action              | On      | Needs                                                                                |
| ------------------- | ------- | ------------------------------------------------------------------------------------ |
| `view`              | content | `<domain>:read`, and a `view` grant                                                  |
| `play`              | content | `<domain>:play`, and a `view` grant                                                  |
| `edit`              | content | `<domain>:edit`, and an `edit` grant                                                 |
| `manage`            | content | `<domain>:edit`, and a `manage` grant; it shares, renames, and deletes               |
| `promote`           | account | `admin`; someone else; an admin or a member without restrictions                     |
| `demote`            | account | `admin`; someone else; an admin or a member                                          |
| `resetPassword`     | account | `admin`; someone else; an admin or a member                                          |
| `restrict`          | account | `admin`; someone else; a member                                                      |
| `viewRestrictions`  | account | nothing for yourself; otherwise `admin`, and anyone but a guest or a service         |
| `joinGroup`         | account | `admin`; anyone but a guest or a service, yourself included                          |
| `handOverOwnership` | account | `admin` and being the owner; someone else; an admin or a member without restrictions |
| `invite`            | server  | `admin`                                                                              |
| `manageGroups`      | server  | `admin`                                                                              |
| `manageFolders`     | server  | `admin`; making a library or changing its folders (ADR 0024)                         |

ADR 0006 adds the tile, approval, and device actions, and `listOnSharedDevices`,
`resetUnlockCode`, and `manageDevices`. ADR 0019 adds `change` on a setting and `keep` on a
download. ADR 0017 adds the group-session actions, whose loader is `requireTogether` in
`together/access.ts`.

The answer is `allowed`, `hidden`, or `forbidden`. Content with no grant, content a restriction
hides, and any content for a service are `hidden`, which fails `not_found` with the same message
as a row that does not exist. So a private thing stays invisible to everyone else, admins and the
owner included. `forbidden` refuses something the principal can see but may not do.

Handlers never pass rows to `can` themselves. Loaders read the facts and decide:
`requireContent`, `visiblePage`, and `requireItems` in `permissions/grants.ts`, and `requireAccount` and
`requireServer` in `permissions/authorize.ts`. A link check has no session, so it asks `can` about
`principalOf(maker)`, the principal the maker's row alone allows.

### Roles and scopes

| Role   | Scopes                                     |
| ------ | ------------------------------------------ |
| owner  | `account`, `admin`, and every domain scope |
| admin  | `account`, `admin`, and every domain scope |
| member | `account` and every domain scope           |
| guest  | `movies:play`, `music:play`                |

- The domain scopes are `read`, `play`, and `edit` for each content domain: `movies:read`,
  `movies:play`, `movies:edit`, `music:read`, `music:play`, `music:edit`. `play` does not need
  `read`, so a key for a speaker plays and cannot browse. `edit` covers what the `manage` level
  allows, sharing included.
- `roleScopes` in `packages/commands/src/scopes.ts` is the only role-to-scope table.
  `heldScopes` in `policy.ts` gives a password session its role's scopes and cuts a key's or a
  device's stored scopes to its role's on every call.
- Nobody assigns `guest`. Guest links make guests (ADR 0007). The role cannot browse, search,
  edit, or make keys.
- The generator refuses a movies or music command that declares anything but a scope of its own
  domain, and a core command that declares a domain scope (`domain-scope` in
  `packages/commands/src/check.ts`). So a key with only `music:play` fails every movies command's
  scope check before the command reads anything.
- A role change that takes away any scope ends every session and API key of the person
  (`endsCredentials`). Losing `admin` is such a change, so losing the right to make invites and
  reset links still ends the links the person made (ADR 0003). A unit test checks every pair of
  roles.

### Service principals

A service principal is a `users` row with `kind: "service"` and a `name`. It has no role,
username, password, or restrictions, so the schema cannot give it a role.
`core/accounts/host:createService` makes one. It holds no scope yet, and `requireCaller` refuses
its sessions. The server move in phase 4 adds its scope and API key (D50). Every account action on
a service is refused, so no admin can give it a role, a reset link, restrictions, or ownership.

### Grants and groups

- A `grants` row names a resource type, a resource id, a principal, and a level. The principal is a
  user id, a group id, or `household`, stored as one value so it can be indexed. The household is
  every person on the server but guests, which covers the libraries both old products shared with
  everyone.
- Resource types live in one registry, `resourceTypes` in `packages/commands/src/access.ts`. Each
  entry names its table. Only containers are grantable: a library now (ADR 0024), a playlist or a
  collection later. A title or a track has no grants of its own: it is seen at its library's level,
  through `requireItems`, which decides on the library once and then on each item's facts. So a
  title list pages the domain's own index after one library check, and never merges grant ranges.
- `core.permissions.grants.set`, `remove`, and `list` share anything in the registry. Their
  `resource` is a `{ type, id }` pair derived from the registry, so an id of another table fails
  validation. `set` refuses API keys, because a leaked key could grant its own person access that
  outlives the key. `list` needs `manage`, and names each user and group.
- A grant or revoke needs `manage`. A person who can see something can leave what was shared
  with them. Only a
  person can hold `manage`, and a group or the household gets `view` or `edit`. Removing or
  lowering the last `manage` grant is a `conflict`. The mutation that creates a resource makes its
  creator the first manager (`grantCreator`).
- Admins hold no level they were not granted.
- Admins manage groups through `core.permissions.groups.*`. Adding someone to a group refuses API
  keys, because a leaked admin key could otherwise add its own person to every group. Group membership is read on every
  content check, so a person added to or removed from a group gains or loses its grants on their
  next call. Removing a group deletes its memberships at once and deletes its grants in scheduled
  pages.
- Limits: 1,000 grants per resource, 16 groups per person, and 500 people per group.

### Restrictions

- They live on the member's `users` row. The schema allows them on members only, because an
  admin could lift their own through another admin they promote. The caller's row is already
  read on every call, so a restriction check reads nothing more.
- The fields are `maxMovieAge` (the highest minimum viewer age, 0 to 21, on the scale of
  `packages/contracts/src/content-rating.ts`, where PG is 7), `hideUnrated`, `hideExplicitMusic`,
  and `libraries` (null for every library the person's grants reach).
- `core.restrictions.set` needs `admin`, refuses API keys, and works only on a member who is
  someone else. `core.restrictions.get` shows your own, or as an admin anyone's, which is null
  for someone who is not a member.
- A kid is a member with restrictions (`isKid`). Limits that hide nothing are stored as no
  restrictions. An admin lifts them before promoting the kid or
  handing them ownership.
- A change applies on the person's next call and ends no session.
- What restrictions do to a thing depends on where it sits, a `Placement` that every content
  resource carries, so no check is skipped because a field is empty:

  | Placement  | Allowed-libraries list                                                   | Rating limits                                        |
  | ---------- | ------------------------------------------------------------------------ | ---------------------------------------------------- |
  | `library`  | checks the library itself                                                | none: a library has no rating, each item has its own |
  | `item`     | checks the item's library                                                | checks its facts; an unrated movie is `unrated`      |
  | `unplaced` | its type chooses: `hides`, or `allows` and each item it holds is checked | its own facts, or none for a `container`             |

  `placements` maps each grantable type to its placement and fails to compile until a new type
  picks one. A thing in no one library, such as a playlist, is `unplaced` and must state both
  choices.

### Reads

- One content check reads 2 grants, the person's own and the household's. Unless one of them is
  `manage`, it then reads the person's group memberships and one grant per group.
- A list page merges the index ranges of the person's own, household, and group grants after the
  cursor, so it reads at most 1,000 documents however many grants the table holds. On the dev stack
  with more than 1,000 grants in the table, a 50-row page read 168 documents.
- A page reloaded up to its end cursor returns every row up to it, or asks the client to split it.
  Restrictions can make a page short.

### Test seam

`convex/core/libraryProbe.ts` holds `probeItems`, items in real libraries with a movie age and an
explicit flag, in place of titles and tracks until they exist (ADR 0024). Its internal `open` and
`page` take a real session's id and run `callerOfSession`, which is everything `requireCaller` does
after it reads the token. A stack test signs in for real, with a password or a key with chosen
scopes, and calls them with the deployment admin key. Libraries themselves are shared and read
through the real commands. The admin key acting as a user identity reaches only public functions,
and the core allows no public function outside the command list.

### Left to later units

- Guest principals and links: p3-guests.
- The service principal's scope and key: phase 4.
- Locking shared-device tiles for kids, from `isKid`: built, see ADR 0006.

### Edge cases settled

- An admin who resets a person's password can sign in as them and see what was shared with them.
  This ADR keeps admins out of private content in the apps only. The reset ends every session the
  person had, so they notice. Music's rule that only the owner may reset someone who sees more
  than the admin was not carried over.
- An admin can add themselves to a group. A grant to a group trusts the admins who run groups.
- A key whose person can see a thing, but which lacks the scope for the action, gets `forbidden`,
  not `not_found`. The person could see the thing anyway.
- Unrated movies stay visible to a kid unless `hideUnrated` is on. Old movies always hid them
  from limited profiles. D17 makes it a switch of its own.
- The allowed-libraries list is not checked for libraries that exist. Checking would tell an admin
  which private libraries exist.

Rejected in this build:

- Access declared on each command and checked by the generated wrapper before the handler runs.
  Lists and commands whose action depends on an argument, such as `setRole` (`promote` or
  `demote`), fit no single declared target. It is worth another look in the movies port, when
  many commands each open one title.
- A table of each person's effective level per resource. A household grant would write a row per
  person, and a group change a row per resource shared with the group.
- Admins who see all content, and a `play` or `edit` scope that needs `read`.
- A `server` scope now. Nothing checks it until the server moves onto the core.
