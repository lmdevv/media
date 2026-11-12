# Spikes

Results of the first-week checks the architecture asked for. Each section records what was run,
against which versions, and what it showed. Add a section per spike; keep the headings stable.

## Convex runtime, auth, export/restore

Run 2026-10-12 against the self-hosted backend started by `scripts/dev-stack.sh`
(`ghcr.io/get-convex/convex-backend:latest`, then digest `sha256:d715e9ec…`; every install and the
dev stack now pin it in `deploy/convex-backend.image`, from `ghcr.io/convex` since Convex moved it), `convex` 1.46.0, `@convex-dev/auth` 0.0.96,
`@auth/core` 0.41.3, Node 24.20.

### HMAC playback tokens in the Convex runtime

- **Result: works in every function type.** A throwaway module ran `crypto.subtle.importKey`
  (raw, HMAC SHA-256), `sign`, `verify`, and `digest("SHA-256")` in a query, a mutation, and an
  action; each produced the same signature as Node's `createHmac` for the same key and message.
  `btoa`/`atob` and `crypto.getRandomValues` are present too. `Buffer` is not.
- **Choice:** `playback.createSession` is a single **mutation**: it authorizes, writes the
  session, and signs the token in one transaction. No action wrapper is needed.
- **Proof, in old movies' backend until `p4-movies-delete` deleted it:** its
  `test/registry.test.ts` checked that the Convex signer (`convex/lib/playbackToken.ts`)
  reproduced `PLAYBACK_TOKEN_TEST_VECTORS` byte for byte, and its `test/stack.test.ts` verified a
  token minted by the live backend with the contracts verifier (`verifyPlaybackToken`) and the
  stack's `PLAYBACK_TOKEN_SECRET`.
- **Randomness:** `getRandomValues` in mutations returned different values per call, but Convex
  documents query and mutation randomness as seeded for determinism. Secrets (API keys, invite
  codes, device codes) are therefore minted in **actions** that call an internal mutation; only
  PIN salts come from mutation randomness.

### Convex Auth: password, API key, and device flows with scoped revocation

- **Result: works.** Verified by `pnpm --filter @movies/backend test:stack` (22 tests).
- `ConvexCredentials.authorize` may return an existing `sessionId`, and Convex Auth then issues
  tokens for that session instead of creating one. The `apikey` and `device` providers create (or
  reuse) the session themselves in an internal mutation and store the **grant on the
  `authSessions` row** (the table is redefined with an optional `grant` field). A restricted
  session therefore cannot outlive its grant as an unrestricted one; password sessions have no
  grant and hold their role's scopes.
- Convex Auth JWTs last an hour, so every public function loads the session row: deleting it
  (sign-out, key revocation, `sessions.revoke`, disabling the account) cuts off its tokens at once.
  The stack tests confirm a revoked key's token fails with `unauthenticated` on the next call and
  the key no longer signs in, and a revoked device session fails the same way.
- A deliberate regression (ignoring grants in `sessionScopes`) fails the API key and device tests,
  so the suite guards this seam.
- Device codes are consumed in the same transaction that creates the session; the second sign-in
  with a code returns no session. Expiry was checked by importing an approved code whose
  `expiresAt` had passed (the suite uses `convex import --append`): `deviceAuth.status` reports
  `expired` and sign-in is refused.
- The built-in `Password` provider's `profile` callback receives untyped params and must return
  typed fields synchronously, which would need a `typeof` or a cast. The `password` provider here
  is a small `ConvexCredentials` that parses params through an internal query's `v` validator and
  calls Convex Auth's `createAccount`/`retrieveAccount` with lucia's Scrypt, the same hashing the
  built-in provider uses. Convex Auth's failed-sign-in rate limit still applies.
- The generated `DataModel` does not satisfy `GenericDataModel` under
  `exactOptionalPropertyTypes` (TS2344), so the providers use `ConvexCredentials` without the
  `DataModel` type argument; all other Convex code compiles with the strict flag.

### `convex export` / `convex import` round trip

Ran `convex export --include-file-storage` against the test stack after the suite had run, then
`MOVIES_STACK=restore-spike scripts/dev-stack.sh up` and `convex import --replace-all --yes` of
the ZIP into the fresh stack.

- **Export:** 40 KB ZIP in under a second, one folder per table: every application table and
  every Convex Auth table (`authAccounts`, `authSessions`, `authRefreshTokens`, `authRateLimits`,
  `authVerifiers`, `authVerificationCodes`), plus an empty `_storage`. Deployment environment
  variables (JWT keys, `PLAYBACK_TOKEN_SECRET`, `MEDIA_SERVICE_API_KEY`, `SITE_URL`,
  `MEDIA_BASE_URL`) are **not** in the export; scheduled functions are not either (crons come
  back from code).
