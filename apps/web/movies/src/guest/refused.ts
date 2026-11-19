import type { QueryState } from "@media/sdk/react";
import { Predicate } from "effect";

type QueryError = Extract<QueryState<unknown>, { readonly status: "error" }>["error"];

/**
 * Whether a guest's read was refused because the link or what it shares is gone, as opposed to a
 * server or connection failure that a retry can recover from.
 */
export const linkRefused = (error: QueryError): boolean =>
  Predicate.isTagged(error, "NotFound") ||
  Predicate.isTagged(error, "Forbidden") ||
  Predicate.isTagged(error, "Expired");
