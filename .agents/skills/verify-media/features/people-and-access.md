# People and access

Each person sees only what their access allows. Every person, a kid too, is a core user who signs
in once at `/`, and `/movies` opens with that session; a kid's limits hide titles above their age
rating, and a library shows only to the people it's shared with. To everyone else a hidden title
doesn't exist.

## Sub-features

- `one-sign-in` opens `/movies` signed in after one sign-in at `/`.
- `kid-user` limits the kid user to titles rated PG and below.
- `access-shared` hides a library from a member it isn't shared with.
- `access-cli` applies the same limits to each person's CLI.
- `shared-device` shows the picker `Who's here?` at `/` on a device an admin made shared, with a
  tile for each person listed on shared devices.

## How to get to it (user POV)

- Sign in at `/`, then open `/movies`. A signed-out `/movies` sends the browser to `/`. The
  account client's Admin, Users (`/admin`) holds each person's `Kid limits` and
  `Shared devices` under their `Manage` button; a library's page, from Admin, Libraries, holds its
  `Shared with`. [Account and admin](./account-and-admin.md) drives both.
- A shared device, made so in Admin, Devices: `/` shows `Who's here?` with the tiles.
- Terminal: `media movies titles list`, `media movies titles get --title-id <id>`,
  `media auth sessions current`, and for admins `media admin restrictions set`.

## Driving it with verify-media

Preconditions:

- `$S doctor` passes, and the side holds the seed.

- **One sign-in.** Run `$S browser sign-in --page aiko --username aiko`. It signs in at `/` and
  opens `/movies`, which shows Home with the region `Continue watching for aiko` and no sign-in
  page. `$S browser open --page aiko /search` stays signed in.
- **Kid.** Run `$S browser sign-in --page kid --username kids`. Home's rows hold only
  `Big Buck Bunny`, `Cosmos Laundromat: First Cycle`, and `Caminandes`.
- **Not shared.** Run `$S browser sign-in --page sam --username sam`. Home's rows hold only
  `Pioneer One` and `Caminandes`. Opening Sintel's page (its id from
  `$S cli -- movies titles search --query sintel`) at `/title/<id>` reads `This title isn't here`.
- **CLI, per person.** `$S cli --as sam -- movies titles list` lists `Caminandes` and
  `Pioneer One` in its `page`. `$S cli --as sam -- movies titles get --title-id <sintel-id>` fails.
  `$S cli --as kids -- movies titles list` lists the kid's three titles, and `--as aiko` and
  `--as mateo` list all 8. `$S cli --as mateo -- auth sessions current` shows `"role": "admin"`.
- **Shared device.** Sign a page in that the list can tell apart,
  `$S browser sign-in --app account --page family-tv --device "iPad Pro 11"`, which the account
  client names `Safari on iPad`. As Lucía on an account page, open `/admin/devices`, click that
  row's `Make shared` (`--in list=Devices --role button --name "Make shared" --nth <row>`, rows
  from 0), then `Make shared` again in the note that reads `Everyone on Safari on iPad is signed
  out.` (`--in note`). The row reads `Safari on iPad Shared`. `$S browser open --page family-tv /`
  then shows the heading `Who's here?` and the button `kids, kid`; clicking it opens `/home` as
  `Hi, kids.`, and `/movies` on that page is the kid's. `Make personal`, confirmed the same way,
  puts the device back.
- **Proof.** Screenshot each person's Home with
  `$S browser screenshot --page sam --path captures/verify/<run>/after/access/sam-home.png`, and
  save the CLI lists' output beside them.

## Gotchas

- A core library is private to whoever made it until it's shared, admins included. Mateo sees
  both libraries because the seed shares them with him. Use Sam to show a library that isn't
  shared.
- Each page is its own browser, so its sign-in is its own: signing out in `/movies` signs out
  that page's `/` too, and no other page.
- The seed lists only `kids` on shared devices, so the picker holds one tile.
- Every page a run signs in is a device, and most are named `Chrome on Linux`, so Admin, Devices
  can't tell them apart. Give the page you mean a device of its own, as above.
- Unrated titles are hidden from a limited person. The seed rated the demo films; the Feature
  Test stays `NR`, so the kid never sees it.
