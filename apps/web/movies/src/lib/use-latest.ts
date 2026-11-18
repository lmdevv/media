import { useInsertionEffect, useRef } from "react";

/**
 * The latest `value`, for code that runs after a render: event handlers, observers, timers, and
 * the layout effects and ref callbacks of the same commit, which all see it. Insertion effects run
 * before those, so nothing reads a value from a render React later discards. Never read it during
 * render.
 */
export const useLatest = <Value>(value: Value): { readonly current: Value } => {
  const latest = useRef(value);

  useInsertionEffect(() => {
    latest.current = value;
  });

  return latest;
};
