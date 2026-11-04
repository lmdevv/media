import type { PaginationOptions, PaginationResult } from "convex/server";
import { v } from "convex/values";

import { register } from "../../../commands/core/devices/registry";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { internalMutation } from "../../_generated/server";
import type { DatabaseReader, MutationCtx } from "../../_generated/server";
import { refuseKeys, requireCaller } from "../auth/caller";
import type { Caller } from "../auth/caller";
import { fail } from "../lib/errors";
import { paginate } from "../lib/paginate";
import { takeAttempt } from "../lib/rateLimit";
import {
  constantTimeEqual,
  formatSecret,
  parseSecret,
  randomSecret,
  sha256Hex,
} from "../lib/secrets";
import { requireServer } from "../permissions/authorize";
import type { PersonDoc } from "../permissions/policy";
import { endSession, liveSession } from "../sessions";
import { DEVICE_PREFIX, NO_DEVICE } from "./facts";

const NAME_MAX = 64;

/** Most people signed in on one personal device at once. */
const PEOPLE_PER_DEVICE_MAX = 16;

/** The sessions bound to one device that a read takes; `purge` deletes the ended ones. */
const DEVICE_SESSIONS_READ = 200;

const ENROLLS_PER_HOUR = 20;

const PURGE_BATCH = 100;

const parseName = (name: string): string => {
  const trimmed = name.trim();

  return trimmed.length === 0 || trimmed.length > NAME_MAX
    ? fail("invalid_args", `Name the device with 1 to ${NAME_MAX} characters`)
    : trimmed;
};

interface SignedInHere {
  readonly sessionId: Id<"authSessions">;
  readonly person: PersonDoc;
}

/** The live sessions on a personal device and the people they sign in. */
export const signedInOn = async (
  db: DatabaseReader,
  deviceId: Id<"devices">,
  now: number,
): Promise<ReadonlyArray<SignedInHere>> => {
  const sessions = await db
    .query("authSessions")
    .withIndex("by_device_user", (q) => q.eq("device.id", deviceId))
    .take(DEVICE_SESSIONS_READ);

  const live = await Promise.all(sessions.map((session) => liveSession(db, session._id, now)));

  return live.flatMap((found) =>
    found?.user.kind === "person" ? [{ sessionId: found.session._id, person: found.user }] : [],
  );
};

/**
 * Binds the caller's session to a personal device, and ends the caller's other sessions there, so
 * each person has one session per device.
 */
const bind = async (
  ctx: Pick<MutationCtx, "db">,
  caller: Caller,
  device: Doc<"devices">,
): Promise<void> => {
  const here = await signedInOn(ctx.db, device._id, Date.now());

  const others = new Set(
    here.flatMap(({ person }) => (person._id === caller.userId ? [] : [person._id])),
  );

  if (others.size >= PEOPLE_PER_DEVICE_MAX) {
    fail("conflict", `${PEOPLE_PER_DEVICE_MAX} people are already signed in on this device`);
  }

  await Promise.all(
    here.flatMap(({ sessionId, person }) =>
      person._id === caller.userId && sessionId !== caller.sessionId
        ? [endSession(ctx, sessionId)]
        : [],
    ),
  );

  await ctx.db.patch(caller.sessionId, {
    device: { id: device._id, generation: device.generation },
  });
};

/** Binds the caller's session to the personal device a code names; null when it names none. */
export const attach = internalMutation({
  args: { deviceId: v.string(), secretHash: v.string(), name: v.string() },
  returns: v.union(v.id("devices"), v.null()),
  handler: async (ctx, { deviceId, secretHash, name }) => {
    const caller = refuseKeys(await requireCaller(ctx, "account"));
    const id = ctx.db.normalizeId("devices", deviceId);
    const device = id === null ? null : await ctx.db.get(id);

    if (device === null || !constantTimeEqual(device.secretHash, secretHash)) return null;

    if (device.mode === "shared") {
      return fail("conflict", "This device is shared; open a tile from its picker instead");
    }

    const named = parseName(name);

    if (named !== device.name) await ctx.db.patch(device._id, { name: named });

    await bind(ctx, caller, device);

    return device._id;
  },
});

