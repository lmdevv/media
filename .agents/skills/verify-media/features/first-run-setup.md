# First-run setup

A fresh server sends its first visitor to setup. They create the owner account and point the
server at folders of films and shows. On the `one-backend` layout that happens in the account
client at `/`, the one sign-in for every app, and each library's first scan runs in the
background; in old movies (`one-port`), the movies client walks through its own welcome, first
library, and scan, and a second library is added from its Admin, Libraries.

## Sub-features

- `setup-owner` creates the first account, which owns the server.
- `setup-library` adds `/media/library/Movies` as the first library, of movies.
- `setup-scan` runs the real scanner over each library.
- `setup-second-library` adds `/media/library/Shows` as a second library.
- `setup-movies` opens `/movies` signed in with the owner's session (`one-backend`), or on
  `Who's watching?` with the owner's own profile (old movies).

## How to get to it (user POV)

- `one-backend`: open the server's address. `/` reads `Set up your server.` until an owner
  exists. Then the account client's Admin, Libraries (`/admin/libraries`) and its `Add a library`
  form, for every library. `/movies` opens with the same sign-in.
- Old movies: any path under `/movies` redirects to `/movies/welcome` until an owner exists. Then
  `/setup/library` and `/setup/scan`, which the steps lead to, and Admin, Libraries
  (`/admin/libraries`) and its `Add library` button, for every later library.

## Driving it with verify-media on one backend

Preconditions:

- A `one-backend` side started with `$S up --no-setup`, so no account exists yet.
- `$S doctor` passes every check and reports the CLI as `skip`.

Use an account page, `--app account --page owner`, for each step:

- **Owner.** Run `$S browser open --app account --page owner /`. The heading reads
  `Set up your server.` Run `$S browser fill --page owner --label Username --value lucia`,
  `$S browser fill --page owner --label Password --exact --value password123`, and
  `$S browser click --page owner --role button --name "Create owner account"`. Then
  `$S browser wait --page owner --url /home$`: the heading reads `Hi, lucia.`
- **Libraries.** Run `$S browser open --page owner /admin/libraries`, then, in the form,
  `$S browser fill --page owner --in region="Add a library" --label Name --value Movies`,
  `$S browser fill --page owner --in region="Add a library" --label "Folders, one per line" --value /media/library/Movies`,
  and `$S browser click --page owner --in region="Add a library" --role button --name "Add library"`.
  A toast reads `Created Movies. Its first scan is queued.`, and the `Libraries` list gains the
  link `Movies` with `Movies · Manages`. Repeat with `Shows` and `/media/library/Shows`; `Kind`
  stays `Movies` for both.
- **Scan.** Open a library's link. Its page reads `Scanning N of M files`, then `Scanned <time>`.
  After a full `up`, `$S cli -- auth libraries get --library-id <id>` shows
  `"scan": {"status": "succeeded", …}`; after `--no-setup`, `$S cli` has no session.
- **Movies.** Run `$S browser sign-in --page owner-movies`: it signs in at `/` as `lucia` and
  opens `/movies` with that session, with no second sign-in.
- **Shortcut.** `$S browser setup --app account --page owner` runs the owner and libraries steps,
  as `up` does.
- **Proof.** `$S browser snapshot --page owner --in main --path captures/verify/<run>/after/setup/libraries.aria.txt`
  on Admin, Libraries, and a screenshot of each library's page after its scan.

## Driving it with verify-media in old movies

Preconditions:

- A `one-port` side (such as the before side until the movies cutover merges) started with
  `$S up --no-setup`, so no account exists yet.
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

- On `one-backend`, a library is private to whoever made it until it's shared, admins included,
  so a new admin sees no library until Lucía shares one. The seed shares them.
- On `one-backend`, the core has no command that lists jobs, so `up` waits for the first scans'
  metadata and scrub-thumbnail jobs by reading the media service's log (`core-seed.mjs wait`).
- `Password` needs `--exact`: the field's `Show password` button matches it otherwise.
- In old movies, the scan page says `done` when the files are scanned, but metadata, people, and
  scrub thumbnails keep running after it. `up` waits for those too (`jobs list` quiet three times);
  a recipe that reads cast or scrub previews right after setup should wait as well.
- `up --no-setup` leaves the side without a CLI session, so `$S cli` refuses and `ios up` won't
  start. Run `$S down --side S` and `$S up --side S` to get the seeded baseline back.
- The before side's setup screens are main's. Compare them only with the same steps on both
  sides.
