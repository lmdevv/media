import type { DomainItem } from "../../../commands/access";
import { register } from "../../../commands/core/connect/targets";
import { contentDomain } from "../../../commands/scopes";
import type { Doc, Id } from "../../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../../_generated/server";
import { callerUser } from "../auth/caller";
import type { Caller } from "../auth/caller";
import { NO_DEVICE } from "../devices/facts";
import { fail } from "../lib/errors";
import { reachOf } from "../permissions/grants";
import { mayPlay, playableBy, requirePlayable } from "../permissions/items";
import { can } from "../permissions/policy";
import type { DeviceAction, DeviceResource, PersonDoc, Principal } from "../permissions/policy";
import { boundDevice, liveOnDevice } from "../sessions";
import { memberIn } from "../together/access";
import { deviceFor, playerOf, reporterOf, requestOf } from "./facts";
import type { Ask } from "./model";
import { controlAsk, moveAsk, nextRevision, parsePosition, playbackOf } from "./playback";
import type { Change, Playback, Player, Request } from "./playback";

const BOUND_DEVICES_READ = 64;

const ENDED_DEVICES_SKIPPED = 192;

const SHARED_DEVICES_READ = 64;

const SESSION_DEVICES_READ = 64;

/**
 * Sessions bound to a device sort after those on none, so the descending walk ends at the first
 * session on no device. A device's newest session ends last, so when it has ended, the person's
 * older sessions there have too.
 */
const liveBoundBelow = async (
  db: DatabaseReader,
  person: PersonDoc,
  below: Id<"devices"> | null,
  left: number,
  skips: number,
  now: number,
): Promise<ReadonlyArray<Id<"devices">>> => {
  if (left === 0) return [];

  const session = await db
    .query("authSessions")
    .withIndex("by_user_device", (q) =>
      below === null
        ? q.eq("userId", person._id)
        : q.eq("userId", person._id).lt("device.id", below),
    )
    .order("desc")
    .first();

  const deviceId = session === null ? null : (boundDevice(session)?.id ?? null);

  if (session === null || deviceId === null) return [];

  const device = await db.get(deviceId);

  if (device !== null && liveOnDevice(session, person, device, now)) {
    return [deviceId, ...(await liveBoundBelow(db, person, deviceId, left - 1, skips, now))];
  }

  return skips === 0 ? [] : liveBoundBelow(db, person, deviceId, left, skips - 1, now);
};

const followingTheirSessions = async (
  db: DatabaseReader,
  person: PersonDoc,
): Promise<ReadonlyArray<Id<"devices">>> => {
  const rows = await Promise.all(
    contentDomain.members.map(async ({ value: domain }) => memberIn(db, person._id, domain)),
  );

  const players = await Promise.all(
    rows.map(async (row) =>
      row === null || row.state !== "joined"
        ? []
        : db
            .query("connectPlayers")
            .withIndex("by_session", (q) => q.eq("playback.session", row.sessionId))
            .take(SESSION_DEVICES_READ),
    ),
  );

  return players.flat().map((player) => player.deviceId);
};

/**
 * The devices a person might control: those they have a live session on, every shared device
 * while shared devices list them, and for a guest every device that follows their group session.
 */
const reachable = async (
  db: DatabaseReader,
  person: PersonDoc,
): Promise<ReadonlyArray<Id<"devices">>> => {
  const [bound, shared, following] = await Promise.all([
    liveBoundBelow(db, person, null, BOUND_DEVICES_READ, ENDED_DEVICES_SKIPPED, Date.now()),
    person.sharedDevices === true
      ? db
          .query("devices")
          .withIndex("by_mode", (q) => q.eq("mode", "shared"))
          .take(SHARED_DEVICES_READ)
      : [],
    person.role === "guest" ? followingTheirSessions(db, person) : [],
  ]);

  return [...new Set([...bound, ...shared.map((device) => device._id), ...following])];
};

const refusals = {
  "no-control": "The group session's host has not let guests control playback",
  guest: "A guest from a share link cannot load or move playback",
} as const;

const requireDevice = (caller: Caller, action: DeviceAction, device: DeviceResource): void => {
  const decision = can(caller, action, device);

  if (decision.allowed) return;

  if (decision.refusal === "hidden") fail("not_found", NO_DEVICE);

  fail(
    "forbidden",
    decision.because === "no-control" || decision.because === "guest"
      ? refusals[decision.because]
      : "This session cannot play what that device plays",
  );
};

const parseChange = ({ playing, positionMs }: Change): Change => {
  if (playing === undefined && positionMs === undefined) {
    return fail("invalid_args", "Say whether to play, where to seek, or both");
  }

  return { playing, positionMs: positionMs === undefined ? undefined : parsePosition(positionMs) };
};

interface Target {
  readonly device: Doc<"devices">;
  readonly player: Player | null;
  readonly request: Request | null;
  readonly current: Playback | null;
}

const targetOf = async (db: DatabaseReader, deviceId: Id<"devices">): Promise<Target> => {
  const [device, player, request] = await Promise.all([
    db.get(deviceId),
    playerOf(db, deviceId),
    requestOf(db, deviceId),
  ]);

  if (device === null) return fail("not_found", NO_DEVICE);

  return {
    device,
    player,
    request,
    current: player === null ? null : playbackOf(player, request),
  };
};

