/**
 * Hands a secret shown once (a new API key, an invite code, a password reset token) from the
 * screen that made it to the screen that shows it: F05 to F06, F12 to F23, F27 to F28. Route
 * parameters can land in navigation state, deep-link logs, and crash reports, so secrets never
 * travel in them; one waits here, in memory, in a single slot.
 */
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
