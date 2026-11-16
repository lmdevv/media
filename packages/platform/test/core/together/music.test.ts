/**
 * The core's group sessions as the music clients run them (ADR 0017): a skip carries the clock
 * past a song's end only into the entry queued first well before that end, a write a client made
 * for one session never lands in another, and a host's player fills a new session's queue.
 */
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { DomainItem } from "../../../commands/access";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { inOrder } from "../../../convex/core/lib/inOrder";
import { CARRY_MAX_MS, FIRST_BY_MS } from "../../../convex/core/together/clock";
import type { Member } from "../../devices";
import { seedLibrary, share, song } from "../../probe";
import { importRows, newestRows } from "../../rows";
import { failureOf, refusal, unique } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";
import { catalog, guestOf, joinedView, kidOf, sleep } from "../../together";

const stack = coreStackFromEnvFile();

const MUSIC = "music" as const;

/** The catalog's song is a second long, as every seeded song is. */
const SONG_MS = 1_000;

type EntryId = FunctionArgs<typeof api.core.together.remove>["entryId"];

type SessionId = Id<"togetherSessions">;

type Op = FunctionArgs<typeof api.core.together.control>["op"];

type Clock = FunctionReturnType<typeof api.core.together.control>;

const musicTrack = (id: Id<"tracks">): DomainItem => ({
  domain: MUSIC,
  ref: { type: "track", id },
});

/** The song a catalog's music item names. */
const trackIdOf = (item: DomainItem): Id<"tracks"> => {
  if (item.ref.type !== "track") throw new Error("expected a song");

  return item.ref.id;
};

const SessionRow = Schema.fromJsonString(
  Schema.Struct({ _id: Schema.String, linkSecret: Schema.optional(Schema.String) }),
);

// SAFETY: a type predicate, not checked by the compiler. A Convex id is an opaque string, and the
// stack's export wrote this one as a `togetherSessions` id; the backend checks it again on use.
const isSessionId = (value: string): value is SessionId => value.length > 0;

/** The session row imported with the link secret `secret`, as a restore of old rows makes one. */
const sessionWithSecret = (secret: string): SessionId => {
  const found = newestRows("togetherSessions", 50)
    .map((line) => Schema.decodeSync(SessionRow)(line))
    .find((row) => row.linkSecret === secret);

  if (found === undefined || !isSessionId(found._id)) throw new Error("imported no session");

  return found._id;
};

const create = (who: Member, item: DomainItem) =>
  who.signedIn.client.action(api.core.together.create, { item });

const fillAs = (who: Member, sessionId: SessionId, items: ReadonlyArray<DomainItem>) =>
  who.signedIn.client.mutation(api.core.together.addItems, {
    domain: MUSIC,
    sessionId,
    items: [...items],
  });

/** Fills `who`'s session with `items`, a call's worth at a time, and answers how many calls it took. */
const fillAll = async (
  who: Member,
  sessionId: SessionId,
  items: ReadonlyArray<DomainItem>,
  calls = 0,
): Promise<number> => {
  if (items.length === 0) return calls;

  const { taken } = await fillAs(who, sessionId, items);

  return taken === 0 ? calls + 1 : fillAll(who, sessionId, items.slice(taken), calls + 1);
};

/** Lets the guests of `host`'s music session add songs. */
const letGuestsAdd = (host: Member) =>
  host.signedIn.client.mutation(api.core.together.configure, {
    domain: MUSIC,
    join: "open",
    control: false,
    add: true,
  });

const addAs = async (
  who: Member,
  item: DomainItem,
  at: "next" | "end" = "end",
  sessionId?: SessionId,
): Promise<EntryId> =>
  (
    await who.signedIn.client.mutation(
      api.core.together.add,
      sessionId === undefined ? { item, at } : { item, at, sessionId },
    )
  ).entryId;

const controlAs = (who: Member, op: Op, sessionId?: SessionId): Promise<Clock> =>
  who.signedIn.client.mutation(
    api.core.together.control,
    sessionId === undefined ? { domain: MUSIC, op } : { domain: MUSIC, op, sessionId },
  );

const removeAs = (who: Member, entryId: EntryId) =>
  who.signedIn.client.mutation(api.core.together.remove, { domain: MUSIC, entryId });

