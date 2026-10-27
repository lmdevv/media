# [music] verification map

This directory is the maintained source for verifying what a [music] user sees and does. Read
this index before you drive the app, then use the matching feature file as the recipe.

## Baseline preconditions

- A side is up through `$S up [--side S]`, and `$S doctor [--side S]` passes.
- The side holds the demo library: 5 albums by 4 artists, including `Vienna Blue` by
  `Doc & Lena Selyanina`, whose tracks include `Wanderer` and `Doppelgänger`. With the fixture
  library the names differ. Read them from `$S cli -- albums list --json`.
- The side holds the seeded [demo data](../SKILL.md#demo-data): Lucía, Mateo, Aiko, and Sam, the
  playlists `Sunday morning`, `Deep focus`, `Lossless`, and `Waltzes`, and their likes.
- Page `main` is signed in as `admin@music.local`, and the CLI uses the key that `up` created.
- For iOS steps, `$S ios up [--side S]` printed `ready` and `$S ios doctor` passes.
- Never drive a server or simulator that this run did not start.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Prefer ARIA roles and accessible names over CSS. On iOS, use labels from `$S ios describe`.
- Treat every command as literal. Keep quoted names and flags unchanged.
- Run browser actions through `$S browser`, the CLI through `$S cli --`, and the simulator
  through `$S ios`.
- A recipe that changes data (a playlist, a like) leaves it there. Remove it through the app or
  the CLI when the next recipe needs the baseline. Never remove proof artifacts.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof is a screenshot plus an ARIA snapshot (`snapshot --path`) or `ios describe`.
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
3. `Driving it with verify-music` starts with `Preconditions:` and uses labeled bullets that pair
   each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state,
commands, and observable proof.

## Features

- [First-run setup](./first-run-setup.md) covers creating the owner account, adding the library
  folder, and the first scan.
- [Playback](./playback.md) covers playing, pausing, and skipping with real audio on desktop,
  phone web, the CLI, and the iOS app.
- [Search](./search.md) covers the search page, the `/` shortcut, accent folding, and CLI search.
- [Playlists](./playlists.md) covers creating, adding to, renaming, and deleting playlists from
  the web and the CLI.
- [Devices](./devices.md) covers handing playback from one device to another and the Play on list.
