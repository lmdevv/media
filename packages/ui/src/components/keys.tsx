import {
  detectPlatform,
  formatForDisplay,
  formatHotkey,
  isHotkeySequence,
  parseHotkey,
} from "@tanstack/hotkeys";
import type { Hotkey } from "@tanstack/hotkeys";
import { cn } from "@media/ui/lib/utils";
import type { ComponentProps } from "react";

type Platform = ReturnType<typeof detectPlatform>;

/** Space reads as a word on its cap rather than TanStack's `␣`. */
const KEY_LABELS = { Space: "Space" } as const;

/**
 * The label on each keycap of `hotkey`, in the platform's order: symbols on macOS (`⌘`, `⇧`),
 * words elsewhere (`Ctrl`, `Shift`). A sequence's steps follow one another.
 */
export const keyLabels = (hotkey: Hotkey, platform = detectPlatform()): ReadonlyArray<string> => {
  const options = { parts: true, keyLabels: KEY_LABELS, platform } as const;

  return isHotkeySequence(hotkey)
    ? formatForDisplay(hotkey, options).flat()
    : formatForDisplay(hotkey, options);
};

/**
 * `hotkey` as `aria-keyshortcuts` names it on this platform, such as `Meta+K` on macOS and
 * `Control+K` elsewhere. Undefined for a sequence, which the attribute cannot express.
 */
export const ariaKeyShortcuts = (
  hotkey: Hotkey,
  platform: Platform = detectPlatform(),
): string | undefined =>
  isHotkeySequence(hotkey) ? undefined : formatHotkey(parseHotkey(hotkey, platform));

/**
 * A keyboard shortcut drawn as keycaps, one per key, labelled for this platform. Each app's
 * stylesheet draws the caps with its `keycaps` and `keycap` utilities. `inverse` is for caps on a
 * solid `bg-text` surface, such as a tooltip.
 */
export function Keys({
  hotkey,
  tone = "default",
  className,
  ...props
}: Omit<ComponentProps<"kbd">, "children"> & {
  readonly hotkey: Hotkey;
  readonly tone?: "default" | "inverse";
}) {
  return (
    <kbd data-slot="keys" className={cn("keycaps", className)} {...props}>
      {keyLabels(hotkey).map((label, index) => (
        <kbd key={index} data-tone={tone} className="keycap">
          {label}
        </kbd>
      ))}
    </kbd>
  );
}
