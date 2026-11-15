import { describe, expect, it } from "vitest";

import {
  ONLINE_MS,
  activeDevice,
  deviceKind,
  devicePosition,
  ownDevices,
  yieldsTo,
} from "./connect-devices";
import type { ConnectTarget, Device } from "./connect-devices";

const NOW = 1_000_000;

const target = (
  deviceId: string,
  fields: Partial<ConnectTarget> & { readonly name?: string } = {},
): ConnectTarget => ({
  deviceId,
  name: fields.name ?? deviceId,
  mode: "personal",
  playback: null,
  reportedAt: NOW,
  ...fields,
});

const music = (
  trackId: string | null,
  playing: boolean,
): NonNullable<ConnectTarget["playback"]> => ({
  domain: "music",
  item: trackId === null ? null : { domain: "music", ref: { type: "track", id: trackId } },
  playing,
  positionMs: 1000,
  at: NOW,
  pending: false,
});

const device = (id: string, playing: boolean | null): Device => ({
  id,
  name: id,
  playback:
    playing === null ? null : { trackId: "a", playing, positionMs: 0, at: NOW, pending: false },
});

describe("ownDevices", () => {
  it("lists the person's other personal devices that are online, by name", () => {
    const listed = ownDevices(
      [
        target("self"),
        target("tv", { mode: "shared" }),
        target("quiet", { reportedAt: NOW - ONLINE_MS - 1 }),
        target("phone", { name: "Aiko's iPhone", playback: music("a", true) }),
        target("laptop", { name: "Firefox on Linux", reportedAt: NOW - ONLINE_MS }),
      ],
      "self",
      NOW,
    );

    expect(listed).toStrictEqual([
      {
        id: "phone",
        name: "Aiko's iPhone",
        playback: { trackId: "a", playing: true, positionMs: 1000, at: NOW, pending: false },
      },
      { id: "laptop", name: "Firefox on Linux", playback: null },
    ]);
  });

  it("shows a movie playing on a device as no music, and music the caller may not see without its song", () => {
    const listed = ownDevices(
      [
        target("a", { playback: { ...music(null, true), domain: "movies" } }),
        target("b", { playback: music(null, false) }),
      ],
      null,
      NOW,
    );

    expect(listed.map((entry) => entry.playback)).toStrictEqual([
      null,
      { trackId: null, playing: false, positionMs: 1000, at: NOW, pending: false },
    ]);
  });
});

describe("activeDevice", () => {
  it("follows a device that plays over one that holds a song paused", () => {
    expect(activeDevice([device("a", false), device("b", true)], null)?.id).toBe("b");
  });

  it("follows a paused device while none plays, and none while none holds music", () => {
    expect(activeDevice([device("a", null), device("b", false)], null)?.id).toBe("b");
    expect(activeDevice([device("a", null)], null)).toBeNull();
  });

  it("keeps the device it followed while it still plays", () => {
    expect(activeDevice([device("a", true), device("b", true)], "b")?.id).toBe("b");
    expect(activeDevice([device("a", true), device("b", false)], "b")?.id).toBe("a");
  });
});

describe("yieldsTo", () => {
  it("lets a song held paused here go once another device plays", () => {
    expect(yieldsTo({ playing: false }, [device("a", true)])).toBe(true);
    expect(yieldsTo({ playing: false }, [device("a", false)])).toBe(false);
    expect(yieldsTo({ playing: true }, [device("a", true)])).toBe(false);
    expect(yieldsTo(null, [device("a", true)])).toBe(false);
  });
});

describe("devicePosition", () => {
  it("moves on while the device plays and stops at the song's end", () => {
    const playback = { trackId: "a", playing: true, positionMs: 1000, at: NOW, pending: false };

    expect(devicePosition(playback, NOW + 500, 10_000)).toBe(1500);
    expect(devicePosition(playback, NOW + 60_000, 10_000)).toBe(10_000);
    expect(devicePosition({ ...playback, playing: false }, NOW + 500, 10_000)).toBe(1000);
  });
});

describe("deviceKind", () => {
  it("tells a computer's browser by the name the account client gave it", () => {
    expect(deviceKind("Firefox on Linux")).toBe("web");
    expect(deviceKind("Safari on iPad")).toBe("web");
    expect(deviceKind("Chrome")).toBe("web");
    expect(deviceKind("Browser on Windows")).toBe("web");
  });

  it("counts a browser on a phone as a phone, as old music did", () => {
    expect(deviceKind("Safari on iPhone")).toBe("phone");
    expect(deviceKind("Chrome on Android")).toBe("phone");
  });

  it("takes any other name for the phone app", () => {
    expect(deviceKind("Aiko's iPhone")).toBe("phone");
    expect(deviceKind("Chrome cast in the kitchen")).toBe("phone");
  });
});
