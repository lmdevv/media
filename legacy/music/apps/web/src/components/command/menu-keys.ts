import type { ReactNode } from "react";

import { ALT, MOD, hasMod } from "../../lib/keys";

/**
 * A key combination that runs one of the selected row's actions. `mod` is the platform's command
 * key: ⌘ on Apple devices, Ctrl elsewhere.
 */
export type Chord = "enter" | "mod+enter" | "shift+enter" | "alt+enter";

/** Every chord, in the order a preview lays out its buttons. */
export const CHORDS: ReadonlyArray<Chord> = ["enter", "mod+enter", "shift+enter", "alt+enter"];

type MenuKey =
  | { readonly kind: "next" }
  | { readonly kind: "previous" }
  | { readonly kind: "run"; readonly chord: Chord };

/** How each chord is drawn on a keycap. */
export const CHORD_LABELS: Readonly<Record<Chord, string>> = {
  enter: "↵",
  "mod+enter": `${MOD}↵`,
  "shift+enter": "⇧↵",
  "alt+enter": `${ALT}↵`,
};

type KeyPress = Pick<
  KeyboardEvent,
  "key" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey" | "isComposing"
>;

const chordOf = (event: KeyPress): Chord | null => {
  const held = [event.ctrlKey, event.metaKey, event.altKey, event.shiftKey].filter(Boolean).length;

  if (held === 0) return "enter";

  if (held > 1) return null;

  if (hasMod(event)) return "mod+enter";

  if (event.shiftKey) return "shift+enter";

  if (event.altKey) return "alt+enter";

  return null;
};

/**
 * Maps a key press in the search field to a list move or to an action chord, or null for keys the
 * field should handle as typing. A chord matches only with exactly its modifiers held, and Enter
 * while an IME composes text is typing.
 */
export const menuKeyOf = (event: KeyPress): MenuKey | null => {
  const ctrl = event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;

  if (event.key === "ArrowDown" || (ctrl && event.key === "j")) return { kind: "next" };

  if (event.key === "ArrowUp" || (ctrl && event.key === "p")) return { kind: "previous" };

  if (event.key !== "Enter" || event.isComposing) return null;

  const chord = chordOf(event);

  return chord === null ? null : { kind: "run", chord };
};

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
