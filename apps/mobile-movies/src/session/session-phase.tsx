import { lastPerson } from "@media/mobile-core/sign-in";
import type { AppRecord } from "@media/mobile-core/records";
import { ownKeychain } from "@media/mobile-core/expo-keychain";
import type { QueryState } from "@media/sdk/react";
import { usePlatform, usePlatformQuery, usePlatformStatus } from "@media/sdk/react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";

import { isFailure } from "@/lib/failure";

import { useServer } from "./connection";
import { useFirstRun } from "./first-run";
import type { Me } from "./me";
import { useSignIn, useSigningIn } from "./sign-in";

/** The phases the root stack switches between. */
export type SessionPhase =
  | { readonly kind: "loading" }
  | { readonly kind: "disconnected" }
  /**
   * Signed out. `person` is who this app last signed in as here: the app then asks for their
   * password again rather than using the phone's grant (D59).
   */
  | { readonly kind: "signedOut"; readonly person: AppRecord["person"] }
  /** Signed out on a server without an owner yet, or while the owner account is created. */
  | { readonly kind: "createOwner" }
  /** The owner just created here sets up a first library before Home. */
  | { readonly kind: "setup"; readonly me: Me }
  | { readonly kind: "ready"; readonly me: Me }
  /** The server could not say who is signed in; `retry` asks again. */
  | { readonly kind: "unavailable"; readonly cause: unknown; readonly retry: () => void };

type Info = { readonly hasOwner: boolean };

const signedOutPhase = (
  info: QueryState<Info>,
  settingUp: boolean,
  person: AppRecord["person"],
): SessionPhase => {
  // The core reports the new owner before the setup sign-in resolves, so setup holds the form.
  if (settingUp) return { kind: "createOwner" };

  if (info.status === "loading") return { kind: "loading" };

  return info.status === "success" && !info.data.hasOwner
    ? { kind: "createOwner" }
    : { kind: "signedOut", person };
};

type Launch =
  | { readonly kind: "pending" }
  | { readonly kind: "done" }
  | { readonly kind: "failed"; readonly cause: unknown };

/**
 * Signs the app in silently once, when it opens signed out and never had a session of its own,
 * from the grant the phone's shared keychain holds (D48). Pending until that is decided.
 */
const useLaunchSignIn = (status: "loading" | "signedIn" | "signedOut"): [Launch, () => void] => {
  const { onLaunch } = useSignIn();
  const [launch, setLaunch] = useState<Launch>({ kind: "pending" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (status === "loading" || launch.kind !== "pending") return undefined;

    if (status === "signedIn") {
      setLaunch({ kind: "done" });

      return undefined;
    }

    const stop = new AbortController();

    const run = async () => {
      try {
        await onLaunch();

        if (!stop.signal.aborted) setLaunch({ kind: "done" });
      } catch (cause) {
        if (!stop.signal.aborted) setLaunch({ kind: "failed", cause });
      }
    };

    void run();

    return () => stop.abort();
  }, [status, launch.kind, onLaunch, attempt]);

  return [
    launch,
    () => {
      setLaunch({ kind: "pending" });
      setAttempt((count) => count + 1);
    },
  ];
};

/** The phase of the connected app, from the session, who it is, and the server's setup. */
export const useLiveSessionPhase = (): SessionPhase => {
  const platform = usePlatform();
  const { mediaUrl } = useServer();
  const status = usePlatformStatus();
  const signingIn = useSigningIn();
  const settingUp = useFirstRun().active;
  const [launch, retryLaunch] = useLaunchSignIn(status);

  const me = usePlatformQuery(
    platform.core.auth.sessions.current,
    ...(status === "signedIn" ? [] : (["skip"] as const)),
  );

  const info = usePlatformQuery(
    platform.core.server.info,
    ...(status === "signedOut" ? [] : (["skip"] as const)),
  );

  return useMemo((): SessionPhase => {
    if (status === "loading" || launch.kind === "pending") return { kind: "loading" };

    if (status === "signedOut") {
      if (launch.kind === "failed") {
        return { kind: "unavailable", cause: launch.cause, retry: retryLaunch };
      }

      return signedOutPhase(info, settingUp, lastPerson({ own: ownKeychain, server: mediaUrl }));
    }

    // Signed in, but still issuing the grant and enrolling: the sign-in screens stay.
    if (signingIn) return { kind: "loading" };

    if (me.status === "loading") return { kind: "loading" };

    if (me.status === "error") {
      // The SDK refreshes once on Unauthenticated, then signs out (D51).
      return isFailure(me.error, "Unauthenticated")
        ? { kind: "loading" }
        : { kind: "unavailable", cause: me.error, retry: me.retry };
    }

    return settingUp ? { kind: "setup", me: me.data } : { kind: "ready", me: me.data };
  }, [status, launch, retryLaunch, info, settingUp, mediaUrl, signingIn, me]);
};

/** A phase the root stack has screens for. */
export type SettledPhase = Extract<
  SessionPhase,
  { readonly kind: "signedOut" | "createOwner" | "setup" | "ready" }
>;

const isSettled = (phase: SessionPhase): phase is SettledPhase =>
  phase.kind === "signedOut" ||
  phase.kind === "createOwner" ||
  phase.kind === "setup" ||
  phase.kind === "ready";

const sameScreens = (next: SettledPhase, last: SettledPhase | null): boolean => {
  if (last === null || next.kind !== last.kind) return false;

  return (
    (next.kind !== "ready" && next.kind !== "setup") ||
    ((last.kind === "ready" || last.kind === "setup") && next.me.userId === last.me.userId)
  );
};

/**
 * `phase` when it is settled, else the last settled phase, or null before the first. A reload or
 * a failed refresh then keeps the screens, and their navigation, in place instead of unmounting
 * them.
 */
export const useSettledPhase = (phase: SessionPhase): SettledPhase | null => {
  const [last, setLast] = useState<SettledPhase | null>(null);

  if (isSettled(phase) && !sameScreens(phase, last)) setLast(phase);

  return isSettled(phase) ? phase : last;
};

/** The settled phase, shared so screens read it without subscribing again. */
export const SessionPhaseContext = createContext<SettledPhase | null>(null);

/**
 * The phase the screens on show belong to.
 *
 * @throws When used outside the connected app, a programming error.
 */
export const useSessionPhase = (): SettledPhase => {
  const phase = useContext(SessionPhaseContext);

  if (phase === null) throw new Error("useSessionPhase must be used inside the connected app");

  return phase;
};
