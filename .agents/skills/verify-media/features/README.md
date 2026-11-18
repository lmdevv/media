# Lar Movies verification map

This directory is the maintained source for verifying what a Lar Movies user sees and does, and
what anyone does in the account client at `/`, which movies and music share. Read this index
before you drive the app, then use the matching feature file as the recipe.

## Baseline preconditions

- A side is up through `$S up [--side S]`, and `$S doctor [--side S]` passes.
- The side holds the demo library: the `Movies` library at `/media/library/Movies` with six
  titles (`Big Buck Bunny`, `Elephants Dream`, `Sintel`, `Tears of Steel`,
  `Cosmos Laundromat: First Cycle`, and `[movies] Feature Test`), and the `Shows` library at
  `/media/library/Shows` with `Caminandes` (3 episodes) and `Pioneer One` (6 episodes). With
  the fixture library the names differ. Read them from `$S cli -- movies titles list`.
- The side holds the seeded [demo data](../SKILL.md#demo-data). Each person sees exactly this:

  | Who                   | Sees                                                    | Watching                                                                           |
  | --------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
  | Lucía (`lucia`, owner) | all 8 titles                                           | nothing yet                                                                        |
  | The kid (`kids`)      | `Big Buck Bunny`, `Caminandes`, `Cosmos Laundromat: First Cycle` | nothing                                                                  |
  | Mateo (`mateo`, admin) | all 8 titles                                           | My List: `Cosmos Laundromat: First Cycle`                                          |
  | Aiko (`aiko`, member, shared `Movies`) | all 8 titles                           | Continue watching: `Pioneer One · S1:E3` and `Elephants Dream` at 5:29; My List: `Sintel`, `Tears of Steel`, `Caminandes` |
  | Sam (`sam`, member)   | `Caminandes` and `Pioneer One` only                     | nothing                                                                            |

- Page `main` is signed in as `lucia` at `/` and opens `/movies` with that session. `$S cli`
  runs as Lucía, and `--as mateo|aiko|sam|kids` as the others, with the `movies …`,
  `auth …`, and `admin …` commands.
- For iOS steps, `$S ios up [--side S]` printed `ready` and `$S ios doctor` passes.
- Never drive a stack or simulator that this run did not start.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Prefer ARIA roles and accessible names over CSS. On iOS, use labels from `$S ios describe`.
- Treat every command as literal. Keep quoted names and flags unchanged.
- Run browser actions through `$S browser`, the CLI through `$S cli --`, and the simulator
  through `$S ios`.
- Watching changes the baseline: a title played past its start shows `Resume` and joins
  Continue watching for that person. Run a recipe that needs a clean slate first, or as another
  person. Never remove proof artifacts.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof is a screenshot plus an ARIA snapshot (`snapshot --path`) or `ios describe`.
- Playback proof is `wait-video`, which reads the real video element's `currentTime`, not the
  player's buttons, plus the stream's `mode` from `$S logs`.
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

- [First-run setup](./first-run-setup.md) covers the owner account, the first library and its
  scan, and adding a second library from Admin.
- [Browse and search](./browse.md) covers Home, the Movies and Shows pages, a title's page, genre,
  collection, and person pages, the command menu, the search page, and CLI search.
- [Playback](./playback.md) covers direct play, HLS with the audio or the whole video transcoded,
  resuming, the player's controls, and the iOS app.
- [People and access](./people-and-access.md) covers signing in once at `/` for `/movies`, the
  kid user, a library that a member wasn't shared, and a shared device's picker.
- [Account and admin](./account-and-admin.md) covers the account client: a person's name, devices,
  and API keys, approving a device from its code, and an admin's users, kid limits, groups,
  libraries, jobs, devices, guests, server, and backups.
- [My List and Continue watching](./my-list.md) covers adding to My List and the Continue
  watching row with its resume point and next episode.
- [Casting](./casting.md) covers Chromecast from the player and from `/music`'s Play on, a
  scripted Chromecast for both, signing out mid-cast, and AirPlay on iOS.
- [Group sessions](./group-sessions.md) covers starting, joining, and leaving a session, approval
  and locked sessions, the guests' control switch, the shared next-episode countdown, the host
  going away, Up next, and joining from the iOS app.

Music runs on every side too, at `/music` on the same image. Its map is
[music/README.md](./music/README.md), with the music library, browsing, playback, search,
playlists, Connect, and Jams.
