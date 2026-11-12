# Implementation decisions

Concrete choices in the code as it runs now: the core's Convex project (`packages/platform`), the
media service (`apps/media`), the SDK, and the movies clients. The decisions behind them are the
ADRs in `docs/decisions/`; this file records the details they leave out. Update it in the same PR
that changes one.

Old movies' Convex project, its SDK client, and its command registry were deleted in
`p4-movies-delete` (ADR 0028). They stay readable in git history for parity checks.

## Tickets

- Every byte route takes one signed ticket (ADR 0011). `@media/contracts/ticket` signs and
  verifies, with no imports, so the core's Convex functions and the media service load the same
  file; `@media/contracts/ticket-vectors` pins its bytes. Keys are `MEDIA_TICKET_KEYS`, on the core
  deployment and on the media service.
- `movies.play.start` issues a personal `play` ticket for one file, and `core.downloads.fetch` a
  `download` ticket. Artwork paths in movies results carry a shareable `image` ticket
  (`packages/platform/convex/movies/artwork.ts`). There is no renewal: a client starts again.
- A ticket travels in the `ticket` query parameter, because `<video>` and HLS segment fetches
  cannot set headers. Negotiation, seeks, stops, downloads, and player diagnostics carry it in the
  request body's `token` field. Logs redact it.
- A refused ticket is `PlaybackTokenInvalid` (401) with a reason, and an ended session is
  `PlaybackSessionEnded` (410). Both are in `@media/contracts/media-playback`. The media service
  admits tickets in `apps/media/src/core/core-tickets.ts` and watches each session through
  `core/tickets:sessionStatus`.

## Roles, scopes, and access

- Roles are `owner`, `admin`, `member`, and `guest` (ADR 0003, ADR 0005). Credential scopes are
  `account`, `admin`, and each content domain's `read`, `play`, and `edit`, such as `movies:read`
  (`packages/commands/src/scopes.ts`). `media-service` is held only by a service principal's key.
- Every access decision is `can(principal, action, resource)` in
  `packages/platform/convex/core/permissions/policy.ts`, which reads no database. Movies commands
  load a title's facts and ask it (ADR 0005, "Movies commands").
- Kids are restricted users, not profiles (ADR 0005). A person's progress, history, and list are
  theirs, keyed by user.

## Commands

- `packages/commands` declares every Convex function once, with its scope, `v` validators, and
  summary (ADR 0009). The generator writes each function's wrapper, which checks the scope on every
  call, and the SDK's and CLI's commands.
- The media service's own HTTP commands are declared in `@media/contracts/media-commands`:
  `libraries.folders`, `metadata.searchCandidates`, `backups.restore`, `imports.connect`,
  `imports.preview`, `imports.start`, `diagnostics.playback`, and `diagnostics.sessions`. Each names
  its route, access level, and Effect Schema args and result. `commandRoute` in
  `apps/media/src/http/command-routes.ts` registers a handler for one.
- A media command's caller sends their core session's Convex auth token as a bearer token. The
  media service asks the core with it through `core/auth/sessions:current`, so an ended session is
  refused at once, and maps the access level onto the core's scopes: `read`, `play`, and `manage`
  need `movies:read`, `movies:play`, and `movies:edit`; `admin` needs an owner or admin whose
  session holds `admin` (`apps/media/src/core/core-callers.ts`).
- Expected failures travel as `{ code, message }` with the codes in `@media/contracts/errors`.
  Convex throws them as `ConvexError`, and the media service answers with the same body.

## The media service and the core

- Convex never calls the media service. The media service signs in as its service principal with
  its key (ADR 0010), subscribes to what it needs, and calls the server functions declared in
  `@media/contracts/server-functions`, which only the `media-service` scope reaches.
- It signs in again with capped exponential backoff (0.5 to 30 seconds) while the core is down or
  refuses the key (`apps/media/src/core/core-session.ts`).
