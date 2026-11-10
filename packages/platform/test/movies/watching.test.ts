import { setTimeout as sleep } from "node:timers/promises";

import { beforeAll, describe, expect, it } from "vitest";

import type { TicketKeyRing } from "@media/contracts/ticket";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { Member } from "../devices";
import { guestOf } from "../guests";
import { sessionOf } from "../probe";
import type { Session } from "../probe";
import { runServer } from "../service";
import { refusal, signInAs } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";
import type { CoreStack } from "../stack-env";
import { deploymentTicketKeys } from "../ticket-keys";
import { Schema } from "effect";
import { fileIn, seasonOf, shelfOf, titleIn } from "./shelf";
import type { Shelf } from "./shelf";

const stack = coreStackFromEnvFile();

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

const SessionStatus = Schema.Union([
  Schema.Struct({ state: Schema.Literal("live"), endsAt: Schema.Finite, guest: Schema.Boolean }),
  Schema.Struct({ state: Schema.Literal("ended") }),
]);

const admittedFor = async (
  core: CoreStack,
  ring: TicketKeyRing,
  ticket: string,
  fileId: Id<"mediaFiles">,
) => {
  const answer = await ring.admit(
    {
      ticket,
      route: { purposes: ["play"], resource: { kind: "file", id: fileId } },
      readSession: async ({ userId, sessionId }) => {
        const status = await runServer(
          core,
          api.core.tickets.sessionStatus,
          { userId, sessionId },
          SessionStatus,
        );

        return status.state === "live" ? "live" : "ended";
      },
    },
    Date.now(),
  );

  if (!answer.ok) throw new Error(`Ticket refused: ${answer.error.reason}`);

  return answer.value.claims;
};

const listOf = async (who: Member): Promise<ReadonlyArray<Id<"titles">>> =>
  (
    await who.signedIn.client.query(api.movies.myList.list, {
      paginationOpts: { numItems: 50, cursor: null },
    })
  ).page.map((title) => title.id);

const anotherSession = async (core: CoreStack, who: Member): Promise<Session> =>
  sessionOf(await signInAs(core, who.person));

