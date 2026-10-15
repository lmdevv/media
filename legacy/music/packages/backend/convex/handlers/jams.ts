/**
 * Starting, joining, and running Jams, and the server setting that lets Jam links make guest
 * accounts. What a Jam does to playback lives in `lib/jams.ts` and the playback handlers.
 */
import type { Jam, JamMember, JamRole } from "@music/commands/models";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { fail } from "../lib/errors";
import { tableId } from "../lib/ids";
import {
  DEFAULT_JAM_SETTINGS,
  approvalAfterRemoval,
  endJam,
  hostedJam,
  jamCodeOf,
  joinPolicy,
  currentMembership,
  listenAlong,
  membershipIn,
  newJamCode,
} from "../lib/jams";
import { removeJamGuest } from "../lib/people";
import { refreshJamAutoplay } from "./playback";
import { contributorOf, makeContributors } from "../lib/present";
import { readServerSettings } from "../lib/serverSettings";
import type { ReadCtx, Viewer } from "../lib/viewer";
import type { MutationHandlers, QueryHandlers } from "./types";
import { ok } from "./types";

/** People one Jam lists at most. */
const MAX_MEMBERS = 200;

const GONE = "This Jam link doesn't work any more. Ask for a new one.";

/** The people in a Jam the viewer may see: joined, and for the host also those waiting. */
const membersOf = async (
  ctx: ReadCtx,
  jam: Doc<"jams">,
  role: JamRole,
): Promise<Array<(typeof JamMember)["Encoded"]>> => {
  const [joined, pending] = await Promise.all([
    ctx.db
      .query("jamMembers")
      .withIndex("by_jam", (q) => q.eq("jamId", jam._id).eq("status", "joined"))
      .take(MAX_MEMBERS),
    role === "host"
      ? ctx.db
          .query("jamMembers")
          .withIndex("by_jam", (q) => q.eq("jamId", jam._id).eq("status", "pending"))
          .take(MAX_MEMBERS)
      : [],
  ]);

  const contributor = makeContributors(ctx);
  const rows = [...joined, ...pending];
  const people = await Promise.all(rows.map((row) => contributor(row.userId)));

  return rows.flatMap((row, index) => {
    const person = people[index];

    return person === undefined || person === null
      ? []
      : [{ person, status: row.status, listening: row.listening, since: row.updatedAt }];
  });
};

/** A Jam as `viewer` sees it in their `role`. */
const presentJam = async (
  ctx: ReadCtx,
  jam: Doc<"jams">,
  role: JamRole,
  listening: boolean,
): Promise<(typeof Jam)["Encoded"]> => {
  const host = await ctx.db.get(jam.hostId);

  return {
    id: jam._id,
    code: role === "pending" ? "" : jam.code,
    host: host === null ? { id: jam.hostId, name: "Someone who left" } : contributorOf(host),
    status: jam.status,
    endedReason: jam.endedReason ?? null,
    settings: jam.settings,
    // The host's panel explains their settings with it. Others can tell the Jam asks anyway
    // (the link's page says Ask to join); they aren't told why.
    approvalAfterRemoval: role === "host" && approvalAfterRemoval(jam),
    role,
    listening,
    members: jam.status === "active" ? await membersOf(ctx, jam, role) : [],
    createdAt: jam._creationTime,
  };
};

/**
 * The Jam the viewer hosts, is in, or waits to join, or the one that ended under them until they
 * leave it; null otherwise.
 */
const currentJam = async (
  ctx: ReadCtx,
  viewer: Viewer,
): Promise<{
  readonly jam: Doc<"jams">;
  readonly role: JamRole;
  readonly listening: boolean;
} | null> => {
  const hosted = await hostedJam(ctx, viewer.id);

  if (hosted !== null) return { jam: hosted, role: "host", listening: false };
  const member = await currentMembership(ctx, viewer.id);

  if (member === null || (member.status !== "joined" && member.status !== "pending")) return null;
  const jam = await ctx.db.get(member.jamId);

  if (jam === null) return null;

  return {
    jam,
    role: member.status === "joined" ? "member" : "pending",
    listening: member.listening && jam.settings.listenAlong,
  };
};

/** The active Jam the viewer hosts, or a `forbidden` failure for anyone else. */
const ownJam = async (ctx: ReadCtx, viewer: Viewer): Promise<Doc<"jams">> =>
  (await hostedJam(ctx, viewer.id)) ?? fail("forbidden", "Only the host of a Jam can do that");

