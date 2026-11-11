/** The delay's range and steps, in milliseconds. */
export const SUBTITLE_DELAY = {
  /** What Earlier and Later move it by. */
  stepMs: 100,
  /** How far it goes either way; a subtitle file further off than this is the wrong file. */
  maxMs: 30_000,
} as const;

/** `ms` held to the delay's range, rounded to a step; 0 for something not a number. */
export const clampSubtitleDelay = (ms: number): number => {
  if (Number.isNaN(ms)) return 0;

  const { maxMs, stepMs } = SUBTITLE_DELAY;
  const rounded = Math.round(ms / stepMs) * stepMs;

  // `+ 0` turns a rounded `-0` into `0`.
  return Math.min(maxMs, Math.max(-maxMs, rounded)) + 0;
};

/** The delay in seconds as the player shows it: `0.0 s`, `+0.5 s`, `−1.2 s`. */
export const formatSubtitleDelay = (ms: number): string => {
  const seconds = (Math.abs(ms) / 1000).toFixed(1);

  if (ms === 0) return `${seconds} s`;

  return `${ms > 0 ? "+" : "−"}${seconds} s`;
};
