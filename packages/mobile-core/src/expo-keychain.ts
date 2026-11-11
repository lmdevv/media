import * as SecureStore from "expo-secure-store";

import { openKeychains } from "./keychains";
import type { KeychainGroups, Keychains } from "./keychains";

/** Opens an app's keychains over expo-secure-store in `groups` (D48); see `openKeychains`. */
export const openExpoKeychains = (groups: KeychainGroups): Keychains =>
  openKeychains(SecureStore, groups);
