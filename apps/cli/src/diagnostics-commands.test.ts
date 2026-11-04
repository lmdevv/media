import { PlaybackDiagnostics } from "@media/contracts/diagnostics";
import { Option, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  formatLogLine,
  parseDuration,
  parseInstant,
  parseLevel,
  renderTimeline,
} from "./diagnostics-commands";

describe("log flags", () => {
  it("reads durations in milliseconds, seconds, minutes, hours, and days", () => {
    expect(parseDuration("500ms")).toStrictEqual(Option.some(500));
    expect(parseDuration("1.5s")).toStrictEqual(Option.some(1500));
    expect(parseDuration("15m")).toStrictEqual(Option.some(900_000));
    expect(parseDuration("2h")).toStrictEqual(Option.some(7_200_000));
    expect(parseDuration("1d")).toStrictEqual(Option.some(86_400_000));
    expect(Option.isNone(parseDuration("15"))).toBe(true);
    expect(Option.isNone(parseDuration("soon"))).toBe(true);
  });

  it("reads an instant as a duration ago or as a time", () => {
    const now = Date.UTC(2026, 9, 21, 20);

    expect(parseInstant("15m", now)).toStrictEqual(Option.some(now - 900_000));
    expect(parseInstant("2026-10-21T19:00:00Z", now)).toStrictEqual(
      Option.some(Date.UTC(2026, 9, 21, 19)),
    );
    expect(Option.isNone(parseInstant("yesterday-ish", now))).toBe(true);
  });

  it("reads levels in any case", () => {
    expect(parseLevel("warn")).toStrictEqual(Option.some("WARN"));
    expect(parseLevel("Warning")).toStrictEqual(Option.some("WARN"));
    expect(parseLevel("ERROR")).toStrictEqual(Option.some("ERROR"));
    expect(Option.isNone(parseLevel("loud"))).toBe(true);
  });
});

describe("log lines for people", () => {
  it("never prints a control character a player sent, such as a terminal escape", () => {
    const line = JSON.stringify({
      message: "Player.error",
      level: "WARN",
      timestamp: "2026-10-21T20:01:02.123Z",
      annotations: { detail: "\u001b[2Jcleared", kind: "x\u0007y" },
      spans: {},
    });

    const printed = formatLogLine(line);

    expect(printed).not.toMatch(/\p{Cc}/u);
    expect(printed).toContain(String.raw`detail="\u001b[2Jcleared"`);
  });

  it("prints time, level, event, and fields, quoting text with spaces", () => {
    const line = JSON.stringify({
      message: "MediaRoutes.slow_segment",
      level: "WARN",
      timestamp: "2026-10-21T20:01:02.123Z",
      annotations: { sessionId: "s1", elapsedMs: 32_900, reason: "two words", file: null },
      spans: {},
    });

    const printed = formatLogLine(line);

    expect(printed).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.123 WARN  MediaRoutes\.slow_segment/u,
    );
    expect(printed).toContain('sessionId=s1 elapsedMs=32900 reason="two words"');
    expect(printed).not.toContain("file=");
  });

  it("indents a failure's cause and leaves other lines as they are", () => {
    const line = JSON.stringify({
      message: "Backups.failed",
      level: "ERROR",
      timestamp: "2026-10-21T20:01:02.123Z",
      annotations: {},
      cause: "Error: disk full\n    at backup",
    });

    expect(formatLogLine(line).split("\n").slice(1)).toStrictEqual([
      "    Error: disk full",
      "        at backup",
    ]);
    expect(formatLogLine("not json")).toBe("not json");
  });
});

describe("the playback timeline for people", () => {
  const diagnostics = Schema.decodeSync(PlaybackDiagnostics)({
    sessionId: "session_a",
    firstSeenAt: Date.UTC(2026, 9, 21, 20),
    lastSeenAt: Date.UTC(2026, 9, 21, 20, 47),
    platform: "web",
    counts: {
      streams: 1,
      stalls: 1,
      stalledMs: 31_000,
      slowSegments: 1,
      failedRequests: 0,
      playerErrors: 0,
      recoveries: 0,
      slowFragments: 0,
      droppedFrames: 0,
    },
    drift: { status: "not-measured", reason: "No player reports audio/video sync." },
    missing: ["Dropped frames: AVPlayer does not report them."],
    truncated: false,
    entries: [
      {
        at: Date.UTC(2026, 9, 21, 20, 1),
        source: "server",
        kind: "slow-segment",
        level: "WARN",
        streamId: "s1",
        summary: "Segment 12 took 32.9 s: encoder 31.0 s, disk 3 ms, network 1.9 s",
        details: {},
      },
    ],
  });

  it("sums up, says what is not measured or missing, then lists the events", () => {
    const printed = renderTimeline(diagnostics);

    expect(printed).toContain("Playback session session_a (web)");
    expect(printed).toContain("1 stream, 1 stall (31.0 s), 1 slow segment");
    expect(printed).toContain("Audio/video drift: not measured.");
    expect(printed).toContain("  - Dropped frames: AVPlayer does not report them.");
    expect(printed).toMatch(/server +WARN +slow-segment +Segment 12 took 32\.9 s/u);
  });

  it("prints a measured drift with its median, worst, and how it was measured", () => {
    const printed = renderTimeline({
      ...diagnostics,
      drift: {
        status: "measured",
        method: "video-frame-vs-media-clock",
        samples: 54,
        medianMs: -12,
        worstMs: -41,
      },
    });

    expect(printed).toContain(
      "Audio/video drift: median -12 ms, worst -41 ms over 54 samples (video frame against the media clock; negative means the picture trails the sound)",
    );
  });
});
