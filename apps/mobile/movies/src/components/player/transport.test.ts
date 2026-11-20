import { Data } from "effect";
import { describe, expect, it } from "vitest";

import { PlaybackStop } from "@/lib/player/policy";

import type { PlayerPhase } from "./playback-controller";
import { transportOf } from "./transport";
import type { TransportInput } from "./transport";

const Phase = Data.taggedEnum<PlayerPhase>();

const base: TransportInput = {
  phase: Phase.Playing(),
  stopped: false,
  playing: true,
  buffering: false,
  recovering: false,
};

const transport = (change: Partial<TransportInput>) => transportOf({ ...base, ...change });

describe("transportOf", () => {
  it("loads with no note while the stream prepares", () => {
    expect(transport({ phase: Phase.Preparing(), playing: false })).toEqual({
      kind: "loading",
      note: null,
    });
  });

  it("says it is reconnecting while a dropped stream prepares again", () => {
    expect(transport({ phase: Phase.Preparing(), recovering: true })).toEqual({
      kind: "loading",
      note: "Reconnecting…",
    });
  });

  it("loads while the video buffers, playing or paused", () => {
    expect(transport({ buffering: true })).toEqual({ kind: "loading", note: null });
    expect(transport({ buffering: true, playing: false })).toEqual({ kind: "loading", note: null });
    expect(transport({ buffering: true, recovering: true })).toEqual({
      kind: "loading",
      note: "Reconnecting…",
    });
  });

  it("shows pause while playing and play while paused", () => {
    expect(transport({})).toEqual({ kind: "ready", playing: true });
    expect(transport({ playing: false })).toEqual({ kind: "ready", playing: false });
  });

  it("has no transport once playback stops or the start fails", () => {
    expect(transport({ phase: Phase.Stopped({ stop: PlaybackStop.Missing() }) })).toBeNull();
    expect(transport({ phase: Phase.Preparing(), stopped: true })).toBeNull();
    expect(transport({ stopped: true, buffering: true })).toBeNull();
  });
});
