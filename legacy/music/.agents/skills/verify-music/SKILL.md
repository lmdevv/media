---
name: verify-music
description: Run disposable [music] servers (the real image, with Convex, the media service, the scanner, and audio) built from this checkout and from main, then drive the web app in Chromium, the `music` CLI, and the iOS app on a Mac simulator to prove a change works the way a user sees it. Captures before/after screenshots and H.264 videos and publishes them to the PR description. Use to verify a web, CLI, backend, media, or iOS change end to end, to reproduce a user-facing bug, or to put visual evidence on a PR.
---

# Verify [music]

This skill runs the real product: the all-in-one image from `deploy/docker/Dockerfile`, with a
music library mounted at `/music`. A run has two sides, each its own server:

- `after` is an image built from this checkout. It is the default side for every command.
- `before` is `ghcr.io/lmdevv/music:main`, the last image published from main.

You drive a side through three surfaces: a Chromium that stays open between commands, the built
`music` CLI signed in with an API key, and the iOS app on a simulator on the Mac `darwin`. Run
every command from the repo root. `S` is shorthand for the helper:

```sh
S=.agents/skills/verify-music/scripts/verify-music.sh
```

Your shell may not keep variables between tool calls. Spell out the full path, or set `S` in the
same command.

## Isolation

`MUSIC_VERIFY_RUN` names a run and defaults to the checkout's directory name, so two worktrees get
two runs on their own. Each side of a run owns these resources and nothing else:

| Resource  | Name                                                                 |
| --------- | -------------------------------------------------------------------- |
| Container | `music-verify-<run>-<side>`, labeled `music.verify.run=<run>`        |
| Volume    | `music-verify-<run>-<side>-data`                                     |
| Image     | `music:verify-<run>`, built by `up` for the after side                |
| Port      | A free loopback port chosen at `up`, with `PUBLIC_URL=http://localhost:<port>` |
| State     | `${TMPDIR:-/tmp}/music-verify/<run>/<side>/` (the API key, pids, logs) |
| Simulator | `music-verify-<run>-<side>` on `darwin`, made by `ios up`            |
| Evidence  | `captures/verify/<run>/`, gitignored and kept after `down`           |

Never drive anything not named `music-verify-*`. The owner's `music` and `music-ios-dev`
containers, their home lab server, and the dev backend from `scripts/dev-backend.sh` hold real
data. `dev-backend.sh` also rewrites the `.env.local` files that the owner's `pnpm dev` reads, so
this skill never calls it.

## Launch

Prerequisites: Docker, Node 24, pnpm, `pnpm install` done in this checkout, and ffmpeg. On NixOS
the helper uses the system Chromium on its own, since Playwright's bundled one does not run.

```sh
$S up                  # the after side: build the image from this checkout
$S up --side before    # the before side: pull ghcr.io/lmdevv/music:main
```

`up` does these steps in order:

1. It builds `music:verify-<run>` from the checkout, or pulls the main image for `before`. A warm
   Docker cache builds in about 50 seconds; a cold one takes several minutes.
