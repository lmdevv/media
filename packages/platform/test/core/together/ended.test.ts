/**
 * The end of a song in a music group session, as the core decides it (ADR 0017): the host's player
 * says its engine finished the entry it played (`core.together.ended`), and the core moves on only
 * while it still plays that entry under that clock, once its own clock agrees, to what is queued
 * then. And playing a song now in one write bound to its session (`core.together.playNow`).
 */
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { describe, expect, it } from "vitest";

import type { DomainItem } from "../../../commands/access";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { ENDED_EARLY_MS, FIRST_BY_MS } from "../../../convex/core/together/clock";
import type { Member } from "../../devices";
import { seedLibrary, share, song } from "../../probe";
import { failureOf, refusal } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";
import { catalog, guestOf, joinedView, kidOf, sleep } from "../../together";

const stack = coreStackFromEnvFile();

const MUSIC = "music" as const;

/** Every seeded song is a second long. */
const SONG_MS = 1_000;

/** How long a seeded song plays at half speed. */
const SLOW_SONG_MS = SONG_MS / 0.5;

type SessionId = Id<"togetherSessions">;

type EntryId = FunctionArgs<typeof api.core.together.remove>["entryId"];

type Op = FunctionArgs<typeof api.core.together.control>["op"];

type Clock = FunctionReturnType<typeof api.core.together.control>;

const musicTrack = (id: Id<"tracks">): DomainItem => ({
  domain: MUSIC,
  ref: { type: "track", id },
});

const create = (who: Member, item: DomainItem) =>
  who.signedIn.client.action(api.core.together.create, { item });

const addAs = async (who: Member, item: DomainItem, at: "next" | "end" = "end"): Promise<EntryId> =>
  (await who.signedIn.client.mutation(api.core.together.add, { item, at })).entryId;

const controlAs = (who: Member, op: Op): Promise<Clock> =>
  who.signedIn.client.mutation(api.core.together.control, { domain: MUSIC, op });

const endedAs = (who: Member, sessionId: SessionId, entryId: EntryId | null, revision: number) =>
  who.signedIn.client.mutation(api.core.together.ended, {
    domain: MUSIC,
    sessionId,
    entryId,
    revision,
  });

const playNowAs = (who: Member, item: DomainItem, sessionId: SessionId) =>
  who.signedIn.client.mutation(api.core.together.playNow, { item, sessionId });

const configure = (host: Member, control: boolean, add: boolean) =>
  host.signedIn.client.mutation(api.core.together.configure, {
    domain: MUSIC,
    join: "open",
    control,
    add,
  });

const queuedIds = async (who: Member): Promise<ReadonlyArray<EntryId>> =>
  (
    await who.signedIn.client.query(api.core.together.queue, {
      domain: MUSIC,
      paginationOpts: { numItems: 200, cursor: null },
    })
  ).page.map((row) => row.entryId);

