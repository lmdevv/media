import { hostReading, PLAYER_SILENCE_MS, targetPosition } from "@media/contracts/clock";
import type { FunctionPath } from "@media/contracts/command";
import { commands } from "@media/contracts/commands";
import type { CommandError } from "@media/contracts/errors";
import { Conflict, Forbidden, NotFound, StaleRevision } from "@media/contracts/errors";
import type { Room, RoomClock } from "@media/contracts/models/rooms";
import type { MediaFileId } from "@media/contracts/ids";
import { Room as RoomSchema, RoomClock as RoomClockSchema } from "@media/contracts/models/rooms";
import { EpochMillis, Milliseconds } from "@media/contracts/units";
import {
  Clock,
  Duration,
  Effect,
  Option,
  Ref,
  Schema,
  Stream,
  Struct,
  SubscriptionRef,
} from "effect";

import * as ConvexTransport from "../convex-transport";
import type { WireArgs } from "../convex-transport";
import type { CallError } from "../sdk-errors";
import { TransportError } from "../sdk-errors";

/** Test controls and observations for the in-memory room backend. */
export interface MemoryRooms {
  readonly transport: ConvexTransport.Interface;
  /** The committed room. */
  readonly room: Effect.Effect<Room>;
  /** The server's clock now. */
  readonly serverNow: Effect.Effect<EpochMillis>;
  /** Drops or restores the connection; calls and subscriptions fail while it is down. */
  readonly setConnected: (connected: boolean) => Effect.Effect<void>;
  /** Commits a clock change without telling subscribers, as a write racing this device would. */
  readonly changeSilently: (change: Partial<RoomClock>) => Effect.Effect<void>;
  /** Every function path called, in order. */
  readonly calls: Effect.Effect<ReadonlyArray<string>>;
  /**
   * Moves the room on to `fileId`, paused at its start with the next revision, as `rooms.playNext`
   * and `rooms.setMedia` do.
   */
  readonly moveTo: (fileId: MediaFileId) => Effect.Effect<void>;
}

/** How the backend behaves. */
export interface MemoryRoomsOptions {
  /** Server clock minus test clock. */
  readonly serverOffsetMs: number;
  /** One-way delay of every call, answer, and subscription update. */
  readonly latencyMs: number;
}

const encodeRoom = Schema.encodeSync(Schema.toCodecJson(RoomSchema));

const encodeClock = Schema.encodeSync(Schema.toCodecJson(RoomClockSchema));

const withClock = (room: Room, clock: RoomClock): Room =>
  Struct.evolve(room, { clock: () => clock });

const dropped = (operation: string): TransportError =>
  new TransportError({
    operation,
    message: `Transport failed during ${operation}: connection lost`,
    cause: null,
  });

const decodeArgs = <A>(schema: Schema.Codec<A, unknown>, args: WireArgs): Effect.Effect<A> =>
  Schema.decodeEffect(schema)(args).pipe(Effect.orDie);

