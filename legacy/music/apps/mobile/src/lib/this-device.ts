/** What the app runs on, read once from the platform, for the words that name this device. */
import { Platform } from "react-native";

import type { DeviceFamily } from "./device-family";

/** `iPad` on an iPad, else `iPhone`: the app is built for iOS only. */
export const DEVICE_FAMILY: DeviceFamily =
  Platform.OS === "ios" && Platform.isPad ? "iPad" : "iPhone";
