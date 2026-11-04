import { ConvexHttpClient } from "convex/browser";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { api, internal } from "../../../convex/_generated/api";
import { runFunction } from "../../admin";
import { createPerson, ensureOwner, refusal, signIn, signInAs, unique } from "../../sign-in";
import type { Person, SignedIn } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";
import type { CoreStack } from "../../stack-env";

const stack = coreStackFromEnvFile();

const whoIs = (signedIn: SignedIn) => signedIn.client.query(api.core.auth.sessions.current, {});

/**
 * Takes over the stack's owner, whoever it is now, with the host reset, and signs in as them. The
 * reset ends the owner's other sessions, so no other test file signs in as the owner.
 */
const claimOwner = async (
  core: CoreStack,
): Promise<{ readonly person: Person; readonly signedIn: SignedIn }> => {
  const password = `password-${unique()}`;

  await ensureOwner(core);

  const { username } = await runFunction(
    core,
    internal.core.accounts.host.resetPassword,
    { password },
    Schema.Struct({ username: Schema.String }),
  );

  const person = { username, password };

  return { person, signedIn: await signInAs(core, person) };
};

describe.skipIf(stack === undefined)("the owner", { timeout: 120_000 }, () => {
  it("is made exactly once, however many setups race", async () => {
    if (stack === undefined) return;

    const racers = Array.from({ length: 5 }, () => ({
      username: `racer-${unique()}`,
      password: `password-${unique()}`,
    }));

    const outcomes = await Promise.all(
      racers.map(async (racer) => refusal(signIn(stack, "setup", racer))),
    );

    expect(outcomes.filter((outcome) => outcome === "accepted").length).toBeLessThanOrEqual(1);
    expect(outcomes.every((outcome) => outcome === "accepted" || outcome === "conflict")).toBe(
      true,
    );

    const refused = racers.filter((_racer, index) => outcomes[index] === "conflict");

    expect(
      await Promise.all(refused.map(async (racer) => refusal(signInAs(stack, racer)))),
    ).toEqual(refused.map(() => "unauthenticated"));

    expect(
      await new ConvexHttpClient(stack.url, { logger: false }).query(api.core.server.info, {}),
    ).toMatchObject({ hasOwner: true });
  });

  it("is an admin who holds every scope", async () => {
    if (stack === undefined) return;
    const { signedIn } = await claimOwner(stack);

    expect(await whoIs(signedIn)).toMatchObject({ role: "owner", scopes: ["account", "admin"] });
  });

  it("cannot be demoted or sent a reset link by any admin, or by themselves", async () => {
    if (stack === undefined) return;
    const { signedIn: owner } = await claimOwner(stack);
    const admin = await signInAs(stack, await createPerson(stack, "admin", "admin"));
    const { userId } = await whoIs(owner);

    expect(
      await refusal(
        admin.client.mutation(api.core.accounts.users.setRole, { userId, role: "member" }),
      ),
    ).toBe("forbidden");
    expect(
      await refusal(admin.client.action(api.core.accounts.resetLinks.create, { userId })),
    ).toBe("forbidden");
    expect(
      await refusal(
        owner.client.mutation(api.core.accounts.users.setRole, { userId, role: "admin" }),
      ),
    ).toBe("forbidden");
    expect(await whoIs(owner)).toMatchObject({ role: "owner" });
  });

  it("hands ownership over only by the owner's own call, and whole", async () => {
    if (stack === undefined) return;
    const { signedIn: owner } = await claimOwner(stack);
    const ownerId = (await whoIs(owner)).userId;
    const admin = await signInAs(stack, await createPerson(stack, "admin", "admin"));
    const heir = await signInAs(stack, await createPerson(stack, "heir"));
    const heirId = (await whoIs(heir)).userId;

    const { code } = await admin.client.action(api.core.accounts.resetLinks.create, {
      userId: heirId,
    });

    expect(
      await refusal(
        admin.client.mutation(api.core.accounts.users.handOverOwnership, { userId: heirId }),
      ),
    ).toBe("forbidden");

    await owner.client.mutation(api.core.accounts.users.handOverOwnership, { userId: heirId });

    expect(await whoIs(heir)).toMatchObject({ role: "owner", scopes: ["account", "admin"] });
    expect(await whoIs(owner)).toMatchObject({ role: "admin", scopes: ["account", "admin"] });
    expect(await refusal(signIn(stack, "reset", { code, password: `password-${unique()}` }))).toBe(
      "expired",
    );
    expect(
      await refusal(
        owner.client.mutation(api.core.accounts.users.handOverOwnership, { userId: heirId }),
      ),
    ).toBe("forbidden");

    await heir.client.mutation(api.core.accounts.users.handOverOwnership, { userId: ownerId });

    expect(await whoIs(owner)).toMatchObject({ role: "owner" });
    expect(await whoIs(heir)).toMatchObject({ role: "admin" });
  });

  it("gets back in from the server host, which ends every session and key and the lockout", async () => {
    if (stack === undefined) return;
    const { person, signedIn: owner } = await claimOwner(stack);

    const { key } = await owner.client.action(api.core.auth.apiKeys.create, {
      name: "script",
      scopes: ["account"],
    });

    const keyed = await signIn(stack, "apiKey", { key });

    const wrong = await Promise.all(
      Array.from({ length: 10 }, async () =>
        refusal(
          signIn(stack, "password", { username: person.username, password: "wrong-password" }),
        ),
      ),
    );

    expect(
      wrong.every((outcome) => outcome === "unauthenticated" || outcome === "rate_limited"),
    ).toBe(true);
    expect(await refusal(signInAs(stack, person))).toBe("rate_limited");

    const password = `password-${unique()}`;

    expect(
      await runFunction(
        stack,
        internal.core.accounts.host.resetPassword,
        { password },
        Schema.Struct({ username: Schema.String }),
      ),
    ).toEqual({ username: person.username });

    expect(await refusal(whoIs(owner))).toBe("unauthenticated");
    expect(await refusal(whoIs(keyed))).toBe("unauthenticated");
    expect(await refusal(signIn(stack, "apiKey", { key }))).toBe("unauthenticated");
    expect(await refusal(signInAs(stack, person))).toBe("unauthenticated");
    expect(await whoIs(await signInAs(stack, { ...person, password }))).toMatchObject({
      username: person.username,
      role: "owner",
    });
  });
});
