/**
 * The media service's one retry shape: exponential from `first`, never longer than `cap` between
 * tries. Subscriptions, folder watches, and folder claims all retry this way.
 */
import { type Duration, Schedule } from "effect";

/** Exponential backoff from `first`, capped at `cap` between tries. */
export const cappedBackoff = (first: Duration.Input, cap: Duration.Input) =>
  Schedule.min([Schedule.exponential(first), Schedule.spaced(cap)]);
