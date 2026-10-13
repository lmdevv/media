import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { DEVICE_LISTED_MS, DEVICE_LIST_LIMIT, listedDevices } from "../lib/devices";
import { fail } from "../lib/errors";
import { tableId } from "../lib/ids";
import { MAX_QUEUE, ensureSession, findSession, livePosition, shuffled } from "../lib/playback";
import { DEVICE_ONLINE_MS, makePresenter, presentDevice } from "../lib/present";
import { canRead } from "../lib/viewer";
import type { Viewer } from "../lib/viewer";
import type { MutationHandlers, QueryHandlers } from "./types";
import { ok } from "./types";

const RESTART_THRESHOLD_MS = 3000;

const findDevice = (ctx: MutationCtx, userId: Id<"users">, deviceId: string) =>
  ctx.db
    .query("devices")
    .withIndex("by_user_device", (q) => q.eq("userId", userId).eq("deviceId", deviceId))
    .unique();

/** Parses track IDs the viewer may play, keeping their order. */
const playableTracks = async (
  ctx: MutationCtx,
  viewer: Viewer,
  ids: ReadonlyArray<string>,
): Promise<Array<Id<"tracks">>> => {
  const tracks = await Promise.all(ids.map((id) => ctx.db.get(tableId(ctx, "tracks", id))));

  return tracks.map((track, index) =>
    track === null || !canRead(viewer, track.libraryId)
      ? fail("not_found", `Track ${ids[index] ?? ""} not found`)
      : track._id,
  );
};

/** Picks the device that should play when the caller did not name one. */
const defaultDevice = async (
  ctx: MutationCtx,
  viewer: Viewer,
  session: Doc<"playbackSessions">,
): Promise<string | undefined> => {
  const devices = await ctx.db
    .query("devices")
    .withIndex("by_user_device", (q) => q.eq("userId", viewer.id))
    .collect();

  const now = Date.now();
  const online = devices.filter((device) => now - device.lastSeenAt < DEVICE_ONLINE_MS);

  // Keep the active device while it is online; otherwise hand playback to the player that was
  // seen most recently, so a closed tab does not keep "playing" with nobody listening.
  if (online.some((device) => device.deviceId === session.activeDeviceId)) {
    return session.activeDeviceId;
  }

  const players = online
    .filter((device) => device.kind !== "cli")
    .toSorted((left, right) => right.lastSeenAt - left.lastSeenAt);

  return players[0]?.deviceId ?? session.activeDeviceId;
};

export const playbackQueries = {
  "playback.state": async (ctx, viewer) => {
    const session = await findSession(ctx, viewer.id);

    if (session === null) {
      return {
        activeDevice: null,
        queue: [],
        index: 0,
        positionMs: 0,
        playing: false,
        updatedAt: 0,
        shuffle: false,
        repeat: "off",
        volume: 1,
      } as const;
    }

    const present = makePresenter(ctx, viewer);
    const loaded = await Promise.all(session.queue.map((id) => ctx.db.get(id)));

    const visible = loaded.map((track) => track !== null && canRead(viewer, track.libraryId));

    const docs = loaded.filter(
      (track): track is Doc<"tracks"> => track !== null && canRead(viewer, track.libraryId),
    );

    const index = visible.slice(0, session.index).filter(Boolean).length;

    const device =
      session.activeDeviceId === undefined
        ? null
        : await ctx.db
            .query("devices")
            .withIndex("by_user_device", (q) =>
              q.eq("userId", viewer.id).eq("deviceId", session.activeDeviceId ?? ""),
            )
            .unique();

    return {
      activeDevice: device === null ? null : presentDevice(device, Date.now()),
      queue: await present.tracks(docs),
      index: Math.min(index, Math.max(0, docs.length - 1)),
      positionMs: session.positionMs,
      playing: session.playing,
      updatedAt: session.updatedAt,
      shuffle: session.shuffle,
      repeat: session.repeat,
      volume: session.volume,
    };
  },

  "devices.list": async (ctx, viewer, args) => {
    const session = await findSession(ctx, viewer.id);
    const now = Date.now();

    // Long-silent devices drop out, but never the one playing the session or the one asking: a
    // browser waking after a day lists itself before its first heartbeat lands.
    const keep = new Set(
      [session?.activeDeviceId, args.deviceId].filter((id): id is string => id !== undefined),
    );

    // Only the listed range is read, so a long device history costs the list nothing; the kept
    // devices are looked up on their own.
    const recent = await ctx.db
      .query("devices")
      .withIndex("by_user_last_seen", (q) =>
        q.eq("userId", viewer.id).gt("lastSeenAt", now - DEVICE_LISTED_MS),
      )
      .order("desc")
      .take(DEVICE_LIST_LIMIT);

    const kept = await Promise.all(
      [...keep].map((deviceId) =>
        ctx.db
          .query("devices")
          .withIndex("by_user_device", (q) => q.eq("userId", viewer.id).eq("deviceId", deviceId))
          .unique(),
      ),
    );

    const devices = new Map(
      [...recent, ...kept.filter((device) => device !== null)].map((device) => [
        device.deviceId,
        device,
      ]),
    );

    return listedDevices([...devices.values()], now, keep)
      .toSorted((left, right) => right.lastSeenAt - left.lastSeenAt)
      .map((device) => presentDevice(device, now));
  },
} satisfies Partial<QueryHandlers>;

