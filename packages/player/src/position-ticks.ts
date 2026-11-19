import { useEffect, useState } from "react";

const POSITION_INTERVAL_MS = 250;

/** `read()` in whole milliseconds, read again four times a second; `read` must be stable. */
export const usePositionTicks = (read: () => number): number => {
  const [position, setPosition] = useState(() => Math.round(read()));

  useEffect(() => {
    const timer = setInterval(() => {
      setPosition(Math.round(read()));
    }, POSITION_INTERVAL_MS);

    return () => {
      clearInterval(timer);
    };
  }, [read]);

  return position;
};
