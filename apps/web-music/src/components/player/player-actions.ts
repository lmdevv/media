import { moveArrived } from "@media/player/connect-devices";
import type { Device, DeviceKind } from "@media/player/connect-devices";
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

/** Where a move from the Play on list is headed: this browser, or another device. */
export type MoveTarget = "here" | { readonly device: string };

/** A move from the Play on list on its way. */
export interface PendingMove {
  /** Tells this move from earlier ones, whose answers and timeouts change nothing. */
  readonly id: number;
  readonly target: MoveTarget;
  /** The device's name as the list showed it when the move started, `this browser` for here. */
  readonly name: string;
  /** The core took the move: its command answered. */
  readonly landed: boolean;
}

/**
 * Whether `move` has reached its device: the core took it, and this browser holds the song, or the
 * other device answered the move with its own report, not merely the request the core holds for it.
 */
export const moveDone = (
  move: PendingMove,
  player: { readonly here: boolean; readonly devices: ReadonlyArray<Device> },
): boolean =>
  moveArrived(
    { deviceId: move.target === "here" ? null : move.target.device, landed: move.landed },
    player,
  );

/** The repeat mode after the current one when the repeat control is pressed. */
export const NEXT_REPEAT = { off: "all", all: "one", one: "off" } as const;
