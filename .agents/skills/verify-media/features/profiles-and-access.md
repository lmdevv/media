# People and access

Each person sees only what their access allows. On the `one-backend` layout every person, a kid
too, is a core user who signs in once at `/`, and `/movies` opens with that session; a kid's
limits hide titles above their age rating, and a library shows only to the people it's shared
with. In old movies (`one-port`), one account holds several viewing profiles instead: a kids
profile hides titles above its rating and asks for a PIN, and a restricted library shows only to
the people it's granted to. To everyone else a hidden title doesn't exist.

## Sub-features

- `one-sign-in` opens `/movies` signed in after one sign-in at `/` (`one-backend`).
- `kid-user` limits the kid user to titles rated PG and below (`one-backend`).
- `access-shared` hides a library from a member it isn't shared with (`one-backend`).

- `profile-picker` asks `Who's watching?` on a new session and lists the account's profiles.
- `profile-switch` switches profiles from the banner's avatar.
- `profile-kids` limits a kids profile to titles rated PG and below.
- `profile-pin` asks for a PIN, and says how many tries are left after a wrong one.
- `access-restricted` hides a restricted library from a member who wasn't granted it.
- `access-cli` applies the same limits to each person's CLI.

## How to get to it (user POV)

- `one-backend`: sign in at `/`, then open `/movies`. A signed-out `/movies` sends the browser to
  `/`. The account client's Admin, Users (`/admin`) holds each person's `Kid limits` and
  `Shared devices`; Admin, Libraries holds each library's `Shared with`.
- Terminal on `one-backend`: `media movies titles list`, `media movies titles get --title-id <id>`,
  `media auth sessions current`, and for admins `media admin restrictions set`.

Old movies:

- `/profiles` after sign-in, or `Manage profiles` in the profile switcher.
- The banner's `<profile>: switch profile` button opens the command menu's `Switch profile` list.
- `/profiles/new` adds a profile; `Kids profile` and `Profile PIN` are switches there.
- Admin, Libraries: a library's `Who sees it` (`Everyone` or `Only people I choose`).
- Terminal: `media profiles list`, `media profiles unlock --profile-id <id> <pin>`,
  `media titles list --profile-id <id>`.

## Driving it with verify-media on one backend

Preconditions:

- `$S doctor` passes on a `one-backend` side, and the side holds the seed.

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
- **Proof.** Screenshot each person's Home with
  `$S browser screenshot --page sam --path captures/verify/<run>/after/access/sam-home.png`, and
  save the CLI lists' output beside them.

## Driving it with verify-media in old movies

Preconditions:

- `$S doctor` passes on a `one-port` side, and the side holds the seed.

- **Picker.** Run `$S browser sign-in --page pin`. The URL is `/profiles?redirect=%2F`, and
  `$S browser snapshot --page pin --in main` lists the buttons `Lucía` and `Kids`.
- **Wrong PIN.** Run `$S browser click --page pin --role button --name Kids --exact`. The heading
  reads `Enter Kids's PIN`. Run
  `$S browser click --page pin --role textbox --name "Kids's PIN" --exact` and
  `$S browser type --page pin --value 1111`. `$S browser text --page pin --role alert` prints
  `Wrong PIN. 4 tries left.`
- **Kids.** Run `$S browser close-page --page pin`, then
  `$S browser sign-in --page kids --profile Kids --pin 1234`. It prints `watching as Kids`. Home's
  `Recently added` holds only `New Cosmos Laundromat: First Cycle` and `New Big Buck Bunny`, and
  `Shows` only `New Caminandes`.
- **Restricted library.** Run `$S browser sign-in --page sam --email sam@movies.local --profile Sam`.
  Home's rows hold only `Pioneer One` and `Caminandes`. `$S browser open --page sam /movies`
  reads `0 titles` and `No movies yet`. Opening Sintel's page (its id from
  `$S cli -- search sintel`) at `/title/<id>` reads `This title isn't here`.
- **CLI, per person.** `$S cli --as sam -- titles list --limit 100` lists `Caminandes` and
  `Pioneer One`. `$S cli --as sam -- titles get <sintel-id>` exits `5` with
  `{"error":{"code":"not_found","message":"No such title"}}`. `$S cli --as aiko -- titles list --limit 100`
  and `$S cli --as mateo -- …` list all 8. `$S cli --as mateo -- whoami` shows `"role": "admin"`.
- **CLI, Kids.** Read Kids' id from `$S cli -- profiles list`. `$S cli -- titles list --profile-id <id>`
  fails until `$S cli -- profiles unlock --profile-id <id> 1234`; then it lists the three Kids
  titles. Run `$S cli -- profiles lock --profile-id <id>` after.
- **Proof.** Screenshot each person's Home with
  `$S browser screenshot --page sam --path captures/verify/<run>/after/access/sam-home.png`, and
  save the CLI lists' output beside them.

## Gotchas

- On `one-backend`, a core library is private to whoever made it until it's shared, admins
  included. Mateo sees both libraries because the seed shares them with him. Use Sam to show a
  library that isn't shared.
- On `one-backend`, each page is its own browser, so its sign-in is its own: signing out in
  `/movies` signs out that page's `/` too, and no other page.

- A page that made a PIN profile has it unlocked, so the `main` page switches to `Kids` without
  asking. Prove the PIN on a new page.
- The PIN page doesn't focus its first box. Click the `Kids's PIN` textbox before typing; typed
  digits otherwise go nowhere. `profile --pin` and `sign-in --pin` do this for you.
- `Kids's PIN` also names the group around the four boxes, so ask for `--role textbox` with
  `--exact`, not `--label`.
- In old movies, admins see every library whatever its access, so Mateo can't show a
  restriction. Use Sam.
- Five wrong PINs lock the profile for a while (`Too many wrong PINs`). Use one wrong try per run.
- Unrated titles are hidden from a limited profile. The seed rated the demo films; the Feature
  Test stays `NR`, so Kids never sees it.
