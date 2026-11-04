# First-run setup

A fresh server sends its first visitor to setup. They create the owner account, point the server
at a folder of films, and watch the real scan match each title before the app opens. A second
library, such as the shows, is added from Admin, Libraries.

## Sub-features

- `setup-owner` creates the first account, which owns the server.
- `setup-library` adds `/media/library/Movies` as the first library, of movies.
- `setup-scan` runs the real scanner and shows each title as it matches.
- `setup-profile` lands on `Who's watching?` with the owner's own profile.
- `setup-second-library` adds `/media/library/Shows` as a Series library from Admin.

## How to get to it (user POV)

- Open the server's address in a browser. Any path redirects to `/welcome` until an owner exists.
- Then `/setup/library` and `/setup/scan`, which the steps lead to.
- Admin, Libraries (`/admin/libraries`) and its `Add library` button, for every later library.

## Driving it with verify-media

Preconditions:

- A side started with `$S up --no-setup`, so no account exists yet.
- `$S doctor` passes every check and reports the CLI as `skip`.

- **Redirect.** Run `$S browser open /`, then `$S browser wait --url /welcome`. The heading
  `Welcome to your own screening room.` shows `Step 1 of 3 · Admin`.
- **Owner.** Run `$S browser fill --label "Your name" --value Lucía`,
  `$S browser fill --label Email --value admin@movies.local`,
  `$S browser fill --label Password --exact --value password123`, and
  `$S browser click --role button --name "Create admin account"`. Then
  `$S browser wait --url /setup/library`: the heading reads `Point us at your films.`
- **Library.** `Movies` is already checked under `This folder contains`. Run
  `$S browser fill --label "Folder path" --exact --value /media/library/Movies` and
  `$S browser click --role button --name "Save and start scan"`, then
  `$S browser wait --url /setup/scan`.
- **Scan.** Run `$S browser wait --text done --exact --timeout 300000`. The page reads
  `Files found 9`, `Scanned 9`, `Titles 6`, and shows each title's poster under `Just matched`.
- **Open.** Run `$S browser click --role link --name "Continue to [movies]"`. The URL becomes
  `/profiles`, which asks `Who's watching?` with the `Lucía` button. Run
  `$S browser profile --profile Lucía`.
- **Second library.** Run `$S browser open /admin/libraries`, then
  `$S browser click --role button --name "Add library"`. In the dialog:
  `$S browser fill --in dialog="Add library" --label Name --value Shows`,
  `$S browser click --in dialog="Add library" --role radio --name Series`,
  `$S browser fill --in dialog="Add library" --label "Folder 1" --value /media/library/Shows`, and
  `$S browser click --in dialog="Add library" --role button --name "Add library"`. The
  `Libraries` table then has the rows `Movies Films /media/library/Movies 6 titles` and
  `Shows Series /media/library/Shows 2 titles`, both `Ready`.
- **Proof.** Run `$S browser screenshot --path captures/verify/<run>/after/setup/scan.png` on the
  scan page, and `$S browser snapshot --in main --path captures/verify/<run>/after/setup/libraries.aria.txt`
  on Admin, Libraries.

## Gotchas

- `Password` needs `--exact`: the field's `Show password` button matches it otherwise.
- The scan page says `done` when the files are scanned, but metadata, people, and scrub
  thumbnails keep running after it. `up` waits for those too (`jobs list` quiet three times);
  a recipe that reads cast or scrub previews right after setup should wait as well.
- `up --no-setup` leaves the side without a CLI session, so `$S cli` refuses and `ios up` won't
  start. Run `$S down --side S` and `$S up --side S` to get the seeded baseline back.
- The before side's setup screens are main's. Compare them only with the same steps on both
  sides.
