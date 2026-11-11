/** A position such as `1:33:18`, `24:18`, or `0:07`; whole seconds, rounded down. */
export const formatClock = (seconds: number): string => {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");

  return hours > 0
    ? `${String(hours)}:${String(minutes).padStart(2, "0")}:${rest}`
    : `${String(minutes)}:${rest}`;
};

/** Time left as the scrubber's trailing label, with a minus sign: `−1:12:44`. */
export const formatTimeLeft = (positionSeconds: number, durationSeconds: number): string =>
  `−${formatClock(Math.max(0, Math.ceil(durationSeconds) - Math.floor(positionSeconds)))}`;
