# Security review

A review of [media] as the code runs: the core's Convex backend, the media service, the web
clients, the CLI, and the two installs. The media service signs in to the core as a service
principal and checks a caller with `core.auth.sessions.current` (ADR 0010); its byte routes admit
only core tickets, and it seals artwork keys under its own service key (ADR 0011). Each finding
says what the risk is, how the code meets it or why it stays, and where the evidence is.

## The Convex instance secret stays off command lines (2026-11-11)

The Convex backend takes its instance secret only as an argument, and `generate_key` derives the
admin key from the same argument. Any local process can read every process's arguments in
`/proc/<pid>/cmdline` (mode 0444), and the admin key gives full control of the core. The pinned
upstream image's entrypoint (`run_backend.sh`) and `generate_admin_key.sh` pass the secret as
that argument.

- **The image** runs both through `deploy/image/argv-secret.c`, an `LD_PRELOAD` shim that swaps an
  `@ARGV_SECRET_FILE` placeholder for the first line of a file before `main` runs, so the kernel's
  copy of the arguments, the one `/proc` shows, holds only the placeholder. It fails closed when
  the file is missing or empty.
- **The NixOS module** does the same. Started with the upstream entrypoint and
  `generate_admin_key.sh`, it would expose the secret to every local user of the host, since the
  container's processes show in the host's `/proc`. The Nix package builds the same shim
  (`lib/media/convex/argv-secret.so`, with no store path, so it loads into the
  container's own glibc). The module mounts it and `nix/convex-entry.sh` into the container, the
  entrypoint keeps the secret in `credentials/instance_secret` on the data volume (creating it on
  first start), and the setup runs `generate_key` through the shim with `podman exec -e`.
- **Evidence.** `scripts/check-convex-argv.sh` (Docker and Nix) runs the pinned image as the
  module does and checks that no host process's command line holds the secret while the
  backend's shows the placeholder, that the backend's environment holds only the file's path,
  and that the shim's `generate_key` gives an admin key the backend accepts. Run against the
  upstream entrypoint instead, the same `/proc` scan finds the secret. The NixOS VM test
  (`nix/vm-test.nix`, "the Convex instance secret is on no command line") checks the module itself
  on a host with KVM.

## Threat model

- One household, self-hosted on a LAN or a tailnet. The Compose install publishes its one port on
  `127.0.0.1` unless `MEDIA_BIND` says otherwise, and the NixOS module listens on `listenAddress`;
  a media service started directly without `HOST` listens on every interface. No port may face
  the internet (`docs/operations.md`).
- Attackers considered: a stranger who can reach the ports, a signed-in member probing for more
  than their account allows, a child on a shared device trying to leave a restricted account, a
  leaked or over-scoped API key, a hostile Jellyfin or Plex server during migration, crafted files
  in a library (names, links, NFO, media that targets ffmpeg), and someone who reads logs,
  telemetry, a backup, or the web bundle.
- Out of scope: a compromised host or Docker daemon, anyone holding the Convex admin key (it is
  root for the data), and network attackers between devices (plain HTTP; use a tailnet).

## Findings and fixes

| #   | Severity   | Finding                                                                                                                                                                                                                                                           | Fix                                                                                                                                                                                                                                                                                                                                                                      | Evidence                                                                   |
| --- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| 1   | High       | The media service read request bodies whole with no limit (Effect's default), before any check. A few large POSTs to `/api/playback/negotiate`, which needs no sign-in, exhausted its memory.                                                                     | A global middleware refuses bodies over 128 KiB (413) and chunked bodies (411); Node's parser enforces the declared length.                                                                                                                                                                                                                                              | `apps/media/src/http/hardening.ts`, `hardening.test.ts`                    |
| 2   | Medium     | The web app was served without a content security policy or hardening headers, with an inline script, while its Convex tokens live in `localStorage`, so any XSS would steal sessions.                                                                            | Every response carries a CSP (`script-src 'self'`, connections only to this origin and `CONVEX_PUBLIC_URL` (any `http:`, `https:`, `ws:`, or `wss:` host when that is unset), `frame-ancestors 'none'`, `object-src 'none'`), `nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, COOP, and a Permissions-Policy. The theme script is `public/theme.js`. | `hardening.test.ts`; the built app ran under the policy with no violations |
| 3   | Medium     | ffmpeg and ffprobe inherited the service's whole environment, including `CONVEX_SELF_HOSTED_ADMIN_KEY` and `MEDIA_SERVICE_API_KEY`. A media file that exploits a decoder would get the database.                                                                  | The tools run with `PATH`, locale, `TZ`, and the VA-API and oneVPL paths only.                                                                                                                                                                                                                                                                                           | `apps/media/src/media/media-tools.test.ts` runs `env` in place of ffprobe  |
| 4   | Medium     | One member could exhaust the server: remux and audio-only streams had no limit, and a remux ran ffmpeg at disk speed to the end of the file, so every play wrote most of its file into `TRANSCODE_DIR` within minutes (this also threatened ordinary 4K remuxes). | ffmpeg pauses (`SIGSTOP`) once it is `STREAM_BUFFER_AHEAD_SECONDS` (120) ahead of the player and continues when the player catches up.                                                                                                                                                                                                                                   | `apps/media/src/playback/stream-throttle.test.ts`                          |
| 5   | Low–Medium | `FileResolverUnavailable` sent the underlying error to the client, including the absolute path of the file (`FileSystem.stat (/mnt/nas/Movies/…): EACCES`).                                                                                                       | The error carries a fixed reason; the full error goes to the log.                                                                                                                                                                                                                                                                                                        | `apps/media/src/playback/file-resolver.ts`                                 |
| 6   | Low        | Outgoing requests followed redirects without re-checking the host, so the `image.tmdb.org` allowlist and the migration plugins' host guard could be walked to another host (SSRF), and a Plex token could follow a redirect.                                      | The service's HTTP client never follows redirects; a redirect is an unsuccessful response.                                                                                                                                                                                                                                                                               | `apps/media/src/http/outbound.test.ts`                                     |
| 7   | Low        | The scanner read an NFO that linked outside the library root and used it as the title's metadata. A link swapped in after the check remains (see Accepted).                                                                                                       | NFO files are read only when their real path stays inside the root.                                                                                                                                                                                                                                                                                                      | `library-scanner.test.ts` (fails without the fix with "Leaked Title")      |
| 8   | Low        | Playback checked a file's real path against `LIBRARY_ROOTS` and then opened the original path, so a link swapped in between could redirect ffmpeg. A folder swapped above the file remains (see Accepted).                                                        | Playback opens the canonical path it checked.                                                                                                                                                                                                                                                                                                                            | `apps/media/src/playback/file-resolver.ts`                                 |

## Verified without changes

- **Every public Convex function enforces its scope.** The generated wrapper of every command
  checks the caller's scope before the command runs (ADR 0009), and the core's stack suite tests
  access.
- **The media service key and user sessions stay apart:** only a service principal's API key holds
  `media-service`; no role allows it and no command a person calls requires it (ADR 0010).
- **Revocation ends derived sessions:** revoking a key, a session, or disabling an account ends its
  tokens on the next call and its playback sessions at once; the media service follows
  each session it serves through `sessionStatus` and refuses ended sessions with
  `PlaybackSessionEnded`.
- **Path traversal:** the web app's static route resolves inside `WEB_DIST_DIR` after links; HLS
  file names are `init.mp4` or `\d+.m4s` inside the stream's own folder; restore names must match
  `^[^./\\][^/\\]*\.zip$` and resolve inside `BACKUP_DIR`; the scanner follows links only inside
  the root and visits loops once; playback, sidecar subtitles, and local artwork are re-checked
  against `LIBRARY_ROOTS` on use.
- **Tickets:** every byte route admits only a core ticket and checks its key, purpose, resource,
  and expiry, at most six hours and never after its session (ADR 0011), so a ticket for one file
  or session cannot reach another's stream.
- **Scrub thumbnails** are served only to a ticket for their file, like the stream; the
  route takes a file ID, version, and name that must match `[0-9a-z]` IDs, a base-36 version, and
  `manifest.json` or `<n>.jpg`, and resolves inside `DATA_DIR/trickplay` (`trickplay.test.ts`,
  media stack test "reads chapters and makes scrub thumbnails").
- **Downloads** take a ticket with the download purpose: streaming routes refuse it and download
  routes refuse playback tickets (`wrong_purpose`; `downloads-http.test.ts`). A download
  queues at most one MP4, the MP4 being written reserves its space against streams, and a hung run
  fails after ten minutes without output. The MP4 route takes a file ID and a 24-hex-character
  name, must match the ticket's file, and serves only an MP4 the service finished for that file. A
  failure's detail never names a server path.
- **Artwork keys** are AES-256-GCM sealings under a key derived from the media service's own key. `?w=` takes a fixed list; cache names
  are hashes.
- **No user-supplied ffmpeg arguments or paths:** every spawn is built from server-side state; the
  audio track must match a probed track, the start offset is clamped, and nothing runs in a shell.
- **Media command routes** check the bearer token before reading the body and require the
  command's scope (`manage` for metadata search; `admin` for restore and migration), asking the
  core through `core.auth.sessions.current`.
- **Secrets:** the built web bundle holds no service key, admin key, or JWT key
  (searched the built web app for each value); logs and OTLP exports are redacted
  (`observability.test.ts`); backups are `0600` in a `0700` folder; the CLI config is `0600` in a
  `0700` folder, and an environment-only API key is never written to it.
- **Sign-in rate limiting:** Convex Auth refuses an account's password sign-ins with `rate_limited`
  after ten failures, even with the right password, for a while (tried against the dev stack).
  Every sign-in to the core also passes the media service's `/api/auth/sign-in`, which allows one
  client address 10 sign-ins at once, then one every 5 seconds, and relays each with a one-time
  pass; the core refuses a sign-in without one, so none reaches it over `/convex` (ADR 0007).

## Accepted, with reasons

- **CORS allows any origin** on the media service. Every call carries an explicit bearer token or a
  ticket and nothing uses cookies, so another site gains no ambient authority; a fixed
  list would break a separately hosted web app. `/api/health` (stream count, acceleration mode) is
  readable by anyone who can reach the port.
- **Tickets last up to six hours** and are verified offline; while the media service is
  disconnected from Convex it cannot learn of revocations.
- **Rate limiting in the media service covers only the routes without a token.** `/artwork/*`
  (600 requests at once, then 100 per second) and `/api/health` (60, then 10 per second) have a
  token bucket per client address and answer `429` with `Retry-After` beyond it. Behind a reverse
  proxy every client shares the proxy's address, and forwarded headers are not trusted, so the
  budget is shared there. Token routes are not limited: tokens are 256-bit HMACs, so guessing is
  not the risk, and the body cap, per-account device limit, transcode and remux limits
  (`MAX_CONCURRENT_TRANSCODES`, `MAX_CONCURRENT_REMUXES`), at most two subtitle conversions and two
  artwork resizes at once, a 20 MB cap and 30-second limit on artwork downloads, and throttling
  bound the cost of abuse.
- **Lockouts can be triggered by others:** ten wrong passwords lock that account's password sign-in
  for a while.
- **`MEDIA_SERVICE_API_KEY` is a Convex deployment variable** (so `configure.ts` can reuse it), which
  means the Convex admin key can read it and therefore open stored migration credentials. The admin
  key already controls all data; exports do not include deployment variables.
- **Segments behind the player stay until the stream closes,** so a stream watched to the end still
  holds about its file's size in `TRANSCODE_DIR`, and free space is checked only when a stream
  starts. Size `TRANSCODE_DIR` for the largest remux you play.
- **The Cast SDK's scripts** come from `www.gstatic.com`, which the content security policy allows
  for scripts, without a scheme: Google's loader fetches its framework over the page's own scheme,
  so an install served over plain HTTP loads it over HTTP, open to anyone on the path to Google.
  Serve [media] over HTTPS (Tailscale Serve, a reverse proxy) to keep it on HTTPS; browsers other
  than Chromium never load it.
- **First-time subtitle conversions are not de-duplicated:** two requests for the same track
  before it is cached convert it twice (at most two conversions run at once). Keyframe scans are
  shared by everyone waiting on the same file.
- **Check-then-open races in the library.** Paths are checked by their real path and then opened
  by name (ffmpeg opens files itself), so someone who can write to a library folder can swap a
  folder for a link between the two. Libraries are mounted read-only to the service, and whoever
  can write them already controls what is played.
- **Registering a library folder** starts a recursive file watch before the folder's first scan
  checks it against `LIBRARY_ROOTS`; only admins can do this, and the scan then fails.
- **Third-party requests for metadata and trailers.** OMDb (with `OMDB_API_KEY`) learns the IMDb
  IDs of the library's titles; the key travels in its query string, so OMDb requests record no
  client span. The CSP's only frame source is `https://www.youtube-nocookie.com`, which a viewer's
  browser contacts only when they open a trailer; its iframe sends the page's origin as referrer
  (YouTube refuses embeds without one), never a path. Person details are queued by `read`
  sessions (`people.requestDetails`), at most one job per person every six hours.
- **Dependency audit** (`pnpm audit --prod`): one high, `braces` ≤ 3.0.3 (stack exhaustion on
  deeply nested glob patterns), reached only through the `shadcn` CLI's globbing at development
  time; no patched release exists. Nothing else.

## How to repeat this review

The generated wrapper of every command checks its scope (ADR 0009), and the core's stack suite
tests access.

```sh
scripts/dev-stack.sh destroy && scripts/dev-stack.sh up
pnpm --filter @media/platform test:stack   # the core's stack suite
pnpm test                                     # hardening, outbound, media tools, throttle, scanner
pnpm audit --prod
VITE_PLATFORM_URL=http://127.0.0.1:<core-port> pnpm --filter @media/web-movies build && grep -rlF "<secret value>" apps/web-movies/dist
curl -sI http://127.0.0.1:<media-port>/       # security headers
```
