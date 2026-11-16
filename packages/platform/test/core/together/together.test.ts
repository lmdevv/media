import { run } from "@media/contracts/follower";
import type { FollowerPlayer, SessionPort } from "@media/contracts/follower";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { FunctionArgs } from "convex/server";
import { Data, Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { ContentDomain } from "../../../commands/scopes";
import { api } from "../../../convex/_generated/api";
import { inOrder } from "../../../convex/core/lib/inOrder";
import { FIRST_BY_MS } from "../../../convex/core/together/clock";
import { BLOCKED_MAX } from "../../../convex/core/together/model";
import { member } from "../../devices";
import type { Member } from "../../devices";
import { failureOf, refusal } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";
import type { CoreStack } from "../../stack-env";
import {
  catalog,
  guestOf,
  joinedView,
  kidOf,
  plantedStrangers,
  sleep,
  watch,
} from "../../together";
import type { Catalog } from "../../together";

const stack = coreStackFromEnvFile();

type Settings = Omit<FunctionArgs<typeof api.core.together.create>, "item" | "queue">;

type Op = FunctionArgs<typeof api.core.together.control>["op"];

interface Started {
  readonly shelf: Catalog;
  readonly link: string;
}

/** A new host's movies session on the G movie, with `settings`. */
const started = async (core: CoreStack, settings: Settings = {}): Promise<Started> => {
  const shelf = await catalog(core);

  const { link } = await shelf.host.signedIn.client.action(api.core.together.create, {
    item: shelf.g,
    ...settings,
  });

  return { shelf, link };
};

const joinBy = (who: Member, link: string, domain: ContentDomain = "movies") =>
  who.signedIn.client.mutation(api.core.together.join, { domain, link });

const controlAs = (who: Member, op: Op, domain: ContentDomain = "movies") =>
  who.signedIn.client.mutation(api.core.together.control, { domain, op });

type EntryId = FunctionArgs<typeof api.core.together.remove>["entryId"];

/** The entries `who` sees queued in their session in `domain`, in play order. */
const queuedIds = async (
  who: Member,
  domain: ContentDomain = "movies",
): Promise<ReadonlyArray<EntryId>> =>
  (
    await who.signedIn.client.query(api.core.together.queue, {
      domain,
      paginationOpts: { numItems: 50, cursor: null },
    })
  ).page.map((entry) => entry.entryId);

type ReorderArgs = FunctionArgs<typeof api.core.together.reorder>;

const reorderAs = (who: Member, entryId: EntryId, afterEntryId?: EntryId) => {
  const args: ReorderArgs = { domain: "movies", entryId };

  if (afterEntryId !== undefined) args.afterEntryId = afterEntryId;

  return who.signedIn.client.mutation(api.core.together.reorder, args);
};

/** The core refused a follower's call, or the call did not reach it. */
class CallFailed extends Data.TaggedError("CallFailed")<{ readonly cause: unknown }> {}

/** `who`'s movies session as the shared follower reaches it, over the real backend. */
const portOf = (who: Member): SessionPort<CallFailed> => ({
  heartbeat: Effect.tryPromise({
    try: () => who.signedIn.client.mutation(api.core.together.heartbeat, { domain: "movies" }),
    catch: (cause) => new CallFailed({ cause }),
  }),
  control: (op) =>
    Effect.tryPromise({
      try: () => controlAs(who, op),
      catch: (cause) => new CallFailed({ cause }),
    }),
});

const memberNames = async (who: Member): Promise<ReadonlyArray<string>> =>
  (await joinedView(who, "movies")).members.map((row) => row.username);

const configureAs = (who: Member, settings: Required<Settings>) =>
  who.signedIn.client.mutation(api.core.together.configure, { domain: "movies", ...settings });

/** `core.together.add` as a client that does not use the generated types sends it. */
const untypedAdd = makeFunctionReference<
  "mutation",
  { item: { domain: string; ref: { type: string; id: string } } },
  unknown
>("core/together:add");

describe.skipIf(stack === undefined)("group sessions", { timeout: 120_000 }, () => {
  it("starts a session paused on an item its host can play, with the host in it", async () => {
    if (stack === undefined) return;
    const { shelf, link } = await started(stack);
    const view = await joinedView(shelf.host, "movies");

    expect(link).toMatch(/^mt_[a-z0-9]+\.[\w-]{20,}$/u);
    expect(view).toMatchObject({
      role: "host",
      link,
      settings: { join: "open", control: false, add: false },
      may: { control: true, add: true, manage: true },
      clock: { status: "paused", positionAtAnchorMs: 0, playbackRate: 1, revision: 0 },
      item: shelf.g,
      members: [{ userId: shelf.host.userId, role: "host", present: true }],
      pending: [],
    });

    const stranger = await member(stack, "stranger");

    expect(
      await refusal(stranger.signedIn.client.action(api.core.together.create, { item: shelf.g })),
    ).toBe("not_found");
    expect(
      await refusal(
        shelf.host.signedIn.client.action(api.core.together.create, { item: shelf.pg }),
      ),
    ).toBe("conflict");
  });

  it("lets anyone with the link into an open session, as a guest who may only follow", async () => {
    if (stack === undefined) return;
    const { shelf, link } = await started(stack);
    const guest = await guestOf(stack, shelf, "guest");

    expect(await joinBy(guest, link)).toEqual({ state: "joined" });
    expect(await joinBy(guest, link)).toEqual({ state: "joined" });

    const view = await joinedView(guest, "movies");

    expect(view).toMatchObject({
      role: "guest",
      link,
      may: { control: false, add: false, manage: false },
      pending: null,
    });
    expect(new Set(view.members.map((row) => `${row.username} ${row.role}`))).toEqual(
      new Set([`${shelf.host.username} host`, `${guest.username} guest`]),
    );
    expect(await refusal(joinBy(guest, `${link}x`))).toBe("not_found");
    expect(await refusal(joinBy(guest, "mt_abc.defghijklmnopqrstuvwxyz"))).toBe("not_found");
  });

  it("holds a new member of an approval session until the host lets them in", async () => {
    if (stack === undefined) return;
    const { shelf, link } = await started(stack, { join: "approval" });
    const guest = await guestOf(stack, shelf, "waiting");
    const seen = watch(stack, guest, "movies");

    try {
      expect(await joinBy(guest, link)).toEqual({ state: "pending" });
      await seen.until((view) => view?.state === "pending");

      expect(
        await refusal(
          guest.signedIn.client.query(api.core.together.queue, {
            domain: "movies",
            paginationOpts: { numItems: 10, cursor: null },
          }),
        ),
      ).toBe("forbidden");
      expect(await refusal(controlAs(guest, { kind: "play" }))).toBe("forbidden");
      expect((await joinedView(shelf.host, "movies")).pending).toEqual([
        { userId: guest.userId, username: guest.username, displayName: null, present: true },
      ]);

      await shelf.host.signedIn.client.mutation(api.core.together.admit, {
        domain: "movies",
        userId: guest.userId,
      });

      const admitted = await seen.until((view) => view?.state === "joined");

      expect(admitted).toMatchObject({ role: "guest", item: shelf.g });
      expect((await joinedView(shelf.host, "movies")).pending).toEqual([]);
    } finally {
      await seen.close();
    }
  });

  it("refuses a new member of a locked session and keeps the ones it has", async () => {
    if (stack === undefined) return;
    const { shelf, link } = await started(stack);
    const inside = await guestOf(stack, shelf, "inside");
    const waiting = await guestOf(stack, shelf, "waiting");
    const late = await guestOf(stack, shelf, "late");

    await joinBy(inside, link);
    await configureAs(shelf.host, { join: "approval", control: false, add: false });
    await joinBy(waiting, link);
    await configureAs(shelf.host, { join: "locked", control: false, add: false });

    expect(await refusal(joinBy(late, link))).toBe("forbidden");
    expect(await joinBy(inside, link)).toEqual({ state: "joined" });
    expect(
      await refusal(
        shelf.host.signedIn.client.mutation(api.core.together.admit, {
          domain: "movies",
          userId: waiting.userId,
        }),
      ),
    ).toBe("forbidden");
    expect(await late.signedIn.client.query(api.core.together.get, { domain: "movies" })).toBe(
      null,
    );
  });

  it("refuses playback changes from a guest the host has not let control", async () => {
    if (stack === undefined) return;
    const { shelf, link } = await started(stack);
    const guest = await guestOf(stack, shelf, "guest");

    await joinBy(guest, link);

    expect(await refusal(controlAs(guest, { kind: "play" }))).toBe("forbidden");

    await configureAs(shelf.host, { join: "open", control: true, add: false });

    const playing = await controlAs(guest, { kind: "play" });

    expect(playing).toMatchObject({ status: "playing", revision: 1 });
    expect(await controlAs(shelf.host, { kind: "play" })).toEqual(playing);

    const seeked = await controlAs(guest, { kind: "seek", positionMs: 60_000, revision: 1 });

    expect(seeked).toMatchObject({ positionAtAnchorMs: 60_000, revision: 2 });
    expect(await refusal(controlAs(shelf.host, { kind: "seek", positionMs: 0, revision: 1 }))).toBe(
      "conflict",
    );
    expect((await joinedView(shelf.host, "movies")).clock).toEqual(seeked);

    const faster = await controlAs(guest, { kind: "rate", playbackRate: 1.5 });

    expect(faster).toMatchObject({ playbackRate: 1.5, revision: 3 });
    expect(faster.positionAtAnchorMs).toBeGreaterThanOrEqual(60_000);
    expect(await refusal(controlAs(guest, { kind: "rate", playbackRate: 3 }))).toBe("invalid_args");
  });

  it("applies a play or pause a client decided on its own only at the clock it saw", async () => {
    if (stack === undefined) return;
    const { shelf } = await started(stack);
    const { clock: opened } = await joinedView(shelf.host, "movies");
    const playing = await controlAs(shelf.host, { kind: "play", revision: opened.revision });

    expect(playing).toMatchObject({ status: "playing", revision: opened.revision + 1 });
    expect(await refusal(controlAs(shelf.host, { kind: "pause", revision: opened.revision }))).toBe(
      "conflict",
    );
    expect(await refusal(controlAs(shelf.host, { kind: "play", revision: opened.revision }))).toBe(
      "conflict",
    );
    expect((await joinedView(shelf.host, "movies")).clock).toEqual(playing);

    const held = await controlAs(shelf.host, { kind: "pause", revision: playing.revision });

    expect(held).toMatchObject({ status: "paused", revision: playing.revision + 1 });

    // A pause someone asks for carries no revision: it applies, and the hold's play is then stale.
    const paused = await controlAs(shelf.host, { kind: "pause" });

    expect(paused).toMatchObject({ status: "paused", revision: held.revision + 1 });
    expect(await refusal(controlAs(shelf.host, { kind: "play", revision: held.revision }))).toBe(
      "conflict",
    );
    expect((await joinedView(shelf.host, "movies")).clock).toEqual(paused);
  });

  it("never plays a stalled host's session on over a pause its clock has not shown yet", async () => {
    if (stack === undefined) return;
    const { shelf } = await started(stack);

    await controlAs(shelf.host, { kind: "play" });

    // The stall's own pause, which the follower holds the session at until its player recovers.
    const held = await controlAs(shelf.host, { kind: "pause" });
    let buffering = true;

    const player: FollowerPlayer = {
      positionMs: () => held.positionAtAnchorMs,
      isPaused: () => false,
      isBuffering: () => buffering,
      playbackRate: () => 1,
      setPlaybackRate: () => undefined,
      seek: () => undefined,
      play: () => Promise.resolve(),
      pause: () => undefined,
      subscribe: () => () => undefined,
    };

    const { intentional, after } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const following = yield* run({
            player,
            port: portOf(shelf.host),
            clock: held,
            durationMs: () => 3_600_000,
            controls: true,
            pausesForStalls: true,
            resumeHold: { kind: "held", revision: held.revision },
          });

          // Lucía pauses on her other screen, and this follower hears of it only after its player
          // recovered and its correction ticks asked to play the session on.
          const paused = yield* Effect.promise(() => controlAs(shelf.host, { kind: "pause" }));

          buffering = false;
          yield* Effect.sleep("2 seconds");
          yield* following.apply(paused);

          const { clock } = yield* Effect.promise(() => joinedView(shelf.host, "movies"));

          return { intentional: paused, after: clock };
        }),
      ),
    );

    expect(after).toMatchObject({ status: "paused", revision: intentional.revision });
  });

  it("plays a stalled host's session on when its new follower starts behind the hold's own seek", async () => {
    if (stack === undefined) return;
    const { shelf } = await started(stack);

    await controlAs(shelf.host, { kind: "play" });

    // The stall's pause and its seek back. The host's stream reloads before the subscription shows
    // the seek, so the new follower starts from the pause's clock, behind the hold's own.
    const pause = await controlAs(shelf.host, { kind: "pause" });

    const held = await controlAs(shelf.host, {
      kind: "seek",
      positionMs: 45_000,
      revision: pause.revision,
    });

    let buffering = true;
    let paused = false;

    const player: FollowerPlayer = {
      positionMs: () => 45_000,
      isPaused: () => paused,
      isBuffering: () => buffering && !paused,
      playbackRate: () => 1,
      setPlaybackRate: () => undefined,
      seek: () => undefined,
      play: () => {
        paused = false;

        return Promise.resolve();
      },
      pause: () => {
        paused = true;
      },
      subscribe: () => () => undefined,
    };

    const after = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const following = yield* run({
            player,
            port: portOf(shelf.host),
            clock: pause,
            durationMs: () => 3_600_000,
            controls: true,
            pausesForStalls: true,
            resumeHold: { kind: "held", revision: held.revision },
          });

          // The subscription catches up, and then the player recovers.
          yield* following.apply(held);
          buffering = false;
          yield* Effect.sleep("2 seconds");

          const { clock } = yield* Effect.promise(() => joinedView(shelf.host, "movies"));

          return clock;
        }),
      ),
    );

    expect(after).toMatchObject({ status: "playing", revision: held.revision + 1 });
  });

  it("refuses queued items from a guest the host has not let add", async () => {
    if (stack === undefined) return;
    const { shelf, link } = await started(stack);
    const guest = await guestOf(stack, shelf, "guest");

    const add = (who: Member, at: "next" | "end" = "end") =>
      who.signedIn.client.mutation(api.core.together.add, { item: shelf.pg, at });

    await joinBy(guest, link);

    expect(await refusal(add(guest))).toBe("forbidden");

    await configureAs(shelf.host, { join: "open", control: false, add: true });

    const { entryId: hosts } = await add(shelf.host);
    const { entryId: mine } = await add(guest, "next");

    const queued = await guest.signedIn.client.query(api.core.together.queue, {
      domain: "movies",
      paginationOpts: { numItems: 10, cursor: null },
    });

    // A movie carries no song details: only a music song does.
    expect(queued.page).toEqual([
      {
        entryId: mine,
        item: shelf.pg,
        track: null,
        addedBy: guest.username,
        addedByDisplayName: null,
        removable: true,
      },
      {
        entryId: hosts,
        item: shelf.pg,
        track: null,
        addedBy: shelf.host.username,
        addedByDisplayName: null,
        removable: false,
      },
    ]);

    const remove = (who: Member, entryId: typeof mine) =>
      who.signedIn.client.mutation(api.core.together.remove, { domain: "movies", entryId });

    expect(await refusal(remove(guest, hosts))).toBe("forbidden");
    expect(await remove(guest, mine)).toBe(null);
    expect(await remove(guest, mine)).toBe(null);

    const { revision } = (await joinedView(shelf.host, "movies")).clock;

    expect(await controlAs(shelf.host, { kind: "next", revision })).toMatchObject({
      revision: revision + 1,
      positionAtAnchorMs: 0,
    });
    expect((await joinedView(guest, "movies")).item).toEqual(shelf.pg);
    expect(await refusal(controlAs(shelf.host, { kind: "next", revision: revision + 1 }))).toBe(
      "conflict",
    );
  });

  it("queues what follows the item once from two of the host's screens, and not after it moved on", async () => {
    if (stack === undefined) return;
    const { shelf, link } = await started(stack, { add: true });
    const guest = await guestOf(stack, shelf, "guest");
    const otherScreen = new ConvexHttpClient(stack.url, { logger: false });

    otherScreen.setAuth(shelf.host.signedIn.token);
    await joinBy(guest, link);
    await guest.signedIn.client.mutation(api.core.together.add, { item: shelf.pg });

    const queued = async () =>
      (
        await shelf.host.signedIn.client.query(api.core.together.queue, {
          domain: "movies",
          paginationOpts: { numItems: 10, cursor: null },
        })
      ).page.map((entry) => entry.item);

    const { revision } = (await joinedView(shelf.host, "movies")).clock;
    const following = { item: shelf.pg, at: "next", revision } as const;

    await Promise.all([
      shelf.host.signedIn.client.mutation(api.core.together.add, following),
      otherScreen.mutation(api.core.together.add, following),
    ]);

    expect(await queued()).toEqual([shelf.pg]);

    await controlAs(shelf.host, { kind: "next", revision });

    expect((await joinedView(guest, "movies")).item).toEqual(shelf.pg);
    expect(await refusal(otherScreen.mutation(api.core.together.add, following))).toBe("conflict");
    expect(await queued()).toEqual([]);

    await shelf.host.signedIn.client.mutation(api.core.together.add, { item: shelf.g });

    const now = (await joinedView(guest, "movies")).clock.revision;

    expect(
      await refusal(
        guest.signedIn.client.mutation(api.core.together.add, {
          item: shelf.g,
          at: "next",
          revision: now,
        }),
      ),
    ).toBe("forbidden");
    expect(await queued()).toEqual([shelf.g]);
  });

  it("refuses an item from another domain, by its type and by its row's table", async () => {
    if (stack === undefined) return;
    const { shelf, link } = await started(stack, { add: true });

    const music = await shelf.host.signedIn.client.action(api.core.together.create, {
      item: shelf.track,
    });

    const crossed = {
      domain: "movies",
      ref: { type: "track", id: shelf.track.ref.id },
    };

    expect(
      await refusal(shelf.host.signedIn.client.mutation(untypedAdd, { item: crossed })),
    ).toMatch(/ArgumentValidationError/u);
    const misfiled = { domain: "movies", ref: { type: "title", id: shelf.track.ref.id } };

    expect(
      await refusal(shelf.host.signedIn.client.mutation(untypedAdd, { item: misfiled })),
    ).toMatch(/ArgumentValidationError/u);
    expect(await refusal(joinBy(shelf.host, music.link, "movies"))).toBe("invalid_args");
    expect(await refusal(joinBy(shelf.host, link, "music"))).toBe("invalid_args");
    expect((await joinedView(shelf.host, "music")).item).toEqual(shelf.track);
  });

  it("hides from a kid an item their restrictions hide, without hiding the session", async () => {
    if (stack === undefined) return;
    const { shelf, link } = await started(stack, { add: true });
    const kid = await kidOf(stack, shelf);

    await shelf.host.signedIn.client.mutation(api.core.together.add, { item: shelf.r });
    await joinBy(kid, link);

    expect((await joinedView(kid, "movies")).item).toEqual(shelf.g);

    const queued = await kid.signedIn.client.query(api.core.together.queue, {
      domain: "movies",
      paginationOpts: { numItems: 10, cursor: null },
    });

    expect(queued.page.map((entry) => entry.item)).toEqual([null]);
    expect(
      await refusal(kid.signedIn.client.mutation(api.core.together.add, { item: shelf.r })),
    ).toBe("not_found");

    const { revision } = (await joinedView(shelf.host, "movies")).clock;

    await controlAs(shelf.host, { kind: "next", revision });

    expect((await joinedView(kid, "movies")).item).toBe(null);
    expect((await joinedView(shelf.host, "movies")).item).toEqual(shelf.r);
  });

  it("ends the session for every member when its host leaves", async () => {
    if (stack === undefined) return;
    const { shelf, link } = await started(stack);
    const one = await guestOf(stack, shelf, "one");
    const two = await guestOf(stack, shelf, "two");

    await Promise.all([joinBy(one, link), joinBy(two, link)]);

    const watches = [shelf.host, one, two].map((who) => watch(stack, who, "movies"));

    try {
      await Promise.all(
        watches.map(async (seen) => seen.until((view) => view?.state === "joined")),
      );
      await shelf.host.signedIn.client.mutation(api.core.together.leave, { domain: "movies" });

      const ended = await Promise.all(
        watches.map(async (seen) => seen.until((view) => view?.state === "ended")),
      );

      expect(ended.map((view) => view?.state === "ended" && view.reason)).toEqual([
        "host-left",
        "host-left",
        "host-left",
      ]);
      expect(await refusal(controlAs(one, { kind: "play" }))).toBe("expired");
      expect(await refusal(joinBy(await guestOf(stack, shelf, "late"), link))).toBe("expired");

      const { serverTime } = await one.signedIn.client.mutation(api.core.together.heartbeat, {
        domain: "movies",
      });

      expect(serverTime).toBeGreaterThan(0);

      await one.signedIn.client.mutation(api.core.together.leave, { domain: "movies" });

      expect(await one.signedIn.client.query(api.core.together.get, { domain: "movies" })).toBe(
        null,
      );
    } finally {
      await Promise.all(watches.map(async (seen) => seen.close()));
    }
  });

  it("keeps one session per person and domain", async () => {
    if (stack === undefined) return;
    const first = await started(stack);
    const second = await started(stack);
    const guest = await guestOf(stack, first.shelf, "guest");

    await second.shelf.share(guest);
    await joinBy(guest, first.link);
    await joinBy(guest, second.link);

    expect(await memberNames(first.shelf.host)).not.toContain(guest.username);
    expect(await memberNames(second.shelf.host)).toContain(guest.username);
    expect(await refusal(joinBy(first.shelf.host, second.link))).toBe("conflict");

    const music = await first.shelf.host.signedIn.client.action(api.core.together.create, {
      item: first.shelf.track,
    });

    await joinBy(guest, music.link, "music");

    expect((await joinedView(guest, "movies")).sessionId).toBe(
      (await joinedView(second.shelf.host, "movies")).sessionId,
    );
    expect((await joinedView(guest, "music")).role).toBe("guest");
  });

  it("lets the host remove someone for good, or turn a request away", async () => {
    if (stack === undefined) return;
    const { shelf, link } = await started(stack);
    const rude = await guestOf(stack, shelf, "rude");
    const asking = await guestOf(stack, shelf, "asking");

    const block = (userId: Member["userId"]) =>
      shelf.host.signedIn.client.action(api.core.together.block, { domain: "movies", userId });

    await joinBy(rude, link);
    await block(rude.userId);

    expect(await rude.signedIn.client.query(api.core.together.get, { domain: "movies" })).toBe(
      null,
    );
    expect(await refusal(joinBy(rude, link))).toBe("forbidden");

    await configureAs(shelf.host, { join: "approval", control: false, add: false });
    await joinBy(asking, link);
    await block(asking.userId);

    expect((await joinedView(shelf.host, "movies")).pending).toEqual([]);
    expect(await refusal(joinBy(asking, link))).toBe("forbidden");
    expect(await refusal(block(shelf.host.userId))).toBe("invalid_args");
  });

  it("removes someone even when the session turned away all it can, and tells the host to lock it", async () => {
    if (stack === undefined) return;
    const { shelf, link } = await started(stack);
    const rude = await guestOf(stack, shelf, "rude");

    const block = (userId: Member["userId"]) =>
      shelf.host.signedIn.client.action(api.core.together.block, { domain: "movies", userId });

    await inOrder(plantedStrangers(BLOCKED_MAX), block);

    await joinBy(rude, link);

    const answer = await failureOf(block(rude.userId));

    expect(await rude.signedIn.client.query(api.core.together.get, { domain: "movies" })).toBe(
      null,
    );
    expect(await memberNames(shelf.host)).not.toContain(rude.person.username);
    expect(answer.code).toBe("conflict");
    expect(answer.message).toMatch(/lock/iu);
  });

  it("lets the host move any queued entry, and a guest who may add only their own", async () => {
    if (stack === undefined) return;
    const { shelf, link } = await started(stack, { add: true });
    const guest = await guestOf(stack, shelf, "guest");

    await joinBy(guest, link);

    const add = async (who: Member, item: typeof shelf.g): Promise<EntryId> =>
      (await who.signedIn.client.mutation(api.core.together.add, { item })).entryId;

    const hosts = await add(shelf.host, shelf.g);
    const mine = await add(guest, shelf.pg);
    const later = await add(shelf.host, shelf.r);

    expect(await refusal(reorderAs(guest, hosts, later))).toBe("forbidden");
    expect(await reorderAs(guest, mine)).toBe(null);
    expect(await queuedIds(guest)).toEqual([mine, hosts, later]);
    expect(await reorderAs(shelf.host, mine, later)).toBe(null);
    expect(await queuedIds(guest)).toEqual([hosts, later, mine]);
    expect(await reorderAs(shelf.host, later)).toBe(null);
    expect(await queuedIds(shelf.host)).toEqual([later, hosts, mine]);

    // Where it already stands, or after itself: nothing moves.
    expect(await reorderAs(shelf.host, hosts, later)).toBe(null);
    expect(await reorderAs(shelf.host, hosts, hosts)).toBe(null);
    expect(await queuedIds(shelf.host)).toEqual([later, hosts, mine]);

    // An entry gone is no change; an anchor gone asks for the queue as it stands now.
    await shelf.host.signedIn.client.mutation(api.core.together.remove, {
      domain: "movies",
      entryId: hosts,
    });
    expect(await reorderAs(guest, hosts)).toBe(null);
    expect(await refusal(reorderAs(guest, mine, hosts))).toBe("conflict");

    await configureAs(shelf.host, { join: "open", control: false, add: false });
    expect(await refusal(reorderAs(guest, mine))).toBe("forbidden");
  });

  it("keeps the queue in order through many moves into one gap", async () => {
    if (stack === undefined) return;
    const { shelf } = await started(stack);

    const add = async (item: typeof shelf.g): Promise<EntryId> =>
      (await shelf.host.signedIn.client.mutation(api.core.together.add, { item })).entryId;

    // Orders count up from 0, where halving a gap lasts a thousand moves; above 1, about fifty.
    const spacer = await add(shelf.g);
    const first = await add(shelf.g);
    const second = await add(shelf.pg);
    const third = await add(shelf.r);

    await shelf.host.signedIn.client.mutation(api.core.together.remove, {
      domain: "movies",
      entryId: spacer,
    });

    // Each move halves the gap after the first entry, until no number is left in it.
    await inOrder(
      Array.from({ length: 60 }, (_, at) => at),
      async (at) => {
        await reorderAs(shelf.host, at % 2 === 0 ? third : second, first);
      },
    );

    expect(await queuedIds(shelf.host)).toEqual([first, second, third]);
    expect(await reorderAs(shelf.host, third, first)).toBe(null);
    expect(await queuedIds(shelf.host)).toEqual([first, third, second]);
  });

  it("skips to a queued entry it names, keeps the ones before it queued, and names where the item came from", async () => {
    if (stack === undefined) return;
    const { shelf } = await started(stack);

    const add = async (item: typeof shelf.g): Promise<EntryId> =>
      (await shelf.host.signedIn.client.mutation(api.core.together.add, { item })).entryId;

    const before = await add(shelf.pg);
    const named = await add(shelf.r);

    expect((await joinedView(shelf.host, "movies")).entryId).toBe(null);

    const { revision } = (await joinedView(shelf.host, "movies")).clock;

    await controlAs(shelf.host, { kind: "next", revision, entryId: named });

    expect(await joinedView(shelf.host, "movies")).toMatchObject({
      item: shelf.r,
      entryId: named,
    });
    expect(await queuedIds(shelf.host)).toEqual([before]);
    expect(
      await refusal(
        controlAs(shelf.host, { kind: "next", revision: revision + 1, entryId: named }),
      ),
    ).toBe("conflict");

    await controlAs(shelf.host, { kind: "next", revision: revision + 1 });

    expect(await joinedView(shelf.host, "movies")).toMatchObject({
      item: shelf.pg,
      entryId: before,
    });
  });

  it("starts the next song as far in as the session played past the end of the one before", async () => {
    if (stack === undefined) return;
    const shelf = await catalog(stack);

    // The seeded song is a second long; the same song queued again is another entry.
    await shelf.host.signedIn.client.action(api.core.together.create, { item: shelf.track });

    const { entryId: again } = await shelf.host.signedIn.client.mutation(api.core.together.add, {
      item: shelf.track,
    });

    // Queued first well before the end, as every player would have it preloaded by then.
    await sleep(FIRST_BY_MS);

    const played = await controlAs(shelf.host, { kind: "play" }, "music");

    await sleep(1_600);

    const next = await controlAs(shelf.host, { kind: "next", revision: played.revision }, "music");

    expect(next.status).toBe("playing");
    expect(next.positionAtAnchorMs).toBeGreaterThan(300);
    expect(next.positionAtAnchorMs).toBeLessThan(1_500);
    expect(await joinedView(shelf.host, "music")).toMatchObject({
      item: shelf.track,
      entryId: again,
    });
  });

  it("starts an entry further down the queue from its start when a skip names it", async () => {
    if (stack === undefined) return;
    const shelf = await catalog(stack);

    await shelf.host.signedIn.client.action(api.core.together.create, { item: shelf.track });
    await shelf.host.signedIn.client.mutation(api.core.together.add, { item: shelf.track });

    const { entryId: later } = await shelf.host.signedIn.client.mutation(api.core.together.add, {
      item: shelf.track,
    });

    const played = await controlAs(shelf.host, { kind: "play" }, "music");

    await sleep(1_600);

    const next = await controlAs(
      shelf.host,
      { kind: "next", revision: played.revision, entryId: later },
      "music",
    );

    expect(next).toMatchObject({ status: "playing", positionAtAnchorMs: 0 });
    expect(await joinedView(shelf.host, "music")).toMatchObject({ entryId: later });
  });
});
