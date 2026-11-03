import type { ReactNode } from "react";

import type { HOTKEYS } from "@/lib/hotkeys";

/**
 * The `HOTKEYS` ids of the key combinations that run the selected row's actions, in the order a
 * preview lays out its buttons: Enter, or Enter with ⌘ (Ctrl elsewhere), Shift, or Alt.
 */
export const CHORDS = [
  "command-menu.enter",
  "command-menu.mod-enter",
  "command-menu.shift-enter",
  "command-menu.alt-enter",
] as const satisfies ReadonlyArray<keyof typeof HOTKEYS>;

export type Chord = (typeof CHORDS)[number];

/** One button in a preview, run by clicking it or by pressing its chord in the search field. */
export interface PreviewAction {
  readonly label: string;
  readonly icon?: ReactNode;
  readonly disabled?: boolean;
  /** Whether the action is still running; it can't run again until it settles. */
  readonly pending?: boolean;
  readonly run: () => void;
}

/**
 * A preview's actions by the chord that runs them, so no two share a chord. The Enter action is
 * the preview's main one: its button is solid, the footer names it, and clicking the row runs it.
 */
export type ChordActions = Readonly<Partial<Record<Chord, PreviewAction>>>;

/** The action `chord` runs, or null when there is none or it is disabled or still running. */
export const runnableAction = (actions: ChordActions, chord: Chord): PreviewAction | null => {
  const action = actions[chord];

  return action === undefined || action.disabled === true || action.pending === true
    ? null
    : action;
};
