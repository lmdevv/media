import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { api, internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { PRESENT_MS } from "../../../convex/core/together/model";
import { followLog, logMark, runFunction, usageSince } from "../../admin";
import type { Member } from "../../devices";
import { newestRows } from "../../rows";
import { coreStackFromEnvFile } from "../../stack-env";
import type { CoreStack } from "../../stack-env";
import { inOrder } from "../../../convex/core/lib/inOrder";
import { catalog, guestOf, joinedView, repeat, sleep, watch } from "../../together";
import type { Catalog, View } from "../../together";

const stack = coreStackFromEnvFile();

// SAFETY: a type predicate, not checked by the compiler. The rows come from the
// `togetherMembers` table, whose validator holds `v.id("togetherMembers")` for `_id`.
const isMemberId = (value: unknown): value is Id<"togetherMembers"> =>
  Schema.is(Schema.String)(value);

const MemberRow = Schema.fromJsonString(
  Schema.Struct({
    _id: Schema.declare(isMemberId),
    userId: Schema.String,
    awaySince: Schema.NullOr(Schema.Finite),
  }),
);

const decodeRow = Schema.decodeUnknownSync(MemberRow);

const beat = (who: Member) =>
  who.signedIn.client.mutation(api.core.together.heartbeat, { domain: "movies" });

const presence = (view: View, who: Member): boolean | null =>
  view?.state === "joined"
    ? (view.members.find((row) => row.userId === who.userId)?.present ?? null)
    : null;

const joinedSession = async (core: CoreStack): Promise<{ shelf: Catalog; guest: Member }> => {
  const shelf = await catalog(core);
  const guest = await guestOf(core, shelf, "guest");

  const { link } = await shelf.host.signedIn.client.action(api.core.together.create, {
    item: shelf.g,
  });

  await guest.signedIn.client.mutation(api.core.together.join, { domain: "movies", link });

  return { shelf, guest };
};

const sweepAsOf = (core: CoreStack, asOf: number) =>
  runFunction(core, internal.core.together.presence.sweep, { asOf }, Schema.Null);

describe.skipIf(stack === undefined)("presence in group sessions", { timeout: 120_000 }, () => {
  it("drops a member whose heartbeat stops from presence, and brings them back", async () => {
    if (stack === undefined) return;
    const { shelf, guest } = await joinedSession(stack);
    const seen = watch(stack, shelf.host, "movies");
    let beating = true;

    const hostBeats = repeat(
      () => beating,
      5_000,
      async () => {
        await beat(shelf.host);
      },
    );

    try {
      await seen.until((view) => presence(view, guest) === true);

      const started = Date.now();
      const away = await seen.until((view) => presence(view, guest) === false, PRESENT_MS + 20_000);

      expect(Date.now() - started).toBeGreaterThan(PRESENT_MS - 10_000);
      expect(presence(away, shelf.host)).toBe(true);

      await beat(guest);
      await seen.until((view) => presence(view, guest) === true);
    } finally {
      beating = false;
      await hostBeats;
      await seen.close();
    }
  });

  it("pauses a playing session when its host goes away, and ends it when they stay away", async () => {
    if (stack === undefined) return;
    const { shelf, guest } = await joinedSession(stack);

    const playing = await shelf.host.signedIn.client.mutation(api.core.together.control, {
      domain: "movies",
      op: { kind: "play" },
    });

    await sweepAsOf(stack, Date.now() + PRESENT_MS + 1_000);

    const paused = await joinedView(guest, "movies");

    expect(paused.clock).toMatchObject({ status: "paused", revision: playing.revision + 1 });
    expect(paused.clock.positionAtAnchorMs).toBeGreaterThanOrEqual(0);
    expect(presence(paused, shelf.host)).toBe(false);

    const host = newestRows("togetherMembers")
      .map((line) => decodeRow(line))
      .find((row) => row.userId === shelf.host.userId);

    if (host?.awaySince === null || host === undefined) throw new Error("the host is not away");

    await runFunction(
      stack,
      internal.core.together.presence.abandon,
      { memberId: host._id, awaySince: host.awaySince + 1 },
      Schema.Null,
    );

    expect((await joinedView(guest, "movies")).clock.status).toBe("paused");

    await runFunction(
      stack,
      internal.core.together.presence.abandon,
      { memberId: host._id, awaySince: host.awaySince },
      Schema.Null,
    );

    expect(
      await guest.signedIn.client.query(api.core.together.get, { domain: "movies" }),
    ).toMatchObject({ state: "ended", reason: "abandoned" });
  });

  it("drops a request whose person left before the host answered", async () => {
    if (stack === undefined) return;
    const shelf = await catalog(stack);
    const asking = await guestOf(stack, shelf, "asking");

    const { link } = await shelf.host.signedIn.client.action(api.core.together.create, {
      item: shelf.g,
      join: "approval",
    });

    await asking.signedIn.client.mutation(api.core.together.join, { domain: "movies", link });

    expect((await joinedView(shelf.host, "movies")).pending).toHaveLength(1);

    await sweepAsOf(stack, Date.now() + PRESENT_MS + 1_000);

    expect((await joinedView(shelf.host, "movies")).pending).toEqual([]);
    expect(await asking.signedIn.client.query(api.core.together.get, { domain: "movies" })).toBe(
      null,
    );
  });

  it("re-runs nobody's view for a heartbeat and writes at most one row", async () => {
    if (stack === undefined) return;
    const { shelf, guest } = await joinedSession(stack);
    const seen = watch(stack, shelf.host, "movies");

    try {
      await seen.until((view) => presence(view, guest) === true);

      const mark = await logMark(stack);

      await inOrder([1, 2, 3, 4, 5, 6], async () => {
        await beat(guest);
        await beat(guest);
        await sleep(1_100);
      });

      const beats = (await usageSince(stack, mark, api.core.together.heartbeat, 12)).filter(
        (call) => call.committed,
      );

      const log = followLog(stack, mark);

      await log.catchUp();

      expect(beats).toHaveLength(12);
      expect(Math.max(...beats.map((call) => call.writes))).toBeLessThanOrEqual(1);
      expect(beats.filter((call) => call.writes === 0).length).toBeGreaterThanOrEqual(6);
      expect(log.usage(api.core.together.get)).toEqual([]);
    } finally {
      await seen.close();
    }
  });
});
