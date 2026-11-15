import { register } from "../../../commands/core/connect/player";
import type { ContentDomain } from "../../../commands/scopes";
import type { Doc, Id } from "../../_generated/dataModel";
import type { DatabaseReader } from "../../_generated/server";
import { callerUser } from "../auth/caller";
import type { Caller } from "../auth/caller";
import { fail } from "../lib/errors";
import { printableName } from "../lib/names";
import { can } from "../permissions/policy";
import { boundDevice } from "../sessions";
import { factsOf, memberIn, placeOf } from "../together/access";
import { deviceFor, playerOf, requestOf } from "./facts";
import { parsePosition, pendingRequest, settledAfter } from "./playback";
import type { Player } from "./playback";

const RECEIVER_MAX = 64;

type Output = Player["output"];

const deviceOfCaller = async (db: DatabaseReader, caller: Caller): Promise<Doc<"devices">> => {
  const session = await db.get(caller.sessionId);
  const bound = session === null ? null : boundDevice(session);
  const device = bound === null ? null : await db.get(bound.id);

  return (
    device ??
    fail("forbidden", "Only an app registered as a device has a player; enroll this app first")
  );
};

const receiverName = (name: string | null): string | null => {
  const printable = name === null ? null : printableName(name);

  return printable === null
    ? null
    : printableName(Array.from(printable).slice(0, RECEIVER_MAX).join(""));
};

const parseOutput = (output: Output): Output =>
  output.kind === "local" ? output : { kind: output.kind, receiver: receiverName(output.receiver) };

const parseApplied = (applied: number, newestRevision: number): number => {
  if (!Number.isSafeInteger(applied) || applied < 0) {
    return fail("invalid_args", "A revision is a whole number, 0 or more");
  }

  return applied > newestRevision
    ? fail("invalid_args", `No request after revision ${newestRevision} was made of this device`)
    : applied;
};

/** An ended session still passes (`view` allows it), so a device that has not seen it end keeps reporting. */
const requireFollows = async (
  db: DatabaseReader,
  caller: Caller,
  domain: ContentDomain,
  sessionId: Id<"togetherSessions">,
): Promise<void> => {
  const [session, member] = await Promise.all([
    db.get(sessionId),
    memberIn(db, caller.userId, domain),
  ]);

  const decision =
    session === null || session.item.domain !== domain
      ? null
      : can(caller, "view", factsOf(session, placeOf(session, caller.userId, member)));

  if (decision?.allowed !== true)
    fail("not_found", "This device's person is not in that group session");
};

export const { report, requested } = register({
  report: async (ctx, { output, playback, applied }, caller) => {
    const now = Date.now();
    const device = await deviceOfCaller(ctx.db, caller);

    const [person, stored, request] = await Promise.all([
      callerUser(ctx, caller),
      playerOf(ctx.db, device._id),
      requestOf(ctx.db, device._id),
    ]);

    const newestRevision = request?.revision ?? 0;
    const domain = playback?.item.domain ?? null;
    const resource = await deviceFor(ctx.db, device, person, null, domain, now);

    if (!can(caller, "report", resource).allowed) {
      return fail("forbidden", "This session cannot play what it reports");
    }

    if (playback?.session !== undefined) {
      await requireFollows(ctx.db, caller, playback.item.domain, playback.session);
    }

    const row = {
      deviceId: device._id,
      reporter: caller.sessionId,
      output: parseOutput(output),
      playback:
        playback === null ? null : { ...playback, positionMs: parsePosition(playback.positionMs) },
      settled: settledAfter(
        stored,
        caller.sessionId,
        parseApplied(applied, newestRevision),
        newestRevision,
        now,
      ),
      reportedAt: now,
    };

    if (stored === null) await ctx.db.insert("connectPlayers", row);
    else await ctx.db.replace(stored._id, row);

    return { reportedAt: now };
  },
  requested: async (ctx, _args, caller) => {
    const device = await deviceOfCaller(ctx.db, caller);

    const [player, request] = await Promise.all([
      playerOf(ctx.db, device._id),
      requestOf(ctx.db, device._id),
    ]);

    const pending = player?.reporter === caller.sessionId ? pendingRequest(player, request) : null;

    return pending === null ? null : { revision: pending.revision, ask: pending.ask };
  },
});