- Jobs run through the core's job framework (ADR 0012). The media service claims with a 60-second
  lease, renews every 15 seconds with its progress, and stops a job's work when a renewal answers
  canceled or lost.
- Scans: a `full` scan reads every file again; a `quick` one skips files whose size and
  modification time did not change; watchers and the periodic reconciliation are quick. Local
  disks are watched with file events. Network file systems (NFS, SMB/CIFS, 9p, FUSE, found with
  `statfs`) send none for changes made elsewhere, so `LIBRARY_WATCH=auto` polls them every
  `LIBRARY_POLL_SECONDS`, one `stat` per folder, reading a folder again only when its modification
  time moved. A file rewritten in place leaves its folder's time alone, so such an edit waits for
  the reconciliation. Extras such as trailers and featurettes are not stored.
- Library folders are written down one way (`@media/contracts/library-folder`). Libraries, their
  folders, and their scans are ADR 0024.

## Media playback API

- The media service's HttpApi lives in `@media/contracts/media-api`; its routes, request and
  response schemas, and tagged errors live in `@media/contracts/media-playback`, which uses only
  stable Effect modules. Contracts allow the unstable `effect/http-api` module for the definition
  alone. The SDK does not import the HttpApi: it posts with `fetch` and decodes the shared schemas
  (with their JSON codecs: absent optional fields arrive as `null`) and tagged errors.
- `Playback.recoveryFor` maps each failure to what a player does: `StreamGenerationGone` → load
  the current playlist (`seekStream`), `StreamNotFound` → negotiate again, `PlaybackTokenInvalid`
  with `expired` → start again with a new ticket, `PlaybackSessionEnded` → start again, busy or
  briefly unavailable (`TranscodeCapacityReached`, `InsufficientTranscodeSpace`,
  `FileResolverUnavailable`, `SegmentNotReady`, transport) → retry later, `UnsupportedPlayback`
  → tell the viewer.
- Playback modes are one vocabulary everywhere: `direct`, `remux`, `audio-transcode`,
  `transcode-qsv`, `transcode-vaapi`, `transcode-software`.
- GPU encoders: `HARDWARE_ACCELERATION=auto` test-encodes with Quick Sync, then VA-API, and uses
  the first that works; `qsv` and `vaapi` trust the setting. A GPU run that fails marks that
  encoder unavailable for the process and the session continues in software. HDR is tone-mapped
  to SDR on the GPU (`vpp_qsv`, `tonemap_vaapi`) or in software with `zscale` and `tonemap` when
  the ffmpeg build has them; without either, HDR that the client cannot display is refused.
- A stream's ffmpeg pauses (`SIGSTOP`) once its output runs `STREAM_BUFFER_AHEAD_SECONDS` (120)
  past the furthest segment the player asked for, and continues (`SIGCONT`) when the player is
  within half of that. A remux copies at disk speed, and without the pause every play wrote most of
  its file into `TRANSCODE_DIR` within minutes. Segments behind the player stay until the stream
  closes, so a stream watched to the end still holds about the file's size.
