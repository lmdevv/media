import { deviceKind } from "@media/player/connect-devices";
import type { DeviceKind } from "@media/player/connect-devices";

import { HERE } from "./transfer";
import type { MoveTarget, Transfer } from "./transfer";
import type { DeviceFamily } from "./device-family";
import { sortedBy } from "./sorted-by";

/** A device row in the sheet. */
export interface DeviceRow {
  /** `HERE` for this phone, else the device's id. */
  readonly target: MoveTarget;
  /** `This iPhone` or `This iPad` for this device, else the device's own name. */
  readonly name: string;
  readonly kind: DeviceKind;
  readonly status: "Playing now" | "Online";
  /** Playback is here: accent title and a check. */
  readonly current: boolean;
  readonly thisPhone: boolean;
}

/** The sheet's state. */
export type DeviceSheet =
  /** B05: this phone and the person's other devices. */
  | { readonly kind: "picker"; readonly rows: ReadonlyArray<DeviceRow> }
  /** B08: no other device is online. */
  | { readonly kind: "only"; readonly row: DeviceRow }
  /** B06: playback is moving from `from` to `to`; `from` keeps playing until it lands. */
  | { readonly kind: "connecting"; readonly from: DeviceRow; readonly to: DeviceRow }
  /** B07: the move to `to` failed, and playback stayed on `from`. */
  | {
      readonly kind: "failed";
      readonly from: DeviceRow;
      readonly to: DeviceRow;
      readonly message: string;
    };

/** Everything the sheet is derived from. */
export interface DeviceSheetInput {
  /** What this device is; its own row reads `This iPad` or `This iPhone`. */
  readonly family: DeviceFamily;
  /** The person's other devices that are online now, by name (ADR 0018). */
  readonly devices: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  /** The device that plays: `HERE` while a song is loaded on this phone, another's id, or null. */
  readonly active: MoveTarget | null;
  readonly transfer: Transfer;
}

const PLAYING = "Playing now";

const ONLINE = "Online";

/**
 * The sheet for the person's devices and the move in progress: this phone first, then the device
 * that plays, then the rest by name. With nothing playing anywhere, this phone is the current one.
 */
export const deviceSheet = ({
  family,
  devices,
  active,
  transfer,
}: DeviceSheetInput): DeviceSheet => {
  const phone: DeviceRow = {
    target: HERE,
    name: `This ${family}`,
    kind: "phone",
    status: active === HERE ? PLAYING : ONLINE,
    current: active === HERE || active === null,
    thisPhone: true,
  };

  const others = sortedBy(
    devices.map((device): DeviceRow => {
      const playing = device.id === active;

      return {
        target: device.id,
        name: device.name,
        kind: deviceKind(device.name),
        status: playing ? PLAYING : ONLINE,
        current: playing,
        thisPhone: false,
      };
    }),
    (left, right) => Number(right.current) - Number(left.current),
  );

  const rows = [phone, ...others];
  const from = rows.find((row) => row.current) ?? phone;

  if (transfer.state !== "idle") {
    const to = rows.find((row) => row.target === transfer.to);

    if (to !== undefined && to.target !== from.target) {
      return transfer.state === "pending"
        ? { kind: "connecting", from, to }
        : { kind: "failed", from, to, message: transfer.message };
    }
  }

  return others.length === 0 ? { kind: "only", row: phone } : { kind: "picker", rows };
};
