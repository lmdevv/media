# @media/sdk

The client core shared by the web app, the CLI, and later the native apps. Calls are typed by the
command registry in `@media/contracts`: arguments are encoded and results decoded with each
command's schemas, and failures are the contracts' tagged errors plus `TransportError` and
`ProtocolError`. No Node built-ins or DOM globals in shipped sources (`import-boundary.test.ts`).

| Entry point          | For                                                               |
| -------------------- | ----------------------------------------------------------------- |
| `@media/sdk/effect`  | Effect programs: services, layers, workflows                      |
| `@media/sdk/react`   | React: provider and hooks on the app's `ConvexReactClient`        |
| `@media/sdk/promise` | Everything else: a Promise facade that rejects with tagged errors |

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
