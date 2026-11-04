import { PlaybackSessionId, UserId } from "@media/contracts/ids";
import { assert, describe, it } from "vitest";

import { makeFailureBudget } from "./failure-budget.ts";

const grant = (session: string, user = "user_a") => ({
  sessionId: PlaybackSessionId.make(session),
  userId: UserId.make(user),
});

const allowed = (
  budget: ReturnType<typeof makeFailureBudget>,
  session: string,
  count: number,
  now = 0,
  user = "user_a",
): number =>
  Array.from({ length: count }, () => budget.allow(grant(session, user), "failure", now)).filter(
    Boolean,
  ).length;

describe("failure budget", () => {
  it("lets a session log a burst, then counts the rest until it refills", () => {
    const budget = makeFailureBudget();

    assert.strictEqual(allowed(budget, "flood", 100), 30);
    assert.deepStrictEqual(budget.drain(), [{ ...grant("flood"), count: 70 }]);
    assert.deepStrictEqual(budget.drain(), []);
    assert.strictEqual(allowed(budget, "flood", 10, 10_000), 5);
  });

  it("keeps an account's failure budget when refused tokens use up their own", () => {
    const budget = makeFailureBudget();

    const refused = ["one", "two", "three", "four"].reduce(
      (sum, session) =>
        sum +
        Array.from({ length: 30 }, () => budget.allow(grant(session), "token-refused", 0)).filter(
          Boolean,
        ).length,
      0,
    );

    assert.strictEqual(refused, 60);
    assert.strictEqual(allowed(budget, "live", 30), 30);
  });

  it("limits one account across its sessions", () => {
    const budget = makeFailureBudget();

    const total = ["one", "two", "three", "four"].reduce(
      (sum, session) => sum + allowed(budget, session, 30),
      0,
    );

    assert.strictEqual(total, 60);
    assert.strictEqual(allowed(budget, "other", 30, 0, "user_b"), 30);
    assert.deepStrictEqual(
      budget.drain().map((counted) => [counted.sessionId, counted.count]),
      [
        ["three", 30],
        ["four", 30],
      ],
    );
  });
});
