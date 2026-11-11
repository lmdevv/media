import { openExpoKeychains } from "@media/mobile-core/expo-keychain";
import { groupsFor } from "@media/mobile-core/keychains";
import type { Keychains } from "@media/mobile-core/keychains";
import Constants from "expo-constants";

let opened: Keychains | null = null;

/**
 * This app's keychains, opened on first use (D48): its own records and session in its private
 * access group, and the phone's shared record in the group every [media] app lists. The groups
 * take the Team ID and bundle identifier from `app.json`; a build without a Team ID names none.
 */
export const appKeychains = (): Keychains => {
  opened ??= openExpoKeychains(
    groupsFor(
      Constants.expoConfig?.ios?.appleTeamId ?? null,
      Constants.expoConfig?.ios?.bundleIdentifier ?? null,
    ),
  );

  return opened;
};
