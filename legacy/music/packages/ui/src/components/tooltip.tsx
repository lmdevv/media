import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { cn } from "@music/ui/lib/utils";
import type { ReactElement, ReactNode } from "react";

/** Shares hover delays between tooltips. Wrap the app once. */
export function TooltipProvider({ children }: { readonly children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delay={400} closeDelay={0}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

/**
 * Labels an icon control and shows its keyboard shortcut where the action lives. The child must
 * be a single element; it becomes the trigger.
 */
export function Tooltip({
  label,
  shortcut,
  side = "top",
  children,
}: {
  readonly label: string;
  readonly shortcut?: string | undefined;
  readonly side?: "top" | "bottom" | "left" | "right";
  readonly children: ReactElement;
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger render={children} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side={side} sideOffset={8} className="isolate z-50">
          <TooltipPrimitive.Popup
            className={cn(
              "flex items-center gap-2 rounded-sm bg-text px-2.5 py-1.5 font-sans text-sm/xs text-text-inverse shadow-md data-closed:animate-out data-closed:fade-out-0 data-open:animate-in data-open:fade-in-0",
            )}
          >
            {label}
            {shortcut === undefined ? null : (
              <span className="font-mono text-xs/xs text-text-inverse/(--opacity-muted)">
                {shortcut}
              </span>
            )}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
