import { describe, expect, it } from "vitest";

import { api } from "../../../convex/_generated/api";
import { GIVEN_NAME_MAX } from "../../../convex/core/lib/names";
import { PASSWORD_MAX } from "../../../convex/core/lib/passwords";
import { enroll, member, picker } from "../../devices";
import { allPages } from "../../pages";
import { createPerson, refusal, signIn, signInAs, unique } from "../../sign-in";
import type { SignedIn } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";

const stack = coreStackFromEnvFile();

const whoIs = (signedIn: SignedIn) => signedIn.client.query(api.core.auth.sessions.current, {});

describe.skipIf(stack === undefined)("your own account", { timeout: 120_000 }, () => {
  it("takes a new username and keeps your id, sessions, and keys", async () => {
    if (stack === undefined) return;
    const person = await createPerson(stack, "Old");
    const session = await signInAs(stack, person);
    const { userId } = await whoIs(session);

    const { key } = await session.client.action(api.core.auth.apiKeys.create, {
      name: "script",
      scopes: ["account"],
    });

    const username = `New-${unique()}`;

    await session.client.mutation(api.core.accounts.me.rename, { username });

    expect(await whoIs(session)).toMatchObject({ userId, username });
    expect(await whoIs(await signIn(stack, "apiKey", { key }))).toMatchObject({ userId, username });
    expect(
      await whoIs(
        await signInAs(stack, { username: username.toLowerCase(), password: person.password }),
      ),
    ).toMatchObject({ userId });
    expect(await refusal(signInAs(stack, person))).toBe("unauthenticated");
  });

  it("refuses a username someone else has in any case, and lets you change only the case of yours", async () => {
    if (stack === undefined) return;
    const other = await createPerson(stack);
    const person = await createPerson(stack, "case");
    const session = await signInAs(stack, person);

    const rename = (username: string) =>
      refusal(session.client.mutation(api.core.accounts.me.rename, { username }));

    expect(await rename(other.username.toUpperCase())).toBe("conflict");
    expect(await rename("has space")).toBe("invalid_args");
    expect(await rename(person.username.toUpperCase())).toBe("accepted");
    expect(await whoIs(session)).toMatchObject({ username: person.username.toUpperCase() });
  });

  it("changes your password with the current one, keeping this session and your keys", async () => {
    if (stack === undefined) return;
    const person = await createPerson(stack);
    const kept = await signInAs(stack, person);
    const ended = await signInAs(stack, person);

    const { key } = await kept.client.action(api.core.auth.apiKeys.create, {
      name: "script",
      scopes: ["account"],
    });

    const change = (currentPassword: string, newPassword: string) =>
      refusal(
        kept.client.action(api.core.accounts.me.changePassword, { currentPassword, newPassword }),
      );

    const password = `password-${unique()}`;

    expect(await change("wrong-password", password)).toBe("unauthenticated");
    expect(await change("x".repeat(PASSWORD_MAX * 8 + 1), password)).toBe("invalid_args");
    expect(await change(person.password, "short")).toBe("invalid_args");
    expect(await change(person.password, password)).toBe("accepted");

    expect(await refusal(whoIs(kept))).toBe("accepted");
    expect(await refusal(whoIs(ended))).toBe("unauthenticated");
    expect(await refusal(signIn(stack, "apiKey", { key }))).toBe("accepted");
    expect(await refusal(signInAs(stack, person))).toBe("unauthenticated");
    expect(await refusal(signInAs(stack, { ...person, password }))).toBe("accepted");
  });

  it("refuses renames and password changes made with an API key", async () => {
    if (stack === undefined) return;
    const person = await createPerson(stack);
    const session = await signInAs(stack, person);

    const { key } = await session.client.action(api.core.auth.apiKeys.create, {
      name: "script",
      scopes: ["account"],
    });

    const agent = await signIn(stack, "apiKey", { key });

    expect(
      await refusal(
        agent.client.mutation(api.core.accounts.me.rename, { username: `agent-${unique()}` }),
      ),
    ).toBe("forbidden");
    expect(
      await refusal(
        agent.client.action(api.core.accounts.me.changePassword, {
          currentPassword: person.password,
          newPassword: `password-${unique()}`,
        }),
      ),
    ).toBe("forbidden");
  });
  it("takes a display name that greetings and the users list show, until cleared, and keeps it off pickers", async () => {
    if (stack === undefined) return;
    const person = await createPerson(stack, "named");
    const session = await signInAs(stack, person);
    const admin = await member(stack, "admin", "admin");
    const device = await enroll(session, "Living room iPad");
    const { userId } = await whoIs(session);

    const nameOf = async () => {
      const pages = await allPages(
        (paginationOpts) =>
          admin.signedIn.client.query(api.core.accounts.users.list, { paginationOpts }),
        200,
      );

      return pages.flatMap((page) => page.page).find((user) => user.userId === userId)?.displayName;
    };

    expect(await whoIs(session)).toMatchObject({ displayName: null });
    expect(await nameOf()).toBeNull();

    await session.client.mutation(api.core.accounts.me.setDisplayName, {
      displayName: "  Aiko Tanaka ",
    });

    expect(await whoIs(session)).toMatchObject({ displayName: "Aiko Tanaka" });
    expect(await nameOf()).toBe("Aiko Tanaka");
    expect((await picker(stack, device)).tiles).toEqual([{ userId, username: person.username }]);

    await session.client.mutation(api.core.accounts.me.rename, { username: `aiko-${unique()}` });

    expect(await whoIs(session)).toMatchObject({ displayName: "Aiko Tanaka" });

    await session.client.mutation(api.core.accounts.me.setDisplayName, { displayName: null });

    expect(await whoIs(session)).toMatchObject({ displayName: null });
    expect(await nameOf()).toBeNull();
  });

  it("refuses a blank, unprintable, or too long display name, and one set with an API key", async () => {
    if (stack === undefined) return;
    const session = await signInAs(stack, await createPerson(stack, "fit"));

    const name = (displayName: string, as: SignedIn = session) =>
      refusal(as.client.mutation(api.core.accounts.me.setDisplayName, { displayName }));

    expect(await name("   ")).toBe("invalid_args");
    expect(await name("bad\u202Ename")).toBe("invalid_args");
    expect(await name("x".repeat(GIVEN_NAME_MAX + 1))).toBe("invalid_args");
    expect(await name("😀".repeat(GIVEN_NAME_MAX))).toBe("accepted");

    const { key } = await session.client.action(api.core.auth.apiKeys.create, {
      name: "script",
      scopes: ["account"],
    });

    expect(await name("Script", await signIn(stack, "apiKey", { key }))).toBe("forbidden");
  });
});