/** Leaves whatever Jam the viewer is in or waiting for, other than `except`. */
const leaveOtherJams = async (
  ctx: MutationCtx,
  viewer: Viewer,
  except: Id<"jams"> | null,
): Promise<void> => {
  const member = await currentMembership(ctx, viewer.id);

  if (
    member !== null &&
    member.jamId !== except &&
    (member.status === "joined" || member.status === "pending")
  ) {
    await ctx.db.patch(member._id, { status: "left", listening: false, updatedAt: Date.now() });
  }
};

/** Someone's membership in the host's Jam, for the host's approve and remove. */
const membershipOf = async (
  ctx: MutationCtx,
  jam: Doc<"jams">,
  userId: string,
): Promise<Doc<"jamMembers">> =>
  (await membershipIn(ctx, jam._id, tableId(ctx, "users", userId))) ??
  fail("not_found", "They aren't in this Jam");

export const jamQueries = {
  "jam.get": async (ctx, viewer) => {
    const current = await currentJam(ctx, viewer);

    return current === null ? null : presentJam(ctx, current.jam, current.role, current.listening);
  },

  "jam.members": async (ctx, viewer) => {
    const current = await currentJam(ctx, viewer);

    return current === null || current.jam.status !== "active"
      ? []
      : membersOf(ctx, current.jam, current.role);
  },

  "server.settings": async (ctx) => readServerSettings(ctx),
} satisfies Partial<QueryHandlers>;

