# First-run setup

A fresh server sends its first visitor to setup. They create the owner account, name the folder
that holds their music, and watch the real scan index it before the library opens.

## Sub-features

- `setup-owner` creates the first account, which owns the server.
- `setup-folder` adds `/music` as the first library folder.
- `setup-scan` runs the real scanner and reports when the library is ready.
- `setup-open` opens the library with the scanned albums and their art.

## How to get to it (user POV)

- Open the server's address in a browser. Any path redirects to `/setup` until an owner exists.
- On the iOS app, connect to a fresh server. The `(entry)/setup` screens ask for the same steps.

## Driving it with verify-media

Preconditions:

- A side started with `$S up --no-setup`, so no account exists yet.
- `$S doctor` passes all checks except the CLI ones, which it reports as `skip`.

- **Redirect.** Open the server. Run `$S browser --app music open /`, then `$S browser --app music wait --url /setup`.
  The URL ends in `/setup`.
- **Owner.** Fill the account form. Run `$S browser --app music fill --label Name --value "Lucía"`,
  `$S browser --app music fill --label Email --value admin@movies.local`,
  `$S browser --app music fill --label Password --value password123`, and
  `$S browser --app music click --role button --name "Create admin account"`. The heading
  `Where's your music?` appears.
- **Folder.** Run `$S browser --app music fill --label "Library folder" --value /music` and
  `$S browser --app music click --role button --name "Start scanning"`.
- **Scan.** Wait for it. Run `$S browser --app music wait --role heading --name "Your library is ready" --timeout 300000`.
- **Open.** Run `$S browser --app music click --role button --name "Open my library"` and
  `$S browser --app music wait --role heading --name "Recently added"`. Album art shows under it.
- **Proof.** Run `$S browser --app music screenshot --path captures/verify/<run>/after/music/setup/library.png` and
  `$S browser --app music snapshot --in main --path captures/verify/<run>/after/music/setup/library.aria.txt`.
  After you create a key (as `up` does), `$S cli --app music -- albums list --json` lists every album in the
  library.

## Gotchas

- `$S cli` needs an API key, which exists only after setup. Create one at `/settings/keys`
  (`New key`, then `Create key`; the key is in the element with test id `new-api-key`), and never
  put that screen in evidence.
- The scan of the demo library takes seconds; a large real library takes minutes. Raise
  `--timeout` rather than adding sleeps.
- `up --no-setup` leaves the side without a key, so `$S doctor` skips the music CLI check. It
  also leaves movies without its owner: set that up through movies' own setup when a recipe needs
  both.
