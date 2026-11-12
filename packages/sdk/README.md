# @media/sdk

The client core shared by the web clients, the iOS app, the CLI, and the media service. No Node
built-ins or DOM globals in shipped sources (`import-boundary.test.ts`).

It holds one client for the core's Convex project (`packages/platform`), the platform client, and
calls to the media service's own routes:

- **The platform client.** The generator in `packages/commands` gives every command a method at
  its name's path, so `core.server.info` is `platform.core.server.info()` and
  `movies.titles.list` is `platform.movies.titles.list(args)`.
- **The media service.** Playback, downloads, and the media service's own commands
  (`@media/contracts/media-commands`), sent with the session's token as a bearer.

Arguments are encoded and results decoded with each command's schemas. Failures are the contracts'
tagged errors plus `TransportError` and `ProtocolError`.

| Entry point          | For                                                               |
| -------------------- | ----------------------------------------------------------------- |
| `@media/sdk/effect`  | Effect programs: services, layers, workflows                      |
| `@media/sdk/react`   | React: a provider and hooks                                       |
| `@media/sdk/promise` | Everything else: a Promise facade that rejects with tagged errors |

## Platform

Every sign-in goes through the media service's sign-in boundary (ADR 0007), so each client names
it: `signInUrlFor(serverUrl)`, or `signInUrlBeside(platformUrl)` in an install that serves the
core at `<server>/convex`.

```ts
import { Platform, TokenStorage } from "@media/sdk/effect";

const program = Effect.gen(function* () {
  const platform = yield* Platform.Platform;

  yield* platform.session.signIn(
    Platform.Credentials.Password({ username, password: Redacted.make(password) }),
  );

  const { name } = yield* platform.core.server.info();
  const me = yield* platform.core.auth.sessions.current();

  yield* platform.core.auth.sessions.end({ sessionId: me.sessionId });
}).pipe(
  Effect.provide(
    Platform.layer({
      url,
      connection: "http",
      storage: TokenStorage.layerMemory,
      signIn: Platform.SignInRoute.Boundary({ url: Platform.signInUrlFor(serverUrl) }),
    }),
  ),
);
```

```ts
import { createPlatform, signInUrlFor } from "@media/sdk/promise";

const platform = createPlatform({ url, signInUrl: signInUrlFor(serverUrl), connection: "http" });
const { name } = await platform.core.server.info();
```

```tsx
import { PlatformProvider, usePlatform, usePlatformQuery } from "@media/sdk/react";

<PlatformProvider url={url} signInUrl={signInUrl} storage={window.localStorage}>
  <ServerName />
</PlatformProvider>;

const ServerName = () => {
  const info = usePlatformQuery(usePlatform().core.server.info);

  return info.status === "success" ? <h1>{info.data.name}</h1> : null;
};
```

- Every command `domain.module.fn` is the method `platform.domain.module.fn(args)`. Hover it for
  the command's summary, kind, scope, and whether it refuses API keys. A command whose arguments
  are all optional takes none. Queries also have `watch`: a `Stream` in Effect, a `QueryWatch` in
  Promise code and React.
- IDs are typed by table (`Platform.Id<"authSessions">`), so an ID from a result passes into
  another command's arguments and an ID of the wrong table does not type-check.
- Calls fail with `PlatformError`: a session without the command's scope gets `Forbidden`, and a
  session that was ended elsewhere gets `Unauthenticated`.
- `platform.session` signs in, signs out, and reports `status`. `Credentials` covers a password,
  an API key, the first account (`Setup`), an invite, a reset link, a shared device's tile, and a
  device grant. In Promise code and React these are `session.signInWithPassword`,
  `signInWithApiKey`, `setUpOwner`, `acceptInvite`, `resetPassword`, `openTile`, and
  `exchangeGrant`. `startDeviceSignIn(clientName)` starts a device sign-in: show its `userCode`,
  then `complete` waits until a signed-in session approves it, or fails with
  `DeviceSignInRefused`. Tokens refresh by themselves through the session engine in `Auth`.
- Clients that store their session under one key share one sign-in, as the web clients on one
  origin do (`media.session` by default). Pass the same `storage` object on every render. Browser
  tabs share a `SharedStore` from `openIndexedDb` instead of a store each tab owns.
- `usePlatformQuery` follows a query and returns a `QueryState` (`loading`, `success`, or
  `error`); pass `"skip"` in place of the arguments to wait. `usePlatformStatus` gives the
  session's status.
- `src/platform/generated/` is written by `pnpm --filter @media/commands generate`. Never edit it.

## The media service

```ts
import { createMediaServer } from "@media/sdk/promise";

const media = createMediaServer({ url: mediaUrl, session: platform.session });
const folders = await media.run("libraries.folders", {});
```

- `createMediaServer` runs a media command by name, reports an app's unexpected errors
  (`reportError`, `reportCaught`), and sends a player's diagnostic events
  (`reportClientEvents`). With `session`, a refused call refreshes once while the session is still
  the one it went out with. In Effect, `MediaRoutes.run` does the same, and `MediaRoutes.logs`
  reads the retained log.
- `Playback`: `negotiate` (a stream of a started playback's file), `seekStream`, `stop` and
  `stopNow`, `autoplayCountdown`, `PROGRESS_INTERVAL_MS`, and `recoveryFor`, which maps each
  playback API failure (`@media/contracts/media-playback`) to what the player does next:
  `reload-playlist`, `renegotiate`, `renew-token`, `new-session`, `retry-later`, `unsupported`,
  or `fail`. On the core, `renew-token` and `new-session` both mean a new `movies.play.start`,
  since tickets are never renewed (ADR 0011).
- `Downloads.prepare` asks the media service where a download stands.
- `PlayerDiagnostics` records a player's startup, stalls, and recoveries and reports them.
- `Versions` orders a title's files (`preferredVersion`) and `MediaLabels` names their facts.
- `MediaOrigin`: playback and download requests go to the public URL the playback names unless
  this reference is provided, as the CLI does with its configured media URL. The URLs the service
  answers with, such as `stream.url`, stay public either way.
- `PlayerPort` and `PlayerEvent` type a player as the SDK reads it, such as the iOS app's video
  player for `PlayerDiagnostics` and its progress reporter.
- `ConvexTransport`: `layerWebSocket` for apps, `layerHttp` for short-lived processes.
  `TokenStorage`: `layerMemory`, `layerKeyValue(store, key)` for `localStorage` or AsyncStorage,
  or any implementation (the CLI stores a file).

## Tests

`pnpm test` runs the unit suites. `pnpm --filter @media/sdk test:stack` runs the SDK against the
dev stack from `scripts/dev-stack.sh up`.
