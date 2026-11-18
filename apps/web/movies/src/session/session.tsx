import type { BrowserStore } from "@media/ui/lib/browser-session";
import {
  PlatformProvider,
  usePlatform,
  usePlatformQuery,
  usePlatformStatus,
} from "@media/sdk/react";
import type { PlatformSdk } from "@media/sdk/promise";
import { useCallback, useEffect, useMemo } from "react";
import type { ReactNode } from "react";

import { SIGN_IN_URL } from "../env";
import { BlankPage } from "./redirect";

/** Where a signed-out browser signs in: the account client at the origin's root (ADR 0020). */
const SIGN_IN_PATH = "/";

/**
 * Runs the platform client on the browser's one session (D52). The movies client never signs in
 * itself: it reads the session the account client at `/` keeps, and follows sign-in, switching,
 * and sign-out in every tab through the shared store.
 */
export function MoviesSession({
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

/** Leaves the movies client for the account client, which shows sign-in or the shared picker. */
const leaveToSignIn = (): void => {
  window.location.replace(SIGN_IN_PATH);
};

/**
 * Renders `children` only while the browser holds a session. A browser that holds none, or whose
 * session ends here or in another tab, goes to `/` to sign in.
 */
export function RequireSession({ children }: { readonly children: ReactNode }) {
  const status = usePlatformStatus();

  useEffect(() => {
    if (status === "signedOut") leaveToSignIn();
  }, [status]);

  return status === "signedIn" ? children : <BlankPage />;
}

/** Who is signed in, as `core.auth.sessions.current` answers. */
export type Me = Awaited<ReturnType<PlatformSdk["core"]["auth"]["sessions"]["current"]>>;

/** The signed-in person and their session, or null while loading. Use inside `RequireSession`. */
export const useMe = (): Me | null => {
  const platform = usePlatform();
  const me = usePlatformQuery(platform.core.auth.sessions.current);

  return me.status === "success" ? me.data : null;
};

/** The name a person goes by: the display name they set, else their username. */
export const nameOf = (person: Pick<Me, "username" | "displayName">): string =>
  person.displayName ?? person.username;

/** A scope a session can hold, such as `movies:edit`. */
export type Scope = Me["scopes"][number];

/**
 * What this session may do. Empty while loading, so scope-gated actions appear once known rather
 * than flashing in and out.
 */
export const useScopes = (): ReadonlySet<Scope> => {
  const me = useMe();

  return useMemo(() => new Set(me?.scopes ?? []), [me]);
};

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
