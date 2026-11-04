import { describe, expect, it } from "vitest";

import { reachOf } from "./server-reach";

const connected = { offlinePhase: false, socketLost: false, stalled: false };

describe("reachOf", () => {
  it("keeps the screens online while only a request is slow, and lets the notice say so", () => {
    expect(reachOf({ ...connected, stalled: true })).toEqual({
      reach: "online",
      notice: "reconnecting",
    });
  });

  it("calls a lost socket reconnecting for screens and notice alike", () => {
    expect(reachOf({ ...connected, socketLost: true, stalled: true })).toEqual({
      reach: "reconnecting",
      notice: "reconnecting",
    });
  });

  it("stays offline for a launch that never reached the server", () => {
    expect(reachOf({ offlinePhase: true, socketLost: true, stalled: true })).toEqual({
      reach: "offline",
      notice: "offline",
    });
  });

  it("is online with the socket up and nothing waiting", () => {
    expect(reachOf(connected)).toEqual({ reach: "online", notice: "online" });
  });
});
