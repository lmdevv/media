import { isFailure } from "@media/mobile-core/failure";
import { lastPerson } from "@media/mobile-core/sign-in";
import { usePlatform, usePlatformStatus } from "@media/sdk/react";
import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";

import { useHasDownloads } from "@/downloads";
import { appKeychains } from "@/lib/keychains";
import { useReadSettled } from "@/lib/platform";
import { sameScreens, sessionPhase, settle } from "@/lib/session-phase";
import type { SessionPhase, SettledPhase, SetupProgress } from "@/lib/session-phase";
import { useConnectionControls, useServer } from "@/session/connection";
import { useSignIn, useSigningIn } from "@/session/sign-in";

/** How long a remembered server may stay silent at launch before G05 offers a way out. */
const SILENT_AFTER_MS = 8000;

/**
 * How long a remembered server may stay silent before the app opens on the downloads (D11).
 * Shorter than G05's wait: the downloads play either way.
 */
const OFFLINE_AFTER_MS = 2500;

/** This install's setup progress on the connected server, and the way setup screens move it. */
interface SetupSteps {
  readonly progress: SetupProgress;
  readonly setProgress: (next: SetupProgress) => void;
}

const SetupStepsContext = createContext<SetupSteps | null>(null);

/**
 * Holds this install's setup progress for the connected server. Creating the owner moves on to
 * the first library once the account is signed in, so a later sign-out shows Sign in again.
 */
export function SetupProgressProvider({ children }: { readonly children: ReactNode }) {
  const status = usePlatformStatus();
  const signingIn = useSigningIn();
  const [progress, setProgress] = useState<SetupProgress>("none");

  if (status === "signedIn" && !signingIn && progress === "creatingOwner") {
    setProgress("addingLibrary");
  }

  return <SetupStepsContext value={{ progress, setProgress }}>{children}</SetupStepsContext>;
}

/**
 * This install's setup progress, for the setup screens that move it along.
 *
 * @throws When used outside `SetupProgressProvider`, a programming error.
 */
export const useSetupProgress = (): SetupSteps => {
  const steps = useContext(SetupStepsContext);

  if (steps === null) throw new Error("useSetupProgress needs SetupProgressProvider above it");

  return steps;
};

type Launch = "pending" | "done" | "failed";

/**
 * Signs the app in silently once, when it opens signed out and never had a session of its own,
 * from the grant the phone's shared keychain holds (D48). Pending until that is decided.
 */
const useLaunchSignIn = (status: "loading" | "signedIn" | "signedOut"): Launch => {
  const { onLaunch } = useSignIn();
  const [launch, setLaunch] = useState<Launch>("pending");

  useEffect(() => {
    if (status === "loading" || launch !== "pending") return undefined;

    if (status === "signedIn") {
      setLaunch("done");

      return undefined;
    }

    const stop = new AbortController();

    const run = async () => {
      try {
        await onLaunch();

        if (!stop.signal.aborted) setLaunch("done");
      } catch {
        if (!stop.signal.aborted) setLaunch("failed");
      }
    };

    void run();

    return () => stop.abort();
  }, [status, launch, onLaunch]);

  return launch;
};

/** Whether `waiting` has lasted `afterMs`. */
const useSilent = (waiting: boolean, afterMs: number): boolean => {
  const [silent, setSilent] = useState(false);

  useEffect(() => {
    setSilent(false);

    if (!waiting) return undefined;

    const timer = setTimeout(() => setSilent(true), afterMs);

    return () => clearTimeout(timer);
  }, [waiting, afterMs]);

  return silent;
};

const useLivePhase = (): SessionPhase => {
  const platform = usePlatform();
  const { mediaUrl } = useServer();
  const status = usePlatformStatus();
  const signingIn = useSigningIn();
  const launch = useLaunchSignIn(status);
  const hasDownloads = useHasDownloads();
  const info = useReadSettled(platform.core.server.info, {});

  const me = useReadSettled(
    platform.core.auth.sessions.current,
    status === "signedIn" ? {} : "skip",
  );

  const { progress } = useSetupProgress();
  const answered = info !== undefined && !(info instanceof Error);
  const silent = useSilent(!answered, hasDownloads ? OFFLINE_AFTER_MS : SILENT_AFTER_MS);

  return sessionPhase({
    connected: true,
    silent,
    hasDownloads,
    auth: status,
    launch,
    signingIn,
    hasOwner: answered ? info.hasOwner : undefined,
    me,
    refused: me instanceof Error && isFailure(me, "Unauthenticated"),
    person: lastPerson({ own: appKeychains().own, server: mediaUrl }),
    progress,
  });
};

/**
 * The phase whose screens are on show: the live phase once it has screens, else the last one
 * that did, or null before the server first answers (the splash stays up).
 */
export const useSettledPhase = (): SettledPhase | null => {
  const live = useLivePhase();
  const { attempt, retriedFrom } = useConnectionControls();

  const [shown, setShown] = useState<SettledPhase | null>(
    attempt > 0 ? { kind: retriedFrom } : null,
  );

  const next = settle(live, shown);

  if (next !== null && !sameScreens(next, shown)) setShown(next);

  return next;
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
