# 0003. Make every account a user who signs in with a username and password

- Status: Accepted, 2026-11-03. Amended 2026-11-04 with how accounts were built.
- Decisions: D12, D13, D15

## Context

Movies has accounts that own profiles, with a Netflix-style picker, per-profile PINs, and kids
profiles. Music has users and no profiles. Both use Convex Auth with a password provider. Movies
stores invite codes hashed. Music stores them in plain text and has admin reset links. The merged
product needs one model for who a person is and how they get in.

## Decision

- **Users only.** Everything belongs to a user. Movies' profiles are removed. The Netflix-style
  picker stays as UI, and each tile is a real user with their own credential. The number of users
  has no limit.
- **Username and password.** A user signs in with a username and a password. The product collects
  no email and offers no passkeys, no two-factor, and no SSO. Usernames are unique,
  case-insensitive, and changeable. History follows the user id, not the username.
- **The first user is the owner.** The first user is an admin with an owner flag. No other admin can
  remove or demote the owner. The owner can hand ownership to another user.
- **New users come from an admin.** An admin sends an invite link, and the new user picks a
  username and password. Or an admin types a username and password for them. There is no open
  sign-up and there are no temporary passwords.
- **Passwords and recovery.**
  - Every user can change their own password.
  - Admins issue one-time reset links.
  - The owner recovers with `media admin reset-password <user>`, run on the server host.
- **Invite codes** are stored hashed and expire after a configurable time.

## Consequences

- Movies' profile tables, PINs, and profile-scoped history go away in the port. Watch history,
  progress, and lists key on the user id.
- Kids become users with restrictions (ADR 0005). Locks on a shared device replace profile PINs
  (ADR 0006).
- Renaming a user changes nothing they own.
- The owner can always get back in from the server host, even when no admin can sign in.

## Alternatives rejected

- Profiles under an account. Every tile in the picker is a user instead, with its own credential.
- Email sign-in, passkeys, two-factor, and SSO. None is collected or offered. Convex Auth v1 has no
  passkeys, two-factor, or generic OIDC (ADR 0004).
- Open sign-up and temporary passwords.
- Plain-text invite codes, as music stores them today.

## Edge cases settled

- `Alice` and `alice` are the same username.
- A username is ASCII, so no two look alike. It starts with a letter or a digit and holds 1 to
  32 letters, digits, dots, dashes, and underscores. A password has 8 to 256 characters.
- A changed username keeps its history, because history follows the user id.
- An admin cannot remove or demote the owner. Only the owner hands over ownership.
- A forgotten owner password is reset from the server host with `media admin reset-password`, not
  through a link.
- An expired invite code no longer works.

## Accounts as built (amended 2026-11-04)

The first accounts build settled the owner's shape, how the first user comes to exist, and what
each link and password event does. The code is in `packages/platform/convex/core/accounts/`.

- **The owner is a role.** A user's `role` is `owner`, `admin`, or `member`. The owner is the
  admin who holds the server, so D15's owner flag is the role value `owner`, and no row can mark a
  member as the owner. `insertUser` in `accounts/users.ts` makes every user. It refuses a second
  owner, and it refuses anyone but the owner while the server has none.
- **First-run setup.** The first user comes from the `setup` sign-in, which works only while the
  server has no owner. `core.server.info` returns `hasOwner`, so a client knows to show setup. Two
  setups that race both read the empty owner index, so Convex retries the later one, which then
  finds an owner and is refused with `conflict`. Whoever reaches a fresh server first can claim
  it. Both old products had the same window.
- **Who changes whom.** An admin can make someone else an admin or a member and send them a reset
  link. Nobody changes the owner's role, sends the owner a reset link, or changes their own role.
  Only the owner hands over ownership. The handover patches both users in one transaction, and
  the old owner stays an admin. `manages` in `accounts/users.ts` holds these rules.
- **Invites.** `core.accounts.invites.create` returns a code `mi_<inviteId>.<secret>` with 32
  random bytes of secret. The `invites` table stores only the secret's SHA-256, and a lookup by
  id compares it in constant time. The admin picks the role and 1 to 30 days, 7 by default.
  - An invite works until it expires, is accepted, or is revoked, and only while its maker is an
    admin. Accepting or revoking deletes the row, and the hourly sweep deletes expired ones.
  - The invitee calls the `invite` sign-in with the code and the username and password they
    picked. One call makes the user and signs them in. A taken username leaves the invite open.
  - `core.accounts.invites.lookup` shows a landing page the role and the inviter, and refuses a
    dead code with `expired`.
- **Admin-made users.** `core.accounts.users.create` takes the username, password, and role an
  admin types. The person signs in with them, and nothing forces a change later.
- **Reset links.** `core.accounts.resetLinks.create` returns `mr_<resetLinkId>.<secret>`, stored
  and compared the same way. A link works once, within 24 hours. It records the person's session
  generation, so it stops working when their sessions end for any reason. It also stops when its
  maker can no longer manage the person, for example after a demotion or when the person became
  the owner. The `reset` sign-in sets the new password and signs the person in.
- **Password events.**

  | Event                              | Needs                                           | Ends                                                 | Keeps                           |
  | ---------------------------------- | ----------------------------------------------- | ---------------------------------------------------- | ------------------------------- |
  | `core.accounts.me.changePassword`  | the current password, which takes a sign-in try | other password and device sessions, open reset links | this session, API keys          |
  | The `reset` sign-in                | the link                                        | every session and API key                            | nothing; it opens a new session |
  | `core/accounts/host:resetPassword` | the deployment admin key                        | every session and API key                            | nothing                         |

  Both resets fill the person's sign-in tries again, so someone locked out by wrong guesses gets
  in at once.

- **The server host.** `media admin reset-password [user]` will run the internal action
  `core/accounts/host:resetPassword` with the deployment admin key. Without a username it resets
  the owner. The internal action `core/accounts/host:createUser` makes a user as an admin would,
  and `insertUser` refuses it until setup.
- **Renames.** Each person renames themselves with `core.accounts.me.rename`. Sessions, keys, and
  everything keyed on the user id stay theirs, and the old name signs nobody in.
- **No open sign-up.** Once the server has an owner, a person becomes a user only through an
  invite or an admin. The commands a caller with no session can reach are `core.server.info`,
  `core.auth.deviceCodes.start`, and the two link lookups. A test in `packages/commands` fails when
  that list grows.
- **Not built here.** Removing a user. The unit that adds it keeps the owner out of reach through
  `manages`.

Rejected in this build:

- An `owner` boolean beside the role. It could mark a member as the owner.
- Setup only from the server host. The first visit would need a shell on the server.
- Account commands followed by a password sign-in. Accepting an invite would take two calls and
  two Scrypt runs. One Scrypt run takes about 140 ms here, and it is most of what accepting an
  invite costs (ADR 0004).
- One table for invites and reset links. They share no list or revoke, and ADR 0023 names
  `invites`.
