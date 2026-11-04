import type { Profile } from "@media/contracts/models/profiles";
import { Button } from "@media/ui/components/button";
import { CalmState } from "@media/ui/components/calm-state";
import { useAuth, useCommandQuery } from "@media/sdk/react";
import { useLocation } from "@tanstack/react-router";
import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";

import { describeFailure, isFailure } from "@/lib/failure";

import { useProfileChoice } from "./profile-choice";
import { BlankPage, Redirect } from "./redirect";

const signInHref = (href: string): string =>
  href === "/" ? "/sign-in" : `/sign-in?redirect=${encodeURIComponent(href)}`;

/**
 * Renders `children` only with a session. Without one it redirects to the welcome screen on a
 * server without an owner yet, otherwise to sign-in with a way back here.
 */
export function RequireSignedIn({ children }: { readonly children: ReactNode }) {
  const { status } = useAuth();
  const href = useLocation({ select: (location) => location.href });
  const pathname = useLocation({ select: (location) => location.pathname });
  const setup = useCommandQuery("setup.status", status === "signedOut" ? {} : "skip");

  if (status === "loading") return <BlankPage />;

  if (status === "signedIn") return children;

  if (pathname === "/sign-in" || setup.status === "loading") return <BlankPage />;

  if (setup.status === "success" && !setup.data.hasOwner) return <Redirect href="/welcome" />;

  return <Redirect href={signInHref(href)} />;
}

/** The profile everything on screen belongs to, and its account's other profiles. */
export interface ActiveProfile {
  readonly profile: Profile;
  readonly profiles: ReadonlyArray<Profile>;
}

const ActiveProfileContext = createContext<ActiveProfile | null>(null);

/** A whole-page failure; Try again runs `retry`, such as a failed query's. */
export function PageFailure({
  cause,
  retry,
}: {
  readonly cause: unknown;
  readonly retry: () => void;
}) {
  return (
    <div className="flex min-h-svh items-center justify-center bg-page px-6">
      <CalmState
        title="Something went wrong"
        description={describeFailure(cause)}
        actions={<Button onClick={retry}>Try again</Button>}
      />
    </div>
  );
}

/**
 * Renders `children` once this browser has chosen one of the account's profiles and the session
 * has unlocked it. Otherwise it sends people to "Who's watching?" or to the profile's PIN.
 * Must sit inside `RequireSignedIn`.
 */
export function RequireProfile({ children }: { readonly children: ReactNode }) {
  const { profileId } = useProfileChoice();
  const href = useLocation({ select: (location) => location.href });
  const profiles = useCommandQuery("profiles.list", {});

  const active = useMemo((): ActiveProfile | null => {
    if (profiles.status !== "success") return null;

    const profile = profiles.data.find((candidate) => candidate.id === profileId);

    return profile === undefined ? null : { profile, profiles: profiles.data };
  }, [profiles, profileId]);

  if (profiles.status === "loading") return <BlankPage />;

  if (profiles.status === "error") {
    return isFailure(profiles.error, "Unauthenticated") ? (
      <BlankPage />
    ) : (
      <PageFailure cause={profiles.error} retry={profiles.retry} />
    );
  }

  const back = encodeURIComponent(href);

  if (active === null) return <Redirect href={`/profiles?redirect=${back}`} />;

  if (active.profile.locked) {
    return <Redirect href={`/profiles/${active.profile.id}/pin?redirect=${back}`} />;
  }

  return <ActiveProfileContext.Provider value={active}>{children}</ActiveProfileContext.Provider>;
}

/**
 * The chosen, unlocked profile. Pass its id to every profile-scoped command.
 *
 * @throws When used outside `RequireProfile`, a programming error.
 */
export const useActiveProfile = (): ActiveProfile => {
  const active = useContext(ActiveProfileContext);

  if (active === null) throw new Error("useActiveProfile must be used inside RequireProfile");

  return active;
};
