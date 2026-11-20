/**
 * The parts of a `VTTCue` the placement reads and moves. Its `line` is `auto` where the cue's file
 * leaves it at the bottom of the picture. `lineAlign` is missing in browsers whose cues lack it.
 */
export interface PlacedCue {
  line: LineAndPositionSetting;
  snapToLines: boolean;
  lineAlign?: LineAlignSetting;
  readonly vertical: DirectionSetting;
  readonly text: string;
}

/** The settings of a `VTTCue` that place it; `lineAlign` is left alone where it is missing. */
export interface CueLine {
  readonly line: LineAndPositionSetting;
  readonly snapToLines: boolean;
  readonly lineAlign?: LineAlignSetting;
}

/**
 * Where to put a cue so its last line sits `liftPx` pixels above the bottom of the video. Takes
 * the lift once for every cue it places, then each cue.
 */
export type CuePosition = (liftPx: number) => (cue: PlacedCue) => CueLine;

/** Line counts for the snapped position, at the video's size now. */
export interface CueLineCounts {
  /** Reads the video's size again and returns one line's height there, 0 while it has no box. */
  readonly lineHeight: () => number;
  /** The lines `cue` takes on screen at the size `lineHeight` last read. */
  readonly count: (cue: PlacedCue) => number;
}

/**
 * Places cues snapped to lines, as Chromium and Firefox pin a cue at a negative line by its first
 * line: a cue of `n` lines raised `lift` lines gets line `-(n + lift)`, which puts its first line
 * `n + lift` lines up from the bottom and its last line `lift` lines up. Snapped cues that show
 * together still stack.
 */
export const snappedPosition =
  (lines: CueLineCounts): CuePosition =>
  (liftPx) => {
    const step = lines.lineHeight();
    const lift = step === 0 ? 0 : Math.ceil(liftPx / step);

    return (cue) => ({ line: -(lines.count(cue) + lift), snapToLines: true });
  };

/**
 * Places cues by the bottom of their last line, a percentage of the video element's height, as
 * WebKit lays an end-aligned cue: exact for any font or caption style, whatever the line count.
 */
export const endAlignedPosition =
  (video: { readonly clientHeight: number }): CuePosition =>
  (liftPx) => {
    const height = video.clientHeight;

    const line =
      height === 0 ? 100 : Math.min(100, Math.max(0, (100 * (height - liftPx)) / height));

    const placed: CueLine = { line, snapToLines: false, lineAlign: "end" };

    return () => placed;
  };

/** A cue as its file leaves it at the bottom of the picture. */
const atBottom = (cue: PlacedCue): CueLine =>
  "lineAlign" in cue
    ? { line: "auto", snapToLines: true, lineAlign: "start" }
    : { line: "auto", snapToLines: true };

/**
 * The parts of a `TextTrack` the placement uses: its cues, and those showing now, are null while
 * it is disabled, and showing it again draws its showing cues anew. A subtitle or caption track's
 * cues are `VTTCue`s, which the DOM types as the `TextTrackCue` they extend.
 */
export interface PlacedTrack {
  readonly kind: string;
  mode: TextTrackMode;
  readonly cues: Iterable<TextTrackCue | PlacedCue> | null;
  readonly activeCues: Iterable<TextTrackCue | PlacedCue> | null;
}

/**
 * The parts of a media element the placement follows. Its `<track>` children fire `load` once
 * their cues are parsed and `cuechange` as cues show and end; the track list fires `change` when
 * a track is shown or hidden.
 */
export interface PlacedElement extends EventTarget {
  readonly textTracks: EventTarget & Iterable<PlacedTrack>;
}

const PLACED_KINDS: ReadonlySet<string> = new Set(["subtitles", "captions"]);

const isPlacedCue = (cue: TextTrackCue | PlacedCue): cue is PlacedCue => "line" in cue;

