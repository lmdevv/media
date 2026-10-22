/**
 * The live session phase: what the connected server says about setup, auth, the account, and
 * its libraries, folded by `sessionPhase` and held on screen by `settle`.
 */
import { useAuthActions } from "@convex-dev/auth/react";
import { setupStatus } from "@music/sdk/functions";
import { sessionEnd } from "@music/sdk/errors";
import type { SessionEnd } from "@music/sdk/errors";
import { useReadSettled } from "@music/sdk/react";
import type { Role } from "@music/commands/models";
import { useConvexAuth, useConvexConnectionState, useQuery } from "convex/react";
import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";

import { sessionPhase, settle } from "@/lib/session-phase";
import type { SessionPhase, SettledPhase, SetupProgress } from "@/lib/session-phase";
import { useConnectionControls } from "@/session/connection";

/** This install's setup progress on the connected server, and the way setup screens move it. */
interface SetupSteps {
  readonly progress: SetupProgress;
  readonly setProgress: (next: SetupProgress) => void;
}

const SetupStepsContext = createContext<SetupSteps | null>(null);

/**
 * Holds this install's setup progress for the connected server. Creating the owner ends once the
 * account is signed in, so a later sign-out on this server shows Sign in again.
 */
export function SetupProgressProvider({ children }: { readonly children: ReactNode }) {
  const { isAuthenticated } = useConvexAuth();
  const [progress, setProgress] = useState<SetupProgress>("none");

  if (isAuthenticated && progress === "creatingOwner") setProgress("none");

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

/** Why the server ended this install's session, as the screens that explain it need it. */
export interface EndedSession {
  readonly reason: SessionEnd;
  /** Whether the account was a Jam guest's, which goes when its Jam ends. */
  readonly guest: boolean;
}

/** The ended session, and the ways the phase and G17 move it. */
interface SessionEnding {
  readonly ended: EndedSession | null;
  readonly setEnded: (next: EndedSession | null) => void;
}

const SessionEndContext = createContext<SessionEnding | null>(null);

/**
 * Holds why the server ended this install's session on the connected server. It outlives the
 * token, which is cleared at once, so Sign in and G17 can still say what happened.
 */
export function SessionEndProvider({ children }: { readonly children: ReactNode }) {
  const [ended, setEnded] = useState<EndedSession | null>(null);

  return <SessionEndContext value={{ ended, setEnded }}>{children}</SessionEndContext>;
}

/** Why the server ended the last session, for Sign in and G17. */
export interface EndedSessionControls {
  readonly ended: EndedSession | null;
  /** Forgets why, as G17's Sign out does. */
  readonly forget: () => void;
}

/**
 * Why the server ended the last session, or null, and `forget` for G17's Sign out.
 *
 * @throws When used outside `SessionEndProvider`, a programming error.
 */
export const useEndedSession = (): EndedSessionControls => {
  const ending = useContext(SessionEndContext);

  if (ending === null) throw new Error("useEndedSession needs SessionEndProvider above it");

  return { ended: ending.ended, forget: () => ending.setEnded(null) };
};

/** How long a remembered server may stay silent at launch before G05 offers a way out. */
const SILENT_AFTER_MS = 8000;

/** Whether the WebSocket has been down for `SILENT_AFTER_MS` while the app waits on it. */
export const useSilentServer = (): boolean => {
  const { isWebSocketConnected } = useConvexConnectionState();
  const [silent, setSilent] = useState(false);

  useEffect(() => {
    setSilent(false);

    if (isWebSocketConnected) return undefined;

    const timer = setTimeout(() => setSilent(true), SILENT_AFTER_MS);

    return () => clearTimeout(timer);
  }, [isWebSocketConnected]);

  return silent;
};

/**
 * Why the server refused a settled read's session, given the read's failure if it failed. A
 * failure for any other reason is thrown.
 */
const refusalOf = (failure: Error | undefined): SessionEnd | null => {
  if (failure === undefined) return null;

  const end = sessionEnd(failure);

  if (end === null) throw failure;

  return end;
};

/** A settled read's value, or undefined while it loads or once it failed. */
const valueOf = <Value,>(read: Value | Error | undefined): Value | undefined =>
  read instanceof Error ? undefined : read;

/**
 * When the server stops honoring the session (signed out elsewhere, suspended, or removed), the
 * token is dropped at once, and the reason is kept for the screens that explain it. A session the
 * server accepts again forgets it.
 */
const useSessionEnding = (refusal: SessionEnd | null, role: Role | undefined): void => {
  const { signOut } = useAuthActions();
  const ending = useContext(SessionEndContext);
  const [guest, setGuest] = useState(false);

  if (ending === null) throw new Error("useSettledPhase needs SessionEndProvider above it");

  if (role !== undefined && (role === "guest") !== guest) setGuest(role === "guest");

  const { ended, setEnded } = ending;
  const unrecorded = refusal !== null && ended?.reason !== refusal ? refusal : null;
  const accepted = role !== undefined && refusal === null;

  useEffect(() => {
    if (unrecorded === null) return;

    setEnded({ reason: unrecorded, guest });
    void signOut();
  }, [unrecorded, guest, setEnded, signOut]);

  useEffect(() => {
    if (accepted && ended !== null) setEnded(null);
  }, [accepted, ended, setEnded]);
};

/** The phase of the connected app, from what the server has said so far. */
const useLivePhase = (): SessionPhase => {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const silent = useSilentServer();
  const token = isLoading ? "loading" : isAuthenticated ? "signedIn" : "signedOut";
  const setup = useQuery(setupStatus, {});
  // Settled reads: a session the server refused must not throw past every error boundary and
  // close the client, whether it ended here (signing out) or on the server.
  const meRead = useReadSettled("account.me", token === "signedIn" ? {} : "skip");
  const librariesRead = useReadSettled("libraries.list", token === "signedIn" ? {} : "skip");

  const refusal =
    refusalOf(meRead instanceof Error ? meRead : undefined) ??
    refusalOf(librariesRead instanceof Error ? librariesRead : undefined);

  const me = valueOf(meRead);
  const { progress } = useSetupProgress();
  const { ended } = useEndedSession();

  useSessionEnding(refusal, me?.role);

  return sessionPhase({
    connected: true,
    silent,
    auth: refusal === null ? token : "signedOut",
    ended: ended?.reason ?? refusal,
    setup,
    role: me?.role,
    libraries: valueOf(librariesRead),
    progress,
  });
};

/**
 * The phase whose screens are on show: the live phase once it has screens, else the last one
 * that did, or null before the server first answers (the splash stays up).
 */
export const useSettledPhase = (): SettledPhase | null => {
  const live = useLivePhase();
  const { attempt } = useConnectionControls();

  // Try again on G05 opens a new session; G05 stays on show while it waits, not a blank page.
  const [shown, setShown] = useState<SettledPhase | null>(
    attempt > 0 ? { kind: "unreachable" } : null,
  );

  const next = settle(live, shown);

  if (next !== null && next.kind !== shown?.kind) setShown(next);

  return next;
};
