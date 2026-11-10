import { Context, type Effect } from "effect";

/**
 * The artwork route's ticket check. Present on the core, whose artwork URLs carry a shareable
 * ticket on a rounded bucket, so images still cache (ADR 0011); absent in standalone mode and in
 * unit tests, where the route serves any key this server sealed.
 */
export interface Interface {
  /** The query parameter the ticket travels in. */
  readonly param: string;
  /** Whether `ticket` admits an `image` request for the artwork at `key`. */
  readonly admits: (ticket: string, key: string) => Effect.Effect<boolean>;
}

/** The artwork gate. */
export class Service extends Context.Service<Service, Interface>()("@media/server/ArtworkGate") {}
