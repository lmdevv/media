/**
 * Text subtitles for the player to draw itself. AVPlayer cannot add a WebVTT file to an HLS stream
 * or a direct file it did not come with, so the player fetches the WebVTT the media service
 * converts each text track to, parses it here, and shows the cues active at the playback position
 * over the video. Styling tags are dropped except italics; voice names and karaoke timestamps are
 * removed, and the common entities decoded.
 */

interface CueSpan {
  readonly text: string;
  readonly italic: boolean;
}

/** One cue: when it shows, in seconds on the media timeline, and its lines. */
export interface Cue {
  readonly start: number;
  readonly end: number;
  readonly lines: ReadonlyArray<ReadonlyArray<CueSpan>>;
}

const TIMING =
  /^\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s+-->\s+((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/u;

const ENTITIES: ReadonlyMap<string, string> = new Map([
  ["&amp;", "&"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&apos;", "'"],
  ["&nbsp;", " "],
  ["&lrm;", "‎"],
  ["&rlm;", "‏"],
]);

const seconds = (stamp: string): number => {
  const parts = stamp.replace(",", ".").split(":").map(Number);

  return parts.reduce((total, part) => total * 60 + part, 0);
};

const decodeEntities = (text: string): string =>
  text.replace(
    /&(?:amp|lt|gt|quot|apos|nbsp|lrm|rlm);/gu,
    (entity) => ENTITIES.get(entity) ?? entity,
  );

const spansOf = (line: string): ReadonlyArray<CueSpan> => {
  const spans: Array<CueSpan> = [];
  let italic = false;

  for (const part of line.split(/(<[^>]*>)/u)) {
    if (part.startsWith("<")) {
      const tag = part.slice(1, -1).trim().toLowerCase();

      if (tag === "i" || tag.startsWith("i.")) italic = true;
      else if (tag === "/i") italic = false;

      continue;
    }

    const text = decodeEntities(part);

    if (text === "") continue;

    const last = spans[spans.length - 1];

    if (last?.italic === italic) spans[spans.length - 1] = { text: last.text + text, italic };
    else spans.push({ text, italic });
  }

  return spans;
};

/**
 * The cues of a WebVTT file, in file order (WebVTT files list cues by start time). Each timing line starts a cue, whose text runs to the
 * next blank line or the next timing line: the media service's converter writes cues without blank
 * lines between them. A cue identifier sits on its own line after a blank line and is skipped, as
 * are notes, styles, and regions outside cues.
 */
export const parseWebVtt = (source: string): ReadonlyArray<Cue> => {
  const lines = source
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n")
    .split("\n");

  const cues: Array<Cue> = [];
  let current: { start: number; end: number; lines: Array<ReadonlyArray<CueSpan>> } | null = null;

  const finish = (): void => {
    if (current !== null && current.end > current.start && current.lines.length > 0) {
      cues.push({ start: current.start, end: current.end, lines: current.lines });
    }

    current = null;
  };

  for (const line of lines) {
    const match = TIMING.exec(line);

    if (match !== null) {
      finish();
      current = { start: seconds(match[1] ?? ""), end: seconds(match[2] ?? ""), lines: [] };
    } else if (line.trim() === "") {
      finish();
    } else if (current !== null) {
      const spans = spansOf(line);

      if (spans.some((span) => span.text.trim() !== "")) current.lines.push(spans);
    }
  }

  finish();

  return cues;
};

/**
 * The cues showing at `positionSeconds` with the viewer's delay: a positive `delayMs` shows each
 * cue later than its file says, a negative one earlier.
 */
export const cuesAt = (
  cues: ReadonlyArray<Cue>,
  positionSeconds: number,
  delayMs: number,
): ReadonlyArray<Cue> => {
  const time = positionSeconds - delayMs / 1000;

  return cues.filter((cue) => cue.start <= time && time < cue.end);
};
