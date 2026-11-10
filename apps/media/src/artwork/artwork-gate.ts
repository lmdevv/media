import { Context, type Effect } from "effect";

/**
 * The artwork route's ticket check. Absent while the server runs on old movies, whose artwork
 * URLs carry no ticket; present on the core, whose artwork URLs carry a shareable ticket on a
 * rounded bucket, so images still cache (ADR 0011).
 */
export interface Interface {
  /** The query parameter the ticket travels in. */
  readonly param: string;
  /** Whether `ticket` admits an `image` request for the artwork at `key`. */
  readonly admits: (ticket: string, key: string) => Effect.Effect<boolean>;
}

/** The artwork gate. */
export class Service extends Context.Service<Service, Interface>()("@media/server/ArtworkGate") {}
