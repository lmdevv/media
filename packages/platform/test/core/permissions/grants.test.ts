import { describe, expect, it } from "vitest";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { inOrder } from "../../../convex/core/lib/inOrder";
import {
  movie,
  openProbe,
  probePage,
  seedProbes,
  sessionOf,
  shareProbe,
  unshareProbe,
  visibleProbes,
} from "../../probe";
import type { Session } from "../../probe";
import { createPerson, refusal, signInAs, unique } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";
import type { CoreStack } from "../../stack-env";

const stack = coreStackFromEnvFile();

const signInSession = async (
  core: CoreStack,
  label = "person",
  role: "admin" | "member" = "member",
) => sessionOf(await signInAs(core, await createPerson(core, label, role)));

const seedOne = async (core: CoreStack, manager: Session, name: string) => {
  const [probeId] = await seedProbes(core, manager, [movie(name, 0)]);

  if (probeId === undefined) throw new Error("seed made no probe");

  return probeId;
};

const sees = async (core: CoreStack, session: Session, probeId: Id<"accessProbes">) => ({
  open: await refusal(openProbe(core, session, probeId)),
  listed: (await visibleProbes(core, session)).includes(probeId),
});

describe.skipIf(stack === undefined)("grants", { timeout: 120_000 }, () => {
  it("reach a group's members, and stop at once when one leaves the group", async () => {
    if (stack === undefined) return;
    const admin = await signInSession(stack, "admin", "admin");
    const manager = await signInSession(stack, "manager");
    const member = await signInSession(stack, "member");
    const probeId = await seedOne(stack, manager, "group-shared");

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

    expect(await sees(stack, member, probeId)).toEqual({ open: "not_found", listed: false });

    await shareProbe(stack, manager, probeId, { kind: "group", groupId }, "view");

    expect(await sees(stack, member, probeId)).toEqual({ open: "accepted", listed: true });
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

    expect(await sees(stack, member, probeId)).toEqual({ open: "not_found", listed: false });
  });

  it("stop reaching anyone when their group is removed", async () => {
    if (stack === undefined) return;
    const admin = await signInSession(stack, "admin", "admin");
    const manager = await signInSession(stack, "manager");
    const member = await signInSession(stack, "member");
    const probeId = await seedOne(stack, manager, "group-removed");

    const { groupId } = await admin.signedIn.client.mutation(api.core.permissions.groups.create, {
      name: `club-${unique()}`,
    });

    await admin.signedIn.client.mutation(api.core.permissions.groups.addMember, {
      groupId,
      userId: member.userId,
    });
    await shareProbe(stack, manager, probeId, { kind: "group", groupId }, "edit");

    expect((await openProbe(stack, member, probeId)).level).toBe("edit");

    await admin.signedIn.client.mutation(api.core.permissions.groups.remove, { groupId });

    expect(await sees(stack, member, probeId)).toEqual({ open: "not_found", listed: false });
    expect(
      await refusal(shareProbe(stack, manager, probeId, { kind: "group", groupId }, "view")),
    ).toBe("not_found");
  });

  it("reach every person through the household", async () => {
    if (stack === undefined) return;
    const manager = await signInSession(stack, "manager");
    const probeId = await seedOne(stack, manager, "household-shared");

    await shareProbe(stack, manager, probeId, { kind: "household" }, "view");

    const newcomer = await signInSession(stack, "newcomer");

    expect(await sees(stack, newcomer, probeId)).toEqual({ open: "accepted", listed: true });
    expect(
      await refusal(
        shareProbe(stack, newcomer, probeId, { kind: "user", userId: newcomer.userId }, "edit"),
      ),
    ).toBe("forbidden");
  });

  it("keep a private thing hidden from admins, in lookups and lists", async () => {
    if (stack === undefined) return;
    const admin = await signInSession(stack, "admin", "admin");
    const manager = await signInSession(stack, "manager");
    const probeId = await seedOne(stack, manager, "private");

    expect(await sees(stack, admin, probeId)).toEqual({ open: "not_found", listed: false });
    expect(
      await refusal(
        shareProbe(stack, admin, probeId, { kind: "user", userId: admin.userId }, "manage"),
      ),
    ).toBe("not_found");
    expect(await sees(stack, manager, probeId)).toEqual({ open: "accepted", listed: true });
  });

  it("keep one manager, and let anyone else leave what was shared with them", async () => {
    if (stack === undefined) return;
    const manager = await signInSession(stack, "manager");
    const friend = await signInSession(stack, "friend");
    const probeId = await seedOne(stack, manager, "kept");
    const self = { kind: "user", userId: manager.userId } as const;
    const them = { kind: "user", userId: friend.userId } as const;

    expect(await refusal(unshareProbe(stack, manager, probeId, self))).toBe("conflict");
    expect(await refusal(shareProbe(stack, manager, probeId, self, "edit"))).toBe("conflict");
    expect(
      await refusal(shareProbe(stack, manager, probeId, { kind: "household" }, "manage")),
    ).toBe("invalid_args");

    await shareProbe(stack, manager, probeId, them, "view");
    await shareProbe(stack, manager, probeId, them, "view");
    await unshareProbe(stack, friend, probeId, them);

    expect(await sees(stack, friend, probeId)).toEqual({ open: "not_found", listed: false });

    await shareProbe(stack, manager, probeId, them, "manage");
    await unshareProbe(stack, manager, probeId, self);

    expect(await sees(stack, manager, probeId)).toEqual({ open: "not_found", listed: false });
    expect((await openProbe(stack, friend, probeId, "manage")).level).toBe("manage");
  });

  it("list what a person's own, group, and household grants reach, once each, in id order", async () => {
    if (stack === undefined) return;
    const admin = await signInSession(stack, "admin", "admin");
    const manager = await signInSession(stack, "manager");
    const viewer = await signInSession(stack, "viewer");

    const probes = await seedProbes(
      stack,
      manager,
      Array.from({ length: 30 }, (_, n) => movie(`paged-${n}`, 0)),
    );

    const { groupId } = await admin.signedIn.client.mutation(api.core.permissions.groups.create, {
      name: `paged-${unique()}`,
    });

    await admin.signedIn.client.mutation(api.core.permissions.groups.addMember, {
      groupId,
      userId: viewer.userId,
    });
    await inOrder(probes.slice(0, 20), async (probeId) =>
      shareProbe(stack, manager, probeId, { kind: "user", userId: viewer.userId }, "view"),
    );
    await inOrder(probes.slice(10, 25), async (probeId) =>
      shareProbe(stack, manager, probeId, { kind: "group", groupId }, "edit"),
    );
    await inOrder(probes.slice(20, 30), async (probeId) =>
      shareProbe(stack, manager, probeId, { kind: "household" }, "view"),
    );

    const walk = async (
      cursor: string | null = null,
      seen: ReadonlyArray<Id<"accessProbes">> = [],
    ): Promise<ReadonlyArray<Id<"accessProbes">>> => {
      const page = await probePage(stack, viewer, 7, cursor);
      const next = [...seen, ...page.page.map((probe) => probe.probeId)];

      return page.isDone ? next : walk(page.continueCursor, next);
    };

    const small = await walk();

    expect(small).toEqual(await visibleProbes(stack, viewer));
    expect(new Set(small).size).toBe(small.length);
    expect(small).toEqual(small.toSorted());
    expect(probes.filter((probeId) => !small.includes(probeId))).toEqual([]);

    const sharedTwice = probes[15];

    if (sharedTwice === undefined) throw new Error("seed made too few probes");

    expect((await openProbe(stack, viewer, sharedTwice)).level).toBe("edit");
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
  });
});
