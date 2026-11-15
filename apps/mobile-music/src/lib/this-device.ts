import { Platform } from "react-native";

import type { DeviceFamily } from "./device-family";

/** `iPad` on an iPad, else `iPhone`: the app is built for iOS only. */
export const DEVICE_FAMILY: DeviceFamily =
  Platform.OS === "ios" && Platform.isPad ? "iPad" : "iPhone";

/**
 * Where the music plays, as the device button and the iPad player bar name it: this device, or
 * the one the player follows.
 */
export const whereItPlays = (remote: { readonly name: string } | null): string =>
  remote === null ? `This ${DEVICE_FAMILY}` : `Playing on ${remote.name}`;
