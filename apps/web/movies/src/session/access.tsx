import { usePlatform, usePlatformQuery, usePlatformStatus } from "@media/sdk/react";
import { sessionAccess, useIdentityRetry } from "@media/ui/lib/session-identity";
import { useRouterState, Navigate } from "@tanstack/react-router";
import { useEffect } from "react";
import type { ReactNode } from "react";

import { BlankPage } from "./redirect";
import { Button } from "@media/ui/components/button";
import { HeldSettings } from "./held-settings";
import { CurrentSessionProvider } from "@/together/current-session";

export function MoviesAccess({ children }: { readonly children: ReactNode }) {
  const guest = useRouterState({
    select: (state) => state.matches.some((match) => match.routeId === "/guest"),
  });

  return guest ? children : <Household>{children}</Household>;
}

function Household({ children }: { readonly children: ReactNode }) {
  const status = usePlatformStatus();
  const platform = usePlatform();

  const me = usePlatformQuery(
    platform.core.auth.sessions.current,
    ...(status === "signedIn" ? [] : (["skip"] as const)),
  );

  useIdentityRetry(me);
  const access = sessionAccess(status, me);

  useEffect(() => {
    if (status === "signedOut") window.location.replace("/");
  }, [status]);

  if (access === "loading" || access === "signedOut") return <BlankPage />;

  if (me.status === "error")
    return (
      <main className="flex min-h-svh flex-col items-center justify-center gap-5 bg-page text-text">
        <h1 className="text-title/title font-bold">Can't reach the server</h1>
        <Button onClick={me.retry}>Try again</Button>
      </main>
    );

  if (access === "guest") return <Navigate to="/guest" replace />;

  return (
    <>
      <HeldSettings />
      <CurrentSessionProvider>{children}</CurrentSessionProvider>
    </>
  );
}
