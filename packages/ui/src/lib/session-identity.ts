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

/** What a guest's read shows. */
type GuestView<A> =
  | { readonly kind: "blank" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "unreachable"; readonly retry: () => void }
  | { readonly kind: "ready"; readonly data: A };

/**
 * A guest's read as a page: blank while it loads or the session renews, unavailable once the link
 * refuses it, a retry for any other failure, else its data.
 */
export const guestView = <A>(state: QueryState<A>): GuestView<A> => {
  if (state.status === "loading") return { kind: "blank" };

  if (state.status === "success") return { kind: "ready", data: state.data };

  if (isRenewing(state.error)) return { kind: "blank" };

  return linkRefused(state.error)
    ? { kind: "unavailable" }
    : { kind: "unreachable", retry: state.retry };
};

/** Retries identity after the SDK has had time to settle its session. */
export const useIdentityRetry = (me: QueryState<unknown>): void => {
  const renewal = me.status === "error" && isRenewing(me.error) ? me : null;
  const failure = renewal?.error;
  const retry = renewal?.retry;

  useEffect(() => {
    const timer = retry === undefined ? undefined : setTimeout(retry, 1000);

    return () => clearTimeout(timer);
  }, [failure, retry]);
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
