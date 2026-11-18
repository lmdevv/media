import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { Redacted } from "effect";
import { useState } from "react";
import { toast } from "sonner";

import { toastFailure } from "@media/ui/lib/failure";
import {
  canQueryGuestLinks,
  guestExpiryDays,
  guestLinksAllowed,
  sameGuestTarget,
} from "@media/ui/lib/guest-links";
import type { GuestLinkRow, GuestTarget } from "@media/ui/lib/guest-links";
import { useAllPages } from "@media/ui/lib/pages";
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
  readonly created: Redacted.Redacted | null;
  readonly pending: boolean;
  readonly copied: boolean;
  readonly rows: ReadonlyArray<GuestLinkRow>;
  readonly days: number | null;
  readonly create: () => Promise<void>;
  readonly revoke: (linkId: GuestLinkRow["linkId"]) => Promise<void>;
  readonly copy: () => Promise<void>;
  readonly loading: boolean;
  readonly failure: { readonly message: string; readonly retry: () => void } | null;
}

/** Holds a new secret only for the mounted dialog; list subscriptions never return it. */
export const useGuestLinks = (target: GuestTarget): GuestLinksModel => {
  const links = usePlatform().core.guests.links;
  const [expiry, setExpiry] = useState("7");

  const [newLink, setNewLink] = useState<{
    readonly url: Redacted.Redacted;
    readonly linkId: Parameters<typeof links.revoke>[0]["linkId"];
  } | null>(null);

  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);

  const pages = useAllPages(links.list, (paginationOpts) => ({
    whose: "mine" as const,
    paginationOpts,
  }));

  const next = pages.status === "ready" ? pages.next : null;

  const days = guestExpiryDays(expiry);

  const rows =
    pages.status === "ready" ? pages.rows.filter((row) => sameGuestTarget(row.target, target)) : [];

  const create = async () => {
    if (days === null || pending) return;
    setPending(true);

    try {
      const result = await links.create({ target, expiresInDays: days });
      setNewLink({ url: Redacted.make(result.url), linkId: result.linkId });
      setCopied(false);
    } catch (cause) {
      toastFailure(cause);
    } finally {
      setPending(false);
    }
  };

  const revoke = async (linkId: Parameters<typeof links.revoke>[0]["linkId"]) => {
    if (pending) return;
    setPending(true);

    try {
      await links.revoke({ linkId });

      if (newLink?.linkId === linkId) setNewLink(null);
    } catch (cause) {
      toastFailure(cause);
    } finally {
      setPending(false);
    }
  };

  const copy = async () => {
    if (newLink === null) return;

    try {
      await copyText(Redacted.value(newLink.url));
      setCopied(true);
      toast.success("Copied link");
    } catch (cause) {
      toastFailure(cause);
    }
  };

  let failure: GuestLinksModel["failure"] = null;

  if (pages.status === "failed") failure = pages;
  else if (next?.kind === "failed") failure = next;

  return {
    expiry,
    setExpiry,
    created: newLink?.url ?? null,
    pending,
    copied,
    rows,
    days,
    create,
    revoke,
    copy,
    loading: pages.status === "loading" || next?.kind === "loading" || next?.kind === "more",
    failure,
  };
};
