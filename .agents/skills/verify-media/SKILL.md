---
name: verify-media
description: Run disposable [media] stacks built from this checkout and from main, with [media]'s all-in-one image (the real Compose install: the account client, the core's Convex backend with movies in it, the media service, the scanner, ffmpeg, and real video, on one port) and old [music] from legacy/music side by side on one demo library, then drive both web apps in one Chromium, the `media` and `music` CLIs as each seeded person, and the movies iOS app on a Mac simulator to prove a change works the way a user sees it. Captures before/after screenshots and H.264 videos and publishes them to the PR description. Use to verify a web, CLI, backend, media, music, or iOS change end to end, to reproduce a user-facing bug, or to put visual evidence on a PR.
---

# Verify [media]

This skill runs the real products on one demo library, mounted read-only:

- **[media].** `deploy/compose/compose.yaml`, which runs the all-in-one image as one `media`
  container on one port: the account client at `/` with the core's Convex at `/convex`, the
  movies client at `/movies`, which uses the sign-in the account client keeps, and the media
  service, with the library at `/media/library` (ADR 0026). Movies' data lives in the core.
- **Old music.** The all-in-one image from `legacy/music/deploy/docker/Dockerfile`, with its own
  Convex, media service, and web app, with the library's `Music` folder at `/music`. It runs
  until the music port deletes `legacy/music`.

A run has two sides, each its own Compose project that holds both apps:

- `after` is built from this checkout. It is the default side for every command.
- `before` is main: movies is `ghcr.io/lmdevv/media:main`, the last image published from main,
  and music is built from `origin/main:legacy/music`.

Each side runs its own revision's `deploy/compose`, copied into its state folder: the checkout's
for `after`, `origin/main`'s for `before`. `up` reads the layout from it and from the image, and
records it:

| Layout        | What runs                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------ |
| `one-backend` | The all-in-one image with one Convex backend, the core's. Everyone is a core user who signs in once at `/`; `/movies` has no sign-in or profiles, and the movies iOS app signs in to the core with a username |
| `one-port`    | The all-in-one image with old movies' Convex at `/movies/convex` beside the core's. Movies signs in at `/movies/sign-in` and has profiles |
| `two-port`    | A `convex` service beside a `movies` service, movies at `/`                                |

`up` tells `one-backend` from `one-port` by whether the image holds old movies' Convex project
(`/app/backend`). URLs, setup, the seed, the CLI's sign-in, the browser's relays and sign-in,
doctor, and the iOS forwards follow each side's layout, so a change to the deploy shape still
compares before and after. Until the movies cutover merges, the before side is `one-port`.

You drive a side through three surfaces: a Chromium that stays open between commands and opens
pages in either app, the built `media` and `music` CLIs signed in as each seeded person, and the
movies iOS app on a simulator on the Mac `darwin`. Run every command from the repo root. `S` is
shorthand for the helper:

```sh
S=.agents/skills/verify-media/scripts/verify-media.sh
```

Your shell may not keep variables between tool calls. Spell out the full path, or set `S` in the
same command.

## Isolation

`MEDIA_VERIFY_RUN` names a run and defaults to the checkout's directory name, so two worktrees get
two runs on their own. Each side of a run owns these resources and nothing else:

| Resource   | Name                                                                                    |
| ---------- | --------------------------------------------------------------------------------------- |
| Project    | `media-verify-<run>-<side>`: containers `…-media-1` and `…-music-1`, labeled `media.verify.run=<run>` |
| Volumes    | `media-verify-<run>-<side>_media-data`, `_media-transcode`, `_music-data`, and its network |
| Images     | `media:verify-<run>`, built by `up` for the after side, and `media:verify-<run>-music-<side>` for each side |
| Ports      | Two free loopback ports chosen at `up`: [media]'s one port and music, each at `http://localhost:<port>` (`MEDIA_BASE_URL` and music's `PUBLIC_URL`) |
| Network    | The browser host's own network namespace where the host allows it, reached through Unix sockets in the state folder (see [Network view](#network-view)) |
| State      | `${TMPDIR:-/tmp}/media-verify/<run>/<side>/`: ports, pids, logs, sockets, and each person's CLI config, with music's under `music/` |
| Simulator  | `media-verify-<run>-<side>` on `darwin`, made by `ios up`                               |
| Evidence   | `captures/verify/<run>/`, gitignored and kept after `down`                              |

Never drive or touch anything not named `media-verify-*`. The owner runs a real `movies` stack
on this host (`movies-convex` and the NixOS media service), plus `music` containers; they hold
real data. The owner's shell may also export settings for their own servers, so never run
`apps/cli/dist/media.js` or `legacy/music/apps/cli/dist/music.js` directly: `$S cli` strips those
and gives each person their own `XDG_CONFIG_HOME`. `scripts/dev-stack.sh` and old music's
`scripts/dev-backend.sh` rewrite the `.env.local` files the owner's `pnpm dev` reads, so this
skill never calls them. Compose sees only the settings `up` writes, never a `deploy/compose/.env`
or the caller's environment.

### Network view

Chromium cancels every request still waiting for a connection, to any address including
`localhost`, whenever any interface on its host gains or loses an address. Each Docker container
that starts or stops on a bridge network does that, so another agent's `up`, `down`, or test
container fails requests in a browser on the host with `net::ERR_NETWORK_CHANGED`: a module, a
poster, or data goes missing from the page.

