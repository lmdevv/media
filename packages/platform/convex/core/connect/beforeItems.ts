import type { MutationCtx } from "../../_generated/server";
import { playerOf } from "./facts";
import { reportOf } from "./playback";
import type { Player, Request } from "./playback";

/** Rows per batch: each old request costs one index read and up to two writes. */
const BATCH = 256;

/** The phase a cursor of `clearRowsBeforeItems` is in, before the table's own cursor. */
const REQUESTS = "requests:";

const PLAYERS = "players:";

interface Batch {
  readonly continueCursor: string;
  readonly isDone: boolean;
}

const isOldReport = (player: Player): boolean =>
  player.playback !== null && reportOf(player) === null;

/** The table's own cursor in `cursor`, or null at the start of its phase. */
const tableCursor = (cursor: string, phase: string): string | null =>
  cursor.length === phase.length ? null : cursor.slice(phase.length);

/**
 * Rewrites a request v0.3.0 wrote, a flat transport, as a `stop` under the same revision, and
 * settles it on the device's report, which it also clears when v0.3.0 wrote that too.
 */
const settleOldRequest = async (ctx: MutationCtx, request: Request): Promise<void> => {
  if ("ask" in request) return;

  const { deviceId, reporter, revision, at } = request;
  const player = await playerOf(ctx.db, deviceId);

  await ctx.db.replace(request._id, { deviceId, reporter, revision, ask: { kind: "stop", at } });

  if (player === null) return;

  const settled = Math.max(player.settled, revision);

  await ctx.db.patch(player._id, isOldReport(player) ? { settled, playback: null } : { settled });
};

/**
 * One batch of `connect.clearRowsBeforeItems` (`core/schemaMigrations.ts`), which clears Connect's rows
 * in v0.3.0's shapes in one chain, so no two batches write the same report at once. It walks the
 * requests first, then the reports.
 *
 * - A request names no item, so Connect never takes it as pending. It becomes a `stop` under the
 *   same revision, settled on the device's report, so it never fires, the next request is above
 *   it, and an `applied` a client kept stays at or below the newest.
 * - A report names a domain but no item, so Connect reads it as playing nothing. Its playback
 *   becomes null, which says the same, and its `settled` stays, so a request made since the
 *   upgrade still waits for the device.
 */
export const clearRowsBeforeItems = async (
  ctx: MutationCtx,
  cursor: string | null,
): Promise<Batch> => {
  if (cursor === null || cursor.startsWith(REQUESTS)) {
    const page = await ctx.db.query("connectRequests").paginate({
      cursor: cursor === null ? null : tableCursor(cursor, REQUESTS),
      numItems: BATCH,
    });

    await Promise.all(page.page.map((request) => settleOldRequest(ctx, request)));

    return {
      continueCursor: page.isDone ? PLAYERS : `${REQUESTS}${page.continueCursor}`,
      isDone: false,
    };
  }

  const page = await ctx.db.query("connectPlayers").paginate({
    cursor: tableCursor(cursor, PLAYERS),
    numItems: BATCH,
  });

  await Promise.all(
    page.page.filter(isOldReport).map((player) => ctx.db.patch(player._id, { playback: null })),
  );

  return { continueCursor: `${PLAYERS}${page.continueCursor}`, isDone: page.isDone };
};
