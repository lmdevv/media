import { describe, expect, it } from "vitest";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { createPerson, refusal, signIn, signInAs, unique } from "../../sign-in";
import type { SignedIn } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";
import type { CoreStack } from "../../stack-env";

const stack = coreStackFromEnvFile();

const whoIs = (signedIn: SignedIn) => signedIn.client.query(api.core.auth.sessions.current, {});

const signInAdmin = async (core: CoreStack): Promise<SignedIn> =>
  signInAs(core, await createPerson(core, "admin", "admin"));

const listed = async (
  admin: SignedIn,
  userId: Id<"users">,
  cursor: string | null = null,
): Promise<string | null> => {
  const page = await admin.client.query(api.core.accounts.users.list, {
    paginationOpts: { numItems: 500, cursor },
  });

  const found = page.page.find((user) => user.userId === userId);

  if (found !== undefined) return `${found.username}:${found.role}`;

  return page.isDone ? null : listed(admin, userId, page.continueCursor);
};

const promote = (by: SignedIn, userId: Id<"users">) =>
  refusal(by.client.mutation(api.core.accounts.users.setRole, { userId, role: "admin" }));

describe.skipIf(stack === undefined)("users", { timeout: 120_000 }, () => {
  it("are made with the username and password an admin typed, and sign in with them", async () => {
    if (stack === undefined) return;
    const admin = await signInAdmin(stack);
    const person = { username: `typed-${unique()}`, password: `password-${unique()}` };
    const { userId } = await admin.client.action(api.core.accounts.users.create, person);

    expect(await whoIs(await signInAs(stack, person))).toMatchObject({
      userId,
      username: person.username,
      role: "member",
      kind: "password",
    });
    expect(await listed(admin, userId)).toBe(`${person.username}:member`);
  });

  it("keep usernames unique ignoring case, and refuse ones or passwords that break the rules", async () => {
    if (stack === undefined) return;
    const admin = await signInAdmin(stack);
    const taken = await createPerson(stack, "Unique");

    const create = (username: string, password = "long-enough-password") =>
      refusal(admin.client.action(api.core.accounts.users.create, { username, password }));

    expect(await create(taken.username.toUpperCase())).toBe("conflict");
    expect(await create("has space")).toBe("invalid_args");
    expect(await create("Lucía")).toBe("invalid_args");
    expect(await create(`short-${unique()}`, "seven77")).toBe("invalid_args");
    expect(await create(`long-${unique()}`, "x".repeat(257))).toBe("invalid_args");
  });

  it("promote on the person's next call, and demote by ending every session and key", async () => {
    if (stack === undefined) return;
    const admin = await signInAdmin(stack);
    const credentials = await createPerson(stack);
    const person = await signInAs(stack, credentials);
    const { userId } = await whoIs(person);

    await admin.client.mutation(api.core.accounts.users.setRole, { userId, role: "admin" });

    expect(await whoIs(person)).toMatchObject({ role: "admin", scopes: ["account", "admin"] });

    const { key } = await person.client.action(api.core.auth.apiKeys.create, {
      name: "agent",
      scopes: ["account", "admin"],
    });

    const agent = await signIn(stack, "apiKey", { key });

    expect(await whoIs(agent)).toMatchObject({ scopes: ["account", "admin"] });

    await admin.client.mutation(api.core.accounts.users.setRole, { userId, role: "member" });

    expect(await refusal(whoIs(person))).toBe("unauthenticated");
    expect(await refusal(whoIs(agent))).toBe("unauthenticated");

    const member = await signInAs(stack, credentials);

    expect(await whoIs(member)).toMatchObject({ role: "member", scopes: ["account"] });
    expect(
      await refusal(
        member.client.query(api.core.accounts.users.list, {
          paginationOpts: { numItems: 1, cursor: null },
        }),
      ),
    ).toBe("forbidden");

    await admin.client.mutation(api.core.accounts.users.setRole, { userId, role: "admin" });

    expect(await refusal(signIn(stack, "apiKey", { key }))).toBe("unauthenticated");
  });

  it("refuse role changes to yourself, from members, and from API keys", async () => {
    if (stack === undefined) return;
    const admin = await signInAdmin(stack);
    const member = await signInAs(stack, await createPerson(stack));
    const adminId = (await whoIs(admin)).userId;
    const memberId = (await whoIs(member)).userId;

    const { key } = await admin.client.action(api.core.auth.apiKeys.create, {
      name: "agent",
      scopes: ["account", "admin"],
    });

    const agent = await signIn(stack, "apiKey", { key });

    expect(await promote(admin, adminId)).toBe("forbidden");
    expect(await promote(member, adminId)).toBe("forbidden");
    expect(await promote(agent, memberId)).toBe("forbidden");
    expect(
      await refusal(
        agent.client.action(api.core.accounts.users.create, {
          username: `agent-made-${unique()}`,
          password: "long-enough-password",
        }),
      ),
    ).toBe("forbidden");
    expect(
      await refusal(
        member.client.action(api.core.accounts.users.create, {
          username: `member-made-${unique()}`,
          password: "long-enough-password",
        }),
      ),
    ).toBe("forbidden");
  });
});