describe.skipIf(stack === undefined)("a music session's end", { timeout: 120_000 }, () => {
  it("moves on to what is queued when the host's player says the song ended past its end", async () => {
    if (stack === undefined) return;
    const shelf = await catalog(stack);
    const { sessionId } = await create(shelf.host, shelf.track);
    const next = await addAs(shelf.host, shelf.track);

    // Queued first well before the end, as every player would have it preloaded by then.
    await sleep(FIRST_BY_MS);

    const played = await controlAs(shelf.host, { kind: "play" });

    await sleep(SONG_MS + 100);

    const moved = await endedAs(shelf.host, sessionId, null, played.revision);
    const view = await joinedView(shelf.host, MUSIC);

    expect(moved).toMatchObject({ status: "playing", revision: played.revision + 1 });
    // As far in as the clock ran past the end, as each player that moved on by itself is.
    expect(moved.positionAtAnchorMs).toBeGreaterThan(50);
    expect(view).toMatchObject({ entryId: next, lengthMs: SONG_MS });
    expect(await queuedIds(shelf.host)).toEqual([]);
  });

  it("pauses back at the song's start when nothing is queued at the end", async () => {
    if (stack === undefined) return;
    const shelf = await catalog(stack);
    const { sessionId } = await create(shelf.host, shelf.track);
    const played = await controlAs(shelf.host, { kind: "play" });

    await sleep(SONG_MS + 100);

    const stopped = await endedAs(shelf.host, sessionId, null, played.revision);

    expect(stopped).toMatchObject({
      status: "paused",
      positionAtAnchorMs: 0,
      revision: played.revision + 1,
    });
    expect(await joinedView(shelf.host, MUSIC)).toMatchObject({ entryId: null, item: shelf.track });
  });

  it("refuses an end for an entry or a clock the session moved on from", async () => {
    if (stack === undefined) return;
    const shelf = await catalog(stack);
    const { sessionId } = await create(shelf.host, shelf.track);
    const queued = await addAs(shelf.host, shelf.track);
    const played = await controlAs(shelf.host, { kind: "play" });

    await sleep(SONG_MS + 100);

    // An entry the session does not play, under the clock it plays.
    const otherEntry = await failureOf(endedAs(shelf.host, sessionId, queued, played.revision));

    expect(otherEntry).toMatchObject({ code: "conflict" });
    expect(otherEntry.message).toMatch(/moved on/u);

    // Someone paused past the end since: the end said under the clock before is stale.
    const paused = await controlAs(shelf.host, { kind: "pause" });

    expect(await refusal(endedAs(shelf.host, sessionId, null, played.revision))).toBe("conflict");
    expect(await queuedIds(shelf.host)).toEqual([queued]);

    // Under the clock it now has, paused past the end, it moves on, still paused.
    expect(await endedAs(shelf.host, sessionId, null, paused.revision)).toMatchObject({
      status: "paused",
      positionAtAnchorMs: 0,
    });
    expect((await joinedView(shelf.host, MUSIC)).entryId).toBe(queued);

    // The session moved on: an end for the song before is stale too.
    expect(await refusal(endedAs(shelf.host, sessionId, null, paused.revision + 1))).toBe(
      "conflict",
    );
  });

  it("moves on to an entry added just before the end, deciding on the queue as it is at the end", async () => {
    if (stack === undefined) return;
    const shelf = await catalog(stack);
    const { sessionId } = await create(shelf.host, shelf.track);

    // At half speed the song lasts two seconds, so the end below comes a second early.
    await controlAs(shelf.host, { kind: "rate", playbackRate: 0.5 });

    const played = await controlAs(shelf.host, { kind: "play" });

    await sleep(SLOW_SONG_MS - 1_000);

    // The host's engine says the song ended a little early, inside the core's tolerance: the core
    // takes it and moves on itself once its clock reaches the end.
    expect(await endedAs(shelf.host, sessionId, null, played.revision)).toEqual(played);

    // Racing it, a song is added before that end.
    const added = await addAs(shelf.host, shelf.track);

    await sleep(1_500);

    const view = await joinedView(shelf.host, MUSIC);

    expect(view.entryId).toBe(added);
    expect(view.clock).toMatchObject({
      status: "playing",
      positionAtAnchorMs: 0,
      revision: played.revision + 1,
    });
    // Moved on at the end, not when the host said so.
    expect(view.clock.anchorServerTime - played.anchorServerTime).toBeGreaterThanOrEqual(
      SLOW_SONG_MS,
    );
  });

  it("moves nothing on at a scheduled end when the session moved since", async () => {
    if (stack === undefined) return;
    const shelf = await catalog(stack);
    const { sessionId } = await create(shelf.host, shelf.track);
    const queued = await addAs(shelf.host, shelf.track);

    await controlAs(shelf.host, { kind: "rate", playbackRate: 0.5 });

    const played = await controlAs(shelf.host, { kind: "play" });

    await sleep(SLOW_SONG_MS - 1_000);
    expect(await endedAs(shelf.host, sessionId, null, played.revision)).toEqual(played);

    // Someone seeks back before the end the core was to move on at.
    const sought = await controlAs(shelf.host, {
      kind: "seek",
      positionMs: 100,
      revision: played.revision,
    });

    await sleep(1_500);

    const view = await joinedView(shelf.host, MUSIC);

    expect(view.entryId).toBeNull();
    expect(view.clock.revision).toBe(sought.revision);
    expect(await queuedIds(shelf.host)).toEqual([queued]);
  });

  it("refuses an end its clock does not agree with: too early, or paused before the end", async () => {
    if (stack === undefined) return;
    const shelf = await catalog(stack);
    const { sessionId } = await create(shelf.host, shelf.track);

    // Paused at the start, the song has not ended.
    const notYet = await failureOf(endedAs(shelf.host, sessionId, null, 0));

    expect(notYet).toMatchObject({ code: "conflict" });
    expect(notYet.message).toMatch(/not ended/u);

    // At half speed the second-long song ends two seconds after it starts, more than
    // `ENDED_EARLY_MS` from now: an engine that ended now did not end where the session stands.
    await controlAs(shelf.host, { kind: "rate", playbackRate: 0.5 });

    const played = await controlAs(shelf.host, { kind: "play" });

    expect(SLOW_SONG_MS).toBeGreaterThan(ENDED_EARLY_MS);
    expect(await refusal(endedAs(shelf.host, sessionId, null, played.revision))).toBe("conflict");
    expect((await joinedView(shelf.host, MUSIC)).clock).toEqual(played);
  });

  it("lets only the host's player say a song ended, and only for the session it is in", async () => {
    if (stack === undefined) return;
    const shelf = await catalog(stack);
    const guest = await guestOf(stack, shelf, "guest");
    const first = await create(shelf.host, shelf.track);

    await guest.signedIn.client.mutation(api.core.together.join, {
      domain: MUSIC,
      link: first.link,
    });
    await configure(shelf.host, true, true);

    const played = await controlAs(shelf.host, { kind: "play" });

    await sleep(SONG_MS + 100);

    // A guest may control, yet their player never moves the session on.
    expect(await refusal(endedAs(guest, first.sessionId, null, played.revision))).toBe("forbidden");

    // The host ended that session and started another: an end for the first never lands.
    await shelf.host.signedIn.client.mutation(api.core.together.leave, { domain: MUSIC });

    const second = await create(shelf.host, shelf.track);

    expect(await refusal(endedAs(shelf.host, first.sessionId, null, played.revision))).toBe(
      "conflict",
    );
    expect((await joinedView(shelf.host, MUSIC)).sessionId).toBe(second.sessionId);
  });

  it("tells a kid host the length of a song hidden from them, and moves on at its end", async () => {
    if (stack === undefined) return;
    const shelf = await catalog(stack);
    const kid = await kidOf(stack, shelf);
    const adult = await guestOf(stack, shelf, "adult");

    const explicit = await seedLibrary(stack, shelf.host, {
      name: "Explicit",
      kind: "music",
      items: [song("explicit", true)],
    });

    await share(shelf.host, explicit.libraryId, { kind: "user", userId: adult.userId }, "view");

    const [dirtyId] = explicit.itemIds;

    if (dirtyId === undefined) throw new Error("seeded no explicit song");

    // The kid hosts; an adult who may add plays the explicit song now.
    const { sessionId, link } = await create(kid, shelf.track);

    await adult.signedIn.client.mutation(api.core.together.join, { domain: MUSIC, link });
    await kid.signedIn.client.mutation(api.core.together.configure, {
      domain: MUSIC,
      join: "open",
      control: true,
      add: true,
    });

    const after = await addAs(kid, shelf.track);
    const playing = await playNowAs(adult, musicTrack(dirtyId), sessionId);
    const forKid = await joinedView(kid, MUSIC);

    expect(forKid).toMatchObject({ item: null, lengthMs: SONG_MS });

    await sleep(SONG_MS + 100);

    // The kid's player has nothing to play, so its fallback says the song ended.
    await endedAs(kid, sessionId, forKid.entryId, playing.revision);
    expect((await joinedView(kid, MUSIC)).entryId).toBe(after);
  });
});

