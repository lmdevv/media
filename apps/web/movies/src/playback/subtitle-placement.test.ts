import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { PlacedCue, PlacedElement, PlacedTrack } from "./subtitle-placement";
import { SubtitlePlacement } from "./subtitle-placement";
import type { RetimedElement, TextTrackLike } from "./subtitle-timing";
import { SubtitleRetimer } from "./subtitle-timing";

/** A cue as a WebVTT file gives it: at the bottom unless its settings place it. */
class FakeCue implements PlacedCue {
  line: LineAndPositionSetting = "auto";
  snapToLines = true;
  vertical: DirectionSetting = "";
  readonly text: string;
  startTime: number;
  endTime: number;

  constructor(text: string, startTime = 0, endTime = 1) {
    this.text = text;
    this.startTime = startTime;
    this.endTime = endTime;
  }
}

/**
 * A text track as a browser keeps it: its cues read as null while it is disabled. It counts the
 * times it was shown again after being hidden, which draws its showing cues anew.
 */
class FakeTrack implements PlacedTrack, TextTrackLike {
  kind = "subtitles";
  loaded: Array<FakeCue> = [];
  readonly active = new Set<FakeCue>();
  redrawn = 0;
  #mode: TextTrackMode = "showing";

  get mode(): TextTrackMode {
    return this.#mode;
  }

