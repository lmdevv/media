import { describe, expect, it } from "vitest";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { inOrder } from "../../../convex/core/lib/inOrder";
import {
  movie,
  seedLibraries,
  seedLibrary,
  sessionOf,
  share,
  unshare,
  visibleLibraries,
} from "../../probe";
import type { Session } from "../../probe";
import { createPerson, refusal, signIn, signInAs, unique } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";
import type { CoreStack } from "../../stack-env";

const stack = coreStackFromEnvFile();

const signInSession = async (
  core: CoreStack,
  label = "person",
  role: "admin" | "member" = "member",
) => sessionOf(await signInAs(core, await createPerson(core, label, role)));

const seedOne = async (core: CoreStack, manager: Session, name: string) =>
  (await seedLibrary(core, manager, { name, kind: "movies", items: [movie(`${name}-film`, 0)] }))
    .libraryId;

const lookUp = (session: Session, libraryId: Id<"libraries">) =>
  session.signedIn.client.query(api.core.libraries.get, { libraryId });

const sees = async (session: Session, libraryId: Id<"libraries">) => ({
  open: await refusal(lookUp(session, libraryId)),
  listed: (await visibleLibraries(session)).includes(libraryId),
});

describe.skipIf(stack === undefined)("grants", { timeout: 120_000 }, () => {
  it("reach a group's members, and stop at once when one leaves the group", async () => {
    if (stack === undefined) return;
    const admin = await signInSession(stack, "admin", "admin");
    const manager = await signInSession(stack, "manager");
    const member = await signInSession(stack, "member");
    const libraryId = await seedOne(stack, manager, "group-shared");

    const { groupId } = await admin.signedIn.client.mutation(api.core.permissions.groups.create, {
      name: `family-${unique()}`,
    });

    await admin.signedIn.client.mutation(api.core.permissions.groups.addMember, {
      groupId,
      userId: member.userId,
    });
    await admin.signedIn.client.mutation(api.core.permissions.groups.addMember, {
      groupId,
      userId: member.userId,
    });

    expect(await sees(member, libraryId)).toEqual({ open: "not_found", listed: false });

    await share(manager, libraryId, { kind: "group", groupId }, "view");

    expect(await sees(member, libraryId)).toEqual({ open: "accepted", listed: true });
    expect(
      (
        await admin.signedIn.client.query(api.core.permissions.groups.members, {
          groupId,
          paginationOpts: { numItems: 10, cursor: null },
        })
      ).page.map((row) => row.userId),
    ).toEqual([member.userId]);

    await admin.signedIn.client.mutation(api.core.permissions.groups.removeMember, {
      groupId,
      userId: member.userId,
    });

    expect(await sees(member, libraryId)).toEqual({ open: "not_found", listed: false });
  });

  it("stop reaching anyone when their group is removed", async () => {
    if (stack === undefined) return;
    const admin = await signInSession(stack, "admin", "admin");
    const manager = await signInSession(stack, "manager");
    const member = await signInSession(stack, "member");
    const libraryId = await seedOne(stack, manager, "group-removed");

    const { groupId } = await admin.signedIn.client.mutation(api.core.permissions.groups.create, {
      name: `club-${unique()}`,
    });

    await admin.signedIn.client.mutation(api.core.permissions.groups.addMember, {
      groupId,
      userId: member.userId,
    });
    await share(manager, libraryId, { kind: "group", groupId }, "edit");

    expect((await lookUp(member, libraryId)).level).toBe("edit");

    await admin.signedIn.client.mutation(api.core.permissions.groups.remove, { groupId });

    expect(await sees(member, libraryId)).toEqual({ open: "not_found", listed: false });
    expect(await refusal(share(manager, libraryId, { kind: "group", groupId }, "view"))).toBe(
      "not_found",
    );
  });

  it("reach every person through the household", async () => {
    if (stack === undefined) return;
    const manager = await signInSession(stack, "manager");
    const libraryId = await seedOne(stack, manager, "household-shared");

    await share(manager, libraryId, { kind: "household" }, "view");

    const newcomer = await signInSession(stack, "newcomer");

    expect(await sees(newcomer, libraryId)).toEqual({ open: "accepted", listed: true });
    expect(
      await refusal(share(newcomer, libraryId, { kind: "user", userId: newcomer.userId }, "edit")),
    ).toBe("forbidden");
  });

  it("keep a private library hidden from admins, in lookups and lists", async () => {
    if (stack === undefined) return;
    const admin = await signInSession(stack, "admin", "admin");
    const manager = await signInSession(stack, "manager");
    const libraryId = await seedOne(stack, manager, "private");

    expect(await sees(admin, libraryId)).toEqual({ open: "not_found", listed: false });
    expect(
      await refusal(share(admin, libraryId, { kind: "user", userId: admin.userId }, "manage")),
    ).toBe("not_found");
    expect(await sees(manager, libraryId)).toEqual({ open: "accepted", listed: true });
  });

  it("keep one manager, and let anyone else leave what was shared with them", async () => {
    if (stack === undefined) return;
    const manager = await signInSession(stack, "manager");
    const friend = await signInSession(stack, "friend");
    const libraryId = await seedOne(stack, manager, "kept");
    const self = { kind: "user", userId: manager.userId } as const;
    const them = { kind: "user", userId: friend.userId } as const;

    expect(await refusal(unshare(manager, libraryId, self))).toBe("conflict");
    expect(await refusal(share(manager, libraryId, self, "edit"))).toBe("conflict");
    expect(await refusal(share(manager, libraryId, { kind: "household" }, "manage"))).toBe(
      "invalid_args",
    );

    await share(manager, libraryId, them, "view");
    await share(manager, libraryId, them, "view");
    await unshare(friend, libraryId, them);

    expect(await sees(friend, libraryId)).toEqual({ open: "not_found", listed: false });

    await share(manager, libraryId, them, "manage");
    await unshare(manager, libraryId, self);

    expect(await sees(manager, libraryId)).toEqual({ open: "not_found", listed: false });
    expect((await lookUp(friend, libraryId)).level).toBe("manage");
  });

  it("list who a library is shared with, to its managers only", async () => {
    if (stack === undefined) return;
    const admin = await signInSession(stack, "admin", "admin");
    const manager = await signInSession(stack, "manager");
    const friend = await signInSession(stack, "friend");
    const stranger = await signInSession(stack, "stranger");
    const libraryId = await seedOne(stack, manager, "listed");
    const name = `listed-${unique()}`;

    const { groupId } = await admin.signedIn.client.mutation(api.core.permissions.groups.create, {
      name,
    });

    await share(manager, libraryId, { kind: "user", userId: friend.userId }, "view");
    await share(manager, libraryId, { kind: "group", groupId }, "edit");
    await share(manager, libraryId, { kind: "household" }, "view");

    const sharedWith = (session: Session) =>
      session.signedIn.client.query(api.core.permissions.grants.list, {
        resource: { type: "library", id: libraryId },
        paginationOpts: { numItems: 10, cursor: null },
      });

    const listed = await sharedWith(manager);

    expect(listed.isDone).toBe(true);
    expect(listed.page).toHaveLength(4);
    expect(listed.page).toEqual(
      expect.arrayContaining([
        {
          principal: { kind: "user", userId: manager.userId, username: manager.username },
          level: "manage",
        },
        {
          principal: { kind: "user", userId: friend.userId, username: friend.username },
          level: "view",
        },
        { principal: { kind: "group", groupId, name }, level: "edit" },
        { principal: { kind: "household" }, level: "view" },
      ]),
    );
    expect(await refusal(sharedWith(friend))).toBe("forbidden");
    expect(await refusal(sharedWith(stranger))).toBe("forbidden");

    await unshare(manager, libraryId, { kind: "household" });

    expect(await refusal(sharedWith(stranger))).toBe("not_found");
    expect(await refusal(sharedWith(admin))).toBe("not_found");
  });

  it("list what a person's own, group, and household grants reach, once each, in id order", async () => {
    if (stack === undefined) return;
    const admin = await signInSession(stack, "admin", "admin");
    const manager = await signInSession(stack, "manager");
    const viewer = await signInSession(stack, "viewer");

    const libraries = (
      await seedLibraries(
        stack,
        manager,
        Array.from({ length: 30 }, (_, n) => ({ name: `paged-${n}`, kind: "movies", items: [] })),
      )
    ).map((seeded) => seeded.libraryId);

    const { groupId } = await admin.signedIn.client.mutation(api.core.permissions.groups.create, {
      name: `paged-${unique()}`,
    });

    await admin.signedIn.client.mutation(api.core.permissions.groups.addMember, {
      groupId,
      userId: viewer.userId,
    });
    await inOrder(libraries.slice(0, 20), async (libraryId) =>
      share(manager, libraryId, { kind: "user", userId: viewer.userId }, "view"),
    );
    await inOrder(libraries.slice(10, 25), async (libraryId) =>
      share(manager, libraryId, { kind: "group", groupId }, "edit"),
    );
    await inOrder(libraries.slice(20, 30), async (libraryId) =>
      share(manager, libraryId, { kind: "household" }, "view"),
    );

    const small = await visibleLibraries(viewer, 7);

    expect(small).toEqual(await visibleLibraries(viewer));
    expect(new Set(small).size).toBe(small.length);
    expect(small).toEqual(small.toSorted());
    expect(libraries.filter((libraryId) => !small.includes(libraryId))).toEqual([]);

    const sharedTwice = libraries[15];

    if (sharedTwice === undefined) throw new Error("seed made too few libraries");

    expect((await lookUp(viewer, sharedTwice)).level).toBe("edit");
  });

  it("refuse a group name twice, ignoring case", async () => {
    if (stack === undefined) return;
    const admin = await signInSession(stack, "admin", "admin");
    const member = await signInSession(stack, "member");
    const name = `Name-${unique()}`;

    await admin.signedIn.client.mutation(api.core.permissions.groups.create, { name });

    expect(
      await refusal(
        admin.signedIn.client.mutation(api.core.permissions.groups.create, {
          name: name.toLowerCase(),
        }),
      ),
    ).toBe("conflict");
    expect(
      await refusal(
        member.signedIn.client.mutation(api.core.permissions.groups.create, {
          name: `other-${unique()}`,
        }),
      ),
    ).toBe("forbidden");

    const { groupId } = await admin.signedIn.client.mutation(api.core.permissions.groups.create, {
      name: `keyed-${unique()}`,
    });

    const { key } = await admin.signedIn.client.action(api.core.auth.apiKeys.create, {
      name: "agent",
      scopes: ["admin"],
    });

    const agent = await signIn(stack, "apiKey", { key });

    expect(
      await refusal(
        agent.client.mutation(api.core.permissions.groups.addMember, {
          groupId,
          userId: admin.userId,
        }),
      ),
    ).toBe("forbidden");
  });
});
