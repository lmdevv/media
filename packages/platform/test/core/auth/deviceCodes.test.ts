import { ConvexHttpClient } from "convex/browser";
import { describe, expect, it } from "vitest";

import { api } from "../../../convex/_generated/api";
import { createPerson, refusal, signIn, signInAs } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";
import type { CoreStack } from "../../stack-env";

const stack = coreStackFromEnvFile();

const start = (core: CoreStack) =>
  new ConvexHttpClient(core.url, { logger: false }).action(api.core.auth.deviceCodes.start, {
    clientName: "living room TV",
  });

describe.skipIf(stack === undefined)("device code sign-in", { timeout: 120_000 }, () => {
  it("signs a device in once someone approves it, into one session", async () => {
    if (stack === undefined) return;
    const person = await createPerson(stack);
    const approver = await signInAs(stack, person);
    const device = await start(stack);

    expect(device.userCode).toMatch(/^[B-DF-HJ-NP-TV-XZ]{4}-[B-DF-HJ-NP-TV-XZ]{4}$/u);
    expect(await refusal(signIn(stack, "deviceCode", { deviceCode: device.deviceCode }))).toBe(
      "pending",
    );

    const typed = device.userCode.toLowerCase().replace("-", " ");

    expect(
      await approver.client.query(api.core.auth.deviceCodes.lookup, { userCode: typed }),
    ).toMatchObject({
      clientName: "living room TV",
      state: "pending",
    });

    await approver.client.mutation(api.core.auth.deviceCodes.approve, {
      userCode: typed,
      scopes: [],
    });

    const signedIn = await signIn(stack, "deviceCode", { deviceCode: device.deviceCode });

    expect(await signedIn.client.query(api.core.auth.sessions.current, {})).toMatchObject({
      username: person.username,
      kind: "deviceCode",
      scopes: [],
    });
    const again = await signIn(stack, "deviceCode", { deviceCode: device.deviceCode });

    expect(await again.client.query(api.core.auth.sessions.current, {})).toMatchObject({
      sessionId: (await signedIn.client.query(api.core.auth.sessions.current, {})).sessionId,
    });
    expect(
      await approver.client.query(api.core.auth.deviceCodes.lookup, { userCode: device.userCode }),
    ).toMatchObject({ state: "redeemed" });
  });

  it("tells a refused device so", async () => {
    if (stack === undefined) return;
    const approver = await signInAs(stack, await createPerson(stack));
    const device = await start(stack);

    await approver.client.mutation(api.core.auth.deviceCodes.deny, { userCode: device.userCode });

    expect(await refusal(signIn(stack, "deviceCode", { deviceCode: device.deviceCode }))).toBe(
      "denied",
    );
    expect(
      await refusal(
        approver.client.mutation(api.core.auth.deviceCodes.approve, {
          userCode: device.userCode,
          scopes: [],
        }),
      ),
    ).toBe("conflict");
  });

  it("voids an approval when the approver ends all their sessions before the device signs in", async () => {
    if (stack === undefined) return;
    const person = await createPerson(stack);
    const approver = await signInAs(stack, person);
    const device = await start(stack);

    await approver.client.mutation(api.core.auth.deviceCodes.approve, {
      userCode: device.userCode,
      scopes: ["account"],
    });
    await approver.client.mutation(api.core.auth.sessions.endAll, { keepCurrent: true });

    expect(await refusal(signIn(stack, "deviceCode", { deviceCode: device.deviceCode }))).toBe(
      "expired",
    );
  });

  it("ends a device session with every other session", async () => {
    if (stack === undefined) return;
    const person = await createPerson(stack);
    const approver = await signInAs(stack, person);
    const device = await start(stack);

    await approver.client.mutation(api.core.auth.deviceCodes.approve, {
      userCode: device.userCode,
      scopes: ["account"],
    });

    const signedIn = await signIn(stack, "deviceCode", { deviceCode: device.deviceCode });

    await approver.client.mutation(api.core.auth.sessions.endAll, { keepCurrent: false });

    expect(await refusal(signedIn.client.query(api.core.auth.sessions.current, {}))).toBe(
      "unauthenticated",
    );
  });

  it("refuses a wrong device code and an unknown user code", async () => {
    if (stack === undefined) return;
    const approver = await signInAs(stack, await createPerson(stack));
    const device = await start(stack);

    expect(
      await refusal(
        signIn(stack, "deviceCode", { deviceCode: `${device.deviceCode.slice(0, -4)}AAAA` }),
      ),
    ).toBe("expired");
    expect(
      await refusal(
        approver.client.query(api.core.auth.deviceCodes.lookup, { userCode: "BBBB-BBBB" }),
      ),
    ).toBe("not_found");
  });
});
