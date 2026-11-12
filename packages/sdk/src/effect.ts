/**
 * `@media/sdk/effect`: the Effect core. `Platform.layer` connects to the platform deployment and
 * gives every platform command a method (`platform.core.server.info()`), and `MediaRoutes` calls
 * the media server's own routes with its session's token. `Playback` (with `PlayerDiagnostics`)
 * and `Downloads` stream and download through the media server, and `Versions` (with
 * `MediaLabels` naming their facts) describes a title's files.
 */
export * as Auth from "./auth";

export * as ConvexTransport from "./convex-transport";

export * as Downloads from "./downloads";

export * as MediaLabels from "./media-labels";

export * as MediaRoutes from "./media-routes";

export * as Platform from "./platform/platform";

export * as Playback from "./playback";

export * as PlayerDiagnostics from "./player-diagnostics";

export type { PlayerEvent, PlayerPort } from "./room-sync/player-port";

export { MediaOrigin } from "./media-http";

export type { PlaybackCallError } from "./media-http";

export type { CallError } from "./sdk-errors";

export { ProtocolError, TransportError } from "./sdk-errors";

export * as TokenStorage from "./token-storage";

export * as Versions from "./versions";
