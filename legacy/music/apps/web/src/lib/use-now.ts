import { useEffect, useState } from "react";

/** The current time, refreshed every `intervalMs` while `active`, for live clocks and ETAs. */
export const useNow = (intervalMs: number, active = true): number => {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return undefined;

    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);

    return () => window.clearInterval(timer);
  }, [intervalMs, active]);

  return now;
};
