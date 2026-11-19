import type { GuestTarget } from "./guest-links";

/** A selected item is copied from its entry, independent of the row or menu's lifetime. */
export interface GuestLinkSelection {
  readonly target: GuestTarget;
  readonly name: string;
}

interface GuestLinkDialog {
  readonly getSnapshot: () => GuestLinkSelection | null;
  readonly subscribe: (listener: () => void) => () => void;
  readonly setAllowed: (allowed: boolean) => void;
  readonly show: (selection: GuestLinkSelection) => void;
  readonly close: () => void;
}

/** One dialog above a page's rows; losing permission to share closes it. */
export const guestLinkDialog = (): GuestLinkDialog => {
  let allowed = false;
  let selected: GuestLinkSelection | null = null;
  const listeners = new Set<() => void>();

  const publish = () => {
    for (const listener of listeners) listener();
  };

  return {
    getSnapshot: (): GuestLinkSelection | null => selected,
    subscribe: (listener: () => void) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    setAllowed: (next: boolean) => {
      allowed = next;

      if (!allowed && selected !== null) {
        selected = null;
        publish();
      }
    },
    show: (selection: GuestLinkSelection) => {
      if (!allowed || selected !== null) return;
      selected = selection;
      publish();
    },
    close: () => {
      selected = null;
      publish();
    },
  };
};
