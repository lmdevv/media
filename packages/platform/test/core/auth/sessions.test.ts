import { ConvexHttpClient } from "convex/browser";
import { describe, expect, it } from "vitest";

import { api } from "../../../convex/_generated/api";
import { createPerson, refusal, signInAs } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";

const stack = coreStackFromEnvFile();

describe.skipIf(stack === undefined)("the live-session check", { timeout: 120_000 }, () => {
  it("refuses a call with no session", async () => {
    if (stack === undefined) return;
    const anonymous = new ConvexHttpClient(stack.url, { logger: false });

    expect(await refusal(anonymous.query(api.core.auth.sessions.current, {}))).toBe(
      "unauthenticated",
    );
  });

  it("refuses a signed-out session while its JWT is still unexpired", async () => {
    if (stack === undefined) return;
    const signedIn = await signInAs(stack, await createPerson(stack));

    await signedIn.client.action(api.auth.signOut, {});

    expect(await refusal(signedIn.client.query(api.core.auth.sessions.current, {}))).toBe(
      "unauthenticated",
    );
  });

  it("refuses a session another session ended, and refuses to refresh it", async () => {
    if (stack === undefined) return;
    const person = await createPerson(stack);
    const laptop = await signInAs(stack, person);
    const phone = await signInAs(stack, person);
    const { sessionId } = await laptop.client.query(api.core.auth.sessions.current, {});

    await phone.client.mutation(api.core.auth.sessions.end, { sessionId });

    expect(await refusal(laptop.client.query(api.core.auth.sessions.current, {}))).toBe(
      "unauthenticated",
    );

    const refreshed = await new ConvexHttpClient(stack.url, { logger: false }).action(
      api.auth.signIn,
      { refreshToken: laptop.refreshToken },
    );

    expect(refreshed.tokens).toBeNull();
    expect(await phone.client.query(api.core.auth.sessions.current, {})).toMatchObject({
      username: person.username,
    });
  });

  it("ends every older session at once, and can keep the current one", async () => {
    if (stack === undefined) return;
    const person = await createPerson(stack);
    const older = await signInAs(stack, person);
    const current = await signInAs(stack, person);

    await current.client.mutation(api.core.auth.sessions.endAll, { keepCurrent: true });

    expect(await refusal(older.client.query(api.core.auth.sessions.current, {}))).toBe(
      "unauthenticated",
    );
    expect(await current.client.query(api.core.auth.sessions.current, {})).toMatchObject({
      username: person.username,
    });

    const next = await signInAs(stack, person);

    await current.client.mutation(api.core.auth.sessions.endAll, { keepCurrent: false });

    expect(await refusal(current.client.query(api.core.auth.sessions.current, {}))).toBe(
      "unauthenticated",
    );
    expect(await refusal(next.client.query(api.core.auth.sessions.current, {}))).toBe(
      "unauthenticated",
    );
    expect(await signInAs(stack, person)).toBeDefined();
  });

  it("refuses to end another user's session", async () => {
    if (stack === undefined) return;
    const mine = await signInAs(stack, await createPerson(stack));
    const theirs = await signInAs(stack, await createPerson(stack));
    const { sessionId } = await theirs.client.query(api.core.auth.sessions.current, {});

    expect(await refusal(mine.client.mutation(api.core.auth.sessions.end, { sessionId }))).toBe(
      "not_found",
    );
    expect(await theirs.client.query(api.core.auth.sessions.current, {})).toBeDefined();
  });
});
