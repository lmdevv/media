import type { Infer } from "convex/values";
import { v } from "convex/values";

import { register } from "../../commands/core/settings";
import {
  deviceSettingDefaults,
  deviceSettingFields,
  deviceSettingNames,
  settingTable,
  userSettingDefaults,
  userSettingFields,
  userSettingNames,
} from "../../commands/settings";
import type { SettingName } from "../../commands/settings";
import type { Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import type { Caller } from "./auth/caller";
import { fail } from "./lib/errors";
import { can } from "./permissions/policy";

const userValues = v.object(userSettingFields);

const deviceValues = v.object(deviceSettingFields);

type UserChanges = Infer<typeof userValues>;

type DeviceChanges = Infer<typeof deviceValues>;

type UserSettings = Required<UserChanges>;

type DeviceSettings = Required<DeviceChanges>;

interface SettingsView {
  readonly user: UserSettings;
  readonly device: DeviceSettings | null;
}

const USER_DEFAULTS: UserSettings = userSettingDefaults;

const DEVICE_DEFAULTS: DeviceSettings = deviceSettingDefaults;

const USER_NAMES: ReadonlyArray<keyof UserChanges> = userSettingNames;

const DEVICE_NAMES: ReadonlyArray<keyof DeviceChanges> = deviceSettingNames;

const NAMES: ReadonlyArray<SettingName> = [...USER_NAMES, ...DEVICE_NAMES];

const LANGUAGE = /^[a-z]{2}$/u;

const picked = <T extends object, K extends keyof T>(
  source: T,
  names: ReadonlyArray<K>,
): Partial<Pick<T, K>> => {
  const out: Partial<Pick<T, K>> = {};

  for (const name of names) {
    if (source[name] !== undefined) out[name] = source[name];
  }

  return out;
};

type Changes = UserChanges & DeviceChanges;

type Table = typeof settingTable;

type CheckedBy<K extends Table[SettingName]["check"]["kind"]> = {
  readonly [N in SettingName]: Table[N]["check"]["kind"] extends K ? N : never;
}[SettingName];

const takesLanguage = (name: SettingName): name is CheckedBy<"language"> =>
  settingTable[name].check.kind === "language";

const takesRange = (name: SettingName): name is CheckedBy<"range"> =>
  settingTable[name].check.kind === "range";

/** Why the value `changes` gives setting `name` breaks its check, or null when it keeps it. */
export const refusalOf = (name: SettingName, changes: Changes): string | null => {
  if (takesLanguage(name)) {
    const value = changes[name];

    return value === undefined || value === null || LANGUAGE.test(value)
      ? null
      : `${name} takes a two-letter language code, such as "en", or null`;
  }

  if (!takesRange(name)) return null;

  const value = changes[name];
  const { min, max, whole } = settingTable[name].check;

  return value === undefined ||
    (value >= min && value <= max && (!whole || Number.isInteger(value)))
    ? null
    : `${name} takes a ${whole ? "whole number" : "number"} from ${min} to ${max}`;
};

const requireChange = (caller: Caller, name: SettingName): void => {
  const decision = can(caller, "change", {
    on: "setting",
    owner: caller.userId,
    domains: settingTable[name].domains,
  });

  if (!decision.allowed) fail("forbidden", `This session cannot change ${name}`);
};

const userRow = (db: DatabaseReader, userId: Id<"users">) =>
  db
    .query("userSettings")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();

const deviceRow = (db: DatabaseReader, deviceId: Id<"devices">, userId: Id<"users">) =>
  db
    .query("deviceSettings")
    .withIndex("by_device_user", (q) => q.eq("deviceId", deviceId).eq("userId", userId))
    .unique();

interface Stored {
  readonly user: UserChanges;
  readonly device: DeviceChanges;
}

/** What the caller's rows hold; the device's half is empty for a session on no device. */
const storedFor = async (db: DatabaseReader, caller: Caller) => {
  const { deviceId } = caller;

  const [user, device] = await Promise.all([
    userRow(db, caller.userId),
    deviceId === null ? null : deviceRow(db, deviceId, caller.userId),
  ]);

  return { user, device };
};

const valuesOf = (rows: Awaited<ReturnType<typeof storedFor>>): Stored => ({
  user: rows.user === null ? {} : picked(rows.user, USER_NAMES),
  device: rows.device === null ? {} : picked(rows.device, DEVICE_NAMES),
});

const viewOf = (caller: Caller, stored: Stored): SettingsView => ({
  user: { ...USER_DEFAULTS, ...stored.user },
  device: caller.deviceId === null ? null : { ...DEVICE_DEFAULTS, ...stored.device },
});

/**
 * Splits a change by who holds each value, after deciding the caller's right to change each
 * setting, then the device, then the values, so a refused call writes nothing.
 */
const parseChanges = (caller: Caller, changes: Changes): Stored => {
  const named = NAMES.filter((name) => changes[name] !== undefined);

  if (named.length === 0) fail("invalid_args", "Name at least one setting to change");

  for (const name of named) requireChange(caller, name);

  const device = picked(changes, DEVICE_NAMES);

  if (caller.deviceId === null && Object.keys(device).length > 0) {
    fail(
      "conflict",
      "This session is on no device, so it keeps no device settings; register this app first",
    );
  }

  for (const name of named) {
    const why = refusalOf(name, changes);

    if (why !== null) fail("invalid_args", why);
  }

  return { user: picked(changes, USER_NAMES), device };
};

export const { get, set } = register({
  get: async (ctx, _args, caller) => viewOf(caller, valuesOf(await storedFor(ctx.db, caller))),
  set: async (ctx, args, caller) => {
    const changes = parseChanges(caller, args);
    const rows = await storedFor(ctx.db, caller);
    const { userId, deviceId } = caller;

    if (Object.keys(changes.user).length > 0) {
      if (rows.user === null) await ctx.db.insert("userSettings", { userId, ...changes.user });
      else await ctx.db.patch(rows.user._id, changes.user);
    }

    if (deviceId !== null && Object.keys(changes.device).length > 0) {
      if (rows.device === null) {
        await ctx.db.insert("deviceSettings", { deviceId, userId, ...changes.device });
      } else {
        await ctx.db.patch(rows.device._id, changes.device);
      }
    }

    const stored = valuesOf(rows);

    return viewOf(caller, {
      user: { ...stored.user, ...changes.user },
      device: { ...stored.device, ...changes.device },
    });
  },
});
