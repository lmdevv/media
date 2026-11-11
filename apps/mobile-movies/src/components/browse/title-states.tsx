import { usePlatform } from "@media/sdk/react";
import * as Haptics from "expo-haptics";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { AccessibilityInfo, Alert } from "react-native";

import { watchStates } from "@/lib/browse";
import type { WatchState } from "@/lib/browse";
import type { TitleCard, TitleId } from "@/lib/catalog";
import { describeFailure } from "@/lib/failure";
import { useAllPages, useFirstRows } from "@/lib/pages";
import type { Me } from "@/session/me";
import { SessionPhaseContext } from "@/session/session-phase";

const HISTORY_WINDOW = 100;

const UNDO_MS = 8000;

/** My List membership, watch states, and the actions that change them. */
export interface TitleStates {
  readonly inMyList: (titleId: TitleId) => boolean;
  readonly watchState: (titleId: TitleId) => WatchState | null;
  readonly addToMyList: (title: TitleCard) => Promise<void>;
  readonly removeFromMyList: (title: TitleCard) => Promise<void>;
  readonly markWatched: (title: TitleCard) => Promise<void>;
  readonly markUnwatched: (title: TitleCard) => Promise<void>;
  /** The title last removed from My List while Undo is still offered. */
  readonly removed: TitleCard | null;
  /** Puts the last removed title back on My List. */
  readonly undoRemove: () => Promise<void>;
}

const TitleStatesContext = createContext<TitleStates | null>(null);

const settle = async (change: Promise<unknown>): Promise<boolean> => {
  try {
    await change;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    return true;
  } catch (cause) {
    Alert.alert("Couldn't Update", describeFailure(cause));

    return false;
  }
};

/**
 * Subscribes to the signed-in person's list and recent history for every screen below, once for
 * the whole app. Mounted above the root stack, so it waits while no one is signed in (or offline)
 * instead of remounting.
 */
export function TitleStatesProvider({ children }: { readonly children: ReactNode }) {
  const platform = usePlatform();
  const phase = useContext(SessionPhaseContext);
  const userId: Me["userId"] | null = phase?.kind === "ready" ? phase.me.userId : null;

  const list = useAllPages(
    platform.movies.myList.list,
    userId === null ? "skip" : (paginationOpts) => ({ paginationOpts }),
  );

  const history = useFirstRows(
    platform.movies.history.list,
    userId === null ? "skip" : (paginationOpts) => ({ paginationOpts }),
    HISTORY_WINDOW,
  );

  const { add, remove } = platform.movies.myList;
  const { markWatched: watched, markUnwatched: unwatched } = platform.movies.history;

  const [removal, setRemoval] = useState<{
    readonly userId: Me["userId"];
    readonly title: TitleCard;
  } | null>(null);

  const removed = removal !== null && removal.userId === userId ? removal.title : null;

  useEffect(() => {
    if (removal === null) return undefined;

    const timer = setTimeout(() => setRemoval(null), UNDO_MS);

    return () => clearTimeout(timer);
  }, [removal]);

  const listed = useMemo(
    () => new Set(list.status === "ready" ? list.rows.map((title) => title.id) : []),
    [list],
  );

  const states = useMemo(
    () => watchStates(history.status === "ready" ? history.rows : []),
    [history],
  );

  const value = useMemo((): TitleStates | null => {
    if (userId === null) return null;

    return {
      inMyList: (titleId) => listed.has(titleId),
      watchState: (titleId) => states.get(titleId) ?? null,
      addToMyList: async (title) => {
        await settle(add({ titleId: title.id }));
      },
      removeFromMyList: async (title) => {
        if (await settle(remove({ titleId: title.id }))) {
          setRemoval({ userId, title });
          AccessibilityInfo.announceForAccessibility(`Removed ${title.name} from My List`);
        }
      },
      markWatched: async (title) => {
        await settle(watched({ titleId: title.id }));
      },
      markUnwatched: async (title) => {
        await settle(unwatched({ titleId: title.id }));
      },
      removed,
      undoRemove: async () => {
        if (removed === null) return;

        setRemoval(null);
        await settle(add({ titleId: removed.id }));
      },
    };
  }, [userId, listed, states, add, remove, watched, unwatched, removed]);

  return <TitleStatesContext.Provider value={value}>{children}</TitleStatesContext.Provider>;
}

/**
 * The signed-in person's list and watch states with their actions.
 *
 * @throws When used outside `TitleStatesProvider` or before anyone is signed in, a programming
 *   error.
 */
export const useTitleStates = (): TitleStates => {
  const states = useContext(TitleStatesContext);

  if (states === null) {
    throw new Error("useTitleStates must be used inside TitleStatesProvider once signed in");
  }

  return states;
};
