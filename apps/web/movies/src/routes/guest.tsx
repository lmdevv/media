import { usePlatform, usePlatformQuery, usePlatformStatus } from "@media/sdk/react";
import { GuestUnavailable } from "@media/ui/components/guest-unavailable";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { GuestItem } from "@/guest/item";
import { guestGuard } from "@/guest/guard";
import { useSignOut } from "@/session/session";
import { BlankPage } from "@/session/redirect";
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

  const guard = guestGuard(status, me.status === "success" ? me.data.role : undefined);

  if (me.status === "error") return <GuestUnavailable onLeave={leave} />;

  if (guard === "member") return <Navigate to="/" replace />;

  if (guard === "unavailable") return <GuestUnavailable onLeave={leave} />;

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
  const [ended, setEnded] = useState(false);
  const expiresAt = current.status === "success" ? current.data?.expiresAt : undefined;

  useEffect(() => {
    if (expiresAt === undefined) return undefined;

    const check = (): ReturnType<typeof setTimeout> =>
      setTimeout(
        () => {
          if (Date.now() >= expiresAt) setEnded(true);
          else timer = check();
        },
        Math.min(Math.max(0, expiresAt - Date.now()), 2_000_000_000),
      );

    let timer = check();

    return () => clearTimeout(timer);
  }, [expiresAt]);

  if (ended || current.status === "error") return <GuestUnavailable onLeave={leave} />;

  if (current.status === "loading") return <BlankPage />;
  const guest = current.data;

  if (guest === null || guest.target.kind !== "item" || guest.target.item.domain !== "movies")
    return <GuestUnavailable onLeave={leave} />;

  return (
    <GuestItem item={guest.target.item.ref} sharedBy={guest.sharedBy} expiresAt={guest.expiresAt} />
  );
}
