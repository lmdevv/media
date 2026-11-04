import type { ProfileId } from "@media/contracts/ids";
import { useCommand } from "@media/sdk/react";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { isFailure } from "@/lib/failure";
import { loadProfileChoice, saveProfileChoice } from "@/lib/profile-store";

/** The profile chosen on this device and the way to change it. */
export interface ProfileChoice {
  readonly profileId: ProfileId | null;
  /**
   * Chooses a profile, or forgets the choice with null. Leaving one profile for another resolves
   * once the one left behind is locked, and rejects, back on that profile, when locking fails.
   */
  readonly choose: (profileId: ProfileId | null) => Promise<void>;
}

const ProfileChoiceContext = createContext<ProfileChoice | null>(null);

/** Holds the profile choice, starting from the one this device remembers. */
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
    async (next: ProfileId | null) => {
      const previous = current.current;

      if (previous === null || next === null || previous === next) {
        commit(next);

        return;
      }

      commit(next);

      try {
        await lock({ profileId: previous });
      } catch (cause) {
        if (isFailure(cause, "NotFound") || isFailure(cause, "Forbidden")) return;

        if (current.current === next) commit(previous);
        throw cause;
      }
    },
    [commit, lock],
  );

  const value = useMemo(() => ({ profileId, choose }), [profileId, choose]);

  return <ProfileChoiceContext.Provider value={value}>{children}</ProfileChoiceContext.Provider>;
}

/**
 * The profile chosen on this device.
 *
 * @throws When used outside `ProfileChoiceProvider`, a programming error.
 */
export const useProfileChoice = (): ProfileChoice => {
  const choice = useContext(ProfileChoiceContext);

  if (choice === null)
    throw new Error("useProfileChoice must be used inside ProfileChoiceProvider");

  return choice;
};
