# Account and admin

The account client at `/` is where a person manages themselves and an owner or admin manages the
server, for movies and music alike: their name and password, the devices and API keys signed in as
them, approving a device that shows a code, and for admins the people, groups, libraries, jobs,
devices, guests, server, and backups. The `media` CLI's `auth` and `admin` groups do the same.

## Sub-features

- `account-home` greets the person at `/home` with links to `Movies` and `Music`.
- `account-name` sets the name every app shows in place of the username.
- `account-devices` lists the person's signed-in devices and signs one out.
- `account-api-key` makes a key with chosen scopes, shows it once, and revokes it.
- `account-approve-device` signs a device in from the code it shows.
- `admin-kid-limits` changes a member's highest movie age, and what they see follows.
- `admin-groups` makes a group, adds people to it, and shares a library with it.
- `admin-library` shares a library, scans it, and shows its folders.
- `admin-jobs` lists the server's jobs, with a filter for the failed ones.
- `admin-shared-device` makes a device shared or personal.
- `admin-guests` turns guest links on and off.
- `admin-server` shows the media service and database the server runs.
- `admin-backups` backs the database up on demand and lists the backups.

## How to get to it (user POV)

- `/home` after signing in at `/`, and its `Settings` link. The `Settings` navigation then lists
  `Settings`, `Devices`, `API keys`, and `Approve a device` under `You`, and for an owner or admin
  `Users`, `Groups`, `Libraries`, `Jobs`, `Devices`, `Guests`, `Server`, and `Backups` under
  `Admin`.
- Paths: `/settings`, `/devices`, `/api-keys`, `/device`, `/admin`, `/admin/groups`,
  `/admin/libraries`, `/admin/jobs`, `/admin/devices`, `/admin/guests`, `/admin/server`, and
  `/admin/backups`.
- Terminal: `media auth sessions list`, `media auth api-keys list`, `media auth login`,
  `media admin users list`, `media admin groups list`, `media admin jobs list`, and
  `media admin backups list`.

## Driving it with verify-media

Preconditions:

- `$S doctor` passes, and the side holds the seed.
- An account page as Lucía, `$S browser sign-in --app account --page owner`, which prints
  `signed in as lucia` and ends on `/home`. Each step below takes `--page owner` unless it names
  another page.

- **Home.** `$S browser snapshot --page owner --in main` holds the heading `Hi, lucia.` and the
  links `Movies` and `Music`.
- **Name.** As Sam, so the owner's name stays as the other recipes expect: `$S browser sign-in
  --app account --page sam-acct --username sam`, `$S browser open --page sam-acct /settings`,
  `$S browser fill --page sam-acct --in region=Name --role textbox --value "Sam R."`, and
  `$S browser click --page sam-acct --in region=Name --role button --name Save`. `/home` then
  reads `Hi, Sam R..`, `$S cli --as sam -- auth sessions current` shows `"displayName": "Sam R."`,
  and a movies page of Sam's has the button `Sam R.: switch person`. Fill the field with an empty
  value and `Save` to clear it.
- **API key.** Open `/api-keys`, click `--role button --name "Create key"`, run
  `$S browser fill --page owner --in region="Create key" --label Name --value "verify probe"`, and
  click `--in region="Create key" --role button --name "Create key"`. The region `Key created`
  shows the key once, and the list `API keys` gains `verify probe` with its scopes, `Browse
  movies, Play movies` by default. Sign a CLI config of its own in with it, without printing it:
  `$S browser text --page owner --role status --name "Your new key" | tr -d '\n' | $S cli --as probe -- auth login --server http://localhost:<port>/convex --api-key`.
  `$S cli --as probe -- auth sessions current` shows `"kind": "apiKey"` and the two scopes,
  `$S cli --as probe -- movies titles list` lists the titles, and
  `$S cli --as probe -- music albums list` exits 4 with `This session lacks the music:read scope`.
  Click `Done`, then `--role button --name "Revoke verify probe"` and the note's `--role button
  --name Revoke --exact`: the page reads `No API keys.`, and the probe's next command exits 3.
- **Approve a device.** Start a sign-in that waits for its code: `$S cli --as codeprobe -- auth
  login --server http://localhost:<port>/convex`, in the background with its output in a file. Its
  first line is `{"event":"device_code","userCode":"XXXX-XXXX",…}`. On Sam's page open `/device`,
  click `--role textbox --name "Code from your device"`, and `type --value` the code without its
  dash: the page moves on by itself to `media CLI on <host> wants to sign in as sam.` with what it
  `Can` do. Click `--role button --name Approve`: the page reads `media CLI on <host> is signed
  in.`, the command exits 0 with `"kind": "deviceCode"`, and `$S cli --as codeprobe -- movies
  titles list` lists Sam's two titles.