2. It mounts the library read-only at `/music`. The default is the demo library image named in
   `deploy/demo-library/image` (see [Demo data](#demo-data)), which `up` pulls once per machine.
3. It starts the container and waits until `/healthz` reports `"ok":true`, which needs Caddy, the
   media service, and Convex.
4. It starts the browser host and runs first-run setup through the web app. Setup creates the
   admin `admin@music.local` with password `password123`, adds `/music`, and waits for the real
   scan to finish.
5. It creates an API key at `/settings/keys` and checks that the CLI signs in with it.
6. It seeds the demo people and their playlists, likes, and sharing (`seed.mjs`).

The side is ready only after a line like this prints:

```text
ready: http://localhost:39513 (run verify-music, side after, container music-verify-verify-music-after, image music:verify-verify-music, library ghcr.io/lmdevv/music-demo-library:v1, evidence …)
```

| Flag                           | Use                                                              |
| ------------------------------ | ---------------------------------------------------------------- |
| `--side before`                | Start the main side for a before/after comparison                |
| `--image IMG`                  | Run another image, such as a release tag, instead of building    |
| `--library demo\|fixtures\|DIR` | Pick the library. A DIR must be readable by others (`a+rX`)      |
| `--port N`                     | Pin the port                                                     |
| `--no-seed`                    | Stop after setup: only the admin, with no playlists or likes     |
| `--no-setup`                   | Leave a fresh server, to verify first-run setup itself           |

The image holds the checkout as it was at `up`. After you change code, run `down --side after`
and `up` again. `doctor` fails when the checkout has moved on since the build; commits that only
touch `.agents/` don't count, since the image leaves them out.

### Demo data

Every side starts from the same data, so evidence from any machine looks alike and shows nothing
personal or unlicensed.

- **Music.** `ghcr.io/lmdevv/music-demo-library:v1` holds the five Creative Commons releases of
  `scripts/download-demo-music.sh` (28 songs, 520 MB, two FLAC EPs) and their `CREDITS.md`. It's a
  data-only image that every container mounts read-only, so Docker keeps one copy per machine. A
  published version never changes; `scripts/build-demo-library.sh` builds it, and the Demo library
  workflow publishes the version in `deploy/demo-library/image`. When the pull fails, build it
  locally with `scripts/build-demo-library.sh`.
- **People.** Everyone's password is `password123`:

  | Who   | Email               | Role   | CLI          |
  | ----- | ------------------- | ------ | ------------ |
  | Lucía | `admin@music.local` | owner  | `$S cli --`  |
  | Mateo | `mateo@music.local` | member | `$S cli --as mateo --` |
  | Aiko  | `aiko@music.local`  | member | `$S cli --as aiko --`  |
  | Sam   | `sam@music.local`   | guest  | none: guests can't make API keys |

- **Library access.** `/music` is shared, so members play it. Sam plays it through a grant.
- **Playlists.**
  - Lucía's `Sunday morning` (4 songs) is shared with Mateo as a collaborator, and with Aiko and
    Sam as viewers.
  - Lucía's `Deep focus` (4 songs) and Aiko's `Waltzes` (2 songs) are private.
  - Mateo's `Lossless` (the 7 FLAC songs) is shared by link.
- **Likes.** Lucía likes `Wanderer`, `Doppelgänger`, and `Hoist`. Mateo likes `Drifting Cargo`.
  Aiko likes `Neptune` and `Naughty Waltz`.

Sign a page in as anyone with `$S browser sign-in --page mateo --email mateo@music.local`.
`--library fixtures` generates 4 albums of short chords instead. It needs no download, but the seed
needs the demo songs, so pair it with `--no-seed`.

## Doctor

Run `$S doctor [--side S]` first, and again whenever anything looks off. It is read-only, prints
one line per check, and exits non-zero on any `FAIL`:

- The container runs, belongs to this run, and owns its port.
- `/healthz` is ok.
- The container runs the image that `up` recorded.
- Init deployed this build: `/data/build` matches `/app/build-id`.
- The browser host answers.
- The API key signs the CLI in as the admin.
- For the after side, the image matches the checkout.

The `info` line names the version, build, and image. The `before` side's build often differs from
the checkout even when the code matches, because the `:main` tag moves only when the Image
workflow publishes. `$S logs [--side S] [N]` shows the container's last lines, where init, Convex,
the media service, and Caddy all log. `$S status` lists the sides and simulators that are up.

When `up` failed partway, or `doctor` reports a run you don't recognize, run `$S down` and start
again.

## Drive

### Browser

`$S browser [--side S] <command> [flags]` sends one action to the open Chromium and prints the
result. A failed action exits 1 with Playwright's message. URLs are paths on the side's server.

Name an element with exactly one of these flags, the way the app's ARIA tree names it:

- `--role R [--name N] [--exact]` is preferred.
- `--label L`, `--text T`, or `--testid ID`.
- `--css S` is the last resort, for elements with no accessible name, such as `#search-input`.

Scope with `--in role[=name]`, such as `--in region=Player` or `--in main`. Pick one of several
matches with `--nth K` (from 0). Without `--nth`, a locator that matches several elements fails.
Names match by substring unless you pass `--exact`: `Play` without it also matches `Play Dawn`.

| Command                                         | Does                                                        |
| ----------------------------------------------- | ----------------------------------------------------------- |
| `open [path]`                                   | Full page load. Prints the URL                              |
| `click`, `hover`                                | Acts on the element                                         |
| `fill --value V`                                | Replaces a field's value                                    |
| `type --value V`                                | Types into whatever has focus, such as a dialog's field     |
| `press --key K` (optionally with a locator)     | Presses a key on the page or on the element                 |
| `wait <locator> [--hidden]`, `wait --url RE`    | Waits up to 30 s (`--timeout ms`)                           |
| `text`, `count`, `attr --attr A`                | Reads the element                                           |
| `snapshot [locator] [--path F]`                 | Prints the ARIA tree, and saves it with `--path`            |
| `screenshot --path F [--full]`                  | Waits for the covers in view, then saves a PNG of the page or element |
| `audio`                                         | Prints `{"playing","seconds","elements"}` from real media   |
| `wait-audio --past S` or `--advance S`          | Waits until real audio plays past S, or S more seconds      |
| `record-start --path F.mp4 [--show-actions]`    | Records the page to an H.264 MP4                            |
| `record-stop`                                   | Finishes the recording and prints its path                  |
| `sign-in [--email E --password P]`              | Signs the page in through `/sign-in`, as the admin by default |
| `join --code C --name N --email E`              | Makes an account from an invite at `/invite/<code>`         |
| `url`, `pages`, `close-page`, `eval --js`       | Inspects the session, or closes a page and its recording    |
| `restart`                                       | Restarts the host after `browser.mjs` changed; signs `main` in again |

`--page NAME` (default `main`) picks a browser context, which the app sees as its own device with
its own sign-in. The first command that names a new page creates it. On that first command,
`--device "iPhone 15"` (any Playwright device name) makes it a phone, `--width W --height H` sets
the window, and `--dark` sets the system dark mode, which the app follows. Only `main` is signed
in by `up`, so start a new page with `sign-in`, as in `$S browser sign-in --page phone --device
"iPhone 15" --dark`.

When you don't know an element's name, run `$S browser snapshot --in main` and read the names
from the tree.

### CLI

`$S cli [--side S] [--as mateo|aiko] -- <args>` runs `apps/cli/dist/music.js` against the side's
server as the admin, or as a seeded member. Add `--json` for stable output. Exit codes: `0` ok, `1` failed, `2` usage, `3` auth.
`$S cli -- --help` lists every command. The CLI is built from this checkout, so on the before
side it talks to main's server: a command that is new in the checkout fails there.

### iOS simulator

The iOS app runs on a simulator on `darwin` (set `MAC_HOST` for another Mac). Its JavaScript comes
from a Metro on this machine. For the before side, Metro serves a main checkout that `ios up`
makes with `git worktree` under the side's state. The simulator reaches the side's server as
`localhost:<port>` through an ssh forward, so the address matches the server's `PUBLIC_URL`.

```sh
$S ios up [--side S] [--device "iPhone 17 Pro"] [--dark]
```

`ios up` needs the side to be up with setup. It does these steps in order:

1. It forwards the server and Metro ports to the Mac.
2. It starts Metro.
3. It creates and boots the simulator `music-verify-<run>-<side>`.
4. It installs the dev client. The first run builds it on the Mac from this checkout through
   `scripts/ios-mac.sh build-sim`, which takes several minutes. Later runs reuse
   `~/music-ios/dd-verify-<run>` there.
5. It turns off the dev client's own UI (its first-launch introduction, its floating button, and
   the gestures that open its menu), so screenshots show only the app.
6. It opens the app on Metro, connects to the server, and signs in as the admin.

It prints `ready: ios <side> on simulator <udid>` when the app shows Home. A warm run takes
about two minutes. Then:

| Command                                          | Does                                                    |
| ------------------------------------------------ | ------------------------------------------------------- |
| `ios describe`                                   | Prints the screen's accessibility tree: `label = value \| type \| x,y wxh` |
| `ios find <label>`                               | Prints where `ios tap --label` would tap                |
| `ios tap --label L` or `--id ID` or `-x X -y Y`  | Taps an element by its exact accessibility label or id, or a point |
| `ios type <text>`                                | Replaces the focused field's text                       |
| `ios sign-in`                                    | Connects and signs in again from the welcome or sign-in screen |
| `ios swipe <x1> <y1> <x2> <y2>`                  | Swipes, in points                                       |
| `ios wait <label> [seconds]`                     | Waits until the label appears in the tree               |
| `ios shot <path.png>`                            | Saves a screenshot                                      |
| `ios record start <path.mp4>`, `ios record stop` | Records the screen to an H.264 MP4                      |
| `ios appearance light\|dark`                     | Switches the system appearance                          |
| `ios remote play\|pause\|toggle\|next\|previous` | Sends what the lock screen and headphones send          |
| `ios doctor`                                     | Checks the forward, Metro, the simulator, and that the Mac reaches the server |
| `ios down`                                       | Removes this side's simulator, Metro, and forward       |

Read labels from `ios describe` before you tap; never guess coordinates. A label is the whole
accessibility label: an album card is `Vienna Blue, Doc & Lena Selyanina`, not `Vienna Blue`.
When several elements share a label, `ios tap --label` picks a field or button over plain text,
then the first on screen. Every `ios` command takes `--side S`.

## Evidence

Evidence lives in `captures/verify/<run>/`, under `before/` and `after/`, and survives `down`.
Proof standards:

- Drive the real user path: the UI, the CLI, or the simulator. Never internal setters, direct
  Convex calls, or test-only endpoints.
- Capture the action and the resulting state, not just the final screen. A recording or a
  screenshot plus an ARIA snapshot (`snapshot --path`) or an `ios describe` dump.
- Verify the side effect behind what's visible: real audio with `wait-audio`, stored data with
  `$S cli -- <command> --json`, or files in the container with `docker exec`.
- For a change, capture the same journey on both sides, at the same size, theme, and data. The
  before side is the parent's behavior; a difference you can't explain is a finding.

### Put it on the PR

A PR that changes what a user sees ships before and after screenshots of each changed screen, at
desktop and phone size for the web, and a short video of the changed flow. A new screen has only an
after. Add each pair to the run's manifest, then publish. The manifest outlives `down`, so start
each PR with `evidence clear`, which empties it and keeps the files:

```sh
$S evidence clear
$S evidence add --label "Album page, desktop" --before captures/verify/<run>/before/album.png --after captures/verify/<run>/after/album.png
$S evidence add --label "Play an album on a phone" --after captures/verify/<run>/after/play.mp4
$S evidence list
$S evidence publish --pr <number> --dry-run   # print the block, attach nothing
$S evidence publish --pr <number>
```

`publish` turns every video into an H.264 MP4 under 10 MB, which is GitHub's limit for an image
and, on a free plan, for a video. It writes a `## Screenshots and video` block between
`<!-- verify-music:start -->` and `<!-- verify-music:end -->` and leaves the rest of the PR
description alone. It runs `gh pr edit --attach`, which uploads each file to
`github.com/user-attachments` and rewrites its local path. It then reads the description back and
fails if a `./captures/` path is left. Publishing again replaces the block. To check an upload,
fetch it with `curl -sL`: the asset redirects to a signed S3 URL that answers `HEAD` with 403 and
`GET` with 200. The repo is public, so anyone with a link can open an upload. Never capture
secrets: the `/settings/keys` screen right after creating a key, a reset link, or an invite code.

## Cleanup

```sh
$S down                 # both sides: simulators, Metro, forwards, browser hosts, containers, volumes, the built image
$S down --side before   # one side
$S down --purge         # also remove the iOS build cache on the Mac (~/music-ios/verify-<run>, dd-verify-<run>)
```

`down` stops only what this run started, by pid and by name. It never kills by process name.
Evidence in `captures/verify/<run>/` stays. Clear it yourself when you no longer need it.

## Helpers

- `scripts/verify-music.sh` is the entry point for everything above. `$S` with no command prints
  its usage.
- `scripts/browser.mjs` is the browser host that `up` starts and `browser` talks to. Run it
  directly only to debug the host. Its log is `${TMPDIR:-/tmp}/music-verify/<run>/<side>/browser.log`.
- `scripts/evidence.mjs` keeps the manifest and publishes it. `$S evidence` calls it.
- `scripts/seed.mjs` creates the [demo data](#demo-data) after setup. `up` calls it.

## Feature map

`features/README.md` indexes what the app does and what proves each feature works. Read the
feature's file before you drive it, and add to the map when a change adds a feature.

## Gotchas

- `--show-actions` draws a pointer and step titles on the page while a recording runs, and they
  also show in screenshots taken then. Take stills outside a recording.
- A recording runs in real time, and scripted steps finish in about a second, too fast to follow.
  Pause a second or two after each step's result (`sleep 2` between commands) and before
  `record-stop`, so a reviewer sees each state. A still page holds its last frame.
- The app scrolls inside its own panels, not the page, so `screenshot --full` captures only the
  window. To show something below the fold, screenshot its element, which scrolls it into view.
- A shortcut key such as `n` or `/` types into a focused field instead. Open a page where focus is
  outside fields, such as an album, before you press it.
- The before side runs main's server with the CLI and dev client built from this checkout. If the
  change is in the CLI or in native iOS code, the before side shows the new client against the old
  server. Say so beside that evidence.
- The simulator shares the Mac's network. `localhost` there is the Mac, reached through the ssh
  forward. Without the forward the app shows that it can't reach the server.
- Metro started with `CI=1` stops watching files, and the app keeps the old bundle. `ios up` does
  not set it; don't add it.
- The first touch after the app signs in is dropped (cause unknown). `ios up` and `ios sign-in`
  spend it on the page title. If you sign in another way, tap something harmless first.
- `ios type` pastes through the simulator's pasteboard and replaces the field's text: AXe's own
  typing drops characters in the app's fields. It sends US keyboard characters only.
- `ios record` captures the whole screen at device resolution (1206x2622 on an iPhone 17 Pro).
  `evidence publish` shrinks a clip over 10 MB to 720 pixels wide; keep iOS clips under a minute.
