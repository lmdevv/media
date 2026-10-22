/**
 * What the Play on sheet shows (B05 to B08), derived from the user's devices and the move in
 * progress. One sheet route renders every state, so a move that starts, lands, or fails changes
 * the sheet in place instead of stacking new ones.
 */
import type { DeviceId } from "@music/commands/ids";
import type { DeviceKind } from "@music/commands/models";

import { deviceStatus } from "./playback-format";

/** One of the user's devices, as the player lists it. */
interface DeviceInput {
  readonly id: DeviceId;
  readonly name: string;
  readonly kind: DeviceKind;
  readonly active: boolean;
  readonly online: boolean;
  readonly lastSeenAt: number;
}

/** A move between devices, as the player tracks it. */
type TransferInput =
  | { readonly state: "idle" }
  | { readonly state: "pending"; readonly to: DeviceId }
  | { readonly state: "failed"; readonly to: DeviceId; readonly message: string };

/** A device row in the sheet. */
export interface DeviceRow {
  readonly id: DeviceId;
  /** `This iPhone` for this phone, else the device's own name. */
  readonly name: string;
  readonly kind: DeviceKind;
  /** `Playing now`, `Online`, or when it was last seen. */
  readonly status: string;
  /** Playback is here: accent title and a check. */
  readonly current: boolean;
  readonly thisPhone: boolean;
}

/** The sheet's state. */
export type DeviceSheet =
  /** B05: this phone and the user's other devices. */
  | { readonly kind: "picker"; readonly rows: ReadonlyArray<DeviceRow> }
  /** B08: no other device has signed in. */
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

/** The name this phone goes by in its own sheet. */
const THIS_PHONE = "This iPhone";

/** Everything the sheet is derived from. */
export interface DeviceSheetInput {
  readonly thisDevice: { readonly id: DeviceId; readonly name: string };
  readonly devices: ReadonlyArray<DeviceInput>;
  readonly transfer: TransferInput;
  readonly now: number;
}

const rank = (row: DeviceInput): number => (row.active ? 0 : row.online ? 1 : 2);

/** The sheet for the user's devices and the move in progress. */
export const deviceSheet = ({
  thisDevice,
  devices,
  transfer,
  now,
}: DeviceSheetInput): DeviceSheet => {
  const listed = devices.find((device) => device.id === thisDevice.id);
  const nobodyPlays = !devices.some((device) => device.active);

  // This phone is listed before its first heartbeat lands; with no device playing, it is where
  // playback starts, so it counts as current.
  const phone: DeviceRow = {
    id: thisDevice.id,
    name: THIS_PHONE,
    kind: "phone",
    status: deviceStatus(
      {
        active: listed?.active ?? false,
        online: true,
        lastSeenAt: listed?.lastSeenAt ?? now,
      },
      now,
    ),
    current: (listed?.active ?? false) || nobodyPlays,
    thisPhone: true,
  };

  // Playing first, then online, then the rest, each in the server's order (most recent first).
  const others = [0, 1, 2]
    .flatMap((group) =>
      devices.filter((device) => device.id !== thisDevice.id && rank(device) === group),
    )
    .map((device): DeviceRow => ({
      id: device.id,
      name: device.name,
      kind: device.kind,
      status: deviceStatus(device, now),
      current: device.active,
      thisPhone: false,
    }));

  const rows = [phone, ...others];
  const from = rows.find((row) => row.current) ?? phone;

  if (transfer.state !== "idle") {
    const to = rows.find((row) => row.id === transfer.to);

    if (to !== undefined && to.id !== from.id) {
      return transfer.state === "pending"
        ? { kind: "connecting", from, to }
        : { kind: "failed", from, to, message: transfer.message };
    }
  }

  return others.length === 0 ? { kind: "only", row: phone } : { kind: "picker", rows };
};