const reorderAs = (who: Member, entryId: EntryId, afterEntryId?: EntryId) =>
  who.signedIn.client.mutation(
    api.core.together.reorder,
    afterEntryId === undefined
      ? { domain: MUSIC, entryId }
      : { domain: MUSIC, entryId, afterEntryId },
  );

type QueueRow = FunctionReturnType<typeof api.core.together.queue>["page"][number];

/** Every entry of `who`'s music session's queue, page by page, in play order. */
const everyEntry = async (
  who: Member,
  cursor: string | null = null,
): Promise<ReadonlyArray<QueueRow>> => {
  const found = await who.signedIn.client.query(api.core.together.queue, {
    domain: MUSIC,
    paginationOpts: { numItems: 200, cursor },
  });

  return found.isDone
    ? found.page
    : [...found.page, ...(await everyEntry(who, found.continueCursor))];
};

/** Whether `who` may take out each entry of their music session's queue, in play order. */
const removable = async (who: Member): Promise<ReadonlyArray<boolean>> =>
  (await everyEntry(who)).map((row) => row.removable);

const queuedIds = async (who: Member): Promise<ReadonlyArray<EntryId>> =>
  (await everyEntry(who)).map((row) => row.entryId);

/** How far past the end of the playing song the clock stood when `next` moved it on. */
const pastTheEnd = (played: Clock, next: Clock): number =>
  next.anchorServerTime - played.anchorServerTime - SONG_MS;

/** Whether the core carries a skip `past` the end into a one-second song, as `carriedPast`. */
const carryFits = (past: number): boolean => past > 0 && past <= CARRY_MAX_MS && past < SONG_MS;

/** A change to the queue, made while the session is paused before its song plays, or past its end. */
type Change =
  | { readonly kind: "add"; readonly at: "next" | "end" }
  | { readonly kind: "remove"; readonly pick: number }
  | { readonly kind: "front"; readonly pick: number }
  | { readonly kind: "after"; readonly pick: number; readonly anchor: number };

const change: fc.Arbitrary<Change> = fc.oneof(
  fc.constantFrom("next" as const, "end" as const).map((at) => ({ kind: "add", at }) as const),
  fc.nat(4).map((pick) => ({ kind: "remove", pick }) as const),
  fc.nat(4).map((pick) => ({ kind: "front", pick }) as const),
  fc
    .record({ pick: fc.nat(4), anchor: fc.nat(4) })
    .map(({ pick, anchor }) => ({ kind: "after", pick, anchor }) as const),
);

/** The queue as the test expects the core to keep it, in play order. */
const moved = (order: ReadonlyArray<EntryId>, entry: EntryId, after?: EntryId) => {
  const rest = order.filter((queued) => queued !== entry);
  const at = after === undefined ? 0 : rest.indexOf(after) + 1;

  return [...rest.slice(0, at), entry, ...rest.slice(at)];
};

/** Makes `next` on the session's queue as `who`, and answers the queue the test expects after. */
const makeChange = async (
  who: Member,
  item: DomainItem,
  order: ReadonlyArray<EntryId>,
  next: Change,
): Promise<ReadonlyArray<EntryId>> => {
  const pick = (index: number): EntryId | undefined => order[index % Math.max(1, order.length)];

  if (next.kind === "add") {
    const entryId = await addAs(who, item, next.at);

    return next.at === "next" ? [entryId, ...order] : [...order, entryId];
  }

  const entry = pick(next.pick);

  if (entry === undefined) return order;

  if (next.kind === "remove") {
    await removeAs(who, entry);

    return order.filter((queued) => queued !== entry);
  }

  if (next.kind === "front") {
    await reorderAs(who, entry);

    return moved(order, entry);
  }

  const anchor = pick(next.anchor);

  if (anchor === undefined || anchor === entry) return order;

  await reorderAs(who, entry, anchor);

  return moved(order, entry, anchor);
};