export const playbackMutations = {
  "playback.play": async (ctx, viewer, args) => {
    const session = await ensureSession(ctx, viewer.id);
    let queue = await playableTracks(ctx, viewer, args.trackIds);
    let index = Math.min(args.index ?? 0, queue.length - 1);

    if (queue.length > MAX_QUEUE) {
      queue = queue.slice(index, index + MAX_QUEUE);
      index = 0;
    }

    let unshuffled: Array<Id<"tracks">> | undefined;

    if (session.shuffle) {
      const current = queue[index];
      unshuffled = queue;
      const rest = shuffled(queue.filter((_, position) => position !== index));
      queue = current === undefined ? rest : [current, ...rest];
      index = 0;
    }

    const activeDeviceId = args.deviceId ?? (await defaultDevice(ctx, viewer, session));
    await ctx.db.patch(session._id, {
      queue,
      unshuffled,
      index,
      positionMs: 0,
      playing: true,
      updatedAt: Date.now(),
      activeDeviceId,
    });

    return ok;
  },

  "playback.pause": async (ctx, viewer) => {
    const session = await ensureSession(ctx, viewer.id);
    const now = Date.now();
    await ctx.db.patch(session._id, {
      positionMs: livePosition(session, now),
      playing: false,
      updatedAt: now,
    });

    return ok;
  },

  "playback.resume": async (ctx, viewer) => {
    const session = await ensureSession(ctx, viewer.id);

    if (session.queue.length === 0) return fail("conflict", "The queue is empty");
    const activeDeviceId = await defaultDevice(ctx, viewer, session);
    await ctx.db.patch(session._id, { playing: true, updatedAt: Date.now(), activeDeviceId });

    return ok;
  },

  "playback.next": async (ctx, viewer) => {
    const session = await ensureSession(ctx, viewer.id);
    const now = Date.now();
    const last = session.queue.length - 1;

    if (session.index < last) {
      await ctx.db.patch(session._id, { index: session.index + 1, positionMs: 0, updatedAt: now });
    } else if (session.repeat === "all" && session.queue.length > 0) {
      await ctx.db.patch(session._id, { index: 0, positionMs: 0, updatedAt: now });
    } else {
      await ctx.db.patch(session._id, { positionMs: 0, playing: false, updatedAt: now });
    }

    return ok;
  },

  "playback.previous": async (ctx, viewer) => {
    const session = await ensureSession(ctx, viewer.id);
    const now = Date.now();

    if (livePosition(session, now) > RESTART_THRESHOLD_MS || session.index === 0) {
      const index =
        session.index === 0 && session.repeat === "all" && livePosition(session, now) <= 3000
          ? Math.max(0, session.queue.length - 1)
          : session.index;

      await ctx.db.patch(session._id, { index, positionMs: 0, updatedAt: now });
    } else {
      await ctx.db.patch(session._id, { index: session.index - 1, positionMs: 0, updatedAt: now });
    }

    return ok;
  },

  "playback.seek": async (ctx, viewer, args) => {
    const session = await ensureSession(ctx, viewer.id);
    await ctx.db.patch(session._id, { positionMs: args.positionMs, updatedAt: Date.now() });

    return ok;
  },

  "playback.jump": async (ctx, viewer, args) => {
    const session = await ensureSession(ctx, viewer.id);

    if (args.index >= session.queue.length) return fail("invalid_args", "No song at that index");
    const activeDeviceId = await defaultDevice(ctx, viewer, session);
    await ctx.db.patch(session._id, {
      index: args.index,
      positionMs: 0,
      playing: true,
      updatedAt: Date.now(),
      activeDeviceId,
    });

    return ok;
  },

  "playback.shuffle": async (ctx, viewer, args) => {
    const session = await ensureSession(ctx, viewer.id);

    if (args.on === session.shuffle) return ok;
    const current = session.queue[session.index];

    if (args.on) {
      const rest = shuffled(session.queue.filter((_, position) => position !== session.index));
      await ctx.db.patch(session._id, {
        shuffle: true,
        unshuffled: session.queue,
        queue: current === undefined ? rest : [current, ...rest],
        index: 0,
      });
    } else {
      const original = session.unshuffled ?? session.queue;
      const index = current === undefined ? 0 : Math.max(0, original.indexOf(current));
      await ctx.db.patch(session._id, {
        shuffle: false,
        unshuffled: undefined,
        queue: original,
        index,
      });
    }

    return ok;
  },

  "playback.repeat": async (ctx, viewer, args) => {
    const session = await ensureSession(ctx, viewer.id);
    await ctx.db.patch(session._id, { repeat: args.mode });

    return ok;
  },

  "playback.volume": async (ctx, viewer, args) => {
    const session = await ensureSession(ctx, viewer.id);
    await ctx.db.patch(session._id, { volume: args.volume });

    return ok;
  },

  "playback.transfer": async (ctx, viewer, args) => {
    const device = await findDevice(ctx, viewer.id, args.deviceId);

    if (device === null) return fail("not_found", "That device is not registered");
    const session = await ensureSession(ctx, viewer.id);
    const now = Date.now();
    await ctx.db.patch(session._id, {
      activeDeviceId: device.deviceId,
      positionMs: livePosition(session, now),
      updatedAt: now,
    });

    return ok;
  },

  "playback.report": async (ctx, viewer, args) => {
    const session = await ensureSession(ctx, viewer.id);

    if (session.activeDeviceId !== args.deviceId) return ok;
    const trackId = session.queue[args.index];

    if (trackId === undefined) return ok;
    await ctx.db.patch(session._id, {
      index: args.index,
      positionMs: args.positionMs,
      playing: args.playing,
      updatedAt: Date.now(),
    });

    if (args.playing && session.reportedTrackId !== trackId) {
      const track = await ctx.db.get(trackId);

      if (track !== null) {
        await ctx.db.insert("history", {
          userId: viewer.id,
          trackId,
          albumId: track.albumId,
          deviceId: args.deviceId,
        });
      }

      await ctx.db.patch(session._id, { reportedTrackId: trackId });
    }

    return ok;
  },

  "queue.add": async (ctx, viewer, args) => {
    const session = await ensureSession(ctx, viewer.id);
    const added = await playableTracks(ctx, viewer, args.trackIds);

    if (session.queue.length === 0) {
      await ctx.db.patch(session._id, {
        queue: added.slice(0, MAX_QUEUE),
        index: 0,
        positionMs: 0,
        playing: false,
        updatedAt: Date.now(),
      });

      return ok;
    }

    const insertAt = args.next === true ? session.index + 1 : session.queue.length;

    const queue = [
      ...session.queue.slice(0, insertAt),
      ...added,
      ...session.queue.slice(insertAt),
    ].slice(0, MAX_QUEUE);

    await ctx.db.patch(session._id, { queue, unshuffled: undefined });

    return ok;
  },

  "queue.remove": async (ctx, viewer, args) => {
    const session = await ensureSession(ctx, viewer.id);

    if (args.index >= session.queue.length) return fail("invalid_args", "No song at that index");
    const queue = session.queue.filter((_, position) => position !== args.index);

    if (args.index < session.index) {
      await ctx.db.patch(session._id, { queue, index: session.index - 1 });
    } else if (args.index === session.index) {
      await ctx.db.patch(session._id, {
        queue,
        index: Math.min(session.index, Math.max(0, queue.length - 1)),
        positionMs: 0,
        playing: session.playing && queue.length > 0,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.patch(session._id, { queue });
    }

    return ok;
  },

  "queue.clear": async (ctx, viewer) => {
    const session = await ensureSession(ctx, viewer.id);
    await ctx.db.patch(session._id, {
      queue: session.queue.slice(0, session.index + 1),
      unshuffled: undefined,
    });

    return ok;
  },

  "devices.heartbeat": async (ctx, viewer, args) => {
    const existing = await findDevice(ctx, viewer.id, args.deviceId);
    const now = Date.now();

    if (existing === null) {
      await ctx.db.insert("devices", {
        userId: viewer.id,
        deviceId: args.deviceId,
        name: args.name,
        kind: args.kind,
        lastSeenAt: now,
      });
    } else {
      await ctx.db.patch(existing._id, { name: args.name, kind: args.kind, lastSeenAt: now });
    }

    return ok;
  },
} satisfies Partial<MutationHandlers>;
