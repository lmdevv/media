# Movies: the [movies] server's commands

These commands reach the [movies] server, at the top level of `media` (`media search`,
`media play`), until the movies port moves them under `media movies`. Each one is a command in
the movies server's registry, so the CLI, the web app, and this reference always agree. Output
is JSON by default. `SKILL.md` covers installing `media`, output, and exit codes.

## Setup

`MEDIA_CONVEX_URL` beats a stored login: while it names another server, a profile saved for a
different one stays unused, even with `--profile`. Run `MEDIA_CONVEX_URL= MEDIA_SERVER_URL= media
...` to use that profile.

The server URL is the install's Convex URL (`CONVEX_PUBLIC_URL`; port 3210 on the Compose and
NixOS installs, such as `http://nas.tailnet.ts.net:3210`); the media service URL is the web
address (`MEDIA_BASE_URL`, port 8080).

- **API key (agents, CI):** create one in the web app (Settings → API keys) or with
  `media keys create agent --scopes read,play` from a signed-in machine. The secret is shown once.

  ```sh
  media login --server http://nas.tailnet.ts.net:3210 --media-url http://nas.tailnet.ts.net:8080 --api-key mk_...
  media whoami
  ```

  Or set `MEDIA_CONVEX_URL`, `MEDIA_SERVER_URL`, and `MEDIA_API_KEY` instead of logging in, so
  the key never touches the disk. Then choose the viewing profile once with
  `media profiles list` and `media profiles use <name>`; the config file keeps that choice and
  the server URL, never the key. A stored profile for another server than `MEDIA_CONVEX_URL` is
  left alone: its key and session are never sent to the other server.

- **Device login (people):** `media login --server <url>` prints a short code and an approval URL
  (and a QR code with `--human`), then waits until someone approves it in the web app. In JSON mode
  the first stderr line is `{"event":"device_code","userCode","verificationUrl","expiresAt"}`;
  relay the code and URL to the user, then wait for the command to exit.
- **Password:** `media login --server <url> --email you@example.com --password`, with the
  password piped on stdin or in `MEDIA_PASSWORD`.

`login` stores the server, this install's device ID, the session, and the default viewing profile
in `$XDG_CONFIG_HOME/movies/config.json` (mode 0600). `--profile <name>` (or `MEDIA_PROFILE`)
selects another stored server. `media logout` signs out and forgets the key and session.

## How it works

- `media <group> <action> [flags]` runs registry command `<group>.<action>`; words are kebab-case
  (`media api-keys create`, `media history continue-watching`). `media call <name> --json
  '{...}'` runs any command by its dotted name, including ones a shortcut replaces.
- Flags come from the argument schema: `titleId` is `--title-id`. When a command needs exactly one
  value it can go first without its flag: `media titles get <title-id>`. Lists take repeated flags
  or commas (`--scopes read,play`). `--json '<object>'` passes the whole argument object; flags
  override its fields.
- `--profile-id` and `--device-id` default to the stored viewing profile and this install's
  device. Choose the profile with `media profiles use <name-or-id>`.
