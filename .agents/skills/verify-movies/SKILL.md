---
name: verify-movies
description: Run disposable [movies] stacks (the real Compose install, with the Convex backend, the media service, the scanner, ffmpeg, and real video) built from this checkout and from main, then drive the web app in Chromium, the `movies` CLI as each seeded person, and the iOS app on a Mac simulator to prove a change works the way a user sees it. Captures before/after screenshots and H.264 videos and publishes them to the PR description. Use to verify a web, CLI, backend, media, or iOS change end to end, to reproduce a user-facing bug, or to put visual evidence on a PR.
---

# Verify [movies]

This skill runs the real product: `deploy/compose/compose.yaml`, with its `convex` backend and its
`movies` media service (which also serves the web app), and the demo library mounted read-only at
`/media/library`. A run has two sides, each its own Compose project:

- `after` is an image built from this checkout. It is the default side for every command.
- `before` is `ghcr.io/lmdevv/movies:main`, the last image published from main.

You drive a side through three surfaces: a Chromium that stays open between commands, the built
`movies` CLI signed in as each seeded person, and the iOS app on a simulator on the Mac `darwin`.
Run every command from the repo root. `S` is shorthand for the helper:

```sh
S=.agents/skills/verify-movies/scripts/verify-movies.sh
```

Your shell may not keep variables between tool calls. Spell out the full path, or set `S` in the
same command.

## Isolation

`MOVIES_VERIFY_RUN` names a run and defaults to the checkout's directory name, so two worktrees get
two runs on their own. Each side of a run owns these resources and nothing else:

| Resource   | Name                                                                                    |
| ---------- | --------------------------------------------------------------------------------------- |
| Project    | `movies-verify-<run>-<side>`: containers `…-convex-1` and `…-movies-1`, labeled `movies.verify.run=<run>` |
| Volumes    | `movies-verify-<run>-<side>_convex-data`, `_movies-data`, `_movies-transcode`, and its network |
| Image      | `movies:verify-<run>`, built by `up` for the after side                                 |
| Ports      | Two free loopback ports chosen at `up`: the web app and Convex, with `MOVIES_PUBLIC_URL` and `CONVEX_PUBLIC_URL` at `http://localhost:<port>` |
| Network    | The browser host's own network namespace on Linux, reached through Unix sockets in the state folder (see [Network view](#network-view)) |
| State      | `${TMPDIR:-/tmp}/movies-verify/<run>/<side>/`: ports, pids, logs, sockets, and each person's CLI config |
| Simulator  | `movies-verify-<run>-<side>` on `darwin`, made by `ios up`                              |
| Evidence   | `captures/verify/<run>/`, gitignored and kept after `down`                              |

Never drive or touch anything not named `movies-verify-*`. The owner runs a real `movies` stack
on this host (`movies-convex` and the NixOS media service), plus `music` containers; they hold
real data. The owner's shell also exports `MOVIES_CONVEX_URL` and `MOVIES_MEDIA_URL` for their own
server, so never run `apps/cli/dist/movies.js` directly: `$S cli` strips those and gives each
person their own `XDG_CONFIG_HOME`. `scripts/dev-stack.sh` rewrites the `.env.local` files the
owner's `pnpm dev` reads, so this skill never calls it. Compose sees only the settings `up`
writes, never a `deploy/compose/.env` or the caller's environment.

### Network view

Chromium cancels every request still waiting for a connection, to any address including
`localhost`, whenever any interface on its host gains or loses an address. Each Docker container
that starts or stops on a bridge network does that, so another agent's `up`, `down`, or test
container fails requests in a browser on the host with `net::ERR_NETWORK_CHANGED`: a module, a
poster, or data goes missing from the page.

On Linux the browser host therefore runs in a private user and network namespace
(`scripts/private-network.sh` at the repo root), with the same Chromium, Node, fonts, ffmpeg, and
files. Its loopback has only these, relayed over Unix sockets in the state folder:

- The side's web and Convex ports, at the same numbers, so every URL and origin stays
  `http://localhost:<port>` for the browser, the CLI, and the iOS forwards alike.
- An HTTPS proxy to the internet on the host, for the Cast SDK, TMDB images, and trailers.
  Chromium sends loopback addresses straight to the relays, never through it.

`$S browser` and `seed.mjs` reach the host through `browser.sock` in the state folder. Every
command fails, naming the requests, when Chromium cancelled any with `net::ERR_NETWORK_CHANGED`
since the page's last command: open the page again before you trust it. In the namespace that
should never happen.

