/**
 * Times as the settings screens word them: `Used 12 minutes ago`, `Expires in 5 days`,
 * `Completed · Today`. Each takes `now` so a test can pin the clock.
 */
const MINUTE = 60_000;

const HOUR = 60 * MINUTE;

const DAY = 24 * HOUR;

const dates = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

/** `1 minute` or `12 minutes`. */
const units = (count: number, unit: string): string =>
  `${String(count)} ${count === 1 ? unit : `${unit}s`}`;

/** How long ago `ms` was: `just now`, `12 minutes ago`, `yesterday`, `3 days ago`, `on 2 Oct`. */
export const ago = (ms: number, now: number): string => {
  const elapsed = now - ms;

  if (elapsed < MINUTE) return "just now";

  if (elapsed < HOUR) return `${units(Math.floor(elapsed / MINUTE), "minute")} ago`;

  if (elapsed < DAY) return `${units(Math.floor(elapsed / HOUR), "hour")} ago`;

  if (elapsed < 2 * DAY) return "yesterday";

  if (elapsed < 7 * DAY) return `${units(Math.floor(elapsed / DAY), "day")} ago`;

  return `on ${dates.format(ms)}`;
};

/** How long until `ms`: `in 5 days`, `in 3 hours`, `in 12 minutes`; null once it has passed. */
export const until = (ms: number, now: number): string | null => {
  const remaining = ms - now;

  if (remaining <= 0) return null;

  if (remaining < HOUR) return `in ${units(Math.max(1, Math.round(remaining / MINUTE)), "minute")}`;

  if (remaining < DAY) return `in ${units(Math.round(remaining / HOUR), "hour")}`;

  return `in ${units(Math.round(remaining / DAY), "day")}`;
};

/** The local calendar day of `ms`: `Today`, `Yesterday`, or a date such as `2 Oct`. */
export const dayOf = (ms: number, now: number): string => {
  const day = new Date(ms).setHours(0, 0, 0, 0);
  const today = new Date(now).setHours(0, 0, 0, 0);

  if (day === today) return "Today";

  if (day === new Date(today).setDate(new Date(today).getDate() - 1)) return "Yesterday";

  return dates.format(ms);
};
