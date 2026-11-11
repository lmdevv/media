/**
 * Counts, sizes, and times as the owner screens print them (I02 `186 Titles`, I04 `Today, 3:12 PM`,
 * I11 `842 MB`). Times take `now` so tests and live rows agree on the clock; Hermes has no
 * `Intl.RelativeTimeFormat`, so the words are written here.
 */

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** A count with thousands separators, such as `1,842`. */
export const formatCount = (value: number): string =>
  String(Math.trunc(value)).replace(/\B(?=(?:\d{3})+(?!\d))/gu, ",");

/** `1 Title` or `186 Titles`: a count and its noun in the right number. */
export const countOf = (count: number, singular: string, plural: string): string =>
  `${formatCount(count)} ${count === 1 ? singular : plural}`;

const clock = (date: Date): string => {
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, "0");

  return `${hours % 12 === 0 ? 12 : hours % 12}:${minutes} ${hours < 12 ? "AM" : "PM"}`;
};

const startOfDay = (date: Date): number =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/**
 * A moment as the owner screens name it, in local time: `Today, 3:12 PM`, `Yesterday, 3:08 PM`,
 * `October 15, 3:00 AM` this year, or `October 15, 2025, 3:00 AM` before.
 */
export const formatWhen = (ms: number, now: number): string => {
  const date = new Date(ms);
  const today = new Date(now);
  const days = Math.round((startOfDay(today) - startOfDay(date)) / 86_400_000);

  if (days === 0) return `Today, ${clock(date)}`;

  if (days === 1) return `Yesterday, ${clock(date)}`;

  const day = `${MONTHS[date.getMonth()] ?? ""} ${date.getDate()}`;

  return date.getFullYear() === today.getFullYear()
    ? `${day}, ${clock(date)}`
    : `${day}, ${date.getFullYear()}, ${clock(date)}`;
};

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/** A byte size in decimal units, one decimal from GB up below 100: `842 MB`, `4.2 TB`. */
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

/** A fraction as a whole percentage, such as `68%`. */
export const formatPercent = (fraction: number): string =>
  `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
