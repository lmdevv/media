import { useEffect, useState } from "react";

/** The current time in epoch milliseconds, refreshed every `intervalMs` while mounted. */
export const useNow = (intervalMs: number): number => {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);

    return () => window.clearInterval(timer);
  }, [intervalMs]);

  return now;
};
