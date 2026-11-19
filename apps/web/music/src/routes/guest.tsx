import { usePlatform, usePlatformQuery, usePlatformStatus } from "@media/sdk/react";
import { GuestUnavailable } from "@/guest/unavailable";
import {
  isRenewing,
  linkRefused,
  sessionAccess,
  useIdentityRetry,
} from "@media/ui/lib/session-identity";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

import { musicAccess } from "@/session/access";
import { GuestItem } from "@/guest/item";
import { UnreachableScreen } from "@/guest/unreachable";
import { BlankPage, useSignOut } from "@/session/session";

export const Route = createFileRoute("/guest")({
  head: () => ({ meta: [{ title: "Shared with you · Lar Music" }] }),
  component: GuestRoute,
});

function GuestRoute() {
  const platform = usePlatform();
  const status = usePlatformStatus();
  const leave = useSignOut();

  const me = usePlatformQuery(
    platform.core.auth.sessions.current,
    ...(status === "signedIn" ? [] : (["skip"] as const)),
  );

  useIdentityRetry(me);
  const guard = sessionAccess(status, me);

  if (musicAccess(guard, true) === "home") return <Navigate to="/" replace />;

  if (guard === "failed" && me.status === "error") return <UnreachableScreen retry={me.retry} />;

  if (guard === "signedOut") return <GuestUnavailable onLeave={leave} />;

  if (guard === "loading") return <BlankPage />;

  return <GuestShare />;
}

function GuestShare() {
  const platform = usePlatform();
  const leave = useSignOut();
  const current = usePlatformQuery(platform.core.guests.current);
  useIdentityRetry(current);

  if (current.status === "loading" || (current.status === "error" && isRenewing(current.error)))
    return <BlankPage />;

  if (current.status === "error")
    return linkRefused(current.error) ? (
      <GuestUnavailable onLeave={leave} />
    ) : (
      <UnreachableScreen retry={current.retry} />
    );
  const guest = current.data;

  if (guest === null || guest.target.kind !== "item") return <GuestUnavailable onLeave={leave} />;

  if (guest.target.item.domain !== "music") return <OtherShare />;

  return (
    <GuestItem item={guest.target.item.ref} sharedBy={guest.sharedBy} expiresAt={guest.expiresAt} />
  );
}

function OtherShare() {
  useEffect(() => {
    window.location.replace("/guest");
  }, []);

  return <BlankPage />;
}
