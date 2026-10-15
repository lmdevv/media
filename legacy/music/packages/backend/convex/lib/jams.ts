/**
 * Jams: a live listening session shared from its host's playback. The Jam *is* the host's session
 * and queue; people who join see and steer that playback (within the host's settings) instead of
 * their own, which stays as it was and comes back when they leave.
 *
 * Every playback command resolves a `Playback` first: whose session and queue it acts on (the
 * owner), who is acting, and the Jam around them, if any. The rules for what people in a Jam may
 * do live in `@music/commands/permissions` (`canControlJam`, `canEditJamEntry`, `jamAddsLeft`).
 */
import type { JamEndReason, JamJoinPolicy, JamSettings } from "@music/commands/models";
import { canControlJam, canEditJamEntry, jamAddsLeft } from "@music/commands/permissions";

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { randomToken } from "./crypto";
import { fail } from "./errors";
import type { QueueItem, StoredQueue } from "./queue";
import { viewerOf } from "./viewer";
import type { ReadCtx, Viewer } from "./viewer";

/** Characters in a Jam link code: about 100 bits, so a code cannot be guessed. */
export const JAM_CODE_LENGTH = 20;

/** A new, random link code. */
export const newJamCode = (): string => randomToken(JAM_CODE_LENGTH);

/** What a new Jam allows; see `JamSettings`. */
export const DEFAULT_JAM_SETTINGS: JamSettings = {
  join: "open",
  membersCanAdd: true,
  addLimit: 5,
  membersCanControl: false,
  membersCanEdit: "own",
  listenAlong: true,
};

/** A Jam ends after its host has been offline (no device heartbeat) this long. */
export const HOST_OFFLINE_MS = 30 * 60 * 1000;

/** A Jam ends after nothing has played for this long. */
export const IDLE_MS = 4 * 60 * 60 * 1000;

/**
 * How often a host's commands refresh `jams.hostActiveAt`: often enough for the 30-minute
 * offline rule, rarely enough that a host's heartbeats don't wake every member's subscription.
 */
const HOST_ACTIVITY_STEP_MS = 60 * 1000;

/** Guest accounts one Jam's link makes at most, while they last (they go when the Jam ends). */
export const MAX_GUESTS_PER_JAM = 25;

/** Guest accounts one Jam's link makes in an hour. */
export const GUESTS_PER_JAM_PER_HOUR = 10;

/** Guest accounts all Jam links on the server make together in an hour. */
export const GUESTS_PER_HOUR = 30;

/**
 * The code in what someone pasted: a bare code, or a Jam link whose last path segment is the code
 * (with or without a trailing slash, query, or fragment).
 */
