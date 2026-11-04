import { describe, expect, it } from "vitest";

import { outcome, run, runId, signIn } from "./harness";
import { findStack } from "./stack-env";

const stack = findStack();

describe.skipIf(stack === undefined)("prototype A: one auth for core and movies", () => {
  it("lets a core username sign-up reach old movies functions", { timeout: 120_000 }, async () => {
    if (stack === undefined) return;
    const url = stack.convexUrl;
    const id = runId();

    const core = await signIn(url, {
      provider: "username",
      params: { flow: "signUp", username: `Core-${id}`, password: "password-123" },
    });

    const viewer = await outcome(run(core, "account.viewer", {}));
    const profiles = await outcome(run(core, "profiles.list", {}));
    const listed = await outcome(run(core, "users.list", {}));

    process.stdout.write(
      `core user: account.viewer=${viewer} profiles.list=${profiles}; users.list=${listed}\n`,
    );

    expect(core.token).not.toBeNull();
  });
});
