import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "@media/ui/lib/utils";

/**
 * The Paper toggle, as on the profile editor: a 44×26 pill, red with a white knob when on, a
 * hairline track with a muted knob when off.
 */
export function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "flex h-6.5 w-11 shrink-0 cursor-pointer items-center rounded-pill bg-hairline p-0.75 transition-colors data-checked:bg-accent disabled:cursor-not-allowed disabled:opacity-(--opacity-disabled)",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="size-5 rounded-pill bg-text-muted transition-transform data-checked:translate-x-4.5 data-checked:bg-on-accent" />
    </SwitchPrimitive.Root>
  );
}
