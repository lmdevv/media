# Implementation decisions

Cross-package decisions that every client, the backend, and the media service build against.
The product architecture and design live in the owner's vault; this file records the concrete
choices made while implementing them. Update it in the same PR that changes a decision.

## Playback tokens

- Format: `v1.<payload>.<signature>`. `payload` is base64url (no padding) of UTF-8 JSON; the
  signature is base64url HMAC-SHA256 over the ASCII string `v1.<payload>` with the raw bytes of
  `PLAYBACK_TOKEN_SECRET` (a base64url string of at least 32 random bytes, decoded before use).
- Payload fields: `aud` (`"media"`), `sub` (user ID), `pid` (profile ID), `fid` (file ID), `sid`
  (playback session ID), `iat` and `exp` (milliseconds since the epoch), and `pur: "download"`
  last for a download session's token only. Lifetime six hours.
- Convex signs with WebCrypto in plain TypeScript. The media service verifies with the shared
  verifier in `@media/contracts/playback-token` (constant time; a wrong audience, a bad or
  non-canonically encoded signature, or `exp <= now` is refused). Shared test vectors in
  `packages/contracts` keep both sides honest.
- Each media route takes tokens of one purpose: negotiation, seeking, HLS, and trickplay only
  playback tokens; `prepare` and the download MP4s only download tokens; the original file and its
  subtitles either. Any other is `PlaybackTokenInvalid` with reason `wrong_purpose` (401).
- A token whose playback session has ended is refused with `PlaybackSessionEnded` (410) even
  before it expires. The media service subscribes to `mediaService:sessionStatus` for each session
  whose unexpired token it sees, until the session ends, for the 4096 sessions asked about most
  recently. It remembers up to 16,384 ends for the six hours a token lives, apart from those
  subscriptions, so a session forgotten to make room stays refused while Convex is unreachable. An
  expired token opens no subscription and answers 410 only for an end already known. It waits up to five seconds, timed from the first question and not from
  the wall clock, for the first answer before it serves that session. An HLS stream follows its own session and stops when it ends. A session Convex has no
  record of, such as one a restore erased, counts as ended. Following each session, rather than a
  feed of ends ordered by `endedAt`, sees an end that commits after a later-stamped one, or that a
  restore or a clock step stamped in the past. It also writes nothing, so ends in different
  accounts never contend.
- Tokens never appear in logs. Media URLs carry the token in the `token` query parameter because
  `<video>` and HLS segment fetches cannot set headers.

## Identities, roles, and scopes