export const jamMutations = {
  "jam.start": async (ctx, viewer) => {
    // A Jam link can make guest accounts, so only members and admins hand one out.
    if (viewer.role === "guest") return fail("forbidden", "Guests can't start a Jam");

    const hosted = await hostedJam(ctx, viewer.id);

    if (hosted !== null) return { jamId: hosted._id, code: hosted.code };
    // A person is in at most one Jam, so hosting leaves any other.
    await leaveOtherJams(ctx, viewer, null);
    const code = newJamCode();

    const jamId = await ctx.db.insert("jams", {
      hostId: viewer.id,
      code,
      status: "active",
      settings: DEFAULT_JAM_SETTINGS,
    });

    // Autoplay's songs so far may come from libraries granted to the host alone.
    await refreshJamAutoplay(ctx, viewer);

    return { jamId, code };
  },

  "jam.join": async (ctx, viewer, args) => {
    const code = jamCodeOf(args.code);

    const jam =
      code.length === 0
        ? null
        : await ctx.db
            .query("jams")
            .withIndex("by_code", (q) => q.eq("code", code))
            .unique();

    if (jam === null || jam.status !== "active") return fail("not_found", GONE);

    if (jam.hostId === viewer.id) return fail("conflict", "You're hosting this Jam");

    if ((await hostedJam(ctx, viewer.id)) !== null) {
      return fail("conflict", "End the Jam you're hosting before joining another");
    }

    const existing = await membershipIn(ctx, jam._id, viewer.id);

    if (existing?.status === "removed" && existing.blockedCode === jam.code) {
      return fail("forbidden", "The host removed you from this Jam");
    }

    if (existing?.status === "joined" || existing?.status === "pending") {
      if (existing.status === "joined" && args.deviceId !== undefined && jam.settings.listenAlong) {
        await listenAlong(ctx, jam, existing, args.deviceId);
      }

      // A guest's sign-up put them in the queue without a device; once let in, they listen here.
      if (existing.status === "pending" && args.deviceId !== undefined) {
        await ctx.db.patch(existing._id, { deviceId: args.deviceId });
      }

      return { jamId: jam._id, status: existing.status };
    }

    const policy = joinPolicy(jam);

    if (policy === "locked") {
      return fail("forbidden", "This Jam isn't letting anyone new in");
    }

    await leaveOtherJams(ctx, viewer, jam._id);
    const status = policy === "approval" ? "pending" : "joined";

    const listening =
      status === "joined" && jam.settings.listenAlong && args.deviceId !== undefined;

    const fields = {
      status,
      listening,
      deviceId: args.deviceId,
      updatedAt: Date.now(),
      blockedCode: undefined,
    } as const;

    if (existing === null) {
      await ctx.db.insert("jamMembers", { jamId: jam._id, userId: viewer.id, ...fields });
    } else {
      await ctx.db.patch(existing._id, fields);
    }

    return { jamId: jam._id, status };
  },

  "jam.leave": async (ctx, viewer) => {
    if ((await hostedJam(ctx, viewer.id)) !== null) {
      return fail("conflict", "You're hosting this Jam; end it instead");
    }

    await leaveOtherJams(ctx, viewer, null);

    return ok;
  },

  "jam.listen": async (ctx, viewer, args) => {
    const member = await currentMembership(ctx, viewer.id);
    const jam = member === null ? null : await ctx.db.get(member.jamId);

    if (member?.status !== "joined" || jam === null || jam.status !== "active") {
      return fail("conflict", "You aren't in someone else's Jam");
    }

    if (!args.on) {
      await ctx.db.patch(member._id, { listening: false, updatedAt: Date.now() });

      return ok;
    }

    const deviceId = args.deviceId ?? member.deviceId;

    if (deviceId === undefined) return fail("invalid_args", "Name the device to listen on");

    const device = await ctx.db
      .query("devices")
      .withIndex("by_user_device", (q) => q.eq("userId", viewer.id).eq("deviceId", deviceId))
      .unique();

    if (device === null) return fail("not_found", "That device is not registered");
    await listenAlong(ctx, jam, member, deviceId);

    return ok;
  },

  "jam.end": async (ctx, viewer) => {
    await endJam(ctx, await ownJam(ctx, viewer), "host");

    return ok;
  },

  "jam.settings": async (ctx, viewer, args) => {
    const jam = await ownJam(ctx, viewer);
    const { addLimit, ...rest } = args;

    await ctx.db.patch(jam._id, {
      settings: {
        ...jam.settings,
        ...rest,
        addLimit: addLimit === undefined ? jam.settings.addLimit : addLimit === 0 ? null : addLimit,
      },
    });

    return ok;
  },

  "jam.approve": async (ctx, viewer, args) => {
    const jam = await ownJam(ctx, viewer);
    const member = await membershipOf(ctx, jam, args.userId);

    if (member.status !== "pending") return fail("conflict", "They aren't waiting to join");

    // Turned away like someone removed: this link won't ask again; a new link can. Let in,
    // they listen along on the device they asked from, as they would joining an open Jam.
    await ctx.db.patch(member._id, {
      status: args.approve ? "joined" : "removed",
      listening: args.approve && jam.settings.listenAlong && member.deviceId !== undefined,
      blockedCode: args.approve ? undefined : jam.code,
      updatedAt: Date.now(),
    });

    // A guest account this Jam's link made has nothing else to do; a new one would need the
    // host's approval again.
    if (!args.approve) {
      await ctx.db.patch(jam._id, { removedUnderCode: jam.code });
      await removeJamGuest(ctx, jam, member.userId);
    }

    return ok;
  },

  "jam.remove": async (ctx, viewer, args) => {
    const jam = await ownJam(ctx, viewer);
    const member = await membershipOf(ctx, jam, args.userId);

    // Someone who left can be removed too: the link stops letting them back, and a guest
    // account it made goes.
    if (member.status === "removed") return fail("conflict", "They aren't in this Jam");

    await ctx.db.patch(member._id, {
      status: "removed",
      listening: false,
      blockedCode: jam.code,
      updatedAt: Date.now(),
    });

    // A guest account this Jam's link made goes with them, and until a new link everyone new
    // needs the host's OK, so they can't come straight back as a new guest either.
    await ctx.db.patch(jam._id, { removedUnderCode: jam.code });
    await removeJamGuest(ctx, jam, member.userId);

    return ok;
  },

  "jam.relink": async (ctx, viewer) => {
    const jam = await ownJam(ctx, viewer);
    const code = newJamCode();

    await ctx.db.patch(jam._id, { code });

    return { code };
  },

  "server.update": async (ctx, _viewer, args) => {
    const row = await ctx.db.query("serverSettings").first();
    const current = await readServerSettings(ctx);
    const next = { jamGuestAccounts: args.jamGuestAccounts ?? current.jamGuestAccounts };

    if (row === null) await ctx.db.insert("serverSettings", next);
    else await ctx.db.patch(row._id, next);

    return ok;
  },
} satisfies Partial<MutationHandlers>;
