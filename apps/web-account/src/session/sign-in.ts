import type { OriginStore, SignedIn, SlotId } from "./origin";

/**
 * Makes a finished sign-in its person's, or, when the core kept another of their sign-ins,
 * forgets this one; whether it promoted. Both name the session the sign-in stored, never what the
 * slot holds by then, so a session another tab saved there since stays.
 */
export const settleSignIn = async (
  store: OriginStore,
  slot: SlotId,
  signedIn: SignedIn,
): Promise<boolean> => {
  if (await store.promote(slot, signedIn)) return true;

  await store.forget(slot, signedIn.session);

  return false;
};
