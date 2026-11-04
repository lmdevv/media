import { detectPlatform, formatForDisplay, isHotkeySequence } from "@tanstack/hotkeys";
import type { Hotkey } from "@tanstack/hotkeys";
import { cn } from "@music/ui/lib/utils";
import type { ComponentProps } from "react";

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

const TONES = {
  default: "bg-text/(--opacity-tint) text-text-muted",
  inverse: "bg-text-inverse/(--opacity-tint-strong) text-text-inverse/(--opacity-muted)",
} as const;

/**
 * A keyboard shortcut drawn as keycaps, one per key, labelled for this platform. `inverse` is for
 * caps on a solid `bg-text` surface, such as a tooltip or a solid button.
 */
export function Keys({
  hotkey,
  tone = "default",
  className,
  ...props
}: Omit<ComponentProps<"kbd">, "children"> & {
  readonly hotkey: Hotkey;
  readonly tone?: keyof typeof TONES;
}) {
  return (
    <kbd data-slot="keys" className={cn("inline-flex shrink-0 gap-0.5", className)} {...props}>
      {keyLabels(hotkey).map((label, index) => (
        <kbd
          key={index}
          className={cn(
            "inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-xs px-1 font-sans text-xs/xs font-medium",
            TONES[tone],
          )}
        >
          {label}
        </kbd>
      ))}
    </kbd>
  );
}
