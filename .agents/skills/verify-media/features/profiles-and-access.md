# Profiles and access

One account holds several viewing profiles, and each sees only what its limits allow. A kids
profile hides titles above its age rating and asks for a PIN when a session picks it. A library
the owner restricts shows only to the people it's granted to; to everyone else its titles don't
exist.

## Sub-features

- `profile-picker` asks `Who's watching?` on a new session and lists the account's profiles.
- `profile-switch` switches profiles from the banner's avatar.
- `profile-kids` limits a kids profile to titles rated PG and below.
- `profile-pin` asks for a PIN, and says how many tries are left after a wrong one.
- `access-restricted` hides a restricted library from a member who wasn't granted it.
- `access-cli` applies the same limits to each person's CLI.

## How to get to it (user POV)

- `/profiles` after sign-in, or `Manage profiles` in the profile switcher.
- The banner's `<profile>: switch profile` button opens the command menu's `Switch profile` list.
- `/profiles/new` adds a profile; `Kids profile` and `Profile PIN` are switches there.
- Admin, Libraries: a library's `Who sees it` (`Everyone` or `Only people I choose`).
- Terminal: `media profiles list`, `media profiles unlock --profile-id <id> <pin>`,
  `media titles list --profile-id <id>`.

## Driving it with verify-media

Preconditions:

- `$S doctor` passes, and the side holds the seed.

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

- A page that made a PIN profile has it unlocked, so the `main` page switches to `Kids` without
  asking. Prove the PIN on a new page.
- The PIN page doesn't focus its first box. Click the `Kids's PIN` textbox before typing; typed
  digits otherwise go nowhere. `profile --pin` and `sign-in --pin` do this for you.
- `Kids's PIN` also names the group around the four boxes, so ask for `--role textbox` with
  `--exact`, not `--label`.
- Admins see every library whatever its access, so Mateo can't show a restriction. Use Sam.
- Five wrong PINs lock the profile for a while (`Too many wrong PINs`). Use one wrong try per run.
- Unrated titles are hidden from a limited profile. The seed rated the demo films; the Feature
  Test stays `NR`, so Kids never sees it.
