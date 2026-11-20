/**
 * The parts of a `VTTCue` the placement reads and moves. Its `line` is `auto` where the cue's file
 * leaves it at the bottom of the picture, and a negative line number while the placement holds it
 * above the bottom.
 */
export interface PlacedCue {
  line: LineAndPositionSetting;
  readonly snapToLines: boolean;
  readonly vertical: DirectionSetting;
  readonly text: string;
}

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
 * Holds one element's text subtitles some lines above the bottom of the picture, such as over the
 * player's controls, also for cues that load later. A raise applies at once, since a line under
 * the controls cannot be read; a lower one waits until none of the lines it moves shows, so a line
 * never moves down while it is on screen. Cues the file positions itself (a sign at the top,
 * vertical text) keep their place, and do not hold a lower one back.
 *
 * Cues stay snapped to lines, so the browser still stacks cues that show together: a cue of `n`
 * lines raised `lift` lines gets line `-(n + lift)`, which puts its first line `n + lift` lines up
 * from the bottom and its last line `lift` lines up.
 */
export class SubtitlePlacement {
  readonly #element: PlacedElement;
  readonly #linesOf: (cue: PlacedCue) => number;
  readonly #placed = new WeakSet<PlacedCue>();
  #lift = 0;
  #wanted = 0;

  /** @param linesOf - How many lines `cue` takes on screen once its text wraps. */
  constructor(element: PlacedElement, linesOf: (cue: PlacedCue) => number) {
    this.#element = element;
    this.#linesOf = linesOf;
    // Neither event bubbles from a `<track>`; the element hears them while they are captured.
    element.addEventListener("load", this.#onCues, true);
    element.addEventListener("cuechange", this.#onCueChange, true);
    element.textTracks.addEventListener("change", this.#onCues);
    element.textTracks.addEventListener("addtrack", this.#onCues);
  }

  /**
   * Holds the cues `lines` lines above the bottom: at once when that raises them, and once no
   * line shows when it lowers them. Also places the cues again for a new line count, such as
   * after the picture changed size.
   */
  raise(lines: number): void {
    this.#wanted = lines;
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
    for (const track of this.#element.textTracks) {
      if (!PLACED_KINDS.has(track.kind)) continue;

      const showing = new Set(track.activeCues ?? []);
      let movedShowing = false;

      for (const cue of track.cues ?? []) {
        if (isPlacedCue(cue) && this.#movable(cue) && this.#move(cue) && showing.has(cue))
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

  /** Puts `cue` on the line for the lift now; true when that moved it. */
  #move(cue: PlacedCue): boolean {
    const line = this.#lift === 0 ? "auto" : -(this.#linesOf(cue) + this.#lift);

    if (cue.line === line) return false;

    this.#placed.add(cue);
    cue.line = line;

    return true;
  }
}