- IDs are opaque strings from earlier results. Never invent them.
- Results print as JSON on stdout. Errors print on stderr as `{"error":{"code","message"}}`.
  When the media service answered the failed request, the error also carries `requestId`:
  `media logs --grep <request-id>` finds that request's records. `--human` (or `--format
  table`) prints tables and sentences instead, with the ID on a `Request ID:` line.
- Stdout carries only the result. Log records go to stderr, one JSON object per line
  (`message`, `level`, `timestamp`, `annotations`) beside the error line, or as text with
  `--human`: warnings and errors by default, and debug records too with `--verbose`, such as
  `MediaHttp.response` with each media service answer's `requestId`.
- Commands that queue a job (scans, metadata refreshes, backups, migrations) return a `jobId` at
  once. Add `--wait` to follow it until it ends; progress goes to stderr. A registry command's
  output then becomes `{ "result", "job" }`; the `scan`, `import`, and `backup` shortcuts keep
  their `{ "jobIds" }` or `{ "jobId" }` output and add `"jobs"`, the finished jobs.
  `--timeout <seconds>` (default 3600) bounds the whole wait, even when a scan queued several jobs.
- `media commands` lists every command with its flags and its arguments as JSON Schema;
  `media <command> --help` shows one.
- Scopes limit what a session may do: `read`, `play`, `account`, `manage` (libraries, scans,
  metadata; admins), `admin` (users, invites, backups, migration; admins). A missing scope fails
  with `forbidden`.

## Recipes

Find something and play it in mpv or VLC:

```sh
media search alien
media play "Alien" --open           # launches mpv; without --open, prints .url
media play "The Expanse" --human    # a show plays its next episode
media titles versions <title-id>    # a title with several files: editions, parts, qualities
media play "Alien" --version "Director's Cut"   # or --version 2, its number in that list
media continue                      # what to resume
media progress "The Expanse"
```

Watch together (the host's device controls the room; guests follow):

```sh
media rooms create "Alien" --position 0     # host → .id
media rooms join <room-id>                  # guest, on another install or account
media rooms play                            # host; acts on the room this device is in
media rooms pause
media rooms seek --position 1:02:30
media rooms next                            # host; the whole room moves on to the next episode
media rooms countdown                       # host; everyone moves on in 10 s unless cancelled
media rooms cancel-countdown                # host; watch the credits instead, for everyone
media rooms status --watch                  # one JSON line per change; exits when the room ends
media rooms leave                           # a host leaving ends the room
```

A guest's `rooms play|pause|seek` fails with `forbidden`. A control racing another change is
retried once at the new revision.

Shows move on together. The room's `next` holds its countdown: `pending` with the next `episode`
and `nextAt`, a server time when the server moves every member on (also with the host gone), or
`cancelled` after the host chose the credits; any change of media clears it. Only the host's
device starts, cancels, or skips it (`next`, `countdown`, `cancel-countdown`; guests get
`forbidden`). `rooms next` names the episode the room plays as it reads it, so racing the
countdown moves the room on once; run it again to move on again. After the last episode they fail with `not_found`, and when the next
episode's file is missing with `conflict`. A moved room is paused at the start of the new
episode, on the same room and link; each member's player opens it with its own stream and
progress.

Members heartbeat every 5 seconds: a guest silent for a minute leaves, and a host silent for 20
seconds pauses the room (`hostAway`); a member whose last heartbeat said away gets three minutes.
Each member shows a `presence`: `watching` from a player, `away` from a device that keeps its place
while browsing (`media rooms heartbeat <room-id> --presence away`), once its player has been
silent for 10 seconds. Away members report no drift, and an away host's room keeps playing for the
guests.

Libraries and scans (admin):

```sh
media libraries create --name Films --kind movies --roots /srv/films --wait
media scan Films --mode quick --wait
media jobs list --status running
```

Fix a wrong match (admin):

```sh
media metadata search-candidates --title-id <title-id> --query "Alien" --year 1979
media metadata fix-match --title-id <title-id> --provider tmdb --provider-id 348 --wait
```

Accounts and access:

```sh
media keys create ci --scopes read,manage --expires-in-days 90   # .secret is shown once
media keys list
media keys revoke ci
media invites create --role member --email friend@example.com    # share .url
media device-auth approve --user-code ABCD-EFGH --scopes read,play
media sessions list
```

Migrate from Jellyfin or Plex, back up, and restore (admin):

```sh
echo "$JELLYFIN_API_KEY" | media import jellyfin --url http://jellyfin:8096 --dry-run
echo "$JELLYFIN_API_KEY" | media import jellyfin --url http://jellyfin:8096 \
  --path-map /data/movies=/mnt/nas/movies --map <source-user-id>=<profile-id> --wait