Where the host allows it, the browser host therefore runs in a private user and network namespace
(`scripts/private-network.sh` at the repo root), with the same Chromium, Node, fonts, ffmpeg, and
files. Its loopback has only these, relayed over Unix sockets in the state folder:

- The side's [media] and music ports, at the same numbers, so every URL and origin
  stays `http://localhost:<port>` for the browser and the CLIs alike, and for movies through the
  iOS forwards.
- An HTTPS proxy to the internet on the host, for the Cast SDK, TMDB images, and trailers.
  Chromium sends loopback addresses straight to the relays, never through it.

`$S browser` and `seed.mjs` reach the host through `browser.sock` in the state folder. Every
command fails, naming the requests, when Chromium cancelled any with `net::ERR_NETWORK_CHANGED`
since the page's last command: open the page again before you trust it. In the namespace that
should never happen.

The namespace needs Linux with unprivileged user namespaces, util-linux's `unshare`, and
iproute2's `ip`. Some hosts lack one, such as macOS, or Ubuntu 24.04, whose AppArmor policy
blocks unprivileged user namespaces by default. `MEDIA_VERIFY_BROWSER_NETWORK`, read at `up` and
`browser restart`, picks what happens:

| Value            | Browser network                                                              |
| ---------------- | ---------------------------------------------------------------------------- |
| `auto` (default) | The namespace when a quick check can make one; otherwise the host network    |
| `isolated`       | The namespace, or the browser host stops and says why                        |
| `host`           | The host network                                                             |

On the host network, `up` and `doctor` print why, and Docker network changes elsewhere on the
host can fail the browser's requests; the command that saw them fails rather than hide it.

## Launch

