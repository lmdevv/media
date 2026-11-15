import { LaptopIcon, SmartphoneIcon } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { toastFailure } from "@/lib/action";

/**
 * Runs a player action without awaiting it. Player actions don't reject (a failure becomes the
 * player `error`); anything else that rejects is reported as a toast.
 */
export const perform = (action: Promise<void>): void => {
  action.catch(toastFailure);
};

/** What a device is, as old music's device list told them apart: a browser or the phone app. */
export type DeviceKind = "web" | "phone";

/** The names the account client gives browsers, such as `Firefox on Linux` or `Safari`. */
const BROWSER_NAME = /^(?:Edge|Firefox|Chrome|Safari|Browser)(?: on .+)?$/u;

/**
 * Whether a device is a browser or the phone app, from its name: the core keeps no kind, and a
 * browser's name is the one the account client gave it at sign-in.
 */
export const deviceKind = (name: string): DeviceKind => (BROWSER_NAME.test(name) ? "web" : "phone");

/** How old music's device list labels a device of each kind. */
export const KIND_LABEL: Readonly<Record<DeviceKind, string>> = { web: "Browser", phone: "Phone" };

const DEVICE_ICONS: Readonly<Record<DeviceKind, LucideIcon>> = {
  web: LaptopIcon,
  phone: SmartphoneIcon,
};

/** The icon for a device of `kind`: a laptop for a browser, a phone for the phone app. */
export const deviceIcon = (kind: DeviceKind): LucideIcon => DEVICE_ICONS[kind];

/** The repeat mode after the current one when the repeat control is pressed. */
export const NEXT_REPEAT = { off: "all", all: "one", one: "off" } as const;
