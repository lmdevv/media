import { Option } from "effect";
import { describe, expect, it } from "vitest";

import { bufferedAheadSeconds, playerErrorObservation, recoveryObservation } from "./diagnostics";
import { PlaybackStep, PlaybackStop } from "./policy";

describe("player diagnostics on iOS", () => {
  it("measures what AVPlayer holds ahead, and nothing when it does not say", () => {
    expect(bufferedAheadSeconds({ currentTime: 70, bufferedPosition: 94 })).toBe(24);
    expect(bufferedAheadSeconds({ currentTime: 70, bufferedPosition: -1 })).toBe(0);
    expect(bufferedAheadSeconds({ currentTime: 70, bufferedPosition: 0 })).toBe(0);
  });

  it("records an AVPlayer failure with its message, or says it had none", () => {
    expect(playerErrorObservation("The operation could not be completed")).toMatchObject({
      _tag: "PlayerError",
      source: "avplayer",
      detail: "The operation could not be completed",
      fatal: true,
    });
    expect(playerErrorObservation(undefined)).toMatchObject({
      detail: "AVPlayer failed without a message",
    });
  });

  it("records each recovery the controller takes, and nothing for a stop", () => {
    expect(
      Option.getOrNull(recoveryObservation(PlaybackStep.ReloadPlaylist(), "AVPlayer failed")),
    ).toMatchObject({ _tag: "Recovery", action: "reload-playlist", reason: "AVPlayer failed" });
    expect(
      Option.isNone(
        recoveryObservation(PlaybackStep.Stop({ stop: PlaybackStop.Unsupported() }), "x"),
      ),
    ).toBe(true);
  });
});
