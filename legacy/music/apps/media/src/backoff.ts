import { type Duration, Schedule } from "effect";

/** Exponential backoff from `first`, capped at `cap` between tries. */
export const cappedBackoff = (first: Duration.Input, cap: Duration.Input) =>
  Schedule.min([Schedule.exponential(first), Schedule.spaced(cap)]);
