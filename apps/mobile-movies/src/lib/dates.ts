/**
 * Days as people say them on this iPhone, in its time zone: `Today`, `Yesterday`, `3 days ago`,
 * `Oct 2`, `Oct 2, 2025`. Hermes has no `Intl.RelativeTimeFormat`, so the wording lives here.
 */

const DAY_MS = 86_400_000;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const startOfDay = (at: number): number => {
  const date = new Date(at);

  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

/**
 * Calendar days from `at` to `now` on this device's calendar: 0 for today, 1 for yesterday, and
 * negative for days still ahead. Rounding absorbs the hour that daylight saving time adds or takes.
 */
export const daysAgo = (at: number, now: number): number =>
  Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);

/** A date such as `Oct 2`, with the year when it is not this year: `Oct 2, 2025`. */
export const shortDate = (at: number, now: number): string => {
  const date = new Date(at);
  const day = `${MONTHS[date.getMonth()] ?? ""} ${date.getDate()}`;

  return date.getFullYear() === new Date(now).getFullYear() ? day : `${day}, ${date.getFullYear()}`;
};

/** When something happened: `Today`, `Yesterday`, `3 days ago`, then the date. */
export const dayLabel = (at: number, now: number): string => {
  const days = daysAgo(at, now);

  if (days <= 0) return "Today";

  if (days === 1) return "Yesterday";

  if (days < 7) return `${days} days ago`;

  return shortDate(at, now);
};
