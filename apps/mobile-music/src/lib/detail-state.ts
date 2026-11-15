import { describeFailure, isFailure } from "@media/mobile-core/failure";
import { Predicate } from "effect";

/** Why a record can't be shown: it is gone for this viewer, or reading it failed. */
export type Unavailable =
  /** Deleted, unshared, access removed, or never theirs; the copy stays vague on purpose. */
  { readonly kind: "unavailable" } | { readonly kind: "failed"; readonly message: string };

/** Where a record stands for the viewer. */
export type DetailState<Detail> =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly detail: Detail }
  | Unavailable;

/** What a failed read means for the page; `fallback` stands in for a failure without a reason. */
export const unavailableFrom = (
  error: Error,
  fallback = "Something went wrong. Try again.",
): Unavailable => {
  if (isFailure(error, "NotFound") || isFailure(error, "Forbidden")) return { kind: "unavailable" };

  // The core's own reason for a refusal; the screen's line for anything else, such as a dropped
  // connection, whose message was never meant for people.
  return Predicate.hasProperty(error, "_tag")
    ? { kind: "failed", message: describeFailure(error) }
    : { kind: "failed", message: fallback };
};

/** A settled read (`useReadSettled`) as a page state. */
export const detailStateOf = <Detail>(
  read: Detail | Error | undefined,
  fallback: string,
): DetailState<Detail> => {
  if (read === undefined) return { kind: "loading" };

  return read instanceof Error ? unavailableFrom(read, fallback) : { kind: "ready", detail: read };
};
