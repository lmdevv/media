import { addressBudgets } from "@media/contracts/rate-limit";
import { loadPassKeys, PASS_LIFETIME_MS, PASS_PARAM } from "@media/contracts/sign-in";
import type { PassKeys, SignInProvider } from "@media/contracts/sign-in";
import { ConvexHttpClient } from "convex/browser";
import type { Value } from "convex/values";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { api, internal } from "../../../convex/_generated/api";
import { runFunction } from "../../admin";
import { newestRows } from "../../rows";
import {
  createPerson,
  failureOf,
  newClientAddress,
  postSignIn,
  refusal,
  signInAs,
  unique,
} from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";
import type { CoreStack } from "../../stack-env";
import { deploymentTicketKeysText } from "../../ticket-keys";

const stack = coreStackFromEnvFile();

const REFUSED = "Sign in through the server: the core takes sign-ins only from its sign-in route";

/** A random ring of one key, which the core does not hold. */
const strangerKeys = (): string => {
  const bytes = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

  return `stranger:${bytes}`;
};

const keysOf = async (text: string): Promise<PassKeys> => {
  const loaded = await loadPassKeys(text);

  if (!loaded.ok) throw new Error(`Unusable keys: ${loaded.error.problem}`);

  return loaded.value;
};

/** Calls `auth:signIn` straight over the core's API, as a client that skipped the boundary. */
const straight = (
  core: CoreStack,
  provider: SignInProvider,
  params: Readonly<Record<string, Value>>,
) =>
  new ConvexHttpClient(core.url, { logger: false }).action(api.auth.signIn, { provider, params });

