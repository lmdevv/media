import { describe, expect, it } from "vitest";

import { HERE, idleTransfer, nextTransfer } from "./transfer";
import type { Transfer, TransferEvent } from "./transfer";

const laptop = "laptop";

const speaker = "speaker";

const run = (events: ReadonlyArray<TransferEvent>): Transfer =>
  events.reduce(nextTransfer, idleTransfer);

describe("transfer", () => {
  it("waits until the device it went to plays, then is done", () => {
    expect(run([{ type: "start", to: laptop }])).toStrictEqual({ state: "pending", to: laptop });
    expect(
      run([
        { type: "start", to: laptop },
        { type: "active", active: HERE },
      ]),
    ).toStrictEqual({ state: "pending", to: laptop });
    expect(
      run([
        { type: "start", to: laptop },
        { type: "active", active: laptop },
      ]),
    ).toStrictEqual(idleTransfer);
    expect(
      run([
        { type: "start", to: HERE },
        { type: "active", active: HERE },
      ]),
    ).toStrictEqual(idleTransfer);
  });

  it("fails with the reason, or after waiting too long, until dismissed", () => {
    const refused = run([
      { type: "start", to: laptop },
      { type: "refused", to: laptop, message: "Couldn’t move playback there. Try again." },
    ]);

    expect(refused).toStrictEqual({
      state: "failed",
      to: laptop,
      message: "Couldn’t move playback there. Try again.",
    });
    expect(
      run([
        { type: "start", to: laptop },
        { type: "timeout", to: laptop },
      ]),
    ).toStrictEqual({
      state: "failed",
      to: laptop,
      message: "That device didn’t respond. Check that it’s online and try again.",
    });
    expect(nextTransfer(refused, { type: "dismiss" })).toStrictEqual(idleTransfer);
    expect(nextTransfer(refused, { type: "active", active: laptop })).toBe(refused);
  });

  it("ignores what happens to a move the listener already replaced", () => {
    const events: ReadonlyArray<TransferEvent> = [
      { type: "start", to: laptop },
      { type: "start", to: speaker },
      { type: "refused", to: laptop, message: "Refused" },
      { type: "timeout", to: laptop },
    ];

    expect(run(events)).toStrictEqual({ state: "pending", to: speaker });
  });
});