- **Devices.** On Sam's page open `/devices`: the list `Signed-in devices` holds `media CLI on
  <host>` beside his browsers. Click `--role button --name "Sign out media CLI on <host>"`, then
  the note's `--in note --role button --name "Sign out" --exact`. The row goes, and the probe's
  next command exits 3 with `ended this session`.
- **Kid limits.** Open `/admin`, click `--role button --name "Manage kids"`, run
  `$S browser select --page owner --label "Highest movie age" --value "13 · PG-13"`, and click
  `--role button --name "Save limits"`: a toast reads `Limits saved`, and
  `$S cli --as kids -- movies titles list` lists 6 titles in place of 3. Set `7 · PG` and save to
  put the seed's limit back.
- **Group.** Open `/admin/groups`, `fill --label "New group" --value "Film club"`, and click
  `--role button --name Create --exact`. Click `--role button --name "Manage Film club"`,
  `select --label "Add someone" --value sam`, and `--role button --name Add --exact`: the list
  `Members of Film club` holds `sam`, and `$S cli -- admin groups list` lists the group.
- **Share a library.** Open `/admin/libraries` and click `--in list=Libraries --role link --name
  Movies --exact`. The page reads `Movies · 6 items · Manages`, with the regions `Name`,
  `Folders` (`/media/library/Movies`), `Shared with`, and `Remove`. Run
  `$S browser select --page owner --label "Share with" --value "Film club (group)"` and click
  `--in region="Shared with" --role button --name Share --exact`:
  `$S cli --as sam -- movies titles list` lists all 8 titles in place of 2. Back on
  `/admin/groups`, `Manage Film club`, `Remove group`, and the note's `--role button --name Remove
  --exact` leave `No groups yet.` and Sam with 2 titles again.
- **Jobs.** Open `/admin/jobs`: the list `Jobs` and the group `Show` with `All` and `Failed · 0`.
  Clicking `Failed` reads `No failed jobs.`, and `$S cli -- admin jobs list` lists each job's
  `kind`, `status`, and `message`.
- **Shared device.** Open `/admin/devices`: each row reads `<device> Personal` with `Make shared`
  and `Remove`. [People and access](./people-and-access.md) makes one shared and opens its picker.
- **Guests.** Open `/admin/guests`: the switch `Allow guest links`, the field `Guest address`, and
  under `Everyone's links` the line `Nobody has made a guest link.` Clicking the switch checks it,
  and clicking it again clears it.
- **Server.** Open `/admin/server`: `localhost:<port> · media service running`, `Hardware
  transcoding`, and the terms `Playing now`, `Media service`, and `Database`, each with the side's
  address and version.
- **Backups.** Open `/admin/backups` and click `--role button --name "Back up now"`. Within a few
  seconds the region `Backups` reads `1 kept` and lists a `Manual` backup named
  `media-manual-<time>.zip` with a `Restore…` button, and `$S cli -- admin backups list` shows its
  `fileName` and `sizeBytes`.
- **Proof.** `$S browser screenshot --page owner --path captures/verify/<run>/after/admin/<page>.png`
  on each page, with the CLI's output beside it. Never capture `Key created`, a device code, or an
  invite link.

## Gotchas

- `--in main` on an account page holds the `Settings` navigation too. Scope to a region or a list,
  such as `--in region="Shared with"` or `--in list=Jobs`, to read one part.
- A confirmation is a note inside the row, not a dialog: click the row's button, then the same
  name `--in note`.
- The code field is eight boxes. Click the first, `Code from your device`, before you type;
  `Continue` stays disabled until all eight hold a character, and the page moves on without it.
- `select --value` takes the option's label, such as `13 · PG-13` or `Film club (group)`.
- Changing Lucía's name changes every region and heading named for her, such as `Continue watching
  for lucia`. Use another person for the name step.
- A sign-in of its own, `$S cli --as <name> -- auth login`, keeps its config in the side's state
  folder until `down`. Sign it out or revoke its key when the step ends.
- Guest links, restoring a backup, removing a library, and handing over ownership change the side
  for every later recipe. Run them last, or on a side of their own.
