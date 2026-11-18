import type { HistoryEntry } from "./catalog";

import { daysAgo } from "./dates";
import { progressLabel } from "./format";

type HistorySection = "Today" | "Yesterday" | "Last Week" | "Last Month" | "Earlier";

/** The heading an entry played at `at` sits under. */
export const historySection = (at: number, now: number): HistorySection => {
  const days = daysAgo(at, now);

  if (days <= 0) return "Today";

  if (days === 1) return "Yesterday";

  if (days < 7) return "Last Week";

  if (days < 31) return "Last Month";

  return "Earlier";
};

/** Entries under their headings, most recent first, without empty headings. */
export const historySections = (
  entries: ReadonlyArray<HistoryEntry>,
  now: number,
): ReadonlyArray<{
  readonly title: HistorySection;
  readonly entries: ReadonlyArray<HistoryEntry>;
}> => {
  const sections: Array<{ title: HistorySection; entries: Array<HistoryEntry> }> = [];

  for (const entry of entries) {
    const title = historySection(entry.lastPlayedAt, now);
    const last = sections.at(-1);

    if (last?.title === title) last.entries.push(entry);
    else sections.push({ title, entries: [entry] });
  }

  return sections;
};

/** The row's name: the movie, or the episode as `3. Who Is Alive?`. */
export const historyName = (entry: HistoryEntry): string =>
  entry.episode === null
    ? entry.title.name
    : `${entry.episode.episodeNumber}. ${entry.episode.name}`;

/**
 * The row's muted line: where a movie stands (`1h 12m left`, `Watched`), or an episode's show and
 * place, `Severance · S2, E3`.
 */
export const historyDetail = (entry: HistoryEntry): string =>
  entry.episode === null
    ? (progressLabel(entry.progress) ?? "")
    : `${entry.title.name} · S${entry.episode.seasonNumber}, E${entry.episode.episodeNumber}`;

/** A stable key for an entry: its title and episode. */
export const historyKey = (entry: HistoryEntry): string =>
  entry.episode === null ? entry.title.id : `${entry.title.id}:${entry.episode.id}`;
