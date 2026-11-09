import type { PaginationOptions, PaginationResult } from "convex/server";
import { v } from "convex/values";
import type { Infer } from "convex/values";

import { register } from "../../../commands/core/devices/registry";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { internalMutation } from "../../_generated/server";
import type { DatabaseReader, MutationCtx } from "../../_generated/server";
import { refuseKeys, requireCaller } from "../auth/caller";
import type { Caller } from "../auth/caller";
import { fail } from "../lib/errors";
import { requireDeviceName } from "../lib/names";
import { paginate } from "../lib/paginate";
import { takeAttempt } from "../lib/rateLimit";
import {
  constantTimeEqual,
  formatSecret,
  parseSecret,
  randomSecret,
  sha256Hex,
} from "../lib/secrets";
import { dropConnect } from "../connect/facts";
import { requireServer } from "../permissions/authorize";
import type { PersonDoc } from "../permissions/policy";
import { purgeDevicePage } from "../downloads";
import { endSession, liveOnDevice } from "../sessions";
import { dropApprovals } from "./approvals";
import { DEVICE_PREFIX, NO_DEVICE } from "./facts";

const DEVICE_SESSIONS_READ = 200;

const ENROLLS_PER_HOUR = 20;

const PURGE_BATCH = 100;

interface SignedInHere {
  readonly sessionId: Id<"authSessions">;
  readonly person: PersonDoc;
}

/** Each distinct user of `sessions`, read once. */
const usersOf = async (
  db: DatabaseReader,
  sessions: ReadonlyArray<Doc<"authSessions">>,
): Promise<ReadonlyMap<Id<"users">, Doc<"users">>> => {
  const ids = [...new Set(sessions.map((session) => session.userId))];
  const users = await Promise.all(ids.map((userId) => db.get(userId)));

  return new Map(users.flatMap((user) => (user === null ? [] : [[user._id, user] as const])));
};

/** The live sessions on a personal device and the people they sign in. */
export const signedInOn = async (
  db: DatabaseReader,
  device: Doc<"devices">,
  now: number,
): Promise<ReadonlyArray<SignedInHere>> => {
  const sessions = await db
    .query("authSessions")
    .withIndex("by_device_user", (q) => q.eq("device.id", device._id))
    .take(DEVICE_SESSIONS_READ);

  const users = await usersOf(db, sessions);

  return sessions.flatMap((session) => {
    const user = users.get(session.userId);

    return user?.kind === "person" && liveOnDevice(session, user, device, now)
      ? [{ sessionId: session._id, person: user }]
      : [];
  });
};

/**
 * Binds the caller's session to a personal device and ends every other session there, whoever's,
 * so a device holds one session (ADR 0006). Answers the join's number on the device: a later join
 * ends this session, so of two sign-ins the higher number is the one still live.
 */
const joinDevice = async (
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  caller: Caller,
  device: Doc<"devices">,
): Promise<number> => {
  const here = await signedInOn(ctx.db, device, Date.now());

  await Promise.all(
    here.flatMap(({ sessionId }) =>
      sessionId === caller.sessionId ? [] : [endSession(ctx, sessionId)],
    ),
  );

  const joined = (device.joins ?? 0) + 1;

  await ctx.db.patch(device._id, { joins: joined });
  await ctx.db.patch(caller.sessionId, {
    device: { id: device._id, generation: device.generation, joined },
  });

  return joined;
};

const joinedDevice = v.object({ deviceId: v.id("devices"), joinSequence: v.number() });

/** Binds the caller's session to the personal device a code names; null when it names none. */
export const attach = internalMutation({
  args: { deviceId: v.string(), secretHash: v.string(), name: v.string() },
  returns: v.union(joinedDevice, v.null()),
  handler: async (ctx, { deviceId, secretHash, name }) => {
    const caller = refuseKeys(await requireCaller(ctx, "account"));
    const id = ctx.db.normalizeId("devices", deviceId);
    const device = id === null ? null : await ctx.db.get(id);

    if (device === null || !constantTimeEqual(device.secretHash, secretHash)) return null;

    if (device.mode === "shared") {
      return fail("conflict", "This device is shared; open a tile from its picker instead");
    }

    const named = requireDeviceName(name);

    if (named !== device.name) await ctx.db.patch(device._id, { name: named });

    return { deviceId: device._id, joinSequence: await joinDevice(ctx, caller, device) };
  },
});

