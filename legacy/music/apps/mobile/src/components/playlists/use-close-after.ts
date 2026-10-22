/**
 * Closing a sheet a moment after a quiet confirmation ("Link copied", "Added"), unless the person
 * closed it first: a late close would otherwise pop the page under it.
 */
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
