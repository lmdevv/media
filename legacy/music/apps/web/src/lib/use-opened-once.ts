import { useState } from "react";

/**
 * True from the first render where `open` is true, and from then on. A dialog, menu, or panel that
 * is mounted only once it has opened costs nothing until then, and stays mounted afterwards so its
 * close animation still plays.
 */
export const useOpenedOnce = (open: boolean): boolean => {
  const [opened, setOpened] = useState(open);

  // Updating state while rendering, as React documents for values that follow a prop: the render
  // restarts at once, with no effect and no extra frame.
  if (open && !opened) setOpened(true);

  return opened || open;
};
