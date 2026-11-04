/**
 * Prefetching title details on hover and focus. Hovering a card subscribes to its details for a
 * while; the Convex client shares identical subscriptions, so opening the title then renders from
 * data that is already there.
 */
import type { ProfileId, TitleId } from "@media/contracts/ids";
import { useCommandQuery } from "@media/sdk/react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

const KEEP_MS = 30_000;

const MAX_WARM = 8;

const PrefetchContext = createContext<(titleId: TitleId) => void>(() => undefined);

function WarmTitle({
  profileId,
  titleId,
}: {
  readonly profileId: ProfileId;
  readonly titleId: TitleId;
}) {
  useCommandQuery("titles.get", { profileId, titleId });

  return null;
}

/** Keeps hovered titles' details subscribed for `profileId`. */
export function TitlePrefetchProvider({
  profileId,
  children,
}: {
  readonly profileId: ProfileId;
  readonly children: ReactNode;
}) {
  const [warm, setWarm] = useState<ReadonlyArray<{ readonly id: TitleId; readonly at: number }>>(
    [],
  );

  const prefetch = useCallback((titleId: TitleId) => {
    setWarm((current) =>
      [...current.filter((entry) => entry.id !== titleId), { id: titleId, at: Date.now() }].slice(
        -MAX_WARM,
      ),
    );
  }, []);

  useEffect(() => {
    if (warm.length === 0) return undefined;

    const timer = setInterval(() => {
      const cutoff = Date.now() - KEEP_MS;

      setWarm((current) => {
        const kept = current.filter((entry) => entry.at > cutoff);

        return kept.length === current.length ? current : kept;
      });
    }, KEEP_MS / 3);

    return () => clearInterval(timer);
  }, [warm.length]);

  return (
    <PrefetchContext.Provider value={prefetch}>
      {children}
      {warm.map((entry) => (
        <WarmTitle key={entry.id} profileId={profileId} titleId={entry.id} />
      ))}
    </PrefetchContext.Provider>
  );
}

/** Pointer and focus handlers that warm a title's details before it is opened. */
export const usePrefetchTitle = (
  titleId: TitleId,
): { readonly onPointerEnter: () => void; readonly onFocus: () => void } => {
  const prefetch = useContext(PrefetchContext);

  return useMemo(
    () => ({ onPointerEnter: () => prefetch(titleId), onFocus: () => prefetch(titleId) }),
    [prefetch, titleId],
  );
};
