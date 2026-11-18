import { nameOf } from "@/lib/models";
import type { Me } from "@/lib/models";

import { useSessionPhase } from "./session-phase";

/**
 * The signed-in person, or null while the app shows its downloads without the server.
 *
 * @throws When used before anyone is signed in, a programming error.
 */
export const useMaybeMe = (): Me | null => {
  const phase = useSessionPhase();

  if (phase.kind === "offline") return null;

  if (phase.kind !== "ready" && phase.kind !== "needsLibrary" && phase.kind !== "scanning") {
    throw new Error("useMaybeMe must be used once signed in or offline");
  }

  return phase.me;
};

/**
 * The signed-in person. Use only on screens that show once signed in.
 *
 * @throws When used before anyone is signed in, or offline, a programming error.
 */
export const useMe = (): Me => {
  const me = useMaybeMe();

  if (me === null) throw new Error("useMe must be used once signed in");

  return me;
};

/** The name the signed-in person goes by, or empty while the app shows its downloads offline. */
export const useMyName = (): string => {
  const me = useMaybeMe();

  return me === null ? "" : nameOf(me);
};