describe.skipIf(stack === undefined)(
  "playing a song now in a music session",
  { timeout: 120_000 },
  () => {
    it("plays it from its start for everyone in one write, leaving the queue as it was", async () => {
      if (stack === undefined) return;
      const shelf = await catalog(stack);
      const { sessionId } = await create(shelf.host, shelf.track);
      const queued = await addAs(shelf.host, shelf.track);

      const first = await playNowAs(shelf.host, shelf.track, sessionId);
      const firstView = await joinedView(shelf.host, MUSIC);

      expect(first).toMatchObject({ status: "playing", positionAtAnchorMs: 0, revision: 1 });
      expect(firstView).toMatchObject({ item: shelf.track, clock: first });
      expect(firstView.entryId).not.toBeNull();

      // The same song again is another play of it, which every player tells apart.
      const again = await playNowAs(shelf.host, shelf.track, sessionId);
      const againView = await joinedView(shelf.host, MUSIC);

      expect(again).toMatchObject({ status: "playing", positionAtAnchorMs: 0, revision: 2 });
      expect(againView.entryId).not.toBe(firstView.entryId);
      expect(await queuedIds(shelf.host)).toEqual([queued]);
    });

    it("needs control and adding, and never plays in a session its caller left", async () => {
      if (stack === undefined) return;
      const shelf = await catalog(stack);
      const guest = await guestOf(stack, shelf, "guest");
      const first = await create(shelf.host, shelf.track);

      await guest.signedIn.client.mutation(api.core.together.join, {
        domain: MUSIC,
        link: first.link,
      });

      expect(await refusal(playNowAs(guest, shelf.track, first.sessionId))).toBe("forbidden");

      await configure(shelf.host, true, false);

      const noAdds = await failureOf(playNowAs(guest, shelf.track, first.sessionId));

      expect(noAdds).toMatchObject({ code: "forbidden" });
      expect(noAdds.message).toMatch(/add/u);

      await configure(shelf.host, true, true);
      expect(await refusal(playNowAs(guest, shelf.track, first.sessionId))).toBe("accepted");

      // The guest leaves and starts a session of their own: a late play-now for the first never
      // lands in it.
      await guest.signedIn.client.mutation(api.core.together.leave, { domain: MUSIC });

      const own = await create(guest, shelf.track);

      expect(await refusal(playNowAs(guest, shelf.track, first.sessionId))).toBe("conflict");
      expect((await joinedView(guest, MUSIC)).clock).toMatchObject({
        status: "paused",
        revision: 0,
      });
      expect((await joinedView(guest, MUSIC)).sessionId).toBe(own.sessionId);
    });
  },
);
