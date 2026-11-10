import { describe, expect, it } from "vitest";

import type { CueLike, RetimedElement, TextTrackLike } from "./subtitle-timing";
import {
  SUBTITLE_DELAY,
  SubtitleRetimer,
  clampSubtitleDelay,
  formatSubtitleDelay,
  parseSubtitleDelay,
  subtitleTiming,
} from "./subtitle-timing";

const cue = (startTime: number, endTime: number): CueLike => ({ startTime, endTime });

/**
 * A text track as a browser keeps it: its cues exist once loaded and read as null while the track
 * is disabled, and the list is live, in start time order, as `TextTrack.cues` is: a cue moved
 * past another changes places with it while the list is being read.
 */
class FakeTrack implements TextTrackLike {
  mode: "disabled" | "showing" = "showing";
  kind = "subtitles";
  loaded: Array<CueLike> = [];

  get cues(): Iterable<CueLike> | null {
    if (this.mode === "disabled") return null;

    const loaded = this.loaded;

    return {
      *[Symbol.iterator]() {
        for (let index = 0; index < loaded.length; index += 1) {
          const sorted = loaded.toSorted((left, right) => left.startTime - right.startTime);
          const next = sorted[index];

          if (next !== undefined) yield next;
        }
      },
    };
  }
}

class FakeTrackList extends EventTarget implements Iterable<FakeTrack> {
  readonly #tracks: Array<FakeTrack> = [];

  [Symbol.iterator](): Iterator<FakeTrack> {
    return this.#tracks[Symbol.iterator]();
  }

  add(track: FakeTrack): void {
    this.#tracks.push(track);
    this.dispatchEvent(new Event("addtrack"));
  }
}

class FakeElement extends EventTarget implements RetimedElement {
  readonly textTracks = new FakeTrackList();

  load(track: FakeTrack, cues: ReadonlyArray<CueLike>): void {
    track.loaded = [...cues];
    this.dispatchEvent(new Event("load"));
  }
}

const times = (track: FakeTrack) => track.loaded.map((each) => [each.startTime, each.endTime]);

describe("clampSubtitleDelay", () => {
  it("keeps the delay within the range, in steps of the resolution", () => {
    expect(clampSubtitleDelay(1234)).toBe(1230);
    expect(clampSubtitleDelay(-1236)).toBe(-1240);
    expect(clampSubtitleDelay(SUBTITLE_DELAY.maxMs + 1)).toBe(SUBTITLE_DELAY.maxMs);
    expect(clampSubtitleDelay(-SUBTITLE_DELAY.maxMs - 1)).toBe(-SUBTITLE_DELAY.maxMs);
    expect(clampSubtitleDelay(Number.NaN)).toBe(0);
    expect(Object.is(clampSubtitleDelay(-1), 0)).toBe(true);
  });
});

describe("formatSubtitleDelay", () => {
  it("signs the seconds and keeps a tenth, or hundredths when entered", () => {
    expect(formatSubtitleDelay(0)).toBe("0.0");
    expect(formatSubtitleDelay(500)).toBe("+0.5");
    expect(formatSubtitleDelay(-1200)).toBe("−1.2");
    expect(formatSubtitleDelay(1250)).toBe("+1.25");
    expect(formatSubtitleDelay(-30_000)).toBe("−30.0");
  });
});

describe("parseSubtitleDelay", () => {
  it("reads seconds as people type them", () => {
    expect(parseSubtitleDelay("1.5")).toBe(1500);
    expect(parseSubtitleDelay("+0.25")).toBe(250);
    expect(parseSubtitleDelay("-2")).toBe(-2000);
    expect(parseSubtitleDelay("−1.2")).toBe(-1200);
    expect(parseSubtitleDelay(" 0,3 s ")).toBe(300);
    expect(parseSubtitleDelay(".5")).toBe(500);
  });

  it("holds an entry past the range to its end", () => {
    expect(parseSubtitleDelay("45")).toBe(SUBTITLE_DELAY.maxMs);
    expect(parseSubtitleDelay("-99")).toBe(-SUBTITLE_DELAY.maxMs);
  });

  it("refuses what is not a number of seconds", () => {
    expect(parseSubtitleDelay("")).toBeUndefined();
    expect(parseSubtitleDelay("soon")).toBeUndefined();
    expect(parseSubtitleDelay("1.2.3")).toBeUndefined();
    expect(parseSubtitleDelay("+")).toBeUndefined();
    expect(parseSubtitleDelay("1e3")).toBeUndefined();
  });
});

