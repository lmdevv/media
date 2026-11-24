import { Tooltip } from "@base-ui/react/tooltip";
import { Keys, ariaKeyShortcuts } from "@media/ui/components/keys";
import type { Hotkey } from "@tanstack/hotkeys";
import type { ReactElement } from "react";

/**
 * Names a title page action and draws its shortcut in a tooltip above it: after a short hover, at
 * once on keyboard focus, and never for a touch. The action carries `aria-keyshortcuts`.
 *
 * @param children - The action, a single element; it becomes the trigger.
 */
export function KeyHint({
  hotkey,
  label,
  children,
}: {
  readonly hotkey: Hotkey;
  readonly label: string;
  readonly children: ReactElement;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        delay={300}
        closeDelay={0}
        render={children}
        aria-keyshortcuts={ariaKeyShortcuts(hotkey)}
      />
      <Tooltip.Portal>
        <Tooltip.Positioner side="top" sideOffset={10} className="z-50">
          <Tooltip.Popup
            data-slot="key-hint"
            className="flex items-center gap-2 rounded-control bg-text py-1.5 pr-1.5 pl-2.5 font-sans text-label/label font-semibold text-bg shadow-overlay transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 pointer-coarse:hidden"
          >
            {label}
            <Keys hotkey={hotkey} tone="inverse" />
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
