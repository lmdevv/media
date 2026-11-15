import { router } from "expo-router";
import { useEffect, useRef } from "react";

/** Returns a function that closes the current sheet after `ms`; leaving cancels it. */
export const useCloseAfter = (ms: number): (() => void) => {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  return () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => router.back(), ms);
  };
};
