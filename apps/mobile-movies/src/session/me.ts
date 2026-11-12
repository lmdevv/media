import type { AppRecord } from "@media/mobile-core/records";
import type { PlatformSdk } from "@media/sdk/promise";
import { createContext, useContext } from "react";

import { useSessionPhase } from "./session-phase";

/** Who is signed in, as `core.auth.sessions.current` answers: the person, role, and scopes. */
export type Me = Awaited<ReturnType<PlatformSdk["core"]["auth"]["sessions"]["current"]>>;

/**
 * The signed-in person. Use only on screens that show once signed in.
 *
 * @throws When used before anyone is signed in, a programming error.
 */
export const useMe = (): Me => {
  const phase = useSessionPhase();

  if (phase.kind !== "ready" && phase.kind !== "setup") {
    throw new Error("useMe must be used once signed in");
  }

  return phase.me;
};

/** The name a person goes by: the display name they set, else their username. */
export const nameOf = (person: Pick<Me, "username" | "displayName">): string =>
  person.displayName ?? person.username;

/** The person the app shows: who is signed in, or offline, who last was on this server. */
export type Person = NonNullable<AppRecord["person"]>;

/** The person the screens on show belong to, online or offline. */
export const PersonContext = createContext<Person | null>(null);

/**
 * The person the app shows, signed in or offline. Downloads and the player key on it.
 *
 * @throws When used before anyone is signed in, a programming error.
 */
export const usePerson = (): Person => {
  const person = useContext(PersonContext);

  if (person === null) throw new Error("usePerson must be used once signed in or offline");

  return person;
};