echo "$PLEX_TOKEN" | media import plex --url http://plex:32400 --dry-run
media backup --wait
media backups list
media restore movies-2026-10-12.zip        # every session signs in again
```

Find out why playback buffered or stopped, from the media service's retained log:

```sh
media diagnostics sessions --since 2d --human        # find the session; members see their own
media diagnostics playback <session-id> --human      # its timeline; JSON without --human
media logs --session-id <session-id> --level warn    # admin: the raw records, printed for people
media logs --since 1h --slow 1s --json               # admin: slow segments as NDJSON
media logs --follow --level warn                     # admin: watch new warnings as they happen
media logs --grep Client.error --since 1d            # admin: errors the web and iOS apps reported
```

`media import` connects, dry-runs, and only then imports what that dry run planned. Read the
dry run's `users`: an `invite` user has no [movies] account yet, so import never creates one;
invite the person or `--map` them to a profile (`skip` leaves them out). A source folder maps on
its own when a `LIBRARY_ROOTS` folder ends in the same names (`/data/movies` to
`/mnt/nas/movies`); pass `--path-map` for the rest.
Media files are never moved or copied. Running the import again changes nothing already imported,
and newer [movies] progress is kept unless the source played the item more recently.

## Troubleshooting

- `not_logged_in`: run `media login`, or set `MEDIA_CONVEX_URL` and `MEDIA_API_KEY`.
- `unauthenticated` after it worked before: the key or session was revoked. A stored API key signs
  in again on its own; otherwise log in again.
- `unavailable`: the URL is wrong or the server is down. The server URL is the Convex URL.
- `No viewing profile`: run `media profiles list` and `media profiles use <name>`.
- `forbidden` on a PIN profile: `media profiles unlock --pin <pin>` for this session first.
- A job stuck in `pending` means the media service is not running.
- A scan job that fails with `Library root not approved` names a folder outside the media
  service's `LIBRARY_ROOTS`; point the library at an approved folder (`media libraries update`).
- Spinners, stalls, or a stream that stops: run `media diagnostics sessions` to find the
  playback session, then `media diagnostics playback <session-id>`. Read its `counts`, then the
  `entries`. A `slow-segment` splits the wait into encoder (`encoderWaitMs`: the transcoder was
  behind; check CPU or GPU load and `MAX_CONCURRENT_TRANSCODES`), disk (`diskReadMs`: a slow
  share), and network (`networkWriteMs`: a slow link to the player; try `media play
  --max-height 720`). A `stream-moved` saying `Encoder stopped` means the player paused or went
  quiet for `STREAM_IDLE_SECONDS`; the stream stays, and its next segment restarts the encoder a
  few seconds slower. `Encoder not restarted` means no transcode slot or space was free; the stream
  then ends with reason `resume-refused`, and the player negotiates a new one. A `stream-ended`
  names its reason and how recently the stream was used; logs from older services may show reason
  `idle`, which closed the stream for good.
  A `request-failed` 401 with `Playback token has expired` means the player kept using its
  playback token past expiry; the player must renew it with `playback.renewToken` before then.
  `startup` is how long the player waited for the session to first play, never a stall. Newer
  players split it in its `details`: `negotiatedMs`, `manifestLoadedMs`, `firstFragmentMs`, and
  `firstFrameMs`, each in milliseconds from the viewer's play intent; a stage the player did not
  see is absent. A stage is measured to the first startup that ends; a startup after the viewer
  paused it carries none. The first `startup` entry also holds the segment loads before it ended,
  of its own stream and at most 12, in `details.segmentLoads` (`index`, `segment`, `elapsedMs`,
  `firstByteMs`, `bytes`), with their median and slowest in its summary: loads after a seek or a
  stream change never count as startup. When no startup ended, `missing` says how many loads were
  left out. `player-attached` names the audio the player got (`audioCodec`, `audioChannels`,
  `audioLanguage`) when it knows it. `buffering-started` and `buffering-ended` are the player's
  own stalls after that. `slow-fragment` is hls.js waiting a second or more on a segment, at
  `WARN`, whether or not it is among the first 12. `recovery` is the player starting over, except
  `renew-token`: a routine renewal of the playback token, at `INFO`, shown but not counted in
  `counts.recoveries`.
- The timeline never guesses. `drift` is `measured` only from browsers. The player takes a sample
  every 10 s while it plays (none in the 2 s after it starts playing or seeks), and reports one
  summary a minute. A sample is the media time of the video frame on screen minus the media clock
  when it showed, so a negative value means the picture trails the sound. `samples` counts them,
  `medianMs` is the median of the per-minute medians, and `worstMs` is the sample furthest from
  zero, with its sign. Otherwise `drift` is `not-measured` with one of these reasons: the iOS app
  cannot measure it (AVPlayer through expo-video exposes neither frame times nor its audio clock);
  `LOG_LEVEL` is above `info`, which keeps no drift reports; the browser sent none (it lacks
  `requestVideoFrameCallback`, it stopped before its first sample 10 s in, or its web app predates drift
  sampling); or the player sent no diagnostics at all. A client that does not send
  `measuredDrift` gets a measured drift as `not-measured`, with the numbers in the reason.
  `missing` names what the logs cannot tell, such as a player that sent no diagnostics (mpv and
  VLC send none) or a `LOG_LEVEL` above `info` that keeps no `INFO` records. Say so rather than
  inferring a cause.
- `media logs` needs an admin session (`forbidden` otherwise) and the media service URL
  (`MEDIA_SERVER_URL`). It prints for people by default; `--json` prints the NDJSON records for
  parsing. Records older than `LOG_RETENTION_DAYS` (14) are gone. When stderr says older records
  may match too, narrow it with `--since` or raise `--limit`. When stderr says the service has
  not been able to write or read its retained log since a time, records since then are only on
  its standard output (`docker compose logs movies`, `journalctl -u movies`): report that rather
  than treating the empty answer as a quiet log. `--follow` exits `unavailable` when the
  service goes away, as it does when it restarts. HTTP request lines are `DEBUG`: they are
  there only while the service runs with `LOG_LEVEL=debug`.
- A failed media service command prints `error.requestId`. `media logs --grep <request-id>`
  finds every record of that request; its `DEBUG` access lines exist only at `LOG_LEVEL=debug`.
- The web and iOS apps report a crashed page or screen and any uncaught error or unhandled
  rejection (web only) as a `WARN` record `Client.error` with `source: "client"`, the reporting
  `userId`, `platform`, `appVersion`, `kind`, `route`, `errorName`, `errorMessage`, and `stack`.
  `failedRequestId` is the media service request the error came from, so `media logs --grep
  <failedRequestId>` finds the server's side too. `claimedSessionId` is a playback session the
  app named; the app's claim, not checked. Signed-out apps send nothing, a repeated error is sent
  once per 30 seconds, and the service limits each account and all of them together, so a
  missing report is not proof of no error. `media logs --grep ClientErrors.suppressed` counts
  the reports it refused, by `userId`.
- `media play` failures from the media service print `playback_<recovery>` codes:
  `playback_unsupported` (this player cannot play the file in any mode), `playback_retry_later`
  (exit 9: transcoders busy or the media service cannot reach its files right now),
  `playback_new_session` (the session ended; run `media play` again), and `playback_fail`.

## Command reference

<!-- BEGIN:commands -->
<!-- Generated from the command registry by `pnpm --filter @lmdevv/movies skill:reference`. Do not edit by hand. -->

### Shortcuts

- `media login [--server <convex-url>] [--media-url <url>] [--api-key <key> | --email <email> --password]`: Sign in: device login by default (prints a code, a URL, and a QR code, then waits); --api-key or --email with --password (read from stdin or MEDIA_PASSWORD).
- `media logout`: Sign out and forget the session.
- `media whoami`: Show the account, session scopes, server, device, and default viewing profile.
- `media profiles use <profile-id-or-name>`: Choose the viewing profile commands use when --profile-id is not given.
- `media keys create <name> --scopes <read|play|manage|admin,...> [--expires-in-days <int>]`: Create an API key; the secret is printed once.
- `media keys list`: List this account's API keys.
- `media keys revoke <api-key-id-or-name>`: Revoke an API key and end every session it signed in.
- `media search <query> [--limit <int>] [--profile-id <id>]`: Search titles on the default viewing profile.
- `media play <title> [--episode-id <id>] [--version <name|number>] [--from <seconds>] [--max-height <lines>] [--open]`: Start playback of a title ID or the best name match (a show resumes its next episode) and print the stream URL for mpv or VLC; --version picks a file by its name or its number in `titles versions` (default: the one this profile last played, else the best quality); --max-height caps the picture, such as 720 on a slow link (a taller source is transcoded down); --open launches mpv.
- `media progress [<title>] [--profile-id <id>]`: Show a title's progress, or the recent watch history.
- `media continue [--profile-id <id>]`: List what to resume and which episodes come next.
- `media rooms create <title> [--episode-id <id>] [--position <seconds>] [--profile-id <id>]`: Start a watch room hosted by this device, paused at the position.
- `media rooms join <room-id> [--profile-id <id>]`: Join a room on this device with the default viewing profile.
- `media rooms play [<room-id>] [--position <seconds>]`: Host: play the room from its current position or --position.
- `media rooms pause [<room-id>]`: Host: pause the room at its live position.
- `media rooms seek [<room-id>] --position <seconds>`: Host: move the room to a position.
- `media rooms next [<room-id>]`: Host: move the whole room on to the next episode now; racing the countdown moves it on once.
- `media rooms countdown [<room-id>]`: Host: start the room's 10-second next-episode countdown; the server moves everyone on when it ends.
- `media rooms cancel-countdown [<room-id>]`: Host: cancel the next-episode countdown for everyone, to watch the credits.
- `media rooms leave [<room-id>]`: Leave the room; a host leaving ends it.
- `media rooms status [<room-id>] [--watch] [--profile-id <id>]`: Show the room's clock, live position, and members; --watch prints every change until the room ends.
- `media scan [<library-id-or-name>] [--mode quick|full] [--wait [--timeout <seconds>]]`: Scan one library, or every library, for new, changed, and missing files.
- `media import jellyfin|plex --url <server-url> [--user <jellyfin-admin>] [--path-map <source-folder>=<local-folder>,...] [--map <source-user-id>=<profile-id>|skip,...] [--dry-run] [--wait [--timeout <seconds>]]`: Migrate libraries, watch history, favorites, collections, and metadata overrides; the token (or --user's password) is read from stdin, MEDIA_IMPORT_TOKEN, or MEDIA_IMPORT_PASSWORD.
- `media backup [--wait [--timeout <seconds>]]`: Back up the database now.
- `media restore <backup-file-or-id>`: Restore the database from a backup; every session signs in again.
- `media logs [--follow] [--since <duration|time>] [--until <duration|time>] [--level trace|debug|info|warn|error|fatal] [--session-id <id>] [--stream-id <id>] [--slow <duration>] [--grep <text>] [--limit <int>] [--json|--human]`: Read the media service's retained log, newest last (admin sessions only); --follow keeps printing new records, --since 15m or a time starts there, --slow 1s keeps timed requests at least that long, --json prints the NDJSON records; a followed log the service ends fails as unavailable.
- `media diagnostics sessions [--since <duration|time>] [--json|--human]`: List the playback sessions the retained log mentions (the last day by default), newest first; members see their own.
- `media diagnostics playback <session-id> [--json|--human]`: Print a playback session's timeline: streams and why they ended, slow and failed segments with their time split, the player's startup, stalls, errors, and recoveries, audio/video drift where the player measures it, and the evidence that is missing.
- `media commands [--markdown]`: List every command with its flags and argument JSON Schema.
- `media call <command-name> [--json <object>]`: Run any registry command by its dotted name, such as rooms.pause.

### setup

- `media setup status`: Show whether the server has an owner and a library yet. (no sign-in needed)

### account

- `media account viewer`: Show the signed-in account and what this session may do. (any session)
- `media account change-password --current-password <text> --new-password <text>`: Change the account's password after checking the current one. (scope account)

### invites

- `media invites lookup <code>`: Show an invite's state from its code. (no sign-in needed)
- `media invites create [--email <text>] <admin|member> [--expires-in-days <int>]`: Invite someone to create an account. (scope admin)
- `media invites list`: List invites. (scope admin)
- `media invites revoke <invite-id>`: Revoke an open invite. (scope admin)

### users

- `media users list`: List accounts. (scope admin)
- `media users set-role --user-id <id> --role <admin|member>`: Make an account an admin or a member. (scope admin)
- `media users disable <user-id>`: Disable an account and sign out all of its sessions. (scope admin)
- `media users enable <user-id>`: Re-enable a disabled account. (scope admin)
- `media users set-library-access --user-id <id> --library-ids <id,...>`: Choose which restricted libraries a member can see. (scope admin)

### keys

- `media api-keys create --name <text> --scopes <read|play|manage|admin,...> [--expires-in-days <int>]`: Create a scoped API key; the secret is shown once. (scope account)
- `media api-keys list [--user-id <id>]`: List API keys; admins may list another account's. (scope account)
- `media api-keys revoke <api-key-id>`: Revoke an API key and end every session it signed in. (scope account)

### devices

- `media device-auth request <client-name>`: Start a device sign-in and get a code to approve. (no sign-in needed)
- `media device-auth status <device-code>`: Watch whether a device sign-in was approved. (no sign-in needed)
- `media device-auth lookup <user-code>`: Show the device behind a sign-in code. (scope account)
- `media device-auth approve --user-code <text> --scopes <read|play|account|manage|admin,...>`: Approve a device sign-in with chosen scopes. (scope account)
- `media device-auth deny <user-code>`: Deny a device sign-in. (scope account)

### sessions

- `media sessions list`: List signed-in browsers, devices, and API keys. (scope account)
- `media sessions revoke <session-id>`: Sign out a session. (scope account)

### profiles

- `media profiles list`: List this account's profiles. (scope read)
- `media profiles create --name <text> --avatar <text> (--kids | --no-kids) [--max-age-rating <int>]`: Create a profile. (scope account)
- `media profiles update [--profile-id <id>] [--name <text>] [--avatar <text>] [--kids | --no-kids] [--max-age-rating <int>]`: Rename a profile or change its avatar or rating limit. (scope account)
- `media profiles remove [--profile-id <id>]`: Delete a profile with its history and list. (scope account)
- `media profiles set-pin [--profile-id <id>] <pin>`: Set or clear a profile PIN. (scope account)
- `media profiles unlock [--profile-id <id>] <pin>`: Unlock a PIN profile for this session. (scope read)
- `media profiles lock [--profile-id <id>]`: Lock a PIN profile again on this session. (scope read)

### browse

- `media titles home [--profile-id <id>]`: Show the home rows for a profile. (scope read)
- `media titles list [--profile-id <id>] [--cursor <text>] [--limit <int>] [--kind <movie|show>] [--library-id <id>] [--sort <name|added|year>] [--genre <text>] [--year-from <int>] [--year-to <int>] [--studio <text>] [--min-rating <number>]`: List movies or shows. (scope read)
- `media titles genres [--profile-id <id>] [--kind <movie|show>]`: List genres of the titles a profile may see, most common first. (scope read)
- `media titles similar [--profile-id <id>] <title-id> [--limit <int>]`: Show titles like this one that a profile may see. (scope read)
- `media titles search [--profile-id <id>] <query> [--limit <int>]`: Search titles by name. (scope read)
- `media titles get [--profile-id <id>] <title-id>`: Show a movie or show. (scope read)
- `media titles versions [--profile-id <id>] <title-id> [--episode-id <id>]`: List the versions (files) of a movie or an episode, best quality first. (scope read)
- `media titles episodes [--profile-id <id>] --title-id <id> --season-number <int>`: List a season's episodes. (scope read)
- `media libraries list`: List the libraries this account can see. (scope read)
- `media collections list [--profile-id <id>] [--limit <int>]`: Show collections and the titles a profile may see in each. (scope read)
- `media collections get [--profile-id <id>] <collection-id>`: Show a collection and the titles a profile may see in it. (scope read)
- `media people get [--profile-id <id>] <person-id>`: Show a person and the titles a profile may see them in. (scope read)
- `media people search [--profile-id <id>] <query> [--limit <int>]`: Search cast and crew by name. (scope read)
- `media people request-details [--profile-id <id>] <person-id>`: Fetch a person's biography and dates if they are missing. (scope read)

### history

- `media history continue-watching [--profile-id <id>]`: List what to resume and which episodes come next. (scope read)
- `media history list [--profile-id <id>] [--cursor <text>] [--limit <int>]`: List a profile's watch history, most recent first. (scope read)
- `media history mark-watched [--profile-id <id>] <title-id> [--episode-id <id>]`: Mark a movie, episode, or whole show watched. (scope play)
- `media history mark-unwatched [--profile-id <id>] <title-id> [--episode-id <id>]`: Mark a movie, episode, or whole show unwatched. (scope play)
- `media my-list list [--profile-id <id>]`: Show a profile's list. (scope read)
- `media my-list add [--profile-id <id>] <title-id>`: Add a title to my list. (scope play)
- `media my-list remove [--profile-id <id>] <title-id>`: Remove a title from my list. (scope play)

### playback

- `media playback create-session [--profile-id <id>] [--device-id <id>] [--device-name <text>] <title-id> [--episode-id <id>] [--file-id <id>] [--room-id <id>] [--capabilities <json>]`: Start playing a movie or episode on this device. (scope play)
- `media playback renew-token <session-id>`: Get a fresh playback token for an active session. (scope play)
- `media playback report-progress --session-id <id> --position-ms <number> [--duration-ms <number>] --event <tick|pause|resume|seek|ended>`: Report this device's position. (scope play)
- `media playback end-session --session-id <id> --position-ms <number>`: Stop playback on this device. (scope play)
- `media playback next-episode [--profile-id <id>] <episode-id>`: Show the episode after this one. (scope read)
- `media downloads start [--profile-id <id>] [--device-id <id>] [--device-name <text>] <title-id> [--episode-id <id>] [--file-id <id>] [--capabilities <json>]`: Start downloading a movie or episode to keep on this device. (scope play)
- `media downloads end <session-id>`: End a finished or cancelled download's session. (scope play)
- `media downloads record-progress [--profile-id <id>] --title-id <id> [--episode-id <id>] --file-id <id> --position-ms <number> --duration-ms <number> --played-at <int> --sent-at <int>`: Save progress made while playing a download offline. (scope play)
- `media playback active`: List this account's active playback on every device. (scope read)

### rooms

- `media call rooms.create --json <object>`: Start a watch room for what this device is playing. (scope play)
- `media rooms get <room-id> [--profile-id <id>]`: Show a room's members and committed clock. (scope read)
- `media rooms current [--device-id <id>]`: Show the room this device is in. (scope read)
- `media call rooms.join --json <object>`: Join a room on this device. (scope play)
- `media call rooms.leave --json <object>`: Leave a room; the host leaving ends it for everyone. (scope play)
- `media call rooms.play --json <object>`: Play the room from the host's position. (scope play)
- `media call rooms.pause --json <object>`: Pause the room at the host's position. (scope play)
- `media call rooms.seek --json <object>`: Move the room to a position. (scope play)
- `media rooms buffering --room-id <id> [--device-id <id>] --revision <int> --position-ms <number> [--file-id <id>]`: Freeze the room while the host buffers. (scope play)
- `media rooms heartbeat <room-id> [--device-id <id>] [--position-ms <number>] [--at-server-time <int>] [--revision <int>] [--file-id <id>] [--drift-ms <number>] [--presence <watching|away>]`: Report this device is still in the room; the host also reports its position. (scope play)
- `media rooms set-media --room-id <id> [--device-id <id>] --revision <int> --title-id <id> [--episode-id <id>] [--file-id <id>]`: Switch the room to another title or episode, paused at the start. (scope play)
- `media rooms start-next-countdown --room-id <id> [--device-id <id>] --from-episode-id <id>`: Host: start the room's countdown to the next episode; the server moves everyone on when it ends. (scope play)
- `media rooms cancel-next-countdown --room-id <id> [--device-id <id>] --from-episode-id <id>`: Host: cancel the next-episode countdown for everyone, to watch the credits. (scope play)
- `media rooms play-next --room-id <id> [--device-id <id>] --from-episode-id <id>`: Host: move the room on to the next episode now; once per episode. (scope play)
- `media rooms end <room-id> [--device-id <id>]`: End the room for everyone. (scope play)
- `media rooms time`: Read the server clock to estimate this device's offset. (scope play)

### libraries

- `media libraries list-details`: List every library with its folders and access. (scope manage)
- `media libraries get <library-id>`: Show a library's folders and access. (scope manage)
- `media libraries create --name <text> --kind <movies|shows|mixed> --roots <text,...> [--access <everyone|restricted>] [--wait [--timeout <seconds>]]`: Add a library folder and scan it. (scope manage; job: add `--wait`)
- `media libraries update <library-id> [--name <text>] [--roots <text,...>] [--access <everyone|restricted>] [--trickplay | --no-trickplay]`: Rename a library or change its folders, access, or scrub thumbnails. (scope manage)
- `media libraries remove <library-id>`: Remove a library from [movies]; files on disk are untouched. (scope manage)
- `media libraries files <library-id> [--cursor <text>] [--limit <int>] [--filter <all|missing|unmatched>] [--title-id <id>]`: List a library's files with their titles, or only missing or unmatched ones. (scope manage)
- `media libraries file-summary <library-id>`: Count a library's missing files and unmatched titles. (scope manage)
- `media libraries scan <library-id> [--mode <full|quick>] [--wait [--timeout <seconds>]]`: Scan a library for new, changed, and missing files. (scope manage; job: add `--wait`)
- `media libraries folders [--path <text>]`: List the media host's folders inside its approved library roots. (scope manage)
- `media libraries generate-trickplay <library-id>`: Generate scrub thumbnails for every file in a library that has none. (scope manage)

### jobs

- `media jobs list [--kind <scan|metadata|person|backup|migration|trickplay>] [--status <pending|running|succeeded|failed|cancelled>] [--library-id <id>] [--limit <int>]`: List recent background jobs. (scope manage)
- `media jobs get <job-id>`: Show a background job's progress. (scope manage)
- `media jobs cancel <job-id>`: Cancel a pending or running job. (scope manage)

### metadata

- `media metadata search-candidates --title-id <id> --query <text> [--year <int>]`: Search the metadata provider for matches for a title. (scope manage)
- `media metadata fix-match --title-id <id> --provider <tmdb> --provider-id <id> [--wait [--timeout <seconds>]]`: Match a title to a metadata provider entry. (scope manage; job: add `--wait`)
- `media metadata refresh <title-id> [--wait [--timeout <seconds>]]`: Refresh a title's metadata from its current match. (scope manage; job: add `--wait`)
- `media metadata edit <title-id> --set <json> [--clear <name|sortName|year|overview|certification|ageRating,...>]`: Override or clear a title's name, year, overview, or rating. (scope manage)

### backups

- `media backups list`: List backups. (scope admin)
- `media backups run [--wait [--timeout <seconds>]]`: Back up the database now. (scope admin; job: add `--wait`)
- `media backups restore <backup-id>`: Restore the database from a backup; every session signs in again. (scope admin)

### migration

- `media migration connect --source <jellyfin|plex> --url <text> --credentials <json> [--path-mappings <json>]`: Connect to a Jellyfin or Plex server to migrate from. (scope admin)
- `media migration dry-run <connection-id> [--users <json>]`: Preview what a migration would import without writing anything. (scope admin)
- `media migration import <connection-id> [--users <json>] [--wait [--timeout <seconds>]]`: Import libraries, watch history, favorites, collections, and metadata overrides. (scope admin; job: add `--wait`)
- `media migration status`: Show migration jobs, their phase, and what they imported. (scope admin)

### diagnostics

- `media call diagnostics.playback --json <object>`: Build the timeline of a playback session from the retained logs: streams, slow and failed segments, stalls, player errors, and recoveries. (scope read)
- `media call diagnostics.sessions --json <object>`: List playback sessions the retained logs mention, newest first. (scope read)

<!-- END:commands -->
