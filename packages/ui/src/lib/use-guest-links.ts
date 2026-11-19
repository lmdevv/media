import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import type { Redacted } from "effect";
import { useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { guestLinkDialog } from "@media/ui/lib/guest-link-dialog";
import type { GuestLinkSelection } from "@media/ui/lib/guest-link-dialog";
import { guestLinkActions } from "@media/ui/lib/guest-link-actions";
import { toastFailure } from "@media/ui/lib/failure";
import { canQueryGuestLinks, guestExpiryDays, guestLinksAllowed } from "@media/ui/lib/guest-links";
import type { GuestLinkRow, GuestTarget } from "@media/ui/lib/guest-links";
import { usePages } from "@media/ui/lib/pages";
import type { Paged } from "@media/ui/lib/pages";
import { copyText } from "@media/ui/lib/secure-context";

/** Reads guest policy only after this session proves it can hold account queries. */
export const useMayShareGuests = (): boolean => {
  const platform = usePlatform();
  const me = usePlatformQuery(platform.core.auth.sessions.current);

  const policy = usePlatformQuery(
    platform.core.guests.status,
    canQueryGuestLinks(me.status === "success" ? me.data : undefined) ? {} : "skip",
  );

  return guestLinksAllowed(policy.status === "success" ? policy.data : undefined);
};

/** The mounted dialog's fields, live rows, and actions. */
export interface GuestLinksModel {
  readonly expiry: string;
  readonly setExpiry: (value: string) => void;
  /** The one-time address, visible only while its live row is open. */
  readonly created: Redacted.Redacted | null;
  /** Create or revoke is awaiting the server. */
  readonly pending: boolean;
  /** A link was made in this dialog; keep Create disabled until it closes or revokes that link. */
  readonly made: boolean;
  readonly copied: boolean;
  readonly list: Paged<GuestLinkRow>;
  /** Null when the expiry is not a whole number of days from 1 to 30. */
  readonly days: number | null;
  readonly create: () => Promise<void>;
  readonly revoke: (linkId: GuestLinkRow["linkId"]) => Promise<void>;
  readonly copy: () => Promise<void>;
}

/** Holds a new secret only for the mounted dialog; list subscriptions never return it. */
export const useGuestLinks = (target: GuestTarget): GuestLinksModel => {
  const links = usePlatform().core.guests.links;

  const [actions] = useState(() =>
    guestLinkActions(target, links, copyText, {
      copied: () => toast.success("Copied link"),
      failed: toastFailure,
    }),
  );

  const state = useSyncExternalStore(actions.subscribe, actions.getSnapshot, actions.getSnapshot);

  const list = usePages(links.list, (paginationOpts) => ({
    whose: "mine" as const,
    target,
    paginationOpts,
  }));

  const rows = list.status === "ready" ? list.rows : [];

  return {
    expiry: state.expiry,
    setExpiry: actions.setExpiry,
    created: actions.visible(rows),
    pending: state.pending,
    made: state.newLink !== null,
    copied: state.copied,
    list,
    days: guestExpiryDays(state.expiry),
    create: actions.create,
    revoke: actions.revoke,
    copy: () => actions.copy(rows),
  };
};

interface GuestLinkDialogModel {
  readonly selected: GuestLinkSelection | null;
  readonly show: (selection: GuestLinkSelection) => void;
  readonly close: () => void;
}

/** Keeps one selection above transient entries, and resets it when sharing permission is lost. */
export const useGuestLinkDialog = (allowed: boolean): GuestLinkDialogModel => {
  const [dialog] = useState(guestLinkDialog);
  const selected = useSyncExternalStore(dialog.subscribe, dialog.getSnapshot, dialog.getSnapshot);

  useEffect(() => {
    dialog.setAllowed(allowed);
  }, [dialog, allowed]);

  return { selected, show: dialog.show, close: dialog.close };
};
