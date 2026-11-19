import type { PlatformSdk } from "@media/sdk/promise";
import type { QueryState } from "@media/sdk/react";
import { Predicate } from "effect";
import { useEffect } from "react";

type Identity = Awaited<ReturnType<PlatformSdk["core"]["auth"]["sessions"]["current"]>>;

type QueryError = Extract<QueryState<unknown>, { readonly status: "error" }>["error"];

/** A refused identity waits for renewal or another tab's replacement session. */
export const isRenewing = (error: QueryError): boolean =>
  Predicate.isTagged(error, "Unauthenticated");

/**
 * Whether a guest's read was refused because the link or what it shares is gone, as opposed to a
 * server or connection failure that a retry can recover from.
 */
export const linkRefused = (error: QueryError): boolean =>
  Predicate.isTagged(error, "NotFound") ||
  Predicate.isTagged(error, "Forbidden") ||
  Predicate.isTagged(error, "Expired");

/** Retries identity after the SDK has had time to settle its session. */
export const useIdentityRetry = (me: QueryState<unknown>): void => {
  useEffect(() => {
    const timer =
      me.status === "error" && isRenewing(me.error) ? setTimeout(me.retry, 1000) : undefined;

    return () => clearTimeout(timer);
  }, [me]);
};

/** Separates session transitions from failed identity reads and household access. */
export const sessionAccess = (
  status: "loading" | "signedIn" | "signedOut",
  me: QueryState<Pick<Identity, "role">>,
): "loading" | "signedOut" | "failed" | "guest" | "household" => {
  if (status === "loading") return "loading";

  if (status === "signedOut") return "signedOut";

  if (me.status === "loading") return "loading";

  if (me.status === "error") return isRenewing(me.error) ? "loading" : "failed";

  return me.data.role === "guest" ? "guest" : "household";
};
