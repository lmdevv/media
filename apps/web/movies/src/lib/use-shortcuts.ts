import { useHotkeys } from "@tanstack/react-hotkeys";
import type { UseHotkeyDefinition } from "@tanstack/react-hotkeys";

/**
 * Bind a screen's shortcuts with TanStack's `useHotkeys`, running each once per press: a held
 * key's repeats are skipped, even when something else handled its first press.
 */
export function useShortcuts(hotkeys: ReadonlyArray<UseHotkeyDefinition>): void {
  useHotkeys(
    hotkeys.map((hotkey) => ({
      ...hotkey,
      callback: (event, context) => {
        if (!event.repeat) hotkey.callback(event, context);
      },
    })),
  );
}
