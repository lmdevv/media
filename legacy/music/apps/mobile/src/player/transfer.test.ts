import { DeviceId } from "@music/commands/ids";
import { describe, expect, it } from "vitest";

import { idleTransfer, nextTransfer } from "./transfer";
import type { Transfer, TransferEvent } from "./transfer";

const laptop = DeviceId.make("laptop");

const speaker = DeviceId.make("speaker");

const run = (events: ReadonlyArray<TransferEvent>): Transfer =>
  events.reduce(nextTransfer, idleTransfer);

describe("transfer", () => {
  it("waits for the session to name the device, then is done", () => {
    expect(run([{ type: "start", to: laptop }])).toStrictEqual({ state: "pending", to: laptop });
    expect(
      run([
        { type: "start", to: laptop },
        { type: "session", activeId: null },
      ]),
    ).toStrictEqual({ state: "pending", to: laptop });
    expect(
      run([
        { type: "start", to: laptop },
        { type: "session", activeId: laptop },
      ]),
    ).toStrictEqual(idleTransfer);
  });

  it("fails with the server's reason, or after waiting too long, until dismissed", () => {
    const refused = run([
      { type: "start", to: laptop },
      { type: "refused", to: laptop, message: "That device is not registered" },
    ]);

    expect(refused).toStrictEqual({
      state: "failed",
      to: laptop,
      message: "That device is not registered",
    });
    expect(
      run([
        { type: "start", to: laptop },
        { type: "timeout", to: laptop },
      ]),
    ).toMatchObject({
      state: "failed",
      to: laptop,
    });
    expect(nextTransfer(refused, { type: "dismiss" })).toStrictEqual(idleTransfer);
    expect(nextTransfer(refused, { type: "session", activeId: laptop })).toBe(refused);
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
