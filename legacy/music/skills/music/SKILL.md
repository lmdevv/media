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
   printf '%s' "$KEY" | music login --server https://music.example.com/convex --key-stdin
   music whoami
   ```

   Keep the key off the command line, where it lands in shell history and the process list: pipe
   it to `--key-stdin`, set `MUSIC_API_KEY`, or run `music login --server <url>` at a terminal and
   type it at the hidden prompt. (`--key <api-key>` still works, but avoid it.) `login` checks the
   key, then stores `{ server, key }` in `$XDG_CONFIG_HOME/music/config.json` (mode 0600, in a
   0700 directory). `MUSIC_SERVER` and `MUSIC_API_KEY` override the file, which suits CI and
   sandboxes. `music logout` deletes the stored key and the cached session.

   A plain `http://` server on another machine would carry the key unencrypted, so `login`
   refuses it unless you pass `--insecure` (and remembers that you did), and `MUSIC_SERVER` is
   refused unless `MUSIC_INSECURE=1` is set. `http://localhost` and `http://127.0.0.1` are fine.

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
- Roles: the `owner` (the first account, exactly one) can do everything; `admin` runs people,
  invites, libraries, and jobs, but only the owner changes another admin; `member` listens and
  keeps playlists, likes, history, and API keys; `guest` only listens to the libraries they were
  added to, has no API keys, and can't share with other people (but sees what is shared with
  them). `access` in `music commands --json` names what each command needs: `user` (anyone),
  `keys` or `share` (not guests), `admin`, or `owner`. Other callers get exit code 3 and
  `forbidden`.
- Library visibility: `shared` is everyone but guests, `restricted` is only the people added with
  `music libraries grant`, and `private` is only the library's owner. Guests hear a shared library
  once they are added to it. Only a library's own owner changes its visibility or who is added
  (`forbidden` otherwise). Admins rename and rescan libraries they can listen to, and the
  server's owner every library; only a library's own owner or the server's owner removes it; `music libraries list` shows other libraries with `path: null` and
  `manageable: false`, and commands on them answer `not_found`.
- Queue entries have their own IDs (`itemId` in `music queue list --json`), separate from song
  IDs. `queue remove`, `queue move`, and `playback jump` take an entry ID, so they act on the row
  you read even if someone changed the queue since; an entry that is gone fails with `not_found`
  (read the queue again). The same song can be queued twice as two entries.
- Autoplay (on by default, `music queue autoplay --no-on` turns it off) adds up to 10 songs when
  the last queued song starts: the same artist, then the same genre, then albums within two years,
  from libraries you can read, skipping songs played recently. Those entries have
  `autoplay: true`; `queue add` without `--next` puts songs before them.
- Playlists are `private` (default) or `shared` (anyone signed in with the link can view and play
  them), and can be shared with people as `viewer` or `collaborator`. Collaborators add, remove,
  and reorder songs; only the owner renames, shares, or deletes. Sharing never grants library
  access: songs someone can't read show as unavailable (`reason: "no_access"`).
- A Jam is a live listening session shared from its host's playback. While someone is in a Jam,
  their `playback` and `queue` commands act on the host's session: `queue list` shows the host's
  queue (every entry has `addedBy`), and their own playback waits, untouched, until they leave.
  What they may do is the host's settings (`music jam get --json` → `.settings`): add songs (up
  to `addLimit` upcoming each, they can read), control playback (off by default), move or remove
  none, their own (default), or any entries. Replacing the queue (`playback play`), clearing it,
  and autoplay stay the host's; other attempts fail with `forbidden`. A person is in one Jam at a
  time; joining another leaves the first.

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

Reorder the queue: entry IDs, not positions. The top of "Next up" is right after the song playing:

```sh
music queue list --json                         # .queue[].itemId, .index is the song playing
music queue move <item-id> --after-item-id <id> # or no --after-item-id for the very top
music queue remove <item-id>
music playback jump <item-id>
```

Share a playlist and work on it together:

```sh
music people directory --json                   # names and roles of people you can share with
music playlists share --playlist-id <id> --user-id <user-id> --role collaborator
music playlists visibility --playlist-id <id> --visibility shared   # anyone with the link
music playlists sharing <playlist-id> --json     # who it is shared with
music playlists shared --json                    # playlists others shared with you
music playlists move --playlist-id <id> --item-id <entry> --after-item-id <entry>
music playlists unshare --playlist-id <id> --user-id <user-id>  # one person, or yourself to leave
music playlists unshare --playlist-id <id>       # owner: stop sharing with everyone
```

Run a Jam (the link is `<web address>/jam/<code>`):

