import type { PlatformSdk } from "@media/sdk/promise";
import { Brand } from "effect";

import { dayLabel } from "./dates";
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

/** One of the person's signed-in browsers, apps, or devices, as `core.auth.sessions.list` lists it. */
export type Session = Result<PlatformSdk["core"]["auth"]["sessions"]["list"]>["page"][number];

/** A session ID from a route parameter; the core answers `NotFound` for one that names no session. */
export const asSessionId = Brand.nominal<Session["sessionId"]>();

/** The signed-in devices to list: this iPhone first, the rest newest first as the core lists them. */
export const listedSessions = (sessions: ReadonlyArray<Session>): ReadonlyArray<Session> =>
  sortedBy(sessions, (left, right) => Number(right.current) - Number(left.current));

/**
 * A device's name: the name its device or device sign-in gave, `iPhone` for this one, or
 * `Password Sign-In` for a browser or app that signed in with the password on no device.
 */
export const sessionName = (session: Session): string => {
  if (session.name !== null) return session.name;

  return session.current ? "iPhone" : "Password Sign-In";
};

/** A device's muted detail: `This Device`, or the day it signed in, such as `Yesterday`. */
export const sessionDetail = (session: Session, now: number): string =>
  session.current ? "This Device" : dayLabel(session.signedInAt, now);

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
