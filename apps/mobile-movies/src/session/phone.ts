import { ownKeychain, sharedKeychain } from "@media/mobile-core/expo-keychain";
import type { Keychain } from "@media/mobile-core/keychain";
import type { Phone } from "@media/mobile-core/sign-in";
import Constants from "expo-constants";

import { deviceName } from "@/lib/device";

/**
 * The shared keychain access group's name after the Team ID. Every [media] app lists it in its
 * `keychain-access-groups` entitlement, so they share one sign-in on the phone (D48).
 */
const SHARED_GROUP = "dev.lmdevv.media";

let shared: Keychain | null = null;

/**
 * The phone's shared keychain access group, opened on first use. A build without a Team ID, or
 * one that does not carry the group, keeps the shared record in the app's own keychain.
 */
export const sharedPhoneKeychain = (): Keychain => {
  if (shared !== null) return shared;

  const team = Constants.expoConfig?.ios?.appleTeamId ?? null;

  shared = sharedKeychain(team === null ? null : `${team}.${SHARED_GROUP}`).keychain;

  return shared;
};

/** This app on this phone, signing in to the server at `server`. */
export const phoneFor = (server: string): Phone => ({
  own: ownKeychain,
  shared: sharedPhoneKeychain(),
  server,
  deviceName: deviceName(),
});