export const jamCodeOf = (input: string): string => {
  const path = input.trim().split(/[?#]/u)[0] ?? "";
  const segments = path.split("/").filter((segment) => segment.length > 0);

  return segments.at(-1) ?? "";
};

/**
 * Whether the viewer signed up from a Jam link and is still a guest. Anyone with the link can
 * make such an account, so it gets less than an invited guest: no playlists shared with
 * everyone, and no Jam of its own, whose link would make more guests.
 */
export const isJamGuest = (viewer: Viewer): boolean =>
  viewer.user.joinedViaJam !== undefined && viewer.role === "guest";

/**
 * Whether the host removed or turned someone away under the Jam's current link. Anyone with the
 * link can make a guest account, so until the host makes a new link, nobody new comes in without
 * their OK.
 */
export const approvalAfterRemoval = (jam: Doc<"jams">): boolean =>
  jam.settings.join === "open" && jam.removedUnderCode === jam.code;

/** How the Jam lets people in now: its setting, or approval after a removal (see above). */
export const joinPolicy = (jam: Doc<"jams">): JamJoinPolicy =>
  approvalAfterRemoval(jam) ? "approval" : jam.settings.join;

/**
 * Whether a Jam may share a library's songs that autoplay chose rather than the host: ones the
 * host owns, or ones shared with everyone on the server. A library granted to the host alone
 * stays theirs; only their own choice of a song from it reaches the Jam.
 */
export const jamShareable = (library: Doc<"libraries">, hostId: Id<"users">): boolean =>
  library.ownerId === hostId || library.visibility === "shared";

/**
 * Whether a queue entry of the host's may reach the people in their Jam: anything a person chose,
 * and autoplay's picks from libraries the Jam may share (`jamShareable`). `track` is the entry's
 * song, `host` the host as a viewer (whose libraries include the song's).
 */
export const jamShareableEntry = (
  host: Viewer,
  item: Pick<QueueItem, "autoplay">,
  track: Pick<Doc<"tracks">, "libraryId">,
): boolean => {
  if (!item.autoplay) return true;
  const library = host.libraries.find((candidate) => candidate._id === track.libraryId);

  return library !== undefined && jamShareable(library, host.id);
};

/** The host as autoplay sees them while they host a Jam: only the libraries a Jam may share. */
export const jamAutoplayViewer = (host: Viewer): Viewer => {
  const libraries = host.libraries.filter((library) => jamShareable(library, host.id));

  return {
    ...host,
    libraries,
    libraryIds: new Set(libraries.map((library) => library._id)),
    readsEveryLibrary: false,
  };
};

/** The active Jam `userId` hosts, if any. A host has at most one. */
export const hostedJam = (ctx: ReadCtx, userId: Id<"users">): Promise<Doc<"jams"> | null> =>
  ctx.db
    .query("jams")
    .withIndex("by_host_status", (q) => q.eq("hostId", userId).eq("status", "active"))
    .first();

/**
 * Someone's current Jam membership: the one row `joined`, or else `pending`. Joining a Jam
 * leaves any other first, so a person has at most one of either; looking them up by status (not
 * by update time, which ties within one mutation) always finds the right one.
 */
export const currentMembership = async (
  ctx: ReadCtx,
  userId: Id<"users">,
): Promise<Doc<"jamMembers"> | null> => {
  const byStatus = (status: "joined" | "pending") =>
    ctx.db
      .query("jamMembers")
      .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", status))
      .first();

  return (await byStatus("joined")) ?? byStatus("pending");
};

/** The membership row of `userId` in a Jam, if they ever asked to join it. */
export const membershipIn = (
  ctx: ReadCtx,
  jamId: Id<"jams">,
  userId: Id<"users">,
): Promise<Doc<"jamMembers"> | null> =>
  ctx.db
    .query("jamMembers")
    .withIndex("by_jam_user", (q) => q.eq("jamId", jamId).eq("userId", userId))
    .unique();

/** The Jam someone is joined to and still active, with their membership; null otherwise. */
export const joinedJam = async (
  ctx: ReadCtx,
  userId: Id<"users">,
): Promise<{ readonly jam: Doc<"jams">; readonly member: Doc<"jamMembers"> } | null> => {
  const member = await currentMembership(ctx, userId);

  if (member === null || member.status !== "joined") return null;
  const jam = await ctx.db.get(member.jamId);

  return jam === null || jam.status !== "active" ? null : { jam, member };
};

/** The playback a command acts on, and who is acting. */
export type Playback =
  /** Your own playback, outside any Jam. */
  | { readonly kind: "own"; readonly owner: Viewer; readonly actor: Viewer }
  /** The Jam you host: your own playback, shared. */
  | {
      readonly kind: "host";
      readonly owner: Viewer;
      readonly actor: Viewer;
      readonly jam: Doc<"jams">;
    }
  /** Someone else's Jam you joined: their playback. */
  | {
      readonly kind: "member";
      readonly owner: Viewer;
      readonly actor: Viewer;
      readonly jam: Doc<"jams">;
      readonly member: Doc<"jamMembers">;
    };

/**
 * Whose playback `viewer` acts on: the host's while they are joined to an active Jam, otherwise
 * their own. Costs two index lookups that find nothing for someone outside any Jam.
 */
export const resolvePlayback = async (ctx: ReadCtx, viewer: Viewer): Promise<Playback> => {
  const [joined, hosted] = await Promise.all([
    joinedJam(ctx, viewer.id),
    hostedJam(ctx, viewer.id),
  ]);

  if (hosted !== null) return { kind: "host", owner: viewer, actor: viewer, jam: hosted };

  if (joined === null) return { kind: "own", owner: viewer, actor: viewer };
  const host = await ctx.db.get(joined.jam.hostId);

  // A host whose account is gone takes the Jam with them; the cron ends it.
  if (host === null) return { kind: "own", owner: viewer, actor: viewer };

  return {
    kind: "member",
    owner: await viewerOf(ctx, host),
    actor: viewer,
    jam: joined.jam,
    member: joined.member,
  };
};

/** Fails unless the actor may play, pause, skip, and seek this playback. */
export const requireControl = (playback: Playback): void => {
  if (playback.kind === "member" && !canControlJam(playback.jam.settings, false)) {
    fail("forbidden", "The host controls playback in this Jam");
  }
};

/** Fails when a person in someone else's Jam tries something only the host may do. */
export const requireHost = (playback: Playback, message: string): void => {
  if (playback.kind === "member") fail("forbidden", message);
};

/**
 * Fails unless the actor may add `count` songs to this queue: in someone else's Jam, only while
 * the host allows adding, and up to the host's limit of upcoming songs per person.
 */
export const requireAdds = (playback: Playback, queue: StoredQueue, count: number): void => {
  if (playback.kind !== "member") return;
  const actor = playback.actor.id;

  const upcoming = queue.items.filter(
    (item, position) => position > queue.index && !item.autoplay && item.addedBy === actor,
  ).length;

  const settings = playback.jam.settings;
  const left = jamAddsLeft(settings, false, upcoming);

  if (left === null || count <= left) return;

  if (!settings.membersCanAdd) fail("forbidden", "The host turned off adding songs in this Jam");

  fail(
    "conflict",
    left === 0
      ? `You have ${upcoming} songs coming up; add more once one has played`
      : `You can add ${left} more ${left === 1 ? "song" : "songs"} for now`,
  );
};

/** Fails unless the actor may reorder or remove `item` of this queue. */
export const requireEdit = (playback: Playback, item: QueueItem | undefined): void => {
  if (playback.kind !== "member") return;
  const settings = playback.jam.settings;

  if (canEditJamEntry(settings, false, item?.addedBy === playback.actor.id)) return;

  fail(
    "forbidden",
    settings.membersCanEdit === "none"
      ? "Only the host reorders or removes songs in this Jam"
      : "In this Jam you can only move or remove songs you added",
  );
};

/**
 * Ends a Jam. Its people keep their `joined` rows, so they see "The Jam ended" until they leave
 * it; their own playback is back at once, since a Jam never changed it. The guest accounts its
 * link made go, in batches (`people.removeJamGuests`), unless an admin has promoted them.
 */
export const endJam = async (
  ctx: MutationCtx,
  jam: Doc<"jams">,
  reason: JamEndReason,
): Promise<void> => {
  if (jam.status !== "active") return;
  await ctx.db.patch(jam._id, { status: "ended", endedReason: reason, endedAt: Date.now() });
  await ctx.scheduler.runAfter(0, internal.people.removeJamGuests, { jamId: jam._id });
};

/**
 * Why an active Jam should end at `now`, or null while it should go on: its host is gone, they
 * have shown no sign of life (a device heartbeat or a playback change, at `hostLastSeenAt`) for
 * `HOST_OFFLINE_MS` since the Jam started, or nothing has played for `IDLE_MS`. Pure, so the rule
 * can be checked on its own.
 */
export const expiryReason = (
  host: Doc<"users"> | null,
  hostLastSeenAt: number,
  session: Pick<Doc<"playbackSessions">, "playing" | "updatedAt"> | null,
  startedAt: number,
  now: number,
): JamEndReason | null => {
  if (host === null || host.suspendedAt !== undefined) return "host";

  if (now - Math.max(hostLastSeenAt, startedAt) > HOST_OFFLINE_MS) return "host_offline";

  const lastPlayed = session === null ? startedAt : session.playing ? now : session.updatedAt;

  return now - Math.max(lastPlayed, startedAt) > IDLE_MS ? "idle" : null;
};

/**
 * Notes that `userId` ran a command, for the Jam they host if any: a host on the CLI sends no
 * heartbeats, but their commands show they are there. Called by the dispatcher on every mutation.
 */
export const noteHostActivity = async (ctx: MutationCtx, userId: Id<"users">): Promise<void> => {
  const jam = await hostedJam(ctx, userId);
  const now = Date.now();

  if (jam === null || now - (jam.hostActiveAt ?? 0) < HOST_ACTIVITY_STEP_MS) return;
  await ctx.db.patch(jam._id, { hostActiveAt: now });
};

/** Starts someone listening along to their Jam on one of their devices. */
export const listenAlong = async (
  ctx: MutationCtx,
  jam: Doc<"jams">,
  member: Doc<"jamMembers">,
  deviceId: string,
): Promise<void> => {
  if (!jam.settings.listenAlong) {
    return fail("forbidden", "The host turned off listening along in this Jam");
  }

  await ctx.db.patch(member._id, { listening: true, deviceId, updatedAt: Date.now() });
};
