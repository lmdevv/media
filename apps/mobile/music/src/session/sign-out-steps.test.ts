import { describe, expect, it } from "vitest";

import { signOutInOrder } from "./sign-out-steps";

const recorded = (failing: ReadonlySet<string> = new Set()) => {
  const calls: Array<string> = [];

  const step = (name: string) => async () => {
    calls.push(name);

    if (failing.has(name)) throw new Error(`${name} failed`);
  };

  return {
    calls,
    steps: { release: step("release"), signOut: step("signOut"), wipe: step("wipe") },
  };
};

describe("signOutInOrder", () => {
  it("releases, signs out, then wipes", async () => {
    const { calls, steps } = recorded();

    await signOutInOrder(steps);

    expect(calls).toEqual(["release", "signOut", "wipe"]);
  });

  it("wipes the phone's downloads when signing out rejects, and still rejects", async () => {
    const { calls, steps } = recorded(new Set(["signOut"]));

    await expect(signOutInOrder(steps)).rejects.toThrow("signOut failed");
    expect(calls).toEqual(["release", "signOut", "wipe"]);
  });

  it("signs out though the wipe fails", async () => {
    const { calls, steps } = recorded(new Set(["wipe"]));

    await signOutInOrder(steps);

    expect(calls).toEqual(["release", "signOut", "wipe"]);
  });
});
