import { usePlatform } from "@media/sdk/react";
import { router } from "expo-router";
import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";

import type { TitleCard, TitleId } from "./catalog";
import { pressedOpen } from "./app-events";
import { createTitleHandoff } from "./title-handoff";
import type { TitleHandoff } from "./title-handoff";

const HandoffContext = createContext<TitleHandoff | null>(null);

/**
 * Holds the cards pressed titles hand their pages, for the platform client above it. Place it
 * below the SDK's `PlatformProvider`; a new client gets a new handoff.
 */
export function TitleHandoffProvider({ children }: { readonly children: ReactNode }) {
  const platform = usePlatform();

  const [handoff, setHandoff] = useState(() => ({
    platform,
    held: createTitleHandoff(platform.movies.titles.get),
  }));

  let current = handoff;

  if (handoff.platform !== platform) {
    current = { platform, held: createTitleHandoff(platform.movies.titles.get) };
    setHandoff(current);
  }

  return <HandoffContext value={current.held}>{children}</HandoffContext>;
}

const useHandoff = (): TitleHandoff => {
  const handoff = useContext(HandoffContext);

  if (handoff === null) throw new Error("useHandoff must be used inside TitleHandoffProvider");

  return handoff;
};

/**
 * The card a press handed the page of title `titleId`, read as the page mounts, or null when the
 * page opened without one, such as from a link.
 */
export const useHandedCard = (titleId: TitleId): TitleCard | null => {
  const handoff = useHandoff();
  const [card] = useState(() => handoff.cardFor(titleId));

  return card;
};

/** The press handlers of a control that opens a title's page. */
export interface TitlePress {
  /** The finger went down: hands the card to the page and starts asking for the page's title. */
  readonly onPressIn: () => void;
  /**
   * Opens the page. With the `press` that asked for it, times the open from its touch until the
   * title's content is in view; an open with no touch, such as a menu action, times nothing.
   */
  readonly onPress: (press?: { readonly nativeEvent: unknown }) => void;
}

/** What every control that opens `title`'s page spreads on itself. */
export const useTitlePress = (title: TitleCard): TitlePress => {
  const handoff = useHandoff();

  return {
    onPressIn: () => handoff.pressing(title),
    onPress: (press) => {
      // VoiceOver's activate and a menu action press without a touch going down first.
      handoff.pressing(title);

      if (press !== undefined) pressedOpen("title", title.id, press);
      router.push(`/title/${title.id}`);
    },
  };
};
