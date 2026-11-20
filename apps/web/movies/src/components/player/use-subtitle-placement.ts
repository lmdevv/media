import { useEffect, useRef } from "react";

import type { PlacedCue } from "@/playback/subtitle-placement";
import { SubtitlePlacement } from "@/playback/subtitle-placement";

/** Space between the top of the controls and the last line of a raised subtitle, in pixels. */
const GAP_PX = 8;

/** Chromium and Firefox size cue text at 5% of the shorter side of the video's box. */
const CUE_FONT_SHARE = 0.05;

const COUNTED_KINDS: ReadonlySet<string> = new Set(["subtitles", "captions"]);

/**
 * Counts the lines each cue wraps to over a video by laying its text out offscreen the way
 * Chromium and Firefox lay cues out: in `video::cue`'s font, 5% of the box's shorter side, wrapping
 * at the box's width (the picture's, where bars show at its sides). Counts are kept per cue until
 * the box changes size.
 */
class CueLines {
  readonly #video: HTMLVideoElement;
  readonly #counts = new WeakMap<PlacedCue, { readonly box: string; readonly lines: number }>();
  #box = "";
  #fontPx = 0;
  #widthPx = 0;
  #lineHeightPx = 0;

  constructor(video: HTMLVideoElement) {
    this.#video = video;
  }

  /** One line's height in pixels, 0 while the video has no box. */
  get lineHeightPx(): number {
    return this.#lineHeightPx;
  }

  /** Reads the video's box again, as after a resize. */
  resize(): void {
    const { clientWidth, clientHeight, videoWidth, videoHeight } = this.#video;
    const fontPx = Math.min(clientWidth, clientHeight) * CUE_FONT_SHARE;

    // Safari lays cues over the picture, which is narrower than the box when bars show at its
    // sides; wrapping at the narrower width never counts fewer lines than a browser draws.
    const pictureWidth =
      videoHeight === 0 ? clientWidth : (clientHeight * videoWidth) / videoHeight;

    const widthPx = Math.min(clientWidth, pictureWidth);
    const box = `${String(fontPx)}x${String(widthPx)}`;

    if (box === this.#box) return;

    this.#box = box;
    this.#fontPx = fontPx;
    this.#widthPx = widthPx;
    this.#lineHeightPx = fontPx === 0 ? 0 : (this.#heights([document.createTextNode("M")])[0] ?? 0);
  }

  /** The lines `cue` takes on screen. */
  readonly count = (cue: PlacedCue): number => {
    const counted = this.#counts.get(cue);

    if (counted?.box === this.#box) return counted.lines;

    const short = this.#short(cue);

    if (short !== undefined) {
      this.#counts.set(cue, { box: this.#box, lines: short });

      return short;
    }

    return this.#measure(cue);
  };

  /**
   * The lines of a cue whose every line is too short to wrap, with no layout: no character is
   * wider than the text is tall, and tags only lengthen the text.
   */
  #short(cue: PlacedCue): number | undefined {
    const lines = cue.text.split("\n");
    const ems = this.#widthPx / this.#fontPx;

    return lines.every((line) => line.length <= ems) ? lines.length : undefined;
  }

  /**
   * Lays out `cue` and every other cue of the video still to count at this size together, in one
   * layout, and returns `cue`'s lines.
   */
  #measure(cue: PlacedCue): number {
    if (this.#lineHeightPx === 0) return 1;

    const pending = new Set<PlacedCue>([cue]);

    for (const track of this.#video.textTracks) {
      if (!COUNTED_KINDS.has(track.kind)) continue;

      for (const each of track.cues ?? []) {
        if (
          each instanceof VTTCue &&
          this.#counts.get(each)?.box !== this.#box &&
          this.#short(each) === undefined
        )
          pending.add(each);
      }
    }

    const cues = Array.from(pending);

    const heights = this.#heights(
      cues.map((each) =>
        each instanceof VTTCue ? each.getCueAsHTML() : document.createTextNode(each.text),
      ),
    );

    let lines = 1;

    for (const [index, each] of cues.entries()) {
      const counted = Math.max(1, Math.round((heights[index] ?? 0) / this.#lineHeightPx));

      this.#counts.set(each, { box: this.#box, lines: counted });

      if (each === cue) lines = counted;
    }

    return lines;
  }

  #heights(contents: ReadonlyArray<Node>): Array<number> {
    const mirror = document.createElement("div");

    // `font-family` is `video::cue`'s, in the shared stylesheet.
    mirror.style.cssText = [
      "position:fixed",
      "top:0",
      "left:0",
      "visibility:hidden",
      "pointer-events:none",
      "contain:layout style",
      `width:${String(this.#widthPx)}px`,
      `font-size:${String(this.#fontPx)}px`,
      "font-family:var(--font-sans)",
      "line-height:normal",
      "white-space:pre-line",
      "text-align:center",
    ].join(";");

    const blocks = contents.map((content) => {
      const block = document.createElement("div");

      block.append(content);

      return block;
    });

    mirror.append(...blocks);
    document.body.append(mirror);

    const heights = blocks.map((block) => block.getBoundingClientRect().height);

    mirror.remove();

    return heights;
  }
}

/**
 * Holds `video`'s text subtitles above `controls` while `raised` is set, and lowers them back to
 * the bottom once the line showing when it is cleared ends. Lowers them as well while the iPhone
 * plays the video in its own full screen player, where the page's controls do not show.
 *
 * @param controls - The topmost row of the controls along the bottom of the video, or null where
 *   none show over it.
 * @param raised - The controls show, and the subtitles show in this page: not while casting, in
 *   picture in picture, or on another screen.
 */
export const useSubtitlePlacement = ({
  video,
  controls,
  raised,
}: {
  readonly video: HTMLVideoElement | null;
  readonly controls: HTMLElement | null;
  readonly raised: boolean;
}): void => {
  const placed = useRef<{ readonly placement: SubtitlePlacement; readonly lines: CueLines } | null>(
    null,
  );

  useEffect(() => {
    if (video === null) return undefined;

    const lines = new CueLines(video);
    const placement = new SubtitlePlacement(video, lines.count);

    placed.current = { placement, lines };

    return () => {
      placement.dispose();
      placed.current = null;
    };
  }, [video]);

  useEffect(() => {
    const current = placed.current;

    if (video === null || current === null) return undefined;

    if (!raised || controls === null) {
      current.placement.raise(0);

      return undefined;
    }

    const update = (): void => {
      current.lines.resize();

      const covered =
        video.getBoundingClientRect().bottom - controls.getBoundingClientRect().top + GAP_PX;

      const step = current.lines.lineHeightPx;
      const atBottom = video.webkitDisplayingFullscreen === true || step === 0 || covered <= 0;

      current.placement.raise(atBottom ? 0 : Math.ceil(covered / step));
    };

    const observer = new ResizeObserver(update);

    observer.observe(video);
    observer.observe(controls);
    // `resize` fires when the picture's own size is known or changes.
    video.addEventListener("resize", update);
    video.addEventListener("webkitbeginfullscreen", update);
    video.addEventListener("webkitendfullscreen", update);
    update();

    return () => {
      observer.disconnect();
      video.removeEventListener("resize", update);
      video.removeEventListener("webkitbeginfullscreen", update);
      video.removeEventListener("webkitendfullscreen", update);
    };
  }, [video, controls, raised]);
};
