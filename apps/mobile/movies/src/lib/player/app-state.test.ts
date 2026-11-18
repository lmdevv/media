import { describe, expect, it } from "vitest";

import { StreamLifecycle } from "./app-state";

describe("StreamLifecycle", () => {
  it("stops a transcode at once when the app goes to the background while paused", () => {
    const lifecycle = new StreamLifecycle(false, true);

    expect(lifecycle.playing(false, "server")).toBe("none");
    expect(lifecycle.appState("background", "server")).toBe("stop");
    expect(lifecycle.parked).toBe(true);
  });

  it("keeps a transcode someone watches in Picture in Picture, and stops it when that closes", () => {
    const lifecycle = new StreamLifecycle(false, true);

    expect(lifecycle.pictureInPicture(true, "server")).toBe("none");
    expect(lifecycle.appState("background", "server")).toBe("none");
    expect(lifecycle.playing(false, "server")).toBe("none");
    expect(lifecycle.pictureInPicture(false, "server")).toBe("stop");
  });

  it("keeps background audio's transcode, and stops it when playback pauses in the background", () => {
    const lifecycle = new StreamLifecycle(false, true);

    expect(lifecycle.appState("background", "server")).toBe("none");
    expect(lifecycle.playing(false, "server")).toBe("stop");
    expect(lifecycle.playing(true, "none")).toBe("none");
    expect(lifecycle.appState("active", "none")).toBe("restart");
  });

  it("keeps a kept download or direct play going whatever happens", () => {
    const lifecycle = new StreamLifecycle(false, false);

    expect(lifecycle.appState("background", "none")).toBe("none");
    expect(lifecycle.pictureInPicture(false, "none")).toBe("none");
    expect(lifecycle.parked).toBe(false);
  });

  it("treats inactive as the foreground", () => {
    const lifecycle = new StreamLifecycle(false, false);

    expect(lifecycle.appState("inactive", "server")).toBe("none");
  });

  it("restarts a stopped stream on the next foreground only, once", () => {
    const lifecycle = new StreamLifecycle(false, false);

    expect(lifecycle.appState("background", "server")).toBe("stop");
    expect(lifecycle.appState("inactive", "none")).toBe("restart");
    expect(lifecycle.appState("active", "none")).toBe("none");
  });

  it("survives a quick background and foreground: stop, then one restart", () => {
    const lifecycle = new StreamLifecycle(false, false);

    expect([
      lifecycle.appState("background", "server"),
      lifecycle.appState("active", "none"),
      lifecycle.appState("background", "none"),
      lifecycle.appState("active", "none"),
    ]).toEqual(["stop", "restart", "none", "none"]);
  });

  it("defers a start that answers after the app went to the background", () => {
    const lifecycle = new StreamLifecycle(false, true);

    expect(lifecycle.appState("background", "none")).toBe("none");
    expect(lifecycle.started()).toBe("defer");
    expect(lifecycle.appState("active", "none")).toBe("restart");
  });

  it("defers a start when the app was already in the background as the player opened", () => {
    const lifecycle = new StreamLifecycle(true, true);

    expect(lifecycle.started()).toBe("defer");
  });

  it("negotiates a start that answers in the foreground", () => {
    expect(new StreamLifecycle(false, true).started()).toBe("negotiate");
  });

  it("does nothing once closed, so a late start or event from a closed player opens nothing", () => {
    const closing = new StreamLifecycle(false, true);

    closing.close();

    expect(closing.started()).toBe("none");
    expect(closing.appState("background", "server")).toBe("none");

    // Close, then replay at once: the new player's lifecycle is its own.
    const replay = new StreamLifecycle(false, true);

    expect(replay.started()).toBe("negotiate");
  });
});
