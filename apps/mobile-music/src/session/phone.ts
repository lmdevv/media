import type { Phone } from "@media/mobile-core/sign-in";

import { deviceName } from "@/lib/device";
import { appKeychains } from "@/lib/keychains";

/** This app on this phone, signing in to the server at `server`. */
export const phoneFor = (server: string): Phone => {
  const { own, shared } = appKeychains();

  return { own, shared, server, deviceName: deviceName() };
};
