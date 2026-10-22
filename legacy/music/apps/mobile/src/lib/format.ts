/** Counts and labels as Paper words them, such as `1,248 songs · 126 albums · 84 artists`. */
import type { LibraryVisibility } from "@music/commands/models";

const grouped = new Intl.NumberFormat("en-US");

/** A count grouped as Paper writes it: `1,248`. */
export const formatCount = (count: number): string => grouped.format(count);

/** `count` with its noun, singular for one: `1 song`, `1,248 songs`. */
export const countOf = (count: number, noun: string, plural = `${noun}s`): string =>
  `${grouped.format(count)} ${count === 1 ? noun : plural}`;

/** Library totals for the summary line under Library's title (A02). */
export const librarySummary = (stats: {
  readonly tracks: number;
  readonly albums: number;
  readonly artists: number;
}): string =>
  [
    countOf(stats.tracks, "song"),
    countOf(stats.albums, "album"),
    countOf(stats.artists, "artist"),
  ].join(" · ");

const VISIBILITY = {
  shared: "Shared",
  restricted: "Some people",
  private: "Only you",
} as const satisfies Record<LibraryVisibility, string>;

/** Who hears a library, then its size, as A02's library rows say: `Shared · 1,106 songs`. */
export const libraryLine = (visibility: LibraryVisibility, tracks: number): string =>
  `${VISIBILITY[visibility]} · ${countOf(tracks, "song")}`;