  set mode(mode: TextTrackMode) {
    if (this.#mode === "hidden" && mode === "showing") this.redrawn += 1;

    this.#mode = mode;
  }

  get cues(): Iterable<FakeCue> | null {
    return this.mode === "disabled" ? null : this.loaded;
  }

  get activeCues(): Iterable<FakeCue> | null {
    return this.mode === "disabled" ? null : this.active;
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

/** A media element whose `<track>` children report loads and cue changes, as a browser's do. */
class FakeElement extends EventTarget implements PlacedElement, RetimedElement {
  readonly textTracks = new FakeTrackList();

  load(track: FakeTrack, cues: ReadonlyArray<FakeCue>): void {
    track.loaded = [...cues];
    this.dispatchEvent(new Event("load"));
  }

  show(track: FakeTrack, cue: FakeCue): void {
    track.active.add(cue);
    this.dispatchEvent(new Event("cuechange"));
  }

  end(track: FakeTrack, cue: FakeCue): void {
    track.active.delete(cue);
    this.dispatchEvent(new Event("cuechange"));
  }
}

/** Lines as the file breaks them; the browser wraps none of these. */
const linesOf = (cue: PlacedCue): number => cue.text.split("\n").length;

const setup = () => {
  const element = new FakeElement();
  const track = new FakeTrack();
  const one = new FakeCue("One line.");
  const two = new FakeCue("First of two,\nthen the second.");

  element.textTracks.add(track);
  element.load(track, [one, two]);

  return { element, track, one, two, placement: new SubtitlePlacement(element, linesOf) };
};

const lines = (track: FakeTrack) => track.loaded.map((cue) => cue.line);

/** How far up a cue's last line sits, in lines from the bottom. */
const liftOf = (cue: FakeCue): number => (cue.line === "auto" ? 0 : -cue.line - linesOf(cue));

describe("SubtitlePlacement", () => {
  it("raises cues at once, the last line of each the given lines above the bottom", () => {
    const { track, placement } = setup();

    placement.raise(3);

    expect(lines(track)).toEqual([-4, -5]);
  });

  it("raises a line while it shows, and has the track draw it again at its new line", () => {
    const { element, track, one, placement } = setup();

    element.show(track, one);
    placement.raise(2);
    expect(lines(track)).toEqual([-3, -4]);
    expect(track.mode).toBe("showing");
    expect(track.redrawn).toBe(1);

    placement.raise(4);
    expect(lines(track)).toEqual([-5, -6]);
    expect(track.redrawn).toBe(2);

    placement.raise(4);
    expect(track.redrawn).toBe(2);
  });

  it("draws nothing again when no line that moved shows", () => {
    const { element, track, one, placement } = setup();

    placement.raise(2);
    element.show(track, one);
    placement.raise(0);
    element.end(track, one);

    expect(lines(track)).toEqual(["auto", "auto"]);
    expect(track.redrawn).toBe(0);
  });

  it("lowers cues only once the line showing ends", () => {
    const { element, track, one, placement } = setup();

    placement.raise(3);
    element.show(track, one);
    placement.raise(0);
    expect(lines(track)).toEqual([-4, -5]);

    element.end(track, one);
    expect(lines(track)).toEqual(["auto", "auto"]);
  });

  it("keeps a line raised while the next one follows it without a gap", () => {
    const { element, track, one, two, placement } = setup();

    placement.raise(3);
    element.show(track, one);
    placement.raise(1);
    element.show(track, two);
    element.end(track, one);
    expect(lines(track)).toEqual([-4, -5]);

    element.end(track, two);
    expect(lines(track)).toEqual([-2, -3]);
  });

  it("lowers cues at once while no line shows", () => {
    const { track, placement } = setup();

    placement.raise(3);
    placement.raise(1);
    expect(lines(track)).toEqual([-2, -3]);

    placement.raise(0);
    expect(lines(track)).toEqual(["auto", "auto"]);
  });

  it("lowers cues once their track is hidden, as nothing of it shows any more", () => {
    const { element, track, one, placement } = setup();

    placement.raise(3);
    element.show(track, one);
    placement.raise(0);
    track.mode = "disabled";
    track.active.clear();
    element.textTracks.dispatchEvent(new Event("change"));
    track.mode = "showing";
    element.textTracks.dispatchEvent(new Event("change"));

    expect(lines(track)).toEqual(["auto", "auto"]);
  });

  it("does not wait for cues of tracks that do not show, such as metadata", () => {
    const { element, placement, track } = setup();
    const metadata = new FakeTrack();
    const signal = new FakeCue("{}");

    metadata.kind = "metadata";
    element.textTracks.add(metadata);
    element.load(metadata, [signal]);
    placement.raise(3);
    element.show(metadata, signal);
    placement.raise(0);

    expect(lines(track)).toEqual(["auto", "auto"]);
    expect(lines(metadata)).toEqual(["auto"]);
  });

  it("does not wait for a cue the file places, as it does not move", () => {
    const { element, track, one, placement } = setup();
    const sign = new FakeCue("A sign at the top");

    sign.line = 0;
    element.load(track, [one, sign]);
    placement.raise(3);
    element.show(track, sign);
    element.show(track, one);
    placement.raise(0);
    expect(lines(track)).toEqual([-4, 0]);

    element.end(track, one);
    expect(lines(track)).toEqual(["auto", 0]);
  });

  it("leaves cues where their file places them", () => {
    const { element, track, placement } = setup();
    const sign = new FakeCue("A sign at the top");
    const percent = new FakeCue("Placed at 80%");
    const vertical = new FakeCue("縦書き");

    sign.line = 0;
    percent.line = 80;
    percent.snapToLines = false;
    vertical.vertical = "rl";
    element.load(track, [sign, percent, vertical]);

    placement.raise(3);
    expect(lines(track)).toEqual([0, 80, "auto"]);

    placement.raise(0);
    expect(lines(track)).toEqual([0, 80, "auto"]);
  });

  it("raises cues that load later, such as a track shown for the first time or a new stream's", () => {
    const { element, placement } = setup();
    const later = new FakeTrack();
    const hidden = new FakeTrack();

    placement.raise(2);
    element.textTracks.add(later);
    element.load(later, [new FakeCue("Later.")]);
    hidden.mode = "disabled";
    element.textTracks.add(hidden);
    element.load(hidden, [new FakeCue("Shown later.")]);
    hidden.mode = "showing";
    element.textTracks.dispatchEvent(new Event("change"));

    expect(lines(later)).toEqual([-3]);
    expect(lines(hidden)).toEqual([-3]);
  });

  it("places cues again for new line counts, as when the picture changes size", () => {
    const element = new FakeElement();
    const track = new FakeTrack();
    let wrap = 1;
    const placement = new SubtitlePlacement(element, () => wrap);

    element.textTracks.add(track);
    element.load(track, [new FakeCue("A line that wraps on a narrow screen.")]);
    placement.raise(2);
    expect(lines(track)).toEqual([-3]);

    wrap = 2;
    placement.raise(2);
    expect(lines(track)).toEqual([-4]);
  });

  it("puts cues back at the bottom and stops following the element when disposed", () => {
    const { element, track, one, placement } = setup();
    const later = new FakeTrack();

    placement.raise(3);
    element.show(track, one);
    placement.dispose();
    element.textTracks.add(later);
    element.load(later, [new FakeCue("Later.")]);

    expect(lines(track)).toEqual(["auto", "auto"]);
    expect(lines(later)).toEqual(["auto"]);
  });

  it("composes with the subtitle delay, each keeping to its own part of the cues", () => {
    const element = new FakeElement();
    const track = new FakeTrack();

    element.textTracks.add(track);
    element.load(track, [new FakeCue("Ten seconds.", 10, 12)]);

    const placement = new SubtitlePlacement(element, linesOf);
    const retimer = new SubtitleRetimer(element);

    retimer.set(1500);
    placement.raise(2);
    expect(track.loaded.map((cue) => [cue.startTime, cue.endTime, cue.line])).toEqual([
      [11.5, 13.5, -3],
    ]);

    const later = new FakeTrack();

    element.textTracks.add(later);
    element.load(later, [new FakeCue("Later.", 20, 21)]);
    expect(later.loaded.map((cue) => [cue.startTime, cue.endTime, cue.line])).toEqual([
      [21.5, 22.5, -3],
    ]);

    placement.dispose();
    expect(track.loaded.map((cue) => [cue.startTime, cue.line])).toEqual([[11.5, "auto"]]);

    retimer.dispose();
    expect(track.loaded.map((cue) => [cue.startTime, cue.line])).toEqual([[10, "auto"]]);
  });

  it("never moves a showing line down, and holds no line lower than asked", () => {
    type Step =
      | { readonly kind: "raise"; readonly lines: number }
      | { readonly kind: "show" | "end"; readonly cue: 0 | 1 };

    const step: fc.Arbitrary<Step> = fc.oneof(
      fc.record({ kind: fc.constant("raise"), lines: fc.integer({ min: 0, max: 6 }) }),
      fc.record({ kind: fc.constantFrom("show", "end"), cue: fc.constantFrom(0, 1) }),
    );

    fc.assert(
      fc.property(fc.array(step, { maxLength: 30 }), (steps) => {
        const { element, track, one, two, placement } = setup();
        const cues = [one, two] as const;
        let asked = 0;

        for (const each of steps) {
          const before = new Map(cues.map((cue) => [cue, liftOf(cue)]));
          const showing = new Set(track.active);

          if (each.kind === "raise") {
            asked = each.lines;
            placement.raise(each.lines);
          } else if (each.kind === "show") element.show(track, cues[each.cue]);
          else element.end(track, cues[each.cue]);

          for (const cue of cues) {
            expect(liftOf(cue)).toBeGreaterThanOrEqual(asked);

            if (showing.has(cue) && track.active.has(cue)) {
              expect(liftOf(cue)).toBeGreaterThanOrEqual(before.get(cue) ?? 0);
            }
          }

          if (track.active.size === 0) expect(cues.map(liftOf)).toEqual([asked, asked]);
        }
      }),
    );
  });
});