```sh
music jam start --json                          # {"jamId", "code"}: from what you are playing
music jam settings --join approval --add-limit 3 --members-can-control
music jam members                               # people in it, and who waits to be let in
music jam approve --user-id <id> --approve      # or --no-approve to turn them away
music jam remove --user-id <id>                 # that link won't let them back in
music jam relink --json                         # a new link; the old one stops working
music jam end                                   # everyone gets their own player back
```

Join someone's Jam, and listen along or use it as a remote:

```sh
music jam join https://music.example.com/jam/<code>   # or just the code
music queue add <track-id>                       # adds to the host's queue, credited to you
music jam listen --on --device-id <device-id>    # play it in step on one of your devices
music jam listen --no-on                         # stop; keep using it as a remote
music jam leave                                  # also dismisses a Jam that ended
```

Jams end when the host ends them, after the host has been offline for 30 minutes, or after four
hours without playback. An admin can let Jam links make guest accounts (`music server update
--jam-guest-accounts`); such guests hear only the Jams they join, and `music people list --json`
marks them `joinedViaJam`. Once the host removes or turns someone away, an open Jam asks the host
about everyone new until `music jam relink`. A guest account goes when the host removes or turns it
away and when its Jam ends, unless an admin promotes it first (`music people role --user-id <id>
--role member`). One Jam's link makes at most 25 guests, and 10 an hour (30 an hour across the
server). No guest can start a Jam, and Jam guests don't see playlists shared with everyone, only
ones shared with them by name. Songs heard only through a Jam get stream URLs that last five
minutes, and while a Jam runs, autoplay picks only from libraries the host owns or that are shared
with everyone. A Jam link's page shows only the host's name and whether the host lets people in.

Get a link to send: the path goes after the web address (the server URL without `/convex`). A
song opens its album with the song highlighted; someone who can't open it sees a no-access page:

```sh
music links get --kind album --id <album-id> --json   # {"path": "/albums/...", "title": ...}
```

Like the current song:

```sh
id=$(music now --json | jq -r '.queue[.index].id')
music likes set "$id" --liked
```

Move playback to another device. The list leaves out devices silent for over a day, except the
one playing:

```sh
music devices list               # find the device ID; online devices can play
music playback transfer <device-id>
```

Add a library folder and wait for the scan (admin):

```sh
music libraries create --name Music --path /srv/music --wait
music libraries scan <library-id> --wait --timeout 600
```

Invite someone (admin). The link is `<web address>/invite/<code>`; the web address is the server
URL without `/convex`:

```sh
music invites create --email friend@example.com --json             # share .code with them
music invites create --role guest --json                           # a friend who only listens
```

Run the people on the server (admin). The owner cannot be changed, only the owner changes another
admin, and nobody changes their own account this way:

```sh
music people list --json                       # .id, .role, .suspended, .lastActiveAt
music people role --user-id <id> --role guest  # admin, member, or guest
music people suspend <user-id>                 # signs them out everywhere; keys stop working
music people unsuspend <user-id>
music people reset <user-id> --json            # share <web address>/reset/<.token>; one use, 24 h
music people remove <user-id>                  # deletes their data; their libraries go to the owner
music people transfer <user-id>                # owner only: hand the server to an admin
```