describe.skipIf(stack === undefined)("music group sessions", { timeout: 120_000 }, () => {
  it("starts a song queued only after the session ran past its end from its start", async () => {
    if (stack === undefined) return;
    const shelf = await catalog(stack);

    // The reproduction: a song's clock runs past its end with nothing queued, a song is added,
    // and a skip moves on to it. No player preloaded that song at the end, so it starts at 0.
    await create(shelf.host, shelf.track);

    const played = await controlAs(shelf.host, { kind: "play" });

    await sleep(SONG_MS + 500);

    const added = await addAs(shelf.host, shelf.track);
    const next = await controlAs(shelf.host, { kind: "next", revision: played.revision });

    expect(pastTheEnd(played, next)).toBeGreaterThan(400);
    expect(next).toMatchObject({ status: "playing", positionAtAnchorMs: 0 });
    expect(await joinedView(shelf.host, MUSIC)).toMatchObject({ entryId: added });
  });

  it("starts what an add, a removal, or a move put first after the end from its start", async () => {
    if (stack === undefined) return;
    const shelf = await catalog(stack);

    /**
     * A session with two entries queued well before its song plays, so the first would carry,
     * played on to 100 ms past its song's end.
     */
    const playedOut = async () => {
      const host = await guestOf(stack, shelf, "host");

      await create(host, shelf.track);

      const [first, second] = await inOrder([0, 1], async () => addAs(host, shelf.track));

      await sleep(FIRST_BY_MS);

      const played = await controlAs(host, { kind: "play" });

      await sleep(SONG_MS + 100);

      return { host, first, second, played };
    };

    const removal = await playedOut();

    await removeAs(removal.host, removal.first ?? fail());
    expect(await controlAs(removal.host, { kind: "next", revision: 1 })).toMatchObject({
      positionAtAnchorMs: 0,
    });

    const move = await playedOut();

    await reorderAs(move.host, move.second ?? fail());
    expect(await controlAs(move.host, { kind: "next", revision: 1 })).toMatchObject({
      positionAtAnchorMs: 0,
    });

    // Moved behind the second and back in front: first again, but only since the end.
    const back = await playedOut();

    await reorderAs(back.host, back.first ?? fail(), back.second);
    await reorderAs(back.host, back.first ?? fail());
    expect(await controlAs(back.host, { kind: "next", revision: 1 })).toMatchObject({
      positionAtAnchorMs: 0,
    });

    const inFront = await playedOut();

    await addAs(inFront.host, shelf.track, "next");
    expect(await controlAs(inFront.host, { kind: "next", revision: 1 })).toMatchObject({
      positionAtAnchorMs: 0,
    });
  });

  it("carries a skip past the end into the entry queued first then, named or not, however late songs are added after it", async () => {
    if (stack === undefined) return;
    const shelf = await catalog(stack);

    const carried = async (named: boolean) => {
      const host = await guestOf(stack, shelf, "host");

      await create(host, shelf.track);

      const first = await addAs(host, shelf.track);

      // Queued first well before the end, as every player would have it preloaded by then.
      await sleep(FIRST_BY_MS);

      const played = await controlAs(host, { kind: "play" });

      await sleep(SONG_MS + 50);

      // Added behind it after the end: the entry queued first stays what it was.
      await addAs(host, shelf.track);

      const next = await controlAs(
        host,
        named
          ? { kind: "next", revision: played.revision, entryId: first }
          : { kind: "next", revision: played.revision },
      );

      return { past: pastTheEnd(played, next), next };
    };

    const skips = await inOrder([false, true], carried);

    for (const { past, next } of skips) {
      expect(next.positionAtAnchorMs).toBe(carryFits(past) ? past : 0);
    }
  });

  it("starts an entry put first in the last seconds before the end from its start", async () => {
    if (stack === undefined) return;
    const shelf = await catalog(stack);

    await create(shelf.host, shelf.track);
    await addAs(shelf.host, shelf.track);
    await sleep(FIRST_BY_MS);

    const played = await controlAs(shelf.host, { kind: "play" });

    // Half a second before the end, inside the time players take to preload a song.
    await sleep(SONG_MS / 2);

    const inFront = await addAs(shelf.host, shelf.track, "next");

    await sleep(SONG_MS / 2 + 100);

    const next = await controlAs(shelf.host, { kind: "next", revision: played.revision });

    expect(pastTheEnd(played, next)).toBeGreaterThan(0);
    expect(next).toMatchObject({ status: "playing", positionAtAnchorMs: 0 });
    expect(await joinedView(shelf.host, MUSIC)).toMatchObject({ entryId: inFront });
  });

  it("carries a skip past the end only into the entry queued first at the end, whatever changed the queue around it", async () => {
    if (stack === undefined) return;
    const shelf = await catalog(stack);

    const script = fc.record({
      before: fc.array(change, { maxLength: 4 }),
      after: fc.array(change, { maxLength: 2 }),
      named: fc.option(fc.nat(4), { nil: null }),
    });

    await fc.assert(
      fc.asyncProperty(script, async ({ before, after, named }) => {
        // A new host each run: a person starts at most 30 sessions an hour.
        const host = await guestOf(stack, shelf, "host");

        await create(host, shelf.track);

        const makeIt = (order: ReadonlyArray<EntryId>, next: Change) =>
          makeChange(host, shelf.track, order, next);

        // Changes while the session is paused at the song's start come well before its end.
        const atTheEnd = await before.reduce(
          async (order: Promise<ReadonlyArray<EntryId>>, next) => makeIt(await order, next),
          Promise.resolve<ReadonlyArray<EntryId>>([]),
        );

        await sleep(FIRST_BY_MS);

        const firstAtTheEnd = atTheEnd[0] ?? null;
        const played = await controlAs(host, { kind: "play" });

        await sleep(SONG_MS + 50);

        // Past the end: whether any change made another entry first, even for a moment.
        const { order, firstMoved } = await after.reduce(
          async (sofar, next) => {
            const { order: current, firstMoved: movedSoFar } = await sofar;
            const changed = await makeIt(current, next);

            return { order: changed, firstMoved: movedSoFar || changed[0] !== firstAtTheEnd };
          },
          Promise.resolve({ order: atTheEnd, firstMoved: false }),
        );

        expect(await queuedIds(host)).toEqual(order);

        const target = named === null ? order[0] : order[named % Math.max(1, order.length)];

        const op: Op =
          named === null || target === undefined
            ? { kind: "next", revision: played.revision }
            : { kind: "next", revision: played.revision, entryId: target };

        if (target === undefined) {
          expect(await refusal(controlAs(host, op))).toBe("conflict");

          return;
        }

        const next = await controlAs(host, op);
        const past = pastTheEnd(played, next);
        const carries = target === firstAtTheEnd && !firstMoved && carryFits(past);

        expect(next.positionAtAnchorMs).toBe(carries ? past : 0);
        expect(await joinedView(host, MUSIC)).toMatchObject({ entryId: target });
      }),
      { numRuns: 12 },
    );
  });

  it("refuses a write made for a session its maker left, and keeps it out of the one that replaced it", async () => {
    if (stack === undefined) return;
    const shelf = await catalog(stack);
    const guest = await guestOf(stack, shelf, "guest");
    const first = await create(shelf.host, shelf.track);

    await guest.signedIn.client.mutation(api.core.together.join, {
      domain: MUSIC,
      link: first.link,
    });

    // The host ends the first session and starts another; the guest joins that one.
    await shelf.host.signedIn.client.mutation(api.core.together.leave, { domain: MUSIC });

    const second = await create(shelf.host, shelf.track);

    await letGuestsAdd(shelf.host);

    // A session that ended with the guest still in it decides as ended, as before.
    expect(await refusal(addAs(guest, shelf.track, "end", first.sessionId))).toBe("expired");

    await guest.signedIn.client.mutation(api.core.together.join, {
      domain: MUSIC,
      link: second.link,
    });

    const left = await failureOf(addAs(shelf.host, shelf.track, "end", first.sessionId));

    expect(left).toMatchObject({ code: "conflict" });
    expect(left.message).toMatch(/no longer in that group session/u);
    expect(await refusal(addAs(guest, shelf.track, "next", first.sessionId))).toBe("conflict");
    expect(await refusal(fillAs(shelf.host, first.sessionId, [shelf.track]))).toBe("conflict");

    const late: ReadonlyArray<Op> = [
      { kind: "play" },
      { kind: "pause", revision: 0 },
      { kind: "seek", positionMs: 600, revision: 0 },
    ];

    const refused = await inOrder(late, async (op) =>
      refusal(controlAs(shelf.host, op, first.sessionId)),
    );

    expect(refused).toEqual(["conflict", "conflict", "conflict"]);

    expect(await queuedIds(shelf.host)).toEqual([]);
    expect((await joinedView(guest, MUSIC)).clock).toMatchObject({
      status: "paused",
      positionAtAnchorMs: 0,
      revision: 0,
    });

    // The same writes made for the session they are in apply.
    await addAs(guest, shelf.track, "end", second.sessionId);
    await controlAs(shelf.host, { kind: "play" }, second.sessionId);
    expect(await queuedIds(guest)).toHaveLength(1);
    expect((await joinedView(guest, MUSIC)).clock.status).toBe("playing");
  });

  it("fills a session's queue at its end, in order, over as many calls as it takes, leaving out what the caller may not play", async () => {
    if (stack === undefined) return;
    const shelf = await catalog(stack);
    const outsider = await catalog(stack);

    const pair = await seedLibrary(stack, shelf.host, {
      name: "Pair",
      kind: "music",
      items: [song("x", false), song("y", false)],
    });

    const [x, y] = pair.itemIds.map(musicTrack);

    if (x === undefined || y === undefined) throw new Error("seeded no pair");

    const { sessionId } = await create(shelf.host, shelf.track);
    const queued = await addAs(shelf.host, shelf.track);

    // More than one call decides for a person in no group: 196 items a call.
    const songs = Array.from({ length: 299 }, (_, at) => (at % 2 === 0 ? x : y));

    // One the host may not play, from a library no one shared with them, is left out.
    const items = [...songs.slice(0, 150), outsider.track, ...songs.slice(150)];

    expect(await fillAll(shelf.host, sessionId, items)).toBe(2);

    const listed = await everyEntry(shelf.host);

    expect(listed.map((row) => row.entryId)[0]).toBe(queued);
    expect(listed.slice(1).map((row) => row.item)).toEqual(songs);
    expect(new Set(listed.map((row) => row.addedBy))).toEqual(new Set([shelf.host.username]));

    // The queue holds 500 at most: a fill takes the rest of its room, then nothing.
    expect(
      await fillAll(
        shelf.host,
        sessionId,
        Array.from({ length: 250 }, () => x),
      ),
    ).toBe(3);
    expect(await everyEntry(shelf.host)).toHaveLength(500);
    expect(await fillAs(shelf.host, sessionId, [y])).toEqual({ taken: 0 });

    const tooMany = Array.from({ length: 501 }, () => x);

    expect(await refusal(fillAs(shelf.host, sessionId, tooMany))).toBe("invalid_args");
    expect(await refusal(fillAs(shelf.host, sessionId, [shelf.g]))).toBe("invalid_args");
  });

  it("shows each person by the name they go by, and their username without one", async () => {
    if (stack === undefined) return;
    const shelf = await catalog(stack);
    const guest = await guestOf(stack, shelf, "guest");

    await shelf.host.signedIn.client.mutation(api.core.accounts.me.setDisplayName, {
      displayName: "Lucía García",
    });

    const { link } = await create(shelf.host, shelf.track);

    await letGuestsAdd(shelf.host);
    await guest.signedIn.client.mutation(api.core.together.join, { domain: MUSIC, link });
    await addAs(shelf.host, shelf.track);
    await guest.signedIn.client.mutation(api.core.together.add, { item: shelf.track });

    expect(await joinedView(guest, MUSIC)).toMatchObject({
      host: shelf.host.username,
      hostDisplayName: "Lucía García",
      members: [
        { userId: shelf.host.userId, username: shelf.host.username, displayName: "Lucía García" },
        { userId: guest.userId, username: guest.username, displayName: null },
      ],
    });

    expect(
      (await everyEntry(guest)).map(({ addedBy, addedByDisplayName }) => ({
        addedBy,
        addedByDisplayName,
      })),
    ).toEqual([
      { addedBy: shelf.host.username, addedByDisplayName: "Lucía García" },
      { addedBy: guest.username, addedByDisplayName: null },
    ]);
  });

  it("carries each song's details on its queue page, and none for an entry the caller may not play", async () => {
    if (stack === undefined) return;
    const shelf = await catalog(stack);
    const kid = await kidOf(stack, shelf);

    const explicit = await seedLibrary(stack, shelf.host, {
      name: "Explicit",
      kind: "music",
      items: [song("explicit", true)],
    });

    await share(shelf.host, explicit.libraryId, { kind: "user", userId: kid.userId }, "view");

    const [dirtyId] = explicit.itemIds;

    if (dirtyId === undefined) throw new Error("seeded no explicit song");

    const cleanId = trackIdOf(shelf.track);
    const { link } = await create(shelf.host, shelf.track);

    await kid.signedIn.client.mutation(api.core.together.join, { domain: MUSIC, link });
    await addAs(shelf.host, shelf.track);
    await addAs(shelf.host, musicTrack(dirtyId));
    await kid.signedIn.client.mutation(api.music.likes.set, { trackId: cleanId, liked: true });

    const forHost = await everyEntry(shelf.host);
    const forKid = await everyEntry(kid);

    expect(forHost.map((row) => row.track?.id)).toEqual([cleanId, dirtyId]);
    expect(forHost[1]?.track).toEqual(
      await shelf.host.signedIn.client.query(api.music.tracks.get, { trackId: dirtyId }),
    );

    // The kid's own details: their like, and nothing at all of the explicit song.
    expect(forKid[0]?.track).toEqual(
      await kid.signedIn.client.query(api.music.tracks.get, { trackId: cleanId }),
    );
    expect(forKid[0]?.track?.liked).toBe(true);
    expect(forKid[1]).toMatchObject({ item: null, track: null });
  });

  it("decides who may take out an entry from the session's settings and its end", async () => {
    if (stack === undefined) return;
    const shelf = await catalog(stack);
    const guest = await guestOf(stack, shelf, "guest");
    const { link } = await create(shelf.host, shelf.track);

    await guest.signedIn.client.mutation(api.core.together.join, { domain: MUSIC, link });
    await letGuestsAdd(shelf.host);
    await addAs(shelf.host, shelf.track);
    await addAs(guest, shelf.track);

    expect(await removable(guest)).toEqual([false, true]);
    expect(await removable(shelf.host)).toEqual([true, true]);

    await shelf.host.signedIn.client.mutation(api.core.together.configure, {
      domain: MUSIC,
      join: "open",
      control: false,
      add: false,
    });

    expect(await removable(guest)).toEqual([false, false]);

    await letGuestsAdd(shelf.host);

    expect(await removable(guest)).toEqual([false, true]);

    // The host leaving ends the session: the guest still sees its queue, and takes nothing out.
    await shelf.host.signedIn.client.mutation(api.core.together.leave, { domain: MUSIC });

    expect(await removable(guest)).toEqual([false, false]);
  });

  it("lists the queue of a session from before its facts were kept, as before", async () => {
    if (stack === undefined) return;
    const shelf = await catalog(stack);
    const guest = await guestOf(stack, shelf, "guest");
    const secret = `before-${unique()}`;

    importRows("togetherSessions", [
      {
        hostId: shelf.host.userId,
        linkSecret: secret,
        settings: { join: "open", control: false, add: true },
        blocked: [],
        clock: {
          status: "paused",
          positionAtAnchorMs: 0,
          anchorServerTime: Date.now(),
          playbackRate: 1,
          revision: 0,
        },
        item: shelf.track,
        state: "live",
      },
    ]);

    const sessionId = sessionWithSecret(secret);

    importRows(
      "togetherMembers",
      [shelf.host, guest].map((who) => ({
        sessionId,
        userId: who.userId,
        domain: MUSIC,
        state: "joined" as const,
        awaySince: null,
      })),
    );

    importRows(
      "togetherEntries",
      [shelf.host, guest].map((who, order) => ({
        sessionId,
        order,
        item: shelf.track,
        addedBy: who.userId,
      })),
    );

    const listed = await everyEntry(guest);

    expect(listed.map((row) => [row.track?.id, row.removable])).toEqual([
      [trackIdOf(shelf.track), false],
      [trackIdOf(shelf.track), true],
    ]);

    await shelf.host.signedIn.client.mutation(api.core.together.configure, {
      domain: MUSIC,
      join: "open",
      control: false,
      add: false,
    });

    expect((await everyEntry(guest)).map((row) => row.removable)).toEqual([false, false]);
  });
});

/** A seeded entry that must exist. */
const fail = (): never => {
  throw new Error("expected a queued entry");
};
