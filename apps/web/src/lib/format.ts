import type { Episode, Progress, TitleCard } from "@media/contracts/models/catalog";

const MINUTE_MS = 60_000;

const wholeMinutes = (ms: number): number => Math.max(0, Math.round(ms / MINUTE_MS));

/** A running time such as `2h 46m` or `52m`. */
export const formatRuntime = (ms: number): string => {
  const minutes = wholeMinutes(ms);
  const hours = Math.floor(minutes / 60);

  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
};

/** Time left such as `1h 03m left` or `41m left`. */
export const formatRemaining = (ms: number): string => {
  const minutes = wholeMinutes(ms);
  const hours = Math.floor(minutes / 60);

  return hours > 0
    ? `${hours}h ${String(minutes % 60).padStart(2, "0")}m left`
    : `${minutes}m left`;
};

/** How far through an item a profile is, from 0 to 1; null without a duration. */
export const progressFraction = (progress: Progress | null): number | null => {
  if (progress === null || progress.durationMs <= 0) return null;

  return Math.min(1, Math.max(0, progress.positionMs / progress.durationMs));
};

/** `S2:E4`, the short code of an episode. */
export const episodeCode = (episode: Pick<Episode, "seasonNumber" | "episodeNumber">): string =>
  `S${episode.seasonNumber}:E${episode.episodeNumber}`;

/** Where a profile stands on an item: `Watched`, `41m left`, or nothing when unstarted. */
export const progressLabel = (progress: Progress | null): string | undefined => {
  if (progress === null) return undefined;

  if (progress.watched) return "Watched";

  return formatRemaining(progress.durationMs - progress.positionMs);
};

/** Joins the present parts with ` · `. */
export const facts = (...parts: ReadonlyArray<string | number | null | undefined>): string =>
  parts
    .flatMap((part) => (part === null || part === undefined || part === "" ? [] : [String(part)]))
    .join(" · ");

/** `52m · 41m left`, or `52m · File missing` for an episode with nothing on disk. */
export const episodeRuntimeFacts = (episode: Episode): string =>
  facts(
    episode.runtimeMs === null ? null : formatRuntime(episode.runtimeMs),
    episode.available ? progressLabel(episode.progress) : "File missing",
  );

/** `2024 · 2h 46m`, the line under a poster in a grid. */
export const titleFacts = (title: TitleCard): string =>
  facts(title.year, title.runtimeMs === null ? null : formatRuntime(title.runtimeMs));

/** `Movie · 2024 · 2h 46m` or `Show · 2024`, the line under a search result. */
export const titleKindFacts = (title: TitleCard): string =>
  facts(title.kind === "movie" ? "Movie" : "Show", titleFacts(title));

/** A count with grouping, such as `1,284`. */
export const formatCount = (count: number): string => count.toLocaleString("en-US");

/** `1 season` or `2 seasons`. */
export const plural = (count: number, one: string, many: string): string =>
  `${formatCount(count)} ${count === 1 ? one : many}`;

const DAY_MS = 86_400_000;

const shortDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

const relative = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });

/** `Oct 9`, a short calendar date. */
export const formatShortDate = (epochMs: number): string => shortDate.format(epochMs);

/** `2 days ago`, `today`, or `in 3 days`, relative to `now` in whole days. */
export const formatDaysFrom = (epochMs: number, now: number): string =>
  relative.format(Math.round((epochMs - now) / DAY_MS), "day");
