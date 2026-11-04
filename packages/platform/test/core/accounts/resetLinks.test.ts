import { ConvexHttpClient } from "convex/browser";
import { describe, expect, it } from "vitest";

import { api } from "../../../convex/_generated/api";
import { createPerson, refusal, signIn, signInAs, unique } from "../../sign-in";
import type { Person, SignedIn } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";
import type { CoreStack } from "../../stack-env";

const stack = coreStackFromEnvFile();

const whoIs = (signedIn: SignedIn) => signedIn.client.query(api.core.auth.sessions.current, {});

const signInAdmin = async (core: CoreStack): Promise<SignedIn> =>
  signInAs(core, await createPerson(core, "admin", "admin"));

const linkFor = async (admin: SignedIn, person: SignedIn) =>
  admin.client.action(api.core.accounts.resetLinks.create, {
    userId: (await whoIs(person)).userId,
  });

const redeem = (core: CoreStack, code: string) =>
  signIn(core, "reset", { code, password: `password-${unique()}` });

const anonymous = (core: CoreStack) => new ConvexHttpClient(core.url, { logger: false });

describe.skipIf(stack === undefined)("reset links", { timeout: 120_000 }, () => {
  it("set a new password once, ending every session and key the person had", async () => {
    if (stack === undefined) return;
    const admin = await signInAdmin(stack);
    const person: Person = await createPerson(stack);
    const session = await signInAs(stack, person);

    const { key } = await session.client.action(api.core.auth.apiKeys.create, {
      name: "script",
      scopes: ["account"],
    });

    const { code, expiresAt } = await linkFor(admin, session);

    expect(expiresAt - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(
      await anonymous(stack).query(api.core.accounts.resetLinks.lookup, { code }),
    ).toMatchObject({ username: person.username });

    const password = `password-${unique()}`;
    const reset = await signIn(stack, "reset", { code, password });

    expect(await whoIs(reset)).toMatchObject({ username: person.username, kind: "password" });
    expect(await refusal(whoIs(session))).toBe("unauthenticated");
    expect(await refusal(signIn(stack, "apiKey", { key }))).toBe("unauthenticated");
    expect(await refusal(signInAs(stack, person))).toBe("unauthenticated");
    expect(await refusal(signInAs(stack, { ...person, password }))).toBe("accepted");
    expect(await refusal(redeem(stack, code))).toBe("expired");
  });

  it("stop working when the person changes their password or the maker is demoted", async () => {
    if (stack === undefined) return;
    const maker = await signInAdmin(stack);
    const other = await signInAdmin(stack);
    const person = await createPerson(stack);
    const session = await signInAs(stack, person);
    const changed = await linkFor(maker, session);

    await session.client.action(api.core.accounts.me.changePassword, {
      currentPassword: person.password,
      newPassword: `password-${unique()}`,
    });

    expect(await refusal(redeem(stack, changed.code))).toBe("expired");

    const demoted = await linkFor(maker, session);

    await other.client.mutation(api.core.accounts.users.setRole, {
      userId: (await whoIs(maker)).userId,
      role: "member",
    });

    expect(await refusal(redeem(stack, demoted.code))).toBe("expired");
  });

  it("never work again once their maker lost admin, even after a promotion back", async () => {
    if (stack === undefined) return;
    const makerPerson = await createPerson(stack, "admin", "admin");
    const maker = await signInAs(stack, makerPerson);
    const other = await signInAdmin(stack);
    const target = await createPerson(stack, "admin", "admin");
    const targetSession = await signInAs(stack, target);
    const kept = await linkFor(maker, targetSession);
    const makerId = (await whoIs(maker)).userId;

    await other.client.mutation(api.core.accounts.users.setRole, {
      userId: makerId,
      role: "member",
    });
    await other.client.mutation(api.core.accounts.users.setRole, {
      userId: makerId,
      role: "admin",
    });

    const fresh = await linkFor(await signInAs(stack, makerPerson), targetSession);

    expect(
      await refusal(
        anonymous(stack).query(api.core.accounts.resetLinks.lookup, { code: kept.code }),
      ),
    ).toBe("expired");
    expect(await refusal(redeem(stack, kept.code))).toBe("expired");
    expect(await refusal(whoIs(targetSession))).toBe("accepted");
    expect(await refusal(signInAs(stack, target))).toBe("accepted");
    expect(
      await anonymous(stack).query(api.core.accounts.resetLinks.lookup, { code: fresh.code }),
    ).toMatchObject({ username: target.username });
  });

  it("stop working when their maker changes their password", async () => {
    if (stack === undefined) return;
    const makerPerson = await createPerson(stack, "admin", "admin");
    const maker = await signInAs(stack, makerPerson);
    const person = await signInAs(stack, await createPerson(stack));
    const { code } = await linkFor(maker, person);

    await maker.client.action(api.core.accounts.me.changePassword, {
      currentPassword: makerPerson.password,
      newPassword: `password-${unique()}`,
    });

    expect(await refusal(redeem(stack, code))).toBe("expired");
  });

  it("are refused for yourself, from members, and from API keys", async () => {
    if (stack === undefined) return;
    const admin = await signInAdmin(stack);
    const member = await signInAs(stack, await createPerson(stack));

    const { key } = await admin.client.action(api.core.auth.apiKeys.create, {
      name: "agent",
      scopes: ["account", "admin"],
    });

    const agent = await signIn(stack, "apiKey", { key });

    expect(await refusal(linkFor(admin, admin))).toBe("forbidden");
    expect(await refusal(linkFor(member, admin))).toBe("forbidden");
    expect(await refusal(linkFor(agent, member))).toBe("forbidden");
  });

  it("refuse a code that names no link", async () => {
    if (stack === undefined) return;

    expect(await refusal(redeem(stack, "mr_nothere.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))).toBe(
      "expired",
    );
    expect(await refusal(redeem(stack, "not a code"))).toBe("expired");
  });
});
