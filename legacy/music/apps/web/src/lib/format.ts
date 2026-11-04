import type { Track } from "@music/commands/models";

const SECOND = 1000;

const MINUTE = 60 * SECOND;

const HOUR = 60 * MINUTE;

const DAY = 24 * HOUR;

const numbers = new Intl.NumberFormat("en-US");

/** A count with thousands separators, such as `41,902`. */
export const formatCount = (value: number): string => numbers.format(value);

/** A song length or position as `m:ss`, or `h:mm:ss` past an hour. */
export const formatDuration = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / SECOND));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");

  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
};

/** A long total such as `45 min`, `4 h 12 min`, or `3 days 4 h`. */
export const formatTotal = (ms: number): string => {
  if (ms >= DAY) {
    const days = Math.floor(ms / DAY);
    const hours = Math.floor((ms % DAY) / HOUR);

    return `${days} ${days === 1 ? "day" : "days"}${hours > 0 ? ` ${hours} h` : ""}`;
  }

  if (ms >= HOUR) {
    const hours = Math.floor(ms / HOUR);
    const minutes = Math.round((ms % HOUR) / MINUTE);

    return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  }

  return `${Math.max(1, Math.round(ms / MINUTE))} min`;
};

/** `1 song` or `12 songs`; works for any noun with a regular plural. */
export const plural = (count: number, noun: string): string =>
  `${formatCount(count)} ${count === 1 ? noun : `${noun}s`}`;

/**
 * The short quality label shown in badges: `FLAC 24/96` for lossless files with known depth and
 * rate, `MP3 320` for lossy files with a bitrate, otherwise the codec.
 */
export const formatQuality = (
  track: Pick<Track, "codec" | "lossless" | "bitDepth" | "sampleRate" | "bitrate">,
): string => {
  const codec = track.codec.toUpperCase();

  if (track.lossless && track.bitDepth !== null && track.sampleRate !== null) {
    return `${codec} ${track.bitDepth}/${Math.floor(track.sampleRate / 1000)}`;
  }

  if (track.bitrate !== null) return `${codec} ${Math.round(track.bitrate / 1000)}`;

  return codec;
};

const dates = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

const times = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

/** A short calendar date such as `2 Oct`. */
export const formatDate = (ms: number): string => dates.format(ms);

/** `just now`, `5 min ago`, `3 h ago`, `Yesterday`, or a short date for anything older. */
export const formatAgo = (ms: number, now: number = Date.now()): string => {
  const elapsed = now - ms;

  if (elapsed < MINUTE) return "just now";

  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;

  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h ago`;

  if (elapsed < 2 * DAY) return "Yesterday";

  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)} days ago`;

  return formatDate(ms);
};

/** `in 5 days`, `in 3 h`, or `today` for a future time. */
export const formatUntil = (ms: number, now: number = Date.now()): string => {
  const remaining = ms - now;

  if (remaining <= 0) return "now";

  if (remaining < HOUR) return `in ${Math.max(1, Math.round(remaining / MINUTE))} min`;

  if (remaining < DAY) return `in ${Math.round(remaining / HOUR)} h`;

  return `in ${plural(Math.round(remaining / DAY), "day")}`;
};

/** A clock time such as `21:04`. */
export const formatTime = (ms: number): string => times.format(ms);

const weekdays = new Intl.DateTimeFormat("en-US", { weekday: "long" });

/** The day of the week in capitals for the Home eyebrow, such as `FRIDAY`. */
export const weekday = (ms: number): string => weekdays.format(ms).toUpperCase();

/** `Good morning`, `Good afternoon`, or `Good evening` for the local hour. */
export const greeting = (ms: number): string => {
  const hour = new Date(ms).getHours();

  if (hour < 5 || hour >= 18) return "Good evening";

  return hour < 12 ? "Good morning" : "Good afternoon";
};

/** The first letter of a display name, for avatars. */
export const initial = (name: string): string => name.trim().charAt(0).toUpperCase() || "?";