- Starting fast: the eight seconds from where a session starts are cut into short segments (1, 1,
  2, 2, and 2 seconds on a transcode's 4-second grid; one keyframe each for a copy), and the plan
  returns to its normal length after them; the plan is fixed for the session. Negotiation answers
  as soon as ffmpeg is started, so the player loads hls.js, the playlist, and the init segment while
  the first segment is encoded; only a hardware encode waits for its first segment, since a failure
  there falls back to software and changes the mode the answer names.
- Keyframes for copies come from the container's own index (Matroska Cues, MP4 sample tables) in
  a few reads, else from an ffprobe packet scan of the whole file, cached on disk. Negotiation
  waits at most two seconds for a scan; past that it encodes when the client can take an encode,
  and the scan finishes in the background for the next negotiation.
- Picture subtitles (PGS, VobSub) are listed in negotiation without a URL. A client shows one by
  negotiating again with `burnInSubtitle`, which always transcodes: the picture is scaled and
  tone-mapped as usual (on the GPU when one encodes), then the subtitle, its canvas scaled to the
  output size (DVD subtitles carry none and are read on a 720x576 canvas), is drawn on the SDR
  frame on the CPU; a GPU's frames are downloaded for that and uploaded again to encode. After a
  seek the subtitle comes from a second reading of the file from 30 seconds earlier, so a line
  already on screen is drawn. Choosing a text subtitle or none negotiates again without it, back to
  the cheaper mode.
- A client may send a quality cap (`maxHeight`, `maxBitrate` in bits per second). A source above
  it is encoded down to the cap; one within it plays as before, and so does one the host cannot
  encode (HDR without tone mapping), rather than not at all.

## Artwork

- Titles, seasons, and episodes store artwork keys: `a1.<base64url(iv ‖ ciphertext ‖ tag)>`, an
  AES-256-GCM sealing of where the image lives (an absolute path inside a library folder, or a
  TMDB image URL). The IV is an HMAC of the reference, so sealing is deterministic and rescans do
  not churn. Both keys derive from the media service's own service key, with their own labels
  (`apps/media/src/artwork/artwork-keys.ts`). A new service key invalidates artwork keys until the
  next scan or metadata refresh writes new ones.
- Movies results carry `/artwork/<key>?ticket=<ticket>`, with a shareable `image` ticket for
  `artworkTicketId(key)` (ADR 0011). A client loads the media service's base URL plus that path,
  adding `&w=` one of 185, 342, 500, 780, 1280 (`ARTWORK_WIDTHS` in `@media/contracts/artwork`). A
  key can only name an image the service sealed itself, so the route cannot be pointed at other
  files and URLs reveal no folder names. Local images are re-checked against `LIBRARY_ROOTS`;
  remote images are fetched only from `image.tmdb.org` and cached under `DATA_DIR/artwork`; resized
  copies are JPEGs made with ffmpeg and cached by source, size, and modification time.

## Rich metadata

- Sources, in order: the NFO (Kodi/Jellyfin `<actor>`, `<director>`, `<credits>`/`<writer>`,
  `<studio>`, `<country>`, `<tag>`, `<ratings>`, `<uniqueid>`, `<set>`, `<trailer>`, `<status>`),
  then OMDb for IMDb, Rotten Tomatoes, and Metacritic scores (`OMDB_API_KEY`, by IMDb ID), then
  TMDB. NFO values win field by field; for cast and crew the NFO's list of a kind (actors,
  directors, writers) replaces TMDB's, and each NFO person is matched to TMDB's credit of the same
  name for a TMDB ID and photo. TMDB alone supplies creators, producers, and composers. A library
  without a TMDB key gets everything its NFO files state.
