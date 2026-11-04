import type { ProfileId, TitleId } from "@media/contracts/ids";
import type { TitleCard } from "@media/contracts/models/catalog";
import { useCommand, useCommandQuery } from "@media/sdk/react";
import * as Haptics from "expo-haptics";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { AccessibilityInfo, Alert } from "react-native";

import { watchStates } from "@/lib/browse";
import type { WatchState } from "@/lib/browse";
import { describeFailure } from "@/lib/failure";
import { ActiveProfileContext } from "@/session/active-profile";

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
 * Subscribes to the chosen profile's list and recent history for every screen below, once for the
 * whole app. Mounted above the root stack, so it waits without a profile instead of remounting.
 */
export function TitleStatesProvider({ children }: { readonly children: ReactNode }) {
  const active = useContext(ActiveProfileContext);
  const profileId = active?.profile.id ?? null;
  const list = useCommandQuery("myList.list", profileId === null ? "skip" : { profileId });

  const history = useCommandQuery(
    "history.list",
    profileId === null ? "skip" : { profileId, limit: HISTORY_WINDOW },
  );

  const add = useCommand("myList.add");
  const remove = useCommand("myList.remove");
  const watched = useCommand("history.markWatched");
  const unwatched = useCommand("history.markUnwatched");

  const [removal, setRemoval] = useState<{
    readonly profileId: ProfileId;
    readonly title: TitleCard;
  } | null>(null);

  const removed = removal !== null && removal.profileId === profileId ? removal.title : null;

  useEffect(() => {
    if (removal === null) return undefined;

    const timer = setTimeout(() => setRemoval(null), UNDO_MS);

    return () => clearTimeout(timer);
  }, [removal]);

  const listed = useMemo(
    () => new Set(list.status === "success" ? list.data.map((title) => title.id) : []),
    [list],
  );

  const states = useMemo(
    () => watchStates(history.status === "success" ? history.data.items : []),
    [history],
  );

  const value = useMemo((): TitleStates | null => {
    if (profileId === null) return null;

    return {
      inMyList: (titleId) => listed.has(titleId),
      watchState: (titleId) => states.get(titleId) ?? null,
      addToMyList: async (title) => {
        await settle(add({ profileId, titleId: title.id }));
      },
      removeFromMyList: async (title) => {
        if (await settle(remove({ profileId, titleId: title.id }))) {
          setRemoval({ profileId, title });
          AccessibilityInfo.announceForAccessibility(`Removed ${title.name} from My List`);
        }
      },
      markWatched: async (title) => {
        await settle(watched({ profileId, titleId: title.id }));
      },
      markUnwatched: async (title) => {
        await settle(unwatched({ profileId, titleId: title.id }));
      },
      removed,
      undoRemove: async () => {
        if (removed === null) return;

        setRemoval(null);
        await settle(add({ profileId, titleId: removed.id }));
      },
    };
  }, [profileId, listed, states, add, remove, watched, unwatched, removed]);

  return <TitleStatesContext.Provider value={value}>{children}</TitleStatesContext.Provider>;
}

/**
 * The profile's list and watch states with their actions.
 *
 * @throws When used outside `TitleStatesProvider`, a programming error.
 */
export const useTitleStates = (): TitleStates => {
  const states = useContext(TitleStatesContext);

  if (states === null) {
    throw new Error(
      "useTitleStates must be used inside TitleStatesProvider once a profile is chosen",
    );
  }

  return states;
};
