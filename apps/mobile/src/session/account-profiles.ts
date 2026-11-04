import type { Profile } from "@media/contracts/models/profiles";

import { useSessionPhase } from "./session-phase";

/**
 * The account's profiles while choosing one or once one is chosen, or null until they load.
 * Screens outside those phases never render, so null means loading.
 */
export const useAccountProfiles = (): ReadonlyArray<Profile> | null => {
  const phase = useSessionPhase();

  if (phase.kind === "chooseProfile") return phase.profiles;

  return phase.kind === "ready" ? phase.active.profiles : null;
};