The namespace needs unprivileged user namespaces, util-linux's `unshare`, and iproute2's `ip`.
When it can't be made, the browser host stops and says so; it never falls back to the host
network on its own. `MOVIES_VERIFY_BROWSER_NETWORK=host` at `up` or `browser restart` runs the
browser on the host network, as it does on macOS, and `doctor` then says so.

## Launch

Prerequisites: Docker 28 or later (image mounts), Node 24, pnpm, `pnpm install` done in this
checkout, and ffmpeg for recordings. On NixOS the helper uses the system Chromium on its own,
since Playwright's bundled one does not run there. On Linux the browser host also needs
unprivileged user namespaces (see [Network view](#network-view)).

```sh
$S up                  # the after side: build the image from this checkout
$S up --side before    # the before side: pull ghcr.io/lmdevv/movies:main
```

`up` does these steps in order and prints how long each took:

1. It builds `movies:verify-<run>` from `deploy/compose/Dockerfile`, or pulls the main image for
   `before`. A warm Docker cache builds in seconds; a cold one takes several minutes.
2. It mounts the library read-only at `/media/library`. The default is the demo library image
   named in `deploy/demo-library/image` (see [Demo data](#demo-data)), through
   `deploy/compose/compose.demo.yaml`; `up` pulls it once per machine.
3. It starts the Compose project and waits until `/api/health` reports
   `"backend":"connected"`, which needs Convex, the deployed functions, and the media service.
4. It starts the browser host, in its own network namespace on Linux, and runs first-run setup
   through the web app, as an owner does:
   the owner `admin@movies.local` (Lucía) with password `password123`, the `Movies` library at
   `/media/library/Movies` and its first scan, then the `Shows` library at
   `/media/library/Shows` from Admin, Libraries.
5. It signs Lucía's CLI in with her password and waits until the libraries are really done: no
   library scanning and no scan, metadata, or scrub-thumbnail job pending or running.
6. It seeds the demo people, Lucía's Kids profile, library access, and watching (`seed.mjs`), and
   checks that each person sees what the demo data says.

The side is ready only after a line like this prints:

```text
ready: http://localhost:40773 in 95s (run verify-movies, side after, project movies-verify-verify-movies-after, image movies:verify-verify-movies, library ghcr.io/lmdevv/movies-demo-library:v1, evidence …)
```

A warm `up` takes about 90 seconds: under 30 to rebuild the image after a small change, about 15
to start the stack, 45 to 60 for setup and the first scans with their scrub thumbnails, and 10 to
seed. Both sides at once take a little longer each, since they share the CPU.

| Flag                            | Use                                                                    |
| ------------------------------- | ---------------------------------------------------------------------- |
| `--side before`                 | Start the main side for a before/after comparison                      |
| `--image IMG`                   | Run another image, such as a release tag, instead of building          |
| `--library demo\|fixtures\|DIR` | Pick the library. A DIR holds `Movies/` and `Shows/` and must be readable by others (`a+rX`) |
| `--no-seed`                     | Stop after setup: only Lucía, her own profile, and the two libraries   |
| `--no-setup`                    | Leave a fresh server, to verify first-run setup itself                 |

The image holds the checkout as it was at `up`. After you change code, run `down --side after`
and `up` again. `doctor` fails when the checkout has moved on since the build; changes only to the
paths `.dockerignore` leaves out (`.agents`, `.claude`, `docs`, `nix`) don't count, since the image
doesn't hold them.

### Demo data

Every side starts from the same data, so evidence from any machine looks alike and shows nothing
personal or unlicensed.

- **Library.** `ghcr.io/lmdevv/movies-demo-library:v1` holds the full set of
  `scripts/demo-library.sh`: six movies (Big Buck Bunny, Elephants Dream, Sintel, Tears of Steel,
  Cosmos Laundromat, and the four-version `[movies] Feature Test`) and two shows (Caminandes, 3
  episodes, and Pioneer One, 6), about 7 GB with `CREDITS.md`. It's a data-only image that every
  side mounts read-only, so Docker keeps one copy per machine. A published version never changes;
  `scripts/build-demo-library.sh` builds it (`--from ~/movies-demo` reuses a finished download), and
  the Demo library workflow publishes the version in `deploy/demo-library/image`. When the pull
  fails, build it locally. [docs/demo-library.md](../../../docs/demo-library.md) has the details.
- **People.** Everyone's password is `password123`, and everyone has a CLI:

  | Who   | Email                | Role   | Profiles                                   | CLI                     |
  | ----- | -------------------- | ------ | ------------------------------------------ | ----------------------- |
  | Lucía | `admin@movies.local` | owner  | `Lucía`, and `Kids` (kids, PG, PIN `1234`) | `$S cli --`             |
  | Mateo | `mateo@movies.local` | admin  | `Mateo`                                    | `$S cli --as mateo --`  |
  | Aiko  | `aiko@movies.local`  | member | `Aiko`                                     | `$S cli --as aiko --`   |
  | Sam   | `sam@movies.local`   | member | `Sam`                                      | `$S cli --as sam --`    |

  Mateo, Aiko, and Sam joined from invite links that Lucía made in Admin, Users.
- **Ratings.** The films ship unrated, and a limited profile hides unrated titles, so Lucía rated
  them: Big Buck Bunny `G`, Caminandes `TV-Y`, Cosmos Laundromat `PG`, Elephants Dream, Sintel,
  and Tears of Steel `PG-13`, and Pioneer One `TV-14`. The Feature Test stays `NR`.
- **Access.**
  - `Movies` is restricted (`Only people I choose`) and granted to Aiko; `Shows` is for everyone.
    Admins see every library.
  - Lucía, Mateo, and Aiko see all 8 titles. Sam sees only Caminandes and Pioneer One: a movie's
    page reads `This title isn't here`, `/watch/<id>` stops with `No such title`, and the CLI's
    `titles get` exits 5 (notFound).
  - `Kids` sees Big Buck Bunny, Caminandes, and Cosmos Laundromat, and asks for its PIN when a
    session picks it. The CLI refuses its titles until `profiles unlock --profile-id <id> 1234`.
- **Watching.** Aiko stopped Elephants Dream halfway and watched Pioneer One episodes 1 and 2, so
  her `Continue watching for Aiko` row shows `Pioneer One · S1:E3` (next: Alone in the Night) and
  `Elephants Dream` (50% watched). Her My List holds Sintel, Tears of Steel, and Caminandes;
  Mateo's holds Cosmos Laundromat.

Sign a page in as anyone with `$S browser sign-in --page aiko --email aiko@movies.local --profile
Aiko`. `--library fixtures` generates the stack tests' short fixture titles instead (`Big Buck
Fixture`, `Fixture Show`). It needs no download, but the seed needs the demo titles, so pair it
with `--no-seed`.

## Doctor

Run `$S doctor [--side S]` first, and again whenever anything looks off. It is read-only, prints
one line per check, and exits non-zero on any `FAIL`:

- Both containers run, belong to this run, and own their ports.
- `/api/health` reports the backend connected.
- The media service runs the image that `up` recorded.
- The entrypoint deployed this image's functions: `/data/version` matches the image's version and
  functions hash.
- The browser host answers.
- The browser has its own network namespace: its Chromium's `/proc/<pid>/ns/net` differs from
  the helper's. With `MOVIES_VERIFY_BROWSER_NETWORK=host`, or off Linux, an `info` line says the
  browser shares the host network instead.
- Lucía's CLI is signed in.
- For the after side, the image matches the checkout.

The `info` line names the version, the image, and the library. The `before` side often shows the
same version as the checkout even when the code differs, because the `:main` tag moves only when
the Image workflow publishes. `$S logs [--side S] [--service movies|convex] [N]` shows a
container's last lines; the media service logs one JSON record per line, such as
`"message":"Stream.started"` with the stream's `mode`. `$S status` lists the sides and simulators
that are up.

When `up` failed partway, or `doctor` reports a run you don't recognize, run `$S down` and start
again.

## Drive

### Browser

`$S browser [--side S] <command> [flags]` sends one action to the open Chromium and prints the
result. A failed action exits 1 with Playwright's message. URLs are paths on the side's server.

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
| `type --value V`                                 | Types into whatever has focus, such as a PIN or the command menu |
| `press --key K` (optionally with a locator)      | Presses a key on the page or on the element                  |
| `wait <locator> [--hidden]`, `wait --url RE`     | Waits up to 30 s (`--timeout ms`)                            |
| `text`, `count`, `attr --attr A`                 | Reads the element                                            |
| `snapshot [locator] [--path F]`                  | Prints the ARIA tree, and saves it with `--path`             |
| `screenshot --path F [--full]`                   | Centres an element in the window, waits for the posters and backdrops it covers, then saves a PNG of the page or element. Fails when any of them failed to load |
| `video`                                          | Prints `{"playing","seconds","elements","source","size","requests"}` from the real media element |
| `wait-video --past S` or `--advance S`           | Waits until the video plays past S, or S more seconds        |
| `record-start --path F.mp4 [--show-actions]`     | Records the page to an H.264 MP4                             |
| `record-stop`                                    | Finishes the recording and prints its path                   |
| `sign-in [--email E --password P] [--profile N [--pin P]]` | Signs the page in at `/sign-in`, as Lucía by default, and picks a profile |
| `profile --profile N [--pin P]`                  | Picks a profile at `/profiles`, entering its PIN when asked  |
| `add-profile --profile N [--kids] [--pin P]`     | Adds a profile from `/profiles/new`                          |
| `invite [--invite-role member\|admin]`           | Makes an invite link in Admin, Users and prints its code     |
| `join --code C --name N --email E`               | Accepts an invite at `/invite/<code>` and makes the account  |
| `url`, `pages`, `close-page`, `eval --js`        | Inspects the session, or closes a page and its recording     |
| `network`                                        | Prints `isolated` or `host` and the Chromium's pid           |
| `restart`                                        | Restarts the host after `browser.mjs` changed; signs `main` in again as Lucía |

`video` reads the page's media elements, not the player's buttons. `source` is `file` when the
browser plays the original file and `mse` when the HLS player feeds it, and `requests` counts the
page's `/media/direct/` and `/media/hls/` fetches since it last loaded. The media service's log
says which way it served the stream: `$S logs | grep Stream.started` shows `"mode":"direct"`,
`"audio-transcode"`, `"remux"`, or `"transcode-software"`.

`--page NAME` (default `main`) picks a browser context, which the app sees as its own device with
its own sign-in. The first command that names a new page creates it. On that first command,
`--device "iPhone 15"` (any Playwright device name) makes it a phone, `--width W --height H` sets
the window, and `--light` asks for the light theme (dark is the default, as in the app). Only
`main` is signed in by `up`, as Lucía on her own profile, so start a new page with `sign-in`, as
in `$S browser sign-in --page phone --device "iPhone 15" --profile Lucía`.

When you don't know an element's name, run `$S browser snapshot --in main` and read the names
from the tree.

### CLI

`$S cli [--side S] [--as mateo|aiko|sam] -- <args>` runs `apps/cli/dist/movies.js` against the
side as Lucía, or as a seeded person, each signed in with their password and their own config.
Output is JSON. Exit codes: `0` ok, `1` failed, `2` usage, `3` unauthenticated, `4` forbidden, `5`
notFound. `$S cli -- --help` lists every command. The CLI is built from this checkout, so on the
before side it talks to main's server: a command that is new in the checkout fails there.

### iOS simulator

The iOS app runs on a simulator on `darwin` (set `MAC_HOST` for another Mac). Its JavaScript comes
from a Metro on this machine. For the before side, Metro serves a main checkout that `ios up`
makes with `git worktree` under the side's state. The simulator reaches the side as
`localhost:<port>` through ssh forwards for the web app, Convex, and Metro, so every address
matches the side's public URLs.

```sh
$S ios up [--side S] [--device "iPhone 17 Pro"] [--light] [--source DIR]
```

`--source DIR` has Metro serve another checkout's JavaScript, such as a PR's worktree, against
this side's server, so one stack verifies several app branches with this checkout's tooling.

`ios up` needs the side to be up with setup, and it stops before anything else when the Mac has
less than 3 GB free, or 10 GB when it must build the dev client. It does these steps in order:

1. It forwards the web app, Convex, and Metro ports to the Mac.
2. It starts Metro.
3. It creates and boots the simulator `movies-verify-<run>-<side>`, in dark mode unless `--light`.
4. It installs the dev client. The build is named for the app's native inputs (`app.json`, its
   `package.json`, the lockfile, and the asset names) and lives at `~/movies-ios/dev-client-<hash>`
   on the Mac, so every run and worktree with the same inputs installs the same build. When none
   matches, it syncs this checkout to `~/movies-ios/verify-<run>`, runs `expo prebuild` there,
   and builds, which takes several minutes.
5. It turns off the dev client's own UI (its first-launch introduction, its floating button, and
   the gestures that open its menu), so screenshots show only the app.
6. It opens the app on Metro, connects to the side's server, signs in as Lucía, and picks her
   profile. A new simulator's first sign-in brings up iOS's `Save Password?` sheet over the app;
   `ios up` and `ios sign-in` answer `Not Now`.

It prints `ready: ios <side> on simulator <udid>` when the app shows Home. Then:

| Command                                          | Does                                                    |
| ------------------------------------------------ | ------------------------------------------------------- |
| `ios describe`                                   | Prints the screen's accessibility tree: `label = value \| type #id \| x,y wxh` |
| `ios find <label>`                               | Prints where `ios tap --label` would tap, or fails when it's off screen |
| `ios tap --label L` or `--id ID` or `-x X -y Y`  | Taps an element by its exact accessibility label or id, or a point |
| `ios type <text>`                                | Replaces the focused field's text                       |
| `ios sign-in`                                    | Connects and signs in again from the welcome or sign-in screen |
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
- Verify the side effect behind what's visible: real video with `wait-video`, the stream's mode in
  `$S logs`, stored data with `$S cli -- <command>`, or files in the container with `docker exec`.
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
`<!-- verify-movies:start -->` and `<!-- verify-movies:end -->` and leaves the rest of the PR
description alone. Each file goes in as an `![alt](./captures/…)` reference, the only form that
`gh pr edit --attach` rewrites; `gh` uploads it to `github.com/user-attachments` and rewrites the
path. `publish` then turns each uploaded video reference into a bare asset URL on its own line,
which GitHub plays inline, reads the description back, and fails if a `./captures/` path is left.
Publishing again replaces the block. To check an upload, fetch it with `curl -sL`: the asset
redirects to a signed S3 URL that answers `HEAD` with 403 and `GET` with 200. The repo is public,
so anyone with a link can open an upload. Never capture secrets: a new API key, a device code, or
an invite link.

## Cleanup

```sh
$S down                 # both sides: simulators, Metro, forwards, browser hosts, projects, volumes, the built image
$S down --side before   # one side
$S down --purge         # also remove the iOS build cache on the Mac (~/movies-ios/verify-<run>, and dev-client-<hash> for this checkout)
```

`down` stops only what this run started: processes by the pids it recorded (the browser host
stops its own namespace, relays, and sockets with it), and Docker resources
by this side's Compose project label, which also finds them when the state folder is gone. It
never kills by process name. The demo library image stays for the next run. Evidence in
`captures/verify/<run>/` stays; clear it yourself when you no longer need it.

## Helpers

- `scripts/verify-movies.sh` is the entry point for everything above. `$S` with no command prints
  its usage.
- `scripts/browser.mjs` is the browser host that `up` starts and `browser` talks to. Run it
  directly only to debug the host. Its log is `${TMPDIR:-/tmp}/movies-verify/<run>/<side>/browser.log`.
- `scripts/evidence.mjs` keeps the manifest and publishes it. `$S evidence` calls it.
- `scripts/contact-sheet.sh OUT.png COLUMNS WIDTH FILE...` tiles screenshots, such as an `ios
  matrix`, into one captioned image for a review or a PR.
- `scripts/compare-shots.sh BEFORE_DIR AFTER_DIR [GLOB]` compares same-named screenshots below the
  status bar and prints `same` (no pixel moved by more than 2 of 255) or the largest change, exiting 1 when any differ: the check that a change
  left the iPhone alone.
- `scripts/seed.mjs` creates the [demo data](#demo-data) after setup and checks what each person
  sees. `up` calls it.
- `scripts/check-network.mjs [--trials N] [--image IMG]` proves the [network view](#network-view)
  on this host, with no stack. It runs one browser host on the host network and one isolated,
  stops a bridge container of its own (`movies-verify-netcheck-<pid>`, default image
  `ghcr.io/lmdevv/movies:main`) while each has requests waiting, and prints what each lost. It
  exits 0 when the isolated host lost none and the host-network one lost some, 1 when the isolated
  one lost any or failed, and 2 when the control lost none, which proves nothing. The container can fail
  requests in other browsers on this host, so run it only to check the isolation.

## Feature map

`features/README.md` indexes what the app does and what proves each feature works. Read the
feature's file before you drive it, and add to the map when a change adds a feature.

## Gotchas

- `--show-actions` draws a pointer and step titles on the page while a recording runs, and they
  also show in screenshots taken then. Take stills outside a recording.
- A recording runs in real time, and scripted steps finish in about a second, too fast to follow.
  Pause a second or two after each step's result (`sleep 2` between commands) and before
  `record-stop`, so a reviewer sees each state. A still page holds its last frame.
- A full page load (`open`) in a page that hasn't picked a profile lands on `Who's watching?`.
  Pick one with `profile --profile N`, which returns to the page you asked for.
- The player hides its controls while the video plays, and the video then takes the clicks. Hover
  the player first (`hover --testid player-video`), then click a control.
- A title with progress shows `Resume <time>` and `Play from start` instead of `Play`. Playback in
  one recipe changes what the next one sees on both the web and the CLI.
- Progress, My List, and history are per profile. A second page signed in as the same person on
  another profile sees other rows.
- The before side runs main's server with the CLI and dev client built from this checkout. If the
  change is in the CLI or in native iOS code, the before side shows the new client against the old
  server. Say so beside that evidence.
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
