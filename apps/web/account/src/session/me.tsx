import { createContext, use } from "react";

import type { Me } from "./platform-types";

/** Who the page acts as; null on a public page opened signed out. */
export const MeContext = createContext<Me | null>(null);

/**
 * Who the page acts as, on a page that needs a sign-in.
 *
 * @throws On a public page opened signed out, a programming error.
 */
export const useMe = (): Me => {
  const me = use(MeContext);

  if (me === null) throw new Error("useMe needs a page that requires a sign-in");

  return me;
};

/** The name a person goes by: the display name they set, else their username. */
export const nameOf = (person: Pick<Me, "username" | "displayName">): string =>
  person.displayName ?? person.username;
