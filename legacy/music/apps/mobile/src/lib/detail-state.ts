/**
 * A record a page opens by ID, kept live, with "you can't open it" as an ordinary state rather
 * than a thrown error: a playlist is deleted, or access to a library is taken away, while someone
 * looks at it, and the page should say so (G10) instead of failing the whole app.
 */
import { commandFailure } from "@music/sdk/errors";

/** Why a record can't be shown: it is gone for this viewer, or reading it failed. */
export type Unavailable =
  /** Deleted, unshared, access removed, or never theirs; the copy stays vague on purpose. */
  { readonly kind: "unavailable" } | { readonly kind: "failed"; readonly message: string };

/** Where a record stands for the viewer. */
export type DetailState<Detail> =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly detail: Detail }
  | Unavailable;

/** Server failures that mean the viewer can't open the record, rather than a passing fault. */
const GONE = new Set(["not_found", "forbidden"]);

/** What a failed read means for the page; `fallback` stands in for a failure without a reason. */
export const unavailableFrom = (
  error: Error,
  fallback = "Something went wrong. Try again.",
): Unavailable => {
  const failure = commandFailure(error);

  return failure !== null && GONE.has(failure.code)
    ? { kind: "unavailable" }
    : { kind: "failed", message: failure?.message ?? fallback };
};

/** A settled read (`useReadSettled`) as a page state. */
export const detailStateOf = <Detail>(
  read: Detail | Error | undefined,
  fallback: string,
): DetailState<Detail> => {
  if (read === undefined) return { kind: "loading" };

  return read instanceof Error ? unavailableFrom(read, fallback) : { kind: "ready", detail: read };
};
