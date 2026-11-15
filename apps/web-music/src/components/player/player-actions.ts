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

/** What a device is, as old music's device list told them apart: a computer's browser or a phone. */
export type DeviceKind = "web" | "phone";

/** The names the account client gives browsers, such as `Firefox on Linux` or `Safari`. */
const BROWSER_NAME = /^(?:Edge|Firefox|Chrome|Safari|Browser)(?: on (?<system>.+))?$/u;

/** The systems whose browsers old music counted as phones. */
const PHONE_SYSTEMS = new Set(["iPhone", "Android"]);

/**
 * Whether a device is a computer's browser or a phone, from its name, as old music told them apart:
 * the core keeps no kind, and a browser's name is the one the account client gave it at sign-in. A
 * browser on an iPhone or Android counts as a phone, and so does any other name, such as the phone
 * app's.
 */
export const deviceKind = (name: string): DeviceKind => {
  const system = BROWSER_NAME.exec(name)?.groups?.["system"];

  return BROWSER_NAME.test(name) && !PHONE_SYSTEMS.has(system ?? "") ? "web" : "phone";
};

/**
 * This browser's kind, as old music decided it from the user agent: a phone on an iPhone or an
 * Android phone, else a computer's browser.
 */
export const thisBrowserKind = (userAgent: string = navigator.userAgent): DeviceKind =>
  /iPhone|iPod|Android.*Mobile/u.test(userAgent) ? "phone" : "web";

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
