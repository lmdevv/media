import type { TitleCard, TitleId } from "./catalog";

/** How many pressed titles' cards a handoff holds; past it the one pressed longest ago goes. */
export const HELD_CARDS = 20;

/**
 * What a press on a title hands that title's page before the page has its own answer: the card the
 * row drew, kept by title id, and the page's query, started as the finger goes down.
 *
 * Identity rule: a card is held under its own id and handed only to a page asking for that id, so
 * the page of title B never draws title A's card. The page's answer is the SDK's query for the
 * page's own id, which never answers with another id's result.
 */
export interface TitleHandoff {
  /**
   * A press went down on `card`, or opened it without one (VoiceOver, a menu): holds the card for
   * its page and preloads `movies.titles.get` for it. The SDK keeps the answer five minutes after
   * the last screen stops following it, and keeps at most 50 such answers, so a press that turns
   * into a scroll costs one request for a title the person touched, bounded by those limits.
   */
  readonly pressing: (card: TitleCard) => void;
  /** The card a press held for title `titleId`, or null when nothing pressed it. */
  readonly cardFor: (titleId: TitleId) => TitleCard | null;
}

/** The title page's query, `movies.titles.get`, as far as a handoff starts it. */
export interface TitleQuery {
  readonly preload: (args: { readonly titleId: TitleId }) => Promise<void>;
}

/** A handoff that starts `titles`, holding the last {@link HELD_CARDS} pressed cards. */
export const createTitleHandoff = (titles: TitleQuery): TitleHandoff => {
  // Oldest first: a Map iterates in insertion order, and a press moves its title to the end.
  const held = new Map<TitleId, TitleCard>();

  return {
    pressing: (card) => {
      held.delete(card.id);
      held.set(card.id, card);

      for (const oldest of held.keys()) {
        if (held.size <= HELD_CARDS) break;
        held.delete(oldest);
      }

      void titles.preload({ titleId: card.id });
    },
    cardFor: (titleId) => held.get(titleId) ?? null,
  };
};