Prerequisites: Docker 28 or later (image mounts), Node 24, pnpm, `pnpm install` done in this
checkout, and ffmpeg for recordings. The first `up` installs `legacy/music` and builds its CLI
when `legacy/music/apps/cli/dist/music.js` is missing. On NixOS the helper uses the system Chromium on its own,
since Playwright's bundled one does not run there. The browser gets its own network namespace
where the host allows it (see [Network view](#network-view)).

```sh
$S up                  # the after side: build both apps from this checkout
$S up --side before    # the before side: pull ghcr.io/lmdevv/media:main, build main's legacy/music
```

`up` does these steps in order and prints how long each took:

1. It builds `media:verify-<run>` from `deploy/image/Dockerfile`, or pulls the main image for
   `before`. A warm Docker cache builds in seconds; a cold one takes several minutes.
2. It builds old music's `media:verify-<run>-music-<side>` from `legacy/music`, or from
   `origin/main:legacy/music` for `before`. An unchanged tree builds from the cache in seconds;
   a cold build takes several minutes.
3. It mounts the library read-only: at `/media/library` for movies and its `Music` folder at
   `/music` for music. The default is the demo library image named in
   `deploy/demo-library/image` (see [Demo data](#demo-data)), through
   `deploy/compose/compose.demo.yaml` for movies; `up` pulls it once per machine.
4. It starts the Compose project and waits until movies' `/api/health` reports
   `"backend":"connected"`, which needs Convex, the deployed functions, and the media service, and
   music's `/healthz` reports `"ok":true`. Each check gives up after 10 seconds, and the wait
   after 6 minutes (`MEDIA_VERIFY_HEALTH_SECONDS`). When it runs out, or a container stops while
   starting, `up` prints the containers' last log lines, which URL never answered, and each
   container's `ip route get` line, removes the side, and exits 1. A route through `tailscale0`
   or another VPN means the host can't reach that Docker network.
5. It starts the browser host, in its own network namespace where it can, and runs first-run setup
   through each web app, as an owner does. The owner is Lucía, with password `password123`: the
   core user `lucia` on `one-backend`, and `admin@movies.local` in old movies and music:
   - `one-backend`: the owner account at `/` in the account client, then the `Movies` library at
     `/media/library/Movies` and the `Shows` library at `/media/library/Shows` from its Admin,
     Libraries, each of kind Movies. Each queues its first scan.
   - `one-port` and `two-port`: old movies' owner account at `/movies/welcome`, the `Movies`
     library and its first scan, then the `Shows` library from movies' Admin, Libraries.
   - Music: the owner account, `/music` as the library folder and its first scan, then an API key
     from `/settings/keys` for her music CLI.
6. It signs Lucía's movies CLI in with her password (`media auth login --username lucia` on
   `one-backend`, `media login --email` before it) and waits until the movies libraries are
   really done: every library scanned and no scan, metadata, or scrub-thumbnail job pending or
   running. The core has no command that lists jobs, so on `one-backend` the wait reads the
   media service's `CoreJobs.claimed` and `CoreJobs.job_ended` log records (`core-seed.mjs wait`).
7. It seeds the demo people in both apps: in movies, the people, the kid, library access, and
   watching (`core-seed.mjs seed` on `one-backend`, `seed.mjs` before it); in music, playlists,
   likes, and sharing (`music-seed.mjs`). Each seed checks that each person sees what the demo
   data says.

Each later step has its own limit too: 21 minutes for each app's first-run setup, a minute for
each CLI sign-in and check, 6 minutes for music's API key, 15 minutes for the library wait, and
15 minutes for each seed. A step that runs out fails `up` the same way, naming the step, and so
does a browser host that doesn't start in 20 seconds. A step that ignores the stop is killed 5
seconds later. On the way out, each Docker call gets 15 seconds and `compose down` 60, so a
stalled Docker daemon can't hold up the removal; a removal that can't finish says so.

The side is ready only after a line like this prints, and `$S status` then says `ready` for it:

```text
ready: http://localhost:40773 in 150s (run verify-media, side after, project media-verify-verify-media-after, image media:verify-verify-media, music http://localhost:39513 image media:verify-verify-media-music-after, library ghcr.io/lmdevv/media-demo-library:v1@sha256:…, evidence …)
```

A warm `up` takes two to three minutes: under 30 seconds to rebuild the images after a small
change, about 20 to start the stack, 60 to 90 for both setups and the first scans with their
scrub thumbnails, and 30 to seed. Both sides at once take a little longer each, since they share
the CPU.

| Flag                            | Use                                                                    |
| ------------------------------- | ---------------------------------------------------------------------- |
| `--side before`                 | Start the main side for a before/after comparison                      |
| `--image IMG`                   | Run another movies image, such as a release tag, instead of building   |
| `--library demo\|fixtures\|DIR` | Pick the library. A DIR holds `Movies/`, `Shows/`, and `Music/` and must be readable by others (`a+rX`) |
| `--no-music`                    | Run movies alone, without old music                                     |
| `--no-seed`                     | Stop after setup: only Lucía (with her own profile in old movies) and the libraries |
| `--no-setup`                    | Leave fresh servers, to verify first-run setup itself                   |

`up` leaves the browser host running in the background, and it keeps every file descriptor `up`
inherited. Under `flock(1)`, that is the lock, held until `down`: take it with `flock -o`, which
closes it for the command, or run `$S browser restart` outside the lock after `up`.

The images hold the checkout as it was at `up`. After you change code, run `down --side after`
and `up` again. `doctor` fails when the checkout has moved on since the build. For movies,
changes only to the paths `.dockerignore` leaves out (`.agents`, `.claude`, `docs`, `legacy`,
`nix`) don't count, since the image doesn't hold them. For music, only `legacy/music` counts,
apart from the paths its own `.dockerignore` leaves out.

### Demo data

Every side starts from the same data, so evidence from any machine looks alike and shows nothing
personal or unlicensed.

- **Library.** `ghcr.io/lmdevv/media-demo-library:v1`, pinned by digest in
  `deploy/demo-library/image`, holds six movies (Big Buck Bunny, Elephants Dream, Sintel, Tears
  of Steel, Cosmos Laundromat, and the four-version `[movies] Feature Test`), two shows
  (Caminandes, 3 episodes, and Pioneer One, 6), and five Creative Commons albums under `Music`
  (28 songs, two of them FLAC EPs), about 7.5 GB with their `CREDITS.md` files. It's a data-only
  image that every side mounts read-only, so Docker keeps one copy per machine. A published
  version never changes; `scripts/build-demo-library.sh` builds it from the published movies and
  music demo images, and the Demo library workflow publishes the version in
  `deploy/demo-library/image`. When the pull fails, check Docker and access to `ghcr.io`, then
  retry. [docs/demo-library.md](../../../docs/demo-library.md) has the details.
- **People.** One set of people in every app, with the password `password123`. On `one-backend`
  each is a core user named by their username, and a kid is their own user; old movies and music
  name them by email, and old movies has profiles instead of the kid user:

  | Who   | Core user | Email (old movies, music) | Role   | Old movies' profiles                       | Music role | CLIs                                      |
  | ----- | --------- | ------------------------- | ------ | ------------------------------------------ | ---------- | ----------------------------------------- |
  | Lucía | `lucia`   | `admin@movies.local`      | owner  | `Lucía`, and `Kids` (kids, PG, PIN `1234`) | owner      | `$S cli --`, `$S cli --app music --`      |
  | Mateo | `mateo`   | `mateo@movies.local`      | admin  | `Mateo`                                    | admin      | `$S cli --as mateo --`, and `--app music` |
  | Aiko  | `aiko`    | `aiko@movies.local`       | member | `Aiko`                                     | member     | `$S cli --as aiko --`, and `--app music`  |
  | Sam   | `sam`     | `sam@movies.local`        | member | `Sam`                                      | guest      | `$S cli --as sam --` (movies only)        |
  | Kid   | `kids`    | none                      | member, limited to PG | none                        | none       | `$S cli --as kids --` (`one-backend` only) |

  On `one-backend`, Mateo, Aiko, and Sam joined from invite links that Lucía made in the account
  client's Admin, Users (`/admin`), and Lucía made the kid's account there with a password. In old
  movies they joined from invite links made in its Admin, Users. In music they joined from
  invites she made with music's CLI, and each made an API key at `/settings/keys` for their CLI,
  except Sam: guests can't make keys.
- **Ratings.** The films ship unrated, and a limited person or profile hides unrated titles, so
  Lucía rated them: Big Buck Bunny `G`, Caminandes `TV-Y`, Cosmos Laundromat `PG`, Elephants Dream, Sintel,
  and Tears of Steel `PG-13`, and Pioneer One `TV-14`. The Feature Test stays `NR`.
- **Access.**
  - `one-backend`: a core library is private to whoever made it until it is shared, admins
    included. Lucía made both. `Movies` is shared with Mateo (manages), Aiko, and `kids` (view);
    `Shows` with Mateo (manages) and everyone on the server (view). `kids` is limited to a
    minimum viewer age of 7 (PG) with unrated titles hidden, and is listed on shared devices, so
    a shared browser's picker at `/` shows its tile.
  - Old movies: `Movies` is restricted (`Only people I choose`) and granted to Aiko; `Shows` is
    for everyone. Admins see every library.
  - Lucía, Mateo, and Aiko see all 8 titles. Sam sees only Caminandes and Pioneer One: a movie's
    page reads `This title isn't here`, and the CLI's `titles get` fails (exit 5, notFound, in old
    movies).
  - The kid (`kids` on `one-backend`, Lucía's `Kids` profile in old movies) sees Big Buck Bunny,
    Caminandes, and Cosmos Laundromat. Old movies' `Kids` asks for its PIN when a session picks
    it, and its CLI refuses its titles until `profiles unlock --profile-id <id> 1234`.
- **Watching.** Aiko stopped Elephants Dream halfway and watched Pioneer One episodes 1 and 2, so
  her `Continue watching for Aiko` row shows `Pioneer One · S1:E3` (next: Alone in the Night) and
  `Elephants Dream` (50% watched). Her My List holds Sintel, Tears of Steel, and Caminandes;
  Mateo's holds Cosmos Laundromat.
- **Music.** `/music` is shared, so admins and members play it, and Sam plays it through a grant.
  - Lucía's `Sunday morning` (4 songs) is shared with Mateo as a collaborator, and with Aiko and
    Sam as viewers.
  - Lucía's `Deep focus` (4 songs) and Aiko's `Waltzes` (2 songs) are private.
  - Mateo's `Lossless` (the 7 FLAC songs) is shared by link.
  - Lucía likes `Wanderer`, `Doppelgänger`, and `Hoist`. Mateo likes `Drifting Cargo`. Aiko likes
    `Neptune` and `Naughty Waltz`.

Sign a movies page in as anyone with `$S browser sign-in --page aiko --username aiko` on
`one-backend` (at `/`, then `/movies`), or `$S browser sign-in --page aiko --email
aiko@movies.local --profile Aiko` in old movies, and a music page with `$S browser sign-in --app
music --page aiko-music --email aiko@movies.local`. `--library fixtures` generates the stack tests' short fixture titles instead
(`Big Buck Fixture`, `Fixture Show`) and music's four albums of short chords. It needs no
download, but the seeds need the demo titles and songs, so pair it with `--no-seed`.

## Doctor

Run `$S doctor [--side S]` first, and again whenever anything looks off. It is read-only, prints
one line per check, and exits non-zero on any `FAIL`:

- Both containers run, belong to this run, and own their ports.
- `/api/health` reports the backend connected.
- The media service runs the image that `up` recorded.
- Init deployed this image's functions for each project the layout runs: `/data/core/version` on
  `one-backend`, and `/data/movies/version` too on `one-port`, match the image's versions and
  functions hashes.
- The browser host answers.
- The browser has its own network namespace: its Chromium's `/proc/<pid>/ns/net` differs from
  the helper's. When the browser shares the host network instead, an `info` line says why.
- Lucía's CLI is signed in: as `lucia` on the core on `one-backend` (`auth sessions current`), else
  as `admin@movies.local` (`whoami`).
- For the after side, the image matches the checkout.
- Music's container runs, belongs to this run, owns its port, and runs the image from `up`;
  `/healthz` is ok; its init deployed this build (`/data/build` matches `/app/build-id`); Lucía's
  API key signs music's CLI in; and for the after side, the image matches `legacy/music`.

The `info` lines name the version, the images, the library, and music's address and build. The
`before` side often shows the same version as the checkout even when the code differs, because
the `:main` tag moves only when the Image workflow publishes. `$S logs [--side S] [--service
media|music] [N]` shows a container's last lines; the media service logs one JSON record
per line, such as `"message":"Stream.started"` with the stream's `mode`, and music's container
holds its init, Convex, media service, and Caddy logs. `$S status` lists each side's apps, whether
the side is `ready`, still `starting`, or `failed` (its `up` stopped before ready; run `down`),
and its simulator.

When `up` failed partway, or `doctor` reports a run you don't recognize, run `$S down` and start
again.

## Drive

### Browser

`$S browser [--side S] [--app movies|music|account] <command> [flags]` sends one action to the
open Chromium and prints the result. A failed action exits 1 with Playwright's message. A host
that doesn't answer makes it exit 124 a second after its `--timeout`, or after 5 minutes without
one (20 for `setup`). URLs are
paths inside the page's app: a movies page opens `/title/<id>` at `/movies/title/<id>`.

Each page belongs to one app, which `--app` picks when the page is created: `movies` (the default),
`music`, or `account`, the account client at `/`. A later command on the page needs no `--app`. With `--app music`, `--page` defaults to
`music` instead of `main`; `up` signs `music` in as Lucía. A command that names a page with the
other app fails, so give each app's pages their own names.

Name an element with exactly one of these flags, the way the app's ARIA tree names it:

- `--role R [--name N] [--exact]` is preferred.
- `--label L`, `--text T`, or `--testid ID`.
- `--css S` is the last resort, for elements with no accessible name.

Scope with `--in role[=name]`, such as `--in main` or `--in region="Continue watching for Aiko"`.
Pick one of several matches with `--nth K` (from 0). Without `--nth`, a locator that matches
several elements fails. Names match by substring unless you pass `--exact`: `Play` without it also
matches `Play from start`.

| Command                                          | Does                                                         |
| ------------------------------------------------ | ------------------------------------------------------------ |
| `open [path]`                                    | Full page load. Prints the URL                               |
| `click`, `hover`                                 | Acts on the element                                          |
| `fill --value V`                                 | Replaces a field's value                                     |
| `select --value V`                               | Picks the option labelled V in a select                      |
| `type --value V`                                 | Types into whatever has focus, such as a PIN or the command menu |
| `press --key K` (optionally with a locator)      | Presses a key on the page or on the element                  |
| `wait <locator> [--hidden]`, `wait --url RE`     | Waits up to 30 s (`--timeout ms`)                            |
| `text`, `count`, `attr --attr A`                 | Reads the element                                            |
| `snapshot [locator] [--path F]`                  | Prints the ARIA tree, and saves it with `--path`             |
| `screenshot --path F [--full]`                   | Centres an element in the window, waits for the posters and backdrops it covers, then saves a PNG of the page or element. Fails when any of them failed to load |
| `video` (or `audio`)                             | Prints `{"playing","seconds","elements","source","size","requests"}` from the real media element |
| `wait-video` (or `wait-audio`) `--past S` or `--advance S` | Waits until the media plays past S, or S more seconds |
| `record-start --path F.mp4 [--show-actions]`     | Records the page to an H.264 MP4                             |
| `record-stop`                                    | Finishes the recording and prints its path                   |
| `url`, `pages`, `close-page`, `eval --js`        | Inspects the session, or closes a page and its recording     |
| `network`                                        | Prints `isolated` or `host` and the Chromium's pid           |
| `restart`                                        | Restarts the host after `browser.mjs` changed; signs `main` and `music` in again as Lucía |

Movies pages on `one-backend`, and account pages on any side with the account client, take these.
They act in the account client, in the page's own browser context, so the session a movies page
reads is the one they leave:

| Command                                          | Does                                                         |
| ------------------------------------------------ | ------------------------------------------------------------ |
| `sign-in [--username U --password P]`            | Signs the page in at `/`, as `lucia` by default, and waits for `/home`. A movies page then opens `/movies` |
| `setup [--movies DIR] [--shows DIR]`             | Creates the owner at `/` and adds the libraries from Admin, Libraries |
| `invite [--invite-role member\|admin]`           | Makes an invite link in Admin, Users (`/admin`) and prints its code |
| `join --code C --username U [--password P]`      | Accepts an invite at `/invite#<code>` and makes the account  |
| `create-account --username U [--password P] [--invite-role member\|admin]` | Makes an account with a password in Admin, Users |

A movies page on `one-backend` has no `profile` or `add-profile`: each person, a kid too, is their
own user, so sign in as them instead.

Movies pages on `one-port` and `two-port`, where old movies signs in on its own, take these:

| Command                                          | Does                                                         |
| ------------------------------------------------ | ------------------------------------------------------------ |
| `sign-in [--email E --password P] [--profile N [--pin P]]` | Signs the page in at `/sign-in`, as Lucía by default, and picks a profile |
| `profile --profile N [--pin P]`                  | Picks a profile at `/profiles`, entering its PIN when asked  |
| `add-profile --profile N [--kids] [--pin P]`     | Adds a profile from `/profiles/new`                          |
| `invite [--invite-role member\|admin]`           | Makes an invite link in Admin, Users and prints its code     |
| `join --code C --name N --email E`               | Accepts an invite at `/invite/<code>` and makes the account  |

Music pages take these:

| Command                                          | Does                                                         |
| ------------------------------------------------ | ------------------------------------------------------------ |
| `sign-in [--email E --password P]`               | Signs the page in at `/sign-in`, as Lucía by default         |
| `join --code C --name N --email E`               | Makes an account from an invite at `/invite/<code>`          |
| `create-key`                                     | Makes an API key at `/settings/keys` and prints it           |

`video` reads the page's media elements, not the player's buttons. `source` is `file` when the
browser plays the original file and `mse` when the HLS player feeds it, and `requests` counts the
page's `/media/direct/` and `/media/hls/` fetches since it last loaded. The media service's log
says which way it served the stream: `$S logs | grep Stream.started` shows `"mode":"direct"`,
`"audio-transcode"`, `"remux"`, or `"transcode-software"`.

`--page NAME` (default `main`, or `music` with `--app music`) picks a browser context, which the
app sees as its own device with its own sign-in. The first command that names a new page creates
it. On that first command, `--device "iPhone 15"` (any Playwright device name) makes it a phone,
and `--width W --height H` sets the window. `--tab-of P` instead makes it another tab of page P:
the same context, size, and sign-in, as in `$S browser open / --page aiko-2 --tab-of aiko`, to
check what a second tab sees. `close-page` on a tab closes that tab alone. Each app follows the system theme: a movies page is
dark unless `--light`, and a music page is light unless `--dark`, as each app defaults. Only
`main` (Lucía, on her own profile in old movies) and `music` are signed in by `up`, so start a
new page with `sign-in`, as in `$S browser sign-in --page phone --device "iPhone 15"` on
`one-backend`, `$S browser sign-in --page phone --device "iPhone 15" --profile Lucía` in old
movies, or `$S browser sign-in --app music --page music-phone --device "iPhone 15" --dark`.

When you don't know an element's name, run `$S browser snapshot --in main` and read the names
from the tree.

### CLI

`$S cli [--side S] [--as mateo|aiko|sam|kids] -- <args>` runs `apps/cli/dist/media.js` against
the side as Lucía, or as a seeded person, each signed in with their password and their own config.
`up` builds it from this checkout for the after side. On `one-backend` each signed in to the core
with `media auth login --username <user>`, so use the core's words: `movies titles list`, `movies
titles search --query Q`, `movies play start --title-id ID`, `movies my-list list`, `movies
history continue-watching`, `auth sessions current`, and for admins `admin users list`, and
`movies stream <title>` to get a stream URL for a local player. The old top-level words
(`search`, `titles list`, `whoami`, `login`) are gone and exit 2 naming where they moved, so the
CLI can't sign in to a `one-port` side's old movies. A command whose arguments nest takes
`--json '<object>'`. Output is JSON. Exit codes: `0` ok, `1` failed, `2` usage, `3`
unauthenticated, `4` forbidden, `5` notFound. `$S cli -- --help` lists every command. `kids` has a
CLI only on `one-backend`.

`$S cli [--side S] --app music [--as mateo|aiko] -- <args>` runs old music's
`legacy/music/apps/cli/dist/music.js` against the side's music with the person's API key. Add
`--json` for stable output. Exit codes: `0` ok, `1` failed, `2` usage, `3` auth. Sam has no music
CLI, since guests can't make API keys.

Both CLIs are built from this checkout, so on the before side they talk to main's servers: a
command that is new in the checkout fails there.

### iOS simulator

The movies iOS app (`apps/mobile-movies`) runs on a simulator on `darwin` (set `MAC_HOST` for
another Mac). It signs in to the core through the media server's sign-in boundary, so `ios up`
refuses a side whose image still runs old movies' own Convex (`one-port`, `two-port`): run an iOS
lane against such an image from a checkout of that image's revision, with its own verify skill.
Old music's
iOS app is not driven here; the `ios` commands sign in to movies only. Its JavaScript comes
from a Metro on this machine. For the before side, Metro serves a main checkout that `ios up`
makes with `git worktree` under the side's state. The simulator reaches the side as
`localhost:<port>` through ssh forwards for [media]'s one port and Metro, so every address
matches the side's public URLs.

```sh
$S ios up [--side S] [--device "iPhone 17 Pro"] [--light] [--source DIR]
```

`--source DIR` has Metro serve another checkout's JavaScript, such as a PR's worktree, against
this side's server, so one stack verifies several app branches with this checkout's tooling.

`ios up` needs the side to be up with setup, and it stops before anything else when the Mac has
less than 3 GB free, or 10 GB when it must build the dev client. It does these steps in order:

1. It forwards [media]'s port and Metro's to the Mac.
2. It starts Metro.
3. It creates and boots the simulator `media-verify-<run>-<side>`, in dark mode unless `--light`.
4. It installs the dev client. The build is named for the app's native inputs (`app.json`, its
   `package.json`, the lockfile, and the asset names) and lives at `~/movies-ios/dev-client-<hash>`
   on the Mac, so every run and worktree with the same inputs installs the same build. When none
   matches, it syncs this checkout to `~/movies-ios/verify-<run>`, runs `expo prebuild` there,
   and builds, which takes several minutes.
5. It turns off the dev client's own UI (its first-launch introduction, its floating button, and
   the gestures that open its menu), so screenshots show only the app.
6. It opens the app on Metro, connects to the side's server, and signs in as Lucía with her
   username and password. The app has no profiles (D12): switching person is signing out, then
   `ios sign-in --as <person>`. A new simulator's first sign-in brings up iOS's `Save Password?`
   sheet over the app; `ios up` and `ios sign-in` answer `Not Now`.

It prints `ready: ios <side> on simulator <udid>` when the app shows Home. Then:

| Command                                          | Does                                                    |
| ------------------------------------------------ | ------------------------------------------------------- |
| `ios describe`                                   | Prints the screen's accessibility tree: `label = value \| type #id \| x,y wxh` |
| `ios find <label>`                               | Prints where `ios tap --label` would tap, or fails when it's off screen |
| `ios tap --label L` or `--id ID` or `-x X -y Y`  | Taps an element by its exact accessibility label or id, or a point |
| `ios type <text>`                                | Replaces the focused field's text                       |
| `ios sign-in [--as P]`                           | Connects and signs in as Lucía, or person P, from the welcome or sign-in screen |
| `ios swipe <x1> <y1> <x2> <y2>`                  | Swipes, in points                                       |
| `ios wait <label> [seconds]`                     | Waits until the label appears in the tree               |
| `ios shot <path.png>`                            | Saves a screenshot                                      |
| `ios record start <path.mp4>`, `ios record stop` | Records the screen to an H.264 MP4                      |
| `ios appearance light\|dark`                     | Switches the system appearance                          |
| `ios doctor`                                     | Checks the forwards, Metro, the simulator, and that the Mac reaches the web app and Convex |
| `ios orientation portrait\|landscape`            | Turns the simulator and checks the app's window turned  |
| `ios open <path>`                                | Opens an app path, such as `/title/<id>`, and accepts iOS's `Open in` prompt |
| `ios matrix --out DIR [--orientations portrait,landscape] [--screens a,b]` | Screenshots each screen a layout change reaches, in each orientation, as `<device>-<orientation>-<screen>.png` |
| `ios down`                                       | Removes this side's simulator, Metro, and forwards      |

Read labels from `ios describe` before you tap; never guess coordinates. A label is the whole
accessibility label. When several elements share a label, `ios tap --label` picks a field or
button over plain text. It taps only an element whose centre is on screen: a row that scrolls
sideways lists cards past the edge too, so swipe the row first (`ios swipe 350 729 80 729` on an
iPhone 17 Pro's Continue Watching). Every tap is a touch held for 0.15 s, since AXe's instant
tap misses the tab bar. Every `ios` command takes `--side S`.

## Evidence

Evidence lives in `captures/verify/<run>/`, under `before/` and `after/`, and survives `down`.
Proof standards:

- Drive the real user path: the UI, the CLI, or the simulator. Never internal setters, direct
  Convex calls, or test-only endpoints.
- Capture the action and the resulting state, not just the final screen. A recording or a
  screenshot plus an ARIA snapshot (`snapshot --path`) or an `ios describe` dump.
- Verify the side effect behind what's visible: real video or audio with `wait-video` or
  `wait-audio`, the stream's mode in `$S logs`, stored data with `$S cli -- <command>` (or `$S cli
  --app music -- <command> --json`), or files in the container with `docker exec`.
- For a change, capture the same journey on both sides, at the same size, theme, and data. The
  before side is the parent's behavior; a difference you can't explain is a finding.

### Put it on the PR

A PR that changes what a user sees ships before and after screenshots of each changed screen, at
desktop and phone size for the web, and a short video of the changed flow. A new screen has only an
after. Add each pair to the run's manifest, then publish. The manifest outlives `down`, so start
each PR with `evidence clear`, which empties it and keeps the files:

```sh
$S evidence clear
$S evidence add --label "Title page, desktop" --before captures/verify/<run>/before/title.png --after captures/verify/<run>/after/title.png
$S evidence add --label "Play a movie on a phone" --after captures/verify/<run>/after/play.mp4
$S evidence list
$S evidence publish --pr <number> --dry-run   # print the block, attach nothing
$S evidence publish --pr <number>
```

`publish` turns every video into an H.264 MP4 under 10 MB, which is GitHub's limit for an image
and, on a free plan, for a video. It writes a `## Screenshots and video` block between
`<!-- verify-media:start -->` and `<!-- verify-media:end -->` and leaves the rest of the PR
description alone. One manifest holds a run's captures from both apps, so one block shows them
all. `publish --dry-run` without `--pr` prints the block alone. Each file goes in as an `![alt](./captures/…)` reference, the only form that
`gh pr edit --attach` rewrites; `gh` uploads it to `github.com/user-attachments` and rewrites the
path. `publish` then turns each uploaded video reference into a bare asset URL on its own line,
which GitHub plays inline, reads the description back, and fails if a `./captures/` path is left.
Publishing again replaces the block. To check an upload, fetch it with `curl -sL`: the asset
redirects to a signed S3 URL that answers `HEAD` with 403 and `GET` with 200. The repo is public,
so anyone with a link can open an upload. Never capture secrets: a new API key, a device code, or
an invite link, or music's `/settings/keys` screen right after it made a key.

## Cleanup

```sh
$S down                 # both sides: simulators, Metro, forwards, browser hosts, projects, volumes, the built images
$S down --side before   # one side
$S down --purge         # also remove the iOS build cache on the Mac (~/movies-ios/verify-<run>, and dev-client-<hash> for this checkout)
```

`down` stops only what this run started: processes by the pids it recorded (the browser host
stops its own namespace, relays, and sockets with it), and Docker resources
by this side's Compose project label, which also finds them when the state folder is gone. It
never kills by process name. The demo library image stays for the next run. Evidence in
`captures/verify/<run>/` stays; clear it yourself when you no longer need it.

## Helpers

- `scripts/verify-media.sh` is the entry point for everything above. `$S` with no command prints
  its usage.
- `scripts/browser.mjs` is the browser host that `up` starts and `browser` talks to. Run it
  directly only to debug the host. Its log is `${TMPDIR:-/tmp}/media-verify/<run>/<side>/browser.log`.
- `scripts/evidence.mjs` keeps the manifest and publishes it. `$S evidence` calls it.
- `scripts/contact-sheet.sh OUT.png COLUMNS WIDTH FILE...` tiles screenshots, such as an `ios
  matrix`, into one captioned image for a review or a PR.
- `scripts/compare-shots.sh BEFORE_DIR AFTER_DIR [GLOB]` compares same-named screenshots below the
  status bar and prints `same` (no pixel moved by more than 2 of 255) or the largest change, exiting 1 when any differ: the check that a change
  left the iPhone alone.
- `scripts/core-seed.mjs` creates the movies [demo data](#demo-data) on a `one-backend` side after
  setup and checks what each person sees, and its `wait` waits for the first scans there.
  `scripts/seed.mjs` does the same in old movies, and `scripts/music-seed.mjs` in music. `up`
  calls the ones the side needs.
- `node --test .agents/skills/verify-media/scripts/verify-media.test.mjs` runs the skill's own tests, which need no
  stack: the browser host serves pages of both apps from local servers, in its namespace and on
  the host network, and `evidence` builds one block from both apps' captures.
- `scripts/check-network.mjs [--trials N] [--image IMG]` proves the [network view](#network-view)
  on this host, with no stack. It runs one browser host on the host network and one isolated,
  stops a bridge container of its own (`media-verify-netcheck-<pid>`, default image
  `ghcr.io/lmdevv/media:main`) while each has requests waiting, and prints what each lost. It
  exits 0 when the isolated host lost none and the host-network one lost some, 1 when the isolated
  one lost any or failed, and 2 when the control lost none, which proves nothing. The container can fail
  requests in other browsers on this host, so run it only to check the isolation.

## Feature map

`features/README.md` indexes what movies does and what proves each feature works, and
`features/music/README.md` does the same for old music. Read the feature's file before you drive
it, and add to the map when a change adds a feature.

## Gotchas

- `--show-actions` draws a pointer and step titles on the page while a recording runs, and they
  also show in screenshots taken then. Take stills outside a recording.
- A recording runs in real time, and scripted steps finish in about a second, too fast to follow.
  Pause a second or two after each step's result (`sleep 2` between commands) and before
  `record-stop`, so a reviewer sees each state. A still page holds its last frame.
- In old movies, a full page load (`open`) in a page that hasn't picked a profile lands on
  `Who's watching?`. Pick one with `profile --profile N`, which returns to the page you asked
  for. `one-backend` has no profiles.
- On `one-backend`, a movies page that isn't signed in is sent to `/`, the account client, to
  sign in. Signing out in `/movies` signs out the page's account client too: they share one
  session per browser context.
- The player hides its controls while the video plays, and the video then takes the clicks. Hover
  the player first (`hover --testid player-video`), then click a control.
- A title with progress shows `Resume <time>` and `Play from start` instead of `Play`. Playback in
  one recipe changes what the next one sees on both the web and the CLI.
- Progress, My List, and history are per person on `one-backend`, and per profile in old movies.
  A second page signed in as the same person on another profile sees other rows.
- The before side runs main's server with the CLI and dev client built from this checkout. If the
  change is in the CLI or in native iOS code, the before side shows the new client against the old
  server. Say so beside that evidence.
- Music's app scrolls inside its own panels, not the page, so `screenshot --full` captures only
  the window there. To show something below the fold, screenshot its element.
- In music, a shortcut key such as `n` or `/` types into a focused field instead. Open a page
  where focus is outside fields, such as an album, before you press it.
- Music's playback state is per account, not per page: a second music page sees the song that
  `music` left playing or paused.
- The simulator shares the Mac's network. `localhost` there is the Mac, reached through the ssh
  forwards. Without them the app can't reach the server.
- Metro started with `CI=1` stops watching files, and the app keeps the old bundle. `ios up` does
  not set it; don't add it.
- `ios type` pastes through the simulator's pasteboard and replaces the field's text: AXe's own
  typing drops characters in the app's fields. It sends US keyboard characters only.
- `ios record` captures the whole screen at device resolution. `evidence publish` shrinks a clip
  over 10 MB to 720 pixels wide; keep iOS clips under a minute.
- The Mac's disk is nearly full. A dev client build takes about 7 GB there (3 for the synced
  checkout, 4 for the build, deleted once the app is copied out). `down --purge` frees the
  checkout and this checkout's dev client, which other runs with the same native inputs share.
- On an iPad the tab bar sits at the top as a toolbar of radio buttons (`Home = 1 | RadioButton`),
  so look for those, not `Tab Bar`. Pick a size with `ios up --device`, such as `"iPad mini (A17
  Pro)"` or `"iPad Pro 13-inch (M5)"`, and run `ios matrix` once per device: one side holds one
  simulator, so `ios down` and `ios up --device` again for the next size. The shared dev client
  makes that about a minute.
- AXe describes a point in portrait coordinates but taps in the screen's current ones, so in
  landscape a point from `ios describe` is not where `describe-ui --point` looks.
- `ios open` answers iOS's prompts through agent-device's `alert` command, which also reports the
  app's own sheets (such as Seasons). `ios matrix` therefore stops only on system prompts, which
  end in a question or ask for permission. Compare two matrices only when both ran the same
  `--screens` list: a screen opened after a sheet can open inside it.
- iOS's own sheets, such as `Save Password?`, aren't in `ios describe`, which lists the app's
  elements only. When taps stop doing anything, take an `ios shot` and look.
