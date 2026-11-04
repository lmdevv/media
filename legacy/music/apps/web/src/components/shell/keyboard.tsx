import { usePlayer, usePositionReader } from "@music/player/react";
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
 * Binds the global shortcuts in {@link HOTKEYS}. The single-key ones stay off while the command
 * menu or the new-playlist dialog is open, and TanStack skips them while you type in a field or
 * when a focused control uses the key itself, such as Space on a button. ⌘K always toggles the
 * command menu.
 */
export function KeyboardShortcuts() {
  const player = usePlayer();
  const positionMs = usePositionReader();
  const ui = useUi();
  const navigate = useNavigate();
  const like = useLike(player.track);
  const idle = !ui.commandOpen && ui.newPlaylist === null;
  const playable = idle && player.track !== null;

  const seekBy = (deltaMs: number) => {
    const target = positionMs() + deltaMs;
    perform(player.seek(Math.min(Math.max(0, target), player.durationMs)));
  };

  useHotkeys([
    {
      hotkey: HOTKEYS["command-menu.toggle"],
      callback: () => ui.setCommandOpen(!ui.commandOpen),
    },
    {
      hotkey: HOTKEYS["player.toggle"],
      callback: () => perform(player.togglePlay()),
      options: { enabled: playable },
    },
    {
      hotkey: HOTKEYS["player.seek-back"],
      callback: () => seekBy(-SEEK_STEP_MS),
      options: { enabled: playable },
    },
    {
      hotkey: HOTKEYS["player.seek-forward"],
      callback: () => seekBy(SEEK_STEP_MS),
      options: { enabled: playable },
    },
    {
      hotkey: HOTKEYS["player.previous"],
      callback: () => perform(player.previous()),
      options: { enabled: playable },
    },
    {
      hotkey: HOTKEYS["player.next"],
      callback: () => perform(player.next()),
      options: { enabled: playable },
    },
    {
      hotkey: HOTKEYS["player.like"],
      callback: () => void like.toggle(),
      options: { enabled: playable },
    },
    {
      hotkey: HOTKEYS["search.focus"],
      callback: () => {
        const field = document.getElementById(SEARCH_INPUT_ID);

        if (field instanceof HTMLInputElement) field.focus();
        else void navigate({ to: "/search" });
      },
      options: { enabled: idle },
    },
    {
      hotkey: HOTKEYS["playlists.new"],
      callback: () => ui.openNewPlaylist(),
      options: { enabled: idle },
    },
    {
      hotkey: HOTKEYS["devices.toggle"],
      callback: () => (ui.playOn === null ? ui.openPlayOn() : ui.closePlayOn()),
      options: { enabled: idle },
    },
  ]);

  return null;
}
