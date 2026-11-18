# First-run setup

A fresh server sends its first visitor to setup. They create the owner account and point the
server at folders of films and shows. That happens in the account client at `/`, the one sign-in
for every app, and each library's first scan runs in the background.

## Sub-features

- `setup-owner` creates the first account, which owns the server.
- `setup-library` adds `/media/library/Movies` as the first library, of movies.
- `setup-scan` runs the real scanner over each library, and again from the library's `Scan now`.
- `setup-second-library` adds `/media/library/Shows` as a second library.
- `setup-movies` opens `/movies` signed in with the owner's session.

## How to get to it (user POV)

- Open the server's address. `/` reads `Set up your server.` until an owner exists. Then the
  account client's Admin, Libraries (`/admin/libraries`) and its `Add a library` form, for every
  library. `/movies` opens with the same sign-in.

## Driving it with verify-media

Preconditions:

- A side started with `$S up --no-setup`, so no account exists yet.
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
- **Scan.** Open a library's link. Its page reads `Scanning N of M files`, then `Scanned <time>`;
  the demo library scans within a second or two, so it may already read `Scanned`. `Scan now`
  shows the toast `Scan queued` and scans again.
- **CLI.** After `--no-setup`, `$S cli` has no session. Sign Lucía's in with
  `printf %s password123 | $S cli -- auth login --server http://localhost:<port>/convex --username lucia`.
  Then `$S cli -- auth libraries list` gives each `libraryId`,
  `$S cli -- auth libraries get --library-id <id>` shows `"scan": {"status": "succeeded", …}`, and
  `$S cli -- admin jobs list` lists the scans (`movies.scan`) and scrub thumbnails
  (`movies.trickplay`).
- **Movies.** Run `$S browser sign-in --page owner-movies`: it signs in at `/` as `lucia` and
  opens `/movies` with that session, with no second sign-in.
- **Shortcut.** `$S browser setup --app account --page owner --shows /media/library/Shows
  --music-folder /media/library/Music` runs the owner and libraries steps, as `up` does. Without
  the flags it adds `Movies` alone.
- **Proof.** `$S browser snapshot --page owner --in main --path captures/verify/<run>/after/setup/libraries.aria.txt`
  on Admin, Libraries, and a screenshot of each library's page after its scan.

## Gotchas

- A library is private to whoever made it until it's shared, admins included,
  so a new admin sees no library until Lucía shares one. The seed shares them.
- `up` waits for the first scans' metadata and scrub-thumbnail jobs by reading the media service's
  log (`core-seed.mjs wait`). The account client's Admin, Jobs and `$S cli -- admin jobs list`
  show the same jobs.
- `Password` needs `--exact`: the field's `Show password` button matches it otherwise.
- `up --no-setup` leaves the side without a CLI session, so `$S cli` refuses until the `auth
  login` above, and `ios up` won't start. Run `$S down --side S` and `$S up --side S` to get the
  seeded baseline back.
- The before side's setup screens are main's. Compare them only with the same steps on both
  sides.
