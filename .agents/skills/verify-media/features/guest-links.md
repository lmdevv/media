# Guest links

A person shares one movie, show, song, album, or session with someone who has no account, through
a link that ends by itself. An owner or admin decides whether the server makes guest links at all,
which address they carry, and which members may make them, and can see and revoke everyone's. A maker creates, lists, and revokes links from a movies title
page or a music album or song menu, beside the terminal commands. The account client governs them.
A movie guest opens one in the account client and watches only its target in Lar Movies.

## Sub-features

- `guest-policy` turns guest links on or off for the server and sets the address they carry.
- `guest-allow` lets a member make guest links, or stops them.
- `guest-create` makes a link from a title page or an album or song menu, or the CLI, for 1 to 30 days.
- `guest-list` shows the maker's links for the current item in its dialog; the CLI lists all their links, and for an admin everyone's.
- `guest-activity` shows who opened a link.
- `guest-revoke` ends an open link in its item's dialog or the CLI; an admin may also end anyone's in Admin, Guests.
- `guest-open` takes a display name, redeems the link, and resumes the guest on reload.
- `guest-movies` shows the shared movie, show, episode, or file and plays its permitted versions.

## How to get to it (user POV)

- The account client's Admin, Guests (`/admin/guests`): the switch `Allow guest links`, the field
  `Guest address`, and `Everyone's links` with each link's `Activity` and `Revoke`.
- Admin, Users, a member's `Manage`, then `Allow guest links` or `Stop guest links`.
- Movies: open a movie or show, then `Guest link` beside My List. A show shares the whole show.
- Music: open an album, its `More actions` menu, then `Guest link`; a playable song's menu has the same action.
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
- **Web create, copy, list, revoke.** On the after side, open a movie or show as Lucía and
  click `Guest link`, or open an album in music and choose `Guest link` in `More actions`.
  Before creating anything, use `browser eval` to add a stylesheet hiding the field
  `[data-sensitive="guest-link"]` (`visibility: hidden !important`). Keep this stylesheet for every screenshot and every
  recording frame; add it again after navigation. Never snapshot or print the input value.
  The dialog names the item, starts `Expires in days` at 7, and accepts whole days 1 through 30.
  Click `Create link`, check the field's origin against the configured guest address inside
  `browser eval` and return only a boolean, then click `Copy`: it reads `Copied`.
  `Your guest links` lists this item's new link as `Open` with its expiry. Check
  `$S cli -- auth links list --whose mine` for that target and `"state": "open"` (this command
  never returns the secret). Close and reopen the dialog: `New guest link` is gone, while the
  row stays. Click its `Revoke`: the row reads `Revoked`, and the CLI's list agrees.
  Repeat for an album and capture desktop and phone sizes. Before-side captures show the same
  title action area and album menu without the entry. Record the after flow only after the
  masking stylesheet is installed, and publish each pair and the video with `evidence publish`.
  As Aiko, who has no permission to share by default, these entries are absent even when guest links are on.
- **Dialog lifetime.** With a title dialog open, switch between desktop and phone sizes: the
  dialog and its masked one-time address stay. Open a song's guest dialog from a playlist, create a link, and remove that
  song from the playlist in another signed-in page. The row disappears, but the dialog and its
  masked one-time address stay, and Copy still works. Revoke that link from Admin, Guests: its
  row becomes Revoked and both the address and Copy disappear. Turning guest links off closes
  the dialog; turning them back on never reopens it. A pending Create keeps the dialog open and
  disables another Create until the server answers.
- **Create (CLI).** The same `auth links create` now prints `linkId`, `expiresAt` seven days on, and a
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
  "/guest#<link>"` shows `Watch as a guest` and a `Display name` field. Read the link from its
  private file in the command, never print it. Before capturing, verify that the address has
  become `/guest`, with no fragment. Fill the name and click `Watch`: a movie link goes to
  `/movies/guest`, showing the title and `Shared by guestprobe`. If someone is signed in,
  `Replace this sign-in?` names them; `Cancel` keeps them signed in.
- **Household safety.** On a household tab, open `/guest` without a code and click `Leave`:
  that tab returns home and a second household tab stays signed in. A fresh guest link asks
  before replacing the exact session shown. Another tab's new sign-in requires fresh consent;
  a sign-in that wins during redemption stays signed in and the entrance stops for `Continue`.
- **Music guard.** With a movie guest signed in, open `/music`: the account entrance resumes
  `/movies/guest` on the shared item, without showing music's library, search, or settings.
- **Movies playback.** Make a movie link with Lucía's CLI and the movie's title id. On a new
  signed-out guest page, enter a display name, click `Watch`, then `Play`, and use
  `$S browser wait-video --page guest --past 2`. Hover `--testid player-video`, press
  `ArrowRight`, and wait for playback past the seek. Audio, subtitles, quality, versions, and
  fullscreen use the household player's controls. Search, account navigation, casting, downloads,
  settings, and watch-together are absent. Reload, then run `auth links activity --link-id <id>`:
  exactly one guest remains. A show link lists its seasons and episodes; click an episode to play.
  Back from a show episode returns to the shared show and its episodes.
  An episode or file link shows no siblings or episode picker. Opening `/movies/title/<id>` as
  that guest returns to `/movies/guest`. A music target holds at the account entrance.
- **Revoke while watching.** With the guest playing, revoke the link from its maker's CLI.
  The guest video disappears and `This link isn't available` appears, as it does at expiry.
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
  page whose address bar or body shows it. The guest entrance removes `/guest#…`'s fragment
  before rendering; the code stays only in memory until redemption.
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