describe.skipIf(stack === undefined)("movies watching commands", { timeout: 180_000 }, () => {
  let shelf: Shelf;

  beforeAll(async () => {
    if (stack === undefined) return;

    shelf = await shelfOf(stack, `watch-${Math.random().toString(36).slice(2, 8)}`);
  }, 180_000);

  it("start a title with a personal ticket for its file that names the session", async () => {
    if (stack === undefined) return;

    const ring = await deploymentTicketKeys();
    const sintel = titleIn(shelf, "Sintel");
    const before = Date.now();

    const started = await shelf.aiko.signedIn.client.mutation(api.movies.play.start, {
      titleId: sintel,
    });

    expect(started).toMatchObject({
      titleId: sintel,
      episodeId: null,
      episode: null,
      resumePositionMs: 0,
      file: { id: fileIn(shelf, "Sintel") },
    });
    expect(started.expiresAt).toBeLessThanOrEqual(before + SIX_HOURS_MS + 1000);
    expect(await admittedFor(stack, ring, started.ticket, fileIn(shelf, "Sintel"))).toMatchObject({
      kind: "personal",
      principal: { userId: shelf.aiko.userId, sessionId: shelf.aiko.sessionId },
      purpose: "play",
    });

    const pioneer = titleIn(shelf, "Pioneer One");

    const [, secondEpisode] = await seasonOf(shelf.aiko.signedIn.client, pioneer, 1);

    if (secondEpisode === undefined) throw new Error("Pioneer One has no second episode");

    const episode = await shelf.aiko.signedIn.client.mutation(api.movies.play.start, {
      titleId: pioneer,
      episodeId: secondEpisode.id,
    });

    expect(episode.file.id).toBe(fileIn(shelf, "Pioneer One", 1));
    expect(
      await refusal(
        shelf.aiko.signedIn.client.mutation(api.movies.play.start, {
          titleId: sintel,
          fileId: fileIn(shelf, "Big Buck Bunny"),
        }),
      ),
    ).toBe("not_found");
    expect(
      await refusal(shelf.sam.signedIn.client.mutation(api.movies.play.start, { titleId: sintel })),
    ).toBe("not_found");
  });

  it("let a link guest start the title the link names and nothing else", async () => {
    if (stack === undefined) return;

    const guest = await guestOf(stack, shelf.owner, {
      domain: "movies",
      ref: { type: "title", id: titleIn(shelf, "Sintel") },
    });

    const ring = await deploymentTicketKeys();

    const started = await guest.signedIn.client.mutation(api.movies.play.start, {
      titleId: titleIn(shelf, "Sintel"),
    });

    expect(await admittedFor(stack, ring, started.ticket, fileIn(shelf, "Sintel"))).toMatchObject({
      principal: { userId: guest.userId, sessionId: guest.sessionId },
    });
    expect(
      await runServer(
        stack,
        api.core.tickets.sessionStatus,
        { userId: guest.userId, sessionId: guest.sessionId },
        SessionStatus,
      ),
    ).toMatchObject({ state: "live", guest: true });
    expect(
      await refusal(
        guest.signedIn.client.mutation(api.movies.play.start, {
          titleId: titleIn(shelf, "Big Buck Bunny"),
        }),
      ),
    ).toBe("not_found");
    expect(
      await refusal(
        guest.signedIn.client.query(api.movies.titles.get, { titleId: titleIn(shelf, "Sintel") }),
      ),
    ).toBe("forbidden");
  });

  it("carry progress from one session to the next, and ignore an older start", async () => {
    if (stack === undefined) return;

    const tears = titleIn(shelf, "Tears of Steel");
    const fileId = fileIn(shelf, "Tears of Steel");
    const first = shelf.aiko.signedIn.client;
    const second = (await anotherSession(stack, shelf.aiko)).signedIn.client;

    const opened = await first.mutation(api.movies.play.start, { titleId: tears });

    expect(
      await first.mutation(api.movies.play.report, {
        fileId,
        positionMs: 60_000,
        durationMs: 600_000,
        event: "pause",
        startedAt: opened.startedAt,
        playbackId: opened.playbackId,
      }),
    ).toEqual({ applied: true, watched: false });

    const resumed = await second.query(api.movies.history.continueWatching, {});

    expect(resumed.find((item) => item.title.id === tears)).toMatchObject({
      reason: "resume",
      progress: { positionMs: 60_000, durationMs: 600_000 },
    });

    const reopened = await second.mutation(api.movies.play.start, { titleId: tears });

    expect(reopened.resumePositionMs).toBe(60_000);

    await second.mutation(api.movies.play.report, {
      fileId,
      positionMs: 120_000,
      durationMs: 600_000,
      event: "tick",
      startedAt: reopened.startedAt,
      playbackId: reopened.playbackId,
    });

    expect(
      await first.mutation(api.movies.play.report, {
        fileId,
        positionMs: 70_000,
        durationMs: 600_000,
        event: "tick",
        startedAt: opened.startedAt,
        playbackId: opened.playbackId,
      }),
    ).toEqual({ applied: false, watched: false });

    expect(
      await first.mutation(api.movies.play.reportOffline, {
        fileId,
        positionMs: 10_000,
        durationMs: 600_000,
        playedAt: Date.now() - 3_600_000,
        sentAt: Date.now(),
      }),
    ).toEqual({ applied: false, watched: false });
    expect(
      await second.mutation(api.movies.play.report, {
        fileId,
        positionMs: 590_000,
        durationMs: 600_000,
        event: "ended",
        startedAt: reopened.startedAt,
        playbackId: reopened.playbackId,
      }),
    ).toEqual({ applied: true, watched: true });
    expect(
      (await first.query(api.movies.history.continueWatching, {})).map((item) => item.title.id),
    ).not.toContain(tears);
    expect(
      await refusal(
        first.mutation(api.movies.play.report, {
          fileId,
          positionMs: 1,
          event: "tick",
          startedAt: -1,
          playbackId: crypto.randomUUID(),
        }),
      ),
    ).toBe("invalid_args");
    expect(
      await refusal(
        shelf.sam.signedIn.client.mutation(api.movies.play.report, {
          fileId,
          positionMs: 1,
          event: "tick",
          startedAt: Date.now(),
          playbackId: crypto.randomUUID(),
        }),
      ),
    ).toBe("not_found");
  });

  it("ignore a report from an older start of the same session", async () => {
    const unrated = titleIn(shelf, "Unrated Short");
    const fileId = fileIn(shelf, "Unrated Short");
    const client = shelf.owner.signedIn.client;

    const report = (
      start: { readonly playbackId: string; readonly startedAt: number },
      positionMs: number,
    ) =>
      client.mutation(api.movies.play.report, {
        fileId,
        positionMs,
        durationMs: 600_000,
        event: "tick",
        playbackId: start.playbackId,
        startedAt: start.startedAt,
      });

    const older = await client.mutation(api.movies.play.start, { titleId: unrated });

    // Two plays of one title start at different times; a millisecond apart is enough.
    await sleep(5);

    const newer = await client.mutation(api.movies.play.start, { titleId: unrated });

    expect(newer.playbackId).not.toBe(older.playbackId);
    expect(newer.startedAt).toBeGreaterThan(older.startedAt);
    expect(await report(newer, 40_000)).toEqual({ applied: true, watched: false });
    expect(await report(older, 10_000)).toEqual({ applied: false, watched: false });
    expect(
      (await client.mutation(api.movies.play.start, { titleId: unrated })).resumePositionMs,
    ).toBe(40_000);
  });

  it("keep each person's list their own", async () => {
    const sintel = titleIn(shelf, "Sintel");

    await shelf.aiko.signedIn.client.mutation(api.movies.myList.add, { titleId: sintel });
    await shelf.aiko.signedIn.client.mutation(api.movies.myList.add, { titleId: sintel });

    expect(await listOf(shelf.aiko)).toEqual([sintel]);
    expect(await listOf(shelf.mateo)).toEqual([]);
    expect(
      (await shelf.aiko.signedIn.client.query(api.movies.titles.get, { titleId: sintel })).inMyList,
    ).toBe(true);
    expect(
      (await shelf.aiko.signedIn.client.query(api.movies.titles.home, {})).myList.map((t) => t.id),
    ).toEqual([sintel]);

    await shelf.aiko.signedIn.client.mutation(api.movies.myList.remove, { titleId: sintel });

    expect(await listOf(shelf.aiko)).toEqual([]);
  });

  it("mark a whole show watched and unwatched, and page the history", async () => {
    const pioneer = titleIn(shelf, "Pioneer One");
    const client = shelf.mateo.signedIn.client;

    const watchedFlags = async () =>
      (await seasonOf(client, pioneer, 1)).map((episode) => episode.progress?.watched ?? false);

    await client.mutation(api.movies.history.markWatched, { titleId: pioneer });

    expect(await watchedFlags()).toEqual([true, true, true]);
    expect(
      (await client.query(api.movies.titles.get, { titleId: pioneer })).nextEpisode,
    ).toBeNull();

    const pageOne = await client.query(api.movies.history.list, {
      paginationOpts: { numItems: 2, cursor: null },
    });

    const pageTwo = await client.query(api.movies.history.list, {
      paginationOpts: { numItems: 2, cursor: pageOne.continueCursor },
    });

    expect(
      [...pageOne.page, ...pageTwo.page]
        .map((entry) => entry.episode?.episodeNumber ?? 0)
        .toSorted((left, right) => left - right),
    ).toEqual([1, 2, 3]);

    await client.mutation(api.movies.history.markUnwatched, { titleId: pioneer });

    expect(await watchedFlags()).toEqual([false, false, false]);
    expect(
      (await seasonOf(shelf.aiko.signedIn.client, pioneer, 1)).every(
        (episode) => episode.progress === null,
      ),
    ).toBe(true);
  });
});