const ask = async (
  ctx: Pick<MutationCtx, "db">,
  target: Target,
  player: Player,
  made: Ask,
): Promise<number> => {
  const revision = nextRevision(target.request);

  const row = {
    deviceId: target.device._id,
    reporter: player.reporter,
    revision,
    ask: made,
  };

  if (target.request === null) await ctx.db.insert("connectRequests", row);
  else await ctx.db.replace(target.request._id, row);

  return revision;
};

const OFFLINE = "That device is offline";

/**
 * Checks that `caller` may load `item`'s domain onto `target` and control what it plays now, and
 * answers the device's player with the person whose session reports for it.
 */
const requireLoad = async (
  ctx: Pick<MutationCtx, "db">,
  caller: Caller,
  person: PersonDoc,
  target: Target,
  item: DomainItem,
  now: number,
): Promise<{ readonly player: Player; readonly reporter: Principal }> => {
  const { device, player, current } = target;

  const resource = await deviceFor(
    ctx.db,
    device,
    person,
    target,
    current?.item.domain ?? null,
    now,
  );

  requireDevice(caller, "control", resource);
  requireDevice(caller, "load", { ...resource, domain: item.domain });

  const reporter = player === null ? null : await reporterOf(ctx.db, player, now);

  return player === null || reporter === null ? fail("conflict", OFFLINE) : { player, reporter };
};

/** Refuses an item the person on the device may not play, such as a kid and an explicit song. */
const requireTheyPlay = async (
  db: DatabaseReader,
  reporter: Principal,
  item: DomainItem,
): Promise<void> => {
  if (!(await mayPlay(db, reporter, item))) {
    fail("forbidden", "The person on that device cannot play that");
  }
};

export const { list, control, load, move } = register({
  list: async (ctx, _args, caller) => {
    const person = await callerUser(ctx, caller);
    const now = Date.now();
    const playable = playableBy(ctx.db, await reachOf(ctx.db, caller));

    const targets = await Promise.all(
      (await reachable(ctx.db, person)).map(async (deviceId) => {
        const [device, player] = await Promise.all([
          ctx.db.get(deviceId),
          playerOf(ctx.db, deviceId),
        ]);

        if (
          device === null ||
          player === null ||
          (await reporterOf(ctx.db, player, now)) === null
        ) {
          return [];
        }

        const current = playbackOf(player, await requestOf(ctx.db, deviceId));
        const domain = current?.item.domain ?? null;
        const resource = await deviceFor(ctx.db, device, person, { player, current }, domain, now);

        if (!can(caller, "control", resource).allowed) return [];

        const playback =
          current === null
            ? null
            : {
                domain: current.item.domain,
                item: (await playable(current.item)) ? current.item : null,
                playing: current.playing,
                positionMs: current.positionMs,
                at: current.at,
                pending: current.pending,
              };

        return [
          {
            deviceId,
            name: device.name,
            mode: device.mode,
            output: player.output,
            playback,
            reportedAt: player.reportedAt,
          },
        ];
      }),
    );

    return targets.flat().toSorted((left, right) => right.reportedAt - left.reportedAt);
  },
  control: async (ctx, { deviceId, ...asked }, caller) => {
    const change = parseChange(asked);
    const now = Date.now();

    const [target, person] = await Promise.all([
      targetOf(ctx.db, deviceId),
      callerUser(ctx, caller),
    ]);

    const { device, player, current } = target;

    requireDevice(
      caller,
      "control",
      await deviceFor(ctx.db, device, person, target, current?.item.domain ?? null, now),
    );

    if (player === null || (await reporterOf(ctx.db, player, now)) === null) {
      return fail("conflict", OFFLINE);
    }

    if (current === null) return fail("conflict", "Nothing plays on that device");

    return { revision: await ask(ctx, target, player, controlAsk(current, change, now)) };
  },
  load: async (ctx, { deviceId, item, positionMs }, caller) => {
    const position = positionMs === undefined ? 0 : parsePosition(positionMs);
    const now = Date.now();

    const [target, person] = await Promise.all([
      targetOf(ctx.db, deviceId),
      callerUser(ctx, caller),
    ]);

    const { player, reporter } = await requireLoad(ctx, caller, person, target, item, now);

    await requirePlayable(ctx.db, caller, item);
    await requireTheyPlay(ctx.db, reporter, item);

    const loaded: Ask = { kind: "load", item, playing: true, positionMs: position, at: now };

    return { revision: await ask(ctx, target, player, loaded) };
  },
  move: async (ctx, { from, to }, caller) => {
    if (from === to) return fail("invalid_args", "Move playback to another device");

    const now = Date.now();

    const [source, target, person] = await Promise.all([
      targetOf(ctx.db, from),
      targetOf(ctx.db, to),
      callerUser(ctx, caller),
    ]);

    requireDevice(
      caller,
      "control",
      await deviceFor(
        ctx.db,
        source.device,
        person,
        source,
        source.current?.item.domain ?? null,
        now,
      ),
    );

    if (source.player === null || (await reporterOf(ctx.db, source.player, now)) === null) {
      return fail("conflict", OFFLINE);
    }

    if (source.current === null) return fail("conflict", "Nothing plays on that device");

    const { item } = source.current;
    const { player, reporter } = await requireLoad(ctx, caller, person, target, item, now);

    if (!(await mayPlay(ctx.db, caller, item))) {
      return fail("forbidden", "You cannot play what that device plays");
    }

    await requireTheyPlay(ctx.db, reporter, item);
    await ask(ctx, source, source.player, { kind: "stop", at: now });

    return { revision: await ask(ctx, target, player, moveAsk(source.current, now)) };
  },
});
