import { useAuth, useCommandQuery } from "@media/sdk/react";
import type { QueryState } from "@media/sdk/react";
import type { SetupStatus } from "@media/contracts/models/account";
import type { Profile } from "@media/contracts/models/profiles";
import { createContext, useContext, useMemo, useState } from "react";

import { isFailure } from "@/lib/failure";

import type { ActiveProfile } from "./active-profile";
import { useFirstRun } from "./first-run";
import { useProfileChoice } from "./profile-choice";

/** The phases the root stack switches between. */
export type SessionPhase =
  | { readonly kind: "loading" }
  | { readonly kind: "disconnected" }
  | { readonly kind: "signedOut" }
  /** Signed out on a server without an owner yet, or while the owner account is created (I14). */
  | { readonly kind: "createOwner" }
  /** The owner just created here sets up a first library (I15) before choosing a profile. */
  | { readonly kind: "setup"; readonly profiles: ReadonlyArray<Profile> }
  | { readonly kind: "chooseProfile"; readonly profiles: ReadonlyArray<Profile> }
  | { readonly kind: "ready"; readonly active: ActiveProfile }
  /** Signed in, but the profiles could not be read; `retry` asks again. */
  | { readonly kind: "unavailable"; readonly cause: unknown; readonly retry: () => void };

const signedOutPhase = (setup: QueryState<SetupStatus>, settingUp: boolean): SessionPhase => {
  // Convex reports the new owner before the sign-up resolves, so setup holds the form meanwhile.
  if (settingUp) return { kind: "createOwner" };

  return setup.status === "success" && !setup.data.hasOwner
    ? { kind: "createOwner" }
    : { kind: "signedOut" };
};

const phaseFor = (
  status: "loading" | "signedIn" | "signedOut",
  profiles: QueryState<ReadonlyArray<Profile>>,
  profileId: string | null,
  setup: QueryState<SetupStatus>,
  settingUp: boolean,
): SessionPhase => {
  if (status === "loading") return { kind: "loading" };

  if (status === "signedOut") return signedOutPhase(setup, settingUp);

  if (profiles.status === "loading") return { kind: "loading" };

  if (profiles.status === "error") {
    return isFailure(profiles.error, "Unauthenticated")
      ? { kind: "loading" }
      : { kind: "unavailable", cause: profiles.error, retry: profiles.retry };
  }

  if (settingUp) return { kind: "setup", profiles: profiles.data };

  const profile = profiles.data.find((candidate) => candidate.id === profileId);

  if (profile === undefined || profile.locked) {
    return { kind: "chooseProfile", profiles: profiles.data };
  }

  return { kind: "ready", active: { profile, profiles: profiles.data } };
};

/** The phase of the connected app, computed from the session and the profile list. */
export const useLiveSessionPhase = (): SessionPhase => {
  const { status } = useAuth();
  const { profileId } = useProfileChoice();
  const profiles = useCommandQuery("profiles.list", status === "signedIn" ? {} : "skip");
  const setup = useCommandQuery("setup.status", status === "signedOut" ? {} : "skip");
  const settingUp = useFirstRun().active;

  return useMemo(
    () => phaseFor(status, profiles, profileId, setup, settingUp),
    [status, profiles, profileId, setup, settingUp],
  );
};

/** A phase the root stack has screens for. */
export type SettledPhase = Extract<
  SessionPhase,
  { readonly kind: "signedOut" | "createOwner" | "setup" | "chooseProfile" | "ready" }
>;

const isSettled = (phase: SessionPhase): phase is SettledPhase =>
  phase.kind === "signedOut" ||
  phase.kind === "createOwner" ||
  phase.kind === "setup" ||
  phase.kind === "chooseProfile" ||
  phase.kind === "ready";

const sameScreens = (next: SettledPhase, last: SettledPhase | null): boolean => {
  if (last === null || next.kind !== last.kind) return false;

  return (
    next.kind !== "ready" ||
    (last.kind === "ready" && next.active.profile.id === last.active.profile.id)
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

/** The settled phase, shared so screens read it without subscribing to the profiles again. */
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
