import { DOWNLOAD_PIN_LIMIT } from "@music/commands/models";
import type { DownloadTargetKind } from "@music/commands/models";

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  findPin,
  lyricsChanges,
  openTarget,
  parseTarget,
  presentPin,
  resolveManifest,
} from "../lib/downloads";
import { fail } from "../lib/errors";
import { tableId } from "../lib/ids";
import { makePresenter, presentDevice } from "../lib/present";
import { readServerSettings } from "../lib/serverSettings";
import type { ReadCtx } from "../lib/viewer";
import type { MutationHandlers, QueryHandlers } from "./types";
import { ok } from "./types";

/**
 * Most pins `downloads.list` reads across all of someone's devices. Asked for one device, it reads
 * that device's whole list, which `downloads.add` keeps to `DOWNLOAD_PIN_LIMIT`. A playlist pin
 * someone else owns costs four index reads, so more would near Convex's limit of 4,096 a query.
 */
const LISTED_PINS = DOWNLOAD_PIN_LIMIT;

const NOT_FOUND: Readonly<Record<DownloadTargetKind, string>> = {
  track: "Song not found",
  album: "Album not found",
  playlist: "Playlist not found",
};

const findDevice = (
  ctx: ReadCtx,
  userId: Id<"users">,
  deviceId: string,
): Promise<Doc<"devices"> | null> =>
  ctx.db
    .query("devices")
    .withIndex("by_user_device", (q) => q.eq("userId", userId).eq("deviceId", deviceId))
    .unique();

/** Every pin `userId` has on a device. */
const pinsOn = (
  ctx: ReadCtx,
  userId: Id<"users">,
  deviceId: string,
): Promise<Array<Doc<"downloadPins">>> =>
  ctx.db
    .query("downloadPins")
    .withIndex("by_user_device", (q) => q.eq("userId", userId).eq("deviceId", deviceId))
    .take(DOWNLOAD_PIN_LIMIT);

export const downloadQueries = {
  "downloads.list": async (ctx, viewer, args) => {
    const pins =
      args.deviceId === undefined
        ? await ctx.db
            .query("downloadPins")
            .withIndex("by_user_device", (q) => q.eq("userId", viewer.id))
            .take(LISTED_PINS)
        : await pinsOn(ctx, viewer.id, args.deviceId);

    // The device asked for is listed even when it keeps nothing, so a device can watch its list.
    const deviceIds = [
      ...new Set([
        ...(args.deviceId === undefined ? [] : [args.deviceId]),
        ...pins.map((pin) => pin.deviceId),
      ]),
    ];

    const present = makePresenter(ctx, viewer);
    const now = Date.now();

    const [devices, shown] = await Promise.all([
      Promise.all(deviceIds.map((deviceId) => findDevice(ctx, viewer.id, deviceId))),
      Promise.all(
        pins.map(async (pin) =>
          presentPin(ctx, present, pin, await openTarget(ctx, viewer, pin.target)),
        ),
      ),
    ]);

    return deviceIds
      .map((deviceId, index) => {
        const device = devices[index] ?? null;

        return {
          deviceId,
          device: device === null ? null : presentDevice(device, now),
          pins: shown
            .filter((pin) => pin.deviceId === deviceId)
            .toSorted((left, right) => right.createdAt - left.createdAt),
        };
      })
      .toSorted((left, right) => (right.device?.lastSeenAt ?? 0) - (left.device?.lastSeenAt ?? 0));
  },

  "downloads.manifest": async (ctx, viewer, args) => {
    const pin = await ctx.db.get(tableId(ctx, "downloadPins", args.pinId));

    if (pin === null || pin.userId !== viewer.id) return fail("not_found", "Download not found");

    return resolveManifest(ctx, viewer, pin);
  },

  "downloads.lyrics": (ctx, viewer, args) => lyricsChanges(ctx, viewer, args.held),
} satisfies Partial<QueryHandlers>;

export const downloadMutations = {
  "downloads.add": async (ctx, viewer, args) => {
    const target = parseTarget(ctx, args.kind, args.id);
    const held = await pinsOn(ctx, viewer.id, args.deviceId);

    // A device that keeps downloads stays the person's even once its row is pruned.
    if (held.length === 0 && (await findDevice(ctx, viewer.id, args.deviceId)) === null) {
      return fail("not_found", "That device isn't one of yours");
    }

    if ((await openTarget(ctx, viewer, target)) === null)
      return fail("not_found", NOT_FOUND[args.kind]);

    const existing = held.find(
      (pin) => pin.target.kind === target.kind && pin.target.id === target.id,
    );

    if (existing !== undefined) return { pinId: existing._id };

    if (held.length >= DOWNLOAD_PIN_LIMIT) {
      return fail(
        "conflict",
        `A device keeps up to ${DOWNLOAD_PIN_LIMIT} downloads; remove one first`,
      );
    }

    const pinId = await ctx.db.insert("downloadPins", {
      userId: viewer.id,
      deviceId: args.deviceId,
      target,
    });

    // Downloads often play with no connection, so their lyrics are looked up ahead of time.
    if ((await readServerSettings(ctx)).remoteLyrics) {
      await ctx.scheduler.runAfter(0, internal.lyricLookups.requestPinned, {
        target,
        cursor: null,
      });
    }

    return { pinId };
  },

  "downloads.remove": async (ctx, viewer, args) => {
    const pin = await findPin(ctx, viewer.id, args.deviceId, parseTarget(ctx, args.kind, args.id));

    if (pin !== null) await ctx.db.delete(pin._id);

    return ok;
  },
} satisfies Partial<MutationHandlers>;
