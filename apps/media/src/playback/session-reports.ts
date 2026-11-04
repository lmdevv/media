import type { PlaybackSessionId } from "@media/contracts/ids";
import { Context, Layer, Stream } from "effect";

import type { SessionReport } from "./stream-liveness.ts";

/** What the service that owns playback sessions says about them. */
export interface Interface {
  /** What is said about `sessionId` now and after every change. Never ends on its own. */
  readonly follow: (sessionId: PlaybackSessionId) => Stream.Stream<SessionReport>;
}

/** Reports on playback sessions. */
export class Service extends Context.Service<Service, Interface>()(
  "@media/server/SessionReports",
) {}

/** No reports, for standalone mode: streams keep their encoders on requests alone. */
export const layerNone: Layer.Layer<Service> = Layer.succeed(
  Service,
  Service.of({ follow: () => Stream.never }),
);
