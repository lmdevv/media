/** The clock for times a screen words relative to now, such as `Started 3 minutes ago`. */
import { useEffect, useState } from "react";

/** The current time, updated every `everyMs`. */
export const useNow = (everyMs: number): number => {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);

    return () => clearInterval(timer);
  }, [everyMs]);

  return now;
};
