import { ConvexHttpClient } from "convex/browser";
import { describe, expect, it } from "vitest";

import { api } from "../../../convex/_generated/api";
import { createPerson, refusal, signIn, signInAs } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";

const stack = coreStackFromEnvFile();

describe.skipIf(stack === undefined)("API key sign-in", { timeout: 120_000 }, () => {
  it("signs in with a key, and every sign-in with it shares one session", async () => {
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
    const caller = await first.client.query(api.core.auth.sessions.current, {});

    expect(caller).toMatchObject({ kind: "apiKey", scopes: ["account"] });
    expect(await second.client.query(api.core.auth.sessions.current, {})).toMatchObject({
      sessionId: caller.sessionId,
    });
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
        agent.client.action(api.core.auth.apiKeys.create, { name: "copy", scopes: [] }),
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

  it("keeps only the newest refresh tokens however often a key signs in", async () => {
    if (stack === undefined) return;
    const owner = await signInAs(stack, await createPerson(stack));

    const { key } = await owner.client.action(api.core.auth.apiKeys.create, {
      name: "cron",
      scopes: [],
    });

    const signIns = await Array.from({ length: 130 }).reduce<Promise<ReadonlyArray<string>>>(
      async (earlier) => [
        ...(await earlier),
        (await signIn(stack, "apiKey", { key })).refreshToken,
      ],
      Promise.resolve([]),
    );

    const refreshWith = async (refreshToken: string) =>
      (
        await new ConvexHttpClient(stack.url, { logger: false }).action(api.auth.signIn, {
          refreshToken,
        })
      ).tokens ?? null;

    expect(await refreshWith(signIns.at(-1) ?? "")).not.toBeNull();
    expect(await refreshWith(signIns[0] ?? "")).toBeNull();
  });

  it("refuses a wrong or malformed key", async () => {
    if (stack === undefined) return;
    const owner = await signInAs(stack, await createPerson(stack));

    const { key } = await owner.client.action(api.core.auth.apiKeys.create, {
      name: "k",
      scopes: [],
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
      scopes: [],
    });

    const narrow = await signIn(stack, "apiKey", { key });

    expect(await narrow.client.query(api.core.auth.sessions.current, {})).toMatchObject({
      scopes: [],
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
      scopes: [],
    });

    const signedIn = await signIn(stack, "apiKey", { key });

    await owner.client.mutation(api.core.auth.apiKeys.endAll, {});

    expect(await refusal(signedIn.client.query(api.core.auth.sessions.current, {}))).toBe(
      "unauthenticated",
    );
    expect(await refusal(signIn(stack, "apiKey", { key }))).toBe("unauthenticated");
    expect(await owner.client.query(api.core.auth.sessions.current, {})).toMatchObject({
      kind: "password",
    });

    const fresh = await owner.client.action(api.core.auth.apiKeys.create, {
      name: "new",
      scopes: [],
    });

    expect(await signIn(stack, "apiKey", { key: fresh.key })).toBeDefined();
  });

  it("revokes one key and the session it signed in", async () => {
    if (stack === undefined) return;
    const owner = await signInAs(stack, await createPerson(stack));

    const created = await owner.client.action(api.core.auth.apiKeys.create, {
      name: "r",
      scopes: [],
    });

    const signedIn = await signIn(stack, "apiKey", { key: created.key });

    await owner.client.mutation(api.core.auth.apiKeys.revoke, { keyId: created.keyId });

    expect(await refusal(signedIn.client.query(api.core.auth.sessions.current, {}))).toBe(
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
      scopes: [],
    });

    expect(
      await refusal(
        owner.client.action(api.core.auth.apiKeys.create, {
          name: "x",
          scopes: [],
          expiresInDays: 400,
        }),
      ),
    ).toBe("invalid_args");
    expect(
      await refusal(other.client.mutation(api.core.auth.apiKeys.revoke, { keyId: created.keyId })),
    ).toBe("not_found");
  });
});
