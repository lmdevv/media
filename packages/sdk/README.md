# @media/sdk

The client core shared by the web app, the CLI, and later the native apps. No Node built-ins or
DOM globals in shipped sources (`import-boundary.test.ts`).

It holds two clients side by side until movies moves onto the platform (phase 4):

- **The platform client** talks to the platform deployment (`packages/platform`). The generator in
  `packages/commands` gives every command a method at its name's path, so `core.server.info` is
  `platform.core.server.info()`.
- **The movies client** talks to the movies backend (`packages/backend`). Its calls are typed by the
  command registry in `@media/contracts`.

Arguments are encoded and results decoded with each command's schemas. Failures are the contracts'
tagged errors plus `TransportError` and `ProtocolError`.

| Entry point          | For                                                               |
| -------------------- | ----------------------------------------------------------------- |
| `@media/sdk/effect`  | Effect programs: services, layers, workflows                      |
| `@media/sdk/react`   | React: providers and hooks                                        |
| `@media/sdk/promise` | Everything else: a Promise facade that rejects with tagged errors |

## Platform

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
  Effect.provide(Platform.layer({ url, connection: "http", storage: TokenStorage.layerMemory })),
);
```

```ts
import { createPlatform } from "@media/sdk/promise";

const platform = createPlatform({ url, connection: "http" });
const { name } = await platform.core.server.info();
```

```tsx
import { PlatformProvider, usePlatform, usePlatformQuery } from "@media/sdk/react";

<PlatformProvider url={url} storage={window.localStorage}>
  <ServerName />
</PlatformProvider>;

const ServerName = () => {
  const info = usePlatformQuery(usePlatform().core.server.info);

  return info.status === "success" ? <h1>{info.data.name}</h1> : null;
};
```

- Every command `domain.module.fn` is the method `platform.domain.module.fn(args)`. Hover it for
  the command's summary, kind, scope, and whether it refuses API keys. A command whose arguments are all optional takes none.
  Queries also have `watch`: a `Stream` in Effect, a `QueryWatch` in Promise code and React.
- IDs are typed by table (`Platform.Id<"authSessions">`), so an ID from a result passes into
  another command's arguments and an ID of the wrong table does not type-check.
- Calls fail with `PlatformError`: a session without the command's scope gets `Forbidden`, and a
  session that was ended elsewhere gets `Unauthenticated`.
- `platform.session` signs in with `Credentials.Password` or `Credentials.ApiKey`, signs out, and
  reports `status`. `startDeviceSignIn(clientName)` starts a device sign-in: show its `userCode`,
  then `complete` waits until a signed-in session approves it, or fails with
  `DeviceSignInRefused`. Tokens refresh by themselves through the same session engine as `Auth`.
- The account sign-ins make or change an account and sign in as it. `Credentials.Setup` makes the
  first account the owner and fails with `Conflict` once the server has one. `Credentials.Invite`
  makes an account from an invite code and `Credentials.Reset` sets a new password from a reset
  link code; a used or expired code fails with `Expired`. In Promise code and React they are
  `session.setUpOwner`, `session.acceptInvite`, and `session.resetPassword`.
- The platform client opens its own connection and keeps its own session, so it runs beside the
  movies client. Clients that store their session under one key share one sign-in, as the web
  clients on one origin do (`media.session` by default).
- `src/platform/generated/` is written by `pnpm --filter @media/commands generate`. Never edit it.

## Movies

## Effect

```ts
import { Movies, MoviesClient, TokenStorage } from "@media/sdk/effect";

const sdk = Movies.layer({
  convexUrl,
  mediaUrl: Option.some(mediaUrl),
  connection: "websocket",
}).pipe(Layer.provide(TokenStorage.layerMemory));

const titles = Effect.flatMap(MoviesClient.MoviesClient, (client) =>
  client.query("titles.list", { profileId }),
);
```

- `MoviesClient`: `query`, `mutate`, `action`, `media` (HTTP to the media service with the
  session's token as bearer), `run` (any command), `subscribe` (a `Stream` of results).
- `Auth`: `signIn(Credentials.Password | ApiKey | DeviceCode)`, `signOut`, `status`, and
  `accessToken(forceRefresh)`; tokens refresh before expiry and when Convex rejects them.
- `DeviceLogin.start(clientName)`: user code, approval URL (render it as a QR code), and
  `complete`, which waits for approval and signs in.
- `TokenStorage`: `layerMemory`, `layerKeyValue(store, key)` for `localStorage`/AsyncStorage, or
  any implementation (the CLI stores a file).
- `Playback`: `start` (create the session, negotiate a stream), `reportProgress` (every ten
  seconds and on pause, resume, seek, and end; ends the session when its scope closes),
  `nextEpisode`, `autoplayCountdown`, `seekStream`, `renegotiate` (renews the playback token when
  it expires within five minutes, then negotiates again), and `recoveryFor`, which maps each
  playback API failure (`@media/contracts/media-playback`) to what the player does next:
  `reload-playlist`, `renegotiate`, `renew-token`, `new-session`, `retry-later`, `unsupported`,
  or `fail`. Media URLs carry the token, so after renewing load the new `stream.url`.
- `MediaOrigin`: playback and download requests go to the public URL the session names unless
  this reference is provided, as the CLI does with its configured media URL. The URLs the service
  answers with, such as `stream.url`, stay public either way.
- `RoomSync.run({ roomId, deviceId, player, tunables })`: the watch room engine (below).
- `ConvexTransport`: `layerWebSocket` for apps, `layerHttp` for short-lived processes.

## Room engine

The engine drives a `PlayerPort`, so the web `<video>` element, hls.js, and native players plug
in through one small adapter:

```ts
interface PlayerPort {
  positionMs(): number;
  isPaused(): boolean;
  isBuffering(): boolean;
  playbackRate(): number;
  setPlaybackRate(rate: number): void;
  seek(positionMs: number): void;
  play(): Promise<void>; // rejects when autoplay is blocked
  pause(): void;
  subscribe(
    listener: (event: "playing" | "paused" | "seeked" | "waiting" | "ended") => void,
  ): () => void;
}
```

It estimates the server clock offset from `rooms.time` round trips (best of a window, by round
trip), applies committed clocks in revision order, nudges the rate for small drift and seeks for
large drift, settles a guest close to the shared position after a nudge or a clock change rather
than anywhere inside the in-sync band, lets a stalled guest buffer and catch up, publishes the host's play, pause, seek, and
buffering as room commands at the current revision, reverts the host to the committed clock when
a command is stale or after a reconnect, and disables host controls while heartbeats go
unanswered. Tunables live in `RoomSyncPolicy.DEFAULT_TUNABLES`.

A room's next-episode countdown is part of its record (`room.next`), due at a server time.
`RoomSync.nextEpisodeCountdownMs(state, Date.now())` gives the time left with the engine's clock
offset, the same on every member. The server moves the room on; the app then opens the room's new
media with a new engine. Pass `fileId` (the file the player plays) to `RoomSync.run`: once the
room plays another file the engine goes `moved` and leaves the old player alone, and its host
controls and heartbeats name that file, so the server refuses them for the new one.

## Tests

`pnpm test` runs the unit suites, including the room engine against an in-memory backend and a
fake player on `TestClock`. `pnpm --filter @media/sdk test:stack` runs the SDK against the dev
stack from `scripts/dev-stack.sh up`.
