# 0010. Serve HTTP with Effect HttpApi and sign the server in as a service principal

- Status: Accepted, 2026-11-03. Amended 2026-11-06 with the server's key and its rotation, and
  2026-11-10 with the server's core adapters.
- Decisions: D24, D25

## Context

Movies' media service is Node with Effect HttpApi, and its routes are declared in shared contracts
in `packages/contracts`. Music's media service uses Hono.

Movies' media service signs in to Convex through the `apikey` provider with `MEDIA_SERVICE_API_KEY`.
The key belongs to a `service` account, and its grant carries only the `media-service` scope.
Music's media service passes a shared secret (`MEDIA_SERVICE_SECRET`) to Convex as a function
argument. That secret shows in Convex logs, cannot be scoped, and cannot be rotated.

## Decision

- The server's HTTP layer is Effect HttpApi with shared contracts, as in movies. Hono goes.
- The server signs in to Convex as a service principal with a scoped API key, as in movies.
  Music's secret-as-argument goes.

## The server's key as built (amended 2026-11-06)

- The server signs in as a service from `core/accounts/host:createService`. The operator issues
  its key with the host function `core/auth/apiKeys:issueServiceKey`, run with `convex run`. It
  returns the key `mk_<id>.<secret>` once, and the core keeps only the secret's SHA-256 hash. The
  key holds the `media-service` scope (ADR 0005) and does not expire.
- Rotation overlaps. A new key works beside the earlier ones until its first sign-in, which
  deletes every key of the service made before it and ends their sessions. The operator puts the
  new key in the server's secret and restarts the server, and the running server keeps working
  until the new one signs in. An earlier key that signs in again never ends a newer one.
- `retire: "now"` ends every earlier key of the service and its sessions in the same transaction
  as the issue, for a key that leaked.
- A service holds at most four working keys. A fifth issue is a `conflict` that tells the
  operator to sign the server in with its newest key or issue with `retire: "now"`. Without the
  cap, issues that never sign in would pile up keys that all still work.
- Every command refuses a service session with `forbidden`. No server function is public until
  the server moves onto the core in phase 4 (D50): the lint allows no public function outside the
  command list. Until then a stack test proves the sign-in through `auth:signIn` and the internal
  `core/serviceProbe:whoami`.
- `apps/media/src/core/core-session.ts` signs the server in to the core with its key through the
  SDK's platform client. It retries with backoff until the core accepts the key, logs a refusal
  without the key, and signs in once more when a call answers `Unauthenticated`. Nothing starts it
  and no `MEDIA_` setting holds the key until phase 4.
- The Convex function log holds neither the key nor its secret. A stack test reads the log across
  an issue, a sign-in, a refused sign-in, and a rotation.

## The server's core adapters (amended 2026-11-10)

`p4-server-core` built the server's half beside the old movies wiring. `main.ts` still wires old
movies, so the running server holds one Convex URL (D50); `p4-movies-cutover` switches it.

- `apps/media/src/core/core-wiring.ts` composes the server on the core: `CoreSession` with the
  service key, the job worker on the core's worker protocol, the file resolver, ticket admission
  on every byte route, the server status report, and backups. It takes the core's URL, the key,
  and `MEDIA_TICKET_KEYS` as arguments. The settings that hold them land with the cutover, which
  adds them to the image, Compose, the NixOS module, and both READMEs.
- The core's server functions are declared once in `@media/contracts/server-functions` with Effect
  Schema, in the shape the SDK's platform client runs. `CoreSession.call` and `CoreSession.watch`
  run them as the service. They are not SDK methods or CLI commands; the SDK exports its client
  (`Platform.Client`) only so the server can run a declaration it did not generate.
- `CoreSession` signs in again once when a call answers `Unauthenticated`. A refused sign-in wakes
  one sign-in loop that retries with backoff and reads the session's state on every try. Before,
  each refusal started a backoff fiber bound to the generation it saw, unless one already ran: a
  fiber from before a later sign-in then skipped every try and ended, leaving the server signed
  out after the next refusal. A unit test that failed before the fix covers it.
- A watch that fails or ends resubscribes with backoff, and signs in again first when the core
  answered `Unauthenticated`, so a pool or a session watch never stops on its own.
- `/api/health` reports the core as `connected` while the server is signed in and the core
  answered its latest probe, every 30 seconds, as old movies' backend probe did.
- Backups on the core export the core's deployment with its admin key and Convex folder, which
  the caller passes; until the cutover's settings exist they fail as unavailable, naming them.
  The core has no restore yet: old movies' restore runs maintenance functions the core lacks, and
  nothing in the core wiring serves the restore route. The cutover brings both.
- Left for the cutover, each because it changes what the running server serves or which
  deployment a client talks to: TMDB match-candidate search stays the server's own route, which
  calls TMDB itself and needs no server function, and moves onto the core's caller check when the
  cutover replaces old movies' viewer check on the command routes; old movies' playback-mode
  reports have no core function, so on the core the server only logs them; and rescans after a
  file changes need a core function that queues a scan (ADR 0024).

## Consequences

- Clients, the SDK, and the server share one typed description of every HTTP route.
- The server's Convex access is limited to the scopes on its key, and the key can be rotated.
- Music's routes are rewritten onto HttpApi during the music port (phase 5).
- Convex still never calls the server. The server subscribes outward (`docs/architecture.md`).

## Alternatives rejected

- Hono for the server. Effect HttpApi with shared contracts replaces it.
- A shared secret passed as a function argument. It shows in Convex logs, cannot be scoped, and
  cannot be rotated.

## Edge cases settled

- A service principal is a principal type of its own, not a user with a role (ADR 0005).
- A leaked server key reaches only what its scopes allow.
- A server still running on a rotated key loses its session at the new key's first sign-in. Its
  next call answers `Unauthenticated`, its sign-in again is refused, and it stays signed out.
- A key issued for a person's id is `not_found`.
