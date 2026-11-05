import { register } from "../../../commands/core/connect/player";
import type { Doc, Id } from "../../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../../_generated/server";
import type { Caller } from "../auth/caller";
import { fail } from "../lib/errors";
import { appliedAfter, parsePosition, pendingRequest } from "./playback";
import type { Player, Request } from "./playback";

const RECEIVER_MAX = 64;

type Output = Player["output"];

/** The device's player row, or null before its first report. */
export const playerOf = (db: DatabaseReader, deviceId: Id<"devices">): Promise<Player | null> =>
  db
    .query("connectPlayers")
    .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
    .unique();

/** The newest request made of the device, or null before the first. */
export const requestOf = (db: DatabaseReader, deviceId: Id<"devices">): Promise<Request | null> =>
  db
    .query("connectRequests")
    .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
    .unique();

/** Forgets what Connect kept for a device: its report and its request. */
export const dropConnect = async (
  ctx: Pick<MutationCtx, "db">,
  deviceId: Id<"devices">,
): Promise<void> => {
  const rows: ReadonlyArray<Doc<"connectPlayers"> | Doc<"connectRequests"> | null> =
    await Promise.all([playerOf(ctx.db, deviceId), requestOf(ctx.db, deviceId)]);

  await Promise.all(rows.flatMap((row) => (row === null ? [] : [ctx.db.delete(row._id)])));
};

const deviceOfCaller = async (db: DatabaseReader, caller: Caller): Promise<Id<"devices">> => {
  const session = await db.get(caller.sessionId);
  const device = session === null || session.kind === "apiKey" ? undefined : session.device;

  return (
    device?.id ??
    fail("forbidden", "Only an app registered as a device has a player; enroll this app first")
  );
};

const receiverName = (name: string): string => {
  const trimmed = name.trim();

  return trimmed.length === 0 || trimmed.length > RECEIVER_MAX
    ? fail("invalid_args", `Name the receiver with 1 to ${RECEIVER_MAX} characters`)
    : trimmed;
};

const parseOutput = (output: Output): Output => {
  if (output.kind === "local") return output;

  if (output.kind === "cast") return { kind: "cast", receiver: receiverName(output.receiver) };

  return {
    kind: "airplay",
    receiver: output.receiver === null ? null : receiverName(output.receiver),
  };
};

const parseRevision = (revision: number): number =>
  Number.isSafeInteger(revision) && revision >= 0
    ? revision
    : fail("invalid_args", "A revision is a whole number, 0 or more");

export const { report, requested } = register({
  report: async (ctx, { output, playback, applied }, caller) => {
    const deviceId = await deviceOfCaller(ctx.db, caller);
    const stored = await playerOf(ctx.db, deviceId);
    const reportedAt = Date.now();

    const row = {
      deviceId,
      reporter: caller.sessionId,
      output: parseOutput(output),
      playback:
        playback === null ? null : { ...playback, positionMs: parsePosition(playback.positionMs) },
      applied: appliedAfter(stored, caller.sessionId, parseRevision(applied)),
      reportedAt,
    };

    if (stored === null) await ctx.db.insert("connectPlayers", row);
    else await ctx.db.replace(stored._id, row);

    return { reportedAt };
  },
  requested: async (ctx, _args, caller) => {
    const deviceId = await deviceOfCaller(ctx.db, caller);

    const [player, request] = await Promise.all([
      playerOf(ctx.db, deviceId),
      requestOf(ctx.db, deviceId),
    ]);

    const pending = player?.reporter === caller.sessionId ? pendingRequest(player, request) : null;

    return pending === null
      ? null
      : {
          revision: pending.revision,
          playing: pending.playing,
          positionMs: pending.positionMs,
          at: pending.at,
        };
  },
});