- TMDB: one details request per title with `append_to_response` (credits or `aggregate_credits`
  for shows, keywords, videos, recommendations, similar, release dates or content ratings, external
  IDs), one per season (guest stars and episode crew come with it), one per collection, and one per
  person. Requests time out after 20 seconds, share a 20 per second budget, and are cached on disk
  for a week; OMDb answers for a day, so scores refresh at most daily, and OMDb is not asked again
  for an hour after it refuses the key (wrong, or over the free tier's daily limit). Without a key
  either provider is simply absent.
- The media service writes metadata through the server functions `movies.metadata.apply`,
  `movies.metadata.applyCredits`, and `movies.metadata.applyCollection`, and a person's details
  through `movies.people.apply`. Opening a person page calls `movies.people.requestDetails`, which
  asks for a person's details at most once every six hours.
- Trailers: the official YouTube trailer from TMDB videos, or a YouTube ID or URL in the NFO
  `<trailer>`. The web app embeds `youtube-nocookie.com` only. Local trailer files stay unstored
  extras.

## Scrub thumbnails and chapters

- A `movies.trickplay` job per file makes its scrub thumbnails. With `TRICKPLAY=off` the media
  service runs none; they wait, and run once it is on.
- Generation is one ffmpeg run on one thread at the lowest CPU priority: keyframes only
  (`-skip_frame nokey`), one frame per `TRICKPLAY_INTERVAL_SECONDS` (10) taken as the last
  keyframe at or before each tick (`fps` with `round=up` and `start_time=0`; ffmpeg 6 emits nothing
  for clips shorter than one interval without it), counted as ffmpeg picks them so a video shorter
  than its container leaves no black tiles, 320 pixels wide by the display aspect ratio, HDR
  tone-mapped when ffmpeg has `zscale`, tiled 10 × 10 into JPEG sheets. A two-hour film takes about
  23 s and 3.8 MB (measured on a 32-thread desktop, Sintel looped to 1 h 58 min). Trickplay jobs
  have their own worker slots (`TRICKPLAY_CONCURRENCY`, 1).
- Sheets live in `DATA_DIR/trickplay/<fileId>/<version>/` with `manifest.json`; the version is the
  file's size and modification time in base 36, so a replaced file never shows old frames. A new
  version is built in a hidden folder and renamed into place. A job reads the file's size and time
  again after ffmpeg and drops its sheets if they changed. The job records its manifest with
  `movies.trickplay.record`. A sweep deletes folders the catalog no longer names
  (`movies.trickplay.versions`).
- Players read the manifest from `MediaFile.trickplay` and load
  `/media/trickplay/<fileId>/<version>/<n>.jpg` with the playback's ticket. Frames are content, not
  artwork: they are authorized like the stream. Responses are `private, max-age=31536000,
  immutable`: the version changes with the file.
- Chapters come from ffprobe (`-show_chapters`), measured from the first frame, clipped to the
  file's length, without empty markers.

## Casting and system controls

- The movies web client does not cast since the movies cutover; casting returns through the core's
  Connect (ADR 0018). `@media/contracts/cast` keeps the Chromecast client profile the media
  service's negotiation is tested with, and the content security policy still allows Google's Cast
  sender scripts from `www.gstatic.com` (`apps/media/src/http/hardening.ts`).
- Safari plays HLS natively (hls.js is never used there), so its own AirPlay works on the
  `<video>` element.
- The Media Session API publishes what plays and handles play, pause, seek backward and forward,
  seek to, and previous and next episode (`apps/web-movies/src/playback/use-media-session.ts`).
  Picture in picture uses the standard API, or Safari's presentation modes.

## Playback and progress

- `movies.play.start` decides one file and issues its ticket (ADR 0005, "Playback"). Each start
  answers a fresh `playbackId` and its start time; each `movies.play.report` carries both, and a
  report from a playback that started before the one that last reported changes nothing, so a
  second tab cannot drag a newer position back.
- Reaching 90 percent of the duration, or reporting `ended`, marks the item watched
  (`packages/platform/convex/movies/viewing.ts`).
- Versions: `movies.titles.versions` lists a movie's or an episode's files, best quality first.
  The SDK's `Versions.preferredVersion` orders a client's list the same way. Direct play is decided
  by `@media/contracts/direct-play`, which the media service's negotiation, the SDK, and the
  clients use. The web player switches versions with a new start at the same position and play
  state.

## Downloads

- Who may download, each device's list, storage caps, and expiry are the core's
  `core.downloads.*` (ADR 0019). `core.downloads.fetch` issues the `download` ticket.
- `POST /api/downloads/prepare` takes the ticket, the device's capabilities, a quality
  (`standard`: 720p and 4 Mb/s; `high`: 1080p and 10 Mb/s, the players' presets), and an optional
  audio track. It answers `Ready` at once when the device opens the original file within the
  quality (MP4 or QuickTime, decodable streams, the default audio), with the existing
  `/media/direct` URL. Anything else becomes an MP4 by the playback ladder: the video copied when
  the device decodes it within the quality, else encoded to H.264 in software; the audio copied
  when the device decodes it, else stereo AAC; `+faststart` so AVPlayer opens it at once. Until it
  is written, prepare answers `Preparing` with progress (the tail of ffmpeg's `-progress` output)
  and an upper bound on the size (the encode's rates, with copied audio counted at 1.6 Mb/s), and
  the app asks again. Unlike playback, the quality is a limit: a source this host cannot bring
  within it (HDR without tone mapping) is `UnsupportedPlayback`, never the full-size original.
  Text subtitles come as the existing WebVTT URLs; picture subtitles are not downloaded.
- The MP4s are written one at a time at the lowest CPU priority (`ffmpegInBackground`) and take no
  transcode slot, so playback always wins. They live in
  `TRANSCODE_DIR/downloads/<fileId>/<name>.mp4`. One job per hash of the file's identity (ID,
  size, modification time) and the plan, so devices asking for the same thing share one file;
  each run gets a random name, so a plan written again is served at a new URL and a resumed
  transfer never mixes bytes of two runs. The MP4 being written reserves its estimate in a ledger
  streams share (`TranscodeSpace`), so streams keep `MIN_FREE_TRANSCODE_MB` beyond it; queued MP4s
  reserve nothing and never refuse a stream. A run whose ffmpeg writes nothing further for ten
  minutes (a NAS gone quiet) fails, so it cannot hold the queue. A restart empties
  `TRANSCODE_DIR`; the app then prepares again.
- `/media/downloads/<fileId>/<hash>.mp4` serves a finished MP4 with the direct route's validators
  and single byte ranges, so a transfer resumes with a new ticket; the ticket must be a `download`
  ticket for that file. A failed job's `TranscodeFailed.detail` is ffmpeg's path-scrubbed output,
  or a fixed sentence for any other failure, so it never names a path in `TRANSCODE_DIR`.
- The iOS app keeps one store per server and person in `downloads/<server>/<person>/index.json`
  under its documents folder, with one folder per download. A kept download plays from its local
  file with no server call, and the progress it makes is sent with `movies.play.reportOffline`
  when the server answers.

## Subtitle delay

- The web player shifts text subtitles for the viewer: a positive delay shows each cue later than
  its file says, a negative one earlier. Range ±30 s; Earlier and Later (and the player's G and H
  keys) step 0.1 s; a typed entry keeps 0.01 s. A cue moved before 0 s is cut at 0 s.
- Lifetime: the current playback only. Nothing is stored: not on the device, in Convex, or in the
  account.
- It is a client presentation setting and nothing else. The media service, Convex, and the SDK
  never see it, so it is not in contracts, the SDK, or the CLI, which has no player.
- How: `SubtitleRetimer` (`apps/web-movies/src/playback/subtitle-timing.ts`) moves the
  `startTime` and `endTime` of the `<video>` element's text track cues, keeping each cue's file
  timing beside it so changes never drift, and times cues that load later (a track shown the first
  time, or a new stream's `<track>` elements). Text subtitles are WebVTT `<track>` elements beside
  the stream on every path, so one mechanism covers direct play, native HLS, and hls.js. Re-timing
  the WebVTT on the server was rejected: it would need a new URL and a reload for every step and
  would leak a per-viewer setting into the media service.
- Where it cannot apply, the control is disabled and says why: "Subtitles are off", "Subtitles are
  loading" for a track the playing stream does not list yet, and "Burned into the video" for
  picture subtitles (PGS, VobSub, DVB), which the media service burns into a transcode. ASS and SSA
  convert to WebVTT text and do get the delay.

## Group sessions

- Old movies' watch rooms are gone. Group sessions are the core's `core.together.*` (ADR 0017);
  the movies clients do not run them yet. `@media/contracts/clock` keeps the shared clock math.

## Backups and restore

- The media service owns both: a nightly Convex cron at 03:00 UTC requests a backup job, which
  runs `convex export --include-file-storage` into `BACKUP_DIR` (renamed into place only on
  success, pruned past `BACKUP_RETENTION_DAYS` only after a new backup succeeds). `POST
  /api/backups/restore` (admin) runs `convex import --replace-all`, then
  `core/maintenance:settleRestoredJobs` and `core/maintenance:endAllSessions` (a snapshot carries
  working sessions). Deployment environment variables are not part of an export. The procedure,
  including recovery without the media service, is in `docs/operations.md`.
- Both installs back up before deploying a new version's functions.

## Imports from Jellyfin and Plex

- Sources are in-repo migration-source plugins in `apps/media/src/migration/` (Jellyfin 10.8 or
  later, Plex Media Server 1.24 or later), behind one typed contract (`source-plugin.ts`). A
  plugin's manifest names role `migration-source` and the one host it may reach; the HTTP client
  it gets refuses other hosts, methods other than GET, and POSTs other than Jellyfin's
  `/Users/AuthenticateByName`. Plugins never read, move, copy, or link media files.
- Jellyfin signs in with an API key or an administrator's user name and password. Plex takes a
  local server token (`X-Plex-Token`); plex.tv is never contacted.
- Flow: `imports.connect` → `imports.preview` → `imports.start`, media commands with `admin`
  access. Runs are read with `movies.imports.list` and `movies.imports.get`. A connection lives in
  the media service's memory for an hour.
- The run is a core import job (ADR 0012, "Jellyfin and Plex imports"): it adds the libraries it
  needs, waits for their scans, maps each source user to a core user, and writes in batches that
  move its checkpoint, so a restarted run goes on where the last one stopped.
- Secrets: connection credentials stay in the media service's memory and are never logged. A job
  must survive a restart, so its stored plan carries the credentials sealed with AES-256-GCM under
  a key derived (HKDF-SHA256) from the media service's own service key, bound to the server ID and
  URL (`apps/media/src/migration/credentials.ts`). The core never holds that key, so no Convex
  function, user, or backup can open them. A new service key makes queued plans unreadable; their
  jobs fail and the admin imports again.
- The web migration suite imports from the recorded Jellyfin server by default and from a real
  Jellyfin in Docker with `MEDIA_JELLYFIN_DOCKER=1`, as CI runs it.

## Web UI kit

- `@media/ui` holds presentational components with typed props and no data access; routes wire
  them to the SDK. Link-like components take the router's link through Base UI's `render` prop.
- Components use Paper tokens only. Paper literals that are not tokens yet (such as the 11px
  keycap size, the hero title size, and the glass fill) live in a separate, labeled `@theme` block
  in `globals.css` under role names. Paddings, gaps, margins, and offsets between the Paper
  spacing steps (`gap-1.5`, `p-5`) are listed there too, keyed by their step on Tailwind's 4px
  grid so class names stay familiar, in rem as Tailwind's multiplier drew them, so they follow
  the browser's text size like the rest of the multiplier. Element sizes read the same keys
  where their step is listed (`h-9` is `--spacing-9`, 36px) and the `--spacing` multiplier
  otherwise (`w-110`). `apps/web-movies/src/lib/design-tokens.test.ts` fails on a spacing step
  outside both lists, on Tailwind's own text, radius, shadow, weight, leading, and tracking sizes,
  and on a raw length inside an arbitrary value. `--color-page` is the page canvas: `bg` in light,
  `dark-bg` on dark phones, `dark-surface` on dark desktops, as Paper draws them.
- Chrome over artwork (hero, player, phone glass) uses the `on-media` utility, which remaps the
  text and state roles to their dark twins so it stays white in both themes.
- `cn` knows the Paper theme scale (`packages/ui/src/lib/utils.ts`); without it, custom sizes such
  as `text-micro` merge away next to colors such as `text-danger`.
- Desktop layout starts at `md` (48rem). Rows switch layouts with container queries, so they also
  fit narrow panels.
- Keyboard shortcuts are listed once in `apps/web-movies/src/lib/keymap.ts` and resolved by
  `@media/ui/lib/keymap` (`mod` is `⌘` on Apple devices and `Ctrl` elsewhere). The command menu
  draws its keycaps from that list. Sequences such as `g h` wait one second for the next key.
- The command menu takes a typed page model (`@media/ui/lib/command-menu`): groups scoped to
  browsing or searching, fuzzy or caller-ranked filtering, actions (sync or async) and submenus
  that replace the list in the same panel, running-job progress, and fallback commands for no
  results. Rows come from the web app's feature contributions (see Web app).
- The component gallery at `/dev/kit` is development-only; production builds replace it with an
  empty route and do not bundle it. So is the track menu bench at `/dev/tracks`, which the `kit`
  E2E project checks at several screen sizes.
- The player's track menu always opens above its trigger (`collisionAvoidance` `side: "none"`):
  Base UI would otherwise flip a tall panel below or beside the trigger, over the controls or off
  the screen. Its height is held to Base UI's `--available-height` and `--spacing-track-panel`,
  its width to `--available-width`.

## Web app

- The movies web client never signs in itself. It runs the platform client on the browser's one
  session, which the account client at `/` keeps, and sends a signed-out browser there
  (`apps/web-movies/src/session/session.tsx`, ADR 0020). Screens read and write through
  `@media/sdk/react` (`usePlatform`, `usePlatformQuery`).
- The command menu's root list is collected from `src/commands/`: each feature exports a
  `use<Feature>Commands` hook, and `src/commands/index.ts` merges them in menu order. Groups with
  the same id merge, so features add rows to "Actions" or "Go to".
- Escape on the player does one thing per press. An open menu, popover, or dialog takes it first;
  in full screen it only leaves full screen; otherwise it asks "Leave playback?". Stay, Escape, and
  a click outside keep playing, and repeats of a held Escape never close it.
- Artwork loads the media service's base URL plus the result's artwork path, resized per use
  (`apps/web-movies/src/lib/artwork.ts`).
- Play and Resume link to `/watch/$titleId?episodeId=&start=0`, with `version=<fileId>` for a
  chosen file. A version switched in the player replaces `version` in the URL without remounting
  the player.
- The stack E2E suite (`apps/web-movies/e2e/stack`) runs the real media service against the dev
  stack over a generated fixture library. The Playwright groups are in
  `apps/web-movies/playwright.config.ts`.

## Account and admin screens

- The account client (`apps/web-account`) holds sign-in, the shared picker, invites, reset links,
  device approval, and the server's admin screens: users, groups, devices, guests, libraries,
  backups, and the server. The movies client keeps its own library detail, fix match, and import
  screens under `/movies/admin`.
- The library detail screen counts problems with `movies.files.summary`, which reads the
  `by_library_missing` and `by_library_status` indexes instead of scanning the library.
- Fix match treats a search the media service answers with `Internal` (no metadata provider, or
  one that failed) or cannot reach as search being unavailable, and keeps hand edits working.
  `RateLimited` asks to try again.

## SDK

- `@media/sdk` runs the platform client on one transport: the WebSocket `ConvexClient` for apps
  and `ConvexHttpClient` for short-lived processes, whose subscriptions poll. Functions are called
  by path with `makeFunctionReference`.
- The SDK avoids Effect modules marked unstable, which the repo's lint rejects: media service
  requests use the platform `fetch`.
- Sign-in and token refresh go through a private `ConvexHttpClient`: the WebSocket client waits
  for its token before running calls, so refreshing through it would wait on itself. Every sign-in
  goes through the media service's sign-in boundary (ADR 0007).
- `PlatformProvider` creates and disposes its client in one effect, so React's development double
  mount never leaves a disposed client in use; children render once the client exists.
- The Promise facade and React commands reject with the same tagged errors the Effect API fails
  with; React queries return a `loading | success | error` state instead of throwing.
