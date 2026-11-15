# [music] verification map

This directory is the maintained source for verifying what a [music] user sees and does on a
verify-media side: the music client at `/music`, the `media` CLI's `music` group, and the music
iOS app. Read this index before you drive the app, then use the matching feature file as the
recipe. Every browser command takes `--app music` on the page's first command, and every CLI
command starts with `music`.

## Baseline preconditions

- A side is up through `$S up [--side S]`, and `$S doctor [--side S]` passes, with the line
  `ok    /music is the music client`.
- The side holds the demo library's `Music` library: 5 albums by 4 artists, including
  `Vienna Blue` by `Doc & Lena Selyanina`, whose songs include `Wanderer` and `Doppelgänger`.
  Read them from `$S cli -- music albums list`.
- The side holds the seeded [demo data](../../SKILL.md#demo-data): Lucía, Mateo, Aiko, and Sam,
  the playlists `Sunday morning`, `Deep focus`, `Lossless`, and `Waltzes`, and their likes.
- Page `music` is signed in as `lucia`, with the session the account client at `/` keeps. `$S cli`
  runs as Lucía, and `--as mateo|aiko|sam|kids` as the others.
- For iOS steps, `$S ios up --app music [--side S]` printed `ready`, or T3's device tools run the
  app (see [Playback](./playback.md)).
- Never drive a server that this run did not start.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Prefer ARIA roles and accessible names over CSS.
- Treat every command as literal. Keep quoted names and flags unchanged.
- Run browser actions through `$S browser --app music` and the CLI through `$S cli -- music`.
- A recipe that changes data (a playlist, a like) leaves it there. Remove it through the app or
  the CLI when the next recipe needs the baseline. Never remove proof artifacts.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof is a screenshot plus an ARIA snapshot (`snapshot --path`).
- Playback proof is `wait-audio`, which reads real media elements, not the play button's state.
- CLI proof is the command, its stdout and stderr, and its exit code.
- Mutation proof is a second, read-only view of the stored value, such as a CLI read.
- Record the feature ID and entry point with every artifact.
- Report an unreachable path with the command you tried and the precondition it lacked. Do not
  report a skipped entry point as verified through a different one.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior.
It then uses exactly four H2 sections in this order:

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with verify-media` starts with `Preconditions:` and uses labeled bullets that pair
   each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state,
commands, and observable proof.

## Features

- [Music library](./library.md) covers adding the `Music` library from the account client's
  Admin, Libraries, its scan, and opening `/music` with the same sign-in.
- [Playback](./playback.md) covers playing, pausing, and skipping with real audio on desktop and
  phone web, the queue and history from the CLI, and the music iOS app.
- [Search](./search.md) covers the search page, the `/` shortcut, accent folding, and CLI search.
- [Playlists](./playlists.md) covers creating, adding to, renaming, and deleting playlists from
  the web and the CLI.

Moving playback from one device to another is not in the music port; it returns in phase 6 (D62),
so this map has no recipe for it.
