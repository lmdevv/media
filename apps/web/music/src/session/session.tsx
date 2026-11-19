import type { BrowserStore } from "@media/ui/lib/browser-session";
import {
  PlatformProvider,
  usePlatform,
  usePlatformQuery,
  usePlatformStatus,
} from "@media/sdk/react";
import { sessionAccess, useIdentityRetry } from "@media/ui/lib/session-identity";
import { Navigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";
import type { ReactNode } from "react";

import { musicAccess } from "./access";
import { UnreachableScreen } from "@/guest/unreachable";

import { SIGN_IN_URL } from "../env";

/** Where a signed-out browser signs in: the account client at the origin's root (ADR 0020). */
const SIGN_IN_PATH = "/";

/**
 * Runs the platform client on the browser's one session (D52). The music client never signs in
 * itself: it reads the session the account client at `/` keeps, and follows sign-in, switching,
 * and sign-out in every tab through the shared store, as the movies client does.
 */
export function MusicSession({
  store,
  url,
  children,
}: {
  readonly store: BrowserStore;
  readonly url: string;
  readonly children: ReactNode;
}) {
  return (
    <PlatformProvider url={url} signInUrl={SIGN_IN_URL} storage={store.sessions}>
      {children}
    </PlatformProvider>
  );
}

/** Leaves the music client for the account client, which shows sign-in or the shared picker. */
const leaveToSignIn = (): void => {
  window.location.replace(SIGN_IN_PATH);
};

/** The empty page canvas shown while the session loads or the browser leaves to sign in. */
export function BlankPage() {
  return <div aria-busy className="min-h-dvh bg-bg" />;
}

/**
 * The guest route owns its identity checks. Every other route requires a household session;
 * guests return to their share, and signed-out browsers go to the account entrance.
 */
export function RequireSession({ children }: { readonly children: ReactNode }) {
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
    if (access === "signedOut") leaveToSignIn();
  }, [access]);

  if (musicAccess(access, false) === "guest") return <Navigate to="/guest" replace />;

  if (access === "failed" && me.status === "error") return <UnreachableScreen retry={me.retry} />;

  return musicAccess(access, false) === "render" ? children : <BlankPage />;
}

/**
 * Signs this browser's person out, here and in every tab on the origin, then goes to `/`.
 * Switching person is signing out, then signing the next one in at `/` (D52).
 */
export const useSignOut = (): (() => Promise<void>) => {
  const platform = usePlatform();

  return useCallback(async () => {
    try {
      await platform.session.signOut();
    } finally {
      leaveToSignIn();
    }
  }, [platform]);
};
