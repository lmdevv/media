import type { LibraryKind } from "@media/contracts/models/catalog";

const SECOND_MS = 1000;

const MINUTE_MS = 60 * SECOND_MS;

const HOUR_MS = 60 * MINUTE_MS;

const DAY_MS = 24 * HOUR_MS;

const counts = new Intl.NumberFormat("en-US");

const shortDates = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

const longDates = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

const clockTimes = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

/** A count with thousands separators, such as `1,312`. */
export const formatCount = (value: number): string => counts.format(value);

/** `1 title` or `1,312 titles`, for nouns with a regular plural. */
export const plural = (count: number, noun: string): string =>
  `${formatCount(count)} ${count === 1 ? noun : `${noun}s`}`;

/** A calendar date: `Oct 9` this year, `Mar 4, 2025` otherwise. */
export const formatDate = (ms: number, now: number): string =>
  new Date(ms).getFullYear() === new Date(now).getFullYear()
    ? shortDates.format(ms)
    : longDates.format(ms);

/** A date with its year, such as `Jan 9, 2027`. */
export const formatFullDate = (ms: number): string => longDates.format(ms);

/** A 24-hour clock time, such as `03:00`. */
export const formatClock = (ms: number): string => clockTimes.format(ms);

/** A date and time, such as `Oct 8, 03:00`. */
export const formatDateTime = (ms: number, now: number): string =>
  `${formatDate(ms, now)}, ${formatClock(ms)}`;

/** How long ago: `just now`, `2 min ago`, `1 hr ago`, `Yesterday`, `41 days ago`. */
export const formatAgo = (ms: number, now: number): string => {
  const elapsed = Math.max(0, now - ms);

  if (elapsed < MINUTE_MS) return "just now";

  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} min ago`;

  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)} hr ago`;

  if (elapsed < 2 * DAY_MS) return "Yesterday";

  return `${Math.floor(elapsed / DAY_MS)} days ago`;
};

/** How long until: `in 8 min`, `in 3 hr`, `in 5 days`, or `now` once it has passed. */
export const formatUntil = (ms: number, now: number): string => {
  const remaining = ms - now;

  if (remaining <= 0) return "now";

  if (remaining < HOUR_MS) return `in ${Math.max(1, Math.ceil(remaining / MINUTE_MS))} min`;

  if (remaining < DAY_MS) return `in ${Math.round(remaining / HOUR_MS)} hr`;

  return `in ${plural(Math.round(remaining / DAY_MS), "day")}`;
};

/** An elapsed span in the shortest unit, such as `45s`, `4m`, or `2h`. */
export const formatSpan = (ms: number): string => {
  const elapsed = Math.max(0, ms);

  if (elapsed < MINUTE_MS) return `${Math.floor(elapsed / SECOND_MS)}s`;

  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`;

  return `${Math.floor(elapsed / HOUR_MS)}h`;
};

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/** A byte size in decimal units with one decimal from GB up, such as `182 MB` or `4.1 TB`. */
export const formatBytes = (bytes: number): string => {
  let value = Math.max(0, bytes);
  let unit = 0;

  while (value >= 1000 && unit < SIZE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }

  const digits = unit >= 3 && value < 100 ? 1 : 0;

  return `${value.toFixed(digits)} ${SIZE_UNITS[unit] ?? "B"}`;
};

/** A fraction as a whole percentage, such as `62%`. */
export const formatPercent = (fraction: number): string =>
  `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;

/** How each library kind reads in the admin screens. */
export const KIND_LABELS: Readonly<Record<LibraryKind, string>> = {
  movies: "Films",
  shows: "Series",
  mixed: "Mixed",
};
