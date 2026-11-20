import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { useKeyboardFocusReturn } from "@media/ui/lib/focus-policy";
import { cn } from "@/lib/utils";

/** A floating panel anchored to its trigger, such as the device picker. */
export const Popover = PopoverPrimitive.Root;

/** The element that opens a {@link Popover}. Use `render` to supply your own button. */
export const PopoverTrigger = PopoverPrimitive.Trigger;

export function PopoverContent({
  className,
  align = "end",
  side = "top",
  sideOffset = 12,
  ref,
  finalFocus,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<PopoverPrimitive.Positioner.Props, "align" | "side" | "sideOffset">) {
  const focusReturn = useKeyboardFocusReturn(ref, finalFocus);

  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "flex origin-(--transform-origin) flex-col rounded-lg border border-border bg-surface-raised text-text shadow-popover outline-none data-closed:animate-out data-closed:fade-out-0 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
            className,
          )}
          {...props}
          {...focusReturn}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}
