import type { PlatformSdk } from "@media/sdk/promise";
import { Brand } from "effect";

import { sortedBy } from "./sorted-by";

type Result<Method> = Method extends (...args: never) => Promise<infer A> ? A : never;

/** A registered device, as `core.devices.registry.list` lists it. */
export type Device = Result<PlatformSdk["core"]["devices"]["registry"]["list"]>["page"][number];

/** A registered device's ID. */
export type DeviceId = Device["deviceId"];

/** A device ID from a route parameter; the core answers `NotFound` for one that names no device. */
export const asDeviceId = Brand.nominal<DeviceId>();

/** The devices to list, newest first as the core lists them, with this phone first. */
export const listedDevices = (
  devices: ReadonlyArray<Device>,
  own: DeviceId | null,
): ReadonlyArray<Device> =>
  sortedBy(
    devices,
    (left, right) => Number(right.deviceId === own) - Number(left.deviceId === own),
  );

/** A device's muted detail: `This Device`, or whether it is `Personal` or `Shared`. */
export const deviceDetail = (device: Device, own: DeviceId | null): string => {
  if (device.deviceId === own) return "This Device";

  return device.mode === "shared" ? "Shared" : "Personal";
};

/** The fewest characters the core takes in a new password. */
export const PASSWORD_MIN = 8;

/** The most characters the core takes in a new password. */
export const PASSWORD_MAX = 256;

/**
 * Why the core would refuse `password` as a new password, or null when it fits the rule: 8 to 256
 * characters, counted as the code points of its NFKC form, as the core and the web client count.
 */
export const passwordProblem = (password: string): string | null => {
  const length = Array.from(password.normalize("NFKC")).length;

  return length < PASSWORD_MIN || length > PASSWORD_MAX
    ? `Use ${PASSWORD_MIN} to ${PASSWORD_MAX} characters`
    : null;
};
