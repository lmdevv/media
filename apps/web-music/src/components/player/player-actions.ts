import { toastFailure } from "@/lib/action";

/**
 * Runs a player action without awaiting it. Player actions don't reject (a failure becomes the
 * player `error`); anything else that rejects is reported as a toast.
 */
export const perform = (action: Promise<void>): void => {
  action.catch(toastFailure);
};

/** The repeat mode after the current one when the repeat control is pressed. */
export const NEXT_REPEAT = { off: "all", all: "one", one: "off" } as const;
