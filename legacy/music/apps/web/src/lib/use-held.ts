import { useState } from "react";

/**
 * `value`, or the last value that wasn't undefined while it is: a query's previous result stays on
 * screen while new arguments re-subscribe, so a list or a set of results doesn't flash empty.
 */
export const useHeld = <Value>(value: Value | undefined): Value | undefined => {
  const [held, setHeld] = useState(value);

  // Updating state while rendering, as React documents for values that follow a prop: the render
  // restarts at once, with no effect and no extra frame.
  if (value !== undefined && value !== held) setHeld(value);

  return value ?? held;
};