/** Registers a new personal device and binds the caller's session to it. */
export const insert = internalMutation({
  args: { secretHash: v.string(), name: v.string() },
  returns: joinedDevice,
  handler: async (ctx, { secretHash, name }) => {
    const caller = refuseKeys(await requireCaller(ctx, "account"));
    const limit = { identifier: `devices:${caller.userId}`, perHour: ENROLLS_PER_HOUR };

    if (!(await takeAttempt(ctx, limit, Date.now()))) {
      return fail("rate_limited", "Too many devices registered; try again in a few minutes");
    }

    const generation = 0;
    const joinSequence = 1;

    const deviceId = await ctx.db.insert("devices", {
      name: requireDeviceName(name),
      secretHash,
      generation,
      joins: joinSequence,
      mode: "personal",
    });

    await ctx.db.patch(caller.sessionId, {
      device: { id: deviceId, generation, joined: joinSequence },
    });

    return { deviceId, joinSequence };
  },
});

const deleteEndedSessions = async (
  ctx: Pick<MutationCtx, "db">,
  deviceId: Id<"devices">,
  options: PaginationOptions,
  now: number,
): Promise<PaginationResult<Doc<"authSessions">>> => {
  const page = await paginate(
    ctx.db,
    { table: "authSessions", index: "by_device_user", range: (q) => q.eq("device.id", deviceId) },
    options,
  );

  const [device, users] = await Promise.all([ctx.db.get(deviceId), usersOf(ctx.db, page.page)]);

  await Promise.all(
    page.page.map(async (session) => {
      const user = users.get(session.userId);

      const live =
        device !== null && user !== undefined && liveOnDevice(session, user, device, now);

      if (!live) await ctx.db.delete(session._id);
    }),
  );

  return page;
};

const deleteStrikes = async (
  ctx: Pick<MutationCtx, "db">,
  deviceId: Id<"devices">,
  options: PaginationOptions,
): Promise<PaginationResult<Doc<"unlockStrikes">>> => {
  const page = await paginate(
    ctx.db,
    { table: "unlockStrikes", index: "by_device_user", range: (q) => q.eq("deviceId", deviceId) },
    options,
  );

  await Promise.all(page.page.map((strike) => ctx.db.delete(strike._id)));

  return page;
};

const deleteSettings = async (
  ctx: Pick<MutationCtx, "db">,
  deviceId: Id<"devices">,
  options: PaginationOptions,
): Promise<PaginationResult<Doc<"deviceSettings">>> => {
  const page = await paginate(
    ctx.db,
    { table: "deviceSettings", index: "by_device_user", range: (q) => q.eq("deviceId", deviceId) },
    options,
  );

  await Promise.all(page.page.map((row) => ctx.db.delete(row._id)));

  return page;
};

type Purger = (
  ctx: Pick<MutationCtx, "db">,
  deviceId: Id<"devices">,
  options: PaginationOptions,
) => Promise<Pick<PaginationResult<unknown>, "isDone" | "continueCursor">>;

const purgers = {
  authSessions: (ctx, deviceId, options) => deleteEndedSessions(ctx, deviceId, options, Date.now()),
  unlockStrikes: deleteStrikes,
  deviceSettings: deleteSettings,
  downloads: purgeDevicePage,
} satisfies Record<string, Purger>;

const purgeArgs = {
  deviceId: v.id("devices"),
  table: v.union(
    v.literal("authSessions"),
    v.literal("unlockStrikes"),
    v.literal("deviceSettings"),
    v.literal("downloads"),
  ),
  cursor: v.union(v.string(), v.null()),
};

