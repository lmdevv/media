import { usePlatform, usePlatformQuery, usePlatformStatus } from "@media/sdk/react";
import { GuestUnavailable } from "@media/ui/components/guest-unavailable";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { isRenewing, sessionAccess, useIdentityRetry } from "@media/ui/lib/session-identity";

import { GuestItem } from "@/guest/item";
import { linkRefused } from "@/guest/refused";
import { useSignOut } from "@/session/session";
import { BlankPage } from "@/session/redirect";
import { UnreachableScreen } from "@/session/unreachable";
import { SoloSessionProvider } from "@/together/current-session";

export const Route = createFileRoute("/guest")({
  head: () => ({ meta: [{ title: "Shared with you · Lar Movies" }] }),
  component: GuestRoute,
});

function GuestRoute() {
  const status = usePlatformStatus();
  const platform = usePlatform();
  const leave = useSignOut();

  const me = usePlatformQuery(
    platform.core.auth.sessions.current,
    ...(status === "signedIn" ? [] : (["skip"] as const)),
  );

  useIdentityRetry(me);

  const guard = sessionAccess(status, me);

  if (guard === "failed" && me.status === "error") return <UnreachableScreen retry={me.retry} />;

  if (guard === "household") return <Navigate to="/" replace />;

  if (guard === "signedOut") return <GuestUnavailable onLeave={leave} />;

  if (guard === "loading") return <BlankPage />;

  return (
    <SoloSessionProvider>
      <GuestShare />
    </SoloSessionProvider>
  );
}

function GuestShare() {
  const platform = usePlatform();
  const leave = useSignOut();
  const current = usePlatformQuery(platform.core.guests.current);
  useIdentityRetry(current);

  if (current.status === "error" && isRenewing(current.error)) return <BlankPage />;

  if (current.status === "error")
    return linkRefused(current.error) ? (
      <GuestUnavailable onLeave={leave} />
    ) : (
      <UnreachableScreen retry={current.retry} />
    );

  if (current.status === "loading") return <BlankPage />;
  const guest = current.data;

  if (guest === null || guest.target.kind !== "item" || guest.target.item.domain !== "movies")
    return <GuestUnavailable onLeave={leave} />;

  return (
    <GuestItem item={guest.target.item.ref} sharedBy={guest.sharedBy} expiresAt={guest.expiresAt} />
  );
}