/** Registers a new personal device and binds the caller's session to it. */
export const insert = internalMutation({
  args: { secretHash: v.string(), name: v.string() },
  returns: v.id("devices"),
  handler: async (ctx, { secretHash, name }) => {
    const caller = refuseKeys(await requireCaller(ctx, "account"));
    const limit = { identifier: `devices:${caller.userId}`, perHour: ENROLLS_PER_HOUR };

    if (!(await takeAttempt(ctx, limit, Date.now()))) {
      return fail("rate_limited", "Too many devices registered; try again in a few minutes");
    }

    const deviceId = await ctx.db.insert("devices", {
      name: parseName(name),
      secretHash,
      generation: 0,
      mode: "personal",
    });

    const device = (await ctx.db.get(deviceId)) ?? fail("not_found", NO_DEVICE);

    await bind(ctx, caller, device);

    return deviceId;
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

  await Promise.all(
    page.page.map(async (session) => {
      if ((await liveSession(ctx.db, session._id, now)) === null) await ctx.db.delete(session._id);
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

const purgeArgs = {
  deviceId: v.id("devices"),
  table: v.union(v.literal("authSessions"), v.literal("unlockStrikes")),
  cursor: v.union(v.string(), v.null()),
};

/**
 * Deletes what a device change left behind, a page at a time: the sessions bound to the device
 * that ended, then, when strikes are named, every unlock-code strike on it. Liveness already ended
 * those sessions, so this is cleanup.
 */
export const purge = internalMutation({
  args: purgeArgs,
  returns: v.null(),
  handler: async (ctx, { deviceId, table, cursor }) => {
    const options = { numItems: PURGE_BATCH, cursor };
    const now = Date.now();

    const page =
      table === "authSessions"
        ? await deleteEndedSessions(ctx, deviceId, options, now)
        : await deleteStrikes(ctx, deviceId, options);

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

/** A device keeps one live approval; a read takes a few to clear stragglers too. */
const DEVICE_APPROVALS_READ = 8;

/**
 * Clears what a device kept: its ended sessions, and when it was shared, its approval at once and
 * its unlock-code strikes in scheduled pages.
 */
const forget = async (
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

  const approvals = await ctx.db
    .query("tileApprovals")
    .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
    .take(DEVICE_APPROVALS_READ);

  await Promise.all(approvals.map((approval) => ctx.db.delete(approval._id)));

  await ctx.scheduler.runAfter(0, internal.core.devices.registry.purge, {
    deviceId,
    table: "unlockStrikes",
    cursor: null,
  });
};

export const { enroll, list, setMode, remove } = register({
  enroll: async (ctx, { name, device }) => {
    parseName(name);

    const stored = device?.trim();
    const parsed = stored === undefined ? null : parseSecret(DEVICE_PREFIX, stored);

    if (stored !== undefined && parsed !== null) {
      const found: Id<"devices"> | null = await ctx.runMutation(
        internal.core.devices.registry.attach,
        { deviceId: parsed.rowId, secretHash: await sha256Hex(parsed.secret), name },
      );

      if (found !== null) return { deviceId: found, device: stored };
    }

    const secret = randomSecret(32);

    const deviceId: Id<"devices"> = await ctx.runMutation(internal.core.devices.registry.insert, {
      secretHash: await sha256Hex(secret),
      name,
    });

    return { deviceId, device: formatSecret(DEVICE_PREFIX, deviceId, secret) };
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

    const fields = {
      name: device.name,
      secretHash: device.secretHash,
      generation: device.generation + 1,
    };

    await ctx.db.replace(
      device._id,
      mode === "shared" ? { ...fields, mode, tile: null } : { ...fields, mode },
    );

    await forget(ctx, device);

    return null;
  },
  remove: async (ctx, { deviceId }, caller) => {
    requireServer(caller, "manageDevices");

    const device = (await ctx.db.get(deviceId)) ?? fail("not_found", NO_DEVICE);

    await ctx.db.delete(deviceId);
    await forget(ctx, device);

    return null;
  },
});