/**
 * Deletes what a device change left behind, a page at a time: the sessions bound to the device
 * that ended, every unlock-code strike on it, or, once it is removed, every person's settings and
 * downloads on it. Liveness already ended those sessions, so no one reads them meanwhile.
 */
export const purge = internalMutation({
  args: purgeArgs,
  returns: v.null(),
  handler: async (ctx, { deviceId, table, cursor }) => {
    const page = await purgers[table](ctx, deviceId, { numItems: PURGE_BATCH, cursor });

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.core.devices.registry.purge, {
        deviceId,
        table,
        cursor: page.continueCursor,
      });
    }

    return null;
  },
});

/**
 * Clears what a device kept: its ended sessions, and when it was shared, its approval at once and
 * its unlock-code strikes in scheduled pages.
 */
const purgeLeftovers = async (
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  device: Doc<"devices">,
): Promise<void> => {
  const deviceId = device._id;

  await ctx.scheduler.runAfter(0, internal.core.devices.registry.purge, {
    deviceId,
    table: "authSessions",
    cursor: null,
  });

  if (device.mode !== "shared") return;

  await dropApprovals(ctx, deviceId);

  await ctx.scheduler.runAfter(0, internal.core.devices.registry.purge, {
    deviceId,
    table: "unlockStrikes",
    cursor: null,
  });
};

export const { enroll, list, setMode, remove } = register({
  enroll: async (ctx, { name, device }) => {
    requireDeviceName(name);

    const stored = device?.trim();
    const parsed = stored === undefined ? null : parseSecret(DEVICE_PREFIX, stored);

    if (stored !== undefined && parsed !== null) {
      const found: Infer<typeof joinedDevice> | null = await ctx.runMutation(
        internal.core.devices.registry.attach,
        { deviceId: parsed.rowId, secretHash: await sha256Hex(parsed.secret), name },
      );

      if (found !== null) return { ...found, device: stored };
    }

    const secret = randomSecret(32);

    const created: Infer<typeof joinedDevice> = await ctx.runMutation(
      internal.core.devices.registry.insert,
      { secretHash: await sha256Hex(secret), name },
    );

    return { ...created, device: formatSecret(DEVICE_PREFIX, created.deviceId, secret) };
  },
  list: async (ctx, { paginationOpts }, caller) => {
    requireServer(caller, "manageDevices");

    const page = await paginate(
      ctx.db,
      { table: "devices", index: "by_creation_time", order: "desc" },
      paginationOpts,
    );

    return {
      ...page,
      page: page.page.map((device) => ({
        deviceId: device._id,
        name: device.name,
        mode: device.mode,
      })),
    };
  },
  setMode: async (ctx, { deviceId, mode }, caller) => {
    requireServer(caller, "manageDevices");

    const device = (await ctx.db.get(deviceId)) ?? fail("not_found", NO_DEVICE);

    if (device.mode === mode) return null;

    const common = {
      name: device.name,
      secretHash: device.secretHash,
      generation: device.generation + 1,
    };

    // The join count goes on across modes, so a client's last join stays lower than the next.
    const fields = device.joins === undefined ? common : { ...common, joins: device.joins };

    await ctx.db.replace(
      device._id,
      mode === "shared" ? { ...fields, mode, tile: null } : { ...fields, mode },
    );

    await purgeLeftovers(ctx, device);

    return null;
  },
  remove: async (ctx, { deviceId }, caller) => {
    requireServer(caller, "manageDevices");

    const device = (await ctx.db.get(deviceId)) ?? fail("not_found", NO_DEVICE);

    await ctx.db.delete(deviceId);
    await dropConnect(ctx, deviceId);
    await purgeLeftovers(ctx, device);

    await Promise.all(
      (["deviceSettings", "downloads"] as const).map(async (table) =>
        ctx.scheduler.runAfter(0, internal.core.devices.registry.purge, {
          deviceId,
          table,
          cursor: null,
        }),
      ),
    );

    return null;
  },
});