Share a library you own with specific people (admin; only the library's owner may):

```sh
music libraries update <library-id> --visibility restricted --name "Kids"
music libraries grant --library-id <library-id> --user-id <user-id>
music libraries people <library-id> --json
```

Playback controls: `music pause`, `music resume`, `music next`, `music previous`,
`music playback seek <ms>`, `music playback volume 0.5`, `music playback shuffle --on`,
`music playback repeat all`, `music queue add <id> --next` (plays after the current song).

## Exit codes

| Code | Meaning                                                     | What to do                                |
| ---- | ----------------------------------------------------------- | ----------------------------------------- |
| 0    | Success                                                     |                                           |
| 1    | The command failed (`not_found`, `conflict`, job failure)   | Read `error.code` and `error.message`     |
| 2    | Usage error: unknown command, missing flag, invalid value   | Fix the command; see `music <cmd> --help` |
| 3    | Auth error: not logged in, bad key, suspended, or no access | `music login`, a new key, or an admin key |

## Troubleshooting

- `not_logged_in`: run `music login`, or set both `MUSIC_SERVER` and `MUSIC_API_KEY`.
- `invalid_key`: the key was revoked or mistyped. Create a new one. A person made a guest loses
  their keys.
- `forbidden` with "suspended": an admin suspended the account; only an admin can lift it.
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

- `music library home`: Recently added and recently played albums, recently played artists, and library totals.
- `music albums list [--cursor <text>] [--end <text>] [--limit <int>]`: List albums, newest first.
- `music albums get <album-id>`: Show an album and its tracks.
- `music artists list [--cursor <text>] [--end <text>] [--limit <int>]`: List artists by name.
- `music artists get <artist-id>`: Show an artist, their albums, and top songs.
- `music tracks list [--cursor <text>] [--end <text>] [--limit <int>]`: List songs by title.
- `music links get --kind <album|artist|playlist|track> --id <text>`: Get a link to an album, artist, playlist, or song you can open (a song opens its album).

### search

- `music search <query> [--limit <int>]`: Search songs, albums, and artists.

### playback

- `music playback state`: Show what is playing, where, and the queue.
- `music playback position`: Show the playing device, position, and volume, without the queue.
- `music playback play <track-ids...> [--index <int>] [--device-id <id>]`: Replace the queue and start playing.
- `music playback pause`: Pause playback.
- `music playback resume`: Resume playback.
- `music playback next`: Skip to the next song.
- `music playback previous`: Go back to the previous song.
- `music playback seek <position-ms>`: Seek within the current song.
- `music playback jump <item-id>`: Play a queue entry by its item ID (queue list shows them).
- `music playback shuffle (--on | --no-on)`: Turn shuffle on or off.
- `music playback repeat <off|all|one>`: Set repeat to off, all, or one.
- `music playback volume <volume>`: Set the volume from 0 to 1.
- `music playback report --device-id <id> --index <int> [--track-id <id>] [--item-id <id>] --position-ms <number> (--playing | --no-playing)`: Report the active device's position (sent by players).
- `music stream url --track-id <id> --profile <original|aac-320|aac-128|fmp4-flac|fmp4-aac> [--requested-at <number>]`: Get a signed stream URL for a song.

### devices

- `music playback transfer <device-id>`: Move playback to another device.
- `music devices list [--device-id <id>]`: List devices seen in the last day and the one playing.
- `music devices heartbeat --device-id <id> --name <text> --kind <web|phone|cli>`: Mark a device as online (sent by players).

### queue

- `music queue list`: Show the queue, the current song's index, shuffle, and repeat.
- `music queue add <track-ids...> [--next | --no-next]`: Add songs to the queue: --next plays them after the current song, otherwise they go after your other queued songs (before autoplay).
- `music queue remove <item-id>`: Remove a queue entry by its item ID.
- `music queue move <item-id> [--after-item-id <id>]`: Move a queue entry to just after another (--after-item-id), or to the top when none is given.
- `music queue clear`: Clear everything after the current song.
- `music queue autoplay (--on | --no-on)`: Turn autoplay on or off: when the queue runs out, play the same artist, then genre, then era.

### downloads

- `music downloads list [--device-id <id>]`: List the albums, playlists, and songs each of your devices keeps downloaded.
- `music downloads add --device-id <id> --kind <track|album|playlist> --id <text>`: Download an album, playlist, or song to one of your devices and keep it in sync (up to 500 per device).
- `music downloads remove --device-id <id> --kind <track|album|playlist> --id <text>`: Stop keeping an album, playlist, or song on a device; the device deletes its files.
- `music downloads manifest <pin-id>`: List the songs and file revisions a download holds now (read by devices).

### likes

- `music likes list`: List up to 1,000 liked songs, newest first (likes.page reads them all).
- `music likes page [--cursor <text>] [--end <text>] [--limit <int>]`: List liked songs, newest first, a page at a time.
- `music likes set <track-id> (--liked | --no-liked)`: Like or unlike a song.
- `music history list [--limit <int>]`: List recently played songs.

### playlists

- `music playlists list`: List your playlists.
- `music playlists shared`: List playlists other people shared with you by name.
- `music playlists get <playlist-id>`: Show a playlist and its songs: yours, one shared with you, or one shared by link.
- `music playlists create <name> [--description <text>] [--track-ids <id,...>]`: Create a playlist.
- `music playlists rename --playlist-id <id> --name <text>`: Rename a playlist you own.
- `music playlists update <playlist-id> [--name <text>] [--description <text>]`: Change a playlist's name or description (an empty description clears it).
- `music playlists delete <playlist-id>`: Delete a playlist you own.
- `music playlists add --playlist-id <id> --track-ids <id,...>`: Add songs to a playlist you own or collaborate on.
- `music playlists remove --playlist-id <id> --item-id <id>`: Remove an entry from a playlist you own or collaborate on.
- `music playlists move --playlist-id <id> --item-id <id> [--after-item-id <id>]`: Move a playlist entry to just after another (--after-item-id), or to the top when none is given.
- `music playlists sharing <playlist-id>`: Show who a playlist you own is shared with.
- `music playlists visibility --playlist-id <id> --visibility <private|shared>`: Make a playlist you own private, or shared: anyone on this server with the link can view and play it. (not guests)
- `music playlists share --playlist-id <id> --user-id <id> [--role <viewer|collaborator>]`: Share a playlist you own with someone as a viewer (default) or a collaborator, who adds, removes, and reorders songs. (not guests)
- `music playlists unshare <playlist-id> [--user-id <id>]`: Stop sharing a playlist with someone, or leave one shared with you; naming no one stops sharing it at all.

### libraries

- `music libraries list`: List library folders you can see.
- `music libraries create --name <text> --path <text> [--visibility <shared|restricted|private>] [--wait [--timeout <seconds>]]`: Add a library folder and scan it. (admin; job: add `--wait`)
- `music libraries scan <library-id> [--wait [--timeout <seconds>]]`: Rescan a library folder. (admin; job: add `--wait`)
- `music libraries delete <library-id>`: Remove a library folder from the index (its owner or the server owner; files stay on disk). (admin)
- `music libraries update <library-id> [--name <text>] [--visibility <shared|restricted|private>]`: Rename a library folder, or (its owner only) change who can listen to it. (admin)
- `music libraries people <library-id>`: List the people added to a library folder. (admin)
- `music libraries grant --library-id <id> --user-id <id>`: Let someone listen to a restricted library folder you own, or a guest to a shared one. (admin)
- `music libraries revoke --library-id <id> --user-id <id>`: Take someone off the access list of a library folder you own. (admin)

### jobs

- `music jobs list`: List recent jobs.
- `music jobs get <job-id>`: Show one job.
- `music jobs cancel <job-id>`: Cancel a pending or running job. (admin)

### account

- `music account me`: Show the signed-in user.
- `music account rename <name>`: Change your display name.

### keys

- `music keys list`: List your API keys. (not guests)
- `music keys create <name>`: Create an API key for the CLI or an agent; the key is shown once. (not guests)
- `music keys revoke <api-key-id>`: Revoke an API key. (not guests)

### people

- `music people list`: List people on this server. (admin)
- `music people directory`: List the people on this server you can share with: names and roles, no emails. (not guests)
- `music people role --user-id <id> --role <admin|member|guest>`: Change someone's role to admin, member, or guest. (admin)
- `music people suspend <user-id>`: Suspend someone: sign them out everywhere and stop their API keys. (admin)
- `music people unsuspend <user-id>`: Let a suspended person sign in again. (admin)
- `music people reset <user-id>`: Create a one-time password reset link for someone; it lasts 24 hours. (admin)
- `music people remove <user-id>`: Remove someone with their playlists, likes, history, devices, and keys; their libraries move to the owner. (admin)
- `music people transfer <user-id>`: Make an admin the owner of this server; you become an admin. (owner)
- `music invites list`: List open and expired invites. (admin)
- `music invites create [--email <text>] [--role <admin|member|guest>]`: Invite someone as an admin, member, or guest; share the code or link. (admin)
- `music invites revoke <invite-id>`: Revoke an invite. (admin)

### server

- `music server settings`: Show server settings, such as whether Jam links can create guest accounts. (admin)
- `music server update [--jam-guest-accounts | --no-jam-guest-accounts]`: Change server settings: --jam-guest-accounts lets people without an account join a Jam from its link as guests. (admin)

### jams

- `music jam start`: Start a Jam from your playback: people who open its link share your queue and player.
- `music jam get`: Show the Jam you host, are in, or are waiting to join: host, settings, people, and its link code.
- `music jam members`: List the people in your Jam (the host also sees who is waiting to be let in).
- `music jam join <code> [--device-id <id>]`: Join a Jam by its code or link; leaves any other Jam you are in. --device-id plays it on that device.
- `music jam leave`: Leave the Jam you are in, or dismiss one that ended; your own playback comes back.
- `music jam listen (--on | --no-on) [--device-id <id>]`: Listen along to your Jam on a device (--on --device-id <id>), or stop and use it as a remote (--no-on).
- `music jam end`: End the Jam you host; everyone gets their own player back.
- `music jam settings [--join <open|approval|locked>] [--members-can-add | --no-members-can-add] [--add-limit <int>] [--members-can-control | --no-members-can-control] [--members-can-edit <none|own|any>] [--listen-along | --no-listen-along]`: Change what people in your Jam may do (host only); flags left out stay as they are.
- `music jam approve <user-id> (--approve | --no-approve)`: Let someone waiting into your Jam (--approve), or turn them away (--no-approve).
- `music jam remove <user-id>`: Remove someone from your Jam; the same link won't let them back in.
- `music jam relink`: Give your Jam a new link; the old one stops working.

<!-- END:commands -->
