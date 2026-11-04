# 0003. Make every account a user who signs in with a username and password

- Status: Accepted, 2026-11-03
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
