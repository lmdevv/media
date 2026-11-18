# Guest links

A person shares one movie, show, song, album, or session with someone who has no account, through
a link that ends by itself. An owner or admin decides whether the server makes guest links at all,
which address they carry, and which members may make them, and can see and revoke everyone's. Today
a link is made, listed, and revoked from the terminal and governed in the account client; opening
one as a guest is not built in the clients yet.

## Sub-features

- `guest-policy` turns guest links on or off for the server and sets the address they carry.
- `guest-allow` lets a member make guest links, or stops them.
- `guest-create` makes a link to one thing the maker can play, for 1 to 30 days.
- `guest-list` lists a person's own links, and for an admin everyone's.
- `guest-activity` shows who opened a link.
- `guest-revoke` ends a link, the maker's own or as an admin anyone's.
- `guest-open` opens a link without an account. Not built: the page shows the sign-in form.

## How to get to it (user POV)

- The account client's Admin, Guests (`/admin/guests`): the switch `Allow guest links`, the field
  `Guest address`, and `Everyone's links` with each link's `Activity` and `Revoke`.
- Admin, Users, a member's `Manage`, then `Allow guest links` or `Stop guest links`.
- Terminal: `media auth guests status`, `media auth links create|list|activity|revoke`,
  `media admin guests configure|allow`.

## Driving it with verify-media

Preconditions:

- `$S doctor` passes, and the side holds the seed.
- An account page as Lucía, `$S browser sign-in --app account --page owner`. `<port>` is the
  side's port.
- A member made for this recipe, so no seeded person loses their sign-in at the end:
  `$S browser create-account --page owner --username guestprobe`, then
  `printf %s password123 | $S cli --as guestprobe -- auth login --server
  http://localhost:<port>/convex --username guestprobe`. They see the `Shows` library, which is
  shared with everyone.

- **Off by default.** `$S cli -- auth guests status` prints `"enabled": false`, `"address": null`,
  and `"mayShare": false`.
- **Turn on.** Run `$S browser open --page owner /admin/guests`,
  `$S browser fill --page owner --label "Guest address" --value "http://localhost:<port>"`,
  `$S browser click --page owner --role switch --name "Allow guest links"`, and
  `$S browser click --page owner --in region="Guest links" --role button --name Save`. A toast reads
  `Guest links are on`, and `$S cli -- auth guests status` prints `"enabled": true`, the address,
  and `"mayShare": true` for Lucía.
- **A member needs leave.** With Caminandes' id from `$S cli --as guestprobe -- movies titles
  search --query caminandes`, `$S cli --as guestprobe -- auth links create --target
  '{"kind":"item","item":{"domain":"movies","ref":{"type":"title","id":"<id>"}}}'` exits 4 with
  `An admin has not let you share with guests`. On `/admin`, click `--role button --name "Manage
  guestprobe"` and `--role button --name "Allow guest links"`: a toast reads `guestprobe can make
  guest links`, and `$S cli --as guestprobe -- auth guests status` prints `"mayShare": true`.
- **Create.** The same `auth links create` now prints `linkId`, `expiresAt` seven days on, and a
  `url` of the form `http://localhost:<port>/guest#mg_…`. Send its output to a file in the side's
  state folder, never to the terminal. A music album takes `"domain":"music"` and
  `"type":"album"`, and `--expires-in-days 1` shortens it.
- **List.** `$S cli --as guestprobe -- auth links list --whose mine` shows the link with
  `"madeBy": "guestprobe"` and `"state": "open"`. `--whose everyone` exits 4 for a member with
  `Only an admin can list everyone's guest links`, and lists it for Lucía. On `/admin/guests`, the
  list `Everyone's links` reads `guestprobe · Movies item Open · made <time> · ends <time>`.
- **Activity.** Click `--in region="Everyone's links" --role button --name Activity`: the row reads
  `Nobody has opened it.` `$S cli -- auth links activity --link-id <linkId>` prints an empty
  `page`.
- **Open.** On a page that isn't signed in, `$S browser --app account --page guest open
  "/guest#<link>"` shows the heading `Sign in.` and the sign-in form: nothing takes the link.
- **Revoke.** Click `--in region="Everyone's links" --role button --name Revoke`: the row reads
  `Revoked`, with no confirmation, and the maker's list shows `"state": "revoked"`. From the terminal,
  `$S cli -- auth links revoke --link-id <linkId>` prints `null` and does the same.
- **Stop a member.** On `/admin`, under `Manage guestprobe`, click `--role button --name "Stop
  guest links"`. A note reads `guestprobe is signed out, and every guest link they made stops
  working.`; its `--in note --role button --name Stop --exact` leaves the toast `guestprobe can't
  make guest links`, their links `"state": "dead"` in Lucía's `--whose everyone` list, and their
  CLI's next command at exit 3.
- **Turn off.** Click the switch again, then `Save`: a toast reads `Guest links are off`, and
  `auth guests status` prints `"enabled": false` and `"mayShare": false` for everyone.
- **Proof.** `$S browser screenshot --page owner --path captures/verify/<run>/after/guests/admin-guests.png`
  with a link in the list. The list shows no link address, so it is safe to capture.

## Gotchas

- A link's address is its secret. Never print `auth links create`'s output, and never capture a
  page whose address bar or body shows it: `/guest#…` keeps the secret in the address.
- The switch and the address change nothing until `Save`.
- Stopping a member signs them out everywhere. Never try it on a seeded person: their CLI session
  and pages go with it.
- `guestprobe` stays on the side as a sixth person in Admin, Users. On a second run the account is
  there already: skip `create-account` and sign its CLI in again.
- Turning guest links off ends every link for good; turning them on again brings none back.
- A link names one thing. A playlist is not a target.
- A title id that isn't one makes `auth links create` fail with `The server failed while running
  core/guests/links:create`, exit 1, where a missing title should read as not found.
- A revoked row reads `ended` with the day the link would have run out, not the day it was
  revoked.
