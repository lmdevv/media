/** The delay's range and steps, in milliseconds. */
export const SUBTITLE_DELAY = {
  /** What Earlier and Later (and their keys) move it by. */
  stepMs: 100,
  /** How far it goes either way; a subtitle file further off than this is the wrong file. */
  maxMs: 30_000,
  /** The finest delay a typed entry keeps. */
  resolutionMs: 10,
} as const;

/** `ms` held to the delay's range, rounded to its resolution; 0 for something not a number. */
export const clampSubtitleDelay = (ms: number): number => {
  if (Number.isNaN(ms)) return 0;

  const { maxMs, resolutionMs } = SUBTITLE_DELAY;
  const rounded = Math.round(ms / resolutionMs) * resolutionMs;

  // `+ 0` turns a rounded `-0` into `0`.
  return Math.min(maxMs, Math.max(-maxMs, rounded)) + 0;
};

/** The delay in seconds as the player shows it: `0.0`, `+0.5`, `−1.25`. */
export const formatSubtitleDelay = (ms: number): string => {
  const seconds = (Math.abs(ms) / 1000).toFixed(2).replace(/(\.\d)0$/u, "$1");

  if (ms === 0) return seconds;

  return `${ms > 0 ? "+" : "−"}${seconds}`;
};

const SECONDS = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u;

/**
 * The delay a typed entry asks for, in milliseconds, such as `1.5`, `-0.25`, `−2`, or `0,3 s`,
 * held to the range; undefined when the entry is not a number of seconds.
 */
export const parseSubtitleDelay = (text: string): number | undefined => {
  const entry = text.trim().replace(/\s*s$/u, "").replace("−", "-").replace(",", ".");

  return SECONDS.test(entry) ? clampSubtitleDelay(Number(entry) * 1000) : undefined;
};

/** Whether the viewer can adjust the timing of what shows now, or why not. */
export type SubtitleTiming =
  | { readonly adjustable: true }
  | { readonly adjustable: false; readonly reason: string };

/**
 * Whether the delay can apply to `track`, the subtitle chosen: null for none, `loading` for one
 * the playing stream does not list yet (as its stream is negotiated). Picture subtitles are drawn
 * into the video by the media service, which this browser cannot retime.
 */
export const subtitleTiming = (
  track: { readonly kind: "text" | "bitmap" } | "loading" | null,
): SubtitleTiming => {
  if (track === null) return { adjustable: false, reason: "Subtitles are off" };

  if (track === "loading") return { adjustable: false, reason: "Subtitles are loading" };

  if (track.kind === "bitmap") return { adjustable: false, reason: "Burned into the video" };

  return { adjustable: true };
};

/** The parts of a `TextTrackCue` the retimer moves, in seconds. */
export interface CueLike {
  startTime: number;
  endTime: number;
}

/** The parts of a `TextTrack` the retimer reads: its kind, and its cues, null while disabled. */
export interface TextTrackLike {
  readonly kind: string;
  readonly cues: Iterable<CueLike> | null;
}

const DELAYED_KINDS: ReadonlySet<string> = new Set(["subtitles", "captions"]);

/**
 * The parts of a media element the retimer follows. Its `<track>` children fire `load` once their
 * cues are parsed; the track list fires `change` when a track is shown or hidden.
 */
export interface RetimedElement extends EventTarget {
  readonly textTracks: EventTarget & Iterable<TextTrackLike>;
}

interface FileTiming {
  readonly start: number;
  readonly end: number;
}

/**
 * Keeps one element's text track cues `set`'s delay away from where their files put them, also
 * for cues that load later: a track shown for the first time, or the `<track>` elements of a new
 * stream. Each cue's own timing is kept beside it, so any number of changes add no drift.
 */
export class SubtitleRetimer {
  readonly #element: RetimedElement;
  readonly #fileTimings = new WeakMap<CueLike, FileTiming>();
  #delaySeconds = 0;

  constructor(element: RetimedElement) {
    this.#element = element;
    // `load` does not bubble from a `<track>`; the element hears it while it is captured.
    element.addEventListener("load", this.#apply, true);
    element.textTracks.addEventListener("change", this.#apply);
    element.textTracks.addEventListener("addtrack", this.#apply);
  }

  /** Shows every cue `delayMs` later than its file says (earlier when negative). */
  set(delayMs: number): void {
    this.#delaySeconds = delayMs / 1000;
    this.#apply();
  }

  /** Puts every cue back where its file says and stops following the element. */
  dispose(): void {
    this.set(0);
    this.#element.removeEventListener("load", this.#apply, true);
    this.#element.textTracks.removeEventListener("change", this.#apply);
    this.#element.textTracks.removeEventListener("addtrack", this.#apply);
  }

  readonly #apply = (): void => {
    for (const track of this.#element.textTracks) {
      if (!DELAYED_KINDS.has(track.kind)) continue;

      // The list is live and kept in start order: a moved cue changes places in it, so it is read
      // whole before any cue moves.
      for (const cue of Array.from(track.cues ?? [])) this.#move(cue);
    }
  };

  #move(cue: CueLike): void {
    let timing = this.#fileTimings.get(cue);

    if (timing === undefined) {
      timing = { start: cue.startTime, end: cue.endTime };
      this.#fileTimings.set(cue, timing);
    }

    const start = Math.max(0, timing.start + this.#delaySeconds);
    const end = Math.max(0, timing.end + this.#delaySeconds);

    // Setting a cue's time makes the browser re-sort its track, so unchanged cues are left alone.
    if (cue.startTime !== start) cue.startTime = start;

    if (cue.endTime !== end) cue.endTime = end;
  }
}
