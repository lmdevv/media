/**
 * How Now Playing offers and shows a song's lyrics, the same on the web and the phone: what the
 * lyrics button says and whether it opens, the source caption, and which timed line playback is
 * in.
 */
import { offlineLyricsOf, TrackLyrics } from "@music/commands/lyrics";
import type { LyricLine, LyricsSource, OfflineLyrics } from "@music/commands/lyrics";
import { commandFailure } from "@music/sdk/errors";

/**
 * `lyrics.get`'s answer as Now Playing shows it: the song's lyrics, `loading` before the first
 * answer, or `failed` when the read failed for a reason that may pass (a dropped connection, an
 * answer this client can't read). A song this person can no longer see (another device's, a
 * Jam's that left the queue) has no lyrics for them, so that refusal reads as `None`.
 */
export type LyricsAnswer = TrackLyrics | "loading" | "failed";

/** Settles `lyrics.get`'s read (`undefined` while it loads, an `Error` when it failed). */
export const lyricsAnswer = (read: TrackLyrics | Error | undefined): LyricsAnswer => {
  if (read === undefined) return "loading";

  if (read instanceof Error) {
    return commandFailure(read)?.code === "not_found" ? TrackLyrics.cases.None.make({}) : "failed";
  }

  return read;
};

/**
 * The lyrics to show while the server can't be counted on (it is out of reach, or this device
 * plays its own session): those the device keeps with its download (`loading` while it reads
 * them), else the server's last answer as a device without the server shows it, else none. A
 * lookup still pending never finishes without the server, so it shows the song's own plain words
 * it carries, or nothing, rather than loading for good.
 */
export const offlineLyrics = (
  served: LyricsAnswer,
  held: OfflineLyrics | "loading" | null,
): LyricsAnswer => {
  if (held !== null) return held;

  if (served === "loading" || served === "failed") return TrackLyrics.cases.None.make({});

  return offlineLyricsOf(served);
};

/**
 * What the lyrics button offers for the playing song: lyrics to show (`ready`), lyrics still
 * being found (`loading`), lyrics that failed to load (`failed`, which the view explains), or
 * nothing (`none`, `instrumental`), which dims it.
 */
export type LyricsOffer = "ready" | "loading" | "failed" | "none" | "instrumental";

/** The offer for an answer: Pending is still looking, Synced and Plain are ready. */
export const lyricsOffer = (answer: LyricsAnswer): LyricsOffer => {
  if (answer === "loading" || answer === "failed") return answer;

  return TrackLyrics.match(answer, {
    Synced: (): LyricsOffer => "ready",
    Plain: (): LyricsOffer => "ready",
    Pending: (): LyricsOffer => "loading",
    None: (): LyricsOffer => "none",
    Instrumental: (): LyricsOffer => "instrumental",
  });
};

/** How the lyrics button looks and reads, the same on desktop and phone. */
export interface LyricsButton {
  /** Accessible name and tooltip. */
  readonly label: string;
  /** Dimmed: the song has no lyrics to open. */
  readonly disabled: boolean;
  /** Shows a spinner in place of the icon while lyrics are being found. */
  readonly loading: boolean;
}

const CLOSED_LABEL: Readonly<Record<LyricsOffer, string>> = {
  ready: "Lyrics",
  loading: "Loading lyrics",
  failed: "Lyrics (couldn't load them)",
  none: "No lyrics for this song",
  instrumental: "Instrumental, no lyrics",
};

/**
 * The lyrics button for an offer, with the lyrics shown (`open`) or not. Open, it always hides
 * them again, even when the lyrics went away while shown.
 */
export const lyricsButton = (offer: LyricsOffer, open: boolean): LyricsButton => ({
  label: open ? "Hide lyrics" : CLOSED_LABEL[offer],
  disabled: !open && (offer === "none" || offer === "instrumental"),
  loading: offer === "loading",
});

/** The source caption under the lyrics, such as `SYNCED LYRICS · LRCLIB` or `LYRICS · FROM FILE`. */
export const lyricsCaption = (body: "Synced" | "Plain", source: LyricsSource): string =>
  `${body === "Synced" ? "SYNCED LYRICS" : "LYRICS"} · ${source === "lrclib" ? "LRCLIB" : "FROM FILE"}`;

/**
 * Where playback stands in timed lines: `started` is the last line that has started (-1 before
 * the first), which the view scrolls to and splits past from upcoming lines by; `sung` says
 * whether that line is still being sung. A line is sung until its own end when it has one, else
 * until the next line starts, so in a gap after an explicit end no line is sung.
 */
export interface LyricsMoment {
  readonly started: number;
  readonly sung: boolean;
}

/** The moment at `positionMs` in `lines`, sorted by start (a binary search, for every frame). */
export const lyricsMoment = (
  lines: ReadonlyArray<Pick<LyricLine, "startMs" | "endMs">>,
  positionMs: number,
): LyricsMoment => {
  let low = 0;
  let high = lines.length - 1;
  let started = -1;

  while (low <= high) {
    const middle = (low + high) >>> 1;
    const line = lines[middle];

    if (line !== undefined && line.startMs <= positionMs) {
      started = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  const endMs = lines[started]?.endMs ?? null;

  return { started, sung: started >= 0 && (endMs === null || positionMs < endMs) };
};

/** Where a timed line stands against playback: sung now, already passed, or still to come. */
export type LyricLineState = "past" | "active" | "upcoming";

/** A line is sung while `moment` says so; lines up to the last started are past, later ones upcoming. */
export const lyricLineState = (index: number, moment: LyricsMoment): LyricLineState => {
  if (index === moment.started && moment.sung) return "active";

  return index <= moment.started ? "past" : "upcoming";
};
