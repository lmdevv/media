/**
 * Listening history as the screens show it: Home's "Recently played" lists each song once, most
 * recent first (a song played three times in a row is one row), and History (A06) lists every
 * play under its day: Today, Yesterday, the weekday within a week, then the date.
 */
import type { Track } from "@music/commands/models";

/** One play, as `history.list` returns it, newest first. */
export interface Play {
  readonly playedAt: number;
  readonly track: Track;
}

/** The songs in `plays`, each once at its latest play, newest first, at most `max`. */
export const distinctSongs = (plays: ReadonlyArray<Play>, max: number): ReadonlyArray<Track> => {
  const seen = new Set<string>();
  const songs: Array<Track> = [];

  for (const { track } of plays) {
    if (songs.length === max) break;

    if (seen.has(track.id)) continue;

    seen.add(track.id);
    songs.push(track);
  }

  return songs;
};

/** A row of the History list: a day's heading, or one play with its place in the history. */
export type HistoryRow =
  | { readonly kind: "day"; readonly key: string; readonly label: string }
  | { readonly kind: "play"; readonly key: string; readonly play: Play; readonly index: number };

const DAY_MS = 86_400_000;

/** Local midnight at the start of the day `at` falls in. */
const dayOf = (at: number): number => {
  const date = new Date(at);

  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long" });

const dayInYear = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

const dayWithYear = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** What the heading over the plays of the day starting at `day` says, seen from `now`. */
export const dayLabel = (day: number, now: number): string => {
  const today = dayOf(now);
  // Rounded, so a day that is 23 or 25 hours long across a clock change still counts as one.
  const daysAgo = Math.round((today - day) / DAY_MS);

  if (daysAgo <= 0) return "Today";

  if (daysAgo === 1) return "Yesterday";

  if (daysAgo < 7) return weekday.format(day);

  return new Date(day).getFullYear() === new Date(now).getFullYear()
    ? dayInYear.format(day)
    : dayWithYear.format(day);
};

/** The History list: every play, newest first, under a heading for each day. */
export const historyRows = (plays: ReadonlyArray<Play>, now: number): ReadonlyArray<HistoryRow> => {
  const rows: Array<HistoryRow> = [];
  let current: number | null = null;

  for (const [index, play] of plays.entries()) {
    const day = dayOf(play.playedAt);

    if (day !== current) {
      current = day;
      rows.push({ kind: "day", key: `day:${String(day)}`, label: dayLabel(day, now) });
    }

    rows.push({ kind: "play", key: `${play.track.id}:${String(play.playedAt)}`, play, index });
  }

  return rows;
};
