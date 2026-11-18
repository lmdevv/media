import { Option } from "effect";
import { describe, expect, it } from "vitest";

import {
  bufferedAheadSeconds,
  type DiagnosedElement,
  frameCounts,
  recoveryObservation,
} from "./diagnostics";
import { PlaybackStep, PlaybackStop } from "./playback-policy";
import { failureObservation } from "./stream-attachment";

const element = (
  currentTime: number,
  ranges: ReadonlyArray<readonly [number, number]>,
): DiagnosedElement => ({
  currentTime,
  buffered: {
    length: ranges.length,
    start: (index) => ranges[index]?.[0] ?? 0,
    end: (index) => ranges[index]?.[1] ?? 0,
  },
});

describe("player diagnostics on the web", () => {
  it("measures what the element holds ahead of its position", () => {
    expect(
      bufferedAheadSeconds(
        element(70, [
          [0, 10],
          [60, 94],
        ]),
      ),
    ).toBe(24);
    expect(bufferedAheadSeconds(element(70, [[0, 10]]))).toBe(0);
    expect(bufferedAheadSeconds(element(70, []))).toBe(0);
  });

  it("reads dropped frames where the browser counts them", () => {
    const counting: DiagnosedElement = {
      ...element(0, []),
      getVideoPlaybackQuality: () => ({ droppedVideoFrames: 3, totalVideoFrames: 900 }),
    };

    expect(frameCounts(counting)).toStrictEqual(Option.some({ dropped: 3, decoded: 900 }));
    expect(Option.isNone(frameCounts(element(0, [])))).toBe(true);
  });

  it("describes a stream failure with its status", () => {
    expect(failureObservation({ kind: "http", status: 404 })).toMatchObject({
      _tag: "PlayerError",
      source: "html-video",
      kind: "http",
      status: 404,
      fatal: true,
    });
    expect(failureObservation({ kind: "media" })).toMatchObject({
      kind: "media",
      status: undefined,
    });
  });

  it("records each recovery the controller takes, and nothing for a stop", () => {
    expect(
      Option.getOrNull(recoveryObservation(PlaybackStep.Renegotiate({ afterMs: 0 }), "gone")),
    ).toMatchObject({ _tag: "Recovery", action: "renegotiate", reason: "gone" });
    expect(
      Option.getOrNull(recoveryObservation(PlaybackStep.TryAnotherWay(), "x".repeat(300))),
    ).toMatchObject({ action: "try-another-way", reason: "x".repeat(120) });
    expect(
      Option.isNone(
        recoveryObservation(PlaybackStep.Stop({ stop: PlaybackStop.Missing() }), "missing"),
      ),
    ).toBe(true);
  });
});
