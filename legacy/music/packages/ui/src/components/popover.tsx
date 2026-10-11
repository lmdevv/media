import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { cn } from "@music/ui/lib/utils";

/** A floating panel anchored to its trigger, such as the device picker. */
export const Popover = PopoverPrimitive.Root;

/** The element that opens a {@link Popover}. Use `render` to supply your own button. */
export const PopoverTrigger = PopoverPrimitive.Trigger;

/** The raised panel from the Paper overlays: 12px radius, hairline border, soft shadow. */
export function PopoverContent({
  className,
  align = "end",
  side = "top",
  sideOffset = 12,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<PopoverPrimitive.Positioner.Props, "align" | "side" | "sideOffset">) {
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
            "flex origin-(--transform-origin) flex-col rounded-lg border border-border bg-surface-raised text-text shadow-[0_24px_64px_color-mix(in_oklab,var(--color-text)_16%,transparent)] outline-none data-closed:animate-out data-closed:fade-out-0 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}
