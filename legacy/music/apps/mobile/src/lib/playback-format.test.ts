import { describe, expect, it } from "vitest";

import {
  clock,
  codecName,
  deviceStatus,
  fileDetails,
  playsOn,
  progressOf,
  remainingClock,
} from "./playback-format";

describe("clock", () => {
  it("prints positions as Paper's scrubber does", () => {
    expect(clock(138_000)).toBe("2:18");
    expect(clock(0)).toBe("0:00");
    expect(clock(59_999)).toBe("0:59");
    expect(clock(3_725_000)).toBe("1:02:05");
  });
});

describe("remainingClock", () => {
  it("counts down with a true minus sign, adding up to the song's length", () => {
    expect(remainingClock(138_000, 308_000)).toBe("−2:50");
    expect(remainingClock(138_700, 308_400)).toBe("−2:50");
    expect(remainingClock(400_000, 308_000)).toBe("−0:00");
  });
});

describe("progressOf", () => {
  it("stays between 0 and 1", () => {
    expect(progressOf(154_000, 308_000)).toBe(0.5);
    expect(progressOf(10, 0)).toBe(0);
    expect(progressOf(400_000, 308_000)).toBe(1);
  });
});

describe("fileDetails", () => {
  it("prints B09's line for a lossless file", () => {
    expect(
      fileDetails({
        codec: "FLAC",
        lossless: true,
        bitrate: 900_000,
        sampleRate: 44_100,
        bitDepth: 16,
      }),
    ).toBe("FLAC · 16-bit / 44.1 kHz");
    expect(
      fileDetails({
        codec: "ALAC",
        lossless: true,
        bitrate: null,
        sampleRate: 96_000,
        bitDepth: 24,
      }),
    ).toBe("ALAC · 24-bit / 96 kHz");
  });

  it("prints the bitrate for a lossy file", () => {
    expect(
      fileDetails({
        codec: "MPEG 1 Layer 3",
        lossless: false,
        bitrate: 320_000,
        sampleRate: 44_100,
        bitDepth: null,
      }),
    ).toBe("MP3 · 320 kbps / 44.1 kHz");
  });

  it("leaves out what the scanner did not find", () => {
    expect(
      fileDetails({
        codec: "Opus",
        lossless: false,
        bitrate: null,
        sampleRate: null,
        bitDepth: null,
      }),
    ).toBe("Opus");
  });
});

describe("codecName", () => {
  it("shortens scanner names and keeps unknown ones", () => {
    expect(codecName("AAC (LC)")).toBe("AAC");
    expect(codecName("Monkey's Audio")).toBe("Monkey's Audio");
  });
});

describe("deviceStatus", () => {
  const now = 1_000_000_000;

  it("says where music plays, and when the others were last seen", () => {
    expect(deviceStatus({ active: true, online: true, lastSeenAt: now }, now)).toBe("Playing now");
    expect(deviceStatus({ active: false, online: true, lastSeenAt: now }, now)).toBe("Online");
    expect(deviceStatus({ active: false, online: false, lastSeenAt: now - 5 * 60_000 }, now)).toBe(
      "Last seen 5 min ago",
    );
    expect(
      deviceStatus({ active: false, online: false, lastSeenAt: now - 3 * 3_600_000 }, now),
    ).toBe("Last seen 3 h ago");
  });
});

describe("playsOn", () => {
  it("offers Pause while playing or about to, and Play otherwise", () => {
    expect(["playing", "buffering", "loading"].every(playsOn)).toBe(true);
    expect(["paused", "failed", "idle"].some(playsOn)).toBe(false);
  });
});
