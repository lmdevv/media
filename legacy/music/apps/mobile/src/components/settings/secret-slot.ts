import { useEffect, useState } from "react";

let slot: string | null = null;

/** Keeps `secret` for the next screen, replacing any secret not yet shown. */
export const holdSecret = (secret: string): void => {
  slot = secret;
};

/**
 * The held secret, read on the screen's first render and then cleared, so it lives only in that
 * screen's state: going back and forward again finds nothing. Null when nothing was held.
 */
export const useHeldSecret = (): string | null => {
  const [secret] = useState(() => slot);

  useEffect(() => {
    slot = null;
  }, []);

  return secret;
};
