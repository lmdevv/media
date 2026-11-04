import type { Profile } from "@media/contracts/models/profiles";
import { createContext, useContext } from "react";

/** The profile on screen and its account's other profiles. */
export interface ActiveProfile {
  readonly profile: Profile;
  readonly profiles: ReadonlyArray<Profile>;
}

export const ActiveProfileContext = createContext<ActiveProfile | null>(null);

/**
 * The chosen, unlocked profile. Pass its id to every profile-scoped command.
 *
 * @throws When used before a profile is chosen, a programming error.
 */
export const useActiveProfile = (): ActiveProfile => {
  const active = useContext(ActiveProfileContext);

  if (active === null) throw new Error("useActiveProfile must be used once a profile is chosen");

  return active;
};