- A Convex Auth user is an account. Roles: `owner` (first account), `admin`, `member`, and
  `service` (the media service's system account, which has no password).
- Profiles belong to an account. A kids profile has a maximum age rating (default 7); any profile
  may have a maximum. Titles store a minimum age derived from their certification
  (`ageRatingFromCertification` in contracts); a limited profile never sees titles above its
  maximum or unrated titles, and asking for one directly reports `not_found`.
- Any profile may have a 4 to 8 digit PIN. Each session unlocks a PIN profile on its own
  (`profiles.unlock`); the unlock lives on the session row. Five wrong PINs in a row lock the
  profile for five minutes. Changing or deleting a PIN profile requires it to be unlocked. The web
  app locks a profile again (`profiles.lock`) when the browser switches to another one, so a PIN
  guards a profile every time someone picks it, not once per sign-in. The operator clears a
  forgotten PIN with `convex run maintenance:clearProfilePin '{"profileId":"…"}'`.
- The mobile keypad accepts four digits. It cannot unlock a profile whose five- to eight-digit
  PIN was set through the CLI or API.
- A password session withholds `account`, `manage`, and `admin` while the account has a kids or
  rated profile, every unrestricted profile has a PIN, and none of them is unlocked on the
  session. Only then do PINs keep someone in a limited profile, and only then could that profile
  otherwise lift its own limits, add an open profile, mint keys, or re-rate titles. `account.viewer`
  reports the reduced scopes, so the web app hides those screens. API key and device sessions are
  exempt: whoever created them held those scopes.
- Sessions created by an API key or device sign-in carry a grant with explicit scopes, stored on
  the `authSessions` row itself. Effective scopes are the grant's scopes that the role still
  allows, so demoting an admin strips `manage` and `admin` from their keys and devices at once.
  Password sessions have no grant and hold every scope their role allows.
- Scopes: `read` (browse, search, history, room state, PIN unlock), `play` (playback sessions,
  progress, my list, watched marks, rooms), `account` (the account's own profiles, PINs, API keys,
  device approvals, and sessions), `manage` (libraries, scans, jobs other than backups and
  migrations, metadata fixes; admin role required), `admin` (users, invites, other people's keys, backups, restore, migration; admin role
  required), and `media-service`. `account` was added so a key or device can never mint
  credentials unless explicitly granted it; API keys can never hold it.
- API keys hold a non-empty subset of `read`, `play`, `manage`, `admin`, never more than the
  creating session holds. Device approvals grant a subset of the approving session's scopes and
  may include `account`. `media-service` is never grantable.
- The media service signs in with `MEDIA_SERVICE_API_KEY` through the `apikey` provider. The key
  belongs to the `service` account, is created by `packages/backend/scripts/configure.ts`, and its
  grant carries only `media-service`, which allows the media functions and nothing else.
- An API key's session ends at the key's expiry at the latest, and every call checks the key again:
  a revoked, deleted, or expired key ends its session at once. Admins manage other accounts' keys,
  except the owner's.
- Validators check shapes; the bounds the contracts put on arguments (display names 1 to 80
  characters, avatar keys 1 to 40, device IDs up to 128, folders up to 1024 and 20 per library,
  non-negative finite positions and durations) are checked again in `convex/lib/bounds.ts`, and the
  registry test compares each bound with its contract schema.
- Every public Convex function checks the viewer's scopes server-side, and checks the session row
  on every call: signing out, revoking a key, revoking a session, or disabling the account ends
  its tokens immediately and ends the playback sessions it started. `auth:signOut` is ours, not
  Convex Auth's: it removes the session and its refresh tokens as Convex Auth does and also ends
  the session's playback. Renewing a playback token checks the profile, its PIN unlock, its limits,
  and the library grant again. `packages/backend/test/stack.test.ts` calls every public function
  (found from `convex/_generated/api`) anonymously, as the media service, as a member, and with a
  read-only key, and expects each call outside the registry's scope to be refused.

## Command registry

- `@media/contracts/commands` lists every user action once: name (dotted, such as
  `titles.list`), summary, group, kind (`query`, `mutation`, `action`, or `media` for media
  service HTTP calls), `scope` (a scope, `public` for anonymous calls, or `authenticated` for any
  session), Effect Schema args and result, and the Convex function it calls. The function path is
  the name with its dot replaced by a colon (`titles.list` calls `titles:list`); `media` commands
  name a `route` instead.
- Convex functions stay plain TypeScript with `v` validators and do not import
  `@media/contracts`. `packages/backend/test/registry.test.ts` checks that each Convex command
  and media service function names an existing public function of the same kind whose argument and
  return validators describe the same wire values as the schemas, that every public function is
  listed, and that constants duplicated on both sides agree. ID schemas carry a `convexTable`
  annotation for this check.
- Expected failures travel as `ConvexError({ code, message })` with the codes in
  `@media/contracts/errors`; the media service answers `media` commands with the same body.
- For `media` commands the SDK sends the caller's Convex auth token as a bearer token; the media
  service calls `account.viewer` with it (a one-shot HTTP call, so revoked sessions are refused at
  once) and checks the command's scope. Route groups register through `commandRoute` in
  `apps/media/src/http/command-routes.ts` and are listed once in `apps/media/src/main.ts`.
- The SDK, CLI, and command menu are generated from the registry.

## Media service and Convex

- Convex never calls the media service. The media service subscribes to its job and ended-session
  queries and calls `media-service` scoped mutations.
- Scan jobs use leases: a claim writes `leaseOwner` and `leaseExpiresAt`; the worker renews it, and
  an expired lease can be reclaimed after a restart. The media service claims with a 60 second
  lease, renews every 15 seconds with the scanner's counters as progress, and stops the job's work
  when a renewal reports it cancelled or the lease lost. Failures say whether to retry: a folder
  outside `LIBRARY_ROOTS` fails for good (`Library root not approved: …` on the job), an
  unreadable folder or an unreachable Convex returns the job to the queue. Scans and metadata
  writes are idempotent, so a job that runs twice is harmless.
- The media service signs in with `MEDIA_SERVICE_API_KEY` over the SDK's WebSocket transport and
  keeps retrying with capped exponential backoff (0.5 to 30 seconds, jittered) while Convex is
  down or refuses the key; a session that ends signs in again, and a call refused as
  `unauthenticated` is retried once after that.
- Scans: a `full` scan job re-reads every file; a `quick` one skips files whose size and
  modification time did not change; watchers and the periodic reconciliation are quick. Local
  disks are watched with file events; network file systems (NFS, SMB/CIFS, 9p, FUSE, found with
  `statfs`) send none for changes made elsewhere, so `LIBRARY_WATCH=auto` polls them every
  `LIBRARY_POLL_SECONDS`, one `stat` per folder, reading a folder again only when its modification
  time moved. A file rewritten in place (no rename) leaves its folder's time alone, so such an
  edit waits for the reconciliation; a scan that fails keeps the change pending for the next
  poll. A watcher whose folder fails, ends, or is replaced restarts with backoff (one second
  up to five minutes) and rescans once it is back. Convex
  stores absolute paths. A title's match key is its kind plus a provider ID (`movie:tmdb:603`),
  else its normalized name and year (`show:local:fixture show (2021)`). Extras (trailers,
  featurettes) belong to no title and are not stored. A multi-episode file is stored under its
  first episode.
- The media service's functions are listed with their schemas in
  `@media/contracts/media-service` (`mediaService:*`). It subscribes to `pendingJobs`,
  `libraries`, and `sessionStatus`, resolves a token's file with `resolveFile`, and writes scans
  in batches of at most 100 with `upsertScanned` and `markMissing`. Missing files keep their
  records and history.
- Library folders are normalized (trimmed, no repeated or trailing slashes) and may not equal,
  contain, or sit inside another library's folder, nor nest within one library: a grant on one
  library must never expose another's files. A migration reuses the library whose folder holds,
  or lies inside, a folder it imports, and keeps only the outermost of nested source folders.
  Libraries made before this rule may still overlap; `convex run maintenance:overlappingLibraries`
  lists them.
- `titles.list` pages by index position (the sort value and creation time of the last title read)
  instead of Convex's cursor, so one query can read several batches: limited profiles and kind
  filters still get full pages, up to 1000 titles read per page, and a library filter reads that
  library's own index. Continue watching resolves progress rows until its 20 rows are full and
  spends at most 500 document reads (episodes and their progress rows) in all on next-episode
  lookups, reading following episodes ten at a time; a run of more than 100 watched episodes in
  a row is skipped over.
- One `jobs` table holds scan, metadata, backup, and migration jobs; `payload` carries what each
  kind needs. A claim lasts 5 seconds to 10 minutes; `renewLease` reports progress and returns
  `cancelled` when an admin cancelled the job. A cron returns expired leases to the queue every
  minute and fails a job after five attempts. A nightly cron at 03:00 UTC queues a backup job; the
  media service runs `convex export` and records the archive with `recordBackup`.

## Media playback API

- The media service's HttpApi lives in `@media/contracts/media-api`; its routes, request and
  response schemas, and tagged errors live in `@media/contracts/media-playback`, which uses only
  stable Effect modules. Contracts allow the unstable `effect/http-api` module for the definition
  alone. The SDK does not import the HttpApi: it posts with `fetch` and decodes the shared schemas
  (with their JSON codecs: absent optional fields arrive as `null`) and tagged errors.
- `Playback.recoveryFor` maps each failure to what a player does: `StreamGenerationGone` → load
  the current playlist (`seekStream`), `StreamNotFound` → `renegotiate`, `PlaybackTokenInvalid`
  with `expired` → `renegotiate` (renews the token first), `PlaybackSessionEnded` → start a new
  session, busy or briefly unavailable (`TranscodeCapacityReached`, `InsufficientTranscodeSpace`,
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
  encode (HDR without tone mapping), rather than not at all. The web player offers Auto (no
  cap, as before), Original (no cap; stays so if Auto ever adapts to the connection), 1080p,
  720p, and 480p (10, 4, and 2 Mb/s), remembered per browser; the CLI takes `--max-height`.

## Artwork

- Titles, seasons, and episodes carry artwork keys: `a1.<base64url(iv ‖ ciphertext ‖ tag)>`, an
  AES-256-GCM sealing of where the image lives (an absolute path inside a library folder, or a
  TMDB image URL). The IV is an HMAC of the reference, so sealing is deterministic and rescans do
  not churn. Both keys derive from `PLAYBACK_TOKEN_SECRET` with their own labels; rotating it
  invalidates artwork keys until the next full scan.
- Clients load `${mediaBaseUrl}/artwork/${key}`, optionally `?w=` one of 185, 342, 500, 780,
  1280 (`artworkUrl` in `@media/contracts/artwork`). No token: `<img>` cannot send one, artwork
  is low sensitivity, and a key can only name an image the service sealed itself, so the route
  cannot be pointed at other files and URLs reveal no folder names. Local images are re-checked
  against `LIBRARY_ROOTS`; remote images are fetched only from `image.tmdb.org` and cached under
  `DATA_DIR/artwork`; resized copies are JPEGs made with ffmpeg and cached by source, size, and
  modification time.

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
- Titles keep bounded lists (20 studios, countries, and recommendations, 40 keywords) and a
  ratings object; credits live in their own table, one row per person and role, indexed by title
  and episode and by person. People are keyed `tmdb:<id>`, then `imdb:<id>`, then
  `name:<normalized name>`; a credit whose key finds nobody joins a person of the same name whose
  IDs do not contradict it, and that person gains the credit's IDs in place. Credits of a title or
  an episode are replaced as a set, skipped when the media service's digest of them is unchanged.
  `upsertScanned` returns the stored credit and collection digests, so a rescan sends only what
  changed, eight writes at a time.
- Credits travel in `mediaService.applyCredits` (per title, and per episode for guest stars and
  episode crew) and collections in `mediaService.applyCollection`, after the scan's
  `upsertScanned` batch, once per title per scan. They are extras: a failed one is logged and
  written by the next scan, without failing the scan. A scan never changes a manually matched
  title; a metadata job may, with its lease. A refresh writes credits only where none were written
  (it never replaces a scan's, often an NFO's, cast); a hand-picked match (`metadata.fixMatch`)
  replaces them. Any write keeps the provider IDs and site scores it does not carry (one a
  migration imported, a score OMDb could not give this time), and a title with IDs stays matched.
- A person's biography, dates, birthplace, and photo are fetched lazily: opening a person page
  calls `people.requestDetails` (scope `read`), which queues a `person` job at most once per person
  every six hours. A metadata refresh also fetches the ten top-billed people nobody fetched yet
  (its lease covers the people credited on its title only). A
  person the provider cannot describe (no key, or TMDB no longer has them) is recorded as fetched
  with nothing to show, so nobody asks again.
- People are visible only through titles: `people.get` lists the person's credits on titles the
  profile may see, and a person with none looks missing; `people.search` leaves them out.
- Collections: TMDB's `belongs_to_collection` (`tmdb:<id>`) or an NFO `<set>` (`tmdb:<id>` from
  Jellyfin's `tmdbcolid`, else `set:<name>`) puts a title in a collection, which is created on
  first sight or found by source key, then by name, so a TMDB collection and an imported box set
  or NFO set of the same name become one (two TMDB collections never merge by name). Such members are marked `metadata`; an import replaces only its own
  members. Members a title's metadata added sort by year.
- More like this (`titles.similar`): TMDB recommendations, then similar titles, stored as TMDB IDs
  on the title and resolved against the catalog on read (index on kind and TMDB ID), so titles
  added later appear without a refresh; topped up by shared genres (twice), keywords, and studios
  among the most recently added titles of the kind in each library the profile sees, about 300
  in all. A title's copies in other libraries, and repeats of one TMDB ID, are listed once.
  Visibility applies on read.
- `titles.list` with a genre pages through `titleGenres`, one row per title and genre carrying
  the title's library, kind, and sort fields (Convex cannot index array members), kept in step
  with every title write and backfilled by `maintenance:backfillTitleIndexes`, which `configure.ts`
  starts on each deploy. It uses the same index-position cursors and batch reads as every other
  page, through the genre's own indexes by library, by kind, or across all; it spends half the read
  budget, as each entry reads a row and its title. Years, studio, and minimum score are checked
  per title inside the batch loop, against the year an admin may have overridden, so filtered
  pages still fill up to the read budget. The score is IMDb's, else TMDB's. `titles.genres` counts
  genres across the newest titles of each library the profile sees, about 1,000 in all.
- Trailers: the official YouTube trailer from TMDB videos, or a YouTube ID or URL in the NFO
  `<trailer>`. Keys are checked (`[\w-]{6,20}`) in the media service and again in Convex, and the
  web app embeds `youtube-nocookie.com` only. Local trailer files stay unstored extras.
- Migration carries the source's provider IDs: they fill IDs a matched title lacks, and an
  unmatched title that gains one is queued for a metadata refresh.

## Scrub thumbnails and chapters

- A `trickplay` job per file makes its scrub thumbnails. Scans queue one for each new or changed
  file (another size or modification time) when the library's "Generate scrub thumbnails" setting
  is on (the default); `libraries.generateTrickplay` queues every file without current thumbnails,
  including failed ones, paging through the library with scheduled mutations. The file's
  `trickplay` field follows its job: `pending`, `ready` with the manifest, `failed` (scans leave it
  alone until an admin asks again), or absent, each for the file's size and modification time
  then. A file that changes while its job waits or runs gets a new job and the old one is
  cancelled; thumbnails are shown and kept only while they match the file's current contents, and
  a job that read other contents than the catalog has records nothing. A missing file, a removed
  library, or a library turning thumbnails off cancels the jobs nobody needs.
- A job retries (up to five attempts) when ffmpeg fails or the share or data folder is
  unreadable, and fails for good only when the file is gone, has no video, or yields no frames.
  With `TRICKPLAY=off` the media service runs no trickplay jobs; they wait, and run once it is on.
- Generation is one ffmpeg run on one thread at the lowest CPU priority: keyframes only
  (`-skip_frame nokey`), one frame per `TRICKPLAY_INTERVAL_SECONDS` (10) taken as the last
  keyframe at or before each tick (`fps` with `round=up` and `start_time=0`; ffmpeg 6 emits nothing
  for clips shorter than one interval without it), counted as ffmpeg picks them so a video shorter
  than its container leaves no black tiles, 320 pixels wide by the display aspect ratio, HDR tone-mapped
  when ffmpeg has `zscale`, tiled 10 × 10 into JPEG sheets. A two-hour film takes about 23 s and
  3.8 MB (measured on a 32-thread desktop, Sintel looped to 1 h 58 min). Trickplay jobs have
  their own worker slots (`TRICKPLAY_CONCURRENCY`, 1), and `mediaService:pendingJobs` reads each
  kind on its own, so thousands of queued thumbnails never hold up a scan or a backup.
- Sheets live in `DATA_DIR/trickplay/<fileId>/<version>/` with `manifest.json`; the version is the
  file's size and modification time in base 36, so a replaced file never shows old frames. A new
  version is built in a hidden folder and renamed into place. A job reads the file's size and time
  again after ffmpeg and drops its sheets if they changed. Publishing leaves the file's other
  versions alone, because two jobs for one file may both publish and only the catalog knows which
  it accepted. A sweep a minute after startup and every `LIBRARY_RECONCILE_MINUTES` deletes
  folders the catalog no longer names (`mediaService:trickplayVersions`), sparing ones younger
  than an hour.
- Players read the manifest from `MediaFile.trickplay` and load
  `/media/trickplay/<fileId>/<version>/<n>.jpg?token=` with the session's playback token. Frames
  are content, not artwork: a sealed key like artwork's would let anyone holding a URL see frames
  of private videos forever, while the token is bound to one file and one session and stops working
  when either ends. Responses are `private, max-age=31536000, immutable`: the version changes with
  the file.
- Chapters come from ffprobe (`-show_chapters`), measured from the first frame, clipped to the
  file's length, without empty markers; `Probe.chapters` is absent for files scanned before, so a
  full scan picks them up.

## Casting and system controls

- Chromecast uses Google's Cast Web Sender SDK with the Default Media Receiver. The web app loads
  `cast_sender.js?loadCastFramework=1` from `www.gstatic.com` only in Chromium browsers and only
  once the player opens; Safari and Firefox never download it. The content security policy allows
  scripts from `www.gstatic.com` without a scheme: the SDK loads its framework and platform
  scripts protocol-relative, so a page served over HTTP fetches them over HTTP (checked in Chrome
  against the media service's real policy: with `https://` only, `cast_framework.js` was blocked).
- A cast continues the page's playback session; it is not a new device. The media service keeps
  one stream per playback session, so the page lets go of its stream first (`park`: no
  negotiation, recovery, or token renewal on the page while a TV plays) and the receiver gets a
  new stream, negotiated through the same ladder with the Chromecast client profile in
  `@media/contracts/cast` (1080p H.264 and AAC, MP4 or fMP4 HLS, on every model; HEVC Main 10,
  2160p, HDR10 and HLG only for models known to play them). The web sender SDK's
  `chrome.cast.Receiver` carries a name, `video_out`-style capabilities, and volume, and no model
  or codecs (read from Google's sender script), so the web app always asks for the profile every
  Chromecast plays; native senders, which know the model, can ask for more. Its absolute URLs carry the session's playback token in the query, as every
  media URL does, because a receiver cannot send headers; no other token kind exists, and the
  token stops working when the session ends.
- The page's element pauses and `PlaybackController.output` switches to the receiver, so progress
  reports and a watch room's engine follow the TV. Subtitles are the stream's WebVTT tracks;
  subtitle and audio choices retrack or reload the receiver at its position, and the cast renews
  the token five minutes before it expires, as the page would.
  A seek goes through `seekStream` first, because a receiver asking for segments outside what the
  stream produced would get `StreamGenerationGone`; a new generation reloads the receiver there.
  Disconnecting, from the page or the TV, stops the receiver's stream and continues on the page at
  the TV's position. Leaving the player stops the TV but keeps the device connected, so the next
  episode or title casts by itself. The cast menu warns when the media service's address is
  `localhost` or a loopback address, which no Chromecast can reach.
- AirPlay plays the `<video>` element's own source, so Safari plays HLS natively (hls.js is never
  used there) and the element carries `x-webkit-airplay="allow"`; the menu offers AirPlay only
  after `webkitplaybacktargetavailabilitychanged` reports a device, and the element keeps firing
  its events, so progress keeps reporting. Browsers without the Cast SDK or AirPlay get the
  standard Remote Playback API (`video.remote.prompt()`), which cannot send Media Source streams.
- The Media Session API publishes the title, show, episode, and artwork, and handles play, pause,
  seek backward and forward, seek to, and previous and next episode (within the season); handlers
  act on the session's output, so they also drive a TV. Picture in picture uses the standard API,
  or Safari's presentation modes.
- SharePlay (Apple's GroupActivities) exists only for native apps; the web app does not imitate
  it. Join watching rooms are the cross-platform equivalent, and keep working while the host or a
  guest casts, because the room engine follows the session's output. SharePlay ships with the
  native iOS and tvOS app (V1).

## Playback and progress

- `playback.createSession` is a mutation: it authorizes the profile and library, picks the file,
  ends the device's previous session, records the new one, and signs the token in one
  transaction. Each device has its own session; starting one on a device ends that device's
  previous session. An account plays on at most eight devices at once: starting a ninth ends the
  one that reported least recently, so one account cannot hold unbounded streams.
- Versions: a movie or episode with several files on disk (Plex and Jellyfin `{edition-…}` names,
  `cd2`/`part2` parts, which the scanner names `Part 2`, or copies in other qualities) lists them
  with `titles.versions` (and a movie's in `titles.get` as `versions`), best quality first: taller
  picture, then HDR, then bitrate, then size. The profile's progress row keeps the file it last
  played, so the version is remembered per profile and item while the position stays the item's.
  Without a `fileId`, `createSession` plays that remembered file while it is on disk, else the
  best its `capabilities` play directly, else the best quality; the SDK's
  `Versions.preferredVersion` orders a client's list the same way. Direct play is decided by
  `@media/contracts/direct-play`, which the media service's negotiation, the SDK, and the title
  page use; Convex mirrors it in `convex/lib/directPlay.ts` and a property test keeps the two
  equal. The web player sends its capabilities and starts at once; it switches versions in a new
  session (the media service streams one file per session) at the same position and play state,
  carrying the audio and text subtitle languages over, and falls back to the version that played
  when the new one cannot start. Rooms play the host's file and offer no switch.
- A progress report from a session that started before the session owning the item's progress is
  ignored (`applied: false`), so an old tab cannot drag a newer device back. Reaching 90 percent of
  the duration, or reporting `ended`, marks the item watched; watched stays set until someone marks
  it unwatched. Sessions silent for 30 minutes end.

## Downloads

- A download is a playback session with `purpose: "download"`, started with `downloads.start`.
  It gets playback's checks (the profile, its unlock, its age limit, the library grant) and file
  choice, and every path that ends playback (sign-out, an ended sign-in, a removed library or
  profile, the media service's ended-session list) ends it too, without new plumbing. It neither
  ends nor is ended by the device's playback, is not listed in `playback.active`, and records no
  progress. One device holds at most four download sessions and the account eight, beside the
  eight devices it plays on; past either cap the quietest ends, and the same file again replaces
  its earlier download on that device. Its token names its purpose, so it cannot stream. `playback.renewToken` renews its token and keeps
  it alive; the app renews before the token expires, and the idle sweep ends a download not renewed
  for a token's lifetime and an hour more.
  `downloads.end` ends it once the file is on the device.
- `POST /api/downloads/prepare` takes the token, the device's capabilities, a quality
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
  transcode slot, so playback always wins; no new setting. They live in
  `TRANSCODE_DIR/downloads/<fileId>/<name>.mp4`. One job per hash of the file's identity (ID,
  size, modification time) and the plan, so devices asking for the same thing share one file;
  each run gets a random name, so a plan written again is served at a new URL and a resumed
  transfer never mixes bytes of two runs. A download session holds one MP4 at a time: asking for
  another (or for the original) stops the one it asked for before if nobody else wants it and it
  is not written yet, so the queue holds at most one job per download session. The MP4 being
  written reserves its estimate in a ledger streams share (`TranscodeSpace`), so streams keep
  `MIN_FREE_TRANSCODE_MB` beyond it; queued MP4s reserve nothing and never refuse a stream. A new
  MP4 is queued only when the disk holds the minimum, the reservation, and the estimates of every
  queued MP4 and its own (`InsufficientTranscodeSpace` otherwise). A queued or running MP4 is kept
  while one of its download sessions is live, however long the queue; it is stopped once none has
  asked for it for two minutes (a cancelled download, a sign-out; the grace lets a download started
  again ask first) or nobody asked about it for a token's lifetime (an app gone away). A run whose
  ffmpeg writes nothing further for ten minutes (a NAS gone quiet) fails, so it cannot hold the
  queue. A finished or failed MP4 nobody asked for in six hours is deleted, and a restart empties
  `TRANSCODE_DIR` as before; the app then prepares again. A failed job answers `TranscodeFailed` for ten minutes
  before a prepare tries again, so a broken file is not encoded in full by every retry.
- `/media/downloads/<fileId>/<hash>.mp4` serves a finished MP4 with the direct route's validators
  and single byte ranges, so a transfer resumes; the token must be a download token for that file.
  A failed job's `TranscodeFailed.detail` is ffmpeg's path-scrubbed output, or a fixed sentence
  for any other failure, so it never names a path in `TRANSCODE_DIR`.
- `downloads.recordProgress` saves progress the device made playing a download, sent when it is
  back online with the time it played and its clock at sending, so a fast or slow device clock is
  corrected by its offset. It applies unless the item's progress was played since
  (`lastPlayedAt`), so an old offline viewing never drags a newer one back, and it marks the item
  watched at 90 percent. It needs the profile to still see the title, and the file to still be the
  item's (it may have left the disk); `playedAt` is checked like the positions.

- The iOS app keeps one store per server and account in `downloads/<server>/<account>/index.json`
  under its documents folder, with one folder per download: the video, its text subtitles as
  WebVTT, and its picture. The pure model (`apps/mobile-movies/src/lib/downloads`) reduces every change;
  the engine (`session/download-engine.ts`) works through the store two downloads at a time, oldest first:
  - a session, prepare every three seconds until ready, a space check (keeping 500 MB free, H21),
    then the video in an iOS background-capable download task;
  - Wi-Fi Only pauses the task off Wi-Fi and keeps its resume data, so it continues where it
    stopped; an app that quits starts what was under way again;
  - failures follow `afterDownloadFailure`: an expired token renews, an ended session starts a
    new one, anything else stops with H19's short line and Retry.
- `DownloadEngine` ignores failures while writing `index.json` or deleting a download's folder.
  A failed write can leave the latest state only in memory. A failed deletion can leave files
  on disk. Neither failure is shown in the Downloads screens.
- A download belongs to the profile that made it. The Downloads list, its screens, and the player
  find a download only among the active profile's (`downloadFor`), so another profile, a Kids one
  too, can neither see nor play it, even by a link. Each account keeps its own store folder.
  Signing out keeps the files (H15) but shows none: they come back only when the same account
  signs in on this server.
- A kept download plays in the normal player from its local file and subtitles, as a direct
  stream, with no server call. Progress is recorded every ten seconds and on pause, seek, and end,
  queued in the store, and sent with `downloads.recordProgress` whenever the server answers.
- When the server cannot be reached at launch, A08 offers Go to Downloads for the profile last
  used on this iPhone, while it is still signed in and chosen; the root stack then has only the
  Downloads screens and the player, and Try Again goes back to the server.

## Subtitle delay

- The web player shifts text subtitles for the viewer: a positive delay shows each cue later than
  its file says, a negative one earlier. Range ±30 s; Earlier and Later (and the player's G and H
  keys, and ⌘K's "Subtitles earlier/later") step 0.1 s; a typed entry keeps 0.01 s. A cue moved
  before 0 s is cut at 0 s.
- Lifetime: the current playback only. The playback controller keeps the delay with the file and
  text track it was set for and shows 0 while anything else shows. It survives pause, seeks,
  quality and audio changes, HLS playlist reloads, token renewals, and a version switch that falls
  back to the file that played; turning subtitles Off, or to a picture track, and back to the same
  text track brings it back. Choosing another text track, a version that then plays, another title
  or episode, or reloading the page starts again at 0. Nothing is stored: not on the device, in
  Convex, or in the profile.
- It is a client presentation setting and nothing else. The media service, Convex, the room
  engine, and the SDK never see it, and each member of a watch room has their own; the room's clock
  is untouched. So it is not in contracts, the SDK, or the CLI, which has no player.
- How: `SubtitleRetimer` (`apps/web/src/playback/subtitle-timing.ts`) moves the `startTime` and
  `endTime` of the `<video>` element's text track cues, keeping each cue's file timing beside it
  so changes never drift, and times cues that load later (a track shown the first time, or a new
  stream's `<track>` elements). Text subtitles are WebVTT `<track>` elements beside the stream on
  every path, so one mechanism covers direct play and native HLS (`<video src>`) and hls.js over
  Media Source (its light build has no subtitle handling of its own); a new stream for another
  quality never reloads them. Re-timing the WebVTT on the server was rejected: it would need a
  new URL and a reload for every step and would leak a per-viewer setting into the media service.
- Where it cannot apply, the control is disabled, reads 0.0 (nothing is shifted for the viewer),
  and says why: subtitles Off ("Subtitles are off"); a track the playing stream does not list yet
  ("Subtitles are loading"); picture subtitles (PGS, VobSub, DVB), which the media service burns into a transcode
  ("Burned into the video"; ASS/SSA convert to WebVTT text and do get the delay); Chromecast, whose
  Default Media Receiver loads the WebVTT itself and offers no cue offset ("Not while casting");
  and AirPlay or the Remote Playback API while they play the element on another screen ("Not on
  another screen"), whose receivers fetch the media themselves.

## Watch rooms

- A room stores `positionAtAnchorMs`, `anchorServerTime`, `status`, `playbackRate`, and
  `revision`. `rooms.create` starts it paused at revision 0; the host's device then sends
  `rooms.play`. Host commands require the host's account and device and the room's current
  revision, and bump the revision; an older revision fails with `stale_revision`.
- Heartbeats every five seconds keep members present. The host's heartbeat re-anchors the clock
  when its player is more than 50 ms off. It carries the server time, as the host estimates it, at
  which it read its position, so the request's travel time does not count as drift. Guests follow
  the clock, not the host, so this keeps them close to a host whose player started a little after
  the command that anchored it. A cron every ten seconds pauses a room whose host was
  silent for 20 seconds (`hostAway`), drops guests silent for a minute, and ends rooms abandoned
  for 30 minutes. The host leaving or ending ends the room; a guest leaving only removes them.
- Guests start their own playback session with `roomId`, which plays the room's file.
- `rooms.get` answers members while a profile they joined with may see the room's title (the host
  can switch to a title a guest's kids profile may not see). A room link (`/r/<roomId>`) reads the
  room before joining by naming the profile that would join: when it may see the title, the room
  comes back without its members. Everyone else gets `not_found`.
- Shows move on together, and only the host moves them (no delegated control exists yet). When
  the host's player reaches the credits (the episode's last tenth, at most 30 s, as solo), it calls
  `rooms.startNextCountdown`; the server stores `next: { status: "pending", episodeId, nextAt }`
  and schedules `rooms.nextEpisodeDue` for `nextAt`, ten seconds on. Every member renders the
  same seconds from `nextAt` and its own server clock offset, so a guest who reloads mid-countdown
  picks it up where the others are. The scheduled function is the countdown's only writer: it
  runs whether or not the host is still there (a heartbeat-driven advance would wait for a host
  who left), and it changes the room only while it still plays the episode it counted down from
  with that countdown pending, so it moves a room on at most once. The host's Play next, Next
  button, ⌘K, and media-session next call `rooms.playNext` with the episode they move on from;
  one that finds the room already moved changes nothing, so a double click, a race with the
  countdown, or a stale tab advances once. Watch credits is `rooms.cancelNextCountdown`: the card
  goes away for everyone and the countdown cannot start again for that episode. A guest's Close
  hides only their own card; they still move on with the room.
- Moving on (and the host's Episodes picker, which uses `rooms.setMedia`) switches the room's
  media paused at the start with the next revision and clears its countdown. Each member's player
  sees the new media in the room record and opens it in place (`/watch/...?room=`), keeping the
  room, its link, and its membership; it never starts solo playback. Every member plays it with a
  session of their own, so progress stays per profile, with their own quality and track choices.
  The room plays when the host's player does; members slower to load join at the live position,
  as late joiners do, and nobody waits for them. A countdown due while the host is away still
  moves the room on, paused, until the host's player is back. The room engine of a player still on
  the old file goes `moved` and stops following and commanding, and host controls and heartbeats
  name their file (`fileId`), so a player the room moved on from never moves the new file's clock;
  the server refuses such a control as `stale_revision`. The countdown, its cancel, and Play next
  name the episode they act on (`fromEpisodeId`) for the same reason.
- Episodes share their show's rating and library, so a member who may watch one episode may watch
  the next. The next episode's file missing from disk stops the countdown (`conflict`): the host's
  card says so and only closes. After the last episode there is no card. A member whose profile
  cannot see what the host switched to (another title, through `setMedia`) gets "Not available on
  this profile" instead of the player, keeps their place with away heartbeats, and is taken back
  to the room once it plays something they may watch (`rooms.current` says when, as a failed
  `rooms.get` stays failed until read again).

## Backups and restore

- The media service owns both: a nightly Convex cron queues a `backup` job, which runs
  `convex export --include-file-storage` into `BACKUP_DIR` (renamed into place only on success,
  pruned past `BACKUP_RETENTION_DAYS` only after a new backup succeeds). `POST
  /api/backups/restore` (admin) runs `convex import --replace-all`, re-registers the service key,
  then `maintenance:settleRestoredJobs` and `maintenance:endAllSessions` (a snapshot carries
  working sessions). Deployment environment variables are not part of an export. The procedure,
  including recovery without the media service, is in `docs/operations.md`; the round trip in
  `docs/spikes.md`.
- Both installs back up before deploying a new version's functions.

## Migration from Jellyfin and Plex

- Sources are in-repo migration-source plugins in `apps/media/src/migration/` (Jellyfin 10.8 or
  later, Plex Media Server 1.24 or later), behind one typed contract (`source-plugin.ts`). A
  plugin's manifest names role `migration-source` and the one host it may reach; the HTTP client
  it gets refuses other hosts, methods other than GET, and POSTs other than Jellyfin's
  `/Users/AuthenticateByName`. Plugins never read, move, copy, or link media files: import adds
  the same folders as [movies] libraries in place (`migrationService:ensureLibrary` queues their
  scans).
- Jellyfin signs in with an API key or an administrator's user name and password. Plex takes a
  local server token (`X-Plex-Token`); plex.tv is never contacted. A Plex server token reads the
  owner's positions but only the play history of other local accounts, so those import watched
  marks, play counts, and last-played dates (`history: "plays"`). Plex has no favorites.
- Flow: `migration.connect` → `migration.dryRun` → `migration.import` (media commands, scope
  `admin`) → `migration.status` (Convex query). Source failures are results, not command errors:
  `{ status: "failed", reason, message }` with `unreachable`, `auth_failed`, `not_admin`,
  `version_unsupported`, or `unexpected_response`, for the "Couldn't connect" screen. A connection
  lives in the media service's memory for an hour, private to the admin who opened it. An import
  requires a dry run of the same connection with the same user mappings, and queues exactly that
  plan.
- Access: a library the import adds is open to everyone only when every source user could see the
  source library. Otherwise it is restricted and granted to the accounts whose profiles receive an
  imported user's history, for the imported users who could see it. When the source does not say
  who sees a library (Plex: a local server token cannot read sharing, which plex.tv holds), it
  starts admins-only. The plan stores this per library (`PlannedLibrary.access`), and
  `ensureLibrary` reads it from the stored plan, never from its caller; plans stored before it
  existed also add admins-only libraries. A library the import reuses keeps its access.
  Jellyfin reports it through each user's `EnableAllFolders` and `EnabledFolders` policy. The
  Review screen says who each new library is shared with.
- Users are never created. Each source user is suggested a profile of an existing account (same
  email, then same account name, then same profile name) or `invite`; the admin may choose a
  profile or `skip` per user.
- Paths: a source path maps through the longest matching `from` prefix of the path mappings, or
  stays as is when it already lies inside `LIBRARY_ROOTS`. Without a mapping, connect infers one
  per library folder when a folder ending in the same one or two names exists under a root
  (`/data/movies` → `/mnt/nas/movies`). Paths compare after normalizing slashes, trailing slashes,
  and Unicode (NFC); Windows drive paths compare without case.
- Matching: the mapped file path first, then provider IDs (TMDB, IMDb, TVDB); episodes match
  through their show (by folder, IDs, or another episode matched by path) and season and episode
  numbers. Items in folders the import adds wait for the first scan and match by path then;
  unmatched items carry a reason (`path_unmapped`, `not_in_catalog`, `no_path`), and the dry run
  lists up to 25.
- Writes are idempotent and safe to repeat: progress is replaced only when [movies] has none or
  the source played the item more recently (otherwise [movies] keeps its own, counted as
  `keptLocal` and as a dry-run `conflict`); a watched mark is only ever added; play counts only
  grow; favorites of movies and shows go to My List; a collection is keyed by source, server ID,
  and collection ID and its members are replaced; source overrides never replace an override made
  in [movies].
- The import is a `migration` job on the media service's job worker. Its plan and checkpoint
  (phase, unit, cursor) live on the job's `migrations` row; it writes batches of at most 100 and
  checkpoints after each, so a job resumed after a crash rewrites at most one batch. Phases:
  `libraries`, `scanning` (waits up to six hours for new libraries' first scans), `watchState`,
  `collections`, `overrides`. Counts are what the job imported, counted as the dry run counts them.
  One migration per source server runs at a time. Cancelling the job stops it at the next lease
  renewal.
- Secrets: connection credentials stay in the media service's memory and are never logged; source
  requests run without HTTP client tracing because Effect does not redact `X-Plex-Token`. A job
  must survive a restart, so its stored plan carries the credentials sealed with AES-256-GCM under
  a key derived (HKDF-SHA256) from `MEDIA_SERVICE_API_KEY`, bound to the server ID and URL. Convex
  functions and their tables hold only that key's hash, so no Convex function, user, or backup can
  open them. `scripts/configure.ts` keeps the key itself in the deployment's environment variables
  so restarts reuse it; whoever holds the deployment's admin key can read it there, and already
  controls everything else.
  Rotating the key makes queued plans unreadable; their jobs fail and the admin imports again.
- Web screens (`/admin/migration`): Connect runs `migration.connect` then `migration.dryRun`, and
  shows a source failure under the field it concerns. Review maps each source user to the
  suggested account's profile, one of the admin's own profiles, or skip, and maps a source folder
  the host lacks to a local one; each change runs the dry run again (a folder mapping reconnects
  with the typed key, which stays in page memory only), so Import always matches the last dry run.
  A running import is pinned to the URL (`?job=`), so the page lands on Done. Job progress
  restarts at every phase, so the bar weighs the phases.
- The web migration suite imports from the recorded Jellyfin server by default and from a real
  Jellyfin in Docker with `MEDIA_JELLYFIN_DOCKER=1`, as CI runs it; both are served by
  `apps/media/scripts/serve-jellyfin-source.ts` over the generated fixture library.

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
  otherwise (`w-110`). `apps/web/src/lib/design-tokens.test.ts` fails on a spacing step outside
  both lists, on Tailwind's own text, radius, shadow, weight, leading, and tracking sizes, and on
  a raw length inside an arbitrary value. `--color-page` is the page canvas: `bg` in light,
  `dark-bg` on dark phones, `dark-surface` on dark desktops, as Paper draws them.
- Chrome over artwork (hero, player, phone glass) uses the `on-media` utility, which remaps the
  text and state roles to their dark twins so it stays white in both themes.
- `cn` knows the Paper theme scale (`packages/ui/src/lib/utils.ts`); without it, custom sizes such
  as `text-micro` merge away next to colors such as `text-danger`.
- Desktop layout starts at `md` (48rem). Rows switch layouts with container queries, so they also
  fit narrow panels.
- Keyboard shortcuts are listed once in `apps/web/src/lib/keymap.ts` and resolved by
  `@media/ui/lib/keymap` (`mod` is `⌘` on Apple devices and `Ctrl` elsewhere). The command menu
  draws its keycaps from that registry. Sequences such as `g h` wait one second for the next key.
- The command menu takes a typed page model (`@media/ui/lib/command-menu`): groups scoped to
  browsing or searching, fuzzy or caller-ranked filtering, actions (sync or async) and submenus
  that replace the list in the same panel, running-job progress, and fallback commands for no
  results. Rows come from the web app's feature contributions (see Web app), which run registry
  commands through the SDK; registry entries are not mapped onto the menu one to one.
- The component gallery at `/dev/kit` is development-only; production builds replace it with an
  empty route and do not bundle it. So is the track menu bench at `/dev/tracks?columns=1|3|4`:
  the player's track menu over a still frame with thirty-two subtitles and long labels, which the
  `kit` E2E project checks at desktop, short, phone, rotated, doubled-text, and full screen sizes.
- The player's track menu always opens above its trigger (`collisionAvoidance` `side: "none"`):
  Base UI would otherwise flip a tall panel below or beside the trigger, over the controls or off
  the screen. Its height is held to Base UI's `--available-height` and `--spacing-track-panel`, its width to
  `--available-width`. The app does not opt into `viewport-fit=cover`, so browsers keep the page
  out of the safe areas; adopting `cover` would need a collision padding that reads the insets. Each column's heading stays fixed
  while its options scroll on their own (`overscroll-contain`), columns wider than the screen
  scroll sideways, and long labels wrap. Each column shows its chosen option when the menu opens
  and when the choice or the option ids change, and keeps it in view as the list resizes unless
  the viewer scrolled it away.

## Web app

- Every screen reads and writes through `@media/sdk/react` (`useCommandQuery`, `useCommand`,
  `useAuth`); components never name Convex functions.
- Guards are components, not router `beforeLoad`, because the session lives in the SDK:
  `RequireSignedIn` sends people to `/welcome` before the owner exists and to `/sign-in?redirect=`
  after; `RequireProfile` sends them to "Who's watching?" or the profile's PIN and provides
  `useActiveProfile()` (the profile and its account's profiles). Pass `profile.id` to every
  profile-scoped command.
- The chosen profile is per browser (`localStorage` key `movies.profile`, through
  `useProfileChoice`); signing out forgets it. PIN unlocks stay per session on the server, so a
  remembered PIN profile asks for its PIN again in a new session. PINs set from the web have four
  digits, as Paper draws the boxes.
- The command menu's root list is collected from `src/commands/`: each feature exports a
  `use<Feature>Commands(context): CommandContribution` hook (groups and "No results" fallbacks),
  and `src/commands/index.ts` calls them in menu order. Groups with the same id merge, so features
  add rows to "Actions" or "Go to". `mod+shift+p` opens the menu on its "Switch profile" submenu.
  The player screen owns its commands and passes them as the context's `player` (null elsewhere)
  rather than through React context, which a component cannot read from a provider it renders.
  In a room, guests get the track lists but no transport; the host gets End room and no Leave room.
- Escape on the player does one thing per press. An open menu, popover, or dialog takes it first;
  in full screen it only leaves full screen (a press made before full screen ended, by event
  time, but delivered after counts as that one); then it closes Stream info; otherwise it asks
  "Leave playback?". Solo playback pauses while it asks and resumes on Stay (a room, named in the
  URL, plays on). Stay, Escape, and a click outside keep playing, and repeats of a held Escape
  never close it. The Back button and the phone's Close leave directly. The player's menus,
  popovers, and dialogs always render inside the player, so they show in full screen and stay put
  when it ends.
- Title search lives in the menu (results while typing) and on `/search` (the full page Paper
  draws; the phone tab bar's search circle opens it). Kids filtering is server-side; the web app
  shows no notice. The menu keeps earlier results on screen only while the same query is typed
  further or shortened; a replaced query clears them, so Enter never opens a stale result.
- Artwork loads through `artworkUrl` from `@media/contracts/artwork` against `VITE_MEDIA_BASE_URL`
  (this origin when unset), resized per use (`?w=185` thumbnails, `500` posters, `780` cards,
  stills, and logos, `1280` backdrops), as lazy images over a fixed-aspect raised placeholder; a
  missing or failing image leaves the placeholder.
  Avatars are app assets in `public/avatars/<key>.svg`; the profile stores the key.
- Play and Resume link to `/watch/$titleId?episodeId=&start=0`, which the playback milestone fills,
  with `version=<fileId>` when the title page's Version select offers several files. A version
  switched in the player replaces `version` in the URL without remounting the player.
- Signing out navigates to sign-in itself; `RequireSignedIn` stays blank while the location is
  already `/sign-in` rather than racing that navigation with its own redirect.
- The stack E2E suite (`apps/web/e2e/stack`) runs the real media service: it generates a fixture
  library (ffmpeg clips, NFO files with certifications, artwork drawn in the browser), bundles
  `apps/media`, and starts it against the dev stack. A scan of a folder outside `LIBRARY_ROOTS`
  is the real failure path; the suite then restarts the service with that folder approved and
  retries. Fixture names are plain: Convex search matches any query term, so a shared run token in
  every name made every title match every search.

## SDK

- `@media/sdk` runs on three Convex clients through one transport: the WebSocket `ConvexClient`
  for apps, `ConvexHttpClient` for short-lived processes (subscriptions poll), and the app's
  `ConvexReactClient` in React. Functions are called by registry path with `makeFunctionReference`.
- The SDK avoids Effect modules marked unstable, which the repo's lint rejects: media service
  requests use the platform `fetch`, and tests use plain Vitest with `TestClock`.
- Sign-in and token refresh go through a private `ConvexHttpClient`: the WebSocket client waits
  for its token before running calls, so refreshing through it would wait on itself.
- `MoviesProvider` creates and disposes its runtime in one effect, so React's development double
  mount never leaves a disposed runtime in use; children render once the runtime exists.
- The Promise facade and React commands reject with the same tagged errors the Effect API fails
  with; React queries return a `loading | success | error` state instead of throwing.
- The room engine's host publishes the difference between its player and the committed clock, not
  raw player events, so the engine's own corrections never echo back as commands. The host moves
  its player onto the committed clock only after a stale or rejected command or a reconnect; its
  own commands reach the subscription before their results do.

## Account and admin screens

- Settings, admin, and migration screens share one frame: the account's own sections, then the
  server sections its scopes open (`manage` for libraries, `admin` for users, migration, and
  backups). Routes also check scopes and show a calm state to sessions without them; the server
  still refuses every call it should, so the check only spares people broken screens.
- A new API key's secret lives only in the open "Copy your new key" dialog's state. Closing the
  dialog drops it; it is never logged, stored, or put in the URL.
- The library detail screen lists files with `libraries.files` (paged by path, or only missing
  files, or the files of unmatched titles) and counts problems with `libraries.fileSummary`, which
  reads the `by_library_missing` and `by_library_status` indexes instead of scanning the library.
- A scan that fails with the scanner's "Library root unavailable" or "Library folder unreadable"
  error shows the NAS-offline state. Other failures show as Failed on the libraries list.
- The device approval page grants `read` and `play` unless the approver changes it; it offers only
  scopes the approving session holds.
- Fix match treats a search the media service answers with `Internal` (no metadata provider, or
  one that failed) or cannot reach as search being unavailable, and keeps hand edits working.
  `RateLimited` asks to try again; other failures show their message. Only unmatched files carry a
  Fix match button; a matched file's title opens the same screen.
- Dialogs the command menu opens live in the URL: `/settings/api-keys?dialog=create` and
  `/admin/libraries?dialog=add`. Menu entries follow the session's scopes, like the settings list.
  A query shaped like a device code (`HD5R-5GTL`) offers to approve it.
- The admin browser suites (`apps/web/e2e/admin`) run as a Playwright project that depends on the
  stack project and sign in as the owner it creates, so both share one fresh stack without racing
  for the first owner. Library scans run on the real media service with generated clips, and the
  backups suite runs a real backup job in its own project last, since each suite that runs a
  media service owns the stack's port while it runs: the service exports the stack into its backup
  folder.
