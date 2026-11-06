import { createHash, randomBytes } from "node:crypto";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import type { DomainItem } from "../../../commands/access";
import { api, internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { GUESTS_PER_LINK_MAX } from "../../../convex/core/guests/model";
import { inOrder } from "../../../convex/core/lib/inOrder";
import { MEMBERS_MAX, PRESENT_MS } from "../../../convex/core/together/model";
import { runFunction } from "../../admin";
import { member } from "../../devices";
import type { Member } from "../../devices";
import { GUEST_ADDRESS, guestsOn, makeLink, openLink } from "../../guests";
import { movie, openItem, seedLibrary, share, visibleItems, visibleLibraries } from "../../probe";
import type { Session } from "../../probe";
import { importRows, newestRows } from "../../rows";
import { refusal, unique } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";
import type { CoreStack } from "../../stack-env";

const stack = coreStackFromEnvFile();

const DAY_MS = 24 * 60 * 60 * 1000;

const Issued = Schema.Struct({ ticket: Schema.String, expiresAt: Schema.Finite });

const Status = Schema.Union([
  Schema.Struct({ state: Schema.Literal("live"), endsAt: Schema.Finite, guest: Schema.Boolean }),
  Schema.Struct({ state: Schema.Literal("ended") }),
]);

interface Shelf {
  readonly admin: Member;
  readonly libraryId: Id<"libraries">;
  readonly shared: DomainItem;
  readonly other: DomainItem;
}

const movieRef = (id: Id<"probeItems">): DomainItem => ({
  domain: "movies",
  ref: { type: "probeMovie", id },
});

const shelf = async (core: CoreStack): Promise<Shelf> => {
  await guestsOn(core);

  const admin = await member(core, "maker", "admin");

  const films = await seedLibrary(core, admin, {
    name: `films-${unique()}`,
    kind: "movies",
    items: [movie("shared.mkv", 0), movie("other.mkv", 0)],
  });

  const [shared, other] = films.itemIds;

  if (shared === undefined || other === undefined) throw new Error("seeded too few items");

  return { admin, libraryId: films.libraryId, shared: movieRef(shared), other: movieRef(other) };
};

const play = (core: CoreStack, who: Session, item: DomainItem) =>
  runFunction(core, internal.core.ticketsProbe.play, { sessionId: who.sessionId, item }, Issued);

const statusOf = (core: CoreStack, who: Session) =>
  runFunction(
    core,
    internal.core.tickets.sessionStatus,
    { userId: who.userId, sessionId: who.sessionId },
    Status,
  );

const currentOf = (who: Session) => who.signedIn.client.query(api.core.guests.current, {});

const revokeAs = (who: Member, linkId: Id<"shareLinks">) =>
  who.signedIn.client.mutation(api.core.guests.links.revoke, { linkId });

const configureAs = (who: Member, enabled: boolean) =>
  who.signedIn.client.mutation(api.core.guests.configure, { enabled, address: GUEST_ADDRESS });

const allowAs = (who: Member, userId: Id<"users">, allowed: boolean) =>
  who.signedIn.client.mutation(api.core.guests.allow, { userId, allowed });

const linkRowsOf = (linkId: Id<"shareLinks">) =>
  newestRows("shareLinks", 50).filter((line) => line.includes(linkId));

const LinkRow = Schema.fromJsonString(
  Schema.Struct({ _id: Schema.String, makerGeneration: Schema.Finite, switchEpoch: Schema.Finite }),
);

describe.skipIf(stack === undefined)("guest links", { timeout: 180_000 }, () => {
  it("lets a guest in under a display name to only what the link names, at the guest address", async () => {
    if (stack === undefined) return;
    const { admin, libraryId, shared, other } = await shelf(stack);
    const made = await makeLink(admin, { kind: "item", item: shared });

    expect(made.url.startsWith(`${GUEST_ADDRESS}/guest#mg_${made.linkId}.`)).toBe(true);
    expect(made.url).not.toContain("?");

    const guest = await openLink(stack, made.code, "  Sam  ");

    expect(await currentOf(guest)).toMatchObject({
      name: "Sam",
      sharedBy: admin.username,
      target: { kind: "item", item: shared },
    });

    const session = await guest.signedIn.client.query(api.core.auth.sessions.current, {});

    expect({ kind: session.kind, role: session.role, scopes: session.scopes }).toEqual({
      kind: "guest",
      role: "guest",
      scopes: ["movies:play", "music:play"],
    });

    expect((await play(stack, guest, shared)).ticket).toMatch(/^t1\./u);
    expect(await refusal(play(stack, guest, other))).toBe("not_found");
    expect(await statusOf(stack, guest)).toMatchObject({ state: "live", guest: true });
    expect(await statusOf(stack, admin)).toMatchObject({ state: "live", guest: false });

    expect(await visibleLibraries(guest)).toEqual([]);
    expect(await refusal(openItem(stack, guest, other.ref.id, "play"))).toBe("not_found");
    expect(await refusal(openItem(stack, guest, shared.ref.id, "view", "movies:read"))).toBe(
      "forbidden",
    );
    expect(await refusal(visibleItems(stack, guest, libraryId))).toBe("not_found");
    expect(await refusal(guest.signedIn.client.query(api.core.libraries.get, { libraryId }))).toBe(
      "not_found",
    );
    expect(await refusal(guest.signedIn.client.query(api.core.guests.status, {}))).toBe(
      "forbidden",
    );

    const users = await admin.signedIn.client.query(api.core.accounts.users.list, {
      paginationOpts: { numItems: 1000, cursor: null },
    });

    expect(users.page.some((user) => user.userId === guest.userId)).toBe(false);
  });

  it("refuses a guest a download", async () => {
    if (stack === undefined) return;
    const { admin, shared } = await shelf(stack);

    const guest = await openLink(
      stack,
      (await makeLink(admin, { kind: "item", item: shared })).code,
      "Sam",
    );

    const adding = guest.signedIn.client.mutation(api.core.downloads.add, {
      item: { kind: "probe", id: shared.ref.id },
    });

    await expect(adding).rejects.toThrow(/Guests cannot download/u);
  });

  it("makes no link while guest links are off, ends every guest, and revives nothing when turned on", async () => {
    if (stack === undefined) return;
    const { admin, shared } = await shelf(stack);
    const before = await makeLink(admin, { kind: "item", item: shared });
    const guest = await openLink(stack, before.code, "Sam");

    await configureAs(admin, false);

    try {
      expect(await refusal(makeLink(admin, { kind: "item", item: shared }))).toBe("forbidden");
      expect(await refusal(currentOf(guest))).toBe("unauthenticated");
      expect(await statusOf(stack, guest)).toEqual({ state: "ended" });
      expect(await refusal(openLink(stack, before.code, "Kai"))).toBe("expired");
      expect((await admin.signedIn.client.query(api.core.guests.status, {})).mayShare).toBe(false);
    } finally {
      await configureAs(admin, true);
    }

    expect(await refusal(openLink(stack, before.code, "Kai"))).toBe("expired");
    expect(await refusal(currentOf(guest))).toBe("unauthenticated");

    const after = await makeLink(admin, { kind: "item", item: shared });

    expect((await currentOf(await openLink(stack, after.code, "Kai")))?.name).toBe("Kai");
  });

  it("lets a member share only once an admin allows it, and stopping them ends their links for good", async () => {
    if (stack === undefined) return;
    const { admin, libraryId, shared } = await shelf(stack);
    const maya = await member(stack, "maya");

    await share(admin, libraryId, { kind: "user", userId: maya.userId }, "view");

    expect((await maya.signedIn.client.query(api.core.guests.status, {})).mayShare).toBe(false);
    expect(await refusal(makeLink(maya, { kind: "item", item: shared }))).toBe("forbidden");

    await allowAs(admin, maya.userId, true);

    const made = await makeLink(maya, { kind: "item", item: shared });
    const guest = await openLink(stack, made.code, "Sam");

    expect(await refusal(allowAs(admin, admin.userId, true))).toBe("forbidden");

    await allowAs(admin, maya.userId, false);

    expect(await refusal(maya.signedIn.client.query(api.core.guests.status, {}))).toBe(
      "unauthenticated",
    );
    expect(await refusal(currentOf(guest))).toBe("unauthenticated");
    expect(await refusal(openLink(stack, made.code, "Kai"))).toBe("expired");

    await allowAs(admin, maya.userId, true);

    expect(await refusal(openLink(stack, made.code, "Kai"))).toBe("expired");
  });

  it("ends a maker's links when the maker signs out everywhere", async () => {
    if (stack === undefined) return;
    const { admin, libraryId, shared } = await shelf(stack);
    const maya = await member(stack, "maya");

    await share(admin, libraryId, { kind: "user", userId: maya.userId }, "view");
    await allowAs(admin, maya.userId, true);

    const made = await makeLink(maya, { kind: "item", item: shared });

    await maya.signedIn.client.mutation(api.core.auth.sessions.endAll, { keepCurrent: false });

    expect(await refusal(openLink(stack, made.code, "Sam"))).toBe("expired");
  });

  it("opens a revoked link for no one and signs its guests out at once", async () => {
    if (stack === undefined) return;
    const { admin, libraryId, shared } = await shelf(stack);
    const maya = await member(stack, "maya");

    await share(admin, libraryId, { kind: "user", userId: maya.userId }, "view");
    await allowAs(admin, maya.userId, true);

    const mine = await makeLink(maya, { kind: "item", item: shared });
    const guest = await openLink(stack, mine.code, "Sam");
    const stranger = await member(stack, "stranger");

    expect(await refusal(revokeAs(stranger, mine.linkId))).toBe("not_found");

    await revokeAs(maya, mine.linkId);
    await revokeAs(maya, mine.linkId);

    expect(await refusal(openLink(stack, mine.code, "Kai"))).toBe("expired");
    expect(await refusal(currentOf(guest))).toBe("unauthenticated");
    expect(await statusOf(stack, guest)).toEqual({ state: "ended" });

    const theirs = await makeLink(maya, { kind: "item", item: shared });

    await revokeAs(admin, theirs.linkId);

    expect(await refusal(openLink(stack, theirs.code, "Kai"))).toBe("expired");
  });

  it("opens an expired link for no one, and makes links that last 7 days unless asked", async () => {
    if (stack === undefined) return;
    const { admin, shared } = await shelf(stack);
    const before = Date.now();
    const made = await makeLink(admin, { kind: "item", item: shared });

    const week = await admin.signedIn.client.query(api.core.guests.links.list, {
      whose: "mine",
      paginationOpts: { numItems: 5, cursor: null },
    });

    const listed = week.page.find((link) => link.linkId === made.linkId);

    expect(((listed?.expiresAt ?? 0) - before) / DAY_MS).toBeCloseTo(7, 2);
    expect(await refusal(makeLink(admin, { kind: "item", item: shared }, 31))).toBe("invalid_args");

    const [stored] = linkRowsOf(made.linkId).map((line) => Schema.decodeSync(LinkRow)(line));
    const secret = randomBytes(32).toString("base64url");

    if (stored === undefined) throw new Error("the link row was not found");

    importRows("shareLinks", [
      {
        secretHash: createHash("sha256").update(secret).digest("hex"),
        maker: admin.userId,
        makerGeneration: stored.makerGeneration,
        switchEpoch: stored.switchEpoch,
        target: { kind: "item", item: shared },
        expiresAt: Date.now() - 1000,
        revokedAt: null,
      },
    ]);

    const planted = newestRows("shareLinks", 50).find((line) =>
      line.includes(createHash("sha256").update(secret).digest("hex")),
    );

    const plantedId = planted === undefined ? "missing" : Schema.decodeSync(LinkRow)(planted)._id;

    expect(await refusal(openLink(stack, `mg_${plantedId}.${secret}`, "Sam"))).toBe("expired");
  });

  it("rate-limits a link to 30 guests an hour, counting only guests who got in", async () => {
    if (stack === undefined) return;
    const { admin, shared } = await shelf(stack);
    const made = await makeLink(admin, { kind: "item", item: shared });
    const wrong = `mg_${made.linkId}.${randomBytes(32).toString("base64url")}`;

    expect(await refusal(openLink(stack, wrong, "Mallory"))).toBe("expired");

    const answers = await inOrder(
      Array.from({ length: 31 }, (_, index) => `Guest ${index}`),
      async (name) => refusal(openLink(stack, made.code, name)),
    );

    expect(answers.filter((answer) => answer === "accepted")).toHaveLength(30);
    expect(answers.filter((answer) => answer === "rate_limited")).toHaveLength(1);
  });

  it("answers a full link's dead code like any other dead code", async () => {
    if (stack === undefined) return;
    const { admin, shared } = await shelf(stack);
    const made = await makeLink(admin, { kind: "item", item: shared });

    importRows(
      "users",
      Array.from({ length: GUESTS_PER_LINK_MAX }, (_, index) => ({
        kind: "person" as const,
        role: "guest" as const,
        username: `Planted ${index}`,
        usernameKey: `~${made.linkId}.${index + 1}`,
        link: made.linkId,
        sessionGeneration: 0,
        keyGeneration: 0,
      })),
    );

    expect(await refusal(openLink(stack, made.code, "Sam"))).toBe("conflict");

    await revokeAs(admin, made.linkId);

    expect(await refusal(openLink(stack, made.code, "Sam"))).toBe("expired");
  });

  it("shows a link's activity to its maker and admins, and what it names only to its maker", async () => {
    if (stack === undefined) return;
    const { admin, libraryId, shared } = await shelf(stack);
    const maya = await member(stack, "maya");

    await share(admin, libraryId, { kind: "user", userId: maya.userId }, "view");
    await allowAs(admin, maya.userId, true);

    const made = await makeLink(maya, { kind: "item", item: shared });

    await openLink(stack, made.code, "Sam");
    await openLink(stack, made.code, "Grandma Jo");

    const opens = await admin.signedIn.client.query(api.core.guests.links.activity, {
      linkId: made.linkId,
      paginationOpts: { numItems: 10, cursor: null },
    });

    expect(opens.page.map((open) => open.name)).toEqual(["Sam", "Grandma Jo"]);

    const everyone = await admin.signedIn.client.query(api.core.guests.links.list, {
      whose: "everyone",
      paginationOpts: { numItems: 50, cursor: null },
    });

    expect(everyone.page.find((link) => link.linkId === made.linkId)).toMatchObject({
      madeBy: maya.username,
      kind: "item",
      domain: "movies",
      target: null,
      state: "open",
    });

    const mine = await maya.signedIn.client.query(api.core.guests.links.list, {
      whose: "mine",
      paginationOpts: { numItems: 50, cursor: null },
    });

    expect(mine.page.find((link) => link.linkId === made.linkId)?.target).toEqual({
      kind: "item",
      item: shared,
    });

    const stranger = await member(stack, "stranger");

    expect(
      await refusal(
        stranger.signedIn.client.query(api.core.guests.links.activity, {
          linkId: made.linkId,
          paginationOpts: { numItems: 10, cursor: null },
        }),
      ),
    ).toBe("not_found");
    expect(
      await refusal(
        stranger.signedIn.client.query(api.core.guests.links.list, {
          whose: "everyone",
          paginationOpts: { numItems: 10, cursor: null },
        }),
      ),
    ).toBe("forbidden");
  });

  it("seats a session link's guests under the join setting, and revoking it takes them out", async () => {
    if (stack === undefined) return;
    const { admin: host, shared } = await shelf(stack);

    await host.signedIn.client.action(api.core.together.create, { item: shared });

    try {
      const made = await makeLink(host, { kind: "session", domain: "movies" });
      const guest = await openLink(stack, made.code, "Sam");
      const view = await guest.signedIn.client.query(api.core.together.get, { domain: "movies" });

      expect(view?.state).toBe("joined");

      if (view?.state !== "joined") return;

      expect(view.item).toEqual(shared);
      expect(view.members.find((row) => row.userId === guest.userId)).toMatchObject({
        username: "Sam",
        role: "guest",
        linkGuest: true,
      });
      expect(view.members.find((row) => row.userId === host.userId)?.linkGuest).toBe(false);
      expect((await play(stack, guest, shared)).ticket).toMatch(/^t1\./u);

      const pause = { domain: "movies", op: { kind: "pause" } } as const;

      expect(await refusal(guest.signedIn.client.mutation(api.core.together.control, pause))).toBe(
        "forbidden",
      );

      await host.signedIn.client.mutation(api.core.together.configure, {
        domain: "movies",
        join: "approval",
        control: true,
        add: true,
      });

      await guest.signedIn.client.mutation(api.core.together.control, pause);

      expect(
        await refusal(guest.signedIn.client.mutation(api.core.together.add, { item: shared })),
      ).toBe("forbidden");

      const waiting = await openLink(stack, made.code, "Kai");

      expect(
        (await waiting.signedIn.client.query(api.core.together.get, { domain: "movies" }))?.state,
      ).toBe("pending");

      await host.signedIn.client.mutation(api.core.together.configure, {
        domain: "movies",
        join: "locked",
        control: true,
        add: true,
      });

      expect(await refusal(openLink(stack, made.code, "Lee"))).toBe("forbidden");

      await revokeAs(host, made.linkId);

      const after = await host.signedIn.client.query(api.core.together.get, { domain: "movies" });

      expect(after?.state === "joined" ? after.members.map((row) => row.userId) : []).toEqual([
        host.userId,
      ]);
      expect(after?.state === "joined" ? after.pending : null).toEqual([]);
    } finally {
      await host.signedIn.client.mutation(api.core.together.leave, { domain: "movies" });
    }
  });

  it("frees a seat once its guest's link stops holding and the guest goes quiet", async () => {
    if (stack === undefined) return;
    const { admin: host, shared } = await shelf(stack);

    await host.signedIn.client.action(api.core.together.create, { item: shared });

    try {
      const made = await makeLink(host, { kind: "session", domain: "movies" });
      const guest = await openLink(stack, made.code, "Sam");

      await configureAs(host, false);
      await configureAs(host, true);
      await runFunction(
        stack,
        internal.core.together.presence.sweep,
        { asOf: Date.now() + PRESENT_MS + 1000 },
        Schema.Null,
      );

      const after = await host.signedIn.client.query(api.core.together.get, { domain: "movies" });

      expect(after?.state === "joined" ? after.members.map((row) => row.userId) : null).toEqual([
        host.userId,
      ]);
      expect(await refusal(currentOf(guest))).toBe("unauthenticated");
    } finally {
      await host.signedIn.client.mutation(api.core.together.leave, { domain: "movies" });
    }
  });

  it("keeps no seat for a guest who went quiet before their link stopped holding", async () => {
    if (stack === undefined) return;
    const { admin: host, shared } = await shelf(stack);

    await host.signedIn.client.action(api.core.together.create, { item: shared });

    try {
      const gone = await openLink(
        stack,
        (await makeLink(host, { kind: "session", domain: "movies" })).code,
        "Sam",
      );

      await runFunction(
        stack,
        internal.core.together.presence.sweep,
        { asOf: Date.now() + PRESENT_MS + 1000 },
        Schema.Null,
      );
      await configureAs(host, false);
      await configureAs(host, true);

      const even = await makeLink(host, { kind: "session", domain: "movies" });
      const odd = await makeLink(host, { kind: "session", domain: "movies" });

      const answers = await inOrder(
        Array.from({ length: MEMBERS_MAX }, (_, index) => index),
        async (index) =>
          refusal(openLink(stack, (index % 2 === 0 ? even : odd).code, `Guest ${index}`)),
      );

      expect(answers.filter((answer) => answer === "accepted")).toHaveLength(MEMBERS_MAX - 1);
      expect(answers.at(-1)).toBe("conflict");

      const after = await host.signedIn.client.query(api.core.together.get, { domain: "movies" });
      const seated = after?.state === "joined" ? after.members.map((row) => row.userId) : [];

      expect(seated).toHaveLength(MEMBERS_MAX);
      expect(seated).not.toContain(gone.userId);
    } finally {
      await host.signedIn.client.mutation(api.core.together.leave, { domain: "movies" });
    }
  });

  it("refuses a household person's join link to a guest", async () => {
    if (stack === undefined) return;
    const { admin, shared } = await shelf(stack);

    const guest = await openLink(
      stack,
      (await makeLink(admin, { kind: "item", item: shared })).code,
      "Sam",
    );

    const host = await member(stack, "host");

    const films = await seedLibrary(stack, host, {
      name: `own-${unique()}`,
      kind: "movies",
      items: [movie("own.mkv", 0)],
    });

    const [own] = films.itemIds;

    if (own === undefined) throw new Error("seeded no item");

    const { link } = await host.signedIn.client.action(api.core.together.create, {
      item: movieRef(own),
    });

    expect(
      await refusal(
        guest.signedIn.client.mutation(api.core.together.join, { domain: "movies", link }),
      ),
    ).toBe("forbidden");
  });
});
