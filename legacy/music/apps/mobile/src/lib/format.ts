/** Counts and labels as Paper words them, such as `1,248 songs · 126 albums · 84 artists`. */
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

const tenths = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/** A size as iOS writes it, in decimal units: `850 KB`, `412 MB`, `1.4 GB`. */
export const formatBytes = (bytes: number): string => {
  if (bytes >= 999_500_000) return `${tenths.format(bytes / 1e9)} GB`;

  if (bytes >= 999_500) return `${grouped.format(Math.round(bytes / 1e6))} MB`;

  return `${grouped.format(Math.max(1, Math.round(bytes / 1e3)))} KB`;
};