describe.skipIf(stack === undefined)("the sign-in boundary", { timeout: 120_000 }, () => {
  it("refuses every provider's sign-in sent straight to auth:signIn, a right password too", async () => {
    if (stack === undefined) return;
    const person = await createPerson(stack, "straight");

    const attempts: ReadonlyArray<readonly [SignInProvider, Record<string, Value>]> = [
      ["password", { username: person.username, password: person.password }],
      ["apiKey", { key: "mk_x.y" }],
      ["deviceCode", { deviceCode: "dc_x.y" }],
      ["setup", { username: person.username, password: person.password }],
      ["invite", { code: "mi_x.y", username: "someone", password: person.password }],
      ["reset", { code: "mr_x.y", password: person.password }],
      ["tile", { device: "dv_x.y", userId: "x" }],
      ["guest", { code: "mg_x.y", name: "Guest" }],
      ["grant", { userId: "x", grant: "dg_x.y" }],
    ];

    const failures = await Promise.all(
      attempts.map(([provider, params]) => failureOf(straight(stack, provider, params))),
    );

    expect(failures).toEqual(attempts.map(() => ({ code: "forbidden", message: REFUSED })));

    expect(await refusal(signInAs(stack, person))).toBe("accepted");
  });

  it("takes a pass once, for exactly the sign-in it was signed for, until it expires", async () => {
    if (stack === undefined) return;
    const person = await createPerson(stack, "pass");
    const params = { username: person.username, password: person.password };
    const keys = await keysOf(deploymentTicketKeysText());
    const address = newClientAddress();

    const pass = await keys.sign({ provider: "password", params, address, now: Date.now() });

    expect(await refusal(straight(stack, "password", { ...params, [PASS_PARAM]: pass }))).toBe(
      "accepted",
    );

    expect(await refusal(straight(stack, "password", { ...params, [PASS_PARAM]: pass }))).toBe(
      "forbidden",
    );

    const another = await keys.sign({ provider: "password", params, address, now: Date.now() });
    const otherPerson = await createPerson(stack, "other");

    expect(
      await refusal(
        straight(stack, "password", {
          username: otherPerson.username,
          password: otherPerson.password,
          [PASS_PARAM]: another,
        }),
      ),
    ).toBe("forbidden");

    expect(await refusal(straight(stack, "setup", { ...params, [PASS_PARAM]: another }))).toBe(
      "forbidden",
    );

    const old = await keys.sign({
      provider: "password",
      params,
      address,
      now: Date.now() - PASS_LIFETIME_MS - 1000,
    });

    expect(await refusal(straight(stack, "password", { ...params, [PASS_PARAM]: old }))).toBe(
      "forbidden",
    );

    const forged = await (
      await keysOf(strangerKeys())
    ).sign({ provider: "password", params, address, now: Date.now() });

    expect(await refusal(straight(stack, "password", { ...params, [PASS_PARAM]: forged }))).toBe(
      "forbidden",
    );

    expect(
      await refusal(straight(stack, "password", { ...params, [PASS_PARAM]: `${another}x` })),
    ).toBe("forbidden");

    expect(await refusal(straight(stack, "password", { ...params, [PASS_PARAM]: another }))).toBe(
      "accepted",
    );
  });

  it("answers the eleventh fast sign-in from one address with a rate limit, and lets another in", async () => {
    if (stack === undefined) return;
    const target = await createPerson(stack, "burst");
    const other = await createPerson(stack, "elsewhere");
    const address = newClientAddress();
    const wrong = { username: target.username, password: `wrong-${unique()}` };

    const answers = await Array.from({ length: 20 }).reduce<
      Promise<ReadonlyArray<{ readonly status: number; readonly text: string }>>
    >(
      async (earlier) => [...(await earlier), await postSignIn(stack, "password", wrong, address)],
      Promise.resolve([]),
    );

    const burst = addressBudgets.signIn.burst;

    expect(answers.slice(0, burst).map(({ status }) => status)).toEqual(
      Array.from({ length: burst }, () => 401),
    );

    expect(answers.slice(burst).every(({ status }) => status === 429)).toBe(true);

    expect(JSON.parse(answers.at(-1)?.text ?? "{}")).toMatchObject({ code: "rate_limited" });

    const elsewhere = await postSignIn(
      stack,
      "password",
      { username: other.username, password: other.password },
      newClientAddress(),
    );

    expect(elsewhere.status).toBe(200);
  });

  it("refuses a pass spent once and expired, after the sweep, and takes no second try", async () => {
    if (stack === undefined) return;
    const usernameKey = `replay-${unique()}`;
    const params = { username: usernameKey, password: `wrong-${unique()}` };
    const keys = await keysOf(deploymentTicketKeysText());
    const lifetimeLeftMs = 3000;

    const signed = await keys.sign({
      provider: "password",
      params,
      address: newClientAddress(),
      now: Date.now() - PASS_LIFETIME_MS + lifetimeLeftMs,
    });

    const checked = await keys.verify(signed, "password", params, Date.now());

    if (!checked.ok) throw new Error(`the pass did not verify: ${checked.error.reason}`);
    const pass = { ...checked.value, provider: "password" };

    const attempt = () =>
      runFunction(
        stack,
        internal.core.auth.password.attempt,
        { pass, usernameKey },
        Schema.Unknown,
      );

    const budget = () =>
      newestRows("rateLimits", 1000).find((line) => line.includes(`"password:${usernameKey}"`));

    expect(await refusal(attempt())).toBe("accepted");
    const afterFirst = budget();

    await new Promise((resolve) => setTimeout(resolve, lifetimeLeftMs + 500));
    await runFunction(stack, internal.core.auth.passes.sweep, {}, Schema.Null);

    expect(await refusal(attempt())).toBe("forbidden");
    expect(afterFirst).toBeDefined();
    expect(budget()).toBe(afterFirst);
  });

  it("refuses a pass in a mutation of another kind of sign-in", async () => {
    if (stack === undefined) return;
    const usernameKey = `kind-${unique()}`;
    const params = { key: `mk_${unique()}.${unique()}` };
    const keys = await keysOf(deploymentTicketKeysText());

    const signed = await keys.sign({
      provider: "apiKey",
      params,
      address: newClientAddress(),
      now: Date.now(),
    });

    const checked = await keys.verify(signed, "apiKey", params, Date.now());

    if (!checked.ok) throw new Error(`the pass did not verify: ${checked.error.reason}`);

    expect(
      await refusal(
        runFunction(
          stack,
          internal.core.auth.password.attempt,
          { pass: { ...checked.value, provider: "apiKey" }, usernameKey },
          Schema.Unknown,
        ),
      ),
    ).toBe("forbidden");

    expect(
      newestRows("rateLimits", 1000).some((line) => line.includes(`"password:${usernameKey}"`)),
    ).toBe(false);
  });

  it("forgets no pass it took while the pass could still be sent", async () => {
    if (stack === undefined) return;
    const person = await createPerson(stack, "sweep");
    const params = { username: person.username, password: person.password };
    const keys = await keysOf(deploymentTicketKeysText());

    const pass = await keys.sign({
      provider: "password",
      params,
      address: newClientAddress(),
      now: Date.now(),
    });

    expect(await refusal(straight(stack, "password", { ...params, [PASS_PARAM]: pass }))).toBe(
      "accepted",
    );

    await runFunction(stack, internal.core.auth.passes.sweep, {}, Schema.Null);

    expect(await refusal(straight(stack, "password", { ...params, [PASS_PARAM]: pass }))).toBe(
      "forbidden",
    );
  });
});