/**
 * Holds one element's text subtitles some pixels above the bottom of the picture, such as over the
 * player's controls, also for cues that load later. A raise applies at once, since a line under
 * the controls cannot be read; a lower one waits until none of the lines it moves shows, so a line
 * never moves down while it is on screen. Cues the file positions itself (a sign at the top,
 * vertical text) keep their place, and do not hold a lower one back. Lowered to 0, cues get back
 * the settings their file gave them.
 */
export class SubtitlePlacement {
  readonly #element: PlacedElement;
  readonly #position: CuePosition;
  readonly #placed = new WeakSet<PlacedCue>();
  #lift = 0;
  #wanted = 0;

  /** @param position - Where a raised cue goes in this browser. */
  constructor(element: PlacedElement, position: CuePosition) {
    this.#element = element;
    this.#position = position;
    // Neither event bubbles from a `<track>`; the element hears them while they are captured.
    element.addEventListener("load", this.#onCues, true);
    element.addEventListener("cuechange", this.#onCueChange, true);
    element.textTracks.addEventListener("change", this.#onCues);
    element.textTracks.addEventListener("addtrack", this.#onCues);
  }

  /**
   * Holds the last line of each cue `liftPx` pixels above the bottom: at once when that raises
   * them, and once no line shows when it lowers them. Also places the cues again for a new size of
   * the picture.
   */
  raise(liftPx: number): void {
    this.#wanted = liftPx;
    this.#onCues();
  }

  /** Puts every cue back at the bottom and stops following the element. */
  dispose(): void {
    this.#wanted = 0;
    this.#lift = 0;
    this.#place();
    this.#element.removeEventListener("load", this.#onCues, true);
    this.#element.removeEventListener("cuechange", this.#onCueChange, true);
    this.#element.textTracks.removeEventListener("change", this.#onCues);
    this.#element.textTracks.removeEventListener("addtrack", this.#onCues);
  }

  readonly #onCues = (): void => {
    this.#settle();
    this.#place();
  };

  readonly #onCueChange = (): void => {
    if (this.#settle()) this.#place();
  };

  /** Takes the wanted lift where it may apply now; true when the lift changed. */
  #settle(): boolean {
    if (this.#wanted === this.#lift) return false;

    if (this.#wanted < this.#lift && this.#showing()) return false;

    this.#lift = this.#wanted;

    return true;
  }

  #showing(): boolean {
    for (const track of this.#element.textTracks) {
      if (!PLACED_KINDS.has(track.kind) || track.mode !== "showing") continue;

      for (const cue of track.activeCues ?? []) {
        if (isPlacedCue(cue) && this.#movable(cue)) return true;
      }
    }

    return false;
  }

  #place(): void {
    const position = this.#lift === 0 ? atBottom : this.#position(this.#lift);

    for (const track of this.#element.textTracks) {
      if (!PLACED_KINDS.has(track.kind)) continue;

      const showing = new Set(track.activeCues ?? []);
      let movedShowing = false;

      for (const cue of track.cues ?? []) {
        if (
          isPlacedCue(cue) &&
          this.#movable(cue) &&
          this.#move(cue, position(cue)) &&
          showing.has(cue)
        )
          movedShowing = true;
      }

      // Chromium keeps drawing a showing cue where it first put it until its track is shown
      // again; hiding and showing it in one task draws the cue at its new line with no gap.
      if (movedShowing && track.mode === "showing") {
        track.mode = "hidden";
        track.mode = "showing";
      }
    }
  }

  #movable(cue: PlacedCue): boolean {
    return this.#placed.has(cue) || (cue.line === "auto" && cue.snapToLines && cue.vertical === "");
  }

  /** Gives `cue` the settings of `to`; true when that moved it. */
  #move(cue: PlacedCue, to: CueLine): boolean {
    const aligned = to.lineAlign === undefined || cue.lineAlign === to.lineAlign;

    if (cue.line === to.line && cue.snapToLines === to.snapToLines && aligned) return false;

    this.#placed.add(cue);
    cue.line = to.line;
    cue.snapToLines = to.snapToLines;

    if (to.lineAlign !== undefined) cue.lineAlign = to.lineAlign;

    return true;
  }
}
