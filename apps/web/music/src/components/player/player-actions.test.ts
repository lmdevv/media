import type { Device } from "@media/player/connect-devices";
import { describe, expect, it } from "vitest";

import { moveDone, thisBrowserKind } from "./player-actions";
import type { PendingMove } from "./player-actions";

describe("thisBrowserKind", () => {
  it("counts an iPhone or an Android phone as a phone, and a computer or tablet as a browser", () => {
    expect(thisBrowserKind("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("phone");
    expect(thisBrowserKind("Mozilla/5.0 (Linux; Android 15) Mobile Safari/537.36")).toBe("phone");
    expect(thisBrowserKind("Mozilla/5.0 (Linux; Android 15) Safari/537.36")).toBe("web");
    expect(thisBrowserKind("Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0")).toBe("web");
  });
});

const toDesk: PendingMove = {
  id: 1,
  target: { device: "desk" },
  name: "Chrome on Linux",
  landed: true,
};

const desk = (pending: boolean): Device => ({
  id: "desk",
  name: "Chrome on Linux",
  output: { kind: "local" },
  playback: { trackId: "a", playing: true, positionMs: 30_000, at: 1000, pending },
});

describe("moveDone", () => {
  it("keeps waiting once this browser stopped while the device has not loaded the song", () => {
    expect(moveDone(toDesk, { here: false, devices: [desk(true)] })).toBe(false);
  });

  it("is done once the device reports the song itself", () => {
    expect(moveDone(toDesk, { here: false, devices: [desk(false)] })).toBe(true);
  });

  it("takes no report made before the core took the move", () => {
    expect(moveDone({ ...toDesk, landed: false }, { here: false, devices: [desk(false)] })).toBe(
      false,
    );
  });

  it("is done moving here once this browser holds the song", () => {
    const here: PendingMove = { id: 2, target: "here", name: "this browser", landed: true };

    expect(moveDone(here, { here: false, devices: [desk(false)] })).toBe(false);
    expect(moveDone(here, { here: true, devices: [] })).toBe(true);
  });
});
