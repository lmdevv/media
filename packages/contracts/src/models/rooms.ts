import { Schema } from "effect";

import { DeviceId, MediaFileId, ProfileId, RoomId, UserId } from "../ids";
import { EpochMillis, Milliseconds } from "../units";
import { Episode, TitleCard } from "./catalog";

/** Room playback state. Buffering freezes the shared position like a pause. */
const RoomStatus = Schema.Literals(["playing", "paused", "buffering", "ended"]);

/** Room playback state. */
type RoomStatus = typeof RoomStatus.Type;

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
const RoomPresence = Schema.Literals(["watching", "away"]);

/** What a member's device is doing. */
type RoomPresence = typeof RoomPresence.Type;

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
const RoomNext = Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending"), episode: Episode, nextAt: EpochMillis }),
  Schema.Struct({ status: Schema.Literal("cancelled") }),
]);

/** The room's next-episode countdown. */
type RoomNext = typeof RoomNext.Type;

/** A watch room as members and invited account holders see it. */
const Room = Schema.Struct({
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
interface Room extends Schema.Schema.Type<typeof Room> {}
