import { usePlayer, usePositionReader } from "@media/player/react";
import { isTypingTarget, shortcutOptions, unlessYielding } from "@media/ui/lib/focus-policy";
import { useHotkeys } from "@tanstack/react-hotkeys";
import { useNavigate } from "@tanstack/react-router";

import { perform } from "@/components/player/player-actions";
import { HOTKEYS } from "@/lib/hotkeys";
import { useLike } from "@/lib/use-like";

import { useUi } from "./ui-state";

const SEEK_STEP_MS = 10_000;

/** The id of the search field that `/` focuses. */
export const SEARCH_INPUT_ID = "search-input";

/**
 * Binds the global shortcuts in {@link HOTKEYS}. They fire whatever button has focus and yield
 * only to text fields, open menus and dialogs, and the keys a focused control uses itself. ⌘K
 * always toggles the command menu. D closes Play on, itself an overlay, unless you type in a field.
 */
export function KeyboardShortcuts() {
  const player = usePlayer();
  const positionMs = usePositionReader();
  const ui = useUi();
  const navigate = useNavigate();
  const like = useLike(player.track);
  const playable = player.track !== null;

  const seekBy = (deltaMs: number) => {
    const target = positionMs() + deltaMs;
    perform(player.seek(Math.min(Math.max(0, target), player.durationMs)));
  };

  useHotkeys(
    [
      {
        hotkey: HOTKEYS["command-menu.toggle"],
        callback: (event) => {
          event.preventDefault();
          ui.setCommandOpen(!ui.commandOpen);
        },
      },
      {
        hotkey: HOTKEYS["player.toggle"],
        callback: unlessYielding(() => perform(player.togglePlay())),
        options: { enabled: playable },
      },
      {
        hotkey: HOTKEYS["player.seek-back"],
        callback: unlessYielding(() => seekBy(-SEEK_STEP_MS)),
        options: { enabled: playable },
      },
      {
        hotkey: HOTKEYS["player.seek-forward"],
        callback: unlessYielding(() => seekBy(SEEK_STEP_MS)),
        options: { enabled: playable },
      },
      {
        hotkey: HOTKEYS["player.previous"],
        callback: unlessYielding(() => perform(player.previous())),
        options: { enabled: playable },
      },
      {
        hotkey: HOTKEYS["player.next"],
        callback: unlessYielding(() => perform(player.next())),
        options: { enabled: playable },
      },
      {
        hotkey: HOTKEYS["player.like"],
        callback: unlessYielding(() => void like.toggle()),
        options: { enabled: playable },
      },
      {
        hotkey: HOTKEYS["search.focus"],
        callback: unlessYielding(() => {
          const field = document.getElementById(SEARCH_INPUT_ID);

          if (field instanceof HTMLInputElement) field.focus();
          else void navigate({ to: "/search" });
        }),
      },
      {
        hotkey: HOTKEYS["playlists.new"],
        callback: unlessYielding(() => ui.openNewPlaylist()),
      },
      {
        hotkey: HOTKEYS["devices.toggle"],
        callback: (event) => {
          if (ui.playOn === null) {
            unlessYielding(ui.openPlayOn)(event);

            return;
          }

          if (isTypingTarget(event.target)) return;

          event.preventDefault();
          ui.closePlayOn();
        },
      },
    ],
    shortcutOptions,
  );

  return null;
}
