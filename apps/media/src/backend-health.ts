import type { HealthResponse } from "@media/contracts/media-playback";
import { Context, Effect, Layer } from "effect";

type BackendStatus = HealthResponse["backend"];

/** Reports the backend connection's state. */
export interface Interface {
  readonly status: Effect.Effect<BackendStatus>;
}

/** The backend health reporter. */
export class Service extends Context.Service<Service, Interface>()("@media/server/BackendHealth") {}

/** Standalone mode: no backend to connect to. */
export const layerStandalone: Layer.Layer<Service> = Layer.succeed(
  Service,
  Service.of({ status: Effect.succeed("standalone") }),
);
