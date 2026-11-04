import { Schema } from "effect";

import { DeviceId, EpisodeId, MediaFileId, ProfileId, RoomId, TitleId, UserId } from "../ids";
import { EpochMillis, Milliseconds } from "../units";
import { Episode, TitleCard } from "./catalog";

/** Room playback state. Buffering freezes the shared position like a pause. */
export const RoomStatus = Schema.Literals(["playing", "paused", "buffering", "ended"]);

/** Room playback state. */
export type RoomStatus = typeof RoomStatus.Type;

/**
 * The committed shared timeline. Clients compute the live position with `targetPosition` from
 * `@media/contracts/clock` and apply clocks in `revision` order.
 */
export const RoomClock = Schema.Struct({
  status: RoomStatus,
  positionAtAnchorMs: Milliseconds,
  anchorServerTime: EpochMillis,
  playbackRate: Schema.Finite.check(Schema.isGreaterThan(0)),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

/** The committed shared timeline. */
export interface RoomClock extends Schema.Schema.Type<typeof RoomClock> {}

/**
 * What a member's device is doing: `watching` plays the room; `away` browses elsewhere in the app
 * and keeps its place, sending heartbeats without playing. Away members are not watching and
 * report no drift.
 */
export const RoomPresence = Schema.Literals(["watching", "away"]);

/** What a member's device is doing. */
export type RoomPresence = typeof RoomPresence.Type;

/** A room member: one profile on one device. */
export const RoomMember = Schema.Struct({
  userId: UserId,
  profileId: ProfileId,
  profileName: Schema.String,
  avatar: Schema.String,
  deviceId: DeviceId,
  role: Schema.Literals(["host", "guest"]),
  joinedAt: EpochMillis,
  lastSeenAt: EpochMillis,
  presence: RoomPresence,
  /**
   * A guest's last reported distance from the shared position, in milliseconds; positive means
   * ahead. Null for the host, and for a guest that is buffering, away, or has not reported yet.
   */
  driftMs: Schema.NullOr(Schema.Finite),
});

/** A room member. */
export interface RoomMember extends Schema.Schema.Type<typeof RoomMember> {}

/**
 * The room's next-episode countdown for what it plays now. `pending`: the host's player reached the
 * credits, and at `nextAt` by the server's clock the whole room moves on to `episode`, unless the
 * host plays it sooner or cancels. `cancelled`: the host chose to watch the credits, so this
 * episode ends without a countdown. Either goes away when the room's media changes.
 */
export const RoomNext = Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending"), episode: Episode, nextAt: EpochMillis }),
  Schema.Struct({ status: Schema.Literal("cancelled") }),
]);

/** The room's next-episode countdown. */
export type RoomNext = typeof RoomNext.Type;

/** A watch room as members and invited account holders see it. */
export const Room = Schema.Struct({
  id: RoomId,
  title: TitleCard,
  episode: Schema.NullOr(Episode),
  fileId: MediaFileId,
  hostUserId: UserId,
  hostProfileId: ProfileId,
  hostDeviceId: DeviceId,
  /** The host profile's name, also once the host has left the room. */
  hostProfileName: Schema.String,
  /**
   * The host stopped sending heartbeats; the server paused the room until the host's player
   * returns. A host browsing elsewhere in the app still sends them, so a live room is not marked
   * (its member is `away`), but a room already marked stays so until the host's player is back.
   */
  hostAway: Schema.Boolean,
  clock: RoomClock,
  /** The next-episode countdown for what the room plays now; null when there is none. */
  next: Schema.NullOr(RoomNext),
  members: Schema.Array(RoomMember),
  createdAt: EpochMillis,
});

/** A watch room. */
export interface Room extends Schema.Schema.Type<typeof Room> {}

/**
 * Host control arguments: the room, the host's device, the revision the host last saw, and its
 * position, with the file the host's player plays.
 */
export const HostControlArgs = Schema.Struct({
  roomId: RoomId,
  deviceId: DeviceId,
  revision: Schema.Int,
  positionMs: Milliseconds,
  /**
   * The file the host's player plays. A control from a player still on a file the room moved on
   * from fails with `stale_revision`, so it never moves the new media's clock; omit it to act on
   * whatever the room plays.
   */
  fileId: Schema.optionalKey(MediaFileId),
});

/** What a host playback control takes. */
export interface HostControlArgs extends Schema.Schema.Type<typeof HostControlArgs> {}

/** The server's clock reading, for estimating the offset between device and server clocks. */
export const ServerTime = Schema.Struct({ serverTime: EpochMillis });

/** The server's clock reading. */
export interface ServerTime extends Schema.Schema.Type<typeof ServerTime> {}

/** Arguments to start a room for a title the host is about to play or is playing. */
export const CreateRoomArgs = Schema.Struct({
  profileId: ProfileId,
  deviceId: DeviceId,
  titleId: TitleId,
  episodeId: Schema.optionalKey(EpisodeId),
  fileId: Schema.optionalKey(MediaFileId),
  positionMs: Milliseconds,
});

/** What creating a room takes. */
export interface CreateRoomArgs extends Schema.Schema.Type<typeof CreateRoomArgs> {}