describe("subtitleTiming", () => {
  const text = { kind: "text" } as const;

  it("adjusts a text subtitle playing in this browser", () => {
    expect(subtitleTiming(text)).toEqual({ adjustable: true });
  });

  it("says why it cannot adjust anything else", () => {
    expect(subtitleTiming(null)).toEqual({ adjustable: false, reason: "Subtitles are off" });
    expect(subtitleTiming({ kind: "bitmap" })).toEqual({
      adjustable: false,
      reason: "Burned into the video",
    });
    expect(subtitleTiming("loading")).toEqual({
      adjustable: false,
      reason: "Subtitles are loading",
    });
  });
});

const setup = () => {
  const element = new FakeElement();
  const track = new FakeTrack();

  element.textTracks.add(track);
  element.load(track, [cue(10, 12), cue(20, 22.5)]);

  return { element, track, retimer: new SubtitleRetimer(element) };
};

describe("SubtitleRetimer", () => {
  it("moves cues later for a positive delay and earlier for a negative one", () => {
    const { track, retimer } = setup();

    retimer.set(1500);
    expect(times(track)).toEqual([
      [11.5, 13.5],
      [21.5, 24],
    ]);

    retimer.set(-2000);
    expect(times(track)).toEqual([
      [8, 10],
      [18, 20.5],
    ]);
  });

  it("goes back to the file's timing at zero, however often the delay changed", () => {
    const { track, retimer } = setup();

    for (const delay of [100, 200, -300, 30_000, -30_000]) retimer.set(delay);
    retimer.set(0);

    expect(times(track)).toEqual([
      [10, 12],
      [20, 22.5],
    ]);
  });

  it("moves every cue when they change places in the track's live list", () => {
    const { track, retimer } = setup();

    retimer.set(30_000);

    expect(times(track)).toEqual([
      [40, 42],
      [50, 52.5],
    ]);
  });

  it("leaves metadata and chapter tracks where their files put them", () => {
    const { element, retimer } = setup();
    const metadata = new FakeTrack();

    metadata.kind = "metadata";
    element.textTracks.add(metadata);
    element.load(metadata, [cue(5, 6)]);
    retimer.set(1000);

    expect(times(metadata)).toEqual([[5, 6]]);
  });

  it("never moves a cue before the start of the film", () => {
    const { track, retimer } = setup();

    retimer.set(-11_000);

    expect(times(track)).toEqual([
      [0, 1],
      [9, 11.5],
    ]);
  });

  it("times cues that load later, such as a track shown for the first time or a new stream's", () => {
    const { element, retimer } = setup();
    const later = new FakeTrack();

    retimer.set(-500);
    element.textTracks.add(later);
    element.load(later, [cue(5, 6)]);

    expect(times(later)).toEqual([[4.5, 5.5]]);
  });

  it("times a track shown again after the delay changed while it was hidden", () => {
    const { element, track, retimer } = setup();

    track.mode = "disabled";
    retimer.set(1000);
    track.mode = "showing";
    element.textTracks.dispatchEvent(new Event("change"));

    expect(times(track)).toEqual([
      [11, 13],
      [21, 23.5],
    ]);
  });

  it("puts the file's timing back and stops following the element when disposed", () => {
    const { element, track, retimer } = setup();
    const later = new FakeTrack();

    retimer.set(2000);
    retimer.dispose();
    element.textTracks.add(later);
    element.load(later, [cue(5, 6)]);

    expect(times(track)).toEqual([
      [10, 12],
      [20, 22.5],
    ]);
    expect(times(later)).toEqual([[5, 6]]);
  });
});
