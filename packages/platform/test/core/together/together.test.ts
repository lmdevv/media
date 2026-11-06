import { makeFunctionReference } from "convex/server";
import type { FunctionArgs } from "convex/server";
import { ConvexError } from "convex/values";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import type { ContentDomain } from "../../../commands/scopes";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { inOrder } from "../../../convex/core/lib/inOrder";
import { BLOCKED_MAX } from "../../../convex/core/together/model";
import { member } from "../../devices";
import type { Member } from "../../devices";
import { importRows, newestRows } from "../../rows";
import { refusal, unique } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";
import type { CoreStack } from "../../stack-env";
import { catalog, guestOf, joinedView, kidOf, watch } from "../../together";
import type { Catalog } from "../../together";

const stack = coreStackFromEnvFile();

type Settings = Omit<FunctionArgs<typeof api.core.together.create>, "item">;

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

const controlAs = (who: Member, op: Op) =>
  who.signedIn.client.mutation(api.core.together.control, { domain: "movies", op });

const memberNames = async (who: Member): Promise<ReadonlyArray<string>> =>
  (await joinedView(who, "movies")).members.map((row) => row.username);

const configureAs = (who: Member, settings: Required<Settings>) =>
  who.signedIn.client.mutation(api.core.together.configure, { domain: "movies", ...settings });

const ServiceRow = Schema.fromJsonString(
  Schema.Struct({ _id: Schema.String, name: Schema.optional(Schema.String) }),
);

// SAFETY: a type predicate, not checked by the compiler. A Convex id is an opaque string, and the
// stack's export wrote this one as a `users` id; the backend checks it again when a call names it.
const isUserId = (value: string): value is Id<"users"> => value.length > 0;

/** `count` new users no session has seen, planted as service rows so none needs a password. */
const plantedStrangers = (count: number): ReadonlyArray<Id<"users">> => {
  const prefix = `stranger-${unique()}-`;

  importRows(
    "users",
    Array.from({ length: count }, (_, index) => ({
      kind: "service" as const,
      name: `${prefix}${index}`,
      sessionGeneration: 0,
      keyGeneration: 0,
    })),
  );

  const ids = newestRows("users", count + 100)
    .map((line) => Schema.decodeSync(ServiceRow)(line))
    .flatMap((row) =>
      row.name?.startsWith(prefix) === true && isUserId(row._id) ? [row._id] : [],
    );

  if (ids.length !== count) throw new Error(`planted ${ids.length} of ${count} strangers`);

  return ids;
};

const ErrorData = Schema.Struct({ code: Schema.String, message: Schema.String });

/** The code and message a call was refused with; fails the test when it was not refused. */
const failureOf = async (
  call: Promise<unknown>,
): Promise<{ readonly code: string; readonly message: string }> => {
  try {
    await call;
  } catch (cause) {
    if (cause instanceof ConvexError) return Schema.decodeUnknownSync(ErrorData)(cause.data);

    throw cause;
  }

  throw new Error("the call was not refused");
};

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
        { userId: guest.userId, username: guest.username, present: true },
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

    expect(queued.page).toEqual([
      { entryId: mine, item: shelf.pg, addedBy: guest.username, removable: true },
      { entryId: hosts, item: shelf.pg, addedBy: shelf.host.username, removable: false },
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

  it("refuses an item from another domain, by its type and by its row", async () => {
    if (stack === undefined) return;
    const { shelf, link } = await started(stack, { add: true });

    const music = await shelf.host.signedIn.client.action(api.core.together.create, {
      item: shelf.track,
    });

    const crossed = {
      domain: "movies",
      ref: { type: "probeTrack", id: shelf.track.ref.id },
    };

    expect(
      await refusal(shelf.host.signedIn.client.mutation(untypedAdd, { item: crossed })),
    ).toMatch(/ArgumentValidationError/u);
    expect(
      await refusal(
        shelf.host.signedIn.client.mutation(api.core.together.add, { item: shelf.misfiled }),
      ),
    ).toBe("not_found");
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
});
