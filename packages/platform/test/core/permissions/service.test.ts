import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { api, internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { runFunction } from "../../admin";
import { createPerson, refusal, signInAs, unique } from "../../sign-in";
import type { SignedIn } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";

const stack = coreStackFromEnvFile();

// SAFETY: a type predicate, not checked by the compiler. A Convex id is an opaque string, and the
// stack answered this one as a `users` id; the backend's `v.id("users")` validators check it
// again whenever a test sends it back.
const isUserId = (value: unknown): value is Id<"users"> => Schema.is(Schema.String)(value);

const UserId = Schema.declare(isUserId);

const listsUser = async (
  admin: SignedIn,
  userId: Id<"users">,
  cursor: string | null = null,
): Promise<boolean> => {
  const page = await admin.client.query(api.core.accounts.users.list, {
    paginationOpts: { numItems: 500, cursor },
  });

  if (page.page.some((user) => user.userId === userId)) return true;

  return page.isDone ? false : listsUser(admin, userId, page.continueCursor);
};

describe.skipIf(stack === undefined)("service principals", { timeout: 120_000 }, () => {
  it("hold no role, password, restrictions, or group, and are no one's user", async () => {
    if (stack === undefined) return;
    const admin = await signInAs(stack, await createPerson(stack, "admin", "admin"));

    const serviceId = await runFunction(
      stack,
      internal.core.accounts.host.createService,
      { name: `media server ${unique()}` },
      UserId,
    );

    const { groupId } = await admin.client.mutation(api.core.permissions.groups.create, {
      name: `servers-${unique()}`,
    });

    expect(
      await Promise.all([
        refusal(
          admin.client.mutation(api.core.accounts.users.setRole, {
            userId: serviceId,
            role: "admin",
          }),
        ),
        refusal(
          admin.client.mutation(api.core.accounts.users.handOverOwnership, { userId: serviceId }),
        ),
        refusal(admin.client.action(api.core.accounts.resetLinks.create, { userId: serviceId })),
        refusal(
          admin.client.mutation(api.core.restrictions.set, {
            userId: serviceId,
            restrictions: null,
          }),
        ),
        refusal(
          admin.client.mutation(api.core.permissions.groups.addMember, {
            groupId,
            userId: serviceId,
          }),
        ),
      ]),
    ).toEqual(["forbidden", "forbidden", "forbidden", "forbidden", "forbidden"]);
    expect(await listsUser(admin, serviceId)).toBe(false);
  });
});
