---
name: media
description: Control a [media] server (the user's self-hosted movies, shows, and music) from the terminal with the `media` CLI. Use when asked to find, play, or track movies and shows, manage libraries, scans, backups, accounts, users, invites, API keys, or device sign-ins, reset a password on the server host, or find out why playback stalled.
---

# [media] CLI

`media` runs every action the [media] apps have, for people and agents. Output is JSON on stdout
by default.

## Load only the reference you need

Read the one file that covers the task, and no other. Both are generated from the command list,
so they always match the CLI.

| Task                                                                                                                                                                                                                             | Read                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Movies and shows (`media movies`): home rows, titles, search, versions, people, collections, continue watching, history, your list, starting playback, imports, and metadata edits                                               | `references/movies.md` |
| Everything else (`media auth`, `media admin`): sign-in, sessions, API keys, device sign-ins, your account, libraries and scans, users, roles, invites, reset links, groups, restrictions, backups, downloads, and group sessions | `references/core.md`   |
| Music                                                                                                                                                                                                                            | No commands yet        |

## Install

Skip this when `media --version` already works.

- **On the server:** a Compose install has it in the image (`docker compose exec media media ...`).
  A NixOS install puts it on every user's `PATH`.
- **Node 22 or newer:** `npm install -g @lmdevv/media`, or once with `npx @lmdevv/media --help`.
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

## Sign in once

- **Sign in.** `media auth login --server <url>` prints a device code on stderr, as
  `{"event":"device_code","userCode","verificationUrl","expiresAt","approve"}` in JSON mode, then
  waits. Relay the code and URL to the user. Someone signed in elsewhere approves it at
  `verificationUrl`, or with the command in `approve`, adding `admin` to `--scopes` to let this device run `media admin`.
  `--username <name>` signs in with the password piped on stdin or in `MEDIA_PASSWORD`;
  `--api-key` takes the key from stdin or `MEDIA_CORE_API_KEY`. The URL is the install's address
  plus `/convex`, such as `http://nas.tailnet.ts.net:8080/convex`.
- **One config.** Every command uses the one session in
  `$XDG_CONFIG_HOME/media/sessions/<profile>.json` (mode 0600): the server's URL, the media
  server's when it is not that address without `/convex` (`--media-url`), and the session.
  `--profile <name>` or `MEDIA_PROFILE` picks another file; `default` otherwise. `media auth
  logout` signs out and keeps the server.
- **Agents and CI.** Set `MEDIA_CORE_URL` and `MEDIA_CORE_API_KEY` instead of signing in, so the
  key never touches the disk. `MEDIA_SERVER_URL` names the media server when it is elsewhere.
- **Where sign-ins go.** Every sign-in goes through the media server's sign-in route, which
  limits sign-ins per address: 10 at once, then one every 5 seconds. Set `MEDIA_CORE_SIGN_IN_URL`
  when it is not on the media server. A `rate_limited` answer says how long to wait.
- **Names to words.** Each reference lists its commands with their `media` lines. Admin
  commands are in `media admin`, the rest of the core's in `media auth`, and movies in
  `media movies`: `core.accounts.users.list` is `media admin users list`, and
  `movies.history.continueWatching` is `media movies history continue-watching`.
  `media call <name> --json '{...}'` runs any command by its name. IDs come from earlier results;
  never invent them.
- **Passwords never go on the command line.** An argument named like `password` comes from
  `MEDIA_ARG_<FIELD>` (`newPassword` is `MEDIA_ARG_NEW_PASSWORD`), or from stdin when it is the
  command's only one. A flag or `--json` that carries one is refused.
- **Lists come in pages.** `--limit <n>` (default 100) and `--cursor <continueCursor>` from the
  previous page, until `isDone`.
- **Reset a password on the server host.** `media admin reset-password [<username>]` sets a new
  password and ends that person's sessions, API keys, and links; with no username it resets the
  owner. It needs the core's admin key from the host: `--env-file <path>` with
  `CONVEX_SELF_HOSTED_URL` and `CONVEX_SELF_HOSTED_ADMIN_KEY`, or `MEDIA_CORE_URL` and
  `MEDIA_CORE_ADMIN_KEY`; in the image (`docker compose exec media media ...`) it finds the key
  itself. The new password comes from stdin or `MEDIA_ARG_PASSWORD`.

```sh
printf '%s' "$PASSWORD" | media auth login --server http://nas.tailnet.ts.net:8080/convex --username ana
media movies titles search alien
media movies my-list add --title-id <title-id>
media admin users list --human
printf '%s' "$NEW" | media admin reset-password ana
```

## Commands the references do not list

- **Play in mpv or VLC.** `media movies stream <title> [--episode-id <id>] [--version
  <name|number>] [--from <seconds|h:mm:ss>] [--max-height <lines>] [--open]` starts a title by
  its ID or the best name match (a show plays its next episode) and prints `.url`; `--open`
  launches mpv. `--version` takes a name or a number from `media movies titles versions`.
- **Why playback stalled.** `media diagnostics sessions [--since 2d]` lists recent playback
  sessions; `media diagnostics playback <session-id>` prints one's timeline. `media logs [--since
  15m] [--level warn] [--grep <text>] [--follow]` reads the media server's retained log (admins
  only). A failed answer from the media server carries `requestId`: `media logs --grep
  <request-id>` finds its records.

## Output and exit codes

Results print as JSON on stdout. Errors print on stderr as `{"error":{"code","message"}}`; log
records go to stderr too, one JSON object per line. `--human` (or `--format table`) prints
tables and sentences instead. `media <command> --help` shows any command's flags, and
`media commands` lists every command with its flags and argument JSON Schema.

| Code | Meaning                                                       | What to do                                    |
| ---- | ------------------------------------------------------------- | --------------------------------------------- |
| 0    | Success                                                       |                                               |
| 1    | Server or protocol failure, unreadable config, mpv missing    | Read `error.code` and `error.message`         |
| 2    | Usage: unknown command, missing flag, invalid argument        | Fix the command; see `media <command> --help` |
| 3    | Not signed in, session ended, credentials or sign-in refused  | `media auth login`                            |
| 4    | Forbidden: missing scope or role, PIN unlock, or not the host | Use a session with the scope, or ask an admin |
| 5    | Not found (hidden titles also report this)                    | Check the ID or name; list again              |
| 6    | Conflict or stale revision                                    | Read the state again and retry                |
| 7    | Expired code, invite, or key                                  | Start over with a new one                     |
| 8    | Rate limited, or the media service is busy                    | Wait and retry                                |
| 9    | Server unreachable                                            | Check the URL; a mutation may still have run  |

`not_logged_in` names the server and `media auth login`, also when the session ended elsewhere:
the CLI tries one refresh first.
