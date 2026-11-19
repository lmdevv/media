import type { PlatformSdk } from "@media/sdk/promise";
import { usePlatform, usePlatformQuery, usePlatformStatus } from "@media/sdk/react";
import type { QueryState } from "@media/sdk/react";
import { useEffect } from "react";
import type { ComponentType, ReactNode } from "react";

import { guestView, sessionAccess, useIdentityRetry } from "@media/ui/lib/session-identity";

type Guest = NonNullable<Awaited<ReturnType<PlatformSdk["core"]["guests"]["current"]>>>;

type SharedItem = Extract<Guest["target"], { readonly kind: "item" }>["item"];

type Domain = SharedItem["domain"];

type ItemIn<D extends Domain> = Extract<SharedItem, { readonly domain: D }>;

/** A share in one app: what it shares, who shared it, and when the link ends. */
type GuestShareOf<D extends Domain> = {
  readonly item: ItemIn<D>;
  readonly sharedBy: string;
  readonly expiresAt: number;
};

/** The pages an app shows while a guest's read waits, is refused, or fails. */
export type GuestPages = {
  /** While a read loads or the session renews. */
  readonly Blank: ComponentType;
  /** Once the link, or what it shares, is gone. */
  readonly Unavailable: ComponentType;
  /** When the server can't answer; `retry` reads again. */
  readonly Unreachable: ComponentType<{ readonly retry: () => void }>;
};

/** Shows a guest's read through `pages` until it holds data, then `children` with that data. */
export function GuestRead<A>({
  pages,
  state,
  children,
}: {
  readonly pages: GuestPages;
  readonly state: QueryState<A>;
  readonly children: (data: A) => ReactNode;
}): ReactNode {
  useIdentityRetry(state);
  const view = guestView(state);

  if (view.kind === "blank") return <pages.Blank />;

  if (view.kind === "unavailable") return <pages.Unavailable />;

  if (view.kind === "unreachable") return <pages.Unreachable retry={view.retry} />;

  return children(view.data);
}

/**
 * The guest route: a household member goes `home`, a share in the other app opens there, and a
 * share in `domain` renders through `children`.
 */
export function GuestShare<D extends Domain>({
  domain,
  pages,
  home,
  children,
}: {
  readonly domain: D;
  readonly pages: GuestPages;
  readonly home: ReactNode;
  readonly children: (share: GuestShareOf<D>) => ReactNode;
}): ReactNode {
  const status = usePlatformStatus();
  const platform = usePlatform();

  const me = usePlatformQuery(
    platform.core.auth.sessions.current,
    ...(status === "signedIn" ? [] : (["skip"] as const)),
  );

  useIdentityRetry(me);
  const access = sessionAccess(status, me);

  if (access === "household") return home;

  if (access === "failed" && me.status === "error") return <pages.Unreachable retry={me.retry} />;

  if (access === "signedOut") return <pages.Unavailable />;

  if (access === "loading") return <pages.Blank />;

  return (
    <SharedTarget domain={domain} pages={pages}>
      {children}
    </SharedTarget>
  );
}

function SharedTarget<D extends Domain>({
  domain,
  pages,
  children,
}: {
  readonly domain: D;
  readonly pages: GuestPages;
  readonly children: (share: GuestShareOf<D>) => ReactNode;
}) {
  const platform = usePlatform();
  const current = usePlatformQuery(platform.core.guests.current);

  return (
    <GuestRead pages={pages} state={current}>
      {(guest) => {
        if (guest === null || guest.target.kind !== "item") return <pages.Unavailable />;
        const { item } = guest.target;

        if (!isIn(item, domain))
          return <OtherApp to={`/${item.domain}/guest`} Blank={pages.Blank} />;

        return children({ item, sharedBy: guest.sharedBy, expiresAt: guest.expiresAt });
      }}
    </GuestRead>
  );
}

// SAFETY: a type predicate, not checked by the compiler. `domain` is the share union's
// discriminant, so an item whose domain matches is that domain's member.
const isIn = <D extends Domain>(item: SharedItem, domain: D): item is ItemIn<D> =>
  item.domain === domain;

function OtherApp({ to, Blank }: { readonly to: string; readonly Blank: ComponentType }) {
  useEffect(() => {
    window.location.replace(to);
  }, [to]);

  return <Blank />;
}
