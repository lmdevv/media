import type { ProfileId } from "@media/contracts/ids";
import { useCommand } from "@media/sdk/react";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { loadProfileChoice, saveProfileChoice } from "@/lib/device-storage";
import { toastFailure } from "@/lib/failure";

/** The profile chosen on this browser and the way to change it. */
export interface ProfileChoice {
  /** The chosen profile, or null before anyone picked one on this browser. */
  readonly profileId: ProfileId | null;
  /** Chooses a profile (persisted per browser), or forgets the choice with null. */
  readonly choose: (profileId: ProfileId | null) => void;
}

const ProfileChoiceContext = createContext<ProfileChoice | null>(null);

/**
 * Holds the per-browser profile choice, starting from what `localStorage` remembers. Switching to
 * another profile locks the one left behind on this session, so a PIN keeps guarding it: unlocks
 * live on the server session, which every profile on this browser shares.
 */
export function ProfileChoiceProvider({ children }: { readonly children: ReactNode }) {
  const [profileId, setProfileId] = useState<ProfileId | null>(loadProfileChoice);
  const current = useRef(profileId);
  const lock = useCommand("profiles.lock");

  const commit = useCallback((next: ProfileId | null) => {
    current.current = next;
    saveProfileChoice(next);
    setProfileId(next);
  }, []);

  const choose = useCallback(
    (next: ProfileId | null) => {
      const previous = current.current;

      if (previous === null || next === null || previous === next) {
        commit(next);

        return;
      }

      void (async () => {
        try {
          await lock({ profileId: previous });
          commit(next);
        } catch (cause) {
          toastFailure(cause);
        }
      })();
    },
    [commit, lock],
  );

  const value = useMemo(() => ({ profileId, choose }), [profileId, choose]);

  return <ProfileChoiceContext.Provider value={value}>{children}</ProfileChoiceContext.Provider>;
}

/**
 * The profile chosen on this browser. Prefer `useActiveProfile` inside signed-in screens: it also
 * guarantees the profile exists and is unlocked.
 *
 * @throws When used outside `ProfileChoiceProvider`, a programming error.
 */
export const useProfileChoice = (): ProfileChoice => {
  const choice = useContext(ProfileChoiceContext);

  if (choice === null)
    throw new Error("useProfileChoice must be used inside ProfileChoiceProvider");

  return choice;
};
