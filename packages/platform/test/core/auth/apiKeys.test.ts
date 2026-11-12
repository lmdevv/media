import { ConvexHttpClient } from "convex/browser";
import { describe, expect, it } from "vitest";

import { api } from "../../../convex/_generated/api";
import { createPerson, refusal, signIn, signInAs } from "../../sign-in";
import type { SignedIn } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";

const stack = coreStackFromEnvFile();

describe.skipIf(stack === undefined)("API key sign-in", { timeout: 120_000 }, () => {
  it("signs in with a key, and one client signing out leaves the others signed in", async () => {
    if (stack === undefined) return;
    const owner = await signInAs(stack, await createPerson(stack));

    const created = await owner.client.action(api.core.auth.apiKeys.create, {
      name: "backup script",
      scopes: ["account"],
      expiresInDays: 30,
    });

    expect(created.key).toMatch(/^mk_[a-z0-9]+\.[\w-]{43}$/u);
    expect(created.expiresAt).toBeGreaterThan(Date.now());

    const first = await signIn(stack, "apiKey", { key: created.key });
    const second = await signIn(stack, "apiKey", { key: created.key });

    expect(await first.client.query(api.core.auth.sessions.current, {})).toMatchObject({
      kind: "apiKey",
      scopes: ["account"],
    });

    await first.client.action(api.auth.signOut, {});

    expect(await refusal(first.client.query(api.core.auth.sessions.current, {}))).toBe(
      "unauthenticated",
    );
    expect(await refusal(second.client.query(api.core.auth.sessions.current, {}))).toBe("accepted");
  });

  it("cannot create a key or approve a device, even with the account scope", async () => {
    if (stack === undefined) return;
    const owner = await signInAs(stack, await createPerson(stack));

    const { key } = await owner.client.action(api.core.auth.apiKeys.create, {
      name: "agent",
      scopes: ["account"],
    });

    const agent = await signIn(stack, "apiKey", { key });

    const device = await new ConvexHttpClient(stack.url, { logger: false }).action(
      api.core.auth.deviceCodes.start,
      { clientName: "agent box" },
    );

    expect(
      await refusal(
        agent.client.action(api.core.auth.apiKeys.create, {
          name: "copy",
          scopes: ["movies:read"],
        }),
      ),
    ).toBe("forbidden");
    expect(
      await refusal(
        agent.client.mutation(api.core.auth.deviceCodes.approve, {
          userCode: device.userCode,
          scopes: [],
        }),
      ),
    ).toBe("forbidden");
    expect(
      await refusal(agent.client.mutation(api.core.auth.sessions.endAll, { keepCurrent: false })),
    ).toBe("accepted");
  });

  it("keeps a key's newest 100 sign-ins signed in when the oldest refreshes", async () => {
    if (stack === undefined) return;
    const owner = await signInAs(stack, await createPerson(stack));

    const { key } = await owner.client.action(api.core.auth.apiKeys.create, {
      name: "cron",
      scopes: ["movies:read"],
    });

    const [oldest, ...newer] = await Array.from({ length: 102 }).reduce<
      Promise<ReadonlyArray<SignedIn>>
    >(
      async (earlier) => [...(await earlier), await signIn(stack, "apiKey", { key })],
      Promise.resolve([]),
    );

    const newest = newer.at(-1);

    if (oldest === undefined || newest === undefined) throw new Error("No sign-ins");

    const refreshWith = async (refreshToken: string) =>
      (
        await new ConvexHttpClient(stack.url, { logger: false }).action(api.auth.signIn, {
          refreshToken,
        })
      ).tokens ?? null;

    expect(await refreshWith(oldest.refreshToken)).toBeNull();
    expect(await refusal(newest.client.query(api.core.auth.sessions.current, {}))).toBe("accepted");
    expect(await refreshWith(newest.refreshToken)).not.toBeNull();
    expect(await refusal(oldest.client.query(api.core.auth.sessions.current, {}))).toBe(
      "unauthenticated",
    );
  });

  it("refuses a wrong or malformed key", async () => {
    if (stack === undefined) return;
    const owner = await signInAs(stack, await createPerson(stack));

    const { key } = await owner.client.action(api.core.auth.apiKeys.create, {
      name: "k",
      scopes: ["movies:read"],
    });

    expect(await refusal(signIn(stack, "apiKey", { key: `${key.slice(0, -4)}AAAA` }))).toBe(
      "unauthenticated",
    );
    expect(await refusal(signIn(stack, "apiKey", { key: "mk_nothing" }))).toBe("unauthenticated");
  });

  it("holds only the scopes it was given", async () => {
    if (stack === undefined) return;
    const owner = await signInAs(stack, await createPerson(stack));

    const { key } = await owner.client.action(api.core.auth.apiKeys.create, {
      name: "narrow",
      scopes: ["movies:read"],
    });

    const narrow = await signIn(stack, "apiKey", { key });

    expect(await narrow.client.query(api.core.auth.sessions.current, {})).toMatchObject({
      scopes: ["movies:read"],
    });
    expect(
      await refusal(
        narrow.client.action(api.core.auth.apiKeys.create, { name: "wider", scopes: ["account"] }),
      ),
    ).toBe("forbidden");
    expect(
      await refusal(narrow.client.mutation(api.core.auth.sessions.endAll, { keepCurrent: false })),
    ).toBe("forbidden");
  });

  it("stops every key made before ending all keys, and not a key made after", async () => {
    if (stack === undefined) return;
    const owner = await signInAs(stack, await createPerson(stack));

    const { key } = await owner.client.action(api.core.auth.apiKeys.create, {
      name: "old",
      scopes: ["movies:read"],
    });

    const signedIn = await signIn(stack, "apiKey", { key });
    const again = await signIn(stack, "apiKey", { key });

    await owner.client.mutation(api.core.auth.apiKeys.endAll, {});

    expect(await refusal(signedIn.client.query(api.core.auth.sessions.current, {}))).toBe(
      "unauthenticated",
    );
    expect(await refusal(again.client.query(api.core.auth.sessions.current, {}))).toBe(
      "unauthenticated",
    );
    expect(await refusal(signIn(stack, "apiKey", { key }))).toBe("unauthenticated");
    expect(await owner.client.query(api.core.auth.sessions.current, {})).toMatchObject({
      kind: "password",
    });

    const fresh = await owner.client.action(api.core.auth.apiKeys.create, {
      name: "new",
      scopes: ["movies:read"],
    });

    expect(await signIn(stack, "apiKey", { key: fresh.key })).toBeDefined();
  });

  it("revokes one key and every session it signed in", async () => {
    if (stack === undefined) return;
    const owner = await signInAs(stack, await createPerson(stack));

    const created = await owner.client.action(api.core.auth.apiKeys.create, {
      name: "r",
      scopes: ["movies:read"],
    });

    const signedIn = await signIn(stack, "apiKey", { key: created.key });
    const again = await signIn(stack, "apiKey", { key: created.key });

    await owner.client.mutation(api.core.auth.apiKeys.revoke, { keyId: created.keyId });

    expect(await refusal(signedIn.client.query(api.core.auth.sessions.current, {}))).toBe(
      "unauthenticated",
    );
    expect(await refusal(again.client.query(api.core.auth.sessions.current, {}))).toBe(
      "unauthenticated",
    );
    expect(await refusal(signIn(stack, "apiKey", { key: created.key }))).toBe("unauthenticated");
  });

  it("refuses expiries outside 1 to 365 days and another user's key", async () => {
    if (stack === undefined) return;
    const owner = await signInAs(stack, await createPerson(stack));
    const other = await signInAs(stack, await createPerson(stack));

    const created = await owner.client.action(api.core.auth.apiKeys.create, {
      name: "mine",
      scopes: ["movies:read"],
    });

    expect(
      await refusal(
        owner.client.action(api.core.auth.apiKeys.create, {
          name: "x",
          scopes: ["movies:read"],
          expiresInDays: 400,
        }),
      ),
    ).toBe("invalid_args");
    expect(
      await refusal(other.client.mutation(api.core.auth.apiKeys.revoke, { keyId: created.keyId })),
    ).toBe("not_found");
  });
});
