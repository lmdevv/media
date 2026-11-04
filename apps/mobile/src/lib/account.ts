import type { ApiKey, SessionInfo } from "@media/contracts/models/account";
import type { ApiKeyScope } from "@media/contracts/scopes";

import { dayLabel } from "./dates";
import { sortedBy } from "./sorted-by";

/**
 * The signed-in devices to list: password and device sign-ins, this iPhone first. API key sessions
 * are left to API Keys, since signing one out lasts only until the key's next use.
 */
export const listedDevices = (sessions: ReadonlyArray<SessionInfo>): ReadonlyArray<SessionInfo> =>
  sortedBy(
    sessions.filter((session) => session.kind !== "apikey"),
    (left, right) =>
      left.current === right.current ? right.createdAt - left.createdAt : left.current ? -1 : 1,
  );

/**
 * A device's name: the name a device sign-in gave, `iPhone` for this one, or `Password Sign-In` for
 * a browser or app that signed in with the password.
 */
export const deviceName = (session: SessionInfo): string => {
  if (session.label !== null) return session.label;

  return session.current ? "iPhone" : "Password Sign-In";
};

/** A device's muted detail: `This Device`, or the day it signed in, such as `Yesterday`. */
export const deviceDetail = (session: SessionInfo, now: number): string =>
  session.current ? "This Device" : dayLabel(session.createdAt, now);

/** H12: what each API key permission is called, in the order Create API Key lists them. */
export const KEY_PERMISSIONS: ReadonlyArray<{
  readonly scope: ApiKeyScope;
  readonly label: string;
}> = [
  { scope: "read", label: "Read Library" },
  { scope: "play", label: "Playback" },
  { scope: "manage", label: "Manage Libraries" },
  { scope: "admin", label: "Manage Users" },
];

/** Keys that still work or ran out, without revoked ones, newest first. */
export const listedKeys = (keys: ReadonlyArray<ApiKey>): ReadonlyArray<ApiKey> =>
  sortedBy(
    keys.filter((key) => key.revokedAt === null),
    (a, b) => b.createdAt - a.createdAt,
  );

/** A key's muted detail: `Expired`, or its broadest permission, such as `Playback`. */
export const keyDetail = (key: ApiKey, now: number): string => {
  if (key.expiresAt !== null && key.expiresAt <= now) return "Expired";

  const broadest = KEY_PERMISSIONS.reduce<(typeof KEY_PERMISSIONS)[number] | null>(
    (found, permission) => (key.scopes.includes(permission.scope) ? permission : found),
    null,
  );

  return broadest?.label ?? "";
};
