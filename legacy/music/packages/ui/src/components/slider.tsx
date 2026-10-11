import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { cn } from "@music/ui/lib/utils";

/**
 * The thin Paper progress and volume bar. The fill uses `fillClassName` (accent for playback,
 * text for volume) and a thumb appears on hover or while dragging. `aria-label` names the range
 * input inside the thumb, which is what assistive technology reads.
 */
export function Slider({
  className,
  fillClassName = "bg-accent",
  trackClassName = "bg-border",
  thumbClassName = "bg-text",
  "aria-label": label,
  ...props
}: Omit<SliderPrimitive.Root.Props<number>, "children"> & {
  readonly fillClassName?: string | undefined;
  readonly trackClassName?: string | undefined;
  readonly thumbClassName?: string | undefined;
}) {
  return (
    <SliderPrimitive.Root
      className={cn("group/slider w-full", className)}
      thumbAlignment="edge"
      {...props}
    >
      <SliderPrimitive.Control className="relative flex h-3 w-full cursor-pointer touch-none items-center select-none data-disabled:cursor-default">
        <SliderPrimitive.Track className={cn("relative h-1 w-full rounded-full", trackClassName)}>
          <SliderPrimitive.Indicator className={cn("h-full rounded-full", fillClassName)} />
          <SliderPrimitive.Thumb
            aria-label={label}
            className={cn(
              "size-3 rounded-full opacity-0 transition-opacity outline-none group-hover/slider:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 data-dragging:opacity-100",
              thumbClassName,
            )}
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}
