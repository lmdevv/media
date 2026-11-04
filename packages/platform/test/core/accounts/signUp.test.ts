import { describe, expect, it } from "vitest";

import { ensureOwner, refusal, signIn, signInAs, unique } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";

const stack = coreStackFromEnvFile();

describe.skipIf(stack === undefined)("sign-up", { timeout: 120_000 }, () => {
  it("has no way in without an invite once the server has an owner", async () => {
    if (stack === undefined) return;
    const person = { username: `stranger-${unique()}`, password: `password-${unique()}` };

    await ensureOwner(stack);

    expect(await refusal(signIn(stack, "setup", person))).toBe("conflict");
    expect(await refusal(signIn(stack, "password", { ...person, flow: "signUp" }))).toMatch(
      /^failed: /u,
    );
    expect(
      await refusal(
        signIn(stack, "invite", { ...person, code: "mi_nothere.aaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
      ),
    ).toBe("expired");
    expect(
      await refusal(
        signIn(stack, "reset", {
          password: person.password,
          code: "mr_nothere.aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        }),
      ),
    ).toBe("expired");
    expect(await refusal(signInAs(stack, person))).toBe("unauthenticated");
  });
});
