---
name: media
description: Control a [media] server (the user's self-hosted movies, shows, and music) from the terminal with the `media` CLI. Use when asked to find, play, or track movies and shows, run watch rooms, manage libraries, scans, imports, backups, accounts, users, invites, API keys, or device sign-ins, reset a password on the server host, or find out why playback stalled.
---

# [media] CLI

`media` runs every action the [media] apps have, for people and agents. Output is JSON on stdout
by default.

## Load only the reference you need

Read the one file that covers the task, and no other.

| Task                                                                                                                                                                                                      | Read                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Movies and shows on the core (`media movies`): home rows, titles, search, people, collections, continue watching, history, your list, starting playback, and metadata edits                               | `references/movies.md` |
| The old movies server (top-level words such as `media search` and `media play`): watch rooms, libraries, scans, imports, backups, playback diagnostics, and its own sign-in, profiles, and keys           | `movies.md`            |
| The core: sign-in, sessions, API keys, device sign-ins, your username and password, users, roles, invites, reset links, groups, restrictions, downloads kept on a device, group sessions, and guest links | `references/core.md`   |
| Music                                                                                                                                                                                                     | No commands yet        |

[media] is moving onto one core server. Until the movies port lands there are two servers. The
core's movies commands sit in the `movies` group and sign in with `media auth login`, like the
`auth` and `admin` groups. The old movies server's commands run at the top level (`media search`,
`media play`) and sign in with `media login`. `media --help` lists both.

## Install

Skip this when `media --version` already works.

- **On the server:** a Compose install has it in the image (`docker compose exec media media ...`).
  A NixOS install puts it on every user's `PATH`.
- **Node 22 or newer:** `npm install -g @lmdevv/movies`, or once with `npx @lmdevv/movies --help`.
- **No Node:** download the release binary, check it, and install it (`media-linux-arm64` or
  `media-darwin-arm64` likewise; `shasum -a 256 -c` on macOS):

  ```sh
  curl -fLO https://github.com/lmdevv/media/releases/latest/download/media-linux-x64
  curl -fLO https://github.com/lmdevv/media/releases/latest/download/SHA256SUMS
  grep media-linux-x64 SHA256SUMS | sha256sum -c
  mkdir -p ~/.local/bin && install -m 755 media-linux-x64 ~/.local/bin/media
  ```

- **Nix:** `nix run github:lmdevv/media -- <command>`.

No install holds a credential; sign in as each reference says.

## The core

- **Sign in.** `media auth login --server <core-url>` prints a device code on stderr, as
  `{"event":"device_code","userCode","expiresAt","approve"}` in JSON mode, then waits. Relay the
  code to the user. Someone signed in elsewhere approves it with the command in `approve`, adding
  `admin` to `--scopes` to let this device run `media admin`. `--username <name>` signs in with
  the password piped on stdin or in `MEDIA_PASSWORD`; `--api-key` takes the key from stdin or
  `MEDIA_CORE_API_KEY`. The session lives in `$XDG_CONFIG_HOME/media/sessions/<profile>.json`
  (mode 0600). `media auth logout` signs out.
- **Agents and CI.** Set `MEDIA_CORE_URL` and `MEDIA_CORE_API_KEY` instead of signing in, so the
  key never touches the disk.
- **Names to words.** Each reference lists its commands with their `media` lines. Admin
  commands are in `media admin`, the rest of the core's in `media auth`, and movies in
  `media movies`: `core.accounts.users.list` is `media admin users list`, and
  `movies.history.continueWatching` is `media movies history continue-watching`.
  `media call <name> --json '{...}'` runs any command by its name.
- **Passwords never go on the command line.** An argument named like `password` comes from
  `MEDIA_ARG_<FIELD>` (`newPassword` is `MEDIA_ARG_NEW_PASSWORD`), or from stdin when it is the
  command's only one. A flag or `--json` that carries one is refused.
- **Lists come in pages.** `--limit <n>` (default 100) and `--cursor <continueCursor>` from the
  previous page, until `isDone`.
- **Reset a password on the server host.** `media admin reset-password [<username>]` sets a new
  password and ends that person's sessions, API keys, and links; with no username it resets the
  owner. It needs the core's admin key from the host: `--env-file <path>` with
  `CONVEX_SELF_HOSTED_URL` and `CONVEX_SELF_HOSTED_ADMIN_KEY`, or `MEDIA_CORE_URL` and
  `MEDIA_CORE_ADMIN_KEY`. The new password comes from stdin or `MEDIA_ARG_PASSWORD`.

```sh
printf '%s' "$PASSWORD" | media auth login --server http://nas.tailnet.ts.net:8080/convex --username ana
media admin users list --human
printf '%s' "$NEW" | media admin users create bob --role member
media auth api-keys create --name ci --scopes account
printf '%s' "$NEW" | media admin reset-password ana --env-file /path/to/core.env
```

## Output and exit codes

Results print as JSON on stdout. Errors print on stderr as `{"error":{"code","message"}}`; log
records go to stderr too, one JSON object per line. `--human` (or `--format table`) prints
tables and sentences instead. `media <command> --help` shows any command's flags, and
`media commands` lists every command with its flags and argument JSON Schema.

| Code | Meaning                                                          | What to do                                                |
| ---- | ---------------------------------------------------------------- | --------------------------------------------------------- |
| 0    | Success                                                          |                                                           |
| 1    | Server or protocol failure, unreadable config, mpv missing       | Read `error.code` and `error.message`                     |
| 2    | Usage: unknown command, missing flag, invalid argument           | Fix the command; see `media <command> --help`             |
| 3    | Not signed in, session ended, credentials or sign-in refused     | `media auth login` for the core, `media login` for movies |
| 4    | Forbidden: missing scope or role, PIN unlock, or not the host    | Use a session with the scope, or ask an admin             |
| 5    | Not found (hidden titles also report this)                       | Check the ID or name; list again                          |
| 6    | Conflict or stale revision                                       | Read the state again and retry                            |
| 7    | Expired code, invite, or key                                     | Start over with a new one                                 |
| 8    | Rate limited, or the media service is busy                       | Wait and retry                                            |
| 9    | Server unreachable                                               | Check the URL; a mutation may still have run              |
| 10   | A job followed with `--wait` failed, was cancelled, or timed out | `media jobs get <job-id>`                                 |
| 11   | `media import` could not use the Jellyfin or Plex server         | Read `error.code`, such as `source_auth_failed`           |

`not_logged_in` from a core command names the server and `media auth login`, also when the core
ended the session elsewhere.