- **Import:** 340 documents in about two seconds. Users, libraries, titles, files, and history
  were present; `setup.status` reported an owner; the owner signed in with their password (the
  password hashes travel in `authAccounts`; the new deployment's JWT keys sign the new tokens).
- **Sessions survive a restore.** A refresh token taken from the snapshot was accepted by the
  restored deployment even though its JWT keys differ. The restore procedure must end them:
  `convex run maintenance:endAllSessions` (added for this) signed out 35 sessions, after which the
  old refresh token was rejected and password sign-in still worked.
- **Media service key after restore:** the snapshot's `apiKeys` table replaced the one holding
  the restored deployment's own service key hash, so the service could not sign in until
  `scripts/configure.ts` ran again (it re-registers the key from `MEDIA_SERVICE_API_KEY`).
  Restoring into the same deployment, whose environment still holds the matching key, does not
  need this, but running `configure.ts` after every restore is harmless and covers both cases.
- **Restore procedure** (for the media service's `backups.restore`): stop writes, `convex import
  --replace-all --yes <zip>`, `convex run maintenance:endAllSessions`, run `scripts/configure.ts`,
  then verify sign-in, library access, playback, and history. Keep the deployment environment in
  the separately protected recovery store; the export does not replace it.
- The spike stack was destroyed afterwards (`MOVIES_STACK=restore-spike scripts/dev-stack.sh
  destroy`).

## Effect HttpApi media serving

Question: can Effect 4.0.3 (`effect/http`, `effect/http-api`, `@effect/platform-node` 4.0.3) on
Node 24 serve media bytes correctly, or do media bytes need raw Node handlers?

Verdict: **Effect serves media bytes correctly.** The media service keeps one Effect server:
HttpApi for the control endpoints (`/api/...`) and `HttpRouter` routes for bytes (`/media/...`),
which `<video>` elements and HLS players fetch by URL. No raw Node fallback is needed.

Measured on the owner's box (Node 24.20, localhost, warm page cache, 2026-10-12).

### Byte ranges

- `HttpServerResponse.file(path, { status: 206, offset, bytesToRead })` streams through
  `fs.createReadStream({ start, end })` and `stream.pipeline` into the socket. Nothing buffers
  the whole file: serving a 256 MiB file to a reader that pulls slowly kept RSS flat.
- 206 with the right `Content-Range`, suffix ranges (`bytes=-N`), and 416 with
  `Content-Range: bytes */size` all behave as RFC 9110 requires; returned bytes match the file.
- Client disconnects: `NodeHttpServer` interrupts the request fiber when the response closes
  early, which aborts the pipeline and destroys the read stream. After 50 aborts mid-body, open
  file descriptors returned to the baseline.
- Time to first byte for a 1 MiB range at offset 128 MiB of a 256 MiB file: 0.83–0.99 ms over
  five runs. A full 256 MiB response took 0.265 s.
- Gaps found and handled in the service: the Node platform adds a weak `ETag`, which cannot
  satisfy `If-Range`, so direct play sets its own strong validator; the router has no `HEAD`
  method, so the direct route is registered for `*` and checks the method (Node then sends
  headers only); Effect's server spans record `url.full` and `url.query`, which would leak
  playback tokens, so built-in spans are disabled for `/media/` and those routes record their own.

### HLS segments as they are produced

ffmpeg writes fMP4 HLS with `-hls_flags temp_file`, so a fragment file appears only when it is
complete; the service serves each one as soon as it exists.

| Path (30 s 1080p H.264 source)                              | Time to first segment |
| ----------------------------------------------------------- | --------------------- |
| Remux (`-c copy`)                                           | 149 ms                |
| libx264 `veryfast`                                          | 1.18 s                |
| Intel QSV `h264_qsv`, hardware decode and encode (Arc A380) | 665 ms                |

QSV encoded the whole 30 s clip in 1.63 s (about 18× real time).

Findings that shaped the stream design:

- Seeks restart ffmpeg at the requested segment. To keep every generation on the source
  timeline, the service uses `-copyts` with `-hls_segment_options movflags=+frag_discont`;
  without `frag_discont` a restarted run resets `tfdt` to 0, and `-output_ts_offset` alone did
  the same in fMP4 HLS.
- `-hls_time` cuts on a running grid from the run's first packet, so a restarted copy run cuts
  differently from the first run. The service instead asks ffmpeg for one fragment per keyframe
  (`-hls_time 0.1`) and groups fragments into planned segments by their first video sample's
  presentation time (`tfdt`, `trun`, and the init segment's edit list). Not by `sidx`: ffmpeg 8.0
  writes its earliest presentation time one frame late for runs from the start of the file.
- `-force_key_frames expr:gte(t,n_forced*4)` skipped a keyframe under `-copyts`; an explicit list
  of segment start times is exact.
- Copy-mode segment plans need source keyframe times. An ffprobe packet scan reads the whole
  file (8.8 s for a 1.9 GB MKV on the HDD, about 220 MB/s). Reading the Matroska Cues index
  found the same 3,722 keyframes in 19 ms with 15 reads (144 KB). Other containers fall back to
  the scan once and cache the result.

### Intel QSV on the Arc A380

- The default nixpkgs `ffmpeg` 9.0.1 is built with `--disable-libvpl`: VAAPI encoders exist,
  QSV encoders do not. nixpkgs `ffmpeg-full` 9.0.1 (a 77 MiB download from the binary cache)
  has `h264_qsv`, `hevc_qsv`, `av1_qsv`, `vp9_qsv`, and `vpp_qsv`, and loads the iHD driver from
  `/run/opengl-driver`. The dev shell now uses `ffmpeg-full`.
- Verified for real: QSV H.264 encode, hardware decode of H.264 and HEVC Main 10, and
  `vpp_qsv=tonemap=1` turning HDR10 HEVC into BT.709 H.264 (an end-to-end test runs when a QSV
  test encode succeeds; CI has no GPU and skips it).
- A failing QSV run (for example a missing render node) falls back to software when the ladder
  allows it and reports the mode change; this path is tested everywhere.
