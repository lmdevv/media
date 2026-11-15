import type { Device } from "@media/player/connect-devices";
import { describe, expect, it } from "vitest";

import { HERE, idleTransfer, nextTransfer, transferArrived } from "./transfer";
import type { Move, Transfer, TransferEvent } from "./transfer";

const phone = { target: HERE, name: "" } as const;

const laptop = { target: "laptop", name: "Chrome on Linux" } as const;

const speaker = { target: "speaker", name: "Den speaker" } as const;

const toLaptop: Move = { id: 1, from: phone, to: laptop };

const toSpeaker: Move = { id: 2, from: phone, to: speaker };

const run = (events: ReadonlyArray<TransferEvent>): Transfer =>
  events.reduce(nextTransfer, idleTransfer);

const laptopPlaying = (pending: boolean): Device => ({
  id: laptop.target,
  name: laptop.name,
  playback: { trackId: "t1", playing: true, positionMs: 30_000, at: 1000, pending },
});

describe("transfer", () => {
  it("waits for the core to take the move, then for the device it went to to answer it", () => {
    expect(run([{ type: "start", move: toLaptop }])).toStrictEqual({
      state: "pending",
      move: toLaptop,
      landed: false,
    });
    expect(
      run([
        { type: "start", move: toLaptop },
        { type: "arrived", id: 1 },
      ]),
    ).toStrictEqual({ state: "pending", move: toLaptop, landed: false });
    expect(
      run([
        { type: "start", move: toLaptop },
        { type: "landed", id: 1 },
        { type: "arrived", id: 1 },
      ]),
    ).toStrictEqual(idleTransfer);
  });

  it("fails with the reason, or after waiting too long, until dismissed", () => {
    const refused = run([
      { type: "start", move: toLaptop },
      { type: "refused", id: 1, message: "Couldn’t move playback there. Try again." },
    ]);

    expect(refused).toStrictEqual({
      state: "failed",
      move: toLaptop,
      message: "Couldn’t move playback there. Try again.",
      landed: false,
    });
    expect(
      run([
        { type: "start", move: toLaptop },
        { type: "landed", id: 1 },
        { type: "timeout", id: 1 },
      ]),
    ).toStrictEqual({
      state: "failed",
      move: toLaptop,
      message: "That device didn’t respond. Check that it’s online and try again.",
      landed: true,
    });
    expect(nextTransfer(refused, { type: "dismiss" })).toStrictEqual(idleTransfer);
    expect(nextTransfer(refused, { type: "arrived", id: 1 })).toBe(refused);
  });

  it("ignores what happens to a move the listener already replaced, even to the same device", () => {
    const again: Move = { ...toLaptop, id: 3 };

    expect(
      run([
        { type: "start", move: toLaptop },
        { type: "start", move: toSpeaker },
        { type: "refused", id: 1, message: "Refused" },
        { type: "timeout", id: 1 },
        { type: "landed", id: 1 },
      ]),
    ).toStrictEqual({ state: "pending", move: toSpeaker, landed: false });
    expect(
      run([
        { type: "start", move: toLaptop },
        { type: "start", move: again },
        { type: "timeout", id: 1 },
      ]),
    ).toStrictEqual({ state: "pending", move: again, landed: false });
  });
});

describe("transferArrived", () => {
  const landed: Transfer = { state: "pending", move: toLaptop, landed: true };

  it("waits while the device Connect follows has only the move's request standing in for it", () => {
    expect(transferArrived(landed, { here: false, devices: [laptopPlaying(true)] })).toBe(false);
    expect(nextTransfer(landed, { type: "timeout", id: 1 })).toMatchObject({ state: "failed" });
  });

  it("counts the move once the device reports the song itself", () => {
    expect(transferArrived(landed, { here: false, devices: [laptopPlaying(false)] })).toBe(true);
  });

  it("counts nothing before the core took the move, as the device's report from before it", () => {
    expect(
      transferArrived(
        { state: "pending", move: toLaptop, landed: false },
        { here: false, devices: [laptopPlaying(false)] },
      ),
    ).toBe(false);
  });

  it("counts a move here once this phone holds the song", () => {
    const here: Transfer = {
      state: "pending",
      move: { id: 4, from: laptop, to: phone },
      landed: true,
    };

    expect(transferArrived(here, { here: false, devices: [laptopPlaying(false)] })).toBe(false);
    expect(transferArrived(here, { here: true, devices: [] })).toBe(true);
  });
});
