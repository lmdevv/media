import { PlatformClientProvider, usePlatform, usePlatformQuery } from "@media/sdk/react";
import type { PlatformSdk } from "@media/sdk/promise";
import { useCallback, useMemo } from "react";
import type { ReactNode } from "react";

/** Where a signed-out browser signs in: the account client at the origin's root (ADR 0020). */
const SIGN_IN_PATH = "/";

/**
 * Provides the platform client on the browser's one session (D52). The movies client never signs
 * in itself: it reads the session the account client at `/` keeps, and follows sign-in, switching,
 * and sign-out in every tab through the shared store.
 */
export function MoviesSession({
  platform,
  children,
}: {
  readonly platform: PlatformSdk;
  readonly children: ReactNode;
}) {
  return <PlatformClientProvider platform={platform}>{children}</PlatformClientProvider>;
}

/** Leaves the movies client for the account client, which shows sign-in or the shared picker. */
const leaveToSignIn = (): void => {
  window.location.replace(SIGN_IN_PATH);
};

/** Who is signed in, as `core.auth.sessions.current` answers. */
export type Me = Awaited<ReturnType<PlatformSdk["core"]["auth"]["sessions"]["current"]>>;

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
