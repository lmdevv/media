---
name: music
description: Control a [music] server (the user's self-hosted music library) from the terminal with the `music` CLI. Use when asked to find, play, queue, like, or organize music, manage playlists, move playback between devices, add or rescan library folders, or manage API keys, invites, and people on a [music] server.
---

# [music] CLI

`music` runs every action the [music] app has. Each one is a command in a shared registry, so the
CLI, the web app, and this skill always agree.

## Setup

1. Get an API key: in the web app open Settings → API keys, or run `music keys create --name agent`
   from a machine that is already logged in. The key is shown once.
2. Log in with the Convex URL of the server. On the container install that is
   `https://<host>/convex`:

   ```sh
   music login --server https://music.example.com/convex --key mk_...
   music whoami
   ```

   `login` checks the key, then stores `{ server, key }` in `$XDG_CONFIG_HOME/music/config.json`
   (mode 0600). `MUSIC_SERVER` and `MUSIC_API_KEY` override the file, which suits CI and sandboxes.
   `music logout` deletes the stored key and the cached session.

## How it works

- `music <group> <command> [flags]` runs registry command `<group>.<command>`; `music search` runs
  `search`. Flags come from the command's argument schema: `trackIds` is `--track-ids`.
- When a command needs one value, it can go first without its flag:
  `music playlists get <playlist-id>`, `music search daft punk`, `music queue add <id> <id>`.
- Lists take repeated flags or commas: `--track-ids a,b` equals `--track-ids a --track-ids b`.
  Booleans are `--liked` or `--no-liked`. `--args '<json>'` passes the whole argument object.
- IDs are opaque strings from earlier results. Never invent them; read them from `--json` output.
- Add `--json` to parse results. It prints the decoded result on stdout. Errors go to stderr as
  `{"error":{"code","message"}}`. Without `--json`, lists print as tables with an `ID` column.
- Commands marked as jobs (library scans) return a `jobId` at once. Add `--wait` to poll until the
  job ends; progress goes to stderr. With `--json` the output is `{ "result", "job" }`. `--timeout
  <seconds>` (default 3600) bounds the wait.
- `music commands --json` lists every command with its flags and its arguments as JSON Schema.
  `music <command> --help` shows one command.
- Admin-only commands fail with exit code 3 and `forbidden` for other users.

## Recipes

Find and play an album:

```sh
music play abbey road            # best match: album, artist's top songs, or songs
music search "abbey road" --json # or choose yourself: .albums[].id
music albums get <album-id> --json
music playback play --track-ids <id>,<id>,<id>
music now
```

Make a playlist from search results:

```sh
ids=$(music search "miles davis" --limit 10 --json | jq -r '[.tracks[].id] | join(",")')
music playlists create "Late night" --track-ids "$ids" --json   # → {"playlistId": ...}
music playlists add --playlist-id <playlist-id> --track-ids <id>
```

Like the current song:

```sh
id=$(music now --json | jq -r '.queue[.index].id')
music likes set "$id" --liked
```

Move playback to another device:

```sh
music devices list               # find the device ID; online devices can play
music playback transfer <device-id>
```

Add a library folder and wait for the scan (admin):

```sh
music libraries create --name Music --path /srv/music --wait
music libraries scan <library-id> --wait --timeout 600
```

Invite someone (admin):

```sh
music invites create --email friend@example.com --json   # share .code with them
```

Playback controls: `music pause`, `music resume`, `music next`, `music previous`,
`music playback seek <ms>`, `music playback volume 0.5`, `music playback shuffle --on`,
`music playback repeat all`, `music queue add <id> --next`.

## Exit codes

| Code | Meaning                                                   | What to do                                |
| ---- | --------------------------------------------------------- | ----------------------------------------- |
| 0    | Success                                                   |                                           |
| 1    | The command failed (`not_found`, `conflict`, job failure) | Read `error.code` and `error.message`     |
| 2    | Usage error: unknown command, missing flag, invalid value | Fix the command; see `music <cmd> --help` |
| 3    | Auth error: not logged in, bad key, or admin-only command | `music login`, a new key, or an admin key |

## Troubleshooting

- `not_logged_in`: run `music login`, or set both `MUSIC_SERVER` and `MUSIC_API_KEY`.
- `invalid_key`: the key was revoked or mistyped. Create a new one.
- `server_error` with "Could not reach": check the URL. It is the Convex URL (`.../convex`), not
  the web app URL.
- `timeout` from `--wait`: the job is still running. Check it with `music jobs get <job-id>`. A job
  stuck in `pending` means the media service is not running.
- Playback commands change the shared session. A device must be online to play; `music now` shows
  the active device.

## Command reference

<!-- BEGIN:commands -->
<!-- Generated from the command registry by `pnpm --filter @music/cli skill:reference`. Do not edit by hand. -->

### library

- `music library home`: Recently added and recently played albums, with library totals.
- `music albums list [--cursor <text>] [--limit <int>]`: List albums, newest first.
- `music albums get <album-id>`: Show an album and its tracks.
- `music artists list [--cursor <text>] [--limit <int>]`: List artists by name.
- `music artists get <artist-id>`: Show an artist, their albums, and top songs.
- `music tracks list [--cursor <text>] [--limit <int>]`: List songs by title.

### search

- `music search <query> [--limit <int>]`: Search songs, albums, and artists.

### playback

- `music playback state`: Show what is playing, where, and the queue.
- `music playback play <track-ids...> [--index <int>] [--device-id <id>]`: Replace the queue and start playing.
- `music playback pause`: Pause playback.
- `music playback resume`: Resume playback.
- `music playback next`: Skip to the next song.
- `music playback previous`: Go back to the previous song.
- `music playback seek <position-ms>`: Seek within the current song.
- `music playback jump <index>`: Play the queue entry at an index.
- `music playback shuffle (--on | --no-on)`: Turn shuffle on or off.
- `music playback repeat <off|all|one>`: Set repeat to off, all, or one.
- `music playback volume <volume>`: Set the volume from 0 to 1.
- `music playback report --device-id <id> --index <int> --position-ms <number> (--playing | --no-playing)`: Report the active device's position (sent by players).
- `music stream url --track-id <id> --profile <original|aac-320|aac-128>`: Get a signed stream URL for a song.

### devices

- `music playback transfer <device-id>`: Move playback to another device.
- `music devices list`: List your devices.
- `music devices heartbeat --device-id <id> --name <text> --kind <web|phone|cli>`: Mark a device as online (sent by players).

### queue

- `music queue add <track-ids...> [--next | --no-next]`: Add songs to the queue, next or at the end.
- `music queue remove <index>`: Remove the queue entry at an index.
- `music queue clear`: Clear everything after the current song.

### likes

- `music likes list`: List liked songs, newest first.
- `music likes set <track-id> (--liked | --no-liked)`: Like or unlike a song.
- `music history list [--limit <int>]`: List recently played songs.

### playlists

- `music playlists list`: List your playlists.
- `music playlists get <playlist-id>`: Show a playlist and its songs.
- `music playlists create <name> [--description <text>] [--track-ids <id,...>]`: Create a playlist.
- `music playlists rename --playlist-id <id> --name <text>`: Rename a playlist.
- `music playlists delete <playlist-id>`: Delete a playlist.
- `music playlists add --playlist-id <id> --track-ids <id,...>`: Add songs to a playlist.
- `music playlists remove --playlist-id <id> --item-id <id>`: Remove an entry from a playlist.

### libraries

- `music libraries list`: List library folders you can see.
- `music libraries create --name <text> --path <text> [--visibility <shared|private>] [--wait [--timeout <seconds>]]`: Add a library folder and scan it. (admin; job: add `--wait`)
- `music libraries scan <library-id> [--wait [--timeout <seconds>]]`: Rescan a library folder. (admin; job: add `--wait`)
- `music libraries delete <library-id>`: Remove a library folder from the index (files stay on disk). (admin)

### jobs

- `music jobs list`: List recent jobs.
- `music jobs get <job-id>`: Show one job.
- `music jobs cancel <job-id>`: Cancel a pending or running job. (admin)

### account

- `music account me`: Show the signed-in user.
- `music account rename <name>`: Change your display name.

### keys

- `music keys list`: List your API keys.
- `music keys create <name>`: Create an API key for the CLI or an agent; the key is shown once.
- `music keys revoke <api-key-id>`: Revoke an API key.

### people

- `music people list`: List people on this server. (admin)
- `music invites list`: List open invites. (admin)
- `music invites create [--email <text>] [--role <admin|member>]`: Invite someone; share the code or link. (admin)
- `music invites revoke <invite-id>`: Revoke an invite. (admin)

<!-- END:commands -->