/** Opens the backend with `room` committed. */
export const makeMemoryRooms = Effect.fn("MemoryRooms.make")(function* (
  initial: Room,
  options: MemoryRoomsOptions,
) {
  const committed = yield* Ref.make(initial);
  const published = yield* SubscriptionRef.make(initial);
  const connected = yield* SubscriptionRef.make(true);
  const calls = yield* Ref.make<ReadonlyArray<string>>([]);

  const opened = Math.round((yield* Clock.currentTimeMillis) + options.serverOffsetMs);

  const watched = yield* Ref.make<ReadonlyMap<string, number>>(
    new Map([
      [initial.hostDeviceId, opened],
      ...initial.members.map((member) => [member.deviceId, opened] as const),
    ]),
  );

  const latency = Duration.millis(options.latencyMs);

  const commit = (room: Room): Effect.Effect<void> =>
    Effect.andThen(Ref.set(committed, room), SubscriptionRef.set(published, room));

  const serverNow = Effect.map(Clock.currentTimeMillis, (now) =>
    EpochMillis.make(Math.round(now + options.serverOffsetMs)),
  );

  const requireConnection = (operation: string): Effect.Effect<void, TransportError> =>
    Effect.flatMap(SubscriptionRef.get(connected), (up) =>
      up ? Effect.void : Effect.fail(dropped(operation)),
    );

  const control = (
    args: (typeof commands)["rooms.play"]["args"]["Type"],
    status: (current: RoomClock) => RoomClock["status"],
  ): Effect.Effect<RoomClock, CommandError> =>
    Effect.gen(function* () {
      const now = yield* serverNow;
      const room = yield* Ref.get(committed);

      if (room.id !== args.roomId) return yield* new NotFound({ message: "No such room" });

      if (args.deviceId !== room.hostDeviceId) {
        return yield* new Forbidden({ message: "Only the host's device controls the room" });
      }

      if (room.clock.status === "ended") return yield* new Conflict({ message: "Room ended" });

      if (args.revision !== room.clock.revision || (args.fileId ?? room.fileId) !== room.fileId) {
        return yield* new StaleRevision({ message: "The room changed" });
      }

      const clock: RoomClock = {
        ...room.clock,
        status: status(room.clock),
        positionAtAnchorMs: args.positionMs,
        anchorServerTime: now,
        revision: room.clock.revision + 1,
      };

      yield* commit(withClock(room, clock));

      return clock;
    });

  const heartbeat = (
    args: (typeof commands)["rooms.heartbeat"]["args"]["Type"],
  ): Effect.Effect<RoomClock, CommandError> =>
    Effect.gen(function* () {
      const now = yield* serverNow;
      const before = yield* Ref.get(committed);

      if (before.id !== args.roomId) return yield* new NotFound({ message: "No such room" });

      const joined =
        args.deviceId === before.hostDeviceId ||
        before.members.some((each) => each.deviceId === args.deviceId);

      if (!joined) {
        return yield* new Forbidden({ message: "Join the room on this device first" });
      }

      const guest = args.deviceId !== before.hostDeviceId;
      const lastWatched = (yield* Ref.get(watched)).get(args.deviceId);

      if (
        args.presence === "away" &&
        lastWatched !== undefined &&
        now - lastWatched < PLAYER_SILENCE_MS
      ) {
        return before.clock;
      }

      const presence = args.presence ?? "watching";

      if (presence === "watching") {
        yield* Ref.update(watched, (times) => new Map([...times, [args.deviceId, now]]));
      }

      const driftMs = guest && presence === "watching" ? (args.driftMs ?? null) : null;

      const changed = before.members.some(
        (member) =>
          member.deviceId === args.deviceId &&
          (member.presence !== presence || member.driftMs !== driftMs),
      );

      const room = Struct.evolve(before, {
        members: (members) =>
          members.map((member) =>
            member.deviceId === args.deviceId ? { ...member, presence, driftMs } : member,
          ),
      });

      if ((guest && presence === "watching") || changed) yield* commit(room);

      if (guest) return room.clock;

      if (presence === "away") {
        if (room.clock.status !== "buffering") return room.clock;

        const clock: RoomClock = {
          ...room.clock,
          status: "paused",
          anchorServerTime: now,
          revision: room.clock.revision + 1,
        };

        yield* commit(withClock(room, clock));

        return clock;
      }

      if (
        args.positionMs === undefined ||
        args.deviceId !== room.hostDeviceId ||
        args.revision !== room.clock.revision ||
        room.clock.status !== "playing" ||
        (args.fileId ?? room.fileId) !== room.fileId
      ) {
        return room.clock;
      }

      const reading = hostReading(room.clock, args.positionMs, args.atServerTime, now);

      if (Math.abs(reading.positionMs - targetPosition(room.clock, now)) <= reading.thresholdMs) {
        return room.clock;
      }

      const clock: RoomClock = {
        ...room.clock,
        positionAtAnchorMs: reading.positionMs,
        anchorServerTime: now,
        revision: room.clock.revision + 1,
      };

      yield* commit(withClock(room, clock));

      return clock;
    });

  const dispatch = (path: FunctionPath, args: WireArgs): Effect.Effect<Schema.Json, CommandError> =>
    Effect.gen(function* () {
      switch (path) {
        case "rooms:get":
          return encodeRoom(yield* Ref.get(committed));
        case "rooms:time":
          return { serverTime: yield* serverNow };
        case "rooms:play":
          return encodeClock(
            yield* control(yield* decodeArgs(commands["rooms.play"].args, args), () => "playing"),
          );
        case "rooms:pause":
          return encodeClock(
            yield* control(yield* decodeArgs(commands["rooms.pause"].args, args), () => "paused"),
          );
        case "rooms:seek":
          return encodeClock(
            yield* control(yield* decodeArgs(commands["rooms.seek"].args, args), (clock) =>
              clock.status === "buffering" ? "paused" : clock.status,
            ),
          );
        case "rooms:buffering":
          return encodeClock(
            yield* control(
              yield* decodeArgs(commands["rooms.buffering"].args, args),
              () => "buffering",
            ),
          );
        case "rooms:heartbeat":
          return encodeClock(
            yield* heartbeat(yield* decodeArgs(commands["rooms.heartbeat"].args, args)),
          );
        default:
          return yield* Effect.die(new Error(`MemoryRooms does not serve ${path}`));
      }
    });

  const call = (
    _kind: ConvexTransport.FunctionKind,
    path: FunctionPath,
    args: WireArgs,
  ): Effect.Effect<Schema.Json, CallError> =>
    Effect.gen(function* () {
      yield* Ref.update(calls, (list) => [...list, path]);
      yield* Effect.sleep(latency);
      yield* requireConnection(path);
      const result = yield* dispatch(path, args);

      yield* Effect.sleep(latency);
      yield* requireConnection(path);

      return result;
    });

  const subscribe = (path: FunctionPath): Stream.Stream<Schema.Json, CallError> => {
    if (path !== "rooms:get") return Stream.die(new Error(`MemoryRooms cannot watch ${path}`));

    const updates = SubscriptionRef.changes(published).pipe(Stream.map(Option.some));

    const drops = SubscriptionRef.changes(connected).pipe(
      Stream.filter((up) => !up),
      Stream.map(() => Option.none<Room>()),
    );

    return Stream.unwrap(Effect.as(requireConnection(path), Stream.merge(updates, drops))).pipe(
      Stream.mapEffect((update) =>
        Effect.delay(
          Option.match(update, {
            onNone: () => Effect.fail(dropped(path)),
            onSome: (room) => Effect.succeed(encodeRoom(room)),
          }),
          latency,
        ),
      ),
    );
  };

  const rooms: MemoryRooms = {
    transport: ConvexTransport.ConvexTransport.of({
      call,
      subscribe: (path) => subscribe(path),
      setAuth: () => Effect.void,
      authenticated: Effect.succeed("none" as const),
    }),
    room: Ref.get(committed),
    serverNow,
    setConnected: (up) => SubscriptionRef.set(connected, up),
    changeSilently: (change) =>
      Effect.gen(function* () {
        const room = yield* Ref.get(committed);
        const now = yield* serverNow;

        yield* Ref.set(
          committed,
          withClock(room, {
            ...room.clock,
            positionAtAnchorMs: Milliseconds.make(targetPosition(room.clock, now)),
            anchorServerTime: now,
            ...change,
            revision: room.clock.revision + 1,
          }),
        );
      }),
    calls: Ref.get(calls),
    moveTo: (fileId) =>
      Effect.gen(function* () {
        const room = yield* Ref.get(committed);
        const now = yield* serverNow;

        yield* commit(
          Struct.evolve(room, {
            fileId: () => fileId,
            next: () => null,
            clock: (clock) => ({
              ...clock,
              status: "paused" as const,
              positionAtAnchorMs: Milliseconds.make(0),
              anchorServerTime: now,
              revision: clock.revision + 1,
            }),
          }),
        );
      }),
  };

  return rooms;
});
